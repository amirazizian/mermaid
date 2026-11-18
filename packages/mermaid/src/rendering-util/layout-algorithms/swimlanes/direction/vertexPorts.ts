/**
 * Chooses the vertex an edge meets a pointed shape at (a diamond, a circle drawn smaller than its
 * box), and the route from that vertex to the rest of the edge.
 *
 * Each vertex an edge could take is tried with a few short ways of joining the edge's route from
 * there: straight on, one turn, or two turns, onto any point of the route. Each way is costed by
 * its length, its turns, the shapes and texts it crosses and the other edges it crosses or runs
 * along, and an edge takes the vertex whose best way costs least. A node that asks for one line
 * per vertex gets the assignment of its edges to distinct vertices that costs least in all.
 */
import { dedupeConsecutivePoints, simplifyPolyline } from './geometry.js';
import type { Point, RectBounds } from './geometry.js';

export type VertexSide = 'top' | 'bottom' | 'left' | 'right';
export const VERTEX_SIDES: readonly VertexSide[] = ['top', 'bottom', 'left', 'right'];

/** How far a line runs out of a vertex before it turns. */
export const VERTEX_STUB = 12;

/** What a turn costs, in pixels of length. */
const BEND_COST = 30;
/** What crossing a shape costs: a way that does is used only when every way does. */
const SHAPE_COST = 100_000;
/** What crossing a text (a caption or another edge's label) costs. */
const TEXT_COST = 250;
/** What crossing another edge costs. */
const CROSSING_COST = 90;
/** What running along another edge costs, per pixel shared. */
const SHARED_TRACK_COST = 6;
/** What running along another shape's side, closer than HUG_GAP, costs. */
const HUG_COST = 120;
const HUG_GAP = 6;
/** What running along the node's own shape, closer than OWN_HUG_GAP, costs. */
const OWN_HUG_COST = 40;
const OWN_HUG_GAP = 16;
/**
 * What taking the bottom vertex of a node that writes its caption below costs. The caption can
 * move aside, so the vertex is not barred; it is used where it saves more than this.
 */
export const CAPTION_VERTEX_COST = 60;

const EPS = 1e-6;

export interface Obstacle {
  id: string;
  /** The drawn shape: a way through it is not taken while another way is clear. */
  shape?: RectBounds;
  /** A text, or the room round a shape it writes in: a way through it costs TEXT_COST. */
  text?: RectBounds;
}

export interface VertexContext {
  /** The node's drawn vertices. */
  vertexAt: (side: VertexSide) => Point | undefined;
  /** The node's own drawn shape, which a way must not run back through. */
  ownShape: RectBounds;
  obstacles: Obstacle[];
  /** Ids of obstacles a given edge may cross: its own node and its own label. */
  exempt: (edge: unknown) => Set<string>;
  /** Ids of obstacles whose text a given edge may cross: its far end's caption. */
  textExempt: (edge: unknown) => Set<string>;
  /** Routes of the other edges, to count crossings and shared track against. */
  otherRoutes: (edge: unknown) => Point[][];
  /** Extra cost of using a side, such as a caption below. */
  sideCost: (side: VertexSide) => number;
  /** The rect of the far end's node, where a way may arrive anywhere along the same face. */
  farRect?: (edge: unknown) => RectBounds | undefined;
}

export interface VertexWay {
  side: VertexSide;
  /** The route from the vertex outward to the far end. */
  points: Point[];
  cost: number;
}

const normalOf = (side: VertexSide): Point => {
  switch (side) {
    case 'top':
      return { x: 0, y: -1 };
    case 'bottom':
      return { x: 0, y: 1 };
    case 'left':
      return { x: -1, y: 0 };
    case 'right':
      return { x: 1, y: 0 };
  }
};

const along = (p: Point, n: Point) => p.x * n.x + p.y * n.y;
const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });

function dropBacktracks(points: Point[]): Point[] {
  const out = [...points];
  let i = 1;
  while (i < out.length - 1) {
    const [a, b, c] = [out[i - 1], out[i], out[i + 1]];
    const flat = Math.abs(a.y - b.y) < EPS && Math.abs(b.y - c.y) < EPS;
    const upright = Math.abs(a.x - b.x) < EPS && Math.abs(b.x - c.x) < EPS;
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

const tidy = (points: Point[]): Point[] =>
  simplifyPolyline(dropBacktracks(dedupeConsecutivePoints(points, 1e-3)));

const isOrthogonal = (points: Point[]) =>
  points.every(
    (p, i) =>
      i === 0 || Math.abs(p.x - points[i - 1].x) < EPS || Math.abs(p.y - points[i - 1].y) < EPS
  );

const lengthOf = (points: Point[]) =>
  points.reduce(
    (sum, p, i) =>
      i === 0 ? sum : sum + Math.abs(p.x - points[i - 1].x) + Math.abs(p.y - points[i - 1].y),
    0
  );

function bendsOf(points: Point[]): number {
  let bends = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1];
    const b = points[i];
    const c = points[i + 1];
    const firstHorizontal = Math.abs(a.y - b.y) < EPS;
    const secondHorizontal = Math.abs(b.y - c.y) < EPS;
    if (firstHorizontal !== secondHorizontal) {
      bends++;
    }
  }
  return bends;
}

