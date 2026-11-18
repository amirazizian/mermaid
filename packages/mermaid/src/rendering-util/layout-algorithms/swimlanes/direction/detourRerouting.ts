/**
 * Reroutes an edge whose route makes a long detour, turns many times, or runs along the shape it
 * starts or ends at, when a route through the space round it is clearly better.
 *
 * The search runs on a sparse orthogonal grid: lines a clearance off every shape and text in the
 * route's box, halfway between them, and through the ports of the edge's two ends (a flat node's
 * face middles, a pointed node's vertices). A route there costs its length and turns, the texts
 * it crosses, and the other edges it crosses or runs along; it may not cross a shape. The new
 * route replaces the old one only when it costs clearly less by the same measure.
 *
 * Only edges with an end whose producer declared an endpoint profile are rerouted, so a layout of
 * plain nodes keeps the routes the earlier passes gave it.
 */
import {
  declaresEndpointProfile,
  endpointRectOf,
  labelNodeIdOf,
  meetsAtVertices,
  obstaclesOf,
  vertexOf,
} from './endpointClip.js';
import type { RoutedEdge } from './endpointClip.js';
import { readAnchor } from '../anchoredNodes.js';
import { dedupeConsecutivePoints } from './geometry.js';
import type { Point, RectBounds } from './geometry.js';
import type { Obstacle } from './vertexPorts.js';
import {
  BEND_COST,
  bendsOf,
  conflictCost,
  CROSSING_COST,
  lengthOf,
  segmentEntersRect,
  segmentHugsRect,
  SHARED_TRACK_COST,
  TEXT_COST,
  tidy,
  VERTEX_SIDES,
} from './vertexPorts.js';

/** How far grid lines keep off shapes and texts. */
const CLEARANCE = 16;
/** How far a new route runs out of a port before it turns. */
const PORT_STUB = 24;
/** What running along a shape's side costs, per pixel, on top of the run's length. */
const HUG_FACTOR = 1;
/** Closer than this to a side of the edge's own end, a route runs along it. */
const OWN_END_GAP = 32;
/** A route closer than this alongside another one runs too close to it, at this cost per pixel. */
const CLOSE_TRACK = 12;
const CLOSE_TRACK_COST = 1.5;
/** How far a new route keeps off the side of a shape it does not end at. */
const SHAPE_GAP = 6;
/** What crossing a shape costs when an old route is measured; a new route never does. */
const SHAPE_COST = 100_000;
/** What running along its own end's side, closer than OWN_HUG_GAP, costs, and per pixel. */
const OWN_HUG_COST = 200;
const OWN_HUG_GAP = 8;
/** What running along another shape's side, closer than OTHER_HUG_GAP, costs, and per pixel. */
const OTHER_HUG_COST = 200;
const OTHER_HUG_GAP = 5;
/** A new route must cost this much less, and this share less, than the old one to replace it. */
const MIN_SAVING = 60;
const MIN_SAVING_SHARE = 0.15;
/** A route this much longer than the distance between its ends, plus the slack, is a detour. */
const DETOUR_RATIO = 1.5;
const DETOUR_SLACK = 80;
const MANY_BENDS = 4;
/** A face longer than this has ports a quarter in from its ends as well as at its middle. */
const LONG_FACE = 160;
/** Above this many grid lines on either axis, an edge is left as it is. */
const MAX_LINES = 160;

interface Port {
  point: Point;
  /** Unit vector pointing out of the node. */
  out: Point;
}

