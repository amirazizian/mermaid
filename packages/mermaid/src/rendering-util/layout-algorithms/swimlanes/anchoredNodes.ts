import type { LayoutData, Node } from '../../types.js';
import { buildLaneModel } from './lanes.js';
import { choosePlacements, placedCentre } from './attachedPlacement.js';
import type { AttachedPlacement, PlacementSide } from './attachedPlacement.js';

type Direction = 'TB' | 'LR' | 'BT' | 'RL';

export type AnchorSide = 'top' | 'right' | 'bottom' | 'left';

const ANCHOR_SIDES = new Set(['top', 'right', 'bottom', 'left']);

const ANCHOR_GAP = 8;

// Far beyond any lane a diagram draws, and small enough that a stand-off keeps every
// coordinate it feeds finite.
export const MAX_ANCHOR_GAP = 10_000;

const OUTWARD: Record<AnchorSide, { x: number; y: number }> = {
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

export interface NodeAnchor {
  hostId: string;

  side?: AnchorSide;

  slot?: number;

  gap?: number;
}

export function readAnchor(node: Node | undefined): NodeAnchor | undefined {
  const raw = node?.metadata?.anchorTo;
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const { hostId, side, slot, gap } = raw as Record<string, unknown>;
  if (typeof hostId !== 'string' || hostId.length === 0 || hostId === node?.id) {
    return undefined;
  }
  return {
    hostId,
    ...(typeof side === 'string' && ANCHOR_SIDES.has(side) ? { side: side as AnchorSide } : {}),
    ...(typeof slot === 'number' && Number.isFinite(slot) ? { slot } : {}),
    ...(typeof gap === 'number' && Number.isFinite(gap) && gap > 0
      ? { gap: Math.min(gap, MAX_ANCHOR_GAP) }
      : {}),
  };
}

export function resolveAnchorHostId(id: string, byId: Map<string, Node>): string | undefined {
  const seen = new Set<string>([id]);
  let hostId = readAnchor(byId.get(id))?.hostId;
  while (hostId && !seen.has(hostId)) {
    const host = byId.get(hostId);
    if (!host) {
      return undefined;
    }
    const next = readAnchor(host)?.hostId;
    if (!next) {
      return hostId;
    }
    seen.add(hostId);
    hostId = next;
  }
  return undefined;
}

/** For a validator's `isAttached`: whether `nodeId` is pinned to `toId` through its anchor chain. */
export function isAnchoredTo(nodes: Node[]): (nodeId: string, toId: string) => boolean {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return (nodeId, toId) => resolveAnchorHostId(nodeId, byId) === toId;
}

export function collectAnchoredIds(nodes: Node[]): Set<string> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ids = new Set<string>();
  for (const node of nodes) {
    if (readAnchor(node) && resolveAnchorHostId(node.id, byId)) {
      ids.add(node.id);
    }
  }
  return ids;
}

export function defaultAnchorSide(space: 'canonical' | 'final', direction: Direction): AnchorSide {
  if (space === 'canonical') {
    return 'right';
  }
  return direction === 'LR' || direction === 'RL' ? 'bottom' : 'right';
}

/**
 * The side a node attached to its host's border (no stand-off gap, such as a boundary event)
 * sits on when it names none: in TB, the bottom, as in LR. On the right side, in the middle of
 * the host, it covered the host's own label, and a flow leaving it ran down the host's border.
 */
function attachedSide(anchor: NodeAnchor, direction: Direction): AnchorSide | undefined {
  return direction === 'TB' && !anchor.side && !anchor.gap ? 'bottom' : undefined;
}

/**
 * How far an attached run on a TB host's bottom moves from the middle towards the right end of
 * the border, keeping BORDER_INSET from the corner, so the flow that leaves the host's bottom
 * in the middle passes it by.
 */
function towardsTheEnd(
  entry: BucketEntry,
  side: AnchorSide,
  direction: Direction,
  hostExtent: number,
  runExtent: number
): number {
  if (side !== 'bottom' || attachedSide(entry.anchor, direction) !== 'bottom') {
    return 0;
  }
  return Math.max(0, hostExtent / 2 - runExtent / 2 - BORDER_INSET);
}

/**
 * How far the nodes attached to each host's bottom border in TB (see `attachedSide`) reach
 * below that border: half their height, caption room included. The gap under the host's layer
 * keeps this much more room, so they do not reach into the next layer.
 */
export function attachedReachBelow(nodes: Node[], direction?: Direction): Map<string, number> {
  const reach = new Map<string, number>();
  for (const bucket of bucketByHostAndSide(nodes, (anchor) =>
    attachedSide(anchor, direction ?? 'TB') === 'bottom' ? 'bottom' : 'right'
  ).values()) {
    const { hostId, side } = bucket[0];
    if (side !== 'bottom') {
      continue;
    }
    const half = Math.max(...bucket.map((entry) => (entry.node.height ?? 0) / 2));
    reach.set(hostId, Math.max(reach.get(hostId) ?? 0, half));
  }
  return reach;
}

export interface AnchorPin {
  nodeId: string;
  hostId: string;
  side: AnchorSide;
  x: number;
  y: number;

  outward: { x: number; y: number };

  /** The node's place in a row going out from the host's side, nearest first. */
  row?: number;
}

