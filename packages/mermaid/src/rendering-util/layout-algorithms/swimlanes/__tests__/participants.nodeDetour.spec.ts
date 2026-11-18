import { describe, expect, it } from 'vitest';
import type { Edge, LayoutData, Node } from '../../../types.js';
import { crosses, linkParticipantBands } from '../direction/participantLinks.js';

const pool = (id: string, y: number, height: number): Node =>
  ({
    id,
    isGroup: true,
    x: 300,
    y,
    width: 600,
    height,
    metadata: { laneRole: 'pool' },
  }) as Node;

const task = (id: string, x: number, y: number, extra: Partial<Node> = {}): Node =>
  ({ id, isGroup: false, parentId: 'p1', x, y, width: 100, height: 80, ...extra }) as Node;

const message = (start: string, end: string): Edge =>
  ({ id: `${start}-${end}`, start, end, type: 'normal' }) as Edge;

const boxOf = (node: Node) => ({
  left: node.x! - node.width! / 2,
  right: node.x! + node.width! / 2,
  top: node.y! - node.height! / 2,
  bottom: node.y! + node.height! / 2,
});

const runsThrough = (points: { x: number; y: number }[], node: Node): boolean =>
  points.slice(1).some((end, i) => crosses(points[i], end, boxOf(node)));

// p1 spans y 0..300 and p2 spans 340..440. Task `a` sits above task `b` in p1, so a message
// flow from `a` straight down to p2 would run through `b`.
const stacked = (bExtra: Partial<Node> = {}) =>
  ({
    nodes: [
      pool('p1', 150, 300),
      pool('p2', 390, 100),
      task('a', 300, 60),
      task('b', 300, 200, bExtra),
      task('c', 450, 200),
    ],
    edges: [message('a', 'p2')],
  }) as LayoutData;

describe('a message flow from a node to a participant', () => {
  it('passes beside a node that lies across its run instead of through it', () => {
    const layout = stacked();
    linkParticipantBands(layout);
    const points = layout.edges[0].points!;
    const byId = new Map(layout.nodes.map((node) => [node.id, node]));
    expect(runsThrough(points, byId.get('b')!)).toBe(false);
    expect(runsThrough(points, byId.get('c')!)).toBe(false);
    // It still starts on `a` and ends on p2's top border.
    expect(points[0].x === 350 || points[0].y === 100).toBe(true);
    expect(points.at(-1)!.y).toBe(340);
  });

  it('runs straight past what a node leaves undrawn of its box', () => {
    // `b` draws only a narrow shape at its centre, such as a data object over its caption.
    const layout = stacked({ x: 380, metadata: { drawnExtent: { width: 36, height: 50 } } });
    linkParticipantBands(layout);
    expect(layout.edges[0].points).toEqual([
      { x: 300, y: 100 },
      { x: 300, y: 340 },
    ]);
  });
});
