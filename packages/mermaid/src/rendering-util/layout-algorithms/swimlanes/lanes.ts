import type { Node } from '../../types.js';

export type LaneRole = 'pool' | 'lane';

export function readLaneRole(node: Node | undefined): LaneRole | undefined {
  const role = node?.metadata?.laneRole;
  return role === 'pool' || role === 'lane' ? role : undefined;
}

export function readLaneIndex(node: Node | undefined): number | undefined {
  const index = node?.metadata?.laneIndex;
  return typeof index === 'number' && Number.isFinite(index) ? index : undefined;
}

export interface LaneModel {
  isPool: (id: string) => boolean;
  isLane: (id: string) => boolean;

  laneIdOf: (id: string) => string | null;

  poolIdOf: (id: string) => string | null;

  lanesByPool: Map<string, string[]>;
  hasPools: boolean;

  /** Whether a group is a lane that holds lanes: a frame round them, not a lane itself. */
  isLaneSet: (id: string) => boolean;
  /** How many lanes that hold lanes a lane or lane set sits in: 0 for one straight in a pool. */
  laneDepth: (id: string) => number;
  /** The lanes that hold lanes, outermost first. */
  laneSets: string[];
}

export function buildLaneModel(nodes: Node[]): LaneModel {
  const byId = new Map<string, Node>();
  const groupChildCount = new Map<string, number>();
  for (const node of nodes) {
    byId.set(node.id, node);
    if (node.isGroup && node.parentId) {
      groupChildCount.set(node.parentId, (groupChildCount.get(node.parentId) ?? 0) + 1);
    }
  }

  const pools = new Set<string>();
  for (const node of nodes) {
    if (node.isGroup && readLaneRole(node) === 'pool' && (groupChildCount.get(node.id) ?? 0) > 0) {
      pools.add(node.id);
    }
  }

  // A lane written under a lane makes its parent a set of lanes: only the lanes with no lane
  // under them hold content, and the lanes round them are framed about them afterwards.
  const laneSets = new Set<string>();
  for (const node of nodes) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (
      node.isGroup &&
      readLaneRole(node) === 'lane' &&
      parent?.isGroup &&
      readLaneRole(parent) === 'lane'
    ) {
      laneSets.add(parent.id);
    }
  }
  const holdsLanes = (id: string | undefined) =>
    id !== undefined && (pools.has(id) || laneSets.has(id));

  const lanes = new Set<string>();
  const lanesByPool = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.isGroup || pools.has(node.id) || laneSets.has(node.id)) {
      continue;
    }
    if (node.parentId && holdsLanes(node.parentId)) {
      lanes.add(node.id);
      let poolId: string | undefined = node.parentId;
      const seen = new Set<string>();
      while (poolId && laneSets.has(poolId) && !seen.has(poolId)) {
        seen.add(poolId);
        poolId = byId.get(poolId)?.parentId;
      }
      if (poolId && pools.has(poolId)) {
        const siblings = lanesByPool.get(poolId) ?? [];
        siblings.push(node.id);
        lanesByPool.set(poolId, siblings);
      }
    } else if (!node.parentId) {
      lanes.add(node.id);
    }
  }

  const laneDepth = (id: string): number => {
    let depth = 0;
    const seen = new Set<string>([id]);
    let current = byId.get(id)?.parentId;
    while (current && laneSets.has(current) && !seen.has(current)) {
      seen.add(current);
      depth++;
      current = byId.get(current)?.parentId;
    }
    return depth;
  };

  const walk = (id: string, stopAt: Set<string>): string | null => {
    const seen = new Set<string>([id]);
    let current = byId.get(id)?.parentId;
    while (current && !seen.has(current)) {
      if (stopAt.has(current)) {
        return current;
      }
      seen.add(current);
      current = byId.get(current)?.parentId;
    }
    return null;
  };

  const laneCache = new Map<string, string | null>();
  const laneIdOf = (id: string): string | null => {
    const cached = laneCache.get(id);
    if (cached !== undefined) {
      return cached;
    }
    const lane = walk(id, lanes);
    laneCache.set(id, lane);
    return lane;
  };

  return {
    isPool: (id) => pools.has(id),
    isLane: (id) => lanes.has(id),
    laneIdOf,
    poolIdOf: (id) => (pools.has(id) ? id : walk(id, pools)),
    lanesByPool,
    hasPools: pools.size > 0,
    isLaneSet: (id) => laneSets.has(id),
    laneDepth,
    laneSets: [...laneSets].sort((a, b) => laneDepth(a) - laneDepth(b)),
  };
}

/** For callers that hold things in a lane: whether a group is a lane, as `buildLaneModel` decides it. */
export function isLaneIn(nodes: Node[]): (group: Node) => boolean {
  const model = buildLaneModel(nodes);
  return (group) => model.isLane(group.id);
}
