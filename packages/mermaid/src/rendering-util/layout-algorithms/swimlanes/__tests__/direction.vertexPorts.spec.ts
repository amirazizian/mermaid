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
});
