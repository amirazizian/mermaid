import { describe, expect, it } from 'vitest';
import { assignSides, costOfWay } from '../direction/vertexPorts.js';
import type { Obstacle, VertexContext, VertexSide, VertexWay } from '../direction/vertexPorts.js';

interface Point {
  x: number;
  y: number;
}

/** A circle drawn 36 across at the origin, writing its caption in the band under it. */
const shape = { left: -18, right: 18, top: -18, bottom: 18 };
const band = { left: -24, right: 24, top: 18, bottom: 48 };

const contextOf = (
  obstacles: Obstacle[],
  places?: { left: number; right: number; top: number; bottom: number }[]
): VertexContext => ({
  vertexAt: () => undefined,
  ownShape: shape,
  ownId: 'n',
  obstacles,
  exempt: () => new Set(['n']),
  farEnd: () => 'far',
  otherRoutes: () => [],
  sideCost: () => 0,
  captionPlaces: places === undefined ? undefined : () => places,
});

const cost = (points: Point[], obstacles: Obstacle[], places?: (typeof band)[]) =>
  costOfWay(points, contextOf(obstacles, places), {}, []);

describe("a line through its own end's caption", () => {
  const free = [{ left: -80, right: -30, top: 18, bottom: 48 }];

  it('costs little to run on in the caption when the caption has a free place to move to', () => {
    // Out of the bottom vertex, a short stub, then right through the caption band.
    const way = [
      { x: 0, y: 18 },
      { x: 0, y: 30 },
      { x: 200, y: 30 },
    ];
    const extra = cost(way, [{ id: 'n', shape, text: band }], free) - cost(way, [], free);
    expect(extra).toBeGreaterThan(0);
    expect(extra).toBeLessThan(50);
  });

  it('costs a text crossing, even straight out of the vertex, when the caption cannot move', () => {
    const way = [
      { x: 0, y: 18 },
      { x: 0, y: 200 },
    ];
    const extra = cost(way, [{ id: 'n', shape, text: band }], []) - cost(way, [], []);
    expect(extra).toBeGreaterThanOrEqual(250);
  });

  it('counts a free place the way itself runs through as taken', () => {
    const way = [
      { x: 0, y: 18 },
      { x: 0, y: 30 },
      { x: -200, y: 30 },
    ];
    const extra = cost(way, [{ id: 'n', shape, text: band }], free) - cost(way, [], free);
    expect(extra).toBeGreaterThanOrEqual(250);
  });
});

describe('assignSides weighing two ways together', () => {
  const way = (side: VertexSide, cost: number): VertexWay => ({
    side,
    cost,
    points: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ],
  });

  it('adds what a pair of ways costs together to their own costs', () => {
    const first = new Map<VertexSide, VertexWay>([
      ['top', way('top', 10)],
      ['left', way('left', 20)],
    ]);
    const second = new Map<VertexSide, VertexWay>([
      ['right', way('right', 10)],
      ['bottom', way('bottom', 20)],
    ]);
    // Top with right is cheapest alone; together they cost far more.
    const pair = (_i: number, a: VertexWay, _j: number, b: VertexWay) =>
      a.side === 'top' && b.side === 'right' ? 1000 : 0;
    const chosen = assignSides([first, second], true, pair);
    expect(chosen.map((w) => w?.side)).not.toEqual(['top', 'right']);
  });
});
