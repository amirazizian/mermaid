/**
 * Decorations drawn on flows once the layout is done.
 *
 * - The envelope BPMN puts on a message flow that names its message: white for an initiating
 *   message, shaded for a non-initiating one. It stands upright on a straight stretch of its
 *   line, as near the middle as it can be without covering another flow, a crossing, a shape or
 *   a text, and the flow's label is moved onto the line right beside it, so the name reads with
 *   the envelope. It is drawn above the shapes so a line that runs past one still shows it.
 * - The label of an association. An association to an artifact is re-routed after layout, when
 *   the artifact is pinned beside its host, so its label is moved onto the line it ended up on.
 */

const WIDTH = 20;
const HEIGHT = 14;
const SVG_NS = 'http://www.w3.org/2000/svg';
/** How finely a line is sampled, in screen px. */
const STEP = 2;
/** The gap between an envelope and its label, and the room kept to other things. */
const GAP = 4;
const ROOM = 3;
/** How far an envelope or its label keeps from other lines, and its own line keeps straight. */
const LINE_ROOM = 6;
/** How far from either end of its line an envelope keeps, past the arrowhead and the circle. */
const END_CLEARANCE = 14;

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Point {
  x: number;
  y: number;
}

const overlaps = (a: Rect, b: Rect, margin = 0) =>
  a.left < b.right + margin &&
  b.left < a.right + margin &&
  a.top < b.bottom + margin &&
  b.top < a.bottom + margin;

/** Whether `box` reaches over a border of `band`, with `ROOM` to spare. */
export const crossesBorderOf = (band: Rect, box: Rect) =>
  overlaps(band, box, ROOM) &&
  !(
    box.left >= band.left + ROOM &&
    box.right <= band.right - ROOM &&
    box.top >= band.top + ROOM &&
    box.bottom <= band.bottom - ROOM
  );

const boxAround = (centre: Point, width: number, height: number): Rect => ({
  left: centre.x - width / 2,
  right: centre.x + width / 2,
  top: centre.y - height / 2,
  bottom: centre.y + height / 2,
});

// ---------------------------------------------------------------------------
// Where the envelope goes
// ---------------------------------------------------------------------------

export interface EnvelopePlace {
  envelope: Point;
  /** Where the label's centre goes, when it fits beside the envelope. */
  label?: Point;
}

interface Size {
  width: number;
  height: number;
}

/**
 * Where an envelope, and the label beside it, go on a line sampled every `step` px from start
 * to end. Both have to sit on one straight stretch: the envelope with room either side of it
 * along the line, the label after or before it. `isFree` says whether a box covers nothing it
 * should not. The place nearest the middle of the line wins; one with the label beside it beats
 * any without. An envelope without its label beside it keeps off `labelAt`, where the label is.
 */
export function placeEnvelope(
  samples: Point[],
  step: number,
  envelope: Size,
  label: Size | undefined,
  isFree: (box: Rect) => boolean,
  labelAt?: Rect
): EnvelopePlace | undefined {
  const count = samples.length;
  if (count < 2) {
    return undefined;
  }
  const middle = (count - 1) / 2;
  const straight = (from: number, to: number, horizontal: boolean) => {
    if (from < 0 || to >= count) {
      return false;
    }
    const base = samples[from];
    for (let i = from + 1; i <= to; i++) {
      const offAxis = horizontal ? samples[i].y - base.y : samples[i].x - base.x;
      if (Math.abs(offAxis) > 0.5) {
        return false;
      }
    }
    return true;
  };
  const endSteps = Math.ceil(END_CLEARANCE / step);
  let alone: { place: EnvelopePlace; cost: number } | undefined;
  let together: { place: EnvelopePlace; cost: number } | undefined;
  for (let i = endSteps; i < count - endSteps; i++) {
    const cost = Math.abs(i - middle) * step;
    if (together && cost >= together.cost) {
      continue;
    }
    const centre = samples[i];
    const next = samples[Math.min(i + 1, count - 1)];
    const before = samples[Math.max(i - 1, 0)];
    const horizontal = Math.abs(next.x - before.x) > Math.abs(next.y - before.y);
    const half = (horizontal ? envelope.width : envelope.height) / 2;
    const reach = Math.ceil((half + LINE_ROOM) / step);
    if (!straight(i - reach, i + reach, horizontal)) {
      continue;
    }
    const box = boxAround(centre, envelope.width, envelope.height);
    if (!isFree(box)) {
      continue;
    }
    if ((!alone || cost < alone.cost) && !(labelAt && overlaps(box, labelAt, GAP - 1))) {
      alone = { place: { envelope: centre }, cost };
    }
    if (!label) {
      continue;
    }
    const labelHalf = (horizontal ? label.width : label.height) / 2;
    const offset = Math.round((half + GAP + labelHalf) / step);
    const labelReach = Math.ceil(labelHalf / step);
    for (const side of [1, -1]) {
      const j = i + side * offset;
      const far = j + side * labelReach;
      if (far < endSteps || far > count - 1 - endSteps) {
        continue;
      }
      if (!straight(Math.min(i, far), Math.max(i, far), horizontal)) {
        continue;
      }
      const labelBox = boxAround(samples[j], label.width, label.height);
      if (!isFree(labelBox) || overlaps(labelBox, box, GAP - 1)) {
        continue;
      }
      together = { place: { envelope: centre, label: samples[j] }, cost };
      break;
    }
  }
  return (together ?? alone)?.place;
}

