import { describe, expect, it } from 'vitest';
import { meetDiamondsAtTheirVertex } from '../direction/endpointClip.js';

interface Point {
  x: number;
  y: number;
}

interface TestEdge {
  id: string;
  start: string;
  end: string;
  points: Point[];
}

const edge = (id: string, start: string, end: string, ...points: Point[]): TestEdge => ({
  id,
  start,
  end,
  points,
});

/** A pointed node that asks for one line per vertex and writes its caption below. */
const gateway = {
  id: 'g',
  x: 100,
  y: 100,
  width: 120,
  height: 158,
  metadata: {
    endpointProfile: 'vertex',
    oneLinePerVertex: true,
    captionBelow: true,
    drawnExtent: { width: 50, height: 50 },
  },
};

const flat = (id: string, x: number, y: number, width: number, height: number) => ({
  id,
  x,
  y,
  width,
  height,
  metadata: { endpointProfile: 'flat' },
});

const nodes = (...list: { id: string }[]) => new Map(list.map((node) => [node.id, node]));

describe('a vertex for each flow of a gateway', () => {
  it('leaves by the vertex facing the flow, not round the shape', () => {
    // In from the left, one flow out to the right and one down to the right. The router began
    // the second beside the shape's bottom-left corner; it should leave by the bottom vertex
    // and never pass above the centre or left of the shape.
    const incoming = edge('in', 'a', 'g', { x: -100, y: 100 }, { x: 75, y: 100 });
    const right = edge('right', 'g', 'b', { x: 125, y: 100 }, { x: 300, y: 100 });
    const lower = edge(
      'lower',
      'g',
      'c',
      { x: 64, y: 125 },
      { x: 64, y: 146 },
      { x: 237, y: 146 },
      { x: 237, y: 215 },
      { x: 285, y: 215 }
    );
    meetDiamondsAtTheirVertex(
      [incoming, right, lower],
      nodes(
        gateway,
        flat('a', -160, 100, 120, 80),
        flat('b', 360, 100, 120, 80),
        flat('c', 345, 215, 120, 80)
      )
    );
    expect(lower.points[0]).toEqual({ x: 100, y: 125 });
    for (const point of lower.points) {
      expect(point.y).toBeGreaterThanOrEqual(100);
      expect(point.x).toBeGreaterThanOrEqual(75);
    }
    expect(right.points[0]).toEqual({ x: 125, y: 100 });
    expect(incoming.points.at(-1)).toEqual({ x: 75, y: 100 });
  });

  it('runs straight on into a flat node the vertex lines up with', () => {
    // The route goes up, over and down into the target's far side; the target lies straight
    // below the bottom vertex.
    const event = {
      id: 's',
      x: 0,
      y: 0,
      width: 90,
      height: 96,
      metadata: { endpointProfile: 'vertex', drawnExtent: { width: 36, height: 36 } },
    };
    const target = flat('t', 0, 300, 300, 200);
    const flow = edge(
      'f',
      's',
      't',
      { x: 0, y: -18 },
      { x: 0, y: -40 },
      { x: 200, y: -40 },
      { x: 200, y: 300 },
      { x: 150, y: 300 }
    );
    meetDiamondsAtTheirVertex([flow], nodes(event, target));
    expect(flow.points).toEqual([
      { x: 0, y: 18 },
      { x: 0, y: 200 },
    ]);
  });

  it("keeps clear of the far end's side, as of its own node's", () => {
    // From the left face of a task above and to the right, into an event below it. Running down
    // close beside the task's left face is shorter than one turn out of its bottom face, but
    // hugs the task.
    const event = {
      id: 'e',
      x: 0,
      y: 582,
      width: 76,
      height: 96,
      metadata: { endpointProfile: 'vertex', drawnExtent: { width: 36, height: 36 } },
    };
    const task = flat('t', 83, 454, 136, 80);
    const flow = edge('f', 't', 'e', { x: 15, y: 454 }, { x: 6, y: 454 }, { x: 6, y: 564 });
    meetDiamondsAtTheirVertex([flow], nodes(event, task));
    expect(flow.points[0].y).toBe(494);
    expect(flow.points.at(-1)).toEqual({ x: 18, y: 582 });
  });
});

