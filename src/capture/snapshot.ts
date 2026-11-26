import type { Page } from 'playwright';
import type { CaptureTarget } from './policy.ts';

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SnapshotNode {
  path: string;
  tag: string;
  component?: string;
  testId?: string;
  source?: string;
  role?: string;
  hidden: boolean;
  ariaHidden: boolean;
  bounds: Bounds;
  overflowX: boolean;
  overflowY: boolean;
  styles: Record<string, string>;
}

export interface Snapshot {
  version: 1;
  truncated: boolean;
  nodes: SnapshotNode[];
}

const properties = [
  'background-color',
  'border-radius',
  'border-top-width',
  'color',
  'display',
  'flex-direction',
  'font-family',
  'font-size',
  'font-weight',
  'gap',
  'grid-template-columns',
  'line-height',
  'opacity',
  'overflow-x',
  'overflow-y',
  'position',
  'text-align',
  'text-overflow',
  'visibility',
  'white-space',
  'z-index',
];

export function captureSnapshot(
  page: Page,
  target: CaptureTarget,
  scale: number,
): Promise<Snapshot> {
  return page.evaluate(
    ({ selector, masks, scale, properties }) => {
      const root = selector ? document.querySelector(selector) : document.body;
      if (!root) throw new Error('Snapshot target is missing');
      const excluded = new Set(
        masks.flatMap((mask) => Array.from(document.querySelectorAll(mask))),
      );
      if (masks.some((mask) => root.closest(mask)))
        return { version: 1, truncated: false, nodes: [] };
      const origin = selector
        ? root.getBoundingClientRect()
        : { x: -scrollX, y: -scrollY };
      const nodes: SnapshotNode[] = [];
      const validLabel = (value: string | null) =>
        value && /^[a-z][a-z0-9_:-]{0,79}$/i.test(value) ? value : undefined;
      const implicitRole: Record<string, string> = {
        a: 'link',
        button: 'button',
        form: 'form',
        h1: 'heading',
        h2: 'heading',
        img: 'img',
        input: 'input',
        main: 'main',
        nav: 'navigation',
        table: 'table',
      };
      const round = (value: number) => Math.round(value * scale * 10) / 10;
      const pending = [{ element: root, path: root.localName }];
      let scanned = 0;
      let truncated = false;
      while (pending.length && scanned < 5000) {
        const { element, path } = pending.pop()!;
        scanned++;
        const tag = element.localName;
        if (
          excluded.has(element) ||
          ['script', 'style', 'noscript', 'template'].includes(tag)
        )
          continue;
        const computed = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const source = element.getAttribute('data-verity-source');
        const hidden =
          computed.display === 'none' ||
          computed.visibility !== 'visible' ||
          element.getClientRects().length === 0;
        const ariaHidden =
          element.closest('[aria-hidden="true"],[inert]') !== null;
        nodes.push({
          path,
          tag,
          component: validLabel(element.getAttribute('data-verity-component')),
          testId: validLabel(element.getAttribute('data-testid')),
          source:
            source &&
            /^[a-z0-9_-]+(?:\/[a-z0-9_.-]+)*\.[a-z0-9]+(?::[1-9]\d{0,6})?$/i.test(
              source,
            ) &&
            source.length <= 200 &&
            !source.includes('..')
              ? source
              : undefined,
          role:
            validLabel(element.getAttribute('role')) ??
            (Object.hasOwn(implicitRole, tag) ? implicitRole[tag] : undefined),
          hidden,
          ariaHidden,
          bounds: {
            x: round(rect.x - origin.x),
            y: round(rect.y - origin.y),
            width: round(rect.width),
            height: round(rect.height),
          },
          overflowX:
            element.clientWidth > 0 &&
            element.scrollWidth > element.clientWidth + 1,
          overflowY:
            element.clientHeight > 0 &&
            element.scrollHeight > element.clientHeight + 1,
          styles: Object.fromEntries(
            properties.map((name) => [
              name,
              computed.getPropertyValue(name).slice(0, 200),
            ]),
          ),
        });
        const children: typeof pending = [];
        const counts = new Map<string, number>();
        for (const child of element.children) {
          if (
            children.length + pending.length + scanned >= 5000 ||
            path.length > 500
          ) {
            truncated = true;
            break;
          }
          const count = (counts.get(child.localName) ?? 0) + 1;
          counts.set(child.localName, count);
          children.push({
            element: child,
            path: `${path}>${child.localName}:${count}`,
          });
        }
        for (const child of children.reverse()) pending.push(child);
      }
      return { version: 1, truncated: truncated || pending.length > 0, nodes };
    },
    { selector: target.selector, masks: target.masks ?? [], scale, properties },
  );
}
