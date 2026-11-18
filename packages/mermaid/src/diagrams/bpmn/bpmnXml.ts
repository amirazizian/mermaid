/**
 * Writes a parsed `bpmn-beta` diagram as BPMN 2.0.2 XML: the process and collaboration
 * semantics and, when the drawn geometry is given, the diagram interchange (DI) that places every
 * shape and flow where the SVG draws it, so that a BPMN tool (Camunda Modeler, bpmn.io) opens the
 * file with the same layout.
 *
 * Without geometry only the semantics are written: there is no `BPMNDiagram`, so a tool that
 * needs DI to show the model (bpmn.io does) imports it but has nothing to draw.
 *
 * This module is pure: it reads the parsed diagram and the geometry and returns a string.
 */
// cspell:ignore bpmndi
import type { ParsedDiagram, ParsedFlow, ParsedNode } from './parser/bpmn.parser.js';

/** A shape's bounds, top-left corner and size. */
export interface BpmnBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BpmnPoint {
  x: number;
  y: number;
}

/**
 * Where each element and flow is drawn, in one coordinate space: `shapes` by element id (pools,
 * lanes, groups included), `edges` by the flow's index in `ParsedDiagram.flows`.
 */
export interface BpmnGeometry {
  shapes: Record<string, BpmnBounds>;
  edges: Record<number, BpmnPoint[]>;
}

export interface BpmnXmlOptions {
  /** Written as `exporterVersion`; the version of the tool that drew the diagram. */
  exporterVersion?: string;
}

export const BPMN_NAMESPACES = {
  bpmn: 'http://www.omg.org/spec/BPMN/20100524/MODEL',
  bpmndi: 'http://www.omg.org/spec/BPMN/20100524/DI',
  dc: 'http://www.omg.org/spec/DD/20100524/DC',
  di: 'http://www.omg.org/spec/DD/20100524/DI',
  xsi: 'http://www.w3.org/2001/XMLSchema-instance',
} as const;

const TARGET_NAMESPACE = 'https://mermaid.js.org/schema/bpmn';

// ---------------------------------------------------------------------------------------------
// A small XML tree and its serialisation.

type AttributeValue = string | number | boolean | undefined;

interface XmlElement {
  name: string;
  attributes: [string, string][];
  children: XmlElement[];
  text?: string;
}

const element = (
  name: string,
  attributes: Record<string, AttributeValue> = {},
  children: (XmlElement | undefined | false)[] = [],
  text?: string
): XmlElement => ({
  name,
  attributes: Object.entries(attributes)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .map(([key, value]) => [key, String(value)]),
  children: children.filter((child): child is XmlElement => Boolean(child)),
  ...(text !== undefined ? { text } : {}),
});

// Characters XML 1.0 does not allow at all, which no escape can carry.
// eslint-disable-next-line no-control-regex
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

