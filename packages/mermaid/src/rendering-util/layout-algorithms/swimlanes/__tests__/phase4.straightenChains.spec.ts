import { describe, it, expect } from 'vitest';
import type { EdgeRef, Graph, NodeId, OrderedLayers } from '../helpers.js';
import { assignCoordinates } from '../phase4.coordinates.js';

/** One lane, nodes sized by `widths` along the cross axis (TB, so x is across the lane). */
function mkGraph(widths: Record<string, number>, edgePairs: [string, string][]): Graph {
  const ids = Object.keys(widths);
  const nodes = ids.map((id) => ({ id, isGroup: false, width: widths[id], height: 40 }));
  const edges: EdgeRef[] = edgePairs.map(([src, dst], i) => ({
    id: `e${i}`,
    src,
    dst,
    ref: { id: `e${i}`, start: src, end: dst } as any,
  }));
  return {
    nodes: ids,
    edges,
    layout: { nodes, edges: [] } as any,
    nodeById: new Map<NodeId, any>(nodes.map((n) => [n.id, n])),
  };
}

const place = (g: Graph, layers: string[][], straightenChains: boolean) =>
  assignCoordinates({ layers } as OrderedLayers, g, { nodeGap: 20, straightenChains }).x;

describe('straightenChains', () => {
  // a1 -> a2 -> a3 beside b1 -> b2, where b2 is wider than b1: every rank is centred on
  // its own, so the a chain wanders across the lane by half the difference.
  const twoChains = () =>
    mkGraph({ a1: 100, a2: 100, a3: 100, b1: 100, b2: 140 }, [
      ['a1', 'a2'],
      ['a2', 'a3'],
      ['b1', 'b2'],
    ]);
  const layers = [['a1', 'b1'], ['a2', 'b2'], ['a3']];

  it('leaves the centred placement alone when it is off', () => {
    const x = place(twoChains(), layers, false);
    expect(new Set([x.a1, x.a2, x.a3]).size).toBe(3);
  });

  it('puts every node of a one-to-one chain on one line', () => {
    const x = place(twoChains(), layers, true);
    expect(x.a2).toBe(x.a1);
    expect(x.a3).toBe(x.a1);
    expect(x.b2).toBe(x.b1);
  });

  it('keeps the gap to the other nodes of a rank', () => {
    const x = place(twoChains(), layers, true);
    expect(x.b2 - 70 - (x.a2 + 50)).toBeGreaterThanOrEqual(20);
    expect(x.b1 - 50 - (x.a1 + 50)).toBeGreaterThanOrEqual(20);
  });

  it('leaves a merge centred between its branches', () => {
    const g = mkGraph({ s: 60, up: 100, down: 100, e: 60 }, [
      ['s', 'up'],
      ['s', 'down'],
      ['up', 'e'],
      ['down', 'e'],
    ]);
    const merged = [['s'], ['up', 'down'], ['e']];
    expect(place(g, merged, true)).toEqual(place(g, merged, false));
  });
});
