import {
  dedupeConsecutivePoints,
  orthogonalizePolyline,
  pointInsideRect,
  rectFromCenterSize,
  rectOfNodeBounds,
  samePoint,
  sameX,
  sameY,
  simplifyPolyline,
} from './geometry.js';
import type { Point, RectBounds } from './geometry.js';
import type { Node } from '../../../types.js';
import {
  assignSides,
  CAPTION_VERTEX_COST,
  costOfWay,
  VERTEX_SIDES,
  VERTEX_STUB,
  waysFromVertex,
} from './vertexPorts.js';
import type { Obstacle, VertexContext, VertexSide, VertexWay } from './vertexPorts.js';

const EPS = 1e-3;
const INSIDE_EPS = 0.5;
/** How far endpoint clipping keeps a terminal leg from a node's corner. */
export const CORNER_CLEARANCE = 4;

type NodeRect = RectBounds;

type BorderSide = 'top' | 'bottom' | 'left' | 'right';

interface EndpointEdge {
  isLayoutOnly?: boolean;
  points?: Point[];
  start?: string;
  end?: string;
}

function endpointRectOf(node: any): RectBounds | undefined {
  const drawn = node?.metadata?.drawnExtent;
  if (
    drawn &&
    typeof drawn.width === 'number' &&
    typeof drawn.height === 'number' &&
    Number.isFinite(drawn.width) &&
    Number.isFinite(drawn.height) &&
    typeof node.x === 'number' &&
    typeof node.y === 'number'
  ) {
    return rectFromCenterSize(node.x, node.y, drawn.width, drawn.height);
  }
  return rectOfNodeBounds(node);
}

function endpointContextFor(edge: unknown, nodeByIdMap: Map<string, any>, minPoints: number) {
  const candidate = edge as EndpointEdge;
  if (candidate.isLayoutOnly || !candidate.points || candidate.points.length < minPoints) {
    return undefined;
  }
  const src = candidate.start ? nodeByIdMap.get(candidate.start) : undefined;
  const dst = candidate.end ? nodeByIdMap.get(candidate.end) : undefined;
  return {
    edge: candidate,
    points: candidate.points,
    srcRect: src ? endpointRectOf(src) : undefined,
    dstRect: dst ? endpointRectOf(dst) : undefined,
  };
}

// Given an axis-aligned segment from outside a rect to inside it, return the
// point where the segment enters the rect boundary.
function segmentEnterPoint(outside: Point, inside: Point, r: NodeRect): Point {
  if (sameY(outside, inside, EPS)) {
    const x = outside.x < r.left ? r.left : r.right;
    return { x, y: outside.y };
  }
  if (sameX(outside, inside, EPS)) {
    const y = outside.y < r.top ? r.top : r.bottom;
    return { x: outside.x, y };
  }
  return {
    x: Math.min(r.right, Math.max(r.left, outside.x)),
    y: Math.min(r.bottom, Math.max(r.top, outside.y)),
  };
}

function clipEndpoint(points: Point[], rect: NodeRect, atStart: boolean): Point[] {
  const step = atStart ? 1 : -1;
  let outsideIndex = atStart ? 0 : points.length - 1;
  while (
    outsideIndex >= 0 &&
    outsideIndex < points.length &&
    pointInsideRect(points[outsideIndex], rect, INSIDE_EPS)
  ) {
    outsideIndex += step;
  }
  if (outsideIndex < 0 || outsideIndex >= points.length) {
    return points;
  }

  const insideIndex = outsideIndex - step;
  if (insideIndex < 0 || insideIndex >= points.length) {
    return points;
  }

  const entry = segmentEnterPoint(points[outsideIndex], points[insideIndex], rect);
  return atStart
    ? [entry, ...points.slice(outsideIndex)]
    : [...points.slice(0, outsideIndex + 1), entry];
}

export function clipEdgeEndpointsToNodeBoundaries(edges: unknown[], nodeByIdMap: Map<string, any>) {
  for (const edge of edges) {
    const context = endpointContextFor(edge, nodeByIdMap, 2);
    if (!context) {
      continue;
    }

    let next = [...context.points];
    if (context.srcRect) {
      next = clipEndpoint(next, context.srcRect, true);
    }
    if (context.dstRect) {
      next = clipEndpoint(next, context.dstRect, false);
    }
    next = simplifyPolyline(orthogonalizePolyline(next));
    next = clearStraightEndpointCornerConnections(next, context.srcRect, context.dstRect);
    context.edge.points = simplifyPolyline(orthogonalizePolyline(next));
  }
}