const escapeText = (value: string): string =>
  value
    .replace(INVALID_XML_CHARS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/** Escapes an attribute value, keeping line breaks and tabs, which a parser would fold to spaces. */
const escapeAttribute = (value: string): string =>
  escapeText(value)
    .replace(/"/g, '&quot;')
    .replace(/\t/g, '&#9;')
    .replace(/\n/g, '&#10;')
    .replace(/\r/g, '&#13;');

function serialise(node: XmlElement, depth: number, lines: string[]): void {
  const indent = '  '.repeat(depth);
  const attributes = node.attributes
    .map(([key, value]) => ` ${key}="${escapeAttribute(value)}"`)
    .join('');
  if (node.children.length === 0 && node.text === undefined) {
    lines.push(`${indent}<${node.name}${attributes} />`);
    return;
  }
  if (node.children.length === 0) {
    lines.push(`${indent}<${node.name}${attributes}>${escapeText(node.text!)}</${node.name}>`);
    return;
  }
  lines.push(`${indent}<${node.name}${attributes}>`);
  for (const child of node.children) {
    serialise(child, depth + 1, lines);
  }
  lines.push(`${indent}</${node.name}>`);
}

// ---------------------------------------------------------------------------------------------
// Ids.

/** Makes `value` a valid NCName: letters, digits, `_`, `-` and `.`, not starting with a digit. */
export const toNcName = (value: string): string => {
  const cleaned = value.replace(/[^\w.-]/g, '_');
  return /^[A-Z_a-z]/.test(cleaned) ? cleaned : `_${cleaned}`;
};

class IdRegistry {
  private used = new Set<string>();

  /** `base` as an NCName, with a numeric suffix if an earlier element already took it. */
  public claim(base: string): string {
    const name = toNcName(base);
    let id = name;
    for (let suffix = 2; this.used.has(id); suffix++) {
      id = `${name}_${suffix}`;
    }
    this.used.add(id);
    return id;
  }
}

// ---------------------------------------------------------------------------------------------
// Mapping tables.

const TASK_ELEMENTS: Record<string, string> = {
  user: 'bpmn:userTask',
  service: 'bpmn:serviceTask',
  receive: 'bpmn:receiveTask',
  send: 'bpmn:sendTask',
  manual: 'bpmn:manualTask',
  script: 'bpmn:scriptTask',
  rule: 'bpmn:businessRuleTask',
};

const EVENT_ELEMENTS: Record<string, string> = {
  start: 'bpmn:startEvent',
  intermediate: 'bpmn:intermediateCatchEvent',
  throw: 'bpmn:intermediateThrowEvent',
  boundary: 'bpmn:boundaryEvent',
  end: 'bpmn:endEvent',
};

const GATEWAY_ELEMENTS: Record<string, string> = {
  xor: 'bpmn:exclusiveGateway',
  and: 'bpmn:parallelGateway',
  or: 'bpmn:inclusiveGateway',
  'event-gateway': 'bpmn:eventBasedGateway',
  complex: 'bpmn:complexGateway',
};

/** The gateways that take a `default` attribute. */
const GATEWAYS_WITH_DEFAULT = new Set(['xor', 'or', 'complex']);

/** The event definition each single trigger is written with. */
const TRIGGER_DEFINITIONS: Record<string, string> = {
  message: 'messageEventDefinition',
  timer: 'timerEventDefinition',
  error: 'errorEventDefinition',
  escalation: 'escalationEventDefinition',
  cancel: 'cancelEventDefinition',
  compensation: 'compensateEventDefinition',
  conditional: 'conditionalEventDefinition',
  link: 'linkEventDefinition',
  signal: 'signalEventDefinition',
  terminate: 'terminateEventDefinition',
};

/**
 * A multiple event is one with two or more event definitions (BPMN 2.0.2, 10.5.1). The
 * notation does not say which, so message and signal are written: both are allowed on every
 * position an event of the multiple trigger takes.
 */
const MULTIPLE_DEFINITIONS = ['messageEventDefinition', 'signalEventDefinition'];

const CATCHING_POSITIONS = new Set(['start', 'intermediate', 'boundary']);

/** Turns a drawn label into a plain name: `<br>` becomes a line break. */
const nameOf = (label: string | undefined): string | undefined => {
  const name = label
    ?.replace(/<br\s*\/?>/gi, '\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
  return name === '' ? undefined : name;
};

const round = (value: number): number => Math.round(value * 100) / 100;

// ---------------------------------------------------------------------------------------------

interface Process {
  id: string;
  name?: string;
  /** The pool it is the process of; none for the process of everything outside a pool. */
  pool?: ParsedNode;
  /** The participant that stands for it in the collaboration. */
  participantId?: string;
}

/** Where a flow element or artifact is written: a process, or an expanded sub-process. */
type ContainerKey = string;

const PROCESS_KEY = (process: Process) => `process:${process.id}`;
const SUBPROCESS_KEY = (id: string) => `subprocess:${id}`;

interface ContainerContent {
  /** Flow nodes and data, in the order they are written in the diagram. */
  flowElements: XmlElement[];
  /** Sequence flows, written after the elements they join. */
  flows: XmlElement[];
  artifacts: XmlElement[];
}

/**
 * Writes `diagram` as a BPMN 2.0.2 XML document. With `geometry` the document carries a
 * `BPMNDiagram` placing each element and flow as given; without it, only the semantics.
 */
export function toBpmnXml(
  diagram: ParsedDiagram,
  geometry?: BpmnGeometry,
  options: BpmnXmlOptions = {}
): string {
  return new BpmnXmlWriter(diagram, geometry, options).write();
}

class BpmnXmlWriter {
  private readonly ids = new IdRegistry();
  private readonly byId: Map<string, ParsedNode>;
  /** The XML id of each element, by its id in the diagram. */
  private readonly xmlIds = new Map<string, string>();
  /** The XML id of each flow, by its index. */
  private readonly flowXmlIds = new Map<number, string>();
  private readonly processes: Process[] = [];
  private readonly processByPool = new Map<string, Process>();
  private defaultProcess: Process | undefined;
  private collaborationId: string | undefined;
  private readonly contents = new Map<ContainerKey, ContainerContent>();
  private readonly collaborationArtifacts: XmlElement[] = [];
  private readonly messageFlows: XmlElement[] = [];
  private readonly rootElements: XmlElement[] = [];
  /** Data inputs and outputs written into a process's ioSpecification, by process id. */
  private readonly processIo = new Map<string, { inputs: XmlElement[]; outputs: XmlElement[] }>();
  /** Data associations each activity carries, by the activity's id. */
  private readonly dataInputs = new Map<string, XmlElement[]>();
  private readonly dataOutputs = new Map<string, XmlElement[]>();
  /** The XML id the DI of each flow points at, by the flow's index. */
  private readonly flowDiTargets = new Map<number, string>();

  constructor(
    private readonly diagram: ParsedDiagram,
    private readonly geometry: BpmnGeometry | undefined,
    private readonly options: BpmnXmlOptions
  ) {
    this.byId = new Map(diagram.nodes.map((node) => [node.id, node]));
  }

  public write(): string {
    this.assignIds();
    this.assignProcesses();
    this.writeFlows();
    this.writeNodes();

    const definitions = element(
      'bpmn:definitions',
      {
        'xmlns:bpmn': BPMN_NAMESPACES.bpmn,
        'xmlns:bpmndi': BPMN_NAMESPACES.bpmndi,
        'xmlns:dc': BPMN_NAMESPACES.dc,
        'xmlns:di': BPMN_NAMESPACES.di,
        'xmlns:xsi': BPMN_NAMESPACES.xsi,
        id: this.ids.claim('Definitions_1'),
        name: nameOf(this.diagram.title),
        targetNamespace: TARGET_NAMESPACE,
        exporter: 'Mermaid bpmn-beta',
        exporterVersion: this.options.exporterVersion ?? '1.0',
      },
      [
        ...this.rootElements,
        this.collaborationElement(),
        ...this.processes.map((process) => this.processElement(process)),
        this.geometry ? this.diagramElement() : undefined,
      ]
    );
    const lines = ['<?xml version="1.0" encoding="UTF-8"?>'];
    serialise(definitions, 0, lines);
    return `${lines.join('\n')}\n`;
  }

  // -------------------------------------------------------------------------------------------
  // Structure.

  /** The authors' ids first, so a generated id never takes one of them. */
  private assignIds() {
    for (const node of this.diagram.nodes) {
      this.xmlIds.set(node.id, this.ids.claim(node.id));
    }
    for (const [index, flow] of this.diagram.flows.entries()) {
      if (flow.id) {
        this.flowXmlIds.set(index, this.ids.claim(flow.id));
      }
    }
  }

  private xmlId(id: string): string {
    return this.xmlIds.get(id) ?? toNcName(id);
  }

  private parentOf(node: ParsedNode): ParsedNode | undefined {
    return node.parentId ? this.byId.get(node.parentId) : undefined;
  }

  /** The ancestors of a node, nearest first. */
  private ancestorsOf(node: ParsedNode): ParsedNode[] {
    const ancestors: ParsedNode[] = [];
    const seen = new Set<string>([node.id]);
    let current = this.parentOf(node);
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      ancestors.push(current);
      current = this.parentOf(current);
    }
    return ancestors;
  }

  private isExpanded(node: ParsedNode): boolean {
    return (
      node.keyword === 'subprocess' &&
      (Boolean(node.expanded) ||
        this.diagram.nodes.some(
          (child) => child.parentId === node.id && child.keyword !== 'boundary'
        ))
    );
  }

  /**
   * The expanded sub-process an element is written in, as `bpmnDb.scopeOf` lays it out: a
   * boundary event belongs where its activity does.
   */
  private scopeOf(node: ParsedNode): string | undefined {
    let start = node;
    if (node.keyword === 'boundary') {
      start = this.parentOf(node) ?? node;
    }
    return this.ancestorsOf(start).find((ancestor) => this.isExpanded(ancestor))?.id;
  }

  private poolOf(node: ParsedNode): ParsedNode | undefined {
    return node.kind === 'pool' ? node : this.ancestorsOf(node).find((a) => a.kind === 'pool');
  }

  private processOf(node: ParsedNode): Process {
    const pool = this.poolOf(node);
    return (pool && this.processByPool.get(pool.id)) ?? this.ensureDefaultProcess();
  }

  private ensureDefaultProcess(): Process {
    if (!this.defaultProcess) {
      this.defaultProcess = {
        id: this.ids.claim(`Process_${this.processes.length + 1}`),
        name: nameOf(this.diagram.title),
      };
      this.processes.push(this.defaultProcess);
    }
    return this.defaultProcess;
  }

  private containerOf(node: ParsedNode): ContainerKey {
    const scope = this.scopeOf(node);
    return scope ? SUBPROCESS_KEY(scope) : PROCESS_KEY(this.processOf(node));
  }

  private content(key: ContainerKey): ContainerContent {
    let content = this.contents.get(key);
    if (!content) {
      content = { flowElements: [], flows: [], artifacts: [] };
      this.contents.set(key, content);
    }
    return content;
  }

  /** Whether an element is drawn around others rather than taking part: a group with members. */
  private isSpanningGroup(node: ParsedNode): boolean {
    return node.kind === 'group' && Boolean(node.members);
  }

  private assignProcesses() {
    const pools = this.diagram.nodes.filter((node) => node.kind === 'pool');
    for (const pool of pools) {
      const hasContent = this.diagram.nodes.some(
        (node) => node.kind !== 'pool' && this.poolOf(node)?.id === pool.id
      );
      if (hasContent) {
        const process: Process = {
          id: this.ids.claim(`Process_${pool.id}`),
          name: nameOf(pool.label),
          pool,
          participantId: this.xmlId(pool.id),
        };
        this.processes.push(process);
        this.processByPool.set(pool.id, process);
      }
    }
    const loose = this.diagram.nodes.some(
      (node) => node.kind !== 'pool' && !this.isSpanningGroup(node) && !this.poolOf(node)
    );
    if (loose || (this.processes.length === 0 && pools.length === 0)) {
      this.ensureDefaultProcess();
    }
    const hasMessageFlows = this.diagram.flows.some((flow) => flow.kind === 'message');
    if (pools.length > 0 || hasMessageFlows) {
      this.collaborationId = this.ids.claim('Collaboration_1');
      if (this.defaultProcess) {
        this.defaultProcess.participantId = this.ids.claim(`Participant_${this.defaultProcess.id}`);
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // Flows.

  private generatedFlowId(index: number, prefix: string): string {
    const existing = this.flowXmlIds.get(index);
    if (existing) {
      return existing;
    }
    const id = this.ids.claim(`${prefix}_${index + 1}`);
    this.flowXmlIds.set(index, id);
    return id;
  }

  private writeFlows() {
    for (const [index, flow] of this.diagram.flows.entries()) {
      const from = this.byId.get(flow.from);
      const to = this.byId.get(flow.to);
      if (flow.kind === 'sequence') {
        this.writeSequenceFlow(index, flow, from);
      } else if (flow.kind === 'message') {
        this.writeMessageFlow(index, flow);
      } else if (!this.writeDataAssociation(index, flow, from, to)) {
        this.writeAssociation(index, flow, from, to);
      }
    }
  }

  private writeSequenceFlow(index: number, flow: ParsedFlow, from: ParsedNode | undefined) {
    const id = this.generatedFlowId(index, 'Flow');
    const container = from ? this.containerOf(from) : PROCESS_KEY(this.ensureDefaultProcess());
    this.content(container).flows.push(
      element(
        'bpmn:sequenceFlow',
        {
          id,
          name: nameOf(flow.label ?? flow.condition),
          sourceRef: this.xmlId(flow.from),
          targetRef: this.xmlId(flow.to),
        },
        [
          flow.condition !== undefined &&
            element(
              'bpmn:conditionExpression',
              { 'xsi:type': 'bpmn:tFormalExpression' },
              [],
              flow.condition
            ),
        ]
      )
    );
    this.flowDiTargets.set(index, id);
  }

  private writeMessageFlow(index: number, flow: ParsedFlow) {
    const id = this.generatedFlowId(index, 'MessageFlow');
    let messageRef: string | undefined;
    if (flow.message) {
      messageRef = this.ids.claim(`Message_${id}`);
      this.rootElements.push(element('bpmn:message', { id: messageRef, name: nameOf(flow.label) }));
    }
    this.messageFlows.push(
      element('bpmn:messageFlow', {
        id,
        name: nameOf(flow.label),
        sourceRef: this.xmlId(flow.from),
        targetRef: this.xmlId(flow.to),
        messageRef,
      })
    );
    this.flowDiTargets.set(index, id);
  }

  /**
   * A directed association from a data object or store to an activity is the activity's data
   * input association, and one from an activity to a data object or store is its data output
   * association. Anything else stays an association.
   */
  private writeDataAssociation(
    index: number,
    flow: ParsedFlow,
    from: ParsedNode | undefined,
    to: ParsedNode | undefined
  ): boolean {
    if (!flow.directed || flow.bidirectional || !from || !to) {
      return false;
    }
    const isData = (node: ParsedNode) => node.kind === 'data' || node.kind === 'store';
    const isActivity = (node: ParsedNode) => node.kind === 'activity';
    if (isData(from) && isActivity(to)) {
      const id = this.generatedFlowId(index, 'DataInputAssociation');
      const list = this.dataInputs.get(to.id) ?? [];
      list.push(
        element('bpmn:dataInputAssociation', { id }, [
          element('bpmn:sourceRef', {}, [], this.xmlId(from.id)),
          // Filled in with the activity's placeholder property once its id is known.
          element('bpmn:targetRef', {}, [], ''),
        ])
      );
      this.dataInputs.set(to.id, list);
      this.flowDiTargets.set(index, id);
      return true;
    }
    if (isActivity(from) && isData(to)) {
      const id = this.generatedFlowId(index, 'DataOutputAssociation');
      const list = this.dataOutputs.get(from.id) ?? [];
      list.push(
        element('bpmn:dataOutputAssociation', { id }, [
          element('bpmn:targetRef', {}, [], this.xmlId(to.id)),
        ])
      );
      this.dataOutputs.set(from.id, list);
      this.flowDiTargets.set(index, id);
      return true;
    }
    return false;
  }

  private writeAssociation(
    index: number,
    flow: ParsedFlow,
    from: ParsedNode | undefined,
    to: ParsedNode | undefined
  ) {
    const id = this.generatedFlowId(index, 'Association');
    const association = element('bpmn:association', {
      id,
      sourceRef: this.xmlId(flow.from),
      targetRef: this.xmlId(flow.to),
      associationDirection: flow.bidirectional ? 'Both' : flow.directed ? 'One' : 'None',
    });
    this.flowDiTargets.set(index, id);
    const ends = [from, to].filter((node): node is ParsedNode => node !== undefined);
    const touchesParticipant = ends.some(
      (node) => node.kind === 'pool' || this.isSpanningGroup(node)
    );
    if (this.collaborationId && (touchesParticipant || ends.length < 2)) {
      this.collaborationArtifacts.push(association);
      return;
    }
    const [a, b] = ends;
    const containerA = a ? this.containerOf(a) : PROCESS_KEY(this.ensureDefaultProcess());
    const containerB = b ? this.containerOf(b) : containerA;
    if (containerA === containerB) {
      this.content(containerA).artifacts.push(association);
      return;
    }
    const processA = a ? this.processOf(a) : this.ensureDefaultProcess();
    const processB = b ? this.processOf(b) : processA;
    if (processA === processB || !this.collaborationId) {
      this.content(PROCESS_KEY(processA)).artifacts.push(association);
    } else {
      this.collaborationArtifacts.push(association);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Elements.

  private writeNodes() {
    // An expanded sub-process is written once everything inside it is.
    const order = [...this.diagram.nodes].sort((a, b) => this.depthOf(b) - this.depthOf(a));
    for (const node of order) {
      this.writeNode(node);
    }
  }

  private depthOf(node: ParsedNode): number {
    let depth = 0;
    let scope = this.scopeOf(node);
    const seen = new Set<string>();
    while (scope && !seen.has(scope)) {
      seen.add(scope);
      depth++;
      const owner = this.byId.get(scope);
      scope = owner ? this.scopeOf(owner) : undefined;
    }
    return depth;
  }

  private writeNode(node: ParsedNode) {
    const id = this.xmlId(node.id);
    const name = nameOf(node.label);
    switch (node.kind) {
      case 'pool':
      case 'lane':
        // Written with the collaboration and the lane sets.
        return;
      case 'group':
        this.writeGroup(node, id, name);
        return;
      case 'annotation':
        this.content(this.containerOf(node)).artifacts.push(
          element('bpmn:textAnnotation', { id }, [
            name !== undefined && element('bpmn:text', {}, [], name),
          ])
        );
        return;
      case 'store': {
        const storeId = this.ids.claim(`DataStore_${id}`);
        this.rootElements.push(element('bpmn:dataStore', { id: storeId, name }));
        this.content(this.containerOf(node)).flowElements.push(
          element('bpmn:dataStoreReference', { id, name, dataStoreRef: storeId })
        );
        return;
      }
      case 'data':
        this.writeData(node, id, name);
        return;
      case 'event':
        this.content(this.containerOf(node)).flowElements.push(this.eventElement(node, id, name));
        return;
      case 'gateway':
        this.content(this.containerOf(node)).flowElements.push(this.gatewayElement(node, id, name));
        return;
      case 'activity':
        this.content(this.containerOf(node)).flowElements.push(
          this.activityElement(node, id, name)
        );
        return;
    }
  }

  private writeGroup(node: ParsedNode, id: string, name: string | undefined) {
    const categoryId = this.ids.claim(`Category_${id}`);
    const valueId = this.ids.claim(`CategoryValue_${id}`);
    this.rootElements.push(
      element('bpmn:category', { id: categoryId }, [
        element('bpmn:categoryValue', { id: valueId, value: name }),
      ])
    );
    const group = element('bpmn:group', { id, categoryValueRef: valueId });
    if (this.isSpanningGroup(node) && this.collaborationId) {
      this.collaborationArtifacts.push(group);
    } else {
      this.content(this.containerOf(node)).artifacts.push(group);
    }
  }

  private dataState(node: ParsedNode, id: string): XmlElement | undefined {
    return node.state
      ? element('bpmn:dataState', { id: this.ids.claim(`DataState_${id}`), name: node.state })
      : undefined;
  }

  /**
   * A data object is a `dataObject` with a `dataObjectReference` that is drawn. A data input or
   * output of the process is a `dataInput` or `dataOutput` of the process's ioSpecification;
   * inside a sub-process, which has no such inputs, it is written as a data object.
   */
  private writeData(node: ParsedNode, id: string, name: string | undefined) {
    const container = this.containerOf(node);
    const direction = node.qualifier === 'input' || node.qualifier === 'output';
    if (direction && !this.scopeOf(node)) {
      const process = this.processOf(node);
      const io = this.processIo.get(process.id) ?? { inputs: [], outputs: [] };
      const list = node.qualifier === 'input' ? io.inputs : io.outputs;
      list.push(
        element(node.qualifier === 'input' ? 'bpmn:dataInput' : 'bpmn:dataOutput', { id, name }, [
          this.dataState(node, id),
        ])
      );
      this.processIo.set(process.id, io);
      return;
    }
    const objectId = this.ids.claim(`DataObject_${id}`);
    const content = this.content(container);
    content.flowElements.push(
      element('bpmn:dataObject', {
        id: objectId,
        isCollection: node.qualifier === 'collection' ? true : undefined,
      }),
      element('bpmn:dataObjectReference', { id, name, dataObjectRef: objectId }, [
        this.dataState(node, id),
      ])
    );
  }

  private flowRefs(node: ParsedNode): XmlElement[] {
    const refs: XmlElement[] = [];
    for (const [index, flow] of this.diagram.flows.entries()) {
      if (flow.kind !== 'sequence') {
        continue;
      }
      if (flow.to === node.id) {
        refs.push(element('bpmn:incoming', {}, [], this.flowXmlIds.get(index)));
      }
    }
    for (const [index, flow] of this.diagram.flows.entries()) {
      if (flow.kind === 'sequence' && flow.from === node.id) {
        refs.push(element('bpmn:outgoing', {}, [], this.flowXmlIds.get(index)));
      }
    }
    return refs;
  }

  private defaultFlowOf(node: ParsedNode): string | undefined {
    const index = this.diagram.flows.findIndex(
      (flow) => flow.kind === 'sequence' && flow.isDefault && flow.from === node.id
    );
    return index >= 0 ? this.flowXmlIds.get(index) : undefined;
  }

  private eventDefinitions(node: ParsedNode, id: string): XmlElement[] {
    const trigger = node.qualifier;
    if (!trigger || trigger === 'none') {
      return [];
    }
    const kinds =
      trigger === 'multiple' || trigger === 'parallel-multiple'
        ? MULTIPLE_DEFINITIONS
        : TRIGGER_DEFINITIONS[trigger]
          ? [TRIGGER_DEFINITIONS[trigger]]
          : [];
    return kinds.map((kind) => {
      const definitionId = this.ids.claim(`${kind.replace(/^\w/, (c) => c.toUpperCase())}_${id}`);
      if (kind === 'conditionalEventDefinition') {
        return element(`bpmn:${kind}`, { id: definitionId }, [
          element('bpmn:condition', { 'xsi:type': 'bpmn:tFormalExpression' }),
        ]);
      }
      if (kind === 'linkEventDefinition') {
        return element(`bpmn:${kind}`, { id: definitionId, name: nameOf(node.label) ?? id });
      }
      return element(`bpmn:${kind}`, { id: definitionId });
    });
  }

  private eventElement(node: ParsedNode, id: string, name: string | undefined): XmlElement {
    const position = node.keyword;
    const parallel = node.qualifier === 'parallel-multiple' && CATCHING_POSITIONS.has(position);
    return element(
      EVENT_ELEMENTS[position] ?? 'bpmn:intermediateThrowEvent',
      {
        id,
        name,
        ...(position === 'start' && node.nonInterrupting ? { isInterrupting: false } : {}),
        ...(position === 'boundary'
          ? {
              ...(node.nonInterrupting ? { cancelActivity: false } : {}),
              attachedToRef: node.parentId ? this.xmlId(node.parentId) : undefined,
            }
          : {}),
        ...(parallel ? { parallelMultiple: true } : {}),
      },
      [...this.flowRefs(node), ...this.eventDefinitions(node, id)]
    );
  }

  private gatewayElement(node: ParsedNode, id: string, name: string | undefined): XmlElement {
    return element(
      GATEWAY_ELEMENTS[node.keyword] ?? 'bpmn:exclusiveGateway',
      {
        id,
        name,
        ...(GATEWAYS_WITH_DEFAULT.has(node.keyword) ? { default: this.defaultFlowOf(node) } : {}),
        ...(node.instantiate ? { instantiate: true } : {}),
        ...(node.instantiate === 'parallel' ? { eventGatewayType: 'Parallel' } : {}),
      },
      this.flowRefs(node)
    );
  }

  private activityTag(node: ParsedNode): string {
    if (node.keyword === 'call') {
      return 'bpmn:callActivity';
    }
    if (node.keyword === 'subprocess') {
      if (node.subprocessKind === 'transaction') {
        return 'bpmn:transaction';
      }
      return node.adHoc ? 'bpmn:adHocSubProcess' : 'bpmn:subProcess';
    }
    return (node.qualifier && TASK_ELEMENTS[node.qualifier]) ?? 'bpmn:task';
  }

  private activityElement(node: ParsedNode, id: string, name: string | undefined): XmlElement {
    const tag = this.activityTag(node);
    const inputs = this.dataInputs.get(node.id) ?? [];
    let property: XmlElement | undefined;
    if (inputs.length) {
      // A data input association needs a target inside the activity; BPMN tools write a
      // placeholder property for it, and so does this.
      const propertyId = this.ids.claim(`Property_${id}`);
      property = element('bpmn:property', { id: propertyId, name: '__targetRef_placeholder' });
      for (const input of inputs) {
        const target = input.children.find((child) => child.name === 'bpmn:targetRef');
        if (target) {
          target.text = propertyId;
        }
      }
    }
    const loop =
      node.loop === 'loop'
        ? element('bpmn:standardLoopCharacteristics')
        : node.loop
          ? element('bpmn:multiInstanceLoopCharacteristics', {
              isSequential: node.loop === 'sequential' ? true : undefined,
            })
          : undefined;
    const inner = this.isExpanded(node) ? this.contents.get(SUBPROCESS_KEY(node.id)) : undefined;
    return element(
      tag,
      {
        id,
        name,
        ...(node.keyword === 'subprocess' && node.subprocessKind === 'event'
          ? { triggeredByEvent: true }
          : {}),
        ...(node.compensation ? { isForCompensation: true } : {}),
        default: this.defaultFlowOf(node),
      },
      [
        ...this.flowRefs(node),
        property,
        ...inputs,
        ...(this.dataOutputs.get(node.id) ?? []),
        loop,
        ...(inner ? [...inner.flowElements, ...inner.flows, ...inner.artifacts] : []),
      ]
    );
  }

  // -------------------------------------------------------------------------------------------
  // Root elements.

  private collaborationElement(): XmlElement | undefined {
    if (!this.collaborationId) {
      return undefined;
    }
    const participants: XmlElement[] = [];
    for (const node of this.diagram.nodes) {
      if (node.kind !== 'pool') {
        continue;
      }
      participants.push(
        element(
          'bpmn:participant',
          {
            id: this.xmlId(node.id),
            name: nameOf(node.label),
            processRef: this.processByPool.get(node.id)?.id,
          },
          [
            node.multiple &&
              // A pool of several participants: at least two. The maximum is unbounded in the
              // notation, but defaults to 1 in the schema, so it is written as the largest int.
              element('bpmn:participantMultiplicity', { minimum: 2, maximum: 2147483647 }),
          ]
        )
      );
    }
    if (this.defaultProcess?.participantId) {
      participants.push(
        element('bpmn:participant', {
          id: this.defaultProcess.participantId,
          name: this.defaultProcess.name,
          processRef: this.defaultProcess.id,
        })
      );
    }
    return element('bpmn:collaboration', { id: this.collaborationId }, [
      ...participants,
      ...this.messageFlows,
      ...this.collaborationArtifacts,
    ]);
  }

  /** The lanes a flow node is in, nearest last; a node in a nested lane is in its parent too. */
  private lanesOf(node: ParsedNode): ParsedNode[] {
    return this.ancestorsOf(node).filter((ancestor) => ancestor.kind === 'lane');
  }

  private laneSetElement(
    process: Process,
    parentLane: ParsedNode | undefined
  ): XmlElement | undefined {
    const lanes = this.diagram.nodes.filter((node) => {
      if (node.kind !== 'lane' || this.processOf(node) !== process) {
        return false;
      }
      const nearest = this.lanesOf(node)[0];
      return parentLane ? nearest?.id === parentLane.id : nearest === undefined;
    });
    if (!lanes.length) {
      return undefined;
    }
    const base = parentLane ? `LaneSet_${this.xmlId(parentLane.id)}` : `LaneSet_${process.id}`;
    return element(
      parentLane ? 'bpmn:childLaneSet' : 'bpmn:laneSet',
      { id: this.ids.claim(base) },
      lanes.map((lane) => {
        const members = this.diagram.nodes.filter(
          (node) =>
            (node.kind === 'event' || node.kind === 'gateway' || node.kind === 'activity') &&
            this.scopeOf(node) === undefined &&
            this.lanesOf(node).some((ancestor) => ancestor.id === lane.id)
        );
        return element('bpmn:lane', { id: this.xmlId(lane.id), name: nameOf(lane.label) }, [
          ...members.map((member) => element('bpmn:flowNodeRef', {}, [], this.xmlId(member.id))),
          this.laneSetElement(process, lane),
        ]);
      })
    );
  }

  private processElement(process: Process): XmlElement {
    const content = this.content(PROCESS_KEY(process));
    const io = this.processIo.get(process.id);
    const ioSpecification = io
      ? element('bpmn:ioSpecification', { id: this.ids.claim(`IoSpecification_${process.id}`) }, [
          ...io.inputs,
          ...io.outputs,
          element(
            'bpmn:inputSet',
            { id: this.ids.claim(`InputSet_${process.id}`) },
            io.inputs.map((input) => element('bpmn:dataInputRefs', {}, [], input.attributes[0][1]))
          ),
          element(
            'bpmn:outputSet',
            { id: this.ids.claim(`OutputSet_${process.id}`) },
            io.outputs.map((output) =>
              element('bpmn:dataOutputRefs', {}, [], output.attributes[0][1])
            )
          ),
        ])
      : undefined;
    return element('bpmn:process', { id: process.id, name: process.name, isExecutable: false }, [
      ioSpecification,
      this.laneSetElement(process, undefined),
      ...content.flowElements,
      ...content.flows,
      ...content.artifacts,
    ]);
  }

  // -------------------------------------------------------------------------------------------
  // Diagram interchange.

  private bounds(box: BpmnBounds): XmlElement {
    return element('dc:Bounds', {
      x: round(box.x),
      y: round(box.y),
      width: round(box.width),
      height: round(box.height),
    });
  }

  private unionOf(boxes: BpmnBounds[]): BpmnBounds | undefined {
    if (!boxes.length) {
      return undefined;
    }
    const left = Math.min(...boxes.map((b) => b.x));
    const top = Math.min(...boxes.map((b) => b.y));
    const right = Math.max(...boxes.map((b) => b.x + b.width));
    const bottom = Math.max(...boxes.map((b) => b.y + b.height));
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  private diagramElement(): XmlElement {
    const geometry = this.geometry!;
    const horizontal = !['TB', 'TD', 'BT'].includes(this.diagram.direction);
    const shapes: XmlElement[] = [];
    const shape = (
      bpmnElement: string,
      box: BpmnBounds | undefined,
      attributes: Record<string, AttributeValue> = {}
    ) => {
      if (!box) {
        return;
      }
      shapes.push(
        element(
          'bpmndi:BPMNShape',
          { id: this.ids.claim(`${bpmnElement}_di`), bpmnElement, ...attributes },
          [this.bounds(box)]
        )
      );
    };

    // The participant of what lies outside every pool has no pool drawn: it is drawn around
    // what it holds, with a band for its name.
    if (this.defaultProcess?.participantId) {
      const inside = this.diagram.nodes
        .filter((node) => node.kind !== 'pool' && !this.isSpanningGroup(node) && !this.poolOf(node))
        .map((node) => geometry.shapes[node.id])
        .filter((box): box is BpmnBounds => box !== undefined);
      const union = this.unionOf(inside);
      const hasLanes = this.diagram.nodes.some(
        (node) => node.kind === 'lane' && !this.poolOf(node)
      );
      const pad = hasLanes ? 0 : 20;
      const band = 30;
      shape(
        this.defaultProcess.participantId,
        union && {
          x: union.x - pad - (horizontal ? band : 0),
          y: union.y - pad - (horizontal ? 0 : band),
          width: union.width + 2 * pad + (horizontal ? band : 0),
          height: union.height + 2 * pad + (horizontal ? 0 : band),
        },
        { isHorizontal: horizontal }
      );
    }

    const ordered = [
      ...this.diagram.nodes.filter((node) => node.kind === 'pool'),
      ...this.diagram.nodes.filter((node) => node.kind === 'lane'),
      ...this.diagram.nodes.filter((node) => node.kind !== 'pool' && node.kind !== 'lane'),
    ];
    for (const node of ordered) {
      const box = geometry.shapes[node.id];
      const id = this.xmlId(node.id);
      if (node.kind === 'pool' || node.kind === 'lane') {
        shape(id, box, { isHorizontal: horizontal });
      } else if (node.kind === 'activity' && node.keyword !== 'task') {
        shape(id, box, { isExpanded: this.isExpanded(node) });
      } else if (node.kind === 'gateway' && node.keyword === 'xor') {
        shape(id, box, { isMarkerVisible: !node.unmarked });
      } else {
        shape(id, box);
      }
    }

    const edges: XmlElement[] = [];
    for (const [index, flow] of this.diagram.flows.entries()) {
      const target = this.flowDiTargets.get(index);
      if (!target) {
        continue;
      }
      let points = geometry.edges[index];
      if (!points || points.length < 2) {
        const centre = (id: string) => {
          const box = geometry.shapes[id];
          return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : undefined;
        };
        const a = centre(flow.from);
        const b = centre(flow.to);
        if (!a || !b) {
          continue;
        }
        points = [a, b];
      }
      edges.push(
        element(
          'bpmndi:BPMNEdge',
          {
            id: this.ids.claim(`${target}_di`),
            bpmnElement: target,
            ...(flow.message
              ? {
                  messageVisibleKind:
                    flow.message === 'initiating' ? 'initiating' : 'non_initiating',
                }
              : {}),
          },
          points.map((point) => element('di:waypoint', { x: round(point.x), y: round(point.y) }))
        )
      );
    }

    const planeElement = this.collaborationId ?? this.processes[0]?.id;
    return element('bpmndi:BPMNDiagram', { id: this.ids.claim('BPMNDiagram_1') }, [
      element(
        'bpmndi:BPMNPlane',
        { id: this.ids.claim('BPMNPlane_1'), bpmnElement: planeElement },
        [...shapes, ...edges]
      ),
    ]);
  }
}
