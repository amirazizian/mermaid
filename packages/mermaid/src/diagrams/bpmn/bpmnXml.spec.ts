import { describe, expect, it } from 'vitest';
import { parseBpmn } from './parser/bpmn.parser.js';
import { BPMN_NAMESPACES, toBpmnXml, toNcName } from './bpmnXml.js';
import type { BpmnGeometry } from './bpmnXml.js';
import type { ParsedDiagram } from './parser/bpmn.parser.js';

const { bpmn: BPMN, bpmndi: BPMNDI, dc: DC, di: DI, xsi: XSI } = BPMN_NAMESPACES;

/** Parses the XML, failing on anything that is not well-formed. */
const read = (xml: string): Document => {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const error = doc.getElementsByTagName('parsererror')[0];
  if (error) {
    throw new Error(`not well-formed: ${error.textContent}\n${xml}`);
  }
  return doc;
};

const all = (doc: Document | Element, name: string, ns: string = BPMN): Element[] => [
  ...doc.getElementsByTagNameNS(ns, name),
];

const byId = (doc: Document, id: string): Element => {
  const found = [...doc.getElementsByTagName('*')].filter((el) => el.getAttribute('id') === id);
  expect(found, `one element with id ${id}`).toHaveLength(1);
  return found[0];
};

const exportText = (text: string, geometry?: BpmnGeometry) => {
  const diagram = parseBpmn(text);
  const xml = toBpmnXml(diagram, geometry);
  return { diagram, xml, doc: read(xml) };
};

/** A geometry that places every element on a grid and joins each flow's ends. */
const gridGeometry = (diagram: ParsedDiagram): BpmnGeometry => {
  const shapes: BpmnGeometry['shapes'] = {};
  diagram.nodes.forEach((node, index) => {
    shapes[node.id] = { x: 100 * index, y: 10 * index, width: 50, height: 40 };
  });
  const edges: BpmnGeometry['edges'] = {};
  diagram.flows.forEach((flow, index) => {
    const a = shapes[flow.from];
    const b = shapes[flow.to];
    edges[index] = [
      { x: a.x + 50, y: a.y + 20 },
      { x: b.x, y: b.y + 20 },
    ];
  });
  return { shapes, edges };
};

/** Every id is unique and every reference names an element of the document. */
const expectReferencesResolve = (doc: Document) => {
  const ids = [...doc.getElementsByTagName('*')]
    .map((el) => el.getAttribute('id'))
    .filter((id): id is string => id !== null);
  expect(new Set(ids).size).toBe(ids.length);
  const known = new Set(ids);
  const refAttributes = [
    'sourceRef',
    'targetRef',
    'attachedToRef',
    'processRef',
    'bpmnElement',
    'default',
    'categoryValueRef',
    'dataObjectRef',
    'dataStoreRef',
    'messageRef',
  ];
  for (const el of doc.getElementsByTagName('*')) {
    for (const attribute of refAttributes) {
      const value = el.getAttribute(attribute);
      if (value !== null) {
        expect(known, `${el.localName}@${attribute}=${value}`).toContain(value);
      }
    }
    if (
      [
        'flowNodeRef',
        'incoming',
        'outgoing',
        'sourceRef',
        'targetRef',
        'dataInputRefs',
        'dataOutputRefs',
      ].includes(el.localName) &&
      el.namespaceURI === BPMN
    ) {
      expect(known, `${el.localName} ${el.textContent}`).toContain(el.textContent);
    }
  }
};

