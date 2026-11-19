import { describe, expect, it } from 'vitest';
import { meetDiamondsAtTheirVertex } from '../direction/endpointClip.js';

const event = (id: string, x: number, y: number, metadata: Record<string, unknown> = {}) => ({
  id,
  x,
  y,
  width: 76,
  height: 96,
  metadata: { endpointProfile: 'vertex', drawnExtent: { width: 36, height: 36 }, ...metadata },
});

const flat = (id: string, x: number, y: number, width = 100, height = 60) => ({
  id,
  x,
  y,
  width,
  height,
  metadata: { endpointProfile: 'flat' },
});

const nodes = (...list: { id: string }[]) => new Map<string, any>(list.map((n) => [n.id, n]));

describe('a flow out of a boundary event', () => {
  it('leaves the event on its outer side, not along or under its host', () => {
    // A timer on the bottom border of a task (bottom y 40); its flow runs right to an event a
    // little below. Its right vertex lies on the task's border, so leaving by it runs along
    // the border, behind the task's edge.
    const host = flat('t', 0, 0, 125, 80);
    const timer = event('b', 36, 40, { anchorTo: { hostId: 't' } });
    const target = event('e', 137, 65);
    const flow = {
      id: 'f',
      start: 'b',
      end: 'e',
      points: [
        { x: 54, y: 40 },
        { x: 66, y: 40 },
        { x: 66, y: 65 },
        { x: 119, y: 65 },
      ],
    };
    meetDiamondsAtTheirVertex([flow], nodes(host, timer, target));
    const [first, second] = flow.points;
    expect(first).toEqual({ x: 36, y: 58 });
    for (let i = 0; i < flow.points.length - 1; i++) {
      const [a, b] = [flow.points[i], flow.points[i + 1]];
      const alongBorder = Math.abs(a.y - 40) < 2 && Math.abs(b.y - 40) < 2;
      expect(alongBorder).toBe(false);
    }
    expect(second.x).toBe(36);
  });
});
