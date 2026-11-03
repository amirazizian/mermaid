import { describe, it, expect } from 'vitest';
import type { LayoutData, Node } from '../../../types.js';
import type { AnchorPin } from '../anchoredNodes.js';
import { squareAnchoredEdges } from '../anchoredNodes.js';

interface Point {
  x: number;
  y: number;
}

// A host spanning x 50..150 and y 10..90, and artifacts pinned under it whose drawn
// shape is 36 x 50 inside a 60 px tall box, the way a captioned data object lays out.
const host = { id: 'h', x: 100, y: 50, width: 100, height: 80, isGroup: false } as Node;
const artifact = (id: string, x: number): Node =>
  ({
    id,
    x,
    y: 150,
    width: 60,
    height: 110,
    isGroup: false,
    metadata: { drawnExtent: { width: 36, height: 50 } },
  }) as unknown as Node;
const pin = (id: string): AnchorPin => ({
  nodeId: id,
  hostId: 'h',
  side: 'bottom',
  x: 0,
  y: 0,
  outward: { x: 0, y: 1 },
});

function route(xs: Record<string, number>, outgoing: string[] = []) {
  const ids = Object.keys(xs);
  const layout = {
    nodes: [host, ...ids.map((id) => artifact(id, xs[id]))],
    edges: ids.map((id) =>
      outgoing.includes(id)
        ? { id: `e-${id}`, start: 'h', end: id }
        : { id: `e-${id}`, start: id, end: 'h' }
    ),
  } as unknown as LayoutData;
  squareAnchoredEdges(layout, ids.map(pin));
  return new Map(layout.edges.map((edge) => [edge.id, edge.points as Point[]]));
}

type Segment = [Point, Point];
const segments = (points: Point[]): Segment[] =>
  points.slice(1).map((point, i) => [points[i], point]);

/** Whether two axis-aligned segments touch anywhere but a shared endpoint. */
function touch([a, b]: Segment, [c, d]: Segment): boolean {
  const [ax1, ax2] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
  const [ay1, ay2] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
  const [cx1, cx2] = [Math.min(c.x, d.x), Math.max(c.x, d.x)];
  const [cy1, cy2] = [Math.min(c.y, d.y), Math.max(c.y, d.y)];
  return ax1 <= cx2 && cx1 <= ax2 && ay1 <= cy2 && cy1 <= ay2;
}

const crossings = (paths: Map<string, Point[]>) => {
  const all = [...paths.entries()];
  const found: string[] = [];
  for (const [i, [idA, a]] of all.entries()) {
    for (const [idB, b] of all.slice(i + 1)) {
      // The last segment of each runs into the host; only the part outside it counts.
      const outside = (points: Point[]) =>
        segments(points).filter(([p, q]) => p.y > 90 || q.y > 90);
      if (outside(a).some((s) => outside(b).some((t) => touch(s, t)))) {
        found.push(`${idA} x ${idB}`);
      }
    }
  }
  return found;
};

const entryOf = (points: Point[]) => points.find((point) => point.y === 50)!.x;

describe('lines from several nodes pinned beside one side', () => {
  it('nests the lines of nodes beyond one end so none crosses another', () => {
    const paths = route({ a: -60, b: 20, c: 100 });
    expect(crossings(paths)).toEqual([]);
  });

  it('gives each line beyond the end its own entry, outermost nearest the end', () => {
    const paths = route({ a: -60, b: 20, c: 100 });
    const [a, b] = [entryOf(paths.get('e-a')!), entryOf(paths.get('e-b')!)];
    expect(a).toBe(58);
    expect(b).toBeGreaterThan(a);
    expect(b).toBeLessThan(100);
  });

  it('turns the outermost line nearest the host, inside the gap between the shapes', () => {
    const paths = route({ a: -60, b: 20 });
    const turnOf = (points: Point[]) => points[1].y;
    const [a, b] = [turnOf(paths.get('e-a')!), turnOf(paths.get('e-b')!)];
    expect(a).toBeLessThan(b);
    expect(a).toBeGreaterThan(90);
    expect(b).toBeLessThan(125);
  });

  it('runs a node abreast of the side straight in', () => {
    expect(route({ a: -60, b: 20, c: 100 }).get('e-c')).toEqual([
      { x: 100, y: 150 },
      { x: 100, y: 50 },
    ]);
  });

  it('keeps the nesting whichever way each line points', () => {
    expect(crossings(route({ a: -60, b: 20, c: 100 }, ['b']))).toEqual([]);
  });

  it('nests the lines beyond the other end too', () => {
    const paths = route({ a: 260, b: 180, c: 100 });
    expect(crossings(paths)).toEqual([]);
    expect(entryOf(paths.get('e-a')!)).toBe(142);
  });
});
