import { describe, it, expect } from 'vitest';
import { BpmnDb } from './bpmnDb.js';
import { parseBpmn } from './parser/bpmn.parser.js';

const inLane = (...lines: string[]) =>
  ['bpmn-beta LR', '  lane "L"', ...lines.map((line) => `    ${line}`)].join('\n');

const refusal = (source: string) => {
  try {
    parseBpmn(source);
  } catch (error) {
    return (error as Error).message;
  }
  return undefined;
};

const drawn = (source: string) => {
  const db = new BpmnDb();
  db.parse(source);
  return db;
};

describe('instantiating event-based gateways', () => {
  it.each([
    ['true', 'exclusive', 'bpmn:event-based-instantiating'],
    ['parallel', 'parallel', 'bpmn:event-based-parallel'],
  ])('reads instantiate: %s and draws its glyph', (value, read, icon) => {
    const source = inLane(`event-gateway g "G" @{ instantiate: ${value} }`);
    expect(parseBpmn(source).nodes[1].instantiate).toBe(read);
    const node = drawn(source)
      .getData()
      .nodes.find((candidate) => candidate.id === 'g') as { icon?: string };
    expect(node.icon).toBe(icon);
  });

  it('keeps an event-based gateway with instantiate: false as it was', () => {
    const node = drawn(inLane('event-gateway g "G" @{ instantiate: false }'))
      .getData()
      .nodes.find((candidate) => candidate.id === 'g') as { icon?: string };
    expect(node.icon).toBe('bpmn:event-based');
  });

  it.each([
    [
      'event-gateway g "G" @{ instantiate: yes }',
      /instantiate takes true, false or parallel, not "yes"/,
    ],
    ['xor g "G" @{ instantiate: true }', /"instantiate" is not an attribute of an xor gateway/],
  ])('refuses `%s`', (line, message) => {
    expect(refusal(inLane(line))).toMatch(message);
  });
});

const SPANNING = [
  'bpmn-beta LR',
  '  pool a "A"',
  '    lane la "LA"',
  '      task t1 "T1"',
  '  pool b "B"',
  '    lane lb "LB"',
  '      task t2 "T2"',
  '  group g "Shipping" @{ members: [t1, t2] }',
  '  t1 -.-> t2',
].join('\n');

describe('groups spanning lanes and pools', () => {
  it('reads the members of a group', () => {
    expect(parseBpmn(SPANNING).nodes.find((node) => node.id === 'g')?.members).toEqual([
      't1',
      't2',
    ]);
  });

  it('leaves a group with members out of the layout, to draw it afterwards', () => {
    const db = drawn(SPANNING);
    expect(db.getData().nodes.map((node) => node.id)).not.toContain('g');
    expect(db.spanningGroups()).toEqual([{ id: 'g', label: 'Shipping', members: ['t1', 't2'] }]);
  });

  it('keeps a group held by one lane as it was', () => {
    const db = drawn(inLane('group g "G"', '  task t "T"'));
    expect(db.getData().nodes.find((node) => node.id === 'g')).toMatchObject({ isGroup: true });
    expect(db.spanningGroups()).toEqual([]);
  });

  it.each([
    [
      ['group g "G" @{ members: [nope] }'],
      /the group "g" names "nope" as a member, which is not a declared element/,
    ],
    [['group g "G" @{ members: [] }'], /members takes a list of element ids, not \[]/],
    [['group g "G" @{ members: t }', 'task t "T"'], /members takes a list of element ids/],
    [
      ['task t "T"', 'group g "G" @{ members: [t] }', '  task u "U"'],
      /the group "g" names its members, so nothing is indented under it/,
    ],
  ])('refuses %j', (lines, message) => {
    expect(refusal(['bpmn-beta LR', ...lines.map((line) => `  ${line}`)].join('\n'))).toMatch(
      message
    );
  });

  it('refuses a group with members written inside a lane', () => {
    expect(refusal(inLane('task t "T"', 'group g "G" @{ members: [t] }'))).toMatch(
      /a group with members .* is written at the top level/
    );
  });
});
