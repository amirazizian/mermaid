/**
 * Decorations drawn on flows once the layout is done.
 *
 * - The envelope BPMN puts on a message flow that names its message: white for an initiating
 *   message, shaded for a non-initiating one. It stands upright on the line, at its middle or
 *   as near to the middle as it can be without covering a shape or the flow's label, and it is
 *   drawn above the shapes so a line that runs past one still shows it.
 * - The label of an association. An association to an artifact is re-routed after layout, when
 *   the artifact is pinned beside its host, so its label is moved onto the line it ended up on.
 */

const WIDTH = 20;
const HEIGHT = 14;
/** How far along the line the envelope may go, tried in this order. */
const PLACES = [0.5, 0.38, 0.62, 0.28, 0.72, 0.2, 0.8];
const SVG_NS = 'http://www.w3.org/2000/svg';

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const overlaps = (a: Rect, b: Rect) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

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

/** The envelope's box on the screen, centred at `x`, `y` of the line's own coordinates. */
const envelopeBoxOnScreen = (path: SVGPathElement, x: number, y: number): Rect | undefined => {
  const ctm = path.getScreenCTM();
  if (!ctm) {
    return undefined;
  }
  const corner = (dx: number, dy: number) => {
    const point = new DOMPoint(x + dx, y + dy).matrixTransform(ctm);
    return [point.x, point.y];
  };
  const [x1, y1] = corner(-WIDTH / 2, -HEIGHT / 2);
  const [x2, y2] = corner(WIDTH / 2, HEIGHT / 2);
  return {
    left: Math.min(x1, x2),
    top: Math.min(y1, y2),
    right: Math.max(x1, x2),
    bottom: Math.max(y1, y2),
  };
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

/**
 * The shapes a decoration should not cover: every node that is not a container. A node's box
 * holds its caption as well as its shape.
 */
const shapeBoxes = (svg: SVGSVGElement): Rect[] =>
  [...svg.querySelectorAll('g.node')]
    .filter((node) => !node.closest('.clusters'))
    .map((node) => node.querySelector('.bpmn-bounds') ?? node)
    .map(screenBox)
    .filter((box): box is Rect => box !== undefined);

function drawMessageEnvelopes(svg: SVGSVGElement): void {
  const paths = svg.querySelectorAll<SVGPathElement>(
    'path.bpmn-flow-message-initiating, path.bpmn-flow-message-non-initiating'
  );
  if (!paths.length) {
    return;
  }
  const labels = [...svg.querySelectorAll('g.edgeLabel')]
    .filter((label) => label.textContent?.trim())
    .map(screenBox)
    .filter((box): box is Rect => box !== undefined);
  const shapes = shapeBoxes(svg);
  // Drawn last in the diagram's own group, so above the shapes.
  const layer: SVGGraphicsElement = svg.querySelector<SVGGElement>('g.root') ?? svg;
  const envelopes: SVGGElement[] = [];
  for (const path of paths) {
    const length = lengthOf(path);
    if (length === undefined) {
      continue;
    }
    const initiating = path.classList.contains('bpmn-flow-message-initiating');
    const candidates = PLACES.map((fraction) => {
      const point = path.getPointAtLength(length * fraction);
      const box = envelopeBoxOnScreen(path, point.x, point.y);
      return {
        point,
        onShape: box ? shapes.some((shape) => overlaps(shape, box)) : false,
        onLabel: box ? labels.some((label) => overlaps(label, box)) : false,
      };
    });
    const chosen =
      candidates.find((c) => !c.onShape && !c.onLabel) ??
      candidates.find((c) => !c.onShape) ??
      candidates[0];
    const place = moveBetween(chosen.point, path, layer) ?? chosen.point;
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
