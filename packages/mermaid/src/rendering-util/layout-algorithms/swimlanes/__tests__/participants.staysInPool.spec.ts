import { describe, expect, it } from 'vitest';
import { BpmnDb } from '../../../../diagrams/bpmn/bpmnDb.js';
import type { LayoutData, Node } from '../../../types.js';
import { prepareSwimlaneLayout } from '../index.js';
import { runSwimlaneLayoutCore } from '../layoutCore.js';

// A lane where the merge into `e1` is cut off below by a message flow from `approve` down to
// the black-box pool `seller`: every way from `escalate` to `e1` inside the pool crosses it.
const SOURCE = `bpmn-beta LR
  pool buyer "Buyer"
    lane "Purchasing"
      start s1 "Need"
      user task t1 "Check amount"
      xor gw "Approved?"
      task approve "Order goods"
      task reject "Tell requester"
      task escalate "Escalate"
      end e1 "Done"
      note n1 "Limit set by finance"
  pool seller "Seller"
  s1 --> t1
  t1 --> gw
  t1 --> escalate
  gw -- yes --> approve
  gw --> reject
  approve --> e1
  reject --> e1
  escalate --> e1
  approve -.-> seller
  seller -.-> e1
  n1 ... t1
`;

// What the browser measures for each node, and for the shapes drawn smaller than their box
// (an event or gateway over its caption) the size drawn.
const SIZES: Record<string, [number, number]> = {
  s1: [38.25, 96],
  t1: [119.171875, 80],
  gw: [77.390625, 110],
  approve: [104.9375, 80],
  reject: [112.046875, 80],
  escalate: [100, 80],
  e1: [38.25, 96],
  n1: [158.953125, 40],
};
const DRAWN: Record<string, number> = { s1: 36, e1: 36, gw: 50 };
const TITLES: Record<string, [number, number]> = {
  buyer: [41.796875, 24],
  'lane-1': [80.046875, 24],
  seller: [40.90625, 24],
};

const laidOut = (): LayoutData => {
  const db = new BpmnDb();
  db.parse(SOURCE);
  const layout = db.getData();
  layout.nodeSpacing = 35;
  layout.rankSpacing = 40;
  prepareSwimlaneLayout(layout);
  for (const node of layout.nodes) {
    const size = node.isEdgeLabel ? [24.90625, 24] : SIZES[node.id];
    if (size) {
      [node.width, node.height] = size;
    }
    const drawn = DRAWN[node.id];
    if (drawn) {
      node.metadata = { ...node.metadata, drawnExtent: { width: drawn, height: drawn } };
    }
    const title = TITLES[node.id];
    if (title) {
      node.labelBBox = { width: title[0], height: title[1] };
    }
  }
  runSwimlaneLayoutCore(layout);
  return layout;
};

const boxOf = (node: Node) => ({
  left: node.x! - node.width! / 2,
  right: node.x! + node.width! / 2,
  top: node.y! - node.height! / 2,
  bottom: node.y! + node.height! / 2,
});

describe('a flow between two nodes of one pool', () => {
  it('is not rerouted round the outside of the pool to avoid a crossing', () => {
    const layout = laidOut();
    const byId = new Map(layout.nodes.map((node) => [node.id, node]));
    const pool = boxOf(byId.get('buyer')!);
    const inPool = (id: string) => byId.get(id)?.parentId === 'lane-1';
    const flows = layout.edges.filter((edge) => inPool(edge.start!) && inPool(edge.end!));
    expect(flows.length).toBeGreaterThan(0);
    const outside = flows.flatMap((edge) =>
      (edge.points ?? [])
        .filter(
          (p) =>
            p.x < pool.left - 1 ||
            p.x > pool.right + 1 ||
            p.y < pool.top - 1 ||
            p.y > pool.bottom + 1
        )
        .map((p) => `${edge.start} -> ${edge.end} at (${p.x.toFixed(1)}, ${p.y.toFixed(1)})`)
    );
    expect(outside).toEqual([]);
  });
});