function snapEndpointToBoundary(
  inner: Point,
  endpoint: Point,
  r: NodeRect,
  useApproachSide = false
): Point {
  if (sameY(inner, endpoint, EPS)) {
    if (endpoint.y < r.top - EPS || endpoint.y > r.bottom + EPS) {
      return endpoint;
    }
    if (useApproachSide) {
      if (inner.x < r.left - EPS) {
        return { x: r.left, y: inner.y };
      }
      if (inner.x > r.right + EPS) {
        return { x: r.right, y: inner.y };
      }
    }
    const toLeft = Math.abs(endpoint.x - r.left) <= Math.abs(endpoint.x - r.right);
    return { x: toLeft ? r.left : r.right, y: inner.y };
  }
  if (sameX(inner, endpoint, EPS)) {
    if (endpoint.x < r.left - EPS || endpoint.x > r.right + EPS) {
      return endpoint;
    }
    if (useApproachSide) {
      if (inner.y < r.top - EPS) {
        return { x: inner.x, y: r.top };
      }
      if (inner.y > r.bottom + EPS) {
        return { x: inner.x, y: r.bottom };
      }
    }
    const toTop = Math.abs(endpoint.y - r.top) <= Math.abs(endpoint.y - r.bottom);
    return { x: inner.x, y: toTop ? r.top : r.bottom };
  }
  return endpoint;
}

function firstDistinctAdjacent(
  points: Point[],
  endpointIndex: number,
  step: 1 | -1
): Point | undefined {
  const endpoint = points[endpointIndex];
  for (let index = endpointIndex + step; index >= 0 && index < points.length; index += step) {
    const candidate = points[index];
    if (!samePoint(candidate, endpoint, EPS)) {
      return candidate;
    }
  }
  return points[endpointIndex + step];
}

function cornerClearanceRange(min: number, max: number): { lo: number; hi: number } {
  const lo = min + CORNER_CLEARANCE;
  const hi = max - CORNER_CLEARANCE;
  return lo <= hi ? { lo, hi } : { lo: (min + max) / 2, hi: (min + max) / 2 };
}

function clampToCornerClearance(value: number, min: number, max: number): number {
  const { lo, hi } = cornerClearanceRange(min, max);
  return Math.min(hi, Math.max(lo, value));
}

function intersectRanges(
  ranges: { lo: number; hi: number }[]
): { lo: number; hi: number } | undefined {
  const lo = Math.max(...ranges.map((range) => range.lo));
  const hi = Math.min(...ranges.map((range) => range.hi));
  if (lo > hi) {
    return undefined;
  }
  return { lo, hi };
}

function clearanceRangeForSide(r: NodeRect, side: BorderSide): { lo: number; hi: number } {
  return side === 'left' || side === 'right'
    ? cornerClearanceRange(r.top, r.bottom)
    : cornerClearanceRange(r.left, r.right);
}

function terminalSideForSegment(
  endpoint: Point,
  adjacent: Point,
  r: NodeRect
): BorderSide | undefined {
  const yWithin = endpoint.y >= r.top - EPS && endpoint.y <= r.bottom + EPS;
  const xWithin = endpoint.x >= r.left - EPS && endpoint.x <= r.right + EPS;
  if (sameY(endpoint, adjacent, EPS) && yWithin) {
    if (Math.abs(endpoint.x - r.left) < EPS) {
      return 'left';
    }
    if (Math.abs(endpoint.x - r.right) < EPS) {
      return 'right';
    }
  }
  if (sameX(endpoint, adjacent, EPS) && xWithin) {
    if (Math.abs(endpoint.y - r.top) < EPS) {
      return 'top';
    }
    if (Math.abs(endpoint.y - r.bottom) < EPS) {
      return 'bottom';
    }
  }
  return undefined;
}