describe('toBpmnXml', () => {
  it('writes definitions with the BPMN namespaces and a single process without pools', () => {
    const { doc, xml } = exportText(`bpmn-beta LR
title Order <handling> & "more"
  lane "Sales"
    start s1 "Order received"
    task t1 "Check"
    end e1 "Done"
  s1 --> t1 --> e1`);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    const definitions = doc.documentElement;
    expect(definitions.localName).toBe('definitions');
    expect(definitions.namespaceURI).toBe(BPMN);
    expect(definitions.getAttribute('targetNamespace')).toBeTruthy();
    expect(definitions.getAttribute('exporter')).toBeTruthy();
    expect(definitions.getAttribute('exporterVersion')).toBeTruthy();
    expect(definitions.getAttribute('name')).toBe('Order <handling> & "more"');
    expect(definitions.lookupNamespaceURI('bpmndi')).toBe(BPMNDI);
    expect(definitions.lookupNamespaceURI('dc')).toBe(DC);
    expect(definitions.lookupNamespaceURI('di')).toBe(DI);
    expect(definitions.lookupNamespaceURI('xsi')).toBe(XSI);
    expect(all(doc, 'collaboration')).toHaveLength(0);
    expect(all(doc, 'process')).toHaveLength(1);
    const lane = byId(doc, 'lane-1');
    expect(lane.localName).toBe('lane');
    expect(all(lane, 'flowNodeRef').map((ref) => ref.textContent)).toEqual(['s1', 't1', 'e1']);
    // Semantics only without geometry.
    expect(all(doc, 'BPMNDiagram', BPMNDI)).toHaveLength(0);
    expectReferencesResolve(doc);
  });

  it('writes every event position and trigger', () => {
    const { doc } = exportText(`bpmn-beta LR
  lane "Events"
    start message a1 "Message"
    start timer a2
    start conditional a3
    start parallel-multiple a4
    intermediate link a5 "Go on"
    intermediate multiple a6
    throw a7
    throw signal a8
    end terminate a9
    end cancel a10
    end compensation a11
    end error a12
    end escalation a13
    end multiple a14
    task t1 "Work"
      boundary timer b1 "Late" @{ interrupting: false }
      boundary error b2 "Failed"`);
    const tag = (id: string) => byId(doc, id).localName;
    const definitions = (id: string) => [...byId(doc, id).children].map((c) => c.localName);
    expect(tag('a1')).toBe('startEvent');
    expect(definitions('a1')).toEqual(['messageEventDefinition']);
    expect(definitions('a2')).toEqual(['timerEventDefinition']);
    const conditional = all(byId(doc, 'a3'), 'conditionalEventDefinition')[0];
    expect(all(conditional, 'condition')).toHaveLength(1);
    expect(byId(doc, 'a4').getAttribute('parallelMultiple')).toBe('true');
    expect(all(byId(doc, 'a4'), '*').length).toBeGreaterThanOrEqual(2);
    expect(tag('a5')).toBe('intermediateCatchEvent');
    expect(all(byId(doc, 'a5'), 'linkEventDefinition')[0].getAttribute('name')).toBe('Go on');
    expect(definitions('a6').length).toBeGreaterThanOrEqual(2);
    expect(byId(doc, 'a6').hasAttribute('parallelMultiple')).toBe(false);
    expect(tag('a7')).toBe('intermediateThrowEvent');
    expect(definitions('a7')).toEqual([]);
    expect(definitions('a8')).toEqual(['signalEventDefinition']);
    expect(tag('a9')).toBe('endEvent');
    expect(definitions('a9')).toEqual(['terminateEventDefinition']);
    expect(definitions('a10')).toEqual(['cancelEventDefinition']);
    expect(definitions('a11')).toEqual(['compensateEventDefinition']);
    expect(definitions('a12')).toEqual(['errorEventDefinition']);
    expect(definitions('a13')).toEqual(['escalationEventDefinition']);
    expect(definitions('a14').length).toBeGreaterThanOrEqual(2);
    const b1 = byId(doc, 'b1');
    expect(b1.localName).toBe('boundaryEvent');
    expect(b1.getAttribute('attachedToRef')).toBe('t1');
    expect(b1.getAttribute('cancelActivity')).toBe('false');
    expect(byId(doc, 'b2').hasAttribute('cancelActivity')).toBe(false);
    expectReferencesResolve(doc);
  });

  it('writes task types, call activities, loop markers and compensation', () => {
    const { doc } = exportText(`bpmn-beta LR
  lane "Work"
    task t0
    user task t1
    service task t2
    receive task t3
    send task t4
    manual task t5
    script task t6
    rule task t7
    call c1 "Invoicing" @{ calls: process }
    task l1 @{ marker: loop }
    task l2 @{ marker: parallel }
    task l3 @{ marker: [sequential, compensation] }
    subprocess s1 @{ marker: ad-hoc }`);
    const tags = ['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7', 'c1'].map(
      (id) => byId(doc, id).localName
    );
    expect(tags).toEqual([
      'task',
      'userTask',
      'serviceTask',
      'receiveTask',
      'sendTask',
      'manualTask',
      'scriptTask',
      'businessRuleTask',
      'callActivity',
    ]);
    expect(all(byId(doc, 'l1'), 'standardLoopCharacteristics')).toHaveLength(1);
    const parallel = all(byId(doc, 'l2'), 'multiInstanceLoopCharacteristics')[0];
    expect(parallel.hasAttribute('isSequential')).toBe(false);
    const sequential = all(byId(doc, 'l3'), 'multiInstanceLoopCharacteristics')[0];
    expect(sequential.getAttribute('isSequential')).toBe('true');
    expect(byId(doc, 'l3').getAttribute('isForCompensation')).toBe('true');
    expect(byId(doc, 's1').localName).toBe('adHocSubProcess');
  });

  it('writes gateways with their default flow, and conditions and names on flows', () => {
    const { doc } = exportText(`bpmn-beta LR
  lane "Decide"
    task t1 "Price"
    xor g1 "Method?"
    or g2
    and g3
    complex g4
    event-gateway g5 @{ instantiate: true }
    event-gateway g6 @{ instantiate: parallel }
    task a
    task b
    task c
  t1 --> g1
  t1 big@--> c
  big@{ condition: "total > 5000" }
  g1 c1@-- card --> a
  g1 inv@--> b
  inv@{ default: true }
  t1 dt@--> b
  dt@{ default: true }`);
    expect(byId(doc, 'g1').localName).toBe('exclusiveGateway');
    expect(byId(doc, 'g1').getAttribute('default')).toBe('inv');
    expect(byId(doc, 't1').getAttribute('default')).toBe('dt');
    expect(byId(doc, 'g2').localName).toBe('inclusiveGateway');
    expect(byId(doc, 'g3').localName).toBe('parallelGateway');
    expect(byId(doc, 'g4').localName).toBe('complexGateway');
    expect(byId(doc, 'g5').localName).toBe('eventBasedGateway');
    expect(byId(doc, 'g5').getAttribute('instantiate')).toBe('true');
    expect(byId(doc, 'g5').hasAttribute('eventGatewayType')).toBe(false);
    expect(byId(doc, 'g6').getAttribute('eventGatewayType')).toBe('Parallel');
    const big = byId(doc, 'big');
    expect(big.localName).toBe('sequenceFlow');
    const condition = all(big, 'conditionExpression')[0];
    expect(condition.getAttributeNS(XSI, 'type')).toBe('bpmn:tFormalExpression');
    expect(condition.textContent).toBe('total > 5000');
    expect(byId(doc, 'c1').getAttribute('name')).toBe('card');
    // A flow without an id gets a generated one, and the elements list their flows.
    expect(byId(doc, 'Flow_1').getAttribute('sourceRef')).toBe('t1');
    expect(all(byId(doc, 'g1'), 'incoming').map((el) => el.textContent)).toEqual(['Flow_1']);
    expect(all(byId(doc, 'g1'), 'outgoing').map((el) => el.textContent)).toEqual(['c1', 'inv']);
    expectReferencesResolve(doc);
  });

  it('writes pools as participants, black boxes without a process, and message flows', () => {
    const { doc } = exportText(`bpmn-beta LR
  pool shop "Shop"
    lane sales "Sales"
      task t1 "Charge"
    lane "Warehouse"
      end e1 "Done"
  pool bank "Bank"
  pool suppliers "Suppliers" @{ multiple: true }
  t1 --> e1
  t1 m1@-.-> bank
  m1@{ label: "Charge", message: initiating }
  bank -.-> e1
  t1 -.-> suppliers`);
    const collaboration = all(doc, 'collaboration')[0];
    const participants = all(collaboration, 'participant');
    expect(participants.map((p) => p.getAttribute('id'))).toEqual(['shop', 'bank', 'suppliers']);
    expect(byId(doc, 'shop').getAttribute('processRef')).toBe('Process_shop');
    expect(byId(doc, 'bank').hasAttribute('processRef')).toBe(false);
    const multiplicity = all(byId(doc, 'suppliers'), 'participantMultiplicity')[0];
    expect(multiplicity.getAttribute('minimum')).toBe('2');
    expect(all(doc, 'process')).toHaveLength(1);
    const laneSet = all(byId(doc, 'Process_shop'), 'laneSet')[0];
    expect(all(laneSet, 'lane').map((lane) => lane.getAttribute('name'))).toEqual([
      'Sales',
      'Warehouse',
    ]);
    const m1 = byId(doc, 'm1');
    expect(m1.localName).toBe('messageFlow');
    expect(m1.parentElement).toBe(collaboration);
    expect(m1.getAttribute('name')).toBe('Charge');
    const message = byId(doc, m1.getAttribute('messageRef')!);
    expect(message.localName).toBe('message');
    expect(message.parentElement).toBe(doc.documentElement);
    expect(byId(doc, 'MessageFlow_3').hasAttribute('messageRef')).toBe(false);
    expectReferencesResolve(doc);
  });

  it('puts what lies outside every pool into a participant of its own', () => {
    const { doc } = exportText(`bpmn-beta LR
  pool shop "Shop"
    task t1
  lane "Loose"
    task t2
  t1 -.-> t2`);
    const participants = all(doc, 'participant');
    expect(participants).toHaveLength(2);
    expect(all(doc, 'process')).toHaveLength(2);
    expectReferencesResolve(doc);
  });

  it('writes expanded sub-processes with their content, event sub-processes and transactions', () => {
    const { doc, diagram } = exportText(`bpmn-beta LR
  lane "Bookings"
    start s1
    subprocess tx "Book" @{ kind: transaction }
      start t0
      subprocess inner "Hotel"
        task h1
      end t3
      t0 --> inner --> t3
      boundary cancel tc "Cancelled"
    subprocess ev "Cancels" @{ kind: event }
      start message ev1 @{ interrupting: false }
      end ev2
      ev1 --> ev2
    subprocess col "Collapsed"
    end e1
  s1 --> tx --> col --> e1`);
    const tx = byId(doc, 'tx');
    expect(tx.localName).toBe('transaction');
    expect(byId(doc, 't0').parentElement).toBe(tx);
    expect(byId(doc, 'h1').parentElement).toBe(byId(doc, 'inner'));
    const innerFlow = all(tx, 'sequenceFlow').find((f) => f.getAttribute('sourceRef') === 't0');
    expect(innerFlow?.parentElement).toBe(tx);
    // A boundary event sits beside its activity, not inside it.
    expect(byId(doc, 'tc').parentElement).toBe(tx.parentElement);
    expect(byId(doc, 'tc').getAttribute('attachedToRef')).toBe('tx');
    const ev = byId(doc, 'ev');
    expect(ev.localName).toBe('subProcess');
    expect(ev.getAttribute('triggeredByEvent')).toBe('true');
    expect(byId(doc, 'ev1').getAttribute('isInterrupting')).toBe('false');
    // Only top-level flow nodes are listed in the lane.
    const refs = all(doc, 'flowNodeRef').map((ref) => ref.textContent);
    expect(refs).toContain('tx');
    expect(refs).toContain('tc');
    expect(refs).not.toContain('t0');

    const withDi = read(toBpmnXml(diagram, gridGeometry(diagram)));
    const shape = (id: string) =>
      all(withDi, 'BPMNShape', BPMNDI).find((s) => s.getAttribute('bpmnElement') === id)!;
    expect(shape('tx').getAttribute('isExpanded')).toBe('true');
    expect(shape('inner').getAttribute('isExpanded')).toBe('true');
    expect(shape('col').getAttribute('isExpanded')).toBe('false');
    expectReferencesResolve(doc);
  });

  it('writes data objects, stores, inputs and outputs, and data associations', () => {
    const { doc } = exportText(`bpmn-beta LR
  pool p "Orders"
    lane "Sales"
      data-input in1 "Order form"
      data-output out1 "Approval"
      data-collection many "Line items"
      data d1 "Order" @{ state: approved }
      data-store ds "Inventory"
      user task t1 "Check"
      note n1 "Nightly"
      end e1
  in1 ..> t1
  t1 ..> out1
  many ..> t1
  t1 ..> ds
  d1 ... t1
  n1 ... e1
  t1 --> e1`);
    const process = byId(doc, 'Process_p');
    const io = all(process, 'ioSpecification')[0];
    expect(byId(doc, 'in1').localName).toBe('dataInput');
    expect(byId(doc, 'in1').parentElement).toBe(io);
    expect(byId(doc, 'out1').localName).toBe('dataOutput');
    expect(all(io, 'dataInputRefs')[0].textContent).toBe('in1');
    expect(all(io, 'dataOutputRefs')[0].textContent).toBe('out1');

    const many = byId(doc, 'many');
    expect(many.localName).toBe('dataObjectReference');
    expect(byId(doc, many.getAttribute('dataObjectRef')!).getAttribute('isCollection')).toBe(
      'true'
    );
    const d1 = byId(doc, 'd1');
    expect(all(d1, 'dataState')[0].getAttribute('name')).toBe('approved');
    const ds = byId(doc, 'ds');
    expect(ds.localName).toBe('dataStoreReference');
    const store = byId(doc, ds.getAttribute('dataStoreRef')!);
    expect(store.localName).toBe('dataStore');
    expect(store.parentElement).toBe(doc.documentElement);

    const t1 = byId(doc, 't1');
    const inputs = all(t1, 'dataInputAssociation');
    expect(inputs.map((a) => all(a, 'sourceRef')[0].textContent)).toEqual(['in1', 'many']);
    const property = all(t1, 'property')[0];
    expect(
      inputs.every((a) => all(a, 'targetRef')[0].textContent === property.getAttribute('id'))
    ).toBe(true);
    const outputs = all(t1, 'dataOutputAssociation');
    expect(outputs.map((a) => all(a, 'targetRef')[0].textContent)).toEqual(['out1', 'ds']);
    // An undirected association stays an association.
    const associations = all(doc, 'association');
    expect(associations.map((a) => a.getAttribute('associationDirection'))).toEqual([
      'None',
      'None',
    ]);
    expect(byId(doc, 'n1').localName).toBe('textAnnotation');
    expect(all(byId(doc, 'n1'), 'text')[0].textContent).toBe('Nightly');
    expectReferencesResolve(doc);
  });

  it('writes association directions and groups with category values', () => {
    const { doc } = exportText(`bpmn-beta LR
  pool shop "Shop"
    lane "Sales"
      group g1 "Approval"
        task t1
      task t2
      note n1 "A note"
  pool carrier "Carrier"
    lane "Dispatch"
      task t3
  group span "Shipping" @{ members: [t2, t3] }
  n1 a1@... t1
  a1@{ direction: both }
  n1 ..> t2
  t1 --> t2`);
    expect(byId(doc, 'a1').getAttribute('associationDirection')).toBe('Both');
    const directed = all(doc, 'association').find((a) => a.getAttribute('targetRef') === 't2');
    expect(directed?.getAttribute('associationDirection')).toBe('One');
    const g1 = byId(doc, 'g1');
    expect(g1.localName).toBe('group');
    expect(g1.parentElement?.localName).toBe('process');
    const value = byId(doc, g1.getAttribute('categoryValueRef')!);
    expect(value.localName).toBe('categoryValue');
    expect(value.getAttribute('value')).toBe('Approval');
    // A group across pools belongs to the collaboration.
    expect(byId(doc, 'span').parentElement?.localName).toBe('collaboration');
    expectReferencesResolve(doc);
  });

  it('writes the diagram interchange from the geometry', () => {
    const text = `bpmn-beta TB
  pool p "Pool"
    lane l1 "Lane"
      start s1
      xor g1 @{ marker: none }
      xor g2
      task t1
  pool b "Black box"
  s1 --> g1 --> g2 --> t1
  t1 m1@-.-> b
  m1@{ message: non-initiating }`;
    const diagram = parseBpmn(text);
    const geometry = gridGeometry(diagram);
    geometry.edges[0] = [
      { x: 1.234, y: 2 },
      { x: 3, y: 4 },
      { x: 5, y: 6 },
    ];
    delete geometry.edges[1];
    const doc = read(toBpmnXml(diagram, geometry));
    const plane = all(doc, 'BPMNPlane', BPMNDI)[0];
    expect(plane.getAttribute('bpmnElement')).toBe(all(doc, 'collaboration')[0].getAttribute('id'));
    const shapes = all(plane, 'BPMNShape', BPMNDI);
    expect(shapes.map((s) => s.getAttribute('bpmnElement')).sort()).toEqual(
      diagram.nodes.map((n) => n.id).sort()
    );
    const shape = (id: string) => shapes.find((s) => s.getAttribute('bpmnElement') === id)!;
    expect(shape('p').getAttribute('isHorizontal')).toBe('false');
    expect(shape('l1').getAttribute('isHorizontal')).toBe('false');
    expect(shape('g1').getAttribute('isMarkerVisible')).toBe('false');
    expect(shape('g2').getAttribute('isMarkerVisible')).toBe('true');
    const bounds = all(shape('t1'), 'Bounds', DC)[0];
    const index = diagram.nodes.findIndex((n) => n.id === 't1');
    expect(Number(bounds.getAttribute('x'))).toBe(100 * index);
    expect(Number(bounds.getAttribute('width'))).toBe(50);

    const edges = all(plane, 'BPMNEdge', BPMNDI);
    expect(edges).toHaveLength(diagram.flows.length);
    const waypoints = all(edges[0], 'waypoint', DI);
    expect(waypoints.map((w) => [w.getAttribute('x'), w.getAttribute('y')])).toEqual([
      ['1.23', '2'],
      ['3', '4'],
      ['5', '6'],
    ]);
    // A flow without measured points joins its shapes' centres.
    expect(all(edges[1], 'waypoint', DI)).toHaveLength(2);
    const message = edges.find((e) => e.getAttribute('bpmnElement') === 'm1');
    expect(message?.getAttribute('messageVisibleKind')).toBe('non_initiating');
    expectReferencesResolve(doc);
  });

  it('keeps the authors ids, sanitises and de-duplicates generated ones, and escapes text', () => {
    expect(toNcName('1abc')).toBe('_1abc');
    expect(toNcName('a b/c')).toBe('a_b_c');
    const diagram: ParsedDiagram = {
      direction: 'LR',
      nodes: [
        { kind: 'event', keyword: 'start', id: 'Flow_1', label: 'A & B <x>', level: 0 },
        { kind: 'activity', keyword: 'task', id: '9 lives', label: 'line<br>break', level: 0 },
      ],
      flows: [
        { from: 'Flow_1', to: '9 lives', kind: 'sequence', label: 'say "hi"\'' },
        { from: 'Flow_1', to: '9 lives', kind: 'sequence', id: 'f\u0001' },
      ],
    };
    const xml = toBpmnXml(diagram);
    const doc = read(xml);
    expect(byId(doc, 'Flow_1').getAttribute('name')).toBe('A & B <x>');
    expect(byId(doc, '_9_lives').getAttribute('name')).toBe('line\nbreak');
    const flows = all(doc, 'sequenceFlow');
    expect(flows[0].getAttribute('id')).toBe('Flow_1_2');
    expect(flows[0].getAttribute('name')).toBe('say "hi"\'');
    expect(flows[0].getAttribute('targetRef')).toBe('_9_lives');
    expect(flows[1].getAttribute('id')).toBe('f_');
    expectReferencesResolve(doc);
  });
});
