import { describe, expect, it } from 'vitest';
import { BpmnDb } from '../../../../diagrams/bpmn/bpmnDb.js';
import type { LayoutData, Node } from '../../../types.js';
import { prepareSwimlaneLayout } from '../index.js';
import { runSwimlaneLayoutCore } from '../layoutCore.js';

const SIZE = { width: 100, height: 60 };

const laidOut = (source: string): LayoutData => {
  const db = new BpmnDb();
  db.parse(source);
  const layout = db.getData();
  for (const node of layout.nodes) {
    if (!node.isGroup) {
      Object.assign(node, SIZE);
    }
  }
  prepareSwimlaneLayout(layout);
  runSwimlaneLayoutCore(layout);
  return layout;
};

const boxOf = (node: Node) => ({
  left: node.x! - node.width! / 2,
  right: node.x! + node.width! / 2,
  top: node.y! - node.height! / 2,
  bottom: node.y! + node.height! / 2,
});

const isOrthogonal = (points: { x: number; y: number }[]) =>
  points
    .slice(1)
    .every((p, i) => Math.abs(p.x - points[i].x) < 0.5 || Math.abs(p.y - points[i].y) < 0.5);

describe.each([
  [
    'beside a pool of lanes',
    `bpmn-beta TB
  pool shop "Shop"
    lane "Orders"
      task a "Take order"
      task b "Ship"
    lane "Stock"
      task c "Pick"
  pool bank "Bank"
  pool courier "Courier"
  a --> b
  b --> c
  a -.-> bank
  courier -.-> c
`,
  ],
  [
    'beside a pool without lanes',
    `bpmn-beta TB
  pool shop "Shop"
    task a "Take order"
    task b "Ship"
  pool bank "Bank"
  pool courier "Courier"
  a --> b
  a -.-> bank
  courier -.-> b
`,
  ],
])('a black-box pool in a process that runs downwards, %s', (_name, source) => {
  const layout = laidOut(source);
  const byId = new Map(layout.nodes.map((node) => [node.id, node]));
  const [shop, bank, courier] = ['shop', 'bank', 'courier'].map((id) => boxOf(byId.get(id)!));

  it('gets a column of its own, clear of the other pools', () => {
    for (const box of [bank, courier]) {
      expect(box.right - box.left).toBeGreaterThanOrEqual(60);
    }
    expect(bank.left).toBeGreaterThan(shop.right);
    expect(courier.left).toBeGreaterThan(bank.right);
  });

  it('runs as deep as the pools beside it', () => {
    for (const box of [bank, courier]) {
      expect(box.top).toBeCloseTo(shop.top, 0);
      expect(box.bottom).toBeCloseTo(shop.bottom, 0);
    }
  });

  it('is reached by orthogonal message flows that end on its border', () => {
    for (const edge of layout.edges.filter((e) => e.start === 'courier' || e.end === 'bank')) {
      const points = edge.points ?? [];
      expect(isOrthogonal(points)).toBe(true);
      const onBank = edge.end === 'bank' ? points.at(-1)! : points[0];
      const pool = edge.end === 'bank' ? bank : courier;
      expect(onBank.x).toBeCloseTo(pool.left, 0);
    }
  });
});

describe('an empty lane of a pool in a process that runs downwards', () => {
  it('gets its own column between its neighbours, inside the pool', () => {
    const layout = laidOut(`bpmn-beta TB
  pool p "Company"
    lane la "Sales"
      task a "Sell"
    lane le "Legal"
    lane lb "Stock"
      task b "Ship"
  a --> b
`);
    const byId = new Map(layout.nodes.map((node) => [node.id, node]));
    const [pool, sales, legal, stock] = ['p', 'la', 'le', 'lb'].map((id) => boxOf(byId.get(id)!));
    expect(legal.right - legal.left).toBeGreaterThanOrEqual(60);
    expect(legal.left).toBeCloseTo(sales.right, 0);
    expect(stock.left).toBeCloseTo(legal.right, 0);
    expect(pool.left).toBeLessThanOrEqual(sales.left);
    expect(pool.right).toBeGreaterThanOrEqual(stock.right);
  });
});
