import type { LayoutData } from '../../../types.js';
import { assignTopLaneTitleRect } from '../helpers.js';
import { buildLaneModel, type LaneModel } from '../lanes.js';

type LayoutNode = NonNullable<LayoutData['nodes']>[number] & { swimlaneContentTop?: number };

/** The title band an empty column keeps room for, as an empty row does in LR. */
const TITLE_BAND = 36;
/** The band a pool's own title takes above its lanes, as `framePoolsTb` draws it. */
const POOL_TITLE_BAND = 24;

const isPlaced = (lane: LayoutNode): boolean =>
  typeof lane.width === 'number' && lane.width > 0 && typeof lane.x === 'number';

const leftOf = (node: LayoutNode) => (node.x ?? 0) - (node.width ?? 0) / 2;
const rightOf = (node: LayoutNode) => (node.x ?? 0) + (node.width ?? 0) / 2;
const topOf = (node: LayoutNode) => (node.y ?? 0) - (node.height ?? 0) / 2;
const bottomOf = (node: LayoutNode) => (node.y ?? 0) + (node.height ?? 0) / 2;

/** Room an empty column needs across: two title bands, its padding, or the run of its title. */
function emptyColumnWidth(lane: LayoutNode, fontSize: number): number {
  const titleRun = (typeof lane.label === 'string' ? lane.label.length : 0) * fontSize * 0.55;
  return Math.max(2 * TITLE_BAND, 2 * (lane.padding ?? 0), titleRun + TITLE_BAND);
}

const fontSizeOf = (layout: LayoutData): number =>
  Number.parseFloat(String(layout.config?.fontSize ?? 16)) || 16;

/** Puts an empty lane in the column `left`..`left + width`, `top`..`bottom` down the page. */
function placeColumn(
  lane: LayoutNode,
  left: number,
  width: number,
  top: number,
  bottom: number
): void {
  lane.x = left + width / 2;
  lane.width = width;
  lane.y = (top + bottom) / 2;
  lane.height = bottom - top;
  lane.swimlaneContentTop = Math.min(bottom, top + TITLE_BAND);
  assignTopLaneTitleRect(lane);
}

/**
 * Moves everything at or right of `line` right by `by`: lanes that start there, every other
 * node whose centre is right of it, and every edge point right of it. Pools are framed later.
 */
function openColumnAt(layout: LayoutData, laneModel: LaneModel, line: number, by: number): void {
  const BOUNDARY_TOLERANCE = 0.5;
  for (const node of (layout.nodes ?? []) as LayoutNode[]) {
    if (laneModel.isPool(node.id) || typeof node.x !== 'number') {
      continue;
    }
    const reference = laneModel.isLane(node.id) ? leftOf(node) : node.x;
    if (reference < line - BOUNDARY_TOLERANCE) {
      continue;
    }
    node.x += by;
    if (node.groupTitleRect) {
      node.groupTitleRect.left += by;
      node.groupTitleRect.right += by;
    }
  }
  for (const edge of layout.edges ?? []) {
    for (const point of edge.points ?? []) {
      if (point.x >= line) {
        point.x += by;
      }
    }
  }
}

/**
 * Gives each empty lane of a pool its own column inside that pool, in the order the lanes were
 * declared: after the nearest populated lane declared before it, or before the nearest one
 * after it, opening a column there. Run before the pools are framed, so the frame takes it in.
 * A lane whose pool has no populated lane is left for {@link stackEmptyLanesTb}.
 */
export function openEmptyLaneColumnsInPools(layout: LayoutData): void {
  const nodes = (layout.nodes ?? []) as LayoutNode[];
  const laneModel = buildLaneModel(nodes);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const fontSize = fontSizeOf(layout);
  for (const laneIds of laneModel.lanesByPool.values()) {
    const lanes = laneIds
      .map((id) => byId.get(id))
      .filter((lane): lane is LayoutNode => lane !== undefined);
    const placed = new Set(lanes.filter(isPlaced));
    lanes.forEach((lane, index) => {
      if (placed.has(lane)) {
        return;
      }
      const before = lanes.slice(0, index).findLast((other) => placed.has(other));
      const after = lanes.slice(index + 1).find((other) => placed.has(other));
      const sibling = before ?? after;
      if (!sibling) {
        return;
      }
      const line = before ? rightOf(before) : leftOf(after!);
      const width = emptyColumnWidth(lane, fontSize);
      openColumnAt(layout, laneModel, line, width);
      placeColumn(lane, line, width, topOf(sibling), bottomOf(sibling));
      placed.add(lane);
    });
  }
}

/**
 * Gives every lane still empty its own column right of everything else, as tall as the
 * participants beside it: a black-box pool, or a pool whose lanes are all empty, which then
 * gets its title band above them. Run after the pools are framed.
 */
export function stackEmptyLanesTb(layout: LayoutData): void {
  const nodes = (layout.nodes ?? []) as LayoutNode[];
  const laneModel = buildLaneModel(nodes);
  const empty = nodes.filter((node) => laneModel.isLane(node.id) && !isPlaced(node));
  if (empty.length === 0) {
    return;
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const fontSize = fontSizeOf(layout);
  // The participants already standing side by side: the pools and the lanes in no pool.
  const columns = nodes.filter(
    (node) =>
      (laneModel.isPool(node.id) ||
        (laneModel.isLane(node.id) && laneModel.poolIdOf(node.id) === null)) &&
      !empty.includes(node) &&
      isPlaced(node)
  );
  // Right of the populated columns and of anything pinned beside them, such as a note.
  const besides = nodes.filter((node) => !node.isGroup && typeof node.x === 'number');
  const rights = [...columns, ...besides].map(rightOf).filter(Number.isFinite);
  let right = rights.length > 0 ? Math.max(...rights) : 0;
  const top = columns.length > 0 ? Math.min(...columns.map(topOf)) : 0;
  const bottom = columns.length > 0 ? Math.max(...columns.map(bottomOf)) : top + 4 * TITLE_BAND;

  const done = new Set<LayoutNode>();
  for (const lane of empty) {
    if (done.has(lane)) {
      continue;
    }
    const pool = lane.parentId ? byId.get(lane.parentId) : undefined;
    if (!pool || !laneModel.isPool(pool.id)) {
      const width = emptyColumnWidth(lane, fontSize);
      placeColumn(lane, right, width, top, bottom);
      right += width;
      done.add(lane);
      continue;
    }
    // A pool none of whose lanes holds anything: its lanes side by side under its title.
    const left = right;
    for (const id of laneModel.lanesByPool.get(pool.id) ?? []) {
      const member = byId.get(id);
      if (!member || done.has(member)) {
        continue;
      }
      const width = emptyColumnWidth(member, fontSize);
      placeColumn(member, right, width, top + POOL_TITLE_BAND, bottom);
      right += width;
      done.add(member);
    }
    pool.x = (left + right) / 2;
    pool.width = right - left;
    pool.y = (top + bottom) / 2;
    pool.height = bottom - top;
    pool.swimlaneContentTop = top + POOL_TITLE_BAND;
    pool.groupTitleRect = { left, right, top, bottom: top + POOL_TITLE_BAND };
  }
}
