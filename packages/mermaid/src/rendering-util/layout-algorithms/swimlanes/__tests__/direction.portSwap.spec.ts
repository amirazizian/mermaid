import { describe, expect, it } from 'vitest';
import { portSwapToLShape } from '../direction/portSwap.js';

describe('portSwapToLShape', () => {
  it('rewrites a non-collinear HVH detour to a 3-point L shape from the source face', () => {
    const nodes: any[] = [
      { id: 'A', x: 0, y: 0, width: 40, height: 40 },
      { id: 'B', x: 100, y: 100, width: 40, height: 40 },
    ];
    const edges: any[] = [
      {
        id: 'A_B',
        start: 'A',
        end: 'B',
        points: [
          { x: 20, y: 0 },
          { x: 60, y: 0 },
          { x: 60, y: 80 },
          { x: 100, y: 80 },
        ],
      },
    ];

    portSwapToLShape(edges, nodes);

    expect(edges[0].points).toEqual([
      { x: 0, y: 20 },
      { x: 0, y: 80 },
      { x: 100, y: 80 },
    ]);
  });
});

describe('portSwapToLShape off a corner', () => {
  it('does not swap to an L that turns on the face it leaves, along the source side', () => {
    // From A's bottom down to B's top, B's centre in line with A's right side: the L out of A's
    // right face would run straight down A's right side, out of its corner.
    const nodes: any[] = [
      { id: 'A', x: 0, y: 0, width: 40, height: 40 },
      { id: 'B', x: 20, y: 100, width: 40, height: 40 },
    ];
    const points = [
      { x: 0, y: 20 },
      { x: 0, y: 50 },
      { x: 20, y: 50 },
      { x: 20, y: 80 },
    ];
    const edges: any[] = [{ id: 'A_B', start: 'A', end: 'B', points: [...points] }];
    portSwapToLShape(edges, nodes);
    expect(edges[0].points).toEqual(points);
  });
});