function isHorizontalSide(side: BorderSide): boolean {
  return side === 'left' || side === 'right';
}

function straightClearanceRange(
  start: Point,
  end: Point,
  srcRect: NodeRect | undefined,
  dstRect: NodeRect | undefined,
  horizontal: boolean
): { lo: number; hi: number } | undefined {
  const ranges: { lo: number; hi: number }[] = [];
  const srcSide = srcRect ? terminalSideForSegment(start, end, srcRect) : undefined;
  const dstSide = dstRect ? terminalSideForSegment(end, start, dstRect) : undefined;

  if (srcRect && srcSide && isHorizontalSide(srcSide) === horizontal) {
    ranges.push(clearanceRangeForSide(srcRect, srcSide));
  }
  if (dstRect && dstSide && isHorizontalSide(dstSide) === horizontal) {
    ranges.push(clearanceRangeForSide(dstRect, dstSide));
  }

  return ranges.length > 0 ? intersectRanges(ranges) : undefined;
}

function clearStraightEndpointCornerAxis(
  start: Point,
  end: Point,
  srcRect: NodeRect | undefined,
  dstRect: NodeRect | undefined,
  horizontal: boolean
): Point[] | undefined {
  const range = straightClearanceRange(start, end, srcRect, dstRect, horizontal);
  if (!range) {
    return undefined;
  }

  const current = horizontal ? start.y : start.x;
  const next = Math.min(range.hi, Math.max(range.lo, current));
  if (Math.abs(next - current) < EPS) {
    return undefined;
  }

  return horizontal
    ? [
        { x: start.x, y: next },
        { x: end.x, y: next },
      ]
    : [
        { x: next, y: start.y },
        { x: next, y: end.y },
      ];
}

function clearStraightEndpointCornerConnections(
  points: Point[],
  srcRect?: NodeRect,
  dstRect?: NodeRect
): Point[] {
  if (points.length !== 2) {
    return points;
  }

  const [start, end] = points;
  if (sameY(start, end, EPS)) {
    return clearStraightEndpointCornerAxis(start, end, srcRect, dstRect, true) ?? points;
  }

  if (sameX(start, end, EPS)) {
    return clearStraightEndpointCornerAxis(start, end, srcRect, dstRect, false) ?? points;
  }

  return points;
}

function cornerClearedEndpoint(endpoint: Point, r: NodeRect, side: BorderSide): Point {
  return isHorizontalSide(side)
    ? { x: endpoint.x, y: clampToCornerClearance(endpoint.y, r.top, r.bottom) }
    : { x: clampToCornerClearance(endpoint.x, r.left, r.right), y: endpoint.y };
}

function moveCollinearEndpointRun(
  points: Point[],
  endpointIndex: number,
  step: 1 | -1,
  endpoint: Point,
  adjusted: Point,
  horizontalTerminal: boolean
): Point[] {
  const next = points.map((point) => ({ ...point }));
  for (let index = endpointIndex; index >= 0 && index < points.length; index += step) {
    const point = points[index];
    if (horizontalTerminal && !sameY(point, endpoint, EPS)) {
      break;
    }
    if (!horizontalTerminal && !sameX(point, endpoint, EPS)) {
      break;
    }
    if (horizontalTerminal) {
      next[index].y = adjusted.y;
    } else {
      next[index].x = adjusted.x;
    }
  }
  return next;
}

function clearEndpointCornerConnection(points: Point[], r: NodeRect, atStart: boolean): Point[] {
  if (points.length < 2) {
    return points;
  }

  const endpointIndex = atStart ? 0 : points.length - 1;
  const step = atStart ? 1 : -1;
  const endpoint = points[endpointIndex];
  const adjacent = firstDistinctAdjacent(points, endpointIndex, step);
  if (!adjacent) {
    return points;
  }

  const side = terminalSideForSegment(endpoint, adjacent, r);
  if (!side) {
    return points;
  }

  const horizontalTerminal = isHorizontalSide(side);
  const adjusted = cornerClearedEndpoint(endpoint, r, side);
  if (samePoint(endpoint, adjusted, EPS)) {
    return points;
  }

  return moveCollinearEndpointRun(
    points,
    endpointIndex,
    step,
    endpoint,
    adjusted,
    horizontalTerminal
  );
}

