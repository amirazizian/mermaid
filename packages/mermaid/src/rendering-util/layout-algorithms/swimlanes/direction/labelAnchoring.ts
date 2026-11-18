// cspell:ignore Helmers Wybrow
import type { Edge, Node } from '../../../types.js';
import {
  dedupeConsecutivePoints,
  inflateRect,
  rectContainsRect,
  rectFromCenterSize,
  rectOfNodeBounds,
  rectsOverlap,
  segmentBoundsOverlapRect,
} from './geometry.js';
import type { RectBounds } from './geometry.js';
import { buildLaneModel } from '../lanes.js';

const EPS = 1e-3;
const MARKER_CLEARANCE_LENGTH = 10;
const MARKER_CLEARANCE_HALF_WIDTH = 7;

function markerClearanceRectFor(
  pts: { x: number; y: number }[],
  atStart: boolean
): RectBounds | undefined {
  const terminalIndex = atStart ? 0 : pts.length - 1;
  const step = atStart ? 1 : -1;
  const tip = pts[terminalIndex];
  const inner = pts[terminalIndex + step];
  if (!tip || !inner) {
    return undefined;
  }

  const dx = inner.x - tip.x;
  const dy = inner.y - tip.y;
  const len = Math.abs(dx) + Math.abs(dy);
  if (len < EPS) {
    return undefined;
  }

  if (Math.abs(dy) <= EPS) {
    const x2 = tip.x + Math.sign(dx) * MARKER_CLEARANCE_LENGTH;
    return {
      left: Math.min(tip.x, x2),
      right: Math.max(tip.x, x2),
      top: tip.y - MARKER_CLEARANCE_HALF_WIDTH,
      bottom: tip.y + MARKER_CLEARANCE_HALF_WIDTH,
    };
  }

  if (Math.abs(dx) <= EPS) {
    const y2 = tip.y + Math.sign(dy) * MARKER_CLEARANCE_LENGTH;
    return {
      left: tip.x - MARKER_CLEARANCE_HALF_WIDTH,
      right: tip.x + MARKER_CLEARANCE_HALF_WIDTH,
      top: Math.min(tip.y, y2),
      bottom: Math.max(tip.y, y2),
    };
  }

  return {
    left: Math.min(tip.x, inner.x),
    right: Math.max(tip.x, inner.x),
    top: Math.min(tip.y, inner.y),
    bottom: Math.max(tip.y, inner.y),
  };
}

function normalizeRect(rect: RectBounds): RectBounds {
  return {
    left: Math.min(rect.left, rect.right),
    right: Math.max(rect.left, rect.right),
    top: Math.min(rect.top, rect.bottom),
    bottom: Math.max(rect.top, rect.bottom),
  };
}

function labelOverlapsOwnMarker(rect: RectBounds, pts: { x: number; y: number }[]): boolean {
  const visiblePts = dedupeConsecutivePoints(pts);
  const startMarker = markerClearanceRectFor(visiblePts, true);
  const endMarker = markerClearanceRectFor(visiblePts, false);
  return [startMarker, endMarker].some(
    (marker) => marker && rectsOverlap(rect, normalizeRect(marker))
  );
}

/** How far a label keeps from a bend of its own line, and from a lane border. */
const CORNER_ROOM = 4;
const LANE_ROOM = 3;
/** How far past its source's end clearance a branch label sits. */
const BRANCH_LABEL_GAP = 4;
/** How finely, and at most how many places, the search tries along one stretch of a line. */
const SEARCH_STEP = 4;
const MAX_STEPS = 40;
/** What a label set across a stretch of line, rather than along it, costs, in px of distance. */
const ACROSS_PENALTY = 16;