// ---------------------------------------------------------------------------
// The rendered diagram
// ---------------------------------------------------------------------------

/** The box of `element` on the screen, or none when nothing is drawn. */
const screenBox = (element: Element): Rect | undefined => {
  const box = element.getBoundingClientRect();
  return box.width > 0 && box.height > 0
    ? { left: box.left, top: box.top, right: box.right, bottom: box.bottom }
    : undefined;
};

/** A point of `from`'s own coordinates, in `to`'s. */
const moveBetween = (
  point: { x: number; y: number },
  from: SVGGraphicsElement,
  to: SVGGraphicsElement
): { x: number; y: number } | undefined => {
  const fromCtm = from.getScreenCTM();
  const toCtm = to.getScreenCTM();
  if (!fromCtm || !toCtm) {
    return undefined;
  }
  const moved = new DOMPoint(point.x, point.y)
    .matrixTransform(fromCtm)
    .matrixTransform(toCtm.inverse());
  return { x: moved.x, y: moved.y };
};

/** A point on the screen, in `to`'s own coordinates. */
const fromScreen = (point: Point, to: SVGGraphicsElement): Point | undefined => {
  const ctm = to.getScreenCTM();
  if (!ctm) {
    return undefined;
  }
  const moved = new DOMPoint(point.x, point.y).matrixTransform(ctm.inverse());
  return { x: moved.x, y: moved.y };
};

const element = (name: string, attributes: Record<string, string | number>) => {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) {
    node.setAttribute(key, String(value));
  }
  return node;
};

/** The length of a drawn line, or none where it cannot be measured (as in a test DOM). */
const lengthOf = (path: SVGPathElement): number | undefined => {
  if (typeof path.getTotalLength !== 'function') {
    return undefined;
  }
  try {
    const length = path.getTotalLength();
    return length > 0 ? length : undefined;
  } catch {
    return undefined;
  }
};

/** Points along a drawn line on the screen, `STEP` px apart. */
const sampleOnScreen = (path: SVGPathElement, length: number): Point[] => {
  const ctm = path.getScreenCTM();
  if (!ctm) {
    return [];
  }
  const scale = Math.hypot(ctm.a, ctm.b) || 1;
  const step = STEP / scale;
  const points: Point[] = [];
  for (let along = 0; along <= length; along += step) {
    const point = path.getPointAtLength(along).matrixTransform(ctm);
    points.push({ x: point.x, y: point.y });
  }
  return points;
};

/** The label drawn for the flow `path` draws, if it has one. */
const labelOf = (svg: SVGSVGElement, path: SVGPathElement): SVGGElement | undefined => {
  const id = path.getAttribute('data-id');
  if (!id) {
    return undefined;
  }
  const label = [...svg.querySelectorAll<SVGGElement>('g.edgeLabel')].find((candidate) =>
    candidate.id.endsWith(`-${id}`)
  );
  return label?.textContent?.trim() ? label : undefined;
};

/** The visible text of a label: its HTML or SVG text, without the group's padding. */
const textOf = (label: Element) =>
  label.querySelector('foreignObject div, foreignObject span, text') ?? label;

const TEXTS =
  'g.edgeLabel, g.node > g.label, g.node > g.bpmn-frame-title, g.cluster g.cluster-label, .bpmn-spanning-group text';

