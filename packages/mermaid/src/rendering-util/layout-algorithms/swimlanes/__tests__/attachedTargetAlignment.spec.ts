import { describe, expect, it } from 'vitest';
import type { LayoutData, Node } from '../../../types.js';
import { alignTargetsOfAttachedFlows } from '../attachedTargetAlignment.js';

/**
 * LR, in the layout's own space: the flow runs down y, across x, and a node's drawn height lies
 * across. A task 80 high (across) with a timer on its right border (drawn as the bottom one).
 */
const host = (): Node =>
  ({ id: 'h', x: 0, y: 0, width: 125, height: 80, isGroup: false, parentId: 'lane' }) as Node;
const timer = (): Node =>
  ({
    id: 'b',
    x: 62.5,
    y: 10,
    width: 47,
    height: 96,
    isGroup: false,
    parentId: 'h',
    metadata: { anchorTo: { hostId: 'h' }, drawnExtent: { width: 36, height: 36 } },
  }) as unknown as Node;
const event = (id: string, x: number, y: number): Node =>
  ({
    id,
    x,
    y,
    width: 71,
    height: 96,
    isGroup: false,
    parentId: 'lane',
    metadata: { endpointProfile: 'vertex', drawnExtent: { width: 36, height: 36 } },
  }) as unknown as Node;

const layoutOf = (nodes: Node[], edges: [string, string][]) =>
  ({
    nodes,
    edges: edges.map(([start, end], i) => ({ id: `e${i}`, start, end })),
  }) as unknown as LayoutData;

describe('a target of a flow out of an attached node, lined up for one bend', () => {
  it('moves an event just short of the drop out to where the line can turn into it', () => {
    // The timer's outer vertex is at 40 + 18 = 58 across; the event's centre at 66 leaves the
    // line 8px to turn in, too short. It moves out to 58 + 24.
    const target = event('t', 66, 137);
    alignTargetsOfAttachedFlows(layoutOf([host(), timer(), target], [['b', 't']]), 'LR');
    expect(target.x).toBe(82);
  });

  it('leaves a target that has other flows, or another node in the way, where it is', () => {
    const busy = event('t', 66, 137);
    alignTargetsOfAttachedFlows(
      layoutOf(
        [host(), timer(), busy, event('o', 66, 300)],
        [
          ['b', 't'],
          ['t', 'o'],
        ]
      ),
      'LR'
    );
    expect(busy.x).toBe(66);

    const blocked = event('t', 66, 137);
    alignTargetsOfAttachedFlows(
      layoutOf([host(), timer(), blocked, event('n', 150, 137)], [['b', 't']]),
      'LR'
    );
    expect(blocked.x).toBe(66);
  });

  it('turns past the row of captions when another attached node lies further along', () => {
    const second = { ...timer(), id: 'c', y: 50 } as Node;
    const target = event('t', 66, 137);
    alignTargetsOfAttachedFlows(layoutOf([host(), timer(), second, target], [['b', 't']]), 'LR');
    // Past the caption row: the timer's half across (48) less its drawn half (18), and 12.
    expect(target.x).toBe(58 + 30 + 12);
  });
});
