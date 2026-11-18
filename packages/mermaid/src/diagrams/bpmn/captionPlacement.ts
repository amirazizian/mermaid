/**
 * Moves a caption off whatever it is drawn on.
 *
 * Events, gateways, data objects and data stores write their name under the shape. A flow
 * that leaves such a shape from its bottom side, or passes beside it, would run through the
 * name; a boundary event's name under it can land on its host; a name can reach over a lane
 * border, a sub-process frame or another text. So after layout each caption that is drawn on
 * any of these is tried in the other places the notation reads it - above, beside and at the
 * corners, and slid along each side - and the free place nearest the shape wins. A caption
 * that has nowhere free stays where it was. Every shape keeps the band above it that it
 * reserves below, so `above` is room the layout already holds.
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

/** How much less a reader expects each place, in px of distance it is worth. */
const PLACE_BIAS: Record<CaptionPlace, number> = {
  below: 0,
  above: 6,
  right: 10,
  left: 14,
  'below-right': 20,
  'below-left': 22,
  'above-right': 26,
  'above-left': 28,
};

const GAP = 6;
/** A line this close to a caption reads as touching it. */
const CLEARANCE = 2;
/** A caption that moves keeps this far from lines and other things. */
const ROOM = 3;
/** How far a slid caption moves per step. */
const SLIDE_STEP = 4;

const width = (box: Box) => box.right - box.left;
const height = (box: Box) => box.bottom - box.top;

const moved = (box: Box, dx: number, dy: number): Box => ({
  left: box.left + dx,
  right: box.right + dx,
  top: box.top + dy,
  bottom: box.bottom + dy,
});