/** The points where a polyline turns. */
export function bendsOf(pts: { x: number; y: number }[]): { x: number; y: number }[] {
  const visible = dedupeConsecutivePoints(pts);
  const bends: { x: number; y: number }[] = [];
  for (let i = 1; i < visible.length - 1; i++) {
    const before = visible[i - 1];
    const at = visible[i];
    const after = visible[i + 1];
    const cross = (at.x - before.x) * (after.y - at.y) - (at.y - before.y) * (after.x - at.x);
    if (Math.abs(cross) > EPS) {
      bends.push(at);
    }
  }
  return bends;
}

/** Whether `rect` reaches over a border of `lane`: it overlaps the lane without being inside. */
export function crossesBorder(lane: RectBounds, rect: RectBounds): boolean {
  return rectsOverlap(lane, rect) && !rectContainsRect(lane, rect);
}

export function anchorLabelsToPolyline(edges: Edge[], nodeByIdMap: Map<string, Node>): void {
  // Build a set of foreign polylines once for overlap checks. Labelled
  // originals that haven't been anchored yet are still included — their
  // polylines exist, even if their labels haven't moved.
  type RectLite = RectBounds;
  interface SegmentLite {
    edgeId: string;
    p1: { x: number; y: number };
    p2: { x: number; y: number };
  }
  const allEdgeSegments: SegmentLite[] = [];
  for (const other of edges) {
    if (other.isLayoutOnly) {
      continue;
    }
    const pts = other.points;
    if (!pts || pts.length < 2) {
      continue;
    }
    for (let i = 0; i < pts.length - 1; i++) {
      allEdgeSegments.push({ edgeId: other.id, p1: pts[i], p2: pts[i + 1] });
    }
  }

  const foreignNodeRects: { nodeId: string; rect: RectLite }[] = [];
  // Collect top-level lane groups so we can re-assign a label's parentId to
  // whichever lane geometrically contains its anchored position. Without
  // this, labels whose anchor crosses a lane boundary are reported as
  // node-overlap violations against sibling lane groups.
  const laneGroups: { id: string; rect: RectLite }[] = [];
  const laneModel = buildLaneModel([...nodeByIdMap.values()]);
  for (const n of nodeByIdMap.values()) {
    const isGroup = n.isGroup;
    if (laneModel.isLane(n.id)) {
      const rect = rectOfNodeBounds(n);
      if (rect) {
        laneGroups.push({
          id: n.id,
          rect,
        });
      }
      continue;
    }
    if (isGroup) {
      continue;
    }
    if (n.isEdgeLabel) {
      continue;
    }
    const rect = rectOfNodeBounds(n);
    if (!rect) {
      continue;
    }
    foreignNodeRects.push({
      nodeId: n.id,
      rect,
    });
  }

  // Inflation margin for foreign-edge / foreign-node proximity. The layout
  // validator's `edge-border-hugging` check fires when a polyline runs
  // within ~2u of a label's visual border (EPS_BORDER). Inflate the label
  // rect we test by a little more than that when rejecting candidates, so
  // no chosen placement will trigger the hug check. 3u preserves the buffer
  // used by the old pre-label detour pass.
  const LABEL_PLACEMENT_BUFFER = 3;
  const LABEL_LANE_MARGIN = 1;
  // Mermaid's point marker occupies roughly 10u at the edge endpoint; keep
  // labels a little farther away so the arrowhead remains visually readable.
  const LABEL_ENDPOINT_CLEARANCE = 12;

  const labelOverlapsForeignNode = (labelId: string, rect: RectLite): boolean => {
    const buffered = inflateRect(rect, LABEL_PLACEMENT_BUFFER);
    for (const { nodeId, rect: nr } of foreignNodeRects) {
      if (nodeId === labelId) {
        continue;
      }
      if (rectsOverlap(buffered, nr)) {
        return true;
      }
    }
    return false;
  };

  const labelOverlapsForeignEdge = (edgeId: string, rect: RectLite): boolean => {
    const buffered = inflateRect(rect, LABEL_PLACEMENT_BUFFER);
    for (const s of allEdgeSegments) {
      if (s.edgeId === edgeId) {
        continue;
      }
      if (segmentBoundsOverlapRect(s.p1, s.p2, buffered)) {
        return true;
      }
    }
    return false;
  };

  const labelOverlapsAnything = (labelId: string, edgeId: string, rect: RectLite): boolean =>
    labelOverlapsForeignNode(labelId, rect) || labelOverlapsForeignEdge(edgeId, rect);

  const placedLabelRects: { labelId: string; rect: RectLite }[] = [];

  const findContainingLane = (rect: RectLite): string | undefined => {
    for (const { id, rect: laneRect } of laneGroups) {
      if (rectContainsRect(laneRect, rect)) {
        return id;
      }
    }
    return undefined;
  };

  const innermostLaneHolding = (rect: RectLite): string | undefined => {
    let found: { id: string; area: number } | undefined;
    for (const { id, rect: laneRect } of laneGroups) {
      const area = (laneRect.right - laneRect.left) * (laneRect.bottom - laneRect.top);
      if (rectContainsRect(laneRect, rect) && (!found || area < found.area)) {
        found = { id, area };
      }
    }
    return found?.id;
  };

  // How many drawn edges leave each node: a node with more than one is a branch point.
  const outgoingCount = new Map<string, number>();
  for (const other of edges) {
    if (!other.isLayoutOnly && other.start) {
      outgoingCount.set(other.start, (outgoingCount.get(other.start) ?? 0) + 1);
    }
  }

  const overlapsPlacedLabel = (labelId: string, rect: RectLite): boolean =>
    placedLabelRects.some(
      (placed) => placed.labelId !== labelId && rectsOverlap(rect, placed.rect)
    );

  interface SegmentCandidate {
    idx: number;
    length: number;
    orientation: 'horizontal' | 'vertical';
    midX: number;
    midY: number;
  }

  for (const edge of edges) {
    if (edge.isLayoutOnly) {
      continue;
    }
    const labelId = edge.labelNodeId;
    if (!labelId) {
      continue;
    }
    const labelNode = nodeByIdMap.get(labelId);
    if (!labelNode) {
      continue;
    }
    const pts = edge.points;
    if (!pts || pts.length < 2) {
      continue;
    }
    const lw = labelNode.width ?? 0;
    const lh = labelNode.height ?? 0;
    if (lw <= 0 || lh <= 0) {
      continue;
    }

    // Collect every non-zero segment with orientation.
    const segments: SegmentCandidate[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const dx = Math.abs(a.x - b.x);
      const dy = Math.abs(a.y - b.y);
      if (dx < EPS && dy < EPS) {
        continue;
      }
      if (dx >= EPS && dy >= EPS) {
        continue; // non-orthogonal — should not happen post-orthogonalize
      }
      segments.push({
        idx: i,
        length: dx + dy,
        orientation: dx >= EPS ? 'horizontal' : 'vertical',
        midX: (a.x + b.x) / 2,
        midY: (a.y + b.y) / 2,
      });
    }

    if (segments.length === 0) {
      continue;
    }

    // §118: middle segments only (exclude first and last). Fall back to
    // any segment if the polyline has fewer than 3 segments (the paper is
    // silent on degenerate cases — Mermaid calibration).
    const middleSegments =
      segments.length >= 3
        ? segments.filter((s) => s.idx > 0 && s.idx < segments.length - 1)
        : segments;
    const poolBase = middleSegments.length > 0 ? middleSegments : segments;

    // Label long axis: horizontal if wider than tall, else vertical. The
    // label is drawn horizontally inside its bbox regardless, so the long
    // axis only drives preference, not hard filtering.
    const labelLongAxis: 'horizontal' | 'vertical' = lw >= lh ? 'horizontal' : 'vertical';

    // Candidate ranking: (a) length >= labelExtent + 2, (b) orientation
    // matching label long axis preferred, (c) longest tie-break.
    const rankSegments = (pool: SegmentCandidate[]): SegmentCandidate[] => {
      return [...pool].sort((a, b) => {
        const aLongAxis = a.orientation === labelLongAxis;
        const bLongAxis = b.orientation === labelLongAxis;
        if (aLongAxis !== bLongAxis) {
          return aLongAxis ? -1 : 1;
        }
        const aFits = a.length >= (a.orientation === 'horizontal' ? lw : lh) + 2;
        const bFits = b.length >= (b.orientation === 'horizontal' ? lw : lh) + 2;
        if (aFits !== bFits) {
          return aFits ? -1 : 1;
        }
        return b.length - a.length;
      });
    };

    // Try the middle-segment pool first (§118), then expand to include
    // every orthogonal segment if the middle-only pool yields no
    // lane-containing, overlap-free candidate. The "any segment" expansion
    // is a Mermaid-specific adaptation for cross-lane edges whose only
    // middle segment is the vertical lane-crossing leg (which by
    // construction straddles a lane boundary and cannot host the label).
    //
    // Per-segment, if the midpoint (t=0.5) collides with a foreign edge
    // or label, walk along the segment at additional parametric positions
    // t ∈ {0.25, 0.75, 0.15, 0.85, 0.1, 0.9} before moving on. Helmers diss.pdf
    // §118 requires "one of e's middle segments" but is silent on the
    // exact anchor position along that segment, so along-segment shift is
    // consistent with the paper (Mermaid adaptation). Paper-adjacent to
    // Wybrow-Marriott alley-midpoint centering (src `e8804c93`), which
    // picks the placement with widest clearance to foreign geometry.
    const firstVisibleSegment = segments[0];
    const lastVisibleSegment = segments[segments.length - 1];
    const ALONG_SEGMENT_TS = [0.5, 0.25, 0.75, 0.05, 0.95, 0.15, 0.85, 0.1, 0.9];
    const anchorAtT = (seg: SegmentCandidate, t: number): { midX: number; midY: number } => {
      const a = pts[seg.idx];
      const b = pts[seg.idx + 1];
      return {
        midX: a.x + (b.x - a.x) * t,
        midY: a.y + (b.y - a.y) * t,
      };
    };
    const clamp = (value: number, min: number, max: number): number =>
      Math.min(max, Math.max(min, value));
    const pointInsideRectInclusive = (
      point: { midX: number; midY: number },
      rect: RectLite
    ): boolean =>
      point.midX >= rect.left - EPS &&
      point.midX <= rect.right + EPS &&
      point.midY >= rect.top - EPS &&
      point.midY <= rect.bottom + EPS;
    const placementForAnchor = (anchor: {
      midX: number;
      midY: number;
    }): { laneId: string; anchor: { midX: number; midY: number }; rect: RectLite } | undefined => {
      const centeredRect = rectFromCenterSize(anchor.midX, anchor.midY, lw, lh);
      const centeredLane = findContainingLane(centeredRect);
      if (centeredLane) {
        return { laneId: centeredLane, anchor, rect: centeredRect };
      }

      // If the segment is close to a lane border, keep the label box inside
      // the lane while requiring the original segment point to remain inside
      // that box. The validator then sees the edge passing through the label.
      const containingLane = laneGroups.find(({ rect }) => pointInsideRectInclusive(anchor, rect));
      if (!containingLane) {
        return undefined;
      }

      const minX = containingLane.rect.left + lw / 2 + LABEL_LANE_MARGIN;
      const maxX = containingLane.rect.right - lw / 2 - LABEL_LANE_MARGIN;
      const minY = containingLane.rect.top + lh / 2 + LABEL_LANE_MARGIN;
      const maxY = containingLane.rect.bottom - lh / 2 - LABEL_LANE_MARGIN;
      if (minX > maxX || minY > maxY) {
        return undefined;
      }

      const clampedAnchor = {
        midX: clamp(anchor.midX, minX, maxX),
        midY: clamp(anchor.midY, minY, maxY),
      };
      const clampedRect = rectFromCenterSize(clampedAnchor.midX, clampedAnchor.midY, lw, lh);
      return pointInsideRectInclusive(anchor, clampedRect)
        ? { laneId: containingLane.id, anchor: clampedAnchor, rect: clampedRect }
        : undefined;
    };
    const distanceAlongSegment = (
      seg: SegmentCandidate,
      anchor: { midX: number; midY: number },
      endpoint: { x: number; y: number }
    ): number =>
      seg.orientation === 'horizontal'
        ? Math.abs(anchor.midX - endpoint.x)
        : Math.abs(anchor.midY - endpoint.y);
    const labelClearsTerminalEndpoints = (
      seg: SegmentCandidate,
      anchor: { midX: number; midY: number }
    ): boolean => {
      const labelHalfExtent = seg.orientation === 'horizontal' ? lw / 2 : lh / 2;
      const requiredDistance = labelHalfExtent + LABEL_ENDPOINT_CLEARANCE;
      if (seg === firstVisibleSegment) {
        const start = pts[seg.idx];
        if (distanceAlongSegment(seg, anchor, start) + EPS < requiredDistance) {
          return false;
        }
      }
      if (seg === lastVisibleSegment) {
        const end = pts[seg.idx + 1];
        if (distanceAlongSegment(seg, anchor, end) + EPS < requiredDistance) {
          return false;
        }
      }
      return true;
    };
    const tryPool = (
      pool: SegmentCandidate[]
    ): { laneId: string; anchor: { midX: number; midY: number } } | undefined => {
      const rankedPool = rankSegments(pool);
      for (const seg of rankedPool) {
        for (const t of ALONG_SEGMENT_TS) {
          const anchor = anchorAtT(seg, t);
          if (!labelClearsTerminalEndpoints(seg, anchor)) {
            continue;
          }
          const placement = placementForAnchor(anchor);
          if (!placement) {
            continue;
          }
          if (labelOverlapsOwnMarker(placement.rect, pts)) {
            continue;
          }
          if (overlapsPlacedLabel(labelId, placement.rect)) {
            continue;
          }
          if (!labelOverlapsAnything(labelId, edge.id, placement.rect)) {
            return { laneId: placement.laneId, anchor: placement.anchor };
          }
        }
      }
      return undefined;
    };

    const findLaneContainingFallback = (
      pool: SegmentCandidate[],
      requireEndpointClearance: boolean,
      allowForeignEdgeOverlap = false
    ): { laneId: string; anchor: { midX: number; midY: number } } | undefined => {
      const rankedPool = rankSegments(pool);
      for (const seg of rankedPool) {
        const anchor = { midX: seg.midX, midY: seg.midY };
        if (requireEndpointClearance && !labelClearsTerminalEndpoints(seg, anchor)) {
          continue;
        }
        const placement = placementForAnchor(anchor);
        if (
          placement &&
          !labelOverlapsOwnMarker(placement.rect, pts) &&
          !overlapsPlacedLabel(labelId, placement.rect) &&
          !labelOverlapsForeignNode(labelId, placement.rect) &&
          (allowForeignEdgeOverlap || !labelOverlapsForeignEdge(edge.id, placement.rect))
        ) {
          return { laneId: placement.laneId, anchor: placement.anchor };
        }
      }
      return undefined;
    };

    // The search for the best place: every point along every straight stretch of the line
    // where the whole label stays on that stretch, clear of the line's own bends, of other
    // lines, shapes and labels, and inside a lane. The place nearest the middle of the line
    // wins; on a branch (its source has other edges leaving it) the place nearest the source,
    // which is where a reader looks for the condition of a gateway or decision.
    const bestPlacement = ():
      | { laneId: string; anchor: { midX: number; midY: number } }
      | undefined => {
      const along: number[] = [0];
      for (let i = 0; i < pts.length - 1; i++) {
        along.push(
          along[i] + Math.abs(pts[i + 1].x - pts[i].x) + Math.abs(pts[i + 1].y - pts[i].y)
        );
      }
      const total = along[along.length - 1];
      if (total < EPS) {
        return undefined;
      }
      const isBranch = (outgoingCount.get(edge.start ?? '') ?? 0) > 1;
      const first = segments[0];
      const firstExtent = first.orientation === 'horizontal' ? lw / 2 : lh / 2;
      const target = isBranch
        ? along[first.idx] + LABEL_ENDPOINT_CLEARANCE + firstExtent + BRANCH_LABEL_GAP
        : total / 2;
      const bends = bendsOf(pts);
      let best:
        | { laneId: string; anchor: { midX: number; midY: number }; cost: number }
        | undefined;
      for (const seg of segments) {
        const a = pts[seg.idx];
        const b = pts[seg.idx + 1];
        const extent = seg.orientation === 'horizontal' ? lw / 2 : lh / 2;
        const room = seg.length - 2 * (extent + CORNER_ROOM);
        if (room < 0) {
          continue;
        }
        const steps = Math.max(1, Math.min(MAX_STEPS, Math.ceil(room / SEARCH_STEP)));
        for (let k = 0; k <= steps; k++) {
          const offset = extent + CORNER_ROOM + (room * k) / steps;
          const t = offset / seg.length;
          const anchor = { midX: a.x + (b.x - a.x) * t, midY: a.y + (b.y - a.y) * t };
          if (!labelClearsTerminalEndpoints(seg, anchor)) {
            continue;
          }
          const rect = rectFromCenterSize(anchor.midX, anchor.midY, lw, lh);
          const roomy = inflateRect(rect, LANE_ROOM);
          if (laneGroups.some(({ rect: lane }) => crossesBorder(lane, roomy))) {
            continue;
          }
          const laneId = innermostLaneHolding(rect);
          if (!laneId && laneGroups.length > 0) {
            continue;
          }
          const cornerZone = inflateRect(rect, CORNER_ROOM);
          if (bends.some((p) => pointInsideRectInclusive({ midX: p.x, midY: p.y }, cornerZone))) {
            continue;
          }
          if (
            labelOverlapsOwnMarker(rect, pts) ||
            overlapsPlacedLabel(labelId, inflateRect(rect, LABEL_PLACEMENT_BUFFER)) ||
            labelOverlapsAnything(labelId, edge.id, rect)
          ) {
            continue;
          }
          const position = along[seg.idx] + offset;
          const cost =
            Math.abs(position - target) + (seg.orientation === labelLongAxis ? 0 : ACROSS_PENALTY);
          if (!best || cost < best.cost) {
            best = { laneId: laneId ?? labelNode.parentId ?? '', anchor, cost };
          }
        }
      }
      return best && { laneId: best.laneId, anchor: best.anchor };
    };

    const chosen =
      bestPlacement() ??
      tryPool(poolBase) ??
      (poolBase.length < segments.length ? tryPool(segments) : undefined) ??
      findLaneContainingFallback(segments, true) ??
      findLaneContainingFallback(segments, false) ??
      findLaneContainingFallback(segments, false, true);

    if (chosen) {
      labelNode.x = chosen.anchor.midX;
      labelNode.y = chosen.anchor.midY;
      labelNode.parentId = chosen.laneId;
      const chosenRect = rectFromCenterSize(chosen.anchor.midX, chosen.anchor.midY, lw, lh);
      const priorIdx = placedLabelRects.findIndex((placed) => placed.labelId === labelId);
      if (priorIdx >= 0) {
        placedLabelRects[priorIdx] = { labelId, rect: chosenRect };
      } else {
        placedLabelRects.push({ labelId, rect: chosenRect });
      }
    }
  }
}
