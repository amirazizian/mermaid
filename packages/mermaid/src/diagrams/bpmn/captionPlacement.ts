/**
 * Moves a caption off any line that runs through it.
 *
 * Events, gateways, data objects and data stores write their name under the shape. A flow
 * that leaves such a shape from its bottom side, or passes beside it, would run through
 * the name, so after layout each caption that a line crosses is tried in the other places
 * the notation reads it - above, beside, and at the four corners - and the first place
 * that no line, shape or other text touches wins. A caption that has nowhere free stays
 * where it was. Every shape keeps the band above it that it reserves below, so `above` is
 * room the layout already holds.
 */

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Where a caption may go, as the side of the shape its centre moves to. */
export type CaptionPlace =
  | 'below'
  | 'above'
  | 'right'
  | 'left'
  | 'below-right'
  | 'below-left'
  | 'above-right'
  | 'above-left';

export const CAPTION_PLACES: readonly CaptionPlace[] = [
  'below',
  'above',
  'right',
  'left',
  'below-right',
  'below-left',
  'above-right',
  'above-left',
];

const GAP = 6;
/** A line this close to a caption reads as touching it. */
const CLEARANCE = 2;

const width = (box: Box) => box.right - box.left;
const height = (box: Box) => box.bottom - box.top;

const moved = (box: Box, dx: number, dy: number): Box => ({
  left: box.left + dx,
  right: box.right + dx,
  top: box.top + dy,
  bottom: box.bottom + dy,
});

const overlaps = (a: Box, b: Box, margin = 0) =>
  a.left < b.right + margin &&
  b.left < a.right + margin &&
  a.top < b.bottom + margin &&
  b.top < a.bottom + margin;

const contains = (box: Box, point: Point, margin: number) =>
  point.x > box.left - margin &&
  point.x < box.right + margin &&
  point.y > box.top - margin &&
  point.y < box.bottom + margin;

const within = (inner: Box, outer: Box) =>
  inner.left >= outer.left &&
  inner.right <= outer.right &&
  inner.top >= outer.top &&
  inner.bottom <= outer.bottom;

/** The caption's box at `place` around `shape`. */
export function captionBoxAt(shape: Box, caption: Box, place: CaptionPlace): Box {
  const cx = (shape.left + shape.right) / 2;
  const cy = (shape.top + shape.bottom) / 2;
  const w = width(caption);
  const h = height(caption);
  const below = shape.bottom + GAP + h / 2;
  const above = shape.top - GAP - h / 2;
  const right = shape.right + GAP + w / 2;
  const left = shape.left - GAP - w / 2;
  const [x, y] = {
    below: [cx, below],
    above: [cx, above],
    right: [right, cy],
    left: [left, cy],
    'below-right': [right, below],
    'below-left': [left, below],
    'above-right': [right, above],
    'above-left': [left, above],
  }[place];
  return { left: x - w / 2, right: x + w / 2, top: y - h / 2, bottom: y + h / 2 };
}

export interface Surroundings {
  /** Points sampled along every drawn line. */
  linePoints: Point[];
  /** Everything else a caption may not cover: shapes and other text. */
  occupied: Box[];
  /** The caption has to stay inside this box, usually its lane. */
  bounds?: Box;
}

const isFree = (box: Box, around: Surroundings) =>
  (!around.bounds || within(box, around.bounds)) &&
  !around.linePoints.some((point) => contains(box, point, CLEARANCE)) &&
  !around.occupied.some((other) => overlaps(box, other));

/** Whether a line runs through `caption` where it is now. */
export const isCrossed = (caption: Box, around: Surroundings) =>
  around.linePoints.some((point) => contains(caption, point, CLEARANCE));

/**
 * Where a crossed caption should move to, as the offset of its box, or `undefined`
 * when it is not crossed or no place around the shape is free.
 */