function borderSideForSegment(a: Point, b: Point, r: NodeRect): BorderSide | undefined {
  const xWithin = Math.min(a.x, b.x) >= r.left - EPS && Math.max(a.x, b.x) <= r.right + EPS;
  const yWithin = Math.min(a.y, b.y) >= r.top - EPS && Math.max(a.y, b.y) <= r.bottom + EPS;
  if (Math.abs(a.y - r.top) < EPS && Math.abs(b.y - r.top) < EPS && xWithin) {
    return 'top';
  }
  if (Math.abs(a.y - r.bottom) < EPS && Math.abs(b.y - r.bottom) < EPS && xWithin) {
    return 'bottom';
  }
  if (Math.abs(a.x - r.left) < EPS && Math.abs(b.x - r.left) < EPS && yWithin) {
    return 'left';
  }
  if (Math.abs(a.x - r.right) < EPS && Math.abs(b.x - r.right) < EPS && yWithin) {
    return 'right';
  }
  return undefined;
}

function leavesOutward(side: BorderSide, from: Point, to: Point, r: NodeRect): boolean {
  switch (side) {
    case 'top':
      return sameX(from, to, EPS) && to.y < r.top - EPS;
    case 'bottom':
      return sameX(from, to, EPS) && to.y > r.bottom + EPS;
    case 'left':
      return sameY(from, to, EPS) && to.x < r.left - EPS;
    case 'right':
      return sameY(from, to, EPS) && to.x > r.right + EPS;
  }
}

function collapseOwnBorderStub(points: Point[], r: NodeRect, atStart: boolean): Point[] {
  if (points.length < 3) {
    return points;
  }
  if (atStart) {
    const side = borderSideForSegment(points[0], points[1], r);
    if (side && leavesOutward(side, points[1], points[2], r)) {
      return points.slice(1);
    }
    return points;
  }

  const last = points.length - 1;
  const side = borderSideForSegment(points[last - 1], points[last], r);
  if (side && leavesOutward(side, points[last - 1], points[last - 2], r)) {
    return points.slice(0, last);
  }
  return points;
}

function snapAndCollapseEndpoints(
  points: Point[],
  srcRect?: NodeRect,
  dstRect?: NodeRect
): Point[] {
  let next = points;
  if (srcRect) {
    const adjacent = firstDistinctAdjacent(next, 0, 1);
    if (adjacent) {
      const snapped = snapEndpointToBoundary(adjacent, next[0], srcRect);
      if (snapped !== next[0]) {
        next = [snapped, ...next.slice(1)];
      }
    }
    next = collapseOwnBorderStub(next, srcRect, true);
  }
  if (dstRect) {
    const last = next.length - 1;
    const adjacent = firstDistinctAdjacent(next, last, -1);
    if (adjacent) {
      const snapped = snapEndpointToBoundary(adjacent, next[last], dstRect, true);
      if (snapped !== next[last]) {
        next = [...next.slice(0, last), snapped];
      }
    }
    next = collapseOwnBorderStub(next, dstRect, false);
  }

  const straightCleared = clearStraightEndpointCornerConnections(next, srcRect, dstRect);
  if (straightCleared !== next || next.length === 2) {
    return straightCleared;
  }

  if (srcRect) {
    next = clearEndpointCornerConnection(next, srcRect, true);
  }
  if (dstRect) {
    next = clearEndpointCornerConnection(next, dstRect, false);
  }
  return next;
}

export function prepareEdgeEndpointsForRenderer(edges: unknown[], nodeByIdMap: Map<string, any>) {
  for (const edge of edges) {
    const context = endpointContextFor(edge, nodeByIdMap, 2);
    if (!context) {
      continue;
    }

    const input = dedupeConsecutivePoints(context.points, EPS);
    const newPts = snapAndCollapseEndpoints(input, context.srcRect, context.dstRect);
    if (newPts.length < 3) {
      context.edge.points = newPts;
      continue;
    }
    const duplicated = [
      newPts[0],
      { ...newPts[0] },
      ...newPts.slice(1, -1),
      newPts[newPts.length - 1],
      { ...newPts[newPts.length - 1] },
    ];
    context.edge.points = duplicated;
  }
}