const grown = (box: Box, by: number): Box => ({
  left: box.left - by,
  right: box.right + by,
  top: box.top - by,
  bottom: box.bottom + by,
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

const centreOf = (box: Box): Point => ({
  x: (box.left + box.right) / 2,
  y: (box.top + box.bottom) / 2,
});

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
  /** Everything else a caption may not cover: shapes, frames it is not in, and other text. */
  occupied: Box[];
  /** The caption has to stay inside this box: its lane, or the frame it is drawn in. */
  bounds?: Box;
}

const touchesLine = (box: Box, around: Surroundings, margin: number) =>
  around.linePoints.some((point) => contains(box, point, margin));

const isFree = (box: Box, around: Surroundings, margin: number) =>
  (!around.bounds || within(grown(box, margin > CLEARANCE ? 1 : 0), around.bounds)) &&
  !touchesLine(box, around, margin) &&
  !around.occupied.some((other) => overlaps(box, other, margin > CLEARANCE ? 1 : 0));

/** Whether a line runs through `caption` where it is now. */
export const isCrossed = (caption: Box, around: Surroundings) =>
  touchesLine(caption, around, CLEARANCE);

/** Whether `caption` is drawn on a line, a shape, another text or over its bounds. */
export const isBlocked = (caption: Box, around: Surroundings) =>
  !isFree(caption, around, CLEARANCE);

interface Candidate {
  place: CaptionPlace;
  box: Box;
  cost: number;
}

/**
 * Every place a caption may go around `shape`, cheapest first: each of the eight places, and
 * each side slid along the shape for as long as the caption still touches the shape's span.
 */
export function captionCandidates(shape: Box, caption: Box): Candidate[] {
  const w = width(caption);
  const h = height(caption);
  const centre = centreOf(shape);
  const candidates: Candidate[] = [];
  const add = (place: CaptionPlace, box: Box, slide: number) => {
    const at = centreOf(box);
    const distance = Math.hypot(at.x - centre.x, at.y - centre.y);
    candidates.push({ place, box, cost: distance + PLACE_BIAS[place] + slide * 0.5 });
  };
  for (const place of CAPTION_PLACES) {
    const box = captionBoxAt(shape, caption, place);
    add(place, box, 0);
    if (place === 'below' || place === 'above') {
      // Slid sideways until its near edge is past the shape's centre.
      const reach = w / 2 + width(shape) / 4;
      for (let dx = SLIDE_STEP; dx <= reach; dx += SLIDE_STEP) {
        add(place, moved(box, dx, 0), dx);
        add(place, moved(box, -dx, 0), dx);
      }
    } else if (place === 'right' || place === 'left') {
      const reach = h / 2 + height(shape) / 4;
      for (let dy = SLIDE_STEP; dy <= reach; dy += SLIDE_STEP) {
        add(place, moved(box, 0, dy), dy);
        add(place, moved(box, 0, -dy), dy);
      }
    }
  }
  return candidates.sort((a, b) => a.cost - b.cost);
}

/**
 * Where a caption drawn on something should move to, as the offset of its box, or `undefined`
 * when it is free where it is or no place around the shape is free.
 */
export function placeCaption(
  shape: Box,
  caption: Box,
  around: Surroundings
): { place: CaptionPlace; dx: number; dy: number } | undefined {
  if (!isBlocked(caption, around)) {
    return undefined;
  }
  const candidates = captionCandidates(shape, caption);
  // Roomy places first; a place that only just clears its neighbours is still better than one
  // that covers them.
  for (const margin of [ROOM, CLEARANCE]) {
    const found = candidates.find((candidate) => isFree(candidate.box, around, margin));
    if (found) {
      return {
        place: found.place,
        dx: found.box.left - caption.left,
        dy: found.box.top - caption.top,
      };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Room before layout
// ---------------------------------------------------------------------------

/** Shapes that write their name under them, which flows can pass through (a start or end event
 * with a message flow too). */
const PASSED_THROUGH = new Set(['bpmn-start', 'bpmn-intermediate', 'bpmn-end', 'bpmn-gateway']);

interface LayoutElements {
  nodes: { id: string; shape?: string; label?: string; metadata?: Record<string, unknown> }[];
  edges: { start?: string; end?: string }[];
}

/**
 * Top to bottom, a flow enters a shape from above and leaves it below, through the name written
 * under it. Each event or gateway that flows both enter and leave is asked to keep room for its
 * name beside it as well (`metadata.captionBeside`), so the name can move there.
 */
export function keepCaptionRoomBeside(data: LayoutElements): void {
  const entered = new Set(data.edges.map((edge) => edge.end));
  const left = new Set(data.edges.map((edge) => edge.start));
  for (const node of data.nodes) {
    if (
      PASSED_THROUGH.has(node.shape ?? '') &&
      node.label &&
      entered.has(node.id) &&
      left.has(node.id)
    ) {
      node.metadata = { ...(node.metadata ?? {}), captionBeside: true };
    }
  }
}

// ---------------------------------------------------------------------------
// The rendered diagram
// ---------------------------------------------------------------------------

const CAPTIONED = ['bpmn-event', 'bpmn-gateway', 'bpmn-data-object', 'bpmn-data-store'];
const SAMPLE_STEP = 2;
/** A frame's border band: text this far inside its outline is on the border. */
const FRAME_BORDER = 4;

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

const area = (box: Box) => width(box) * height(box);

/**
 * Moves every caption in a rendered BPMN diagram that is drawn on a line, a shape, a frame's
 * border, a lane border or another text. It measures the drawing, so it is a no-op where
 * nothing is laid out (a DOM without geometry).
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
  const frames = new Map<Element, Box>();
  for (const outline of svg.querySelectorAll('g.node > g.bpmn-frame > .bpmn-frame-outline')) {
    const box = boxOf(outline, origin);
    if (!isEmpty(box)) {
      frames.set(outline.parentElement!.parentElement!, box);
    }
  }
  const texts = new Map<Element, Box>();
  for (const label of svg.querySelectorAll(
    'g.node > g.label, g.node > g.bpmn-frame-title, g.edgeLabel, g.cluster g.cluster-label'
  )) {
    const box = label.textContent?.trim() ? boxOf(textOf(label), origin) : undefined;
    if (box && !isEmpty(box)) {
      texts.set(label, box);
    }
  }
  const lanes = [...svg.querySelectorAll('g.cluster rect.swimlane-body, g.cluster rect.pool-body')]
    .map((rect) => boxOf(rect, origin))
    .filter((box) => !isEmpty(box));
  const frameInsides = [...frames.values()].map((box) => grown(box, -FRAME_BORDER));

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
    const centre = centreOf(shape);
    // The innermost lane or frame holding the shape: the smallest box around its centre. A
    // boundary event sits on its host's outline, so its host does not hold it.
    const bounds = [...lanes, ...frameInsides]
      .filter((box) => contains(box, centre, 0))
      .sort((a, b) => area(a) - area(b))[0];
    const occupied = [
      ...[...shapes].filter(([owner]) => owner !== node).map(([, box]) => box),
      // Frames the shape is not drawn in: their border and their content.
      ...[...frames.values()].filter((box) => !contains(grown(box, -FRAME_BORDER), centre, 0)),
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
