/**
 * Where on its host's border a node attached to it with no stand-off (a BPMN boundary event)
 * sits: which border, and where along it, chosen by where its flows go.
 *
 * Each attached node of a host may take one of a few places: the start, the middle or the end
 * of the border on either side of the host that crosses the flow (the bottom and the top in
 * TB; in LR the borders that become the bottom and the top). An assignment of the host's
 * attached nodes to distinct places is costed by the length of each node's flows from just
 * outside its place to their other ends, a turn round the host for a flow whose end lies
 * behind it, the crossings of those flows with each other and with the host's own flows, a
 * place on the line of a host's own flow, and a place where the node would overlap another;
 * the cheapest wins. A small cost on the places other than the default keeps the default where
 * nothing else decides.
 *
 * The choice is made once, when the nodes are first pinned in the layout's own space before
 * the edges are routed, and kept for the pin in the drawn space.
 */
import type { LayoutData, Node } from '../../types.js';

export type PlacementSide = 'top' | 'right' | 'bottom' | 'left';

export interface AttachedPlacement {
  side: PlacementSide;
  /** -1 the start of the border, 0 its middle, 1 its end. */
  slot: -1 | 0 | 1;
}

interface Point {
  x: number;
  y: number;
}

interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const SLOTS: AttachedPlacement['slot'][] = [-1, 0, 1];

/** Room between a node at the start or end of a border and that border's corner. */
export const PLACEMENT_INSET = 8;
/** What a crossing with another flow costs, in pixels of length. */
const CROSSING_COST = 300;
/** What a turn round the host costs, per pixel of the host's extent. */
const ROUND_THE_HOST = 2;
/** What a place costs that is not the default, so the default stands where nothing decides. */
const OFF_DEFAULT_COST = 6;
/** What a place costs where the node would overlap another node. */
const OVERLAP_COST = 100_000;