const NORMALS: Record<(typeof VERTEX_SIDES)[number], Point> = {
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

function portsOf(node: any, rect: RectBounds): Port[] {
  if (meetsAtVertices(node)) {
    return VERTEX_SIDES.flatMap((side) => {
      const point = vertexOf(node, side);
      return point ? [{ point, out: NORMALS[side] }] : [];
    });
  }
  // The middle of each face, and on a long face the points a quarter in from either end too.
  const along = (lo: number, hi: number) =>
    hi - lo > LONG_FACE ? [(lo + hi) / 2, lo + (hi - lo) / 4, hi - (hi - lo) / 4] : [(lo + hi) / 2];
  return [
    ...along(rect.left, rect.right).flatMap((x) => [
      { point: { x, y: rect.top }, out: NORMALS.top },
      { point: { x, y: rect.bottom }, out: NORMALS.bottom },
    ]),
    ...along(rect.top, rect.bottom).flatMap((y) => [
      { point: { x: rect.left, y }, out: NORMALS.left },
      { point: { x: rect.right, y }, out: NORMALS.right },
    ]),
  ];
}

const inflate = (r: RectBounds, by: number): RectBounds => ({
  left: r.left - by,
  right: r.right + by,
  top: r.top - by,
  bottom: r.bottom + by,
});

const centreOf = (r: RectBounds): Point => ({
  x: (r.left + r.right) / 2,
  y: (r.top + r.bottom) / 2,
});

/**
 * Whether a leg of the route runs along a side of one of its own ends, or close along another
 * shape's side (a frame's border, say).
 */
function hugsAShape(points: Point[], ends: RectBounds[], shapes: RectBounds[]): boolean {
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (
      ends.some((rect) => segmentHugsRect(a, b, rect, OWN_HUG_GAP)) ||
      shapes.some((rect) => segmentHugsRect(a, b, rect, OTHER_HUG_GAP))
    ) {
      return true;
    }
  }
  return false;
}

function needsRerouting(
  points: Point[],
  src: RectBounds,
  dst: RectBounds,
  shapes: RectBounds[]
): boolean {
  const a = centreOf(src);
  const b = centreOf(dst);
  const direct = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  return (
    lengthOf(points) > DETOUR_RATIO * direct + DETOUR_SLACK ||
    bendsOf(points) >= MANY_BENDS ||
    hugsAShape(points, [src, dst], shapes)
  );
}

interface Measure {
  obstacles: Obstacle[];
  exempt: Set<string>;
  ends: RectBounds[];
  others: Point[][];
}

/** The cost of a whole route: length, turns, shapes and texts crossed, other edges met. */
function costOfRoute(points: Point[], measure: Measure): number {
  let cost = lengthOf(points) + BEND_COST * bendsOf(points);
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    for (const obstacle of measure.obstacles) {
      if (measure.exempt.has(obstacle.id)) {
        continue;
      }
      if (obstacle.shape && segmentEntersRect(a, b, obstacle.shape)) {
        cost += SHAPE_COST;
      } else if (obstacle.text && segmentEntersRect(a, b, obstacle.text)) {
        cost += TEXT_COST;
      } else if (obstacle.shape && segmentHugsRect(a, b, obstacle.shape, OTHER_HUG_GAP)) {
        cost += OTHER_HUG_COST + HUG_FACTOR * lengthOf([a, b]);
      }
    }
    for (const rect of measure.ends) {
      if (segmentEntersRect(a, b, rect)) {
        cost += SHAPE_COST;
      } else if (segmentHugsRect(a, b, rect, OWN_HUG_GAP)) {
        cost += OWN_HUG_COST + HUG_FACTOR * lengthOf([a, b]);
      }
    }
  }
  for (const other of measure.others) {
    cost += conflictCost(points, other);
  }
  return cost;
}

interface OtherSegment {
  a: Point;
  b: Point;
  horizontal: boolean;
}

/**
 * What one grid step from `a` to `b` costs against the other routes: a crossing where another
 * route passes through the step or its far end (so a crossing on a grid line counts once), and
 * shared track along it.
 */
function stepConflict(a: Point, b: Point, others: OtherSegment[]): number {
  const horizontal = Math.abs(a.y - b.y) < 1e-6;
  let cost = 0;
  for (const o of others) {
    if (o.horizontal === horizontal) {
      const gap = horizontal ? Math.abs(o.a.y - a.y) : Math.abs(o.a.x - a.x);
      if (gap < CLOSE_TRACK) {
        const lo = horizontal ? Math.min(a.x, b.x) : Math.min(a.y, b.y);
        const hi = horizontal ? Math.max(a.x, b.x) : Math.max(a.y, b.y);
        const olo = horizontal ? Math.min(o.a.x, o.b.x) : Math.min(o.a.y, o.b.y);
        const ohi = horizontal ? Math.max(o.a.x, o.b.x) : Math.max(o.a.y, o.b.y);
        const shared = Math.max(0, Math.min(hi, ohi) - Math.max(lo, olo));
        cost += (gap < 3 ? SHARED_TRACK_COST : CLOSE_TRACK_COST) * shared;
      }
      continue;
    }
    // Perpendicular: the other runs across at `at`, over the range lo..hi of the other axis.
    const at = horizontal ? o.a.x : o.a.y;
    const level = horizontal ? a.y : a.x;
    const lo = horizontal ? Math.min(o.a.y, o.b.y) : Math.min(o.a.x, o.b.x);
    const hi = horizontal ? Math.max(o.a.y, o.b.y) : Math.max(o.a.x, o.b.x);
    if (level <= lo + 0.5 || level >= hi - 0.5) {
      continue;
    }
    const from = horizontal ? a.x : a.y;
    const to = horizontal ? b.x : b.y;
    const passes =
      to > from ? at > from + 1e-6 && at <= to + 1e-6 : at < from - 1e-6 && at >= to - 1e-6;
    if (passes) {
      cost += CROSSING_COST;
    }
  }
  return cost;
}