function compareBucketEntries(
  a: { anchor: NodeAnchor; index: number },
  b: { anchor: NodeAnchor; index: number }
): number {
  const slotA = a.anchor.slot;
  const slotB = b.anchor.slot;
  if (slotA !== undefined && slotB !== undefined && slotA !== slotB) {
    return slotA - slotB;
  }
  if (slotA !== undefined && slotB === undefined) {
    return -1;
  }
  if (slotA === undefined && slotB !== undefined) {
    return 1;
  }
  return a.index - b.index;
}

function packAlongBorder(spans: number[]): { offsets: number[]; total: number } {
  const total =
    spans.reduce((sum, span) => sum + span, 0) + ANCHOR_GAP * Math.max(0, spans.length - 1);
  const offsets: number[] = [];
  let cursor = -total / 2;
  for (const span of spans) {
    offsets.push(cursor + span / 2);
    cursor += span + ANCHOR_GAP;
  }
  return { offsets, total };
}

interface BucketEntry {
  node: Node;
  anchor: NodeAnchor;
  index: number;
  side: AnchorSide;
  hostId: string;
}

const hasUsableSize = (node: Node) =>
  [node.width, node.height].every((size) => size === undefined || Number.isFinite(size));

function bucketByHostAndSide(
  nodes: Node[],
  sideOf: (anchor: NodeAnchor) => AnchorSide
): Map<string, BucketEntry[]> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const buckets = new Map<string, BucketEntry[]>();
  nodes.forEach((node, index) => {
    const anchor = readAnchor(node);
    if (!anchor || !hasUsableSize(node)) {
      return;
    }
    const hostId = resolveAnchorHostId(node.id, byId);
    if (!hostId) {
      return;
    }
    const side = sideOf(anchor);
    const key = `${side}:${hostId}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push({ node, anchor, index, side, hostId });
    buckets.set(key, bucket);
  });
  for (const bucket of buckets.values()) {
    bucket.sort(compareBucketEntries);
  }
  return buckets;
}

/**
 * The hosts with a flow to or from another pool (a message flow). In TB such a flow leaves the
 * host by a side, where a row of stood-off nodes would stand in its way, so their nodes keep
 * to a column beside the host, clear of its middle.
 */
function hostsWithFlowsAcrossPools(nodes: Node[], edges?: LayoutData['edges']): Set<string> {
  const busy = new Set<string>();
  if (!edges?.length) {
    return busy;
  }
  const model = buildLaneModel(nodes);
  for (const edge of edges) {
    const { start, end } = edge;
    if (typeof start !== 'string' || typeof end !== 'string') {
      continue;
    }
    if (model.poolIdOf(start) !== model.poolIdOf(end)) {
      busy.add(start);
      busy.add(end);
    }
  }
  return busy;
}

/**
 * In TB, splits a run of stood-off nodes on a host's right side that named no side between
 * the right and the left side, so each side holds half of it: with one or two nodes a side,
 * the nearest goes straight into the host. A node that leaves by its left face (a text
 * annotation's bracket) stays on the right, facing the host, and goes after the others there.
 */
function spreadAcrossBothSides(
  buckets: Map<string, BucketEntry[]>,
  direction: Direction,
  busy: Set<string>
): Map<string, BucketEntry[]> {
  if (direction !== 'TB') {
    return buckets;
  }
  for (const [key, bucket] of [...buckets]) {
    const spreadable = bucket.every((entry) => !entry.anchor.side && (entry.anchor.gap ?? 0) > 0);
    if (
      bucket[0].side !== 'right' ||
      bucket.length < 2 ||
      !spreadable ||
      busy.has(bucket[0].hostId)
    ) {
      continue;
    }
    const facing = bucket.filter((entry) => attachFaceOf(entry.node) === 'left');
    const others = bucket.filter((entry) => attachFaceOf(entry.node) !== 'left');
    const leftCount = Math.floor(bucket.length / 2);
    const left = others.filter((_, i) => i % 2 === 0).slice(0, leftCount);
    const right = [...others.filter((entry) => !left.includes(entry)), ...facing];
    const hostId = bucket[0].hostId;
    const leftKey = `left:${hostId}`;
    buckets.set(key, right);
    buckets.set(leftKey, [
      ...(buckets.get(leftKey) ?? []),
      ...left.map((entry) => ({ ...entry, side: 'left' as AnchorSide })),
    ]);
  }
  return buckets;
}

/**
 * Where a node's centre lies along its host's border, measured from the host's centre.
 *
 * A flow runs through the middle of the node it joins, so a node standing off the left or
 * right of its host stands clear of that line rather than across it: it is moved towards
 * the start of the border by its own half-extent plus ANCHOR_GAP. Along the top or bottom
 * there is no such line to clear, and the run stays centred on the host.
 */
function centreAlongBorder(
  offset: number,
  horizontal: boolean,
  clearance: number,
  alongHalf: number
): number {
  const clearOfFlow = !horizontal && clearance > 0 ? -(alongHalf + ANCHOR_GAP) : 0;
  return offset + clearOfFlow;
}

export interface AnchorFootprint {
  /** Room needed on the start side of the host's centre, along its border. */
  before: number;
  /** Room needed on the end side of the host's centre, along its border. */
  after: number;
  /** Room needed outward from the host's border. */
  beyond: number;
}

/**
 * Whether a run of stood-off nodes beside a TB host is laid out as a row going out from the
 * host's side rather than as a column along it. A column taller than the host leaves all but
 * one node above or below it, and their lines nest round its corner; in a row each line is a
 * short stub or one hop over the nodes nearer the host into its top or bottom face.
 */
function laysOutward(
  bucket: BucketEntry[],
  side: AnchorSide,
  direction: Direction,
  busy: Set<string>
): boolean {
  return (
    direction === 'TB' &&
    !busy.has(bucket[0].hostId) &&
    (side === 'left' || side === 'right') &&
    bucket.length > 0 &&
    bucket.every((entry) => (entry.anchor.gap ?? 0) > 0 && !entry.anchor.side)
  );
}

/** Where each node of an outward row stands: its distance out from the host's border. */
function rowPushes(bucket: BucketEntry[]): number[] {
  let cursor = bucket[0].anchor.gap ?? 0;
  return bucket.map((entry) => {
    const width = entry.node.width ?? 0;
    const push = cursor + width / 2;
    cursor += width + ANCHOR_GAP;
    return push;
  });
}

/**
 * The room a row takes above its centre line, where the lines from its outer nodes hop over
 * the nearer ones (their captions are written below them, so the lines go over the top), and
 * below it.
 */
function rowHeights(bucket: BucketEntry[]): { above: number; below: number } {
  const tallest = Math.max(...bucket.map((entry) => (entry.node.height ?? 0) / 2));
  const hops = bucket.length - 1;
  return { above: tallest + (hops > 0 ? ROW_LEVEL_STEP * (hops + 1) : 0), below: tallest };
}

/** How far apart the lines that hop over a row run, and off the top of the row. */
const ROW_LEVEL_STEP = 12;

/**
 * How far to slide a run of stood-off nodes along a top or bottom border from the host's
 * middle, so that as many of them as can stand in front of the border do, each with a straight
 * line into it. The least slide that achieves it wins, so a run that fits stays centred.
 */
function abreastShift(
  bucket: BucketEntry[],
  offsets: number[],
  side: AnchorSide,
  hostAlongHalf: number | undefined
): number {
  const horizontal = side === 'top' || side === 'bottom';
  if (!horizontal || hostAlongHalf === undefined) {
    return 0;
  }
  // A lone node that leaves by its left or right face (a text annotation's bracket) stands
  // with that face over the host's border, a quarter in from its end, so its line is short
  // and straight.
  const lone = bucket.length === 1 ? bucket[0] : undefined;
  const face = lone ? attachFaceOf(lone.node) : undefined;
  if (lone && (lone.anchor.gap ?? 0) > 0 && (face === 'left' || face === 'right')) {
    const half = (lone.node.width ?? 0) / 2;
    const target = face === 'left' ? -hostAlongHalf / 2 + half : hostAlongHalf / 2 - half;
    return target - offsets[0];
  }
  if (bucket.length < 2 || !bucket.every((entry) => (entry.anchor.gap ?? 0) > 0)) {
    return 0;
  }
  // Kept a spacing in from either end, so a line from past that end can still enter beside them.
  const window = Math.max(0, hostAlongHalf - BORDER_INSET - ENTRY_SPACING);
  const abreast = (shift: number) =>
    offsets.filter((offset) => Math.abs(offset + shift) <= window + 1e-6).length;
  let best = 0;
  let bestCount = abreast(0);
  const candidates = offsets.flatMap((offset) => [-window - offset, window - offset]);
  for (const shift of candidates) {
    const count = abreast(shift);
    if (count > bestCount || (count === bestCount && Math.abs(shift) < Math.abs(best) - 1e-6)) {
      best = shift;
      bestCount = count;
    }
  }
  return best;
}

function footprintOf(
  bucket: BucketEntry[],
  side: AnchorSide,
  direction: Direction = 'TB',
  hostAlongHalf?: number,
  busy = new Set<string>()
): AnchorFootprint {
  if (laysOutward(bucket, side, direction, busy)) {
    const pushes = rowPushes(bucket);
    const last = bucket[bucket.length - 1].node;
    const { above, below } = rowHeights(bucket);
    return {
      before: above,
      after: below,
      beyond: pushes[pushes.length - 1] + (last.width ?? 0) / 2,
    };
  }
  const horizontal = side === 'top' || side === 'bottom';
  const alongBorder = (node: Node) => (horizontal ? (node.width ?? 0) : (node.height ?? 0));
  const reach = (node: Node) => (horizontal ? (node.height ?? 0) : (node.width ?? 0));
  const { offsets } = packAlongBorder(bucket.map((entry) => alongBorder(entry.node)));
  const shift = abreastShift(bucket, offsets, side, hostAlongHalf);
  let before = 0;
  let after = 0;
  let beyond = 0;
  bucket.forEach((entry, position) => {
    const clearance = entry.anchor.gap ?? 0;
    const half = alongBorder(entry.node) / 2;
    const centre = centreAlongBorder(offsets[position], horizontal, clearance, half) + shift;
    before = Math.max(before, half - centre);
    after = Math.max(after, centre + half);
    beyond = Math.max(beyond, clearance > 0 ? clearance + reach(entry.node) : 0);
  });
  return { before, after, beyond };
}

/**
 * The room each run of stood-off nodes needs, per host and per side the run stands on: a
 * node's own `side` when it has one, otherwise the side its direction defaults to.
 */
export function anchorFootprints(
  nodes: Node[],
  direction?: Direction,
  edges?: LayoutData['edges']
): Map<string, Partial<Record<AnchorSide, AnchorFootprint>>> {
  const busy = hostsWithFlowsAcrossPools(nodes, edges);
  const fallback = defaultAnchorSide('final', direction ?? 'TB');
  const footprints = new Map<string, Partial<Record<AnchorSide, AnchorFootprint>>>();
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const hostAlongHalfOf = (hostId: string, side: AnchorSide) => {
    const host = byId.get(hostId);
    const size = side === 'top' || side === 'bottom' ? host?.width : host?.height;
    return typeof size === 'number' && Number.isFinite(size) ? size / 2 : undefined;
  };
  for (const bucket of spreadAcrossBothSides(
    bucketByHostAndSide(
      nodes,
      (anchor) => attachedSide(anchor, direction ?? 'TB') ?? anchor.side ?? fallback
    ),
    direction ?? 'TB',
    busy
  ).values()) {
    if (bucket.length === 0) {
      continue;
    }
    if (!bucket.some((entry) => entry.anchor.gap)) {
      continue;
    }
    const { hostId, side } = bucket[0];
    footprints.set(hostId, {
      ...footprints.get(hostId),
      [side]: footprintOf(bucket, side, direction ?? 'TB', hostAlongHalfOf(hostId, side), busy),
    });
  }
  return footprints;
}

const boxOf = (node: Node) => ({
  left: (node.x ?? 0) - (node.width ?? 0) / 2,
  right: (node.x ?? 0) + (node.width ?? 0) / 2,
  top: (node.y ?? 0) - (node.height ?? 0) / 2,
  bottom: (node.y ?? 0) + (node.height ?? 0) / 2,
});

const sharesSpace = (a: ReturnType<typeof boxOf>, b: ReturnType<typeof boxOf>) =>
  a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;

const CLEARING_STEP = 8;
const CLEARING_TRIES = 24;

/** Whether a group is a lane or a pool, going by the `laneRole` its producer set. */
export const hasLaneRole = (group: Node): boolean => {
  const role = group.metadata?.laneRole;
  return role === 'lane' || role === 'pool';
};

/**
 * Moves a stood-off node clear of what it overlaps, never out of the lane its host sits in.
 *
 * `isLane` says which group is a lane. The default reads `metadata.laneRole`, so a producer
 * must set it on its lanes and pools or pass a resolver of its own; a group that is not
 * recognised as a lane does not hold the node in.
 */
export function clearAnchoredOverlaps(
  layout: LayoutData,
  pins: AnchorPin[],
  isLane: (group: Node) => boolean = hasLaneRole
): AnchorPin[] {
  const nodes = layout.nodes ?? [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const pinned = new Set(pins.map((pin) => pin.nodeId));
  const settled = nodes.filter((node) => !node.isGroup && !pinned.has(node.id));
  const placed: Node[] = [];
  const cleared: AnchorPin[] = [];

  const bandFor = (hostId: string) => {
    let at = byId.get(hostId);
    const seen = new Set<string>();
    while (at?.parentId && !seen.has(at.parentId)) {
      seen.add(at.parentId);
      const parent = byId.get(at.parentId);
      if (!parent) {
        return undefined;
      }
      if (isLane(parent)) {
        return boxOf(parent);
      }
      at = parent;
    }
    return undefined;
  };

  for (const pin of pins) {
    const node = byId.get(pin.nodeId);
    const standsOff = (readAnchor(node)?.gap ?? 0) > 0;
    if (!node || !standsOff) {
      if (node) {
        placed.push(node);
      }
      cleared.push(pin);
      continue;
    }

    const obstacles = [...settled, ...placed].filter((other) => other.id !== pin.hostId);
    const band = bandFor(pin.hostId);
    const startX = node.x ?? 0;
    const startY = node.y ?? 0;
    let tries = 0;
    while (
      tries < CLEARING_TRIES &&
      obstacles.some((other) => sharesSpace(boxOf(node), boxOf(other)))
    ) {
      node.x = (node.x ?? 0) + pin.outward.x * CLEARING_STEP;
      node.y = (node.y ?? 0) + pin.outward.y * CLEARING_STEP;
      tries++;
      const moved = boxOf(node);
      if (
        band &&
        (moved.left < band.left ||
          moved.right > band.right ||
          moved.top < band.top ||
          moved.bottom > band.bottom)
      ) {
        node.x = startX;
        node.y = startY;
        tries = 0;
        break;
      }
    }

    placed.push(node);
    cleared.push(tries > 0 ? { ...pin, x: node.x ?? pin.x, y: node.y ?? pin.y } : pin);
  }

  return cleared;
}

export function pinAnchoredNodes(
  layout: LayoutData,
  opts: { space: 'canonical' | 'final'; direction: Direction }
): AnchorPin[] {
  const allNodes = layout.nodes ?? [];
  const byId = new Map(allNodes.map((node) => [node.id, node]));
  const pins: AnchorPin[] = [];
  const placedOnBorder = placeAttachedByTheirFlows(layout, opts, byId, pins);
  const nodes = allNodes.filter((node) => !placedOnBorder.has(node.id));
  const buckets = bucketByHostAndSide(
    nodes,
    (anchor) =>
      attachedSide(anchor, opts.direction) ??
      (opts.space === 'canonical'
        ? defaultAnchorSide('canonical', opts.direction)
        : (anchor.side ?? defaultAnchorSide('final', opts.direction)))
  );

  const busy = hostsWithFlowsAcrossPools(allNodes, layout.edges);
  for (const bucket of spreadAcrossBothSides(buckets, opts.direction, busy).values()) {
    if (bucket.length === 0) {
      continue;
    }
    const { hostId, side } = bucket[0];
    const host = byId.get(hostId);
    const hx = host?.x;
    const hy = host?.y;
    const hw = host?.width;
    const hh = host?.height;
    if (
      typeof hx !== 'number' ||
      typeof hy !== 'number' ||
      typeof hw !== 'number' ||
      typeof hh !== 'number' ||
      !Number.isFinite(hx) ||
      !Number.isFinite(hy) ||
      !Number.isFinite(hw) ||
      !Number.isFinite(hh)
    ) {
      continue;
    }

    const horizontal = side === 'top' || side === 'bottom';
    const { offsets, total } = packAlongBorder(
      bucket.map((entry) => (horizontal ? entry.node.width : entry.node.height) ?? 0)
    );

    // A lone node's run is as wide as its drawn shape; its caption may reach past the corner.
    const drawnWidth = (bucket[0].node.metadata?.drawnExtent as { width?: unknown } | undefined)
      ?.width;
    const runExtent =
      bucket.length === 1 && typeof drawnWidth === 'number' && drawnWidth > 0 ? drawnWidth : total;
    if (laysOutward(bucket, side, opts.direction, busy)) {
      const pushes = rowPushes(bucket);
      bucket.forEach((entry, position) => {
        const x = hx + (side === 'right' ? hw / 2 + pushes[position] : -hw / 2 - pushes[position]);
        entry.node.x = x;
        entry.node.y = hy;
        pins.push({
          nodeId: entry.node.id,
          hostId,
          side,
          x,
          y: hy,
          outward: OUTWARD[side],
          row: position,
        });
      });
      continue;
    }
    const shift = abreastShift(bucket, offsets, side, (horizontal ? hw : hh) / 2);
    bucket.forEach((entry, position) => {
      const offset = offsets[position] + shift;
      const clearance = entry.anchor.gap ?? 0;
      const span = ((horizontal ? entry.node.height : entry.node.width) ?? 0) / 2;
      const push = clearance > 0 ? clearance + span : 0;
      const alongHalf = ((horizontal ? entry.node.width : entry.node.height) ?? 0) / 2;
      const along =
        centreAlongBorder(offset, horizontal, clearance, alongHalf) +
        towardsTheEnd(entry, side, opts.direction, horizontal ? hw : hh, runExtent);
      const x = horizontal ? hx + along : hx + (side === 'right' ? hw / 2 + push : -hw / 2 - push);
      const y = horizontal ? hy + (side === 'bottom' ? hh / 2 + push : -hh / 2 - push) : hy + along;
      entry.node.x = x;
      entry.node.y = y;
      pins.push({ nodeId: entry.node.id, hostId, side, x, y, outward: OUTWARD[side] });
    });
  }

  return pins;
}

/** The places chosen for attached nodes when first pinned, kept for the pin in drawn space. */
const chosenPlaces = new WeakMap<Node, AttachedPlacement>();

/** The side a place in the layout's own space becomes when drawn. */
function drawnSide(side: PlacementSide, direction: Direction): PlacementSide {
  if (direction !== 'LR') {
    return side;
  }
  const turned: Record<PlacementSide, PlacementSide> = {
    right: 'bottom',
    left: 'top',
    bottom: 'right',
    top: 'left',
  };
  return turned[side];
}

/**
 * Pins the nodes attached to a host's border with no stand-off and no side of their own (BPMN
 * boundary events) at the places their flows want (see `attachedPlacement.ts`), in TB and LR.
 * Returns the ids it pinned; the others are pinned by the runs below.
 */
function placeAttachedByTheirFlows(
  layout: LayoutData,
  opts: { space: 'canonical' | 'final'; direction: Direction },
  byId: Map<string, Node>,
  pins: AnchorPin[]
): Set<string> {
  const done = new Set<string>();
  if (opts.direction !== 'TB' && opts.direction !== 'LR') {
    return done;
  }
  const byHost = new Map<string, Node[]>();
  for (const node of layout.nodes ?? []) {
    const anchor = readAnchor(node);
    if (!anchor || anchor.gap || anchor.side || anchor.slot !== undefined || !hasUsableSize(node)) {
      continue;
    }
    const hostId = resolveAnchorHostId(node.id, byId);
    if (hostId) {
      byHost.set(hostId, [...(byHost.get(hostId) ?? []), node]);
    }
  }
  const layoutSides: PlacementSide[] =
    opts.direction === 'TB' ? ['bottom', 'top'] : ['right', 'left'];
  const fallback: AttachedPlacement =
    opts.direction === 'TB' ? { side: 'bottom', slot: 1 } : { side: 'right', slot: 0 };
  for (const [hostId, attached] of byHost) {
    const host = byId.get(hostId);
    if (!host || ![host.x, host.y, host.width, host.height].every(isFiniteNumber)) {
      continue;
    }
    if (opts.space === 'canonical' || attached.some((node) => !chosenPlaces.has(node))) {
      const sides =
        opts.space === 'canonical'
          ? layoutSides
          : layoutSides.map((side) => drawnSide(side, opts.direction));
      const fallbackHere =
        opts.space === 'canonical'
          ? fallback
          : { ...fallback, side: drawnSide(fallback.side, opts.direction) };
      const chosen = choosePlacements(host, attached, layout, sides, fallbackHere);
      if (!chosen) {
        continue;
      }
      for (const node of attached) {
        const place = chosen.get(node.id)!;
        // Kept as a place in the layout's own space.
        chosenPlaces.set(
          node,
          opts.space === 'canonical'
            ? place
            : { ...place, side: inLayoutSpace(place.side, opts.direction) }
        );
      }
    }
    for (const node of attached) {
      const kept = chosenPlaces.get(node)!;
      const place =
        opts.space === 'canonical' ? kept : { ...kept, side: drawnSide(kept.side, opts.direction) };
      const { x, y } = placedCentre(host, node, place);
      node.x = x;
      node.y = y;
      pins.push({ nodeId: node.id, hostId, side: place.side, x, y, outward: OUTWARD[place.side] });
      done.add(node.id);
    }
  }
  return done;
}

/** The side in the layout's own space that is drawn as `side`. */
function inLayoutSpace(side: PlacementSide, direction: Direction): PlacementSide {
  return (['top', 'right', 'bottom', 'left'] as PlacementSide[]).find(
    (candidate) => drawnSide(candidate, direction) === side
  )!;
}

const STUB_REACH = 16;

const BORDER_INSET = 8;

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

function attachFaceOf(node: Node | undefined): AnchorSide | undefined {
  const face = node?.metadata?.attachFace;
  return face === 'top' || face === 'bottom' || face === 'left' || face === 'right'
    ? face
    : undefined;
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const canRoute = (node: Node, host: Node) =>
  hasUsableSize(node) && [node.x, node.y, host.x, host.y].every(isFiniteNumber);

const pointAt = (alongX: boolean, along: number, across: number) =>
  alongX ? { x: along, y: across } : { x: across, y: along };

const sizeAlong = (node: Node, alongX: boolean) => (alongX ? node.width : node.height) ?? 0;

const leavesSideways = (face: AnchorSide | undefined, alongX: boolean) =>
  alongX ? face === 'left' || face === 'right' : face === 'top' || face === 'bottom';

function exitAlong(centre: number, half: number, face: AnchorSide | undefined, sideways: boolean) {
  if (!sideways) {
    return centre;
  }
  return centre + (face === 'left' || face === 'top' ? -(half + STUB_REACH) : half + STUB_REACH);
}

function stubToHost(node: Node, host: Node, pin: AnchorPin): { x: number; y: number }[] | null {
  if (!canRoute(node, host)) {
    return null;
  }
  const straight = straightFromFace(node, host, pin);
  if (straight) {
    return straight;
  }
  const alongX = pin.side === 'top' || pin.side === 'bottom';
  const [nAlong, nAcross] = alongX ? [node.x!, node.y!] : [node.y!, node.x!];
  const [hAlong, hAcross] = alongX ? [host.x!, host.y!] : [host.y!, host.x!];
  const reach = Math.max(0, sizeAlong(host, alongX) / 2 - BORDER_INSET);

  const face = attachFaceOf(node);
  const sideways = leavesSideways(face, alongX);
  const exit = exitAlong(nAlong, sizeAlong(node, alongX) / 2, face, sideways);
  const enter = clamp(exit, hAlong - reach, hAlong + reach);
  const mid = (nAcross + hAcross) / 2;

  const path = [pointAt(alongX, nAlong, nAcross)];
  if (sideways) {
    path.push(pointAt(alongX, exit, nAcross));
  }
  if (Math.abs(enter - exit) >= 1) {
    path.push(pointAt(alongX, exit, mid), pointAt(alongX, enter, mid));
  }
  path.push(pointAt(alongX, enter, hAcross));
  return path;
}

/**
 * The line from a node that leaves by a side face standing over its host's top or bottom
 * border: straight from the end of that face nearest the host into the border. Just inside
 * the face, so the line is not taken for one running along it.
 */
function straightFromFace(
  node: Node,
  host: Node,
  pin: AnchorPin
): { x: number; y: number }[] | undefined {
  const face = attachFaceOf(node);
  if ((pin.side !== 'top' && pin.side !== 'bottom') || (face !== 'left' && face !== 'right')) {
    return undefined;
  }
  const edge = node.x! + ((face === 'left' ? -1 : 1) * (node.width ?? 0)) / 2;
  const x = edge + (face === 'left' ? 1 : -1) * FACE_INSET;
  const hostHalf = (host.width ?? 0) / 2 - BORDER_INSET;
  if (Math.abs(x - host.x!) > hostHalf) {
    return undefined;
  }
  return [
    { x, y: node.y! },
    { x, y: host.y! },
  ];
}

/** How far inside its face a line leaves a node by straightFromFace. */
const FACE_INSET = 3;

/** Room between neighbouring entry points on a host's border (px). */
const ENTRY_SPACING = 12;

const sizeAcross = (node: Node, alongX: boolean) => {
  const drawn = node.metadata?.drawnExtent as { width?: unknown; height?: unknown } | undefined;
  const value = alongX ? drawn?.height : drawn?.width;
  return isFiniteNumber(value) && value > 0 ? value : sizeAlong(node, !alongX);
};

interface Stub {
  edge: NonNullable<LayoutData['edges']>[number];
  node: Node;
  host: Node;
  pin: AnchorPin;
}

/**
 * The lines from the nodes pinned beside one side of a host, laid out together so they
 * cannot cross. A node in front of the host's side goes straight in. Those beyond either
 * end of the side enter it at their own points, outermost first from that end, and turn
 * at their own depth, the outermost nearest the host: each line then runs outside the
 * ones within it, as nested L shapes do.
 */
function stubsBesideOneSide(
  stubs: Stub[],
  blocked: (
    a: { x: number; y: number },
    b: { x: number; y: number },
    ownId: string,
    leaving?: Node
  ) => boolean = () => false
): Map<Stub, { x: number; y: number }[]> {
  const paths = new Map<Stub, { x: number; y: number }[]>();
  const { host, pin } = stubs[0];
  const alongX = pin.side === 'top' || pin.side === 'bottom';
  const hAlong = alongX ? host.x! : host.y!;
  const hAcross = alongX ? host.y! : host.x!;
  const reach = Math.max(0, sizeAlong(host, alongX) / 2 - BORDER_INSET);
  const low = hAlong - reach;
  const high = hAlong + reach;
  const outward = pin.side === 'bottom' || pin.side === 'right' ? 1 : -1;
  const hostFace = hAcross + (outward * sizeAcross(host, alongX)) / 2;

  const placed = stubs.map((stub) => {
    const nAlong = alongX ? stub.node.x! : stub.node.y!;
    const nAcross = alongX ? stub.node.y! : stub.node.x!;
    const nodeFace = nAcross - (outward * sizeAcross(stub.node, alongX)) / 2;
    return { stub, nAlong, nAcross, nodeFace };
  });
  // Less than a unit off the side still reads as straight, landing on its end.
  const isAbreast = ({ nAlong }: (typeof placed)[number]) =>
    Math.abs(clamp(nAlong, low, high) - nAlong) < 1;
  const straight = placed.filter(isAbreast);
  const before = placed
    .filter((entry) => !isAbreast(entry) && entry.nAlong < low)
    .sort((a, b) => a.nAlong - b.nAlong);
  const after = placed
    .filter((entry) => !isAbreast(entry) && entry.nAlong > high)
    .sort((a, b) => b.nAlong - a.nAlong);

  for (const { stub, nAlong, nAcross } of straight) {
    paths.set(stub, [
      pointAt(alongX, nAlong, nAcross),
      pointAt(alongX, clamp(nAlong, low, high), hAcross),
    ]);
  }
  const firstStraight = Math.min(...straight.map(({ nAlong }) => nAlong), high);
  const lastStraight = Math.max(...straight.map(({ nAlong }) => nAlong), low);

  const nest = (run: typeof placed, start: number, room: number, step: 1 | -1) => {
    const spacing = run.length > 1 ? Math.min(ENTRY_SPACING, room / run.length) : 0;
    for (const [k, { stub, nAlong, nAcross, nodeFace }] of run.entries()) {
      const enter = start + step * k * spacing;
      // A line on its own turns halfway between the two centres; lines that share the run
      // turn at even steps across the gap between the two borders, so each keeps its own.
      const turn =
        run.length === 1
          ? (nAcross + hAcross) / 2
          : hostFace + ((k + 1) * (nodeFace - hostFace)) / (run.length + 1);
      paths.set(stub, [
        pointAt(alongX, nAlong, nAcross),
        pointAt(alongX, nAlong, turn),
        pointAt(alongX, enter, turn),
        pointAt(alongX, enter, hAcross),
      ]);
    }
  };
  // A node past an end of the side goes round the host's corner into the end face instead,
  // by one turn: out of the node towards that face, and across into it near the corner. The
  // node furthest out enters furthest from the corner, so the lines nest without crossing.
  // That is taken for the whole run past one end, and only where no line meets another
  // shape; otherwise the run enters the side itself, as above.
  const hostAcrossHalf = sizeAlong(host, !alongX) / 2;
  const intoEndFace = (run: typeof placed, endFace: number, step: 1 | -1) => {
    const room = Math.max(0, hostAcrossHalf - BORDER_INSET);
    const spacing = run.length > 1 ? Math.min(ENTRY_SPACING, room / run.length) : 0;
    const ways = run.map(({ stub, nAlong, nAcross }, k) => {
      const depth = run.length - 1 - k;
      const enterAcross = hostFace - outward * (BORDER_INSET + depth * spacing);
      return {
        stub,
        clear: (endFace - nAlong) * step > MIN_LEG,
        path: [
          pointAt(alongX, nAlong, nAcross),
          pointAt(alongX, nAlong, enterAcross),
          pointAt(alongX, hAlong, enterAcross),
        ],
      };
    });
    const sound = ways.every(
      ({ stub, clear, path }) =>
        clear &&
        path
          .slice(1)
          .every((b, i) => !blocked(path[i], b, stub.node.id, i === 0 ? stub.node : undefined))
    );
    if (!sound) {
      return false;
    }
    for (const { stub, path } of ways) {
      paths.set(stub, path);
    }
    return true;
  };
  const hostAlongHalf = sizeAlong(host, alongX) / 2;
  if (!intoEndFace(before, hAlong - hostAlongHalf, 1)) {
    nest(before, low, Math.max(0, firstStraight - low - ENTRY_SPACING), 1);
  }
  if (!intoEndFace(after, hAlong + hostAlongHalf, -1)) {
    nest(after, high, Math.max(0, high - lastStraight - ENTRY_SPACING), -1);
  }
  return paths;
}

/**
 * The lines from a row going out from a TB host's side: the nearest node's goes straight into
 * the side; each further one rises over the nodes nearer the host, one level higher the
 * further out it is, and comes down into the host's top face, one step further from the
 * corner. Each line is then an L with one more turn, and none crosses another.
 */
function stubsOfARow(stubs: Stub[]): Map<Stub, { x: number; y: number }[]> {
  const paths = new Map<Stub, { x: number; y: number }[]>();
  const sorted = [...stubs].sort((a, b) => (a.pin.row ?? 0) - (b.pin.row ?? 0));
  const { host, pin } = sorted[0];
  const outward = pin.side === 'right' ? 1 : -1;
  const hostFace = host.x! + (outward * (host.width ?? 0)) / 2;
  const hostTop = host.y! - (host.height ?? 0) / 2;
  let ceiling = hostTop;
  sorted.forEach((stub, i) => {
    const { node } = stub;
    const x = node.x!;
    const y = node.y!;
    if (i === 0) {
      paths.set(stub, [
        { x, y },
        { x: host.x!, y },
      ]);
    } else {
      const level = ceiling - ROW_LEVEL_STEP * i;
      const enter = hostFace - outward * (BORDER_INSET + (i - 1) * ENTRY_SPACING);
      // A node that leaves by a side face (a text annotation's bracket) rises from that face.
      const face = attachFaceOf(node);
      const half = (node.width ?? 0) / 2;
      const from =
        face === 'left' || face === 'right'
          ? { x: x + (face === 'left' ? -half + FACE_INSET : half - FACE_INSET), y }
          : { x, y };
      paths.set(stub, [
        from,
        { x: from.x, y: level },
        { x: enter, y: level },
        { x: enter, y: host.y! },
      ]);
    }
    ceiling = Math.min(ceiling, y - (node.height ?? 0) / 2);
  });
  return paths;
}

/** How far a line from a stood-off node keeps off other nodes' boxes. */
const LINE_CLEARANCE = 8;

/** The shortest leg a line into a host's end face runs past the face before it turns. */
const MIN_LEG = 12;

export function squareAnchoredEdges(layout: LayoutData, pins: AnchorPin[]): void {
  const byId = new Map((layout.nodes ?? []).map((node) => [node.id, node]));
  const pinById = new Map(pins.map((pin) => [pin.nodeId, pin]));
  const bySide = new Map<string, Stub[]>();
  const rows = new Map<string, Stub[]>();
  for (const edge of layout.edges ?? []) {
    const start = typeof edge.start === 'string' ? edge.start : undefined;
    const end = typeof edge.end === 'string' ? edge.end : undefined;
    if (!start || !end) {
      continue;
    }
    const pin = pinById.get(start) ?? pinById.get(end);
    if (!pin) {
      continue;
    }
    if ((pin.nodeId === start ? end : start) !== pin.hostId) {
      continue;
    }
    const node = byId.get(pin.nodeId);
    const host = byId.get(pin.hostId);
    if (!node || !host || !canRoute(node, host)) {
      continue;
    }
    if (pin.row !== undefined) {
      const key = `${pin.hostId}\u0000${pin.side}`;
      rows.set(key, [...(rows.get(key) ?? []), { edge, node, host, pin }]);
      continue;
    }
    const alongX = pin.side === 'top' || pin.side === 'bottom';
    // A node that leaves sideways (a text annotation's bracket) keeps its own stub.
    if (leavesSideways(attachFaceOf(node), alongX)) {
      const path = stubToHost(node, host, pin);
      if (path) {
        edge.points = pin.nodeId === start ? path : [...path].reverse();
      }
      continue;
    }
    const key = `${pin.hostId}\u0000${pin.side}`;
    bySide.set(key, [...(bySide.get(key) ?? []), { edge, node, host, pin }]);
  }
  // Whether a line from a stood-off node runs through another node: a shape or its caption.
  // The node's own box does not count, nor does the host's, which the line ends on.
  const others = (layout.nodes ?? []).filter((node) => !node.isGroup && hasUsableSize(node));
  const blocked = (
    a: { x: number; y: number },
    b: { x: number; y: number },
    ownId: string
  ): boolean =>
    others.some((other) => {
      if (other.id === ownId || pinById.get(ownId)?.hostId === other.id) {
        return false;
      }
      const r = boxOf(other);
      return (
        Math.max(a.x, b.x) > r.left - LINE_CLEARANCE &&
        Math.min(a.x, b.x) < r.right + LINE_CLEARANCE &&
        Math.max(a.y, b.y) > r.top - LINE_CLEARANCE &&
        Math.min(a.y, b.y) < r.bottom + LINE_CLEARANCE
      );
    });
  for (const stubs of rows.values()) {
    for (const [stub, path] of stubsOfARow(stubs)) {
      stub.edge.points = stub.pin.nodeId === stub.edge.start ? path : [...path].reverse();
    }
  }
  for (const stubs of bySide.values()) {
    for (const [stub, path] of stubsBesideOneSide(stubs, blocked)) {
      stub.edge.points = stub.pin.nodeId === stub.edge.start ? path : [...path].reverse();
    }
  }
}