function drawMessageEnvelopes(svg: SVGSVGElement): void {
  const paths = [
    ...svg.querySelectorAll<SVGPathElement>(
      'path.bpmn-flow-message-initiating, path.bpmn-flow-message-non-initiating'
    ),
  ];
  if (!paths.length) {
    return;
  }
  // Drawn last in the diagram's own group, so above the shapes.
  const layer: SVGGraphicsElement = svg.querySelector<SVGGElement>('g.root') ?? svg;
  const scale = Math.hypot(layer.getScreenCTM?.()?.a ?? 1, layer.getScreenCTM?.()?.b ?? 0) || 1;

  const lines = new Map<SVGPathElement, Point[]>();
  for (const path of svg.querySelectorAll<SVGPathElement>('g.edgePaths path')) {
    const length = lengthOf(path);
    if (length !== undefined) {
      lines.set(path, sampleOnScreen(path, length));
    }
  }
  const texts = new Map<Element, Rect>();
  for (const text of svg.querySelectorAll(TEXTS)) {
    const box = text.textContent?.trim() ? screenBox(textOf(text)) : undefined;
    if (box) {
      texts.set(text, box);
    }
  }
  const shapes = [...svg.querySelectorAll('g.node > g[class$="-body"]')]
    .map(screenBox)
    .filter((box): box is Rect => box !== undefined);
  const bands = [...svg.querySelectorAll('g.cluster rect.swimlane-body, g.cluster rect.pool-body')]
    .map(screenBox)
    .filter((box): box is Rect => box !== undefined);
  const placed: Rect[] = [];

  const envelopes: SVGGElement[] = [];
  for (const path of paths) {
    const samples = lines.get(path);
    if (!samples?.length) {
      continue;
    }
    const label = labelOf(svg, path);
    const labelBox = label && texts.get(label);
    const others = [...lines].filter(([other]) => other !== path).flatMap(([, points]) => points);
    const isFree = (box: Rect) =>
      !others.some(
        (point) =>
          point.x > box.left - LINE_ROOM &&
          point.x < box.right + LINE_ROOM &&
          point.y > box.top - LINE_ROOM &&
          point.y < box.bottom + LINE_ROOM
      ) &&
      ![...texts].some(([text, other]) => text !== label && overlaps(box, other, 1)) &&
      !shapes.some((shape) => overlaps(box, shape, 1)) &&
      !bands.some((band) => crossesBorderOf(band, box)) &&
      !placed.some((other) => overlaps(box, other, 1));
    const size = { width: WIDTH * scale, height: HEIGHT * scale };
    const labelSize = labelBox && {
      width: labelBox.right - labelBox.left,
      height: labelBox.bottom - labelBox.top,
    };
    const choice = placeEnvelope(samples, STEP, size, labelSize, isFree, labelBox) ?? {
      envelope: samples[Math.floor(samples.length / 2)],
    };
    placed.push(boxAround(choice.envelope, size.width, size.height));
    if (label && labelSize && choice.label) {
      const parent = label.parentNode as SVGGraphicsElement | null;
      const at = parent && fromScreen(choice.label, parent);
      if (at) {
        label.setAttribute('transform', `translate(${at.x}, ${at.y})`);
        const box = boxAround(choice.label, labelSize.width, labelSize.height);
        texts.set(label, box);
        placed.push(box);
      }
    }

    const place = fromScreen(choice.envelope, layer);
    if (!place) {
      continue;
    }
    const initiating = path.classList.contains('bpmn-flow-message-initiating');
    const left = place.x - WIDTH / 2;
    const top = place.y - HEIGHT / 2;
    const box = { x: left, y: top, width: WIDTH, height: HEIGHT };
    const group = element('g', {
      class: `bpmn-envelope ${initiating ? 'initiating' : 'non-initiating'}`,
      'data-flow': path.getAttribute('data-id') ?? '',
    }) as SVGGElement;
    group.append(
      element('rect', { class: 'bpmn-envelope-body', ...box }),
      ...(initiating ? [] : [element('rect', { class: 'bpmn-envelope-shade', ...box })]),
      element('rect', { class: 'bpmn-envelope-flap', ...box }),
      element('path', {
        class: 'bpmn-envelope-flap',
        d: `M ${left} ${top} L ${place.x} ${top + HEIGHT * 0.55} L ${left + WIDTH} ${top}`,
      })
    );
    envelopes.push(group);
  }
  layer.append(...envelopes);
}

/** Moves the label of each association onto the middle of the line it was drawn with. */
function centreAssociationLabels(svg: SVGSVGElement): void {
  for (const path of svg.querySelectorAll<SVGPathElement>('path.bpmn-flow-association')) {
    const label = labelOf(svg, path);
    const length = lengthOf(path);
    const parent = label?.parentNode as SVGGraphicsElement | null | undefined;
    if (!label || length === undefined || !parent) {
      continue;
    }
    const middle = path.getPointAtLength(length / 2);
    const place = moveBetween(middle, path, parent);
    if (place) {
      label.setAttribute('transform', `translate(${place.x}, ${place.y})`);
    }
  }
}

export function decorateFlows(svg: SVGSVGElement | null): void {
  if (!svg) {
    return;
  }
  centreAssociationLabels(svg);
  drawMessageEnvelopes(svg);
}
