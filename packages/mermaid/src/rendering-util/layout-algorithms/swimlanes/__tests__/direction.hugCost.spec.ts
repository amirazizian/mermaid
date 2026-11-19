import { describe, expect, it } from 'vitest';
import { costOfWay } from '../direction/vertexPorts.js';
import type { Obstacle, VertexContext } from '../direction/vertexPorts.js';

interface Point {
  x: number;
  y: number;
}

const shape = { left: -18, right: 18, top: -18, bottom: 18 };

const contextOf = (obstacles: Obstacle[]): VertexContext => ({
  vertexAt: () => undefined,
  ownShape: shape,
  ownId: 'n',
  obstacles,
  exempt: () => new Set(['n']),
  farEnd: () => 'far',
  otherRoutes: () => [],
  sideCost: () => 0,
});

const cost = (points: Point[], obstacles: Obstacle[]) =>
  costOfWay(points, contextOf(obstacles), {}, []);

describe('running beside another shape', () => {
  it('costs by the stretch beside the shape, not by the whole segment', () => {
    // A long upright segment that passes a small shape 10px off its side.
    const way = [
      { x: 0, y: 18 },
      { x: 0, y: 400 },
    ];
    const small = { left: 10, right: 60, top: 200, bottom: 220 };
    const extra = cost(way, [{ id: 'o', shape: small }]) - cost(way, []);
    expect(extra).toBeGreaterThan(100);
    expect(extra).toBeLessThan(200);
  });
});