/** Whether segment a-b runs through the inside of rect (touching its border does not count). */
function segmentEntersRect(a: Point, b: Point, rect: RectBounds, inset = 0.5): boolean {
  const left = rect.left + inset;
  const right = rect.right - inset;
  const top = rect.top + inset;
  const bottom = rect.bottom - inset;
  if (left >= right || top >= bottom) {
    return false;
  }
  return (
    Math.max(a.x, b.x) > left &&
    Math.min(a.x, b.x) < right &&
    Math.max(a.y, b.y) > top &&
    Math.min(a.y, b.y) < bottom
  );
}

/** Whether segment a-b runs along a side of rect, outside it but closer than `gap`. */
function segmentHugsRect(a: Point, b: Point, rect: RectBounds, gap: number): boolean {
  const horizontal = Math.abs(a.y - b.y) < EPS;
  const vertical = Math.abs(a.x - b.x) < EPS;
  const minLength = 12;
  if (horizontal) {
    const overlap =
      Math.min(Math.max(a.x, b.x), rect.right) - Math.max(Math.min(a.x, b.x), rect.left);
    const nearTop = a.y < rect.top && rect.top - a.y < gap;
    const nearBottom = a.y > rect.bottom && a.y - rect.bottom < gap;
    return overlap > minLength && (nearTop || nearBottom);
  }
  if (vertical) {
    const overlap =
      Math.min(Math.max(a.y, b.y), rect.bottom) - Math.max(Math.min(a.y, b.y), rect.top);
    const nearLeft = a.x < rect.left && rect.left - a.x < gap;
    const nearRight = a.x > rect.right && a.x - rect.right < gap;
    return overlap > minLength && (nearLeft || nearRight);
  }
  return false;
}

function strictlyCross(a1: Point, b1: Point, a2: Point, b2: Point): boolean {
  const h1 = Math.abs(a1.y - b1.y) < EPS;
  const h2 = Math.abs(a2.y - b2.y) < EPS;
  if (h1 === h2) {
    return false;
  }
  const [h, v] = h1
    ? [
        [a1, b1],
        [a2, b2],
      ]
    : [
        [a2, b2],
        [a1, b1],
      ];
  const y = h[0].y;
  const x = v[0].x;
  return (
    x > Math.min(h[0].x, h[1].x) + 0.5 &&
    x < Math.max(h[0].x, h[1].x) - 0.5 &&
    y > Math.min(v[0].y, v[1].y) + 0.5 &&
    y < Math.max(v[0].y, v[1].y) - 0.5
  );
}

function sharedLength(a1: Point, b1: Point, a2: Point, b2: Point): number {
  const near = 3;
  if (Math.abs(a1.y - b1.y) < EPS && Math.abs(a2.y - b2.y) < EPS && Math.abs(a1.y - a2.y) < near) {
    return Math.max(
      0,
      Math.min(Math.max(a1.x, b1.x), Math.max(a2.x, b2.x)) -
        Math.max(Math.min(a1.x, b1.x), Math.min(a2.x, b2.x))
    );
  }
  if (Math.abs(a1.x - b1.x) < EPS && Math.abs(a2.x - b2.x) < EPS && Math.abs(a1.x - a2.x) < near) {
    return Math.max(
      0,
      Math.min(Math.max(a1.y, b1.y), Math.max(a2.y, b2.y)) -
        Math.max(Math.min(a1.y, b1.y), Math.min(a2.y, b2.y))
    );
  }
  return 0;
}

/** Crossings and shared track between two routes. */
export function conflictCost(route: Point[], other: Point[]): number {
  let cost = 0;
  for (let i = 0; i < route.length - 1; i++) {
    for (let j = 0; j < other.length - 1; j++) {
      if (strictlyCross(route[i], route[i + 1], other[j], other[j + 1])) {
        cost += CROSSING_COST;
      }
      cost += SHARED_TRACK_COST * sharedLength(route[i], route[i + 1], other[j], other[j + 1]);
    }
  }
  return cost;
}

