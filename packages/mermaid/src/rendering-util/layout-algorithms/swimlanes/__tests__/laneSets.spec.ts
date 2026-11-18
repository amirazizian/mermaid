import { describe, expect, it } from 'vitest';
import { BpmnDb } from '../../../../diagrams/bpmn/bpmnDb.js';
import type { LayoutData, Node } from '../../../types.js';
import { prepareSwimlaneLayout } from '../index.js';
import { runSwimlaneLayoutCore } from '../layoutCore.js';
import { buildLaneModel } from '../lanes.js';

const SIZE = { width: 100, height: 60 };

const source = (direction: string) => `bpmn-beta ${direction}
  pool p "Company"
    lane sales "Sales"
      lane inside "Inside sales"
        lane north "North"
          start s1 "Lead"
          task t1 "Call"
        lane south "South"
          task t0 "Mail"
      lane field "Field sales"
        task t2 "Visit"
    lane wh "Warehouse"
      task t3 "Ship"
  s1 --> t1 --> t2 --> t3
  s1 --> t0 --> t2
`;

const laidOut = (direction: string): LayoutData => {
  const db = new BpmnDb();
  db.parse(source(direction));
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

describe('the lane model of lanes nested in lanes', () => {
  it('takes the innermost lanes as the lanes, and the lanes round them as lane sets', () => {
    const db = new BpmnDb();
    db.parse(source('LR'));
    const model = buildLaneModel(db.getData().nodes);
    expect(model.lanesByPool.get('p')).toEqual(['north', 'south', 'field', 'wh']);
    expect(model.laneSets).toEqual(['sales', 'inside']);
    expect(['sales', 'inside'].map((id) => model.isLane(id))).toEqual([false, false]);
    expect(['north', 'south', 'field', 'wh', 'sales'].map(model.laneDepth)).toEqual([
      2, 2, 1, 0, 0,
    ]);
    expect(model.laneIdOf('t1')).toBe('north');
    expect(model.poolIdOf('t1')).toBe('p');
  });

  it('leaves a subgraph in a lane of a plain swimlane a plain box', () => {
    const model = buildLaneModel([
      { id: 'l', isGroup: true },
      { id: 'g', isGroup: true, parentId: 'l' },
    ] as Node[]);
    expect(model.isLane('l')).toBe(true);
    expect(model.isLane('g')).toBe(false);
    expect(model.laneSets).toEqual([]);
  });
});

// Along: the axis the lanes are stacked on. Title: the side their titles are drawn on.
describe.each([
  ['LR', { across: ['top', 'bottom'], title: 'left', far: 'right' }],
  ['TB', { across: ['left', 'right'], title: 'top', far: 'bottom' }],
] as const)('lanes nested in lanes (%s)', (direction, { across, title, far }) => {
  const layout = laidOut(direction);
  const byId = new Map(layout.nodes.map((node) => [node.id, node]));
  const box = (id: string) => boxOf(byId.get(id)!);
  const [low, high] = across;
  const outward = title === 'left' || title === 'top' ? -1 : 1;
  const band = (box('inside')[title] - box('north')[title]) * outward;

  it('frames a lane set round its lanes, its title band beside theirs', () => {
    expect(band).toBeGreaterThan(0);
    for (const [set, first, last] of [
      ['inside', 'north', 'south'],
      ['sales', 'north', 'field'],
    ]) {
      expect(box(set)[low]).toBeCloseTo(box(first)[low], 3);
      expect(box(set)[high]).toBeCloseTo(box(last)[high], 3);
      expect(box(set)[far]).toBeCloseTo(box(first)[far], 3);
    }
    expect(box('sales')[title]).toBeCloseTo(box('inside')[title] + outward * band, 3);
    expect(box('field')[title]).toBeCloseTo(box('inside')[title], 3);
    expect(box('wh')[title]).toBeCloseTo(box('sales')[title], 3);
    expect(box('p')[title]).toBeCloseTo(box('sales')[title] + outward * band, 3);
  });

  it('gives each title band its own strip', () => {
    for (const id of ['sales', 'inside', 'north']) {
      expect(byId.get(id)!.groupTitleRect![title]).toBeCloseTo(box(id)[title], 3);
    }
    for (const id of ['sales', 'inside']) {
      const rect = byId.get(id)!.groupTitleRect!;
      const inner = title === 'left' ? 'right' : 'bottom';
      expect(Math.abs(rect[inner] - rect[title])).toBeCloseTo(band, 3);
    }
  });

  it('keeps the lanes of a set apart and each node in its own lane', () => {
    expect(box('north')[high]).toBeLessThanOrEqual(box('south')[low] + 0.5);
    expect(box('south')[high]).toBeLessThanOrEqual(box('field')[low] + 0.5);
    expect(box('field')[high]).toBeLessThanOrEqual(box('wh')[low] + 0.5);
    for (const [node, lane] of [
      ['t1', 'north'],
      ['t0', 'south'],
      ['t2', 'field'],
      ['t3', 'wh'],
    ]) {
      expect(box(node)[low]).toBeGreaterThanOrEqual(box(lane)[low]);
      expect(box(node)[high]).toBeLessThanOrEqual(box(lane)[high]);
    }
  });
});
