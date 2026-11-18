import { describe, expect, it } from 'vitest';
import { BpmnDb } from '../../../../diagrams/bpmn/bpmnDb.js';
import type { LayoutData, Node } from '../../../types.js';
import { prepareSwimlaneLayout } from '../index.js';
import { runSwimlaneLayoutCore } from '../layoutCore.js';

interface Point {
  x: number;
  y: number;
}

/** A task with `count` data objects associated with it, in a lane of a pool. */
const source = (direction: string, count: number) =>
  [
    `bpmn-beta ${direction}`,
    '  pool p "Company"',
    '    lane l "Sales"',
    '      start s "Begin"',
    '      task t "Check"',
    '      end e "Done"',
    ...Array.from({ length: count }, (_, i) => `      data d${i} "Doc ${i}"`),
    '  s --> t --> e',
    ...Array.from({ length: count }, (_, i) => `  d${i} ..> t`),
  ].join('\n');

/** A task with a text annotation associated with it, on its own. */
const noted = (direction: string) =>
  [
    `bpmn-beta ${direction}`,
    '  pool p "Company"',
    '    lane l "Sales"',
    '      start s "Begin"',
    '      task t "Check"',
    '      end e "Done"',
    '      note n "Limits from the policy"',
    '  s --> t --> e',
    '  n ... t',
  ].join('\n');

const SIZES: Record<string, { width: number; height: number }> = {
  'bpmn-start': { width: 90, height: 96 },
  'bpmn-end': { width: 90, height: 96 },
  'bpmn-activity': { width: 120, height: 80 },
  'bpmn-data': { width: 70, height: 110 },
  'bpmn-annotation': { width: 160, height: 40 },
};

const laidOut = (text: string): LayoutData => {
  const db = new BpmnDb();
  db.parse(text);
  const layout = db.getData();
  for (const node of layout.nodes) {
    if (!node.isGroup) {
      Object.assign(node, SIZES[String(node.shape)] ?? { width: 100, height: 60 });
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

const find = (layout: LayoutData, id: string) => layout.nodes.find((n) => n.id === id)!;

const lineOf = (layout: LayoutData, from: string): Point[] => {
  const edge = layout.edges.find((e) => e.start === from && !e.isLayoutOnly)!;
  const points = edge.points as Point[];
  return points.filter(
    (p, i) => i === 0 || Math.abs(p.x - points[i - 1].x) + Math.abs(p.y - points[i - 1].y) > 1e-6
  );
};

describe('data objects round a TB task', () => {
  it.each([2, 4])('keeps %i of them inside the lane', (count) => {
    const layout = laidOut(source('TB', count));
    const lane = boxOf(find(layout, 'l'));
    for (let i = 0; i < count; i++) {
      const box = boxOf(find(layout, `d${i}`));
      expect(box.left).toBeGreaterThanOrEqual(lane.left);
      expect(box.right).toBeLessThanOrEqual(lane.right);
      expect(box.top).toBeGreaterThanOrEqual(lane.top);
      expect(box.bottom).toBeLessThanOrEqual(lane.bottom);
    }
  });

  it('puts two of them on either side of the task, each with a straight line', () => {
    const layout = laidOut(source('TB', 2));
    const task = find(layout, 't');
    const sides = [0, 1].map((i) => Math.sign(find(layout, `d${i}`).x! - task.x!));
    expect(sides.sort()).toEqual([-1, 1]);
    for (const i of [0, 1]) {
      const line = lineOf(layout, `d${i}`);
      expect(line).toHaveLength(2);
      expect(line[0].y).toBeCloseTo(line[1].y, 6);
    }
  });
});

describe('data objects under an LR task', () => {
  it('slides the run so that two of three stand in front of the task, straight below it', () => {
    const layout = laidOut(source('LR', 3));
    const task = boxOf(find(layout, 't'));
    const straight = [0, 1, 2].filter((i) => {
      const line = lineOf(layout, `d${i}`);
      return line.length === 2 && Math.abs(line[0].x - line[1].x) < 1e-6;
    });
    expect(straight.length).toBeGreaterThanOrEqual(2);
    for (const i of straight) {
      const x = find(layout, `d${i}`).x!;
      expect(x).toBeGreaterThan(task.left);
      expect(x).toBeLessThan(task.right);
    }
  });
});

describe('a text annotation under an LR task', () => {
  it('stands with its bracket under the task, and its line runs straight up from it', () => {
    const layout = laidOut(noted('LR'));
    const task = boxOf(find(layout, 't'));
    const note = boxOf(find(layout, 'n'));
    expect(note.left).toBeGreaterThan(task.left);
    expect(note.left).toBeLessThan(task.right);
    const line = lineOf(layout, 'n');
    expect(line).toHaveLength(2);
    expect(line[0].x).toBeCloseTo(line[1].x, 6);
    expect(Math.abs(line[0].x - note.left)).toBeLessThan(6);
  });
});