/** An event on the bottom border of a host shape, with room for its caption under it. */
const boundaryEvent = (x: number, y: number) => ({
  id: 'b',
  x,
  y,
  width: 46,
  height: 96,
  metadata: { endpointProfile: 'vertex', drawnExtent: { width: 36, height: 36 } },
});

describe('a vertex way past the shapes and texts round it', () => {
  it('does not run along the border of the shape an event sits on', () => {
    // The event sits on the bottom border of a big frame; the target lies to the right at the
    // border's height. Straight on would run along the border for the frame's width.
    const frame = flat('f', 0, 0, 400, 200);
    const target = flat('t', 500, 100, 120, 80);
    const flow = edge('m', 'b', 't', { x: 118, y: 100 }, { x: 440, y: 100 });
    meetDiamondsAtTheirVertex([flow], nodes(boundaryEvent(100, 100), frame, target));
    for (let i = 0; i < flow.points.length - 1; i++) {
      const [a, b] = [flow.points[i], flow.points[i + 1]];
      const alongBorder = Math.abs(a.y - 100) < 10 && Math.abs(b.y - 100) < 10;
      const overFrame = Math.min(a.x, b.x) < 200;
      expect(alongBorder && overFrame).toBe(false);
    }
  });

  it('turns past its own caption, not through it', () => {
    // The event sits on the bottom border of a task; its caption is written under it. The flow
    // leaves downward and turns to the right, to an event level with the task.
    const task = flat('t', 36, 0, 121, 80);
    const target = {
      id: 'e',
      x: 164,
      y: 0,
      width: 36,
      height: 96,
      metadata: { endpointProfile: 'vertex', drawnExtent: { width: 36, height: 36 } },
    };
    const flow = edge('m', 'b', 'e', { x: 54, y: 48 }, { x: 164, y: 48 }, { x: 164, y: 18 });
    meetDiamondsAtTheirVertex([flow], nodes(boundaryEvent(36, 40), task, target));
    const caption = { left: 13, right: 59, top: 58, bottom: 88 };
    for (let i = 1; i < flow.points.length - 1; i++) {
      const [a, b] = [flow.points[i], flow.points[i + 1]];
      const inside =
        Math.max(a.x, b.x) > caption.left &&
        Math.min(a.x, b.x) < caption.right &&
        Math.max(a.y, b.y) > caption.top &&
        Math.min(a.y, b.y) < caption.bottom;
      expect(inside).toBe(false);
    }
  });
});

describe('a vertex way that turns back', () => {
  it('comes in by a vertex it shares rather than run round the node to the far one', () => {
    // An event with flows in from above, below and the left. One more comes from the lower
    // left: in by the left vertex it runs along the flow already there; in by the right one it
    // runs round the event. Running round is worse.
    const event = {
      id: 'e',
      x: 0,
      y: 0,
      width: 76,
      height: 96,
      metadata: { endpointProfile: 'vertex', drawnExtent: { width: 36, height: 36 } },
    };
    const sources = ['a', 'b', 'c', 'd'].map((id, k) => flat(id, -400, k * 300 - 400, 100, 60));
    const above = edge('A', 'a', 'e', { x: -200, y: -100 }, { x: 0, y: -100 }, { x: 0, y: -18 });
    const below = edge('B', 'b', 'e', { x: 0, y: 200 }, { x: 0, y: 18 });
    const left = edge('C', 'c', 'e', { x: -200, y: 0 }, { x: -18, y: 0 });
    const lowerLeft = edge(
      'D',
      'd',
      'e',
      { x: -200, y: 60 },
      { x: -100, y: 60 },
      { x: -100, y: 0 },
      { x: -18, y: 0 }
    );
    meetDiamondsAtTheirVertex([above, below, left, lowerLeft], nodes(event, ...sources));
    expect(lowerLeft.points.at(-1)).not.toEqual({ x: 18, y: 0 });
  });
});