function dropAxisBacktracks(points: Point[]): Point[] {
  const out = [...points];
  let i = 1;
  while (i < out.length - 1) {
    const [a, b, c] = [out[i - 1], out[i], out[i + 1]];
    const flat = Math.abs(a.y - b.y) < 1e-6 && Math.abs(b.y - c.y) < 1e-6;
    const upright = Math.abs(a.x - b.x) < 1e-6 && Math.abs(b.x - c.x) < 1e-6;
    const backtracks =
      (flat && (b.x - a.x) * (c.x - b.x) < 0) || (upright && (b.y - a.y) * (c.y - b.y) < 0);
    if (backtracks) {
      out.splice(i, 1);
      i = Math.max(1, i - 1);
      continue;
    }
    i++;
  }
  return out;
}

/**
 * How a producer wants edges to meet a node, set on `metadata.endpointProfile`:
 * `vertex` for a shape that is pointed where its box is not (an edge ends on the drawn
 * outline), `flat` for one with flat sides an edge should approach squarely.
 * `metadata.oneLinePerVertex` asks that each edge take a vertex of its own, and
 * `metadata.captionBelow` that the bottom vertex is left to a caption written under the shape
 * where another vertex serves nearly as well.
 */
function endpointProfileOf(node: any): 'vertex' | 'flat' | undefined {
  const profile = node?.metadata?.endpointProfile;
  return profile === 'vertex' || profile === 'flat' ? profile : undefined;
}

/** Whether the producer of a node declared how edges meet it; a plain node declares nothing. */
export function declaresEndpointProfile(
  node: { metadata?: Record<string, unknown> } | undefined
): boolean {
  return endpointProfileOf(node) !== undefined;
}

/** Whether the producer of any of the nodes declared how edges meet it. */
export function anyNodeDeclaresEndpointProfile(
  nodes: Iterable<{ metadata?: Record<string, unknown> }>
): boolean {
  return [...nodes].some((node) => declaresEndpointProfile(node));
}

function meetsAtVertices(node: any): boolean {
  return endpointProfileOf(node) === 'vertex' && Boolean(node?.metadata?.drawnExtent);
}

const isFlagged = (node: any, key: string): boolean => node?.metadata?.[key] === true;

function wantsOneLinePerCorner(node: any): boolean {
  return isFlagged(node, 'oneLinePerVertex');
}

function vertexOf(node: any, side: VertexSide): Point | undefined {
  const drawn = node?.metadata?.drawnExtent;
  const cx = node?.x;
  const cy = node?.y;
  if (typeof cx !== 'number' || typeof cy !== 'number' || !drawn) {
    return undefined;
  }
  const halfWidth = (drawn.width ?? 0) / 2;
  const halfHeight = (drawn.height ?? 0) / 2;
  if (halfWidth <= 0 || halfHeight <= 0) {
    return undefined;
  }
  switch (side) {
    case 'top':
      return { x: cx, y: cy - halfHeight };
    case 'bottom':
      return { x: cx, y: cy + halfHeight };
    case 'left':
      return { x: cx - halfWidth, y: cy };
    case 'right':
      return { x: cx + halfWidth, y: cy };
  }
}

function writesAQuestionBelow(node: any): boolean {
  const drawn = node?.metadata?.drawnExtent;
  return (
    isFlagged(node, 'captionBelow') &&
    Boolean(drawn) &&
    (node?.height ?? 0) - (drawn?.height ?? 0) > 1
  );
}

/**
 * The route from `vertex` onto `inward` (an edge's points ordered from the node outward) that
 * keeps as much of the route as it can: it joins the route where the route first lies beyond the
 * vertex, or, when none of it does, leaves the vertex by a stub and turns there.
 */