export function placeCaption(
  shape: Box,
  caption: Box,
  around: Surroundings
): { place: CaptionPlace; dx: number; dy: number } | undefined {
  if (!isCrossed(caption, around)) {
    return undefined;
  }
  for (const place of CAPTION_PLACES) {
    const box = captionBoxAt(shape, caption, place);
    if (isFree(box, around)) {
      return { place, dx: box.left - caption.left, dy: box.top - caption.top };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The rendered diagram
// ---------------------------------------------------------------------------

const CAPTIONED = ['bpmn-event', 'bpmn-gateway', 'bpmn-data-object', 'bpmn-data-store'];
const SAMPLE_STEP = 2;

const boxOf = (element: Element, origin: DOMRect): Box => {
  const rect = element.getBoundingClientRect();
  return {
    left: rect.left - origin.left,
    top: rect.top - origin.top,
    right: rect.right - origin.left,
    bottom: rect.bottom - origin.top,
  };
};

const isEmpty = (box: Box) => width(box) < 0.5 || height(box) < 0.5;

/** The visible text of a label: its HTML or SVG text, without the group's padding. */
const textOf = (label: Element) =>
  label.querySelector('foreignObject div, foreignObject span, text') ?? label;

const translateOf = (element: Element): [number, number] => {
  const match = /translate\(\s*([\d+.e-]+)[\s,]+([\d+.e-]+)\s*\)/.exec(
    element.getAttribute('transform') ?? ''
  );
  return match ? [Number(match[1]), Number(match[2])] : [0, 0];
};

/**
 * Moves every caption in a rendered BPMN diagram that a line crosses. It measures the
 * drawing, so it is a no-op where nothing is laid out (a DOM without geometry).
 */
export function avoidCaptionCrossings(svg: SVGSVGElement | null): void {
  if (!svg || typeof svg.getBoundingClientRect !== 'function') {
    return;
  }
  const origin = svg.getBoundingClientRect();
  const scale = svg.getScreenCTM?.()?.a || 1;

  const linePoints: Point[] = [];
  for (const path of svg.querySelectorAll<SVGPathElement>('g.edgePaths path')) {
    if (typeof path.getTotalLength !== 'function' || typeof path.getScreenCTM !== 'function') {
      return;
    }
    const length = path.getTotalLength();
    const matrix = path.getScreenCTM();
    if (!matrix || !length) {
      continue;
    }
    for (let along = 0; along <= length; along += SAMPLE_STEP) {
      const point = path.getPointAtLength(along).matrixTransform(matrix);
      linePoints.push({ x: point.x - origin.left, y: point.y - origin.top });
    }
  }
  if (linePoints.length === 0) {
    return;
  }

  const shapes = new Map<Element, Box>();
  for (const body of svg.querySelectorAll('g.node > g[class$="-body"]')) {
    shapes.set(body.parentElement!, boxOf(body, origin));
  }
  const texts = new Map<Element, Box>();
  for (const label of svg.querySelectorAll('g.node > g.label, g.edgeLabel')) {
    const box = boxOf(textOf(label), origin);
    if (!isEmpty(box)) {
      texts.set(label, box);
    }
  }
  const lanes = [...svg.querySelectorAll('g.cluster rect.swimlane-body, g.cluster rect.pool-body')]
    .map((rect) => boxOf(rect, origin))
    .filter((box) => !isEmpty(box));

  for (const node of svg.querySelectorAll('g.node')) {
    if (!CAPTIONED.some((name) => node.classList.contains(name))) {
      continue;
    }
    const label = node.querySelector(':scope > g.label');
    const shape = shapes.get(node);
    const caption = label && texts.get(label);
    if (!label || !shape || !caption) {
      continue;
    }
    const centre = { x: (shape.left + shape.right) / 2, y: (shape.top + shape.bottom) / 2 };
    // The innermost lane holding the shape: the smallest box around its centre.
    const bounds = lanes
      .filter((lane) => contains(lane, centre, 0))
      .sort((a, b) => width(a) * height(a) - width(b) * height(b))[0];
    const occupied = [
      ...[...shapes].filter(([owner]) => owner !== node).map(([, box]) => box),
      ...[...texts].filter(([other]) => other !== label).map(([, box]) => box),
      shape,
    ];
    const move = placeCaption(shape, caption, { linePoints, occupied, bounds });
    if (!move) {
      continue;
    }
    const [x, y] = translateOf(label);
    label.setAttribute('transform', `translate(${x + move.dx / scale}, ${y + move.dy / scale})`);
    label.setAttribute('data-caption-place', move.place);
    texts.set(label, moved(caption, move.dx, move.dy));
  }
}
