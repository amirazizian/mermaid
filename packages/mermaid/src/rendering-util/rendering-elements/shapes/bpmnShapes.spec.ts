import { afterEach, describe, it, expect, vi } from 'vitest';
import { select } from 'd3';
import type { Node } from '../../types.js';
import { isValidShape, shapes } from '../shapes.js';
import {
  EVENT_RINGS,
  captionRoomWidth,
  faceCentreIntersect,
  fitWrappedLabel,
} from './bpmnShapeCore.js';
import { bpmnIcons } from './bpmnIcons.js';
import bpmnStyles from '../../../diagrams/bpmn/styles.js';
import type { BpmnStyleOptions } from '../../../diagrams/bpmn/styles.js';

const BPMN_SHAPES = [
  'bpmn-start',
  'bpmn-intermediate',
  'bpmn-boundary',
  'bpmn-end',
  'bpmn-gateway',
  'bpmn-activity',
  'bpmn-data',
  'bpmn-data-store',
  'bpmn-annotation',
];

describe('BPMN shape registration', () => {
  it.each(BPMN_SHAPES)('registers %s', (name) => {
    expect(isValidShape(name)).toBe(true);
    expect(Object.keys(shapes)).toContain(name);
  });

  // flowDb rejects a shape name that is not lowercase, or that contains an underscore,
  // before it ever reaches the registry. These names have to survive that check or the
  // whole vocabulary becomes unreachable from a flowchart.
  it.each(BPMN_SHAPES)('%s can be named from a flowchart', (name) => {
    expect(name).toBe(name.toLowerCase());
    expect(name).not.toContain('_');
  });
});

describe('event ring weights', () => {
  it('draws a start event with one thin ring and an end event with one thick ring', () => {
    expect(EVENT_RINGS.start.rings).toBe(1);
    expect(EVENT_RINGS.end.rings).toBe(1);
    expect(EVENT_RINGS.end.strokeWidth).toBeGreaterThan(EVENT_RINGS.start.strokeWidth);
  });

  it('draws an intermediate and a boundary event with a double ring', () => {
    expect(EVENT_RINGS.intermediate.rings).toBe(2);
    expect(EVENT_RINGS.boundary.rings).toBe(2);
  });
});

describe('faceCentreIntersect', () => {
  const node = { id: 'n', x: 100, y: 50 } as Node;

  it.each([
    ['above', { x: 100, y: -100 }, { x: 100, y: 30 }],
    ['below', { x: 100, y: 200 }, { x: 100, y: 70 }],
    ['the left', { x: -100, y: 50 }, { x: 80, y: 50 }],
    ['the right', { x: 300, y: 50 }, { x: 120, y: 50 }],
  ])('docks a flow arriving from %s on the middle of that border', (_label, from, expected) => {
    expect(faceCentreIntersect(node, 40, 40, from)).toEqual(expected);
  });

  it('chooses the face by the box aspect, not by the raw angle', () => {
    // A short, wide box takes a 45-degree approach on its bottom edge, because relative
    // to its own proportions that approach is mostly vertical.
    expect(faceCentreIntersect(node, 100, 40, { x: 160, y: 110 })).toEqual({ x: 100, y: 70 });
  });
});

describe('the message marker', () => {
  const glyph = bpmnIcons.icons.message.body;

  it('draws the envelope fold as a line of its own', () => {
    expect(glyph).toContain('bpmn-glyph-fold');
  });

  // A throwing marker is filled. Filling the fold along with the envelope leaves a
  // plain rectangle, which is not what the notation draws (BPMN 2.0.2, Table 10.93).
  it('leaves that fold unfilled where the marker is filled', () => {
    const theme: BpmnStyleOptions = {
      border2: '#999',
      edgeLabelBackground: '#fff',
      fontFamily: 'sans-serif',
      lineColor: '#333',
      mainBkg: '#fafafa',
      nodeBorder: '#666',
      nodeTextColor: '#111',
      tertiaryColor: '#eee',
      textColor: '#111',
      titleColor: '#111',
    };
    const sheet = bpmnStyles(theme).replace(/\s+/g, ' ');
    expect(sheet).toMatch(/\.bpmn-throw[^{]*\.bpmn-glyph-fold\s*{[^}]*fill:\s*none/);
  });
});

describe('faceCentreIntersect', () => {
  const node = { x: 100, y: 50 } as Parameters<typeof faceCentreIntersect>[0];

  it('answers on the border when the reference point is the centre', () => {
    // A layout that has not routed an edge hands both node centres to insertEdge, so the
    // vector is zero and describes no direction. The answer still has to be a border.
    const at = faceCentreIntersect(node, 80, 40, { x: 100, y: 50 });
    expect(at).toEqual({ x: 100, y: 70 });
  });

  it('answers on the face the point lies off', () => {
    expect(faceCentreIntersect(node, 80, 40, { x: 400, y: 50 })).toEqual({ x: 140, y: 50 });
    expect(faceCentreIntersect(node, 80, 40, { x: 100, y: -400 })).toEqual({ x: 100, y: 30 });
  });
});

describe('caption room', () => {
  const node = (metadata?: Record<string, unknown>) => ({ id: 'n', metadata }) as Node;

  it('keeps the wrapping width the caption was measured at', () => {
    expect(captionRoomWidth(node(), 36, 120, 64)).toBe(120);
    expect(captionRoomWidth(node(), 50, 30, 30)).toBe(50);
  });

  it('keeps room on both sides for a caption that may move beside the shape', () => {
    expect(captionRoomWidth(node({ captionBeside: true }), 36, 120, 64)).toBe(36 + 2 * (6 + 64));
  });
});

describe('fitWrappedLabel', () => {
  const wrappedLabel = (whiteSpace: string) => {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    const foreignObject = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
    foreignObject.setAttribute('width', '120');
    const div = document.createElement('div');
    div.innerHTML = '<span><p>Payment method?</p></span>';
    div.style.whiteSpace = whiteSpace;
    div.style.width = '120px';
    foreignObject.append(div);
    g.append(foreignObject);
    document.body.append(g);
    return { label: select(g), div, foreignObject };
  };
  const box = { x: 10, y: 5, left: 10, top: 5, width: 120, height: 48 } as DOMRect;

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('narrows a wrapped caption to its longest line', () => {
    const { label, div, foreignObject } = wrappedLabel('normal');
    vi.spyOn(document, 'createRange').mockImplementation(
      () =>
        ({
          selectNodeContents: () => undefined,
          getClientRects: () => [
            { left: 38, right: 102, width: 64 },
            { left: 44, right: 96, width: 52 },
          ],
        }) as unknown as Range
    );
    const fitted = fitWrappedLabel(label, box);
    expect(fitted.width).toBe(65);
    expect(fitted.height).toBe(48);
    expect(fitted.x - fitted.left).toBe(0);
    expect(div.style.width).toBe('65px');
    expect(foreignObject.getAttribute('width')).toBe('65');
  });

  it('leaves a caption on one line, or one it cannot measure, as it is', () => {
    expect(fitWrappedLabel(wrappedLabel('nowrap').label, box)).toBe(box);
    // jsdom lays nothing out, so a range has no rectangles to measure.
    expect(fitWrappedLabel(wrappedLabel('normal').label, box)).toBe(box);
  });
});
