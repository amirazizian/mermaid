import { getConfig as getGlobalConfig } from '../../diagram-api/diagramAPI.js';
import {
  setAccTitle,
  getAccTitle,
  setAccDescription,
  getAccDescription,
  setDiagramTitle,
  getDiagramTitle,
  clear as commonClear,
} from '../common/commonDb.js';
import type { LayoutData, Node, NonClusterNode, Edge } from '../../rendering-util/types.js';
import { parseBpmn } from './parser/bpmn.parser.js';
import type { ParsedDiagram, ParsedFlow, ParsedNode } from './parser/bpmn.parser.js';

type BpmnShape = NonNullable<NonClusterNode['shape']>;
type NodeMetadata = Record<string, unknown>;

const EVENT_SHAPES: Record<string, BpmnShape> = {
  start: 'bpmn-start',
  intermediate: 'bpmn-intermediate',
  boundary: 'bpmn-boundary',
  end: 'bpmn-end',
  throw: 'bpmn-intermediate',
};

const GATEWAY_GLYPHS: Record<string, string> = {
  xor: 'bpmn:exclusive',
  and: 'bpmn:parallel-gateway',
  or: 'bpmn:inclusive',
  'event-gateway': 'bpmn:event-based',
  complex: 'bpmn:complex',
};

const EDGE_PATTERNS: Record<ParsedFlow['kind'], Edge['pattern']> = {
  sequence: 'solid',
  message: 'dashed',
  association: 'dotted',
};

/** How many edges a diagram may have when the site config does not set `maxEdges`. */
const DEFAULT_MAX_EDGES = 500;

/**
 * Rejects a diagram with more flows than the secure `maxEdges` setting allows (500 unless
 * `mermaid.initialize` sets it; 0 rejects every flow), with the error a flowchart gives.
 */
function checkEdgeLimit(flowCount: number): void {
  const { maxEdges } = getGlobalConfig();
  const limit = maxEdges ?? DEFAULT_MAX_EDGES;
  if (flowCount <= limit) {
    return;
  }
  throw new Error(
    `Edge limit exceeded. ${limit} edges found, but the limit is ${maxEdges}.

Initialize mermaid with maxEdges set to a higher number to allow more edges.
You cannot set this config via configuration inside the diagram as it is a secure config.
You have to call mermaid.initialize.`
  );
}

/** How edges meet each drawn shape; the layout reads these keys without knowing a BPMN shape. */
const POINTED: NodeMetadata = { endpointProfile: 'vertex' };
const FLAT_SIDED: NodeMetadata = { endpointProfile: 'flat' };

const ENDPOINT_PROFILES: Partial<Record<BpmnShape, NodeMetadata>> = {
  'bpmn-start': POINTED,
  'bpmn-intermediate': POINTED,
  'bpmn-boundary': POINTED,
  'bpmn-end': POINTED,
  'bpmn-gateway': { ...POINTED, oneLinePerVertex: true, captionBelow: true },
  'bpmn-activity': FLAT_SIDED,
  'bpmn-data': FLAT_SIDED,
  'bpmn-data-store': FLAT_SIDED,
  'bpmn-annotation': FLAT_SIDED,
  'bpmn-subprocess-frame': FLAT_SIDED,
};

const ARTIFACT_KINDS = new Set<ParsedNode['kind']>(['data', 'store', 'annotation']);

const ARTIFACT_CLEARANCE = 18;

interface Drawn {
  shape: BpmnShape;
  icon?: string;
  markers?: string[];
}

const LOOP_GLYPHS = {
  loop: 'bpmn:loop',
  parallel: 'bpmn:parallel',
  sequential: 'bpmn:sequential',
} as const;

/**
 * The markers along an activity's bottom edge, in the order BPMN 2.0.2 groups them: the loop or
 * multi-instance marker, the `+` of a collapsed sub-process, ad-hoc, then compensation.
 */
const activityMarkers = (node: ParsedNode): string[] => [
  ...(node.loop ? [LOOP_GLYPHS[node.loop]] : []),
  ...(node.keyword === 'subprocess' || node.callsProcess ? ['bpmn:subprocess'] : []),
  ...(node.adHoc ? ['bpmn:ad-hoc'] : []),
  ...(node.compensation ? ['bpmn:compensation'] : []),
];

/** The label drawn on an element: a data object's state goes under its name, or alone without one. */
const drawnLabel = ({ label, state }: ParsedNode): string => {
  if (!state) {
    return label;
  }
  return label ? `${label}<br>[${state}]` : `[${state}]`;
};

