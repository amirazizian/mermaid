import { describe, it, expect } from 'vitest';
import { BpmnDb } from './bpmnDb.js';
import { parseBpmn } from './parser/bpmn.parser.js';

const inLane = (...lines: string[]) =>
  ['bpmn-beta LR', '  lane "L"', ...lines.map((line) => `    ${line}`)].join('\n');

const nodes = (source: string) => new Map(parseBpmn(source).nodes.map((n) => [n.id, n]));

const refusal = (source: string) => {
  try {
    parseBpmn(source);
  } catch (error) {
    return (error as Error).message;
  }
  return undefined;
};

const db = (source: string) => {
  const built = new BpmnDb();
  built.parse(source);
  return built;
};

const EXPANDED = inLane(
  'start s "S"',
  'subprocess sp "Handle"',
  '  start a "A"',
  '  task b "B"',
  '  end c "C"',
  '  a --> b --> c',
  '  boundary timer late "Late" @{ interrupting: false }',
  'task t "T"',
  'end e "E"',
  's --> sp --> t --> e',
  'late --> t'
);

describe('expanded sub-processes', () => {
  it('reads a sub-process with elements indented under it as expanded', () => {
    const read = nodes(EXPANDED);
    expect(read.get('sp')?.expanded).toBe(true);
    expect(read.get('a')?.parentId).toBe('sp');
    expect(read.get('late')).toMatchObject({ parentId: 'sp', nonInterrupting: true });
  });

  it('keeps a sub-process with only a boundary event under it collapsed', () => {
    const read = nodes(inLane('subprocess sp "S"', '  boundary timer b "B"'));
    expect(read.get('sp')?.expanded).toBeUndefined();
  });

  it('lays the diagram out with the sub-process as one framed node', () => {
    const data = db(EXPANDED).getData({ frames: new Map([['sp', { width: 300, height: 100 }]]) });
    const ids = data.nodes.map((node) => node.id);
    expect(ids).toEqual(['lane-1', 's', 'sp', 'late', 't', 'e']);
    const frame = data.nodes.find((node) => node.id === 'sp');
    expect(frame).toMatchObject({ shape: 'bpmn-subprocess-frame', isGroup: false });
    expect(frame?.metadata).toMatchObject({
      frameBorder: 'solid',
      content: { width: 300, height: 100 },
    });
    expect(data.edges.map((edge) => [edge.start, edge.end])).toEqual([
      ['s', 'sp'],
      ['sp', 't'],
      ['t', 'e'],
      ['late', 't'],
    ]);
  });

  it('lays the inside of a sub-process out on its own, with no lane', () => {
    const data = db(EXPANDED).getData({ scope: 'sp' });
    expect(data.nodes.map((node) => [node.id, node.parentId])).toEqual([
      ['a', undefined],
      ['b', undefined],
      ['c', undefined],
    ]);
    expect(data.edges.map((edge) => [edge.start, edge.end])).toEqual([
      ['a', 'b'],
      ['b', 'c'],
    ]);
  });

  it('lays out inner sub-processes first', () => {
    const built = db(
      inLane('subprocess o "O"', '  subprocess i "I"', '    task x "X"', '  task y "Y"')
    );
    expect(built.expandedSubprocesses()).toEqual(['i', 'o']);
    expect(built.getData({ scope: 'o' }).nodes.map((node) => node.id)).toEqual(['i', 'y']);
  });

  it('draws a message flow to an element inside a sub-process to the sub-process', () => {
    const source = [
      'bpmn-beta LR',
      '  pool p "P"',
      '    subprocess sp "S"',
      '      task inner "I"',
      '  pool q "Q"',
      '    task outer "O"',
      '  outer -.-> inner',
    ].join('\n');
    const edges = db(source).getData().edges;
    expect(edges.map((edge) => [edge.start, edge.end])).toEqual([['outer', 'sp']]);
  });

  it('draws the markers of an expanded sub-process without the + of a collapsed one', () => {
    const data = db(
      inLane('subprocess sp "S" @{ marker: [ad-hoc, loop] }', '  task t "T"')
    ).getData();
    expect(data.nodes.find((node) => node.id === 'sp')).toMatchObject({
      markers: ['bpmn:loop', 'bpmn:ad-hoc'],
    });
  });
});

