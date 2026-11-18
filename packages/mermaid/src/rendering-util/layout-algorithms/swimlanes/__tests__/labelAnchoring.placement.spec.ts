import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '../../../types.js';
import { anchorLabelsToPolyline, bendsOf, crossesBorder } from '../direction/labelAnchoring.js';

const lane = (id: string, x: number, y: number, width: number, height: number): Node =>
  ({ id, x, y, width, height, isGroup: true, metadata: { laneRole: 'lane' } }) as Node;
const box = (id: string, x: number, y: number, width = 40, height = 40): Node =>
  ({ id, x, y, width, height, isGroup: false, parentId: 'top' }) as Node;
const labelNode = (id: string, width = 30, height = 16): Node =>
  ({ id, x: 0, y: 0, width, height, isGroup: false, isEdgeLabel: true }) as Node;
const edge = (id: string, start: string, end: string, points: { x: number; y: number }[]) =>
  ({ id, start, end, type: 'arrow', points }) as Edge;

const place = (nodes: Node[], edges: Edge[]) => {
  anchorLabelsToPolyline(edges, new Map(nodes.map((node) => [node.id, node])));
  return new Map(nodes.map((node) => [node.id, node]));
};

describe('bendsOf', () => {
  it('lists the points where a line turns, not those it runs straight through', () => {
    expect(
      bendsOf([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 30 },
        { x: 40, y: 30 },
      ])
    ).toEqual([
      { x: 20, y: 0 },
      { x: 20, y: 30 },
    ]);
  });
});

describe('crossesBorder', () => {
  const laneBox = { left: 0, top: 0, right: 100, bottom: 100 };
  it('is true only for a box that reaches over the border', () => {
    expect(crossesBorder(laneBox, { left: 10, top: 90, right: 30, bottom: 110 })).toBe(true);
    expect(crossesBorder(laneBox, { left: 10, top: 10, right: 30, bottom: 30 })).toBe(false);
    expect(crossesBorder(laneBox, { left: 10, top: 120, right: 30, bottom: 130 })).toBe(false);
  });
});

describe('anchorLabelsToPolyline', () => {
  it('puts the label of a branch near its source, clear of the bend', () => {
    // A leaves to B straight right, and to C right, then down, then right.
    const nodes = [
      lane('top', 200, 100, 600, 400),
      box('A', 20, 20),
      box('B', 360, 20),
      box('C', 360, 220),
      labelNode('l1'),
    ];
    const toC = {
      ...edge('A_C', 'A', 'C', [
        { x: 40, y: 20 },
        { x: 200, y: 20 },
        { x: 200, y: 220 },
        { x: 340, y: 220 },
      ]),
      // A second line along the first stretch keeps the label off it.
      labelNodeId: 'l1',
    } as Edge;
    const toB = edge('A_B', 'A', 'B', [
      { x: 40, y: 30 },
      { x: 340, y: 30 },
    ]);
    const placed = place(nodes, [toC, toB]).get('l1')!;
    // On the stretch down from the bend, near its top, and not over the bend.
    expect(placed.x).toBe(200);
    expect(placed.y!).toBeGreaterThan(20 + 8 + 4);
    expect(placed.y!).toBeLessThan(120);
  });

  it('keeps a label off a lane border its line crosses', () => {
    const nodes = [
      lane('upper', 200, 50, 400, 100),
      lane('lower', 200, 150, 400, 100),
      { ...box('A', 50, 50), parentId: 'upper' } as Node,
      { ...box('B', 50, 150), parentId: 'lower' } as Node,
      labelNode('l1'),
    ];
    const down = {
      ...edge('A_B', 'A', 'B', [
        { x: 50, y: 70 },
        { x: 50, y: 130 },
      ]),
      labelNodeId: 'l1',
    } as Edge;
    const placed = place(nodes, [down]).get('l1')!;
    const top = placed.y! - 8;
    const bottom = placed.y! + 8;
    // Either wholly above the border at y = 100, or wholly below it, with room.
    expect(bottom <= 100 - 3 || top >= 100 + 3).toBe(true);
  });
});
