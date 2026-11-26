import type { Bounds, Snapshot, SnapshotNode } from '../capture/snapshot.ts';
import type { Region } from './regions.ts';

type Value = string | number | boolean | null;
export interface StructuralChange {
  id: string;
  element: string;
  component?: string;
  source?: string;
  match: 'test-id' | 'component' | 'path' | 'unmatched';
  properties: { name: string; before: Value; after: Value }[];
}

function uniqueNodes(nodes: SnapshotNode[], attribute: 'testId' | 'component') {
  const index = new Map<string, SnapshotNode | null>();
  for (const node of nodes) {
    const value = node[attribute];
    if (value) index.set(value, index.has(value) ? null : node);
  }
  return index;
}

function intersects(left: Bounds, right: Bounds) {
  return (
    left.width > 0 &&
    left.height > 0 &&
    left.x < right.x + right.width &&
    right.x < left.x + left.width &&
    left.y < right.y + right.height &&
    right.y < left.y + left.height
  );
}

export function compareStructure(
  baseline: Snapshot,
  current: Snapshot,
  regions: Region[],
) {
  const unmatched = new Set(current.nodes);
  const pairs: {
    before: SnapshotNode;
    after: SnapshotNode;
    match: StructuralChange['match'];
  }[] = [];
  const previous = new Set(baseline.nodes);
  for (const attribute of ['testId', 'component'] as const) {
    const beforeIndex = uniqueNodes(baseline.nodes, attribute);
    const afterIndex = uniqueNodes(current.nodes, attribute);
    for (const [identifier, before] of beforeIndex) {
      const after = afterIndex.get(identifier);
      if (
        !before ||
        !after ||
        before.tag !== after.tag ||
        !previous.has(before) ||
        !unmatched.has(after)
      )
        continue;
      pairs.push({
        before,
        after,
        match: attribute === 'testId' ? 'test-id' : 'component',
      });
      previous.delete(before);
      unmatched.delete(after);
    }
  }
  const paths = new Map([...unmatched].map((node) => [node.path, node]));
  for (const before of previous) {
    const after = paths.get(before.path);
    if (
      !after ||
      before.tag !== after.tag ||
      (before.component &&
        after.component &&
        before.component !== after.component) ||
      (before.testId && after.testId && before.testId !== after.testId)
    )
      continue;
    pairs.push({ before, after, match: 'path' });
    previous.delete(before);
    unmatched.delete(after);
  }

  const changes: {
    evidence: StructuralChange;
    before?: Bounds;
    after?: Bounds;
  }[] = [];
  function record(
    before: SnapshotNode | undefined,
    after: SnapshotNode | undefined,
    match: StructuralChange['match'],
  ) {
    const node = after ?? before!;
    const properties: StructuralChange['properties'] = [];
    function property(name: string, previous: Value, next: Value) {
      if (previous !== next)
        properties.push({ name, before: previous, after: next });
    }
    if (!before || !after) {
      property('presence', Boolean(before), Boolean(after));
    } else {
      property('hidden', before.hidden, after.hidden);
      property('aria-hidden', before.ariaHidden, after.ariaHidden);
      property('role', before.role ?? null, after.role ?? null);
      property('overflow-x-detected', before.overflowX, after.overflowX);
      property('overflow-y-detected', before.overflowY, after.overflowY);
      if (!before.hidden || !after.hidden) {
        for (const dimension of ['x', 'y', 'height', 'width'] as const)
          if (
            Math.abs(before.bounds[dimension] - after.bounds[dimension]) >= 0.5
          )
            property(
              dimension,
              before.bounds[dimension],
              after.bounds[dimension],
            );
        for (const name of Object.keys(after.styles))
          property(
            name,
            before.styles[name] ?? null,
            after.styles[name] ?? null,
          );
      }
    }
    if (properties.length && (!before || !after ? !node.hidden : true)) {
      changes.push({
        evidence: {
          id: `element-${changes.length + 1}`,
          element: node.testId ? `[data-testid="${node.testId}"]` : node.path,
          component: node.component,
          source: node.source,
          match,
          properties,
        },
        before: before?.bounds,
        after: after?.bounds,
      });
    }
  }

  for (const { before, after, match } of pairs) record(before, after, match);
  for (const before of previous) record(before, undefined, 'unmatched');
  for (const after of unmatched) record(undefined, after, 'unmatched');

  const evidence = changes.slice(0, 250);
  return {
    changes: evidence.map(({ evidence }) => evidence),
    incomplete:
      baseline.truncated ||
      current.truncated ||
      changes.length > evidence.length,
    regions: regions.map((region, index) => ({
      id: `region-${index + 1}`,
      elementIds: evidence
        .filter(
          ({ before, after }) =>
            (before && intersects(before, region)) ||
            (after && intersects(after, region)),
        )
        .map(({ evidence }) => evidence.id),
    })),
  };
}

export type StructuralEvidence = ReturnType<typeof compareStructure>;
