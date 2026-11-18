import { describe, expect, it } from 'vitest';
import { rerouteDetouredEdges } from '../direction/detourRerouting.js';

interface Point {
  x: number;
  y: number;
}

const node = (id: string, x: number, y: number, metadata?: Record<string, unknown>) => ({
  id,
  x,
  y,
  width: 100,
  height: 60,
  ...(metadata ? { metadata } : {}),
});

const lengthOf = (points: Point[]) =>
  points.reduce(
    (sum, p, i) =>
      i === 0 ? sum : sum + Math.abs(p.x - points[i - 1].x) + Math.abs(p.y - points[i - 1].y),
    0
  );

/** From a node's right face up, over a node between, and back down into the target's left face: a loop round the whole layout. */
const loop = (): Point[] => [
  { x: 50, y: 0 },
  { x: 70, y: 0 },
  { x: 70, y: -400 },
  { x: 900, y: -400 },
  { x: 900, y: 200 },
  { x: 330, y: 200 },
  { x: 330, y: 0 },
  { x: 350, y: 0 },
];

describe('rerouteDetouredEdges', () => {
  const FLAT = { endpointProfile: 'flat' };

  it('routes a detouring edge afresh between nodes that declare how edges meet them', () => {
    const edge = { id: 'e', start: 'a', end: 'b', points: loop() };
    const nodes = new Map(
      [node('a', 0, 0, FLAT), node('b', 400, 0, FLAT), node('mid', 200, 120, FLAT)].map((n) => [
        n.id,
        n,
      ])
    );
    rerouteDetouredEdges([edge], nodes);
    expect(lengthOf(edge.points)).toBeLessThan(400);
    expect(edge.points[0]).toEqual({ x: 50, y: 0 });
    expect(edge.points.at(-1)).toEqual({ x: 350, y: 0 });
  });

  it('keeps clear of the shapes in the way', () => {
    // A node straight between the two ends: the new route goes round it, not through it.
    const edge = { id: 'e', start: 'a', end: 'b', points: loop() };
    const nodes = new Map(
      [node('a', 0, 0, FLAT), node('b', 400, 0, FLAT), node('mid', 200, 0, FLAT)].map((n) => [
        n.id,
        n,
      ])
    );
    rerouteDetouredEdges([edge], nodes);
    for (let i = 0; i < edge.points.length - 1; i++) {
      const [p, q] = [edge.points[i], edge.points[i + 1]];
      const through =
        Math.max(p.x, q.x) > 150 &&
        Math.min(p.x, q.x) < 250 &&
        Math.max(p.y, q.y) > -30 &&
        Math.min(p.y, q.y) < 30;
      expect(through).toBe(false);
    }
    expect(lengthOf(edge.points)).toBeLessThan(lengthOf(loop()));
  });

  it('leaves an edge between plain nodes as it is', () => {
    const edge = { id: 'e', start: 'a', end: 'b', points: loop() };
    const nodes = new Map([node('a', 0, 0), node('b', 400, 0)].map((n) => [n.id, n]));
    rerouteDetouredEdges([edge], nodes);
    expect(edge.points).toEqual(loop());
  });
});