function joinRouteAtVertex(vertex: Point, side: VertexSide, inward: Point[]): Point[] {
  const alongY = side === 'top' || side === 'bottom';
  const away = side === 'top' || side === 'left' ? -1 : 1;
  const rest = inward.slice(1);
  const cleared = rest.findIndex((p) =>
    alongY ? (p.y - vertex.y) * away > 1e-6 : (p.x - vertex.x) * away > 1e-6
  );
  const tail = cleared >= 0 ? rest.slice(cleared) : rest;
  const first = tail[0] ?? vertex;
  if (cleared < 0 && tail.length) {
    // Nothing of the route lies beyond this vertex: the vertex faces away from where the
    // line goes. Turning at the vertex's own height would run the line back through the
    // shape, so it first leaves the vertex by a stub and turns there, outside the shape.
    const stub = alongY
      ? { x: vertex.x, y: vertex.y + away * VERTEX_STUB }
      : { x: vertex.x + away * VERTEX_STUB, y: vertex.y };
    const turn = alongY ? { x: first.x, y: stub.y } : { x: stub.x, y: first.y };
    return dropAxisBacktracks([vertex, stub, turn, ...tail]);
  }
  const corner = alongY ? { x: vertex.x, y: first.y } : { x: first.x, y: vertex.y };
  const needsCorner = Math.abs(corner.x - first.x) > 1e-6 || Math.abs(corner.y - first.y) > 1e-6;
  return dropAxisBacktracks([vertex, ...(needsCorner ? [corner] : []), ...tail]);
}

interface RoutedEdge {
  id?: string;
  points?: Point[];
  start?: string;
  end?: string;
  isLayoutOnly?: boolean;
}

/**
 * The shapes and texts a way from a vertex should keep off: each node's drawn shape, the band
 * under a shape that writes its caption below it, and the edge labels.
 */
function obstaclesOf(nodeByIdMap: Map<string, any>): Obstacle[] {
  const obstacles: Obstacle[] = [];
  for (const node of nodeByIdMap.values()) {
    if (!node || node.isGroup || typeof node.x !== 'number' || typeof node.y !== 'number') {
      continue;
    }
    const box = rectOfNodeBounds(node);
    if (!box) {
      continue;
    }
    const id = String(node.id);
    if (node.isEdgeLabel) {
      obstacles.push({ id, text: box });
      continue;
    }
    const shape = endpointRectOf(node) ?? box;
    const captionBand =
      box.bottom - shape.bottom > 1
        ? { left: box.left, right: box.right, top: shape.bottom, bottom: box.bottom }
        : undefined;
    obstacles.push({ id, shape, ...(captionBand ? { text: captionBand } : {}) });
  }
  return obstacles;
}

const labelNodeIdOf = (edge: RoutedEdge) => `edge-label-${edge.start}-${edge.end}-${edge.id}`;

/**
 * Ends each edge on a pointed node at one of the node's drawn vertices: the one from which the
 * edge's route runs on most simply, with the fewest turns, crossings and texts in its way (see
 * `vertexPorts.ts`), and joins the route to it.
 */