const drawnAs = (node: ParsedNode): Drawn => {
  const qualifier = node.qualifier && node.qualifier !== 'none' ? node.qualifier : undefined;
  switch (node.kind) {
    case 'event':
      return {
        shape: EVENT_SHAPES[node.keyword] ?? 'bpmn-start',
        ...(qualifier ? { icon: `bpmn:${qualifier}` } : {}),
      };
    case 'gateway':
      if (node.instantiate) {
        return {
          shape: 'bpmn-gateway',
          icon:
            node.instantiate === 'parallel'
              ? 'bpmn:event-based-parallel'
              : 'bpmn:event-based-instantiating',
        };
      }
      return node.unmarked
        ? { shape: 'bpmn-gateway' }
        : { shape: 'bpmn-gateway', icon: GATEWAY_GLYPHS[node.keyword] ?? 'bpmn:exclusive' };
    case 'activity': {
      const markers = activityMarkers(node);
      return {
        shape: 'bpmn-activity',
        ...(qualifier && node.keyword !== 'subprocess' ? { icon: `bpmn:${qualifier}` } : {}),
        ...(markers.length ? { markers } : {}),
      };
    }
    case 'data':
      return { shape: 'bpmn-data' };
    case 'store':
      return { shape: 'bpmn-data-store' };
    case 'annotation':
      return { shape: 'bpmn-annotation' };
    default:
      return { shape: 'bpmn-activity' };
  }
};

/** The head at a flow's target: filled for a sequence flow, open for a message or a directed association. */
const arrowAtEnd = (flow: ParsedFlow): string =>
  flow.kind === 'sequence'
    ? 'arrow_point'
    : flow.kind === 'message' || flow.directed
      ? 'arrow_open_head'
      : 'none';

/**
 * The mark at a flow's source: the ring of a message flow, the slash of a default flow, the
 * small diamond of a conditional flow out of an activity (out of a gateway its condition is
 * only a label), and the second head of an association drawn in both directions.
 */
const arrowAtStart = (flow: ParsedFlow, source: ParsedNode | undefined): string => {
  if (flow.kind === 'message') {
    return 'arrow_hollow_circle';
  }
  if (flow.bidirectional) {
    return 'arrow_open_head';
  }
  if (flow.isDefault) {
    return 'arrow_slash';
  }
  if (flow.condition !== undefined && source?.kind === 'activity') {
    return 'arrow_small_diamond';
  }
  return 'none';
};

/** The border each kind of expanded sub-process is drawn with. */
const FRAME_BORDERS = { plain: 'solid', event: 'dotted', transaction: 'double' } as const;

const emptyDiagram = (): ParsedDiagram => ({ direction: 'LR', nodes: [], flows: [] });

export class BpmnDb {
  private parsed: ParsedDiagram = emptyDiagram();
  private diagramId = '';
  private frontmatterLineOffset = 0;

  /** Keeps `%%` comment lines in the text, so a line of it is a line of the source. */
  public readonly preserveCommentsWhenParsing = true;

  public setFrontmatterLineOffset(offset: number) {
    this.frontmatterLineOffset = offset;
  }

  public clear() {
    this.parsed = emptyDiagram();
    this.diagramId = '';
    commonClear();
  }

  public parse(input: string) {
    this.parsed = parseBpmn(input, this.frontmatterLineOffset);
    checkEdgeLimit(this.parsed.flows.length);
    if (this.parsed.title) {
      setDiagramTitle(this.parsed.title);
    }
    if (this.parsed.accTitle) {
      setAccTitle(this.parsed.accTitle);
    }
    if (this.parsed.accDescr) {
      setAccDescription(this.parsed.accDescr);
    }
  }

  public setDiagramId(id: string) {
    this.diagramId = id;
  }

  public getDirection() {
    return this.parsed.direction;
  }

  public getClasses() {
    return new Map<string, unknown>();
  }

  public getConfig() {
    return getGlobalConfig().bpmn ?? {};
  }

  public setAccTitle = setAccTitle;
  public getAccTitle = getAccTitle;
  public setAccDescription = setAccDescription;
  public getAccDescription = getAccDescription;
  public setDiagramTitle = setDiagramTitle;
  public getDiagramTitle = getDiagramTitle;

