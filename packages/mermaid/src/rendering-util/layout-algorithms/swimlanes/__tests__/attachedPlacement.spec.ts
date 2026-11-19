import { describe, expect, it } from 'vitest';
import type { LayoutData, Node } from '../../../types.js';
import { pinAnchoredNodes } from '../anchoredNodes.js';
import { flowsFromOneBorderCross } from '../attachedPlacement.js';

const at = (id: string, x: number, y: number, width = 100, height = 60): Node =>
  ({ id, x, y, width, height, isGroup: false }) as Node;

/** A boundary event: attached to `hostId`'s border, no stand-off, drawn 36 across. */
const boundary = (id: string, hostId: string): Node =>
  ({
    id,
    width: 46,
    height: 96,
    isGroup: false,
    metadata: { anchorTo: { hostId }, drawnExtent: { width: 36, height: 36 } },
  }) as unknown as Node;

const edge = (id: string, start: string, end: string) => ({ id, start, end });

describe('boundary events placed by where their flows go', () => {
  it('orders two events on one border so that their flows do not cross', () => {
    // A host with two events; one flows up and right (behind the host's bottom border), the
    // other right at the border's height. The one that turns back has to be the one nearer
    // the targets, or the other one's flow passes under its exit.
    const host = at('h', 100, 100, 300, 80);
    const nodes = [
      host,
      boundary('up', 'h'),
      boundary('level', 'h'),
      at('A', 600, -100),
      at('B', 600, 150),
    ];
    const layout = {
      nodes,
      edges: [edge('e1', 'up', 'A'), edge('e2', 'level', 'B')],
    } as unknown as LayoutData;
    pinAnchoredNodes(layout, { space: 'canonical', direction: 'TB' });
    const [up, level] = [nodes[1], nodes[2]];
    const onTop = up.y! < host.y!;
    expect(onTop || up.x! > level.x!).toBe(true);
  });

  it("takes the end of the border towards its flow's target, clear of the host's own flow", () => {
    // The host's own flow leaves for a node down and to the right; the event's flow goes down
    // and to the left. By default the event sits at the right end of the bottom border.
    const host = at('h', 100, 100, 200, 80);
    const nodes = [host, boundary('ev', 'h'), at('right', 300, 300), at('left', -100, 300)];
    const layout = {
      nodes,
      edges: [edge('own', 'h', 'right'), edge('out', 'ev', 'left')],
    } as unknown as LayoutData;
    pinAnchoredNodes(layout, { space: 'canonical', direction: 'TB' });
    expect(nodes[1].x!).toBeLessThan(host.x!);
    expect(nodes[1].y!).toBe(140);
  });

  it('keeps the default place, the right end of the bottom border, when nothing decides', () => {
    const host = at('h', 100, 100, 200, 80);
    const nodes = [host, boundary('ev', 'h')];
    pinAnchoredNodes({ nodes, edges: [] } as unknown as LayoutData, {
      space: 'canonical',
      direction: 'TB',
    });
    expect(nodes[1]).toMatchObject({ x: 100 + 100 - 8 - 18, y: 140 });
  });

  it('pins in the drawn space where it chose in the layout space, turned for LR', () => {
    const host = at('h', 100, 100, 80, 200);
    const nodes = [host, boundary('ev', 'h'), at('t', 400, 300)];
    const layout = { nodes, edges: [edge('out', 'ev', 't')] } as unknown as LayoutData;
    pinAnchoredNodes(layout, { space: 'canonical', direction: 'LR' });
    // In the layout's own space LR runs downwards: the event is on the right border, which is
    // drawn as the bottom one.
    expect(nodes[1].x).toBe(140);
    const pins = pinAnchoredNodes(layout, { space: 'final', direction: 'LR' });
    expect(pins[0].side).toBe('bottom');
  });
});

describe('flowsFromOneBorderCross', () => {
  const down = { x: 0, y: 1 };
  it('finds the flow that passes the other exit and ends nearer the border crossing it', () => {
    // Exits at x 0 and 100 under a border; both flows head right to x 500.
    expect(
      flowsFromOneBorderCross(
        { x: 0, y: 0 },
        { x: 500, y: -100 },
        { x: 100, y: 0 },
        { x: 500, y: 50 },
        down
      )
    ).toBe(true);
    expect(
      flowsFromOneBorderCross(
        { x: 0, y: 0 },
        { x: 500, y: 50 },
        { x: 100, y: 0 },
        { x: 500, y: -100 },
        down
      )
    ).toBe(false);
  });

  it('counts flows heading towards each other as crossing, and flows heading apart as not', () => {
    expect(
      flowsFromOneBorderCross(
        { x: 0, y: 0 },
        { x: 500, y: 50 },
        { x: 100, y: 0 },
        { x: -400, y: 50 },
        down
      )
    ).toBe(true);
    expect(
      flowsFromOneBorderCross(
        { x: 0, y: 0 },
        { x: -500, y: 50 },
        { x: 100, y: 0 },
        { x: 400, y: 50 },
        down
      )
    ).toBe(false);
  });
});