export function meetDiamondsAtTheirVertex(edges: unknown[], nodeByIdMap: Map<string, any>) {
  interface Contact {
    edge: RoutedEdge;
    atStart: boolean;
    incoming: boolean;
  }
  const byNode = new Map<string, Contact[]>();
  const routed: RoutedEdge[] = [];

  for (const edge of edges) {
    const candidate = edge as RoutedEdge;
    if (candidate.isLayoutOnly || !candidate.points || candidate.points.length < 2) {
      continue;
    }
    routed.push(candidate);
    if (candidate.start === candidate.end) {
      continue;
    }
    for (const atStart of [true, false]) {
      const id = atStart ? candidate.start : candidate.end;
      if (!id || !meetsAtVertices(nodeByIdMap.get(id))) {
        continue;
      }
      byNode.set(id, [...(byNode.get(id) ?? []), { edge: candidate, atStart, incoming: !atStart }]);
    }
  }
  if (byNode.size === 0) {
    return;
  }
  const obstacles = obstaclesOf(nodeByIdMap);

  for (const [id, contacts] of byNode) {
    const node = nodeByIdMap.get(id);
    const ownShape = endpointRectOf(node);
    if (!ownShape) {
      continue;
    }
    const ordered = [...contacts].sort((a, b) => Number(b.incoming) - Number(a.incoming));
    const here = new Set(ordered.map((c) => c.edge));
    const captionBelow = writesAQuestionBelow(node);
    const context: VertexContext = {
      vertexAt: (side) => vertexOf(node, side),
      ownShape,
      obstacles,
      exempt: (edge) => new Set([String(id), labelNodeIdOf(edge as RoutedEdge)]),
      textExempt: (edge) => {
        const e = edge as RoutedEdge;
        return new Set([String(e.start === id ? e.end : e.start)]);
      },
      otherRoutes: (edge) =>
        routed.filter((e) => e !== edge && !here.has(e) && e.points).map((e) => e.points!),
      sideCost: (side) => (side === 'bottom' && captionBelow ? CAPTION_VERTEX_COST : 0),
    };

    const options = ordered.map((contact) => {
      const points = dedupeConsecutivePoints(contact.edge.points!, EPS);
      const inward = contact.atStart ? [...points] : [...points].reverse();
      const farId = contact.atStart ? contact.edge.end : contact.edge.start;
      const farNode = farId ? nodeByIdMap.get(farId) : undefined;
      const farRect =
        farNode && !farNode.isGroup && endpointProfileOf(farNode) === 'flat'
          ? endpointRectOf(farNode)
          : undefined;
      const others = context.otherRoutes(contact.edge);
      const perSide = new Map<VertexSide, VertexWay>();
      for (const side of VERTEX_SIDES) {
        const vertex = context.vertexAt(side);
        if (!vertex || inward.length < 2) {
          continue;
        }
        const ways = waysFromVertex(
          vertex,
          side,
          inward,
          farRect,
          joinRouteAtVertex(vertex, side, inward)
        );
        for (const way of ways) {
          const cost = costOfWay(way, context, contact.edge, others) + context.sideCost(side);
          const known = perSide.get(side);
          if (!known || cost < known.cost - 1e-6) {
            perSide.set(side, { side, points: way, cost });
          }
        }
      }
      return perSide;
    });

    const chosen = assignSides(options, wantsOneLinePerCorner(node));
    ordered.forEach((contact, i) => {
      const way = chosen[i];
      if (!way) {
        return;
      }
      // Keep the far end doubled where it was: the renderer reads a doubled end as pinned.
      const before = contact.edge.points!;
      const farDoubled = contact.atStart
        ? before.length > 1 && samePoint(before[before.length - 1], before[before.length - 2], EPS)
        : before.length > 1 && samePoint(before[0], before[1], EPS);
      const outward = farDoubled
        ? [...way.points, { ...way.points[way.points.length - 1] }]
        : way.points;
      contact.edge.points = contact.atStart ? outward : [...outward].reverse();
    });
  }
}

function firstContact(a: Point, b: Point, r: RectBounds): Point | undefined {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const p = [-dx, dx, -dy, dy];
  const q = [a.x - r.left, r.right - a.x, a.y - r.top, r.bottom - a.y];
  let t0 = 0;
  let t1 = 1;
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) {
        return undefined;
      }
      continue;
    }
    const t = q[i] / p[i];
    if (p[i] < 0) {
      if (t > t1) {
        return undefined;
      }
      if (t > t0) {
        t0 = t;
      }
    } else {
      if (t < t0) {
        return undefined;
      }
      if (t < t1) {
        t1 = t;
      }
    }
  }
  const inside = (t1 - t0) * Math.hypot(dx, dy);
  if (inside < 1) {
    return undefined;
  }
  return { x: a.x + t0 * dx, y: a.y + t0 * dy };
}

function cropTail(points: Point[], rect: RectBounds): Point[] {
  for (let i = 0; i < points.length - 1; i++) {
    const square =
      Math.abs(points[i].x - points[i + 1].x) < 1e-6 ||
      Math.abs(points[i].y - points[i + 1].y) < 1e-6;
    if (!square) {
      continue;
    }
    const contact = firstContact(points[i], points[i + 1], rect);
    if (contact) {
      return [...points.slice(0, i + 1), contact];
    }
  }
  return points;
}

/**
 * The rect an end of an edge is cropped to: the drawn extent of a node whose producer declared an
 * endpoint profile. A plain node has none, and its end keeps the point the router drew.
 */
function cropRectOf(node: Node | undefined): RectBounds | undefined {
  return declaresEndpointProfile(node) ? endpointRectOf(node) : undefined;
}

