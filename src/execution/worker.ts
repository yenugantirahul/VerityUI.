import { setTimeout as delay } from 'node:timers/promises';
import { diagnose, diagnoseSafely } from '../analysis/diagnose.ts';
import { capture, type CaptureResult } from '../capture/engine.ts';
import { CaptureError, desktopProfile } from '../capture/policy.ts';
import type { Snapshot } from '../capture/snapshot.ts';
import { compareScreenshots } from '../compare/compare.ts';
import { InvalidImageError } from '../compare/images.ts';
import { compareStructure } from '../compare/structure.ts';
import {
  inspectDashboard,
  type DashboardCheck,
} from '../fixture/assertions.ts';
import { fixtureVersion } from '../fixture/page.ts';
import { startFixture } from '../fixture/server.ts';
import { ArtifactError, type ArtifactStore } from '../persistence/artifacts.ts';
import {
  BaselineError,
  baselineIdentity,
  type Baselines,
} from '../persistence/baselines.ts';
import type { BaselineScope } from '../persistence/baselines.ts';
import {
  ExecutionError,
  type Claim,
  type JobResult,
  type RunQueue,
} from './queue.ts';

export class Worker {
  private readonly queue: RunQueue;
  private readonly baselines: Baselines;
  private readonly artifacts: ArtifactStore;
  private readonly timeoutMs: number;
  private readonly diagnose: typeof diagnose;

  constructor(
    queue: RunQueue,
    baselines: Baselines,
    artifacts: ArtifactStore,
    timeoutMs = 15000,
    classify = diagnose,
  ) {
    this.queue = queue;
    this.baselines = baselines;
    this.artifacts = artifacts;
    this.timeoutMs = timeoutMs;
    this.diagnose = classify;
  }

  async runOne() {
    const claim = await this.queue.claim();
    if (!claim) return false;
    let result: JobResult;
    try {
      result = await this.process(claim);
    } catch (error) {
      const code =
        error instanceof CaptureError
          ? error.code
          : error instanceof ArtifactError
            ? 'storage_unavailable'
            : error instanceof InvalidImageError ||
                error instanceof ExecutionError
              ? 'invalid_capture'
              : error instanceof BaselineError
                ? error.code
                : 'worker_error';
      await this.queue.fail(
        claim,
        code,
        ![
          'invalid_configuration',
          'capture_area',
          'invalid_capture',
          'forbidden',
          'not_found',
        ].includes(code),
      );
      return true;
    }
    await this.queue.complete(claim, result);
    return true;
  }

  async run(signal: AbortSignal, report: (code: string) => void) {
    let interval = 350;
    while (!signal.aborted) {
      try {
        const claimed = await this.runOne();
        interval = 350;
        if (claimed) continue;
      } catch {
        report('queue_unavailable');
        interval = Math.min(interval * 2, 5000);
      }
      await delay(interval, undefined, { signal }).catch(() => undefined);
    }
  }

  private async process(claim: Claim): Promise<JobResult> {
    const scope = {
      organizationId: claim.org_id,
      projectId: claim.project_id,
      actorId: claim.actor_id,
    };
    if (claim.variant === 'ci') {
      const input = claim.uploaded_evidence;
      if (!input)
        throw new ExecutionError(400, 'CI checkpoint is missing input');
      const png = await this.artifacts.get(scope.organizationId, input.frame);
      const snapshot =
        input.snapshot && (await this.readSnapshot(scope, input.snapshot));
      return this.compare(
        scope,
        input.identity,
        { png, metadata: input.metadata, snapshot },
        undefined,
        input.frame,
      );
    }
    const fixture = await startFixture(claim.variant);
    try {
      const { width, height, selector, masks, key } = claim.checkpoint;
      const target = {
        path: '/analytics',
        readySelector: 'main[data-ready]',
        selector,
        masks,
      };
      let checks: DashboardCheck[] = [];
      const result = await capture(
        {
          origin: fixture.origin,
          profile: { ...desktopProfile, viewport: { width, height } },
          target,
          timeoutMs: this.timeoutMs,
        },
        async (page, remainingMs) => {
          checks = await inspectDashboard(page, remainingMs);
        },
      );
      const identity = baselineIdentity({
        environment: 'local-fixture',
        checkpoint: key,
        fixtureVersion,
        target,
        metadata: result.metadata,
      });
      return await this.compare(scope, identity, result, checks);
    } finally {
      await fixture.close();
    }
  }

  private async readSnapshot(
    scope: BaselineScope,
    ref: NonNullable<JobResult['evidence']['current']>,
  ) {
    const bytes = await this.artifacts.get(scope.organizationId, ref);
    return JSON.parse(bytes.toString('utf8')) as Snapshot;
  }

  private async compare(
    scope: BaselineScope,
    identity: string,
    result: CaptureResult,
    checks?: DashboardCheck[],
    uploadedFrame?: JobResult['evidence']['current'],
  ): Promise<JobResult> {
    const active = await this.baselines.active(scope, identity);
    const baseline =
      active && (await this.baselines.artifact(scope, active.id));
    const comparison = compareScreenshots(baseline ?? undefined, result.png);
    const analysis = diagnoseSafely(
      baseline ?? undefined,
      result.png,
      comparison,
      this.diagnose,
    );
    const evidence: JobResult['evidence'] = {
      current:
        uploadedFrame ??
        (await this.artifacts.put(scope.organizationId, result.png)),
    };
    if (active)
      evidence.baseline = {
        digest: active.artifact_digest,
        sizeBytes: active.artifact_bytes,
      };
    if (comparison.artifacts) {
      for (const kind of ['diff', 'heatmap', 'overlay'] as const) {
        evidence[kind] = await this.artifacts.put(
          scope.organizationId,
          comparison.artifacts[kind],
        );
      }
    }
    const baselineSnapshot =
      result.snapshot &&
      active &&
      (await this.queue.ci.baselineSnapshot(scope, active.id));
    const structure =
      baselineSnapshot && result.snapshot
        ? compareStructure(
            await this.readSnapshot(scope, baselineSnapshot),
            result.snapshot,
            comparison.summary.regions,
          )
        : undefined;
    return {
      identity,
      comparedBaselineId: active?.id ?? null,
      capture: result.metadata,
      comparison: comparison.summary,
      structure,
      analysis,
      checks,
      evidence,
    };
  }
}
