import type { LayoutData } from '../../../types.js';
import { buildLaneModel } from '../lanes.js';

type LayoutNode = NonNullable<LayoutData['nodes']>[number] & { swimlaneContentTop?: number };

interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** The band a title takes when no pool shows how wide one is drawn: across for LR, down for TB. */
const DEFAULT_BAND = { x: 32, y: 24 };

const rectOf = (node: LayoutNode): Rect | undefined => {
  const { x, y, width, height } = node;
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !(width > 0) ||
    !(height > 0)
  ) {
    return undefined;
  }
  return { left: x - width / 2, right: x + width / 2, top: y - height / 2, bottom: y + height / 2 };
};

const setRect = (node: LayoutNode, rect: Rect): void => {
  node.x = (rect.left + rect.right) / 2;
  node.y = (rect.top + rect.bottom) / 2;
  node.width = rect.right - rect.left;
  node.height = rect.bottom - rect.top;
};

/**
 * Frames each lane that holds lanes (`laneModel.isLaneSet`) round the lanes in it, with its own
 * title band beside theirs: left of them when titles run down the left (LR), above them when
 * titles run along the top (TB). Run once every route is final: nothing moves but the bands.
 *
 * Every lane's title band moves out by one band for each level of lanes it is not nested in,
 * so the bands of a lane set and of the lanes in it sit side by side and the lane bodies keep
 * the place the layout gave them; the pools grow by as much on their title side.
 */
export function frameLaneSets(layout: LayoutData, direction?: string): void {
  const nodes = (layout.nodes ?? []) as LayoutNode[];
  const model = buildLaneModel(nodes);
  if (model.laneSets.length === 0) {
    return;
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const leaves = nodes.filter((node) => model.isLane(node.id) && rectOf(node));
  const deepest = Math.max(0, ...leaves.map((lane) => model.laneDepth(lane.id)));
  if (deepest === 0 || leaves.length === 0) {
    return;
  }

  // Titles run across the flow: down the left edge in LR, along the top edge in TB. In RL and
  // BT they sit on the far edge, which the lanes' own title rectangles tell.
  const across = direction === 'LR' || direction === 'RL' ? 'x' : 'y';
  const [low, high] = across === 'x' ? (['left', 'right'] as const) : (['top', 'bottom'] as const);
  const sample = leaves.find((lane) => lane.groupTitleRect);
  const sampleRect = sample ? rectOf(sample) : undefined;
  const titleAtLow =
    !sample?.groupTitleRect ||
    !sampleRect ||
    Math.abs(sample.groupTitleRect[low] - sampleRect[low]) <=
      Math.abs(sample.groupTitleRect[high] - sampleRect[high]);
  const outward = titleAtLow ? -1 : 1;
  const titleSide = titleAtLow ? low : high;

  const pools = [...model.lanesByPool.keys()]
    .map((id) => byId.get(id))
    .filter((pool): pool is LayoutNode => pool !== undefined && rectOf(pool) !== undefined);
  const measuredBand = pools
    .map((pool) => {
      const lanes = (model.lanesByPool.get(pool.id) ?? [])
        .map((id) => byId.get(id))
        .map((lane) => (lane ? rectOf(lane) : undefined))
        .filter((rect): rect is Rect => rect !== undefined);
      const edge = titleAtLow
        ? Math.min(...lanes.map((rect) => rect[low]))
        : Math.max(...lanes.map((rect) => rect[high]));
      return Math.abs(edge - rectOf(pool)![titleSide]);
    })
    .find((band) => band > 0);
  const band = measuredBand ?? DEFAULT_BAND[across];

  // Where each lane's title edge was, before any moves.
  const titleEdge = new Map(leaves.map((lane) => [lane.id, rectOf(lane)![titleSide]]));

  const moveTitleEdge = (node: LayoutNode, by: number): void => {
    const rect = rectOf(node);
    if (!rect || by === 0) {
      return;
    }
    rect[titleSide] += outward * by;
    setRect(node, rect);
    if (node.groupTitleRect) {
      node.groupTitleRect = {
        ...node.groupTitleRect,
        [low]: node.groupTitleRect[low] + outward * by,
        [high]: node.groupTitleRect[high] + outward * by,
      };
    }
  };

  for (const lane of leaves) {
    moveTitleEdge(lane, (deepest - model.laneDepth(lane.id)) * band);
  }

  const leavesUnder = (setId: string): LayoutNode[] =>
    leaves.filter((lane) => {
      const seen = new Set<string>();
      for (let id = lane.parentId; id && !seen.has(id); id = byId.get(id)?.parentId) {
        if (id === setId) {
          return true;
        }
        seen.add(id);
      }
      return false;
    });

  for (const setId of model.laneSets) {
    const set = byId.get(setId);
    const inside = leavesUnder(setId);
    if (!set || inside.length === 0) {
      continue;
    }
    const rects = inside.map((lane) => rectOf(lane)!);
    const edges = inside.map((lane) => titleEdge.get(lane.id)!);
    const shift = (deepest - model.laneDepth(setId)) * band;
    const rect: Rect = {
      left: Math.min(...rects.map((r) => r.left)),
      right: Math.max(...rects.map((r) => r.right)),
      top: Math.min(...rects.map((r) => r.top)),
      bottom: Math.max(...rects.map((r) => r.bottom)),
    };
    rect[titleSide] = titleAtLow ? Math.min(...edges) - shift : Math.max(...edges) + shift;
    setRect(set, rect);
    const title: Rect = { ...rect };
    title[titleAtLow ? high : low] = rect[titleSide] - outward * band;
    set.groupTitleRect = title;
    set.swimlaneContentTop = across === 'y' && titleAtLow ? rect.top + band : rect.top;
  }

  for (const pool of pools) {
    moveTitleEdge(pool, deepest * band);
    if (across === 'y' && titleAtLow && typeof pool.swimlaneContentTop === 'number') {
      pool.swimlaneContentTop -= deepest * band;
    }
  }
}