/** The cost of a way, against the shapes, texts and other routes round it. */
export function costOfWay(
  points: Point[],
  context: VertexContext,
  edge: unknown,
  others: Point[][]
): number {
  let cost = lengthOf(points) + BEND_COST * bendsOf(points);
  const exempt = context.exempt(edge);
  const textExempt = context.textExempt(edge);
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (segmentEntersRect(a, b, context.ownShape)) {
      cost += SHAPE_COST;
    } else if (segmentHugsRect(a, b, context.ownShape, OWN_HUG_GAP)) {
      cost += OWN_HUG_COST;
    }
    for (const obstacle of context.obstacles) {
      if (exempt.has(obstacle.id)) {
        continue;
      }
      if (obstacle.shape && segmentEntersRect(a, b, obstacle.shape)) {
        cost += SHAPE_COST;
      } else if (
        obstacle.text &&
        !textExempt.has(obstacle.id) &&
        segmentEntersRect(a, b, obstacle.text)
      ) {
        cost += TEXT_COST;
      } else if (obstacle.shape && segmentHugsRect(a, b, obstacle.shape, HUG_GAP)) {
        cost += HUG_COST;
      }
    }
  }
  for (const other of others) {
    cost += conflictCost(points, other);
  }
  return cost;
}

/**
 * The ways from `vertex`, leaving along `side`, onto the route `route` (ordered from the node
 * outward; its first point is where it meets the node now and is replaced). `kept` is a way that
 * keeps most of the route, offered as one more way when it leaves and arrives soundly.
 */
export function waysFromVertex(
  vertex: Point,
  side: VertexSide,
  route: Point[],
  farRect?: RectBounds,
  kept?: Point[]
): Point[][] {
  const n = normalOf(side);
  const vertical = n.x === 0;
  const far = route[route.length - 1];
  const beforeFar = route[route.length - 2];
  const lastDirection = beforeFar ? sub(far, beforeFar) : undefined;
  const ways: Point[][] = [];

  const ahead = (p: Point) => along(sub(p, vertex), n);
  const projectAlong = (p: Point): Point =>
    vertical ? { x: vertex.x, y: p.y } : { x: p.x, y: vertex.y };

  for (let k = 1; k < route.length; k++) {
    const target = route[k];
    const rest = route.slice(k + 1);
    const distance = ahead(target);
    if (distance < VERTEX_STUB) {
      continue;
    }
    const corner = projectAlong(target);
    // Straight on, or one turn at `corner`.
    ways.push([vertex, corner, target, ...rest]);
    // Two turns: out to halfway, across, and on along the same axis.
    const half = distance / 2;
    const mid = { x: vertex.x + n.x * half, y: vertex.y + n.y * half };
    const across = vertical ? { x: target.x, y: mid.y } : { x: mid.x, y: target.y };
    ways.push([vertex, mid, across, target, ...rest]);
  }

  // Ways that end on another face of a flat far end: straight on into it where the vertex lines
  // up with it, or one turn into the face nearest the vertex.
  const freeEnds: Point[][] = [];
  if (farRect) {
    const lo = vertical ? farRect.left : farRect.top;
    const hi = vertical ? farRect.right : farRect.bottom;
    const cross = vertical ? vertex.x : vertex.y;
    const nearFace = (r: RectBounds) =>
      n.y > 0 ? r.top : n.y < 0 ? r.bottom : n.x > 0 ? r.left : r.right;
    const centre = { x: (farRect.left + farRect.right) / 2, y: (farRect.top + farRect.bottom) / 2 };
    const toFace = along(
      sub(
        vertical ? { x: vertex.x, y: nearFace(farRect) } : { x: nearFace(farRect), y: vertex.y },
        vertex
      ),
      n
    );
    if (cross > lo + 4 && cross < hi - 4 && toFace >= VERTEX_STUB) {
      freeEnds.push([
        vertex,
        vertical ? { x: vertex.x, y: nearFace(farRect) } : { x: nearFace(farRect), y: vertex.y },
      ]);
    }
    // One turn into the face: at its middle, or a quarter along either way, which keeps clear
    // of another edge at the middle.
    const span = vertical ? farRect.bottom - farRect.top : farRect.right - farRect.left;
    for (const offset of [0, -span / 4, span / 4]) {
      const at = vertical
        ? { x: centre.x, y: centre.y + offset }
        : { x: centre.x + offset, y: centre.y };
      if (along(sub(at, vertex), n) < VERTEX_STUB || (cross >= lo && cross <= hi)) {
        continue;
      }
      const corner = vertical ? { x: vertex.x, y: at.y } : { x: at.x, y: vertex.y };
      const face = vertical
        ? { x: cross < lo ? farRect.left : farRect.right, y: at.y }
        : { x: at.x, y: cross < lo ? farRect.top : farRect.bottom };
      freeEnds.push([vertex, corner, face]);
    }
  }

  const valid: Point[][] = [];
  for (const way of kept ? [kept, ...ways] : ways) {
    // The way that keeps the route may leave by a shorter stub; the others turn a stub out.
    const minStub = way === kept ? 1 : VERTEX_STUB;
    const tidied = tidy(way);
    if (tidied.length < 2 || !isOrthogonal(tidied)) {
      continue;
    }
    // The way leaves the vertex outward, by at least a stub before it turns.
    const first = sub(tidied[1], tidied[0]);
    if (along(first, n) < minStub - EPS || Math.abs(vertical ? first.x : first.y) > EPS) {
      continue;
    }
    // It reaches the far end the way the route did.
    const end = tidied[tidied.length - 1];
    const prev = tidied[tidied.length - 2];
    if (Math.abs(end.x - far.x) > EPS || Math.abs(end.y - far.y) > EPS) {
      continue;
    }
    if (lastDirection) {
      const d = sub(end, prev);
      const sameDirection =
        (Math.abs(d.x) < EPS && Math.abs(lastDirection.x) < EPS && d.y * lastDirection.y > 0) ||
        (Math.abs(d.y) < EPS && Math.abs(lastDirection.y) < EPS && d.x * lastDirection.x > 0);
      if (!sameDirection) {
        continue;
      }
      const lastLength = Math.abs(end.x - prev.x) + Math.abs(end.y - prev.y);
      const routeLastLength = Math.abs(lastDirection.x) + Math.abs(lastDirection.y);
      if (way !== kept && lastLength < Math.min(VERTEX_STUB, routeLastLength) - EPS) {
        continue;
      }
    }
    valid.push(tidied);
  }
  // A way into a new face arrives by at least a stub, room for the arrowhead.
  const arrivesSquarely = (way: Point[]) => {
    const end = way[way.length - 1];
    const prev = way[way.length - 2];
    return Math.abs(end.x - prev.x) + Math.abs(end.y - prev.y) >= VERTEX_STUB - EPS;
  };
  return [...valid, ...freeEnds.map(tidy).filter((way) => way.length >= 2 && arrivesSquarely(way))];
}