function cropBothEnds(
  points: Point[],
  srcRect: RectBounds | undefined,
  dstRect: RectBounds | undefined
): Point[] {
  const toDestination = dstRect ? cropTail(points, dstRect) : points;
  const cropped = srcRect
    ? cropTail([...toDestination].reverse(), srcRect).reverse()
    : toDestination;
  return cropped.length >= 2 ? cropped : points;
}

function hasRoute(edge: EndpointEdge): edge is EndpointEdge & { points: Point[] } {
  return !edge.isLayoutOnly && edge.points !== undefined && edge.points.length >= 2;
}

const joinsTwoShapes = (src: Node | undefined, dst: Node | undefined): boolean =>
  src !== dst && !src?.isGroup && !dst?.isGroup;

/** Cuts each end of an edge back to the border of the node it ends on, for nodes that declare an endpoint profile. */
export function cropEdgeEndsToShapes(edges: unknown[], nodeByIdMap: Map<string, any>) {
  for (const edge of edges) {
    const candidate = edge as EndpointEdge;
    if (!hasRoute(candidate)) {
      continue;
    }
    const src = candidate.start ? nodeByIdMap.get(candidate.start) : undefined;
    const dst = candidate.end ? nodeByIdMap.get(candidate.end) : undefined;
    if (joinsTwoShapes(src, dst)) {
      candidate.points = cropBothEnds(candidate.points, cropRectOf(src), cropRectOf(dst));
    }
  }
}

const SQUARE_APPROACH_STUB = 18;

export function approachBordersSquarely(edges: unknown[], nodeByIdMap: Map<string, any>) {
  for (const edge of edges) {
    const candidate = edge as {
      points?: Point[];
      start?: string;
      end?: string;
      isLayoutOnly?: boolean;
    };
    if (candidate.isLayoutOnly || !candidate.points || candidate.points.length < 2) {
      continue;
    }
    for (const atStart of [true, false]) {
      const id = atStart ? candidate.start : candidate.end;
      const node = id ? nodeByIdMap.get(id) : undefined;
      if (!node || node.isGroup || endpointProfileOf(node) !== 'flat') {
        continue;
      }
      const rect = endpointRectOf(node);
      const points = candidate.points;
      if (!rect || !points || points.length < 2) {
        continue;
      }
      const ordered: Point[] = atStart ? [...points] : [...points].reverse();
      const end: Point = ordered[0];
      const nextIndex = ordered.findIndex(
        (q, i) => i > 0 && (Math.abs(q.x - end.x) > 1e-6 || Math.abs(q.y - end.y) > 1e-6)
      );
      if (nextIndex < 0) {
        continue;
      }
      const next: Point = ordered[nextIndex];
      const alongY = Math.abs(end.x - next.x) < 1e-6 && Math.abs(end.y - next.y) > 1e-6;
      const alongX = Math.abs(end.y - next.y) < 1e-6 && Math.abs(end.x - next.x) > 1e-6;
      if (!alongY && !alongX) {
        continue;
      }
      const onLeft = Math.abs(end.x - rect.left) < 1;
      const onRight = Math.abs(end.x - rect.right) < 1;
      const onTop = Math.abs(end.y - rect.top) < 1;
      const onBottom = Math.abs(end.y - rect.bottom) < 1;
      if (!((alongY && (onLeft || onRight)) || (alongX && (onTop || onBottom)))) {
        continue;
      }
      const away = alongY ? (onLeft ? -1 : 1) : onTop ? -1 : 1;
      const rail: Point = alongY
        ? { x: end.x + away * SQUARE_APPROACH_STUB, y: next.y }
        : { x: next.x, y: end.y + away * SQUARE_APPROACH_STUB };
      const turn: Point = alongY ? { x: rail.x, y: end.y } : { x: end.x, y: rail.y };
      const after = ordered[nextIndex + 1];
      const canDrop =
        after && (Math.abs(after.x - rail.x) < 1e-6 || Math.abs(after.y - rail.y) < 1e-6);
      const rest: Point[] = ordered.slice(canDrop ? nextIndex + 1 : nextIndex);
      const joined: Point[] = [end, turn, rail, ...rest];
      candidate.points = atStart ? joined : [...joined].reverse();
    }
  }
}
