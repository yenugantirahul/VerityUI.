import { setTimeout as delay } from 'node:timers/promises';
import { diagnose, diagnoseSafely } from '../analysis/diagnose.ts';
import { capture } from '../capture/engine.ts';
import { CaptureError, desktopProfile } from '../capture/policy.ts';
import { compareScreenshots } from '../compare/compare.ts';
import { startFixture } from '../fixture/server.ts';
import { ArtifactError, type ArtifactStore } from '../persistence/artifacts.ts';
import {
  BaselineError,
  baselineIdentity,
  type Baselines,
} from '../persistence/baselines.ts';
import type { Claim, JobResult, RunQueue } from './queue.ts';

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
            : error instanceof BaselineError
              ? error.code
              : 'worker_error';
      await this.queue.fail(
        claim,
        code,
        ![
          'invalid_configuration',
          'capture_area',
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
    const fixture = await startFixture(claim.variant);
    try {
      const { width, height, selector, masks, key } = claim.checkpoint;
      const target = {
        path: '/analytics',
        readySelector: 'main[data-ready="true"]',
        selector,
        masks,
      };
      const result = await capture({
        origin: fixture.origin,
        profile: { ...desktopProfile, viewport: { width, height } },
        target,
        timeoutMs: this.timeoutMs,
      });
      const identity = baselineIdentity({
        environment: 'local-fixture',
        checkpoint: key,
        fixtureVersion: '1',
        target,
        metadata: result.metadata,
      });
      const active = await this.baselines.active(scope, identity);
      const baseline = active
        ? await this.baselines.artifact(scope, active.id)
        : undefined;
      const comparison = compareScreenshots(baseline, result.png);
      const analysis = diagnoseSafely(
        baseline,
        result.png,
        comparison,
        this.diagnose,
      );
      const evidence: JobResult['evidence'] = {
        current: await this.artifacts.put(scope.organizationId, result.png),
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
      return {
        identity,
        comparedBaselineId: active?.id ?? null,
        capture: result.metadata,
        comparison: comparison.summary,
        analysis,
        evidence,
      };
    } finally {
      await fixture.close();
    }
  }
}