const OUTWARD: Record<PlacementSide, Point> = {
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

const boxOf = (node: Node): Rect => ({
  left: (node.x ?? 0) - (node.width ?? 0) / 2,
  right: (node.x ?? 0) + (node.width ?? 0) / 2,
  top: (node.y ?? 0) - (node.height ?? 0) / 2,
  bottom: (node.y ?? 0) + (node.height ?? 0) / 2,
});

const centreOf = (node: Node): Point => ({ x: node.x ?? 0, y: node.y ?? 0 });

const drawnHalfAlong = (node: Node, alongX: boolean): number => {
  const drawn = node.metadata?.drawnExtent as { width?: unknown; height?: unknown } | undefined;
  const value = alongX ? drawn?.width : drawn?.height;
  return typeof value === 'number' && value > 0
    ? value / 2
    : ((alongX ? node.width : node.height) ?? 0) / 2;
};

/** Where on its host's border a node at `place` has its centre. */
export function placedCentre(host: Node, node: Node, place: AttachedPlacement): Point {
  const alongX = place.side === 'top' || place.side === 'bottom';
  const hostHalf = ((alongX ? host.width : host.height) ?? 0) / 2;
  const reach = Math.max(0, hostHalf - PLACEMENT_INSET - drawnHalfAlong(node, alongX));
  const along = place.slot * reach;
  const hx = host.x ?? 0;
  const hy = host.y ?? 0;
  const hw = (host.width ?? 0) / 2;
  const hh = (host.height ?? 0) / 2;
  switch (place.side) {
    case 'top':
      return { x: hx + along, y: hy - hh };
    case 'bottom':
      return { x: hx + along, y: hy + hh };
    case 'left':
      return { x: hx - hw, y: hy + along };
    case 'right':
      return { x: hx + hw, y: hy + along };
  }
}

function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const orient = (p: Point, q: Point, r: Point) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = orient(c, d, a);
  const d2 = orient(c, d, b);
  const d3 = orient(a, b, c);
  const d4 = orient(a, b, d);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/**
 * Whether two flows that leave one border, from exits `a` and `b`, to `ta` and `tb`, cross on
 * their way, routed as orthogonal lines do: out of the border, along it towards the target,
 * and on to it. A flow that runs along the border past the other's exit passes outside it, so
 * it crosses the other unless it ends further out than the other does. Two flows heading
 * towards each other cross; two heading apart do not.
 */
export function flowsFromOneBorderCross(
  a: Point,
  ta: Point,
  b: Point,
  tb: Point,
  outward: Point
): boolean {
  const alongOf = (p: Point) => (outward.x === 0 ? p.x : p.y);
  const outOf = (p: Point) => p.x * outward.x + p.y * outward.y;
  // Order the two exits along the border.
  const [first, second] =
    alongOf(a) <= alongOf(b)
      ? [
          { at: alongOf(a), to: alongOf(ta), out: outOf(ta) },
          { at: alongOf(b), to: alongOf(tb), out: outOf(tb) },
        ]
      : [
          { at: alongOf(b), to: alongOf(tb), out: outOf(tb) },
          { at: alongOf(a), to: alongOf(ta), out: outOf(ta) },
        ];
  const firstGoes = Math.sign(first.to - first.at);
  const secondGoes = Math.sign(second.to - second.at);
  if (firstGoes > 0 && secondGoes < 0) {
    return true;
  }
  if (firstGoes > 0 && first.to > second.at) {
    return first.out < second.out;
  }
  if (secondGoes < 0 && second.to < first.at) {
    return second.out < first.out;
  }
  return false;
}

const overlaps = (a: Rect, b: Rect) =>
  a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;

interface Flow {
  /** The other end's centre. */
  to: Point;
}

/**
 * The places of `attached` on `host`'s border: one each, distinct, the cheapest assignment
 * among `sides`, `fallback` being the default place. Undefined when there are more nodes than
 * places.
 */
export function choosePlacements(
  host: Node,
  attached: Node[],
  layout: LayoutData,
  sides: PlacementSide[],
  fallback: AttachedPlacement
): Map<string, AttachedPlacement> | undefined {
  const places = sides.flatMap((side) => SLOTS.map((slot) => ({ side, slot })));
  if (attached.length === 0 || attached.length > places.length) {
    return undefined;
  }
  const nodes = layout.nodes ?? [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const attachedIds = new Set(attached.map((node) => node.id));
  const edges = (layout.edges ?? []).filter((edge) => {
    const start = byId.get(String(edge.start));
    const end = byId.get(String(edge.end));
    return start && end && !start.isEdgeLabel && !end.isEdgeLabel && start !== end;
  });
  const placed = (node: Node) => typeof node.x === 'number' && typeof node.y === 'number';

  const flowsOf = (node: Node): Flow[] =>
    edges.flatMap((edge) => {
      const otherId =
        edge.start === node.id ? edge.end : edge.end === node.id ? edge.start : undefined;
      const other = otherId === undefined ? undefined : byId.get(String(otherId));
      return other && other.id !== host.id && placed(other) ? [{ to: centreOf(other) }] : [];
    });
  // The host's own flows, as lines from its centre to their other ends.
  const hostFlows = edges.flatMap((edge) => {
    const otherId =
      edge.start === host.id ? edge.end : edge.end === host.id ? edge.start : undefined;
    const other = otherId === undefined ? undefined : byId.get(String(otherId));
    return other && !attachedIds.has(other.id) && placed(other) ? [centreOf(other)] : [];
  });
  const hostCentre = centreOf(host);
  const hostBox = boxOf(host);
  const others = nodes.filter(
    (node) => !node.isGroup && node.id !== host.id && !attachedIds.has(node.id) && placed(node)
  );

  const exitOf = (node: Node, place: AttachedPlacement): Point => {
    const centre = placedCentre(host, node, place);
    const o = OUTWARD[place.side];
    const reach = drawnHalfAlong(node, o.x === 0 ? false : true) + 12;
    return { x: centre.x + o.x * reach, y: centre.y + o.y * reach };
  };

  const placeCost = (node: Node, place: AttachedPlacement): number => {
    const o = OUTWARD[place.side];
    const exit = exitOf(node, place);
    const centre = placedCentre(host, node, place);
    let cost = place.side === fallback.side && place.slot === fallback.slot ? 0 : OFF_DEFAULT_COST;
    const hostExtent = o.x === 0 ? hostBox.bottom - hostBox.top : hostBox.right - hostBox.left;
    for (const flow of flowsOf(node)) {
      cost += Math.abs(exit.x - flow.to.x) + Math.abs(exit.y - flow.to.y);
      const ahead = (flow.to.x - centre.x) * o.x + (flow.to.y - centre.y) * o.y;
      if (ahead < 0) {
        cost += ROUND_THE_HOST * hostExtent;
      }
      for (const to of hostFlows) {
        if (segmentsCross(exit, flow.to, hostCentre, to)) {
          cost += CROSSING_COST;
        }
      }
    }
    // A host's own flow towards this side leaves the border at its middle: a place there sits
    // in that flow's way.
    const alongX = o.x === 0;
    const half = drawnHalfAlong(node, alongX) + PLACEMENT_INSET;
    for (const to of hostFlows) {
      const towards = (to.x - hostCentre.x) * o.x + (to.y - hostCentre.y) * o.y;
      const offset = alongX ? centre.x - hostCentre.x : centre.y - hostCentre.y;
      if (towards > 0 && Math.abs(offset) < half) {
        cost += CROSSING_COST;
      }
    }
    // A place where the node would overlap another node.
    const box = {
      left: centre.x - (node.width ?? 0) / 2,
      right: centre.x + (node.width ?? 0) / 2,
      top: centre.y - (node.height ?? 0) / 2,
      bottom: centre.y + (node.height ?? 0) / 2,
    };
    if (others.some((other) => overlaps(box, boxOf(other)))) {
      cost += OVERLAP_COST;
    }
    return cost;
  };

  const costs = attached.map((node) => places.map((place) => placeCost(node, place)));
  let best: number[] | undefined;
  let bestCost = Number.POSITIVE_INFINITY;
  const pick = (index: number, chosen: number[], sum: number) => {
    if (sum >= bestCost) {
      return;
    }
    if (index === attached.length) {
      // Flows of two attached nodes that cross each other.
      let total = sum;
      for (let i = 0; i < attached.length; i++) {
        for (let j = i + 1; j < attached.length; j++) {
          const [pi, pj] = [places[chosen[i]], places[chosen[j]]];
          const ei = exitOf(attached[i], pi);
          const ej = exitOf(attached[j], pj);
          for (const fi of flowsOf(attached[i])) {
            for (const fj of flowsOf(attached[j])) {
              const cross =
                pi.side === pj.side
                  ? flowsFromOneBorderCross(ei, fi.to, ej, fj.to, OUTWARD[pi.side])
                  : segmentsCross(ei, fi.to, ej, fj.to);
              if (cross) {
                total += CROSSING_COST;
              }
            }
          }
        }
      }
      if (total < bestCost) {
        bestCost = total;
        best = [...chosen];
      }
      return;
    }
    for (let p = 0; p < places.length; p++) {
      if (!chosen.includes(p)) {
        pick(index + 1, [...chosen, p], sum + costs[index][p]);
      }
    }
  };
  pick(0, [], 0);
  if (!best) {
    return undefined;
  }
  const chosenPlaces = best;
  return new Map(attached.map((node, i) => [node.id, places[chosenPlaces[i]]]));
}