class MinHeap {
  private items: { key: number; value: number }[] = [];
  get size() {
    return this.items.length;
  }
  push(key: number, value: number) {
    const items = this.items;
    items.push({ key, value });
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (items[parent].key <= items[i].key) {
        break;
      }
      [items[parent], items[i]] = [items[i], items[parent]];
      i = parent;
    }
  }
  pop(): { key: number; value: number } {
    const items = this.items;
    const top = items[0];
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < items.length && items[l].key < items[m].key) {
          m = l;
        }
        if (r < items.length && items[r].key < items[m].key) {
          m = r;
        }
        if (m === i) {
          break;
        }
        [items[m], items[i]] = [items[i], items[m]];
        i = m;
      }
    }
    return top;
  }
}

const DIRS: Point[] = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
];

function uniqueSorted(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of sorted) {
    if (out.length === 0 || v - out[out.length - 1] > 0.5) {
      out.push(v);
    }
  }
  return out;
}

/** The best route on the grid from a port of `src` to a port of `dst`, or none. */
function searchRoute(
  srcPorts: Port[],
  dstPorts: Port[],
  region: RectBounds,
  /** The shapes in the way, the edge's own two ends first. */
  blockers: RectBounds[],
  texts: RectBounds[],
  others: OtherSegment[]
): Point[] | undefined {
  const ownEnds = 2;
  const stub = (port: Port): Point => ({
    x: port.point.x + port.out.x * PORT_STUB,
    y: port.point.y + port.out.y * PORT_STUB,
  });
  const xsRaw = [region.left, region.right];
  const ysRaw = [region.top, region.bottom];
  for (const r of [...blockers, ...texts]) {
    xsRaw.push(r.left - CLEARANCE, r.right + CLEARANCE);
    ysRaw.push(r.top - CLEARANCE, r.bottom + CLEARANCE);
  }
  for (const port of [...srcPorts, ...dstPorts]) {
    const s = stub(port);
    xsRaw.push(port.point.x, s.x);
    ysRaw.push(port.point.y, s.y);
  }
  const inside = (v: number, lo: number, hi: number) => v >= lo - 1e-6 && v <= hi + 1e-6;
  let xs = uniqueSorted(xsRaw.filter((x) => inside(x, region.left, region.right)));
  let ys = uniqueSorted(ysRaw.filter((y) => inside(y, region.top, region.bottom)));
  // Lines halfway between neighbouring lines, for a corridor's middle.
  xs = uniqueSorted([...xs, ...xs.slice(1).map((x, i) => (x + xs[i]) / 2)]);
  ys = uniqueSorted([...ys, ...ys.slice(1).map((y, i) => (y + ys[i]) / 2)]);
  if (xs.length > MAX_LINES || ys.length > MAX_LINES) {
    return undefined;
  }
  const indexOf = (values: number[], v: number) => values.findIndex((u) => Math.abs(u - v) < 0.5);
  const W = xs.length;
  const H = ys.length;
  const stateOf = (i: number, j: number, d: number) => (j * W + i) * 4 + d;
  const best = new Float64Array(W * H * 4).fill(Number.POSITIVE_INFINITY);
  const from = new Int32Array(W * H * 4).fill(-1);
  const heap = new MinHeap();

  // A route keeps a gap off every shape; its own ends it meets at their ports.
  const blocked = (a: Point, b: Point) =>
    blockers.some((r, k) => segmentEntersRect(a, b, k < ownEnds ? r : inflate(r, SHAPE_GAP)));
  const textCost = (a: Point, b: Point) =>
    texts.reduce((sum, r) => sum + (segmentEntersRect(a, b, r) ? TEXT_COST : 0), 0);
  // Running along a shape's side, closer than the clearance (or than OWN_END_GAP, along the
  // edge's own ends), costs as much again as the run.
  // A run on the line a port's stub ends on is the approach to that port, not a hug.
  const onStubLine = (a: Point, b: Point) =>
    [...srcPorts, ...dstPorts].some((port) => {
      const s = stub(port);
      return port.out.x === 0
        ? Math.abs(a.y - s.y) < 0.5 && Math.abs(b.y - s.y) < 0.5
        : Math.abs(a.x - s.x) < 0.5 && Math.abs(b.x - s.x) < 0.5;
    });
  const hugCost = (a: Point, b: Point) =>
    blockers.some((r, k) =>
      k < ownEnds
        ? !onStubLine(a, b) && segmentHugsRect(a, b, r, OWN_END_GAP)
        : segmentHugsRect(a, b, r, CLEARANCE - 1)
    )
      ? HUG_FACTOR * (Math.abs(a.x - b.x) + Math.abs(a.y - b.y))
      : 0;
  const dirIndex = (d: Point) => DIRS.findIndex((u) => u.x === d.x && u.y === d.y);

  const starts = new Map<number, Port>();
  for (const port of srcPorts) {
    const s = stub(port);
    const i = indexOf(xs, s.x);
    const j = indexOf(ys, s.y);
    if (i < 0 || j < 0 || blocked(port.point, s)) {
      continue;
    }
    const state = stateOf(i, j, dirIndex(port.out));
    const cost = PORT_STUB + stepConflict(port.point, s, others) + textCost(port.point, s);
    if (cost < best[state]) {
      best[state] = cost;
      starts.set(state, port);
      heap.push(cost, state);
    }
  }
  const goals = new Map<number, Port>();
  for (const port of dstPorts) {
    const s = stub(port);
    const i = indexOf(xs, s.x);
    const j = indexOf(ys, s.y);
    if (i >= 0 && j >= 0 && !blocked(s, port.point)) {
      goals.set(j * W + i, port);
    }
  }

  let bestGoal: { cost: number; state: number; port: Port } | undefined;
  while (heap.size > 0) {
    const { key, value: state } = heap.pop();
    if (key > best[state] + 1e-9) {
      continue;
    }
    if (bestGoal && key >= bestGoal.cost) {
      break;
    }
    const d = state % 4;
    const cell = (state - d) / 4;
    const i = cell % W;
    const j = (cell - i) / W;
    const here = { x: xs[i], y: ys[j] };
    const goal = goals.get(cell);
    if (goal) {
      const inward = { x: -goal.out.x, y: -goal.out.y };
      const turn = DIRS[d].x === inward.x && DIRS[d].y === inward.y ? 0 : BEND_COST;
      const reversed = DIRS[d].x === -inward.x && DIRS[d].y === -inward.y;
      if (!reversed) {
        const total =
          key +
          turn +
          PORT_STUB +
          stepConflict(here, goal.point, others) +
          textCost(here, goal.point);
        if (!bestGoal || total < bestGoal.cost) {
          bestGoal = { cost: total, state, port: goal };
        }
      }
    }
    for (let nd = 0; nd < 4; nd++) {
      const dir = DIRS[nd];
      if (dir.x === -DIRS[d].x && dir.y === -DIRS[d].y) {
        continue;
      }
      const ni = i + dir.x;
      const nj = j + dir.y;
      if (ni < 0 || nj < 0 || ni >= W || nj >= H) {
        continue;
      }
      const there = { x: xs[ni], y: ys[nj] };
      if (blocked(here, there)) {
        continue;
      }
      const step =
        Math.abs(there.x - here.x) +
        Math.abs(there.y - here.y) +
        (nd === d ? 0 : BEND_COST) +
        stepConflict(here, there, others) +
        textCost(here, there) +
        hugCost(here, there);
      const next = stateOf(ni, nj, nd);
      if (key + step < best[next] - 1e-9) {
        best[next] = key + step;
        from[next] = state;
        heap.push(key + step, next);
      }
    }
  }
  if (!bestGoal) {
    return undefined;
  }
  const cells: Point[] = [];
  let state = bestGoal.state;
  let first = state;
  while (state >= 0) {
    const cell = (state - (state % 4)) / 4;
    cells.push({ x: xs[cell % W], y: ys[(cell - (cell % W)) / W] });
    first = state;
    state = from[state];
  }
  const startPort = starts.get(first);
  if (!startPort) {
    return undefined;
  }
  return tidy([startPort.point, ...cells.reverse(), bestGoal.port.point]);
}

