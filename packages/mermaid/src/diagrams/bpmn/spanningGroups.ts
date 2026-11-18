/**
 * Draws a group written with `members` around those members, once the diagram is laid out: a
 * dash-dot rounded box around every member's drawn shape, with the group's name at its top.
 * Such a group can span lanes and pools, which a group held by one lane cannot.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const PADDING = 12;
const TITLE_HEIGHT = 18;

export interface SpanningGroup {
  id: string;
  label: string;
  /** The DOM id each member is drawn with. */
  memberDomIds: string[];
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** A member's box in the coordinates of `layer`: its drawn shape, or the whole of a container. */
function boxIn(layer: SVGGraphicsElement, element: SVGGraphicsElement): Box | undefined {
  const shape =
    element.querySelector<SVGGraphicsElement>(
      ':scope > g[class$="-body"], :scope > g.bpmn-frame, :scope > rect.swimlane-body, :scope > rect.pool-body'
    ) ?? element;
  const own = shape.getBBox();
  const from = shape.getScreenCTM();
  const to = layer.getScreenCTM();
  if (!from || !to || (own.width === 0 && own.height === 0)) {
    return undefined;
  }
  const matrix = to.inverse().multiply(from);
  const corners = [
    [own.x, own.y],
    [own.x + own.width, own.y + own.height],
    [own.x, own.y + own.height],
    [own.x + own.width, own.y],
  ].map(([x, y]) => new DOMPoint(x, y).matrixTransform(matrix));
  return {
    left: Math.min(...corners.map((p) => p.x)),
    right: Math.max(...corners.map((p) => p.x)),
    top: Math.min(...corners.map((p) => p.y)),
    bottom: Math.max(...corners.map((p) => p.y)),
  };
}

export function drawSpanningGroups(svg: SVGSVGElement | null, groups: SpanningGroup[]): void {
  if (!svg || groups.length === 0 || typeof svg.getScreenCTM !== 'function') {
    return;
  }
  const layer = (svg.querySelector<SVGGElement>(':scope > g') ?? svg) as SVGGraphicsElement;
  for (const group of groups) {
    const boxes = group.memberDomIds
      .map((id) => svg.querySelector<SVGGraphicsElement>(`[id="${CSS.escape(id)}"]`))
      .filter((element): element is SVGGraphicsElement => element !== null)
      .map((element) => boxIn(layer, element))
      .filter((box): box is Box => box !== undefined);
    if (boxes.length === 0) {
      continue;
    }
    const left = Math.min(...boxes.map((b) => b.left)) - PADDING;
    const right = Math.max(...boxes.map((b) => b.right)) + PADDING;
    const top = Math.min(...boxes.map((b) => b.top)) - PADDING - (group.label ? TITLE_HEIGHT : 0);
    const bottom = Math.max(...boxes.map((b) => b.bottom)) + PADDING;
    const element = document.createElementNS(SVG_NS, 'g');
    element.setAttribute('class', 'bpmn-spanning-group');
    element.setAttribute('data-id', group.id);
    const rect = document.createElementNS(SVG_NS, 'rect');
    for (const [key, value] of Object.entries({
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
      rx: 10,
      ry: 10,
    })) {
      rect.setAttribute(key, String(value));
    }
    element.append(rect);
    if (group.label) {
      const text = document.createElementNS(SVG_NS, 'text');
      text.setAttribute('x', String(left + 10));
      text.setAttribute('y', String(top + 14));
      text.textContent = group.label;
      element.append(text);
    }
    layer.append(element);
  }
}