  /**
   * The expanded sub-process an element is laid out in, or none for the diagram itself. A
   * boundary event is laid out where its activity is, on that activity's border.
   */
  public scopeOf(id: string): string | undefined {
    const byId = this.nodesById();
    let node = byId.get(id);
    if (node?.keyword === 'boundary' && node.parentId) {
      node = byId.get(node.parentId);
    }
    let parentId = node?.parentId;
    const seen = new Set<string>();
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = byId.get(parentId);
      if (parent?.expanded) {
        return parent.id;
      }
      parentId = parent?.parentId;
    }
    return undefined;
  }

  private nodesById(): Map<string, ParsedNode> {
    return new Map(this.parsed.nodes.map((node) => [node.id, node]));
  }

  /**
   * The element that stands for `id` in the layout of `scope`: the element itself when it is
   * laid out there, the expanded sub-process of that scope it is inside, or none when it is
   * outside the scope.
   */
  private standIn(id: string, scope: string | undefined): string | undefined {
    let current: string | undefined = id;
    const seen = new Set<string>();
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      const owner = this.scopeOf(current);
      if (owner === scope) {
        return current;
      }
      current = owner;
    }
    return undefined;
  }

  /** The groups drawn around members anywhere in the diagram, once it is laid out. */
  public spanningGroups(): { id: string; label: string; members: string[] }[] {
    return this.parsed.nodes
      .filter((node) => node.members)
      .map((node) => ({ id: node.id, label: node.label, members: node.members! }));
  }

  /** The expanded sub-processes, those inside others first, so each is laid out before its own. */
  public expandedSubprocesses(): string[] {
    const depth = (id: string): number => {
      let count = 0;
      let scope = this.scopeOf(id);
      while (scope !== undefined && count < 1000) {
        count++;
        scope = this.scopeOf(scope);
      }
      return count;
    };
    return this.parsed.nodes
      .filter((node) => node.expanded)
      .map((node) => node.id)
      .sort((a, b) => depth(b) - depth(a));
  }

  private artifactHosts(scope: string | undefined): Map<string, string> {
    const artifacts = new Set(
      this.parsed.nodes.filter((node) => ARTIFACT_KINDS.has(node.kind)).map((node) => node.id)
    );
    const hosts = new Map<string, string>();
    for (const flow of this.parsed.flows) {
      if (flow.kind !== 'association') {
        continue;
      }
      for (const [self, other] of [
        [flow.from, flow.to],
        [flow.to, flow.from],
      ]) {
        if (!artifacts.has(self) || artifacts.has(other) || hosts.has(self)) {
          continue;
        }
        // An artifact is pinned beside what stands for its host where the artifact is laid out.
        const host = this.scopeOf(self) === scope ? this.standIn(other, scope) : undefined;
        if (host !== undefined) {
          hosts.set(self, host);
        }
      }
    }
    return hosts;
  }

  /**
   * The layout of the diagram, or with `scope` of the inside of one expanded sub-process. An
   * expanded sub-process is laid out as one node, drawn as a frame around its content, which
   * is laid out beforehand; `frames` gives the size of each one's content.
   */
  public getData(
    options: { scope?: string; frames?: Map<string, { width: number; height: number }> } = {}
  ): LayoutData {
    const { scope, frames } = options;
    const config = getGlobalConfig();
    const look = config.look ?? 'classic';
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    const byId = this.nodesById();

    let laneIndex = 0;
    const artifactHosts = this.artifactHosts(scope);
    for (const parsed of this.parsed.nodes) {
      // A group with members is not laid out; it is drawn around them afterwards.
      if (this.scopeOf(parsed.id) !== scope || parsed.members) {
        continue;
      }
      const artifactHost = artifactHosts.get(parsed.id);
      const besideHost =
        parsed.kind === 'annotation' &&
        artifactHost !== undefined &&
        byId.get(artifactHost)?.kind === 'gateway';
      const isBand = parsed.kind === 'pool' || parsed.kind === 'lane';
      const isGroup = isBand || parsed.kind === 'group';
      const isFrame = Boolean(parsed.expanded);
      const { shape, icon, markers } = isFrame
        ? { ...drawnAs(parsed), shape: 'bpmn-subprocess-frame' as BpmnShape }
        : drawnAs(parsed);
      // An element straight under the sub-process being laid out is at the top of its layout.
      const parentId = parsed.parentId === scope ? undefined : parsed.parentId;
      const shared = {
        id: parsed.id,
        label: drawnLabel(parsed),
        labelType: 'string' as const,
        parentId,
        metadata: {
          ...(isBand ? { laneRole: parsed.kind, laneIndex: laneIndex++ } : {}),
          ...(parsed.multiple ? { multiplicity: true } : {}),
          // The state is drawn in the label, and kept here too for anything that reads the
          // diagram's elements rather than its drawing.
          ...(parsed.state ? { state: parsed.state } : {}),
          ...(parsed.keyword === 'boundary' && parsed.parentId
            ? { anchorTo: { hostId: parsed.parentId } }
            : {}),
          ...(artifactHost
            ? {
                anchorTo: {
                  hostId: artifactHost,
                  gap: ARTIFACT_CLEARANCE,
                  ...(besideHost ? { side: 'left' as const } : {}),
                },
              }
            : {}),
          ...(parsed.qualifier === 'input' || parsed.qualifier === 'output'
            ? { dataDirection: parsed.qualifier }
            : {}),
          ...(parsed.qualifier === 'collection' ? { isCollection: true } : {}),
          ...(parsed.kind === 'annotation' ? { attachFace: besideHost ? 'right' : 'left' } : {}),
          ...(parsed.subprocessKind || isFrame
            ? { frameBorder: FRAME_BORDERS[parsed.subprocessKind ?? 'plain'] }
            : {}),
          ...(isFrame ? { content: frames?.get(parsed.id) ?? { width: 0, height: 0 } } : {}),
          ...(isGroup ? {} : ENDPOINT_PROFILES[shape]),
        },
        cssClasses: [
          ...(isGroup ? [`bpmn-${parsed.kind}`] : []),
          ...(parsed.subprocessKind ? [`bpmn-${parsed.subprocessKind}-subprocess`] : []),
          ...(parsed.nonInterrupting ? ['bpmn-non-interrupting'] : []),
          ...(parsed.keyword === 'end' || parsed.keyword === 'throw' ? ['bpmn-throw'] : []),
          ...(parsed.keyword === 'call' ? ['bpmn-call'] : []),
          ...(parsed.compensation ? ['bpmn-compensation'] : []),
        ].join(' '),
        cssStyles: [],
        padding: parsed.kind === 'group' ? 56 : 20,
        look,
      };
      if (isGroup) {
        nodes.push({ ...shared, isGroup: true, shape: isBand ? 'rect' : 'roundedWithTitle' });
      } else {
        // An expanded sub-process draws its markers without the + of a collapsed one.
        const drawnMarkers = isFrame
          ? markers?.filter((marker) => marker !== 'bpmn:subprocess')
          : markers;
        const node: NonClusterNode & { markers?: string[] } = {
          ...shared,
          isGroup: false,
          shape,
          ...(icon && !isFrame ? { icon } : {}),
          ...(drawnMarkers?.length ? { markers: drawnMarkers } : {}),
        };
        nodes.push(node);
      }
    }

    for (const [index, flow] of this.parsed.flows.entries()) {
      // A flow is drawn in the layout of the innermost scope that holds both its ends, between
      // what stands for each end there.
      const start = this.standIn(flow.from, scope);
      const end = this.standIn(flow.to, scope);
      if (start === undefined || end === undefined || start === end) {
        continue;
      }
      edges.push({
        id: `bpmn-edge-${index}`,
        start,
        end,
        type: 'normal',
        label: flow.label ?? flow.condition ?? '',
        labelType: 'string',
        labelpos: 'c',
        thickness: 'normal',
        pattern: EDGE_PATTERNS[flow.kind],
        arrowTypeEnd: arrowAtEnd(flow),
        arrowTypeStart: arrowAtStart(flow, byId.get(flow.from)),
        style: [],
        labelStyle: [],
        classes: [
          'bpmn-flow',
          `bpmn-flow-${flow.kind}`,
          ...(flow.isDefault ? ['bpmn-flow-default'] : []),
          ...(flow.condition !== undefined ? ['bpmn-flow-conditional'] : []),
          ...(flow.message ? [`bpmn-flow-message-${flow.message}`] : []),
        ].join(' '),
        look,
        ...(flow.id ? { flowId: flow.id } : {}),
        ...(flow.message ? { message: flow.message } : {}),
      } satisfies Edge & { flowId?: string; message?: string });
    }

    return {
      nodes,
      edges,
      config,
      direction: this.parsed.direction,
      layoutAlgorithm: 'swimlane',
      laneLayering: 'branches',
      diagramId: this.diagramId,
      markers: ['point', 'circle', 'cross', 'openArrow', 'hollowCircle', 'slash', 'smallDiamond'],
      type: 'bpmn',
    } satisfies LayoutData;
  }
}