/** Every assignment of sides to `count` contacts, distinct sides only with `distinct`. */
function* assignments(count: number, distinct: boolean): Generator<VertexSide[]> {
  const pick = (chosen: VertexSide[]): VertexSide[][] =>
    chosen.length === count
      ? [chosen]
      : VERTEX_SIDES.filter((s) => !distinct || !chosen.includes(s)).flatMap((s) =>
          pick([...chosen, s])
        );
  yield* pick([]);
}

/**
 * Picks a side for each contact. `options[i]` holds contact i's best way per side (a side it
 * cannot use is missing, and a contact with no usable side gets none). With `distinct`, no two
 * contacts share a side while there are sides enough. The ways chosen together are also costed
 * against each other, for crossings and shared track.
 */
export function assignSides(
  options: Map<VertexSide, VertexWay>[],
  distinct: boolean
): (VertexWay | undefined)[] {
  const best = (o: Map<VertexSide, VertexWay>, exclude: Set<VertexSide> = new Set()) =>
    [...o.values()].filter((w) => !exclude.has(w.side)).sort((a, b) => a.cost - b.cost)[0];
  const usable = options.flatMap((o, i) => (o.size > 0 ? [i] : []));
  const result: (VertexWay | undefined)[] = options.map(() => undefined);
  if (usable.length <= VERTEX_SIDES.length) {
    let chosen: VertexWay[] | undefined;
    let chosenCost = Number.POSITIVE_INFINITY;
    for (const sides of assignments(usable.length, distinct)) {
      const ways = sides.map((side, k) => options[usable[k]].get(side));
      if (ways.some((w) => !w)) {
        continue;
      }
      let cost = 0;
      for (let i = 0; i < ways.length; i++) {
        cost += ways[i]!.cost;
        for (let j = i + 1; j < ways.length; j++) {
          cost += conflictCost(ways[i]!.points, ways[j]!.points);
        }
      }
      if (cost < chosenCost - 1e-6) {
        chosenCost = cost;
        chosen = ways as VertexWay[];
      }
    }
    const picked = chosen;
    if (picked) {
      usable.forEach((index, k) => (result[index] = picked[k]));
      return result;
    }
  }
  // More contacts than sides, or no assignment of distinct sides: each in turn takes its best
  // side, a free one where it has one.
  const taken = new Set<VertexSide>();
  for (const index of usable) {
    const way = (distinct ? best(options[index], taken) : undefined) ?? best(options[index]);
    if (way) {
      taken.add(way.side);
    }
    result[index] = way;
  }
  return result;
}