/** Reroutes edges that detour, turn many times, or run along their own ends, where it pays. */
export function rerouteDetouredEdges(edges: unknown[], nodeByIdMap: Map<string, any>): void {
  const routed = (edges as RoutedEdge[]).filter(
    (e) => !e.isLayoutOnly && e.points && e.points.length >= 2
  );
  let obstacles: Obstacle[] | undefined;
  for (const edge of routed) {
    const src = edge.start ? nodeByIdMap.get(edge.start) : undefined;
    const dst = edge.end ? nodeByIdMap.get(edge.end) : undefined;
    if (!src || !dst || src === dst || src.isGroup || dst.isGroup) {
      continue;
    }
    if (!declaresEndpointProfile(src) && !declaresEndpointProfile(dst)) {
      continue;
    }
    // A line to a node stood off its host is laid with the node, beside the host.
    if (readAnchor(src)?.gap || readAnchor(dst)?.gap) {
      continue;
    }
    const srcRect = endpointRectOf(src);
    const dstRect = endpointRectOf(dst);
    if (!srcRect || !dstRect) {
      continue;
    }
    const old = dedupeConsecutivePoints(edge.points!, 1e-3);
    obstacles ??= obstaclesOf(nodeByIdMap);
    const exempt = new Set([String(edge.start), String(edge.end), labelNodeIdOf(edge)]);
    const otherShapes = obstacles.filter((o) => !exempt.has(o.id) && o.shape).map((o) => o.shape!);
    if (old.length < 2 || !needsRerouting(old, srcRect, dstRect, otherShapes)) {
      continue;
    }
    const others = routed
      .filter((e) => e !== edge)
      .map((e) => dedupeConsecutivePoints(e.points!, 1e-3));
    const measure: Measure = { obstacles, exempt, ends: [srcRect, dstRect], others };

    const xsOld = old.map((p) => p.x);
    const ysOld = old.map((p) => p.y);
    const region = {
      left: Math.min(...xsOld, srcRect.left, dstRect.left) - PORT_STUB - 1,
      right: Math.max(...xsOld, srcRect.right, dstRect.right) + PORT_STUB + 1,
      top: Math.min(...ysOld, srcRect.top, dstRect.top) - PORT_STUB - 1,
      bottom: Math.max(...ysOld, srcRect.bottom, dstRect.bottom) + PORT_STUB + 1,
    };
    const overlapsRegion = (r: RectBounds) =>
      r.right > region.left &&
      r.left < region.right &&
      r.bottom > region.top &&
      r.top < region.bottom;
    const blockers = [
      srcRect,
      dstRect,
      ...obstacles
        .filter((o) => !exempt.has(o.id) && o.shape && overlapsRegion(o.shape))
        .map((o) => o.shape!),
    ];
    const texts = obstacles
      .filter((o) => !exempt.has(o.id) && o.text && overlapsRegion(o.text))
      .map((o) => o.text!);
    const otherSegments: OtherSegment[] = others.flatMap((points) =>
      points.slice(1).flatMap((b, k) => {
        const a = points[k];
        const horizontal = Math.abs(a.y - b.y) < 1e-6;
        const vertical = Math.abs(a.x - b.x) < 1e-6;
        return horizontal !== vertical ? [{ a, b, horizontal }] : [];
      })
    );
    const route = searchRoute(
      portsOf(src, srcRect),
      portsOf(dst, dstRect),
      region,
      blockers,
      texts,
      otherSegments
    );
    if (!route || route.length < 2) {
      continue;
    }
    const before = costOfRoute(old, measure);
    const after = costOfRoute(route, measure);
    if (after < before - MIN_SAVING && after < (1 - MIN_SAVING_SHARE) * before) {
      edge.points = route;
    }
  }
}
