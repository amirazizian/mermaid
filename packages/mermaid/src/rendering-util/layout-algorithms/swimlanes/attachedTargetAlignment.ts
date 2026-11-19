/**
 * Lines up the far end of a flow out of a node attached to its host's border (a boundary event)
 * so that the flow can reach it with one bend.
 *
 * A node on a border across the flow (in LR, the borders drawn at the top and the bottom) sends
 * its flows out across the flow: out of its outer vertex, then along the flow into its target's
 * near face. That takes one bend only when the target lies far enough out for the line to leave
 * the vertex and turn: a target just short of that gets a hook (out, along, back, and in). Such
 * a target, when it has no other flows and there is room, is moved out until the bend fits.
 *
 * Runs in the layout's own space, after the attached nodes are pinned and before the edges are
 * routed, where the flow runs down the y axis and across the x axis.
 */
import type { LayoutData, Node } from '../../types.js';
import { readAnchor } from './anchoredNodes.js';

type Direction = 'TB' | 'BT' | 'LR' | 'RL';

/** How far out of the vertex the line runs before it turns, at least. */
export const ONE_BEND_DROP = 24;
/** How far past a row of captions beside the border the line turns. */
const ROW_CLEARANCE = 12;
/** How far a target is moved at most. */
const MAX_SHIFT = 48;
/** How near a flat face's corner a line may still enter it. */
const CORNER_CLEARANCE = 24;
/** Room kept between the moved target and any other node. */
const CLEARANCE = 16;

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/**
 * The node's extent across the flow and along it in the layout's own space. In LR the layout is
 * drawn turned, so a node's drawn height lies across the flow there.
 */
function halves(node: Node, direction: Direction): { across: number; along: number } {
  const turned = direction === 'LR' || direction === 'RL';
  const w = num(node.width) / 2;
  const h = num(node.height) / 2;
  return turned ? { across: h, along: w } : { across: w, along: h };
}

function drawnHalfAcross(node: Node, direction: Direction): number {
  const drawn = node.metadata?.drawnExtent as { width?: unknown; height?: unknown } | undefined;
  const turned = direction === 'LR' || direction === 'RL';
  const value = turned ? drawn?.height : drawn?.width;
  return typeof value === 'number' && value > 0 ? value / 2 : halves(node, direction).across;
}

const boxOf = (node: Node, direction: Direction, dx = 0): Box => {
  const { across, along } = halves(node, direction);
  return {
    left: num(node.x) + dx - across,
    right: num(node.x) + dx + across,
    top: num(node.y) - along,
    bottom: num(node.y) + along,
  };
};

const overlaps = (a: Box, b: Box, gap: number) =>
  a.left < b.right + gap &&
  a.right > b.left - gap &&
  a.top < b.bottom + gap &&
  a.bottom > b.top - gap;

const isFlat = (node: Node) => node.metadata?.endpointProfile === 'flat';

export function alignTargetsOfAttachedFlows(layout: LayoutData, direction: Direction): void {
  const nodes = layout.nodes ?? [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges = (layout.edges ?? []).filter(
    (edge) => !(edge as { isLayoutOnly?: boolean }).isLayoutOnly
  );
  const degree = new Map<string, number>();
  for (const edge of edges) {
    for (const id of [String(edge.start), String(edge.end)]) {
      degree.set(id, (degree.get(id) ?? 0) + 1);
    }
  }

  for (const node of nodes) {
    const anchor = readAnchor(node);
    const host = anchor && !anchor.gap ? byId.get(anchor.hostId) : undefined;
    if (!host || host.isGroup || typeof node.x !== 'number' || typeof host.x !== 'number') {
      continue;
    }
    // Only a node on a border across the flow: its centre on the host's left or right border.
    const hostHalf = num(host.width) / 2;
    const outward =
      Math.abs(node.x - (host.x + hostHalf)) < 1
        ? 1
        : Math.abs(node.x - (host.x - hostHalf)) < 1
          ? -1
          : 0;
    if (outward === 0) {
      continue;
    }
    // Its outer vertex as drawn: the host's drawn border plus the node's drawn half.
    const vertex =
      host.x + outward * (halves(host, direction).across + drawnHalfAcross(node, direction));
    // Nodes attached along one border write their captions in one row beside it. With another
    // such node further along the flow, a line along that row would run through its caption:
    // the line then turns past the row.
    const rowAhead = nodes.some(
      (other) =>
        other !== node &&
        readAnchor(other)?.hostId === host.id &&
        typeof other.x === 'number' &&
        typeof other.y === 'number' &&
        Math.abs(other.x - num(node.x)) < 1 &&
        other.y > num(node.y)
    );
    const drop = rowAhead
      ? Math.max(
          ONE_BEND_DROP,
          halves(node, direction).across - drawnHalfAcross(node, direction) + ROW_CLEARANCE
        )
      : ONE_BEND_DROP;
    for (const edge of edges) {
      if (String(edge.start) !== node.id) {
        continue;
      }
      const target = byId.get(String(edge.end));
      if (
        !target ||
        target.isGroup ||
        target.isEdgeLabel ||
        readAnchor(target) ||
        degree.get(target.id) !== 1 ||
        typeof target.x !== 'number' ||
        typeof target.y !== 'number'
      ) {
        continue;
      }
      // Ahead along the flow, past the host, and out on this node's side of it.
      const hostBox = boxOf(host, direction);
      const targetBox = boxOf(target, direction);
      if (targetBox.top <= hostBox.bottom || (target.x - host.x) * outward <= 0) {
        continue;
      }
      // Where the line can enter the target furthest out: its centre, or along a flat face.
      const reach = isFlat(target)
        ? Math.max(0, halves(target, direction).across - CORNER_CLEARANCE)
        : 0;
      const entry = target.x + outward * reach;
      const short = drop - (entry - vertex) * outward;
      if (short <= 0 || short > MAX_SHIFT) {
        continue;
      }
      const dx = outward * short;
      const moved = boxOf(target, direction, dx);
      // Clear of every other node; and of the whole band of a node in another lane or group, so
      // that the target does not reach into it when the lanes are fitted round their nodes.
      const blocked = nodes.some((other) => {
        if (other === target || other.isGroup || typeof other.x !== 'number' || readAnchor(other)) {
          return false;
        }
        const box = boxOf(other, direction);
        const band =
          other.parentId === target.parentId
            ? box
            : { ...box, top: Number.NEGATIVE_INFINITY, bottom: Number.POSITIVE_INFINITY };
        return overlaps(moved, band, CLEARANCE);
      });
      if (!blocked) {
        target.x += dx;
      }
    }
  }
}