describe('sub-process kinds', () => {
  it.each([
    ['event', 'dotted'],
    ['transaction', 'double'],
  ])('draws a %s sub-process with a %s border, open or collapsed', (kind, border) => {
    const open = db(
      inLane(
        `subprocess sp "S" @{ kind: ${kind} }`,
        '  start message a "A"',
        '  task b "B"',
        `subprocess c "C" @{ kind: ${kind} }`
      )
    ).getData();
    for (const id of ['sp', 'c']) {
      const node = open.nodes.find((candidate) => candidate.id === id);
      expect(node?.metadata).toMatchObject({ frameBorder: border });
      expect(node?.cssClasses).toContain(`bpmn-${kind}-subprocess`);
    }
  });

  it('reads interrupting: false on a boundary event and on an event sub-process start', () => {
    const read = nodes(
      inLane(
        'task t "T"',
        '  boundary message b "B" @{ interrupting: false }',
        'subprocess ev "E" @{ kind: event }',
        '  start timer s "S" @{ interrupting: false }'
      )
    );
    expect(read.get('b')?.nonInterrupting).toBe(true);
    expect(read.get('s')?.nonInterrupting).toBe(true);
  });

  it('marks a non-interrupting event for its dashed ring', () => {
    const data = db(
      inLane('task t "T"', '  boundary message b "B" @{ interrupting: false }')
    ).getData();
    expect(data.nodes.find((node) => node.id === 'b')?.cssClasses).toContain(
      'bpmn-non-interrupting'
    );
  });

  it('keeps every start and boundary trigger that parsed before', () => {
    expect(
      refusal(
        inLane(
          'start error s1 "S1"',
          'start escalation s2 "S2"',
          'start compensation s3 "S3"',
          'task t "T"',
          '  boundary cancel b "B"',
          'end cancel e "E"'
        )
      )
    ).toBeUndefined();
  });
});

describe('sub-process refusals', () => {
  it.each([
    [['subprocess sp "S" @{ kind: loop }'], /kind takes event or transaction, not "loop"/],
    [['task t "T" @{ kind: event }'], /"kind" is not an attribute of a task, which takes marker/],
    [
      ['start s "S" @{ interrupting: false }'],
      /only the start event of an event sub-process can be interrupting: false/,
    ],
    [
      ['subprocess sp "S"', '  start message s "S" @{ interrupting: false }'],
      /only the start event of an event sub-process/,
    ],
    [
      ['task t "T"', '  boundary error b "B" @{ interrupting: false }'],
      /an error boundary event always interrupts, so it cannot be interrupting: false/,
    ],
    [
      ['task t "T"', '  boundary cancel b "B" @{ interrupting: false }'],
      /a cancel boundary event always interrupts/,
    ],
    [['end e "E" @{ interrupting: false }'], /an end event takes no attributes/],
    [
      ['subprocess ev "E" @{ kind: event }', '  task t "T"'],
      /the event sub-process "ev" has 0 start events/,
    ],
    [
      ['subprocess ev "E" @{ kind: event }', '  start message a "A"', '  start timer b "B"'],
      /the event sub-process "ev" has 2 start events/,
    ],
    [
      ['subprocess ev "E" @{ kind: event }', '  start s "S"'],
      /the start event of the event sub-process "ev" must name what triggers it/,
    ],
    [
      ['task t "T"', 'subprocess ev "E" @{ kind: event }', '  start message s "S"', 't --> ev'],
      /the event sub-process "ev" is started by its own start event/,
    ],
    [
      ['task t "T"', 'subprocess sp "S"', '  task inner "I"', 't --> inner'],
      /the sequence flow "t --> inner" crosses a sub-process border: "t" is outside every subprocess and "inner" is inside the subprocess "sp"/,
    ],
    [['subprocess sp "S"', '  lane l "L"'], /a lane cannot be indented under the subprocess "sp"/],
    [['task t "T"', '  task u "U"'], /only a pool, a lane, a group or a subprocess holds/],
  ])('refuses %j', (lines, message) => {
    expect(refusal(inLane(...lines))).toMatch(message);
  });

  it('lets a message flow and an association cross a sub-process border', () => {
    expect(
      refusal(inLane('note n "N"', 'subprocess sp "S"', '  task inner "I"', 'n ... inner'))
    ).toBeUndefined();
  });
});
