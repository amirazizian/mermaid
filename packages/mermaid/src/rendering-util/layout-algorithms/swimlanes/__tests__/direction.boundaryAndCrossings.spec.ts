import { describe, expect, it } from 'vitest';
import { meetDiamondsAtTheirVertex } from '../direction/endpointClip.js';
import { rerouteDetouredEdges } from '../direction/detourRerouting.js';

interface Point {
  x: number;
  y: number;
}

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

const crossings = (route: Point[], other: Point[]) => {
  let count = 0;
  for (let i = 0; i < route.length - 1; i++) {
    for (let j = 0; j < other.length - 1; j++) {
      const [a, b, c, d] = [route[i], route[i + 1], other[j], other[j + 1]];
      const h = Math.abs(a.y - b.y) < 1e-6;
      const hOther = Math.abs(c.y - d.y) < 1e-6;
      if (h === hOther) {
        continue;
      }
      const [hs, vs] = h
        ? [
            [a, b],
            [c, d],
          ]
        : [
            [c, d],
            [a, b],
          ];
      const inX = vs[0].x > Math.min(hs[0].x, hs[1].x) && vs[0].x < Math.max(hs[0].x, hs[1].x);
      const inY = hs[0].y > Math.min(vs[0].y, vs[1].y) && hs[0].y < Math.max(vs[0].y, vs[1].y);
      if (inX && inY) {
        count++;
      }
    }
  }
  return count;
};

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

describe('a crossing against a longer way round', () => {
  it('takes a fair way longer into an event rather than cross another flow', () => {
    // From a task left of an event; a flow runs up and down between them. Straight across
    // crosses it; over its top end and down into the task's top face does not.
    const task = flat('a', -300, 0);
    const end = event('e', 0, 0);
    const other = {
      id: 'x',
      start: 'p',
      end: 'q',
      points: [
        { x: -150, y: -60 },
        { x: -150, y: 60 },
      ],
    };
    const flow = {
      id: 'f',
      start: 'a',
      end: 'e',
      points: [
        { x: -250, y: 0 },
        { x: -18, y: 0 },
      ],
    };
    meetDiamondsAtTheirVertex([flow, other], nodes(task, end));
    expect(crossings(flow.points, other.points)).toBe(0);
  });

  it('reroutes a flow that crosses another one, over it, inside the space round it', () => {
    const left = flat('a', 0, 0);
    const right = flat('b', 400, 0);
    const other = {
      id: 'x',
      start: 'p',
      end: 'q',
      points: [
        { x: 200, y: -50 },
        { x: 200, y: 50 },
      ],
    };
    const flow = {
      id: 'f',
      start: 'a',
      end: 'b',
      points: [
        { x: 50, y: 0 },
        { x: 350, y: 0 },
      ],
    };
    rerouteDetouredEdges([flow, other], nodes(left, right));
    expect(crossings(flow.points, other.points)).toBe(0);
  });
});
