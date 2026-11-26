import { readFile } from 'node:fs/promises';
import { parseDocument } from 'yaml';
import * as z from 'zod';
import { applicationPath } from '../cli/config.ts';
import type { ComparisonSummary } from '../compare/compare.ts';
import type { StructuralEvidence } from '../compare/structure.ts';

const component = z.string().regex(/^[a-z][a-z0-9_:-]{0,79}$/i);
const contractSchema = z.strictObject({
  intent: z.strictObject({
    description: z.string().trim().min(1).max(500),
    allowedChanges: z
      .array(
        z.strictObject({
          component,
          properties: z
            .array(z.string().regex(/^[a-z][a-z-]{0,50}$/))
            .min(1)
            .max(40),
        }),
      )
      .max(40)
      .default([]),
    protectedComponents: z.array(component).max(80).default([]),
    protectedRoutes: z.array(applicationPath).max(40).default([]),
  }),
});
export type IntentContract = z.output<typeof contractSchema>['intent'];

export async function readIntent(file: string): Promise<IntentContract> {
  const source = await readFile(file);
  if (source.length > 32_000) throw new Error('Intent contract exceeds 32 KB');
  const yaml = parseDocument(source.toString('utf8'));
  if (yaml.errors.length || yaml.warnings.length)
    throw new Error('Invalid intent YAML');
  const parsed = contractSchema.safeParse(yaml.toJS({ maxAliasCount: 0 }));
  if (!parsed.success) throw new Error('Invalid intent contract fields');
  return parsed.data.intent;
}

export function evaluateIntent(
  route: string,
  critical: boolean,
  summary: ComparisonSummary,
  structure: StructuralEvidence | undefined,
  contract?: IntentContract,
) {
  const { status } = summary;
  if (status === 'missing')
    return {
      verdict: 'baseline_required',
      reasons: ['A compatible baseline is required.'],
    } as const;
  const changes = structure?.changes ?? [];
  const visualChange =
    status === 'incompatible' || Boolean(summary.changedPixels);
  if (!visualChange && !changes.length && !structure?.incomplete)
    return { verdict: 'unchanged', reasons: [] } as const;

  const reasons: string[] = [];
  if (critical || contract?.protectedRoutes.includes(route))
    reasons.push('This route requires human review.');
  if (
    changes.some(
      ({ component }) =>
        component && contract?.protectedComponents.includes(component),
    )
  )
    reasons.push('A protected component changed.');
  if (status === 'incompatible') reasons.push('Capture dimensions changed.');
  if (structure?.incomplete) reasons.push('Structural evidence is incomplete.');
  if (!contract) reasons.push('No change contract was supplied.');
  const disallowed = changes.some(
    ({ component, match, properties }) =>
      !component ||
      match === 'path' ||
      match === 'unmatched' ||
      !properties.every(({ name }) =>
        contract?.allowedChanges.some(
          (rule) =>
            rule.component === component && rule.properties.includes(name),
        ),
      ),
  );
  if (contract && disallowed)
    reasons.push('Some element changes exceed the declared scope.');
  if (
    visualChange &&
    (!changes.length ||
      summary.omittedRegions ||
      structure?.regions.some(({ elementIds }) => !elementIds.length))
  )
    reasons.push('Some changed pixels lack structural attribution.');
  return reasons.length
    ? ({ verdict: 'needs_review', reasons } as const)
    : ({
        verdict: 'within_intent',
        reasons: [
          'Observed element changes fit the declared scope. Review before promoting the baseline.',
        ],
      } as const);
}
