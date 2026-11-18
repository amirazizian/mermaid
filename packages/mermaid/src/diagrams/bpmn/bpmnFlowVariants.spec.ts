import { describe, it, expect, beforeEach } from 'vitest';
import type { Edge } from '../../rendering-util/types.js';
import { BpmnDb } from './bpmnDb.js';
import { parseBpmn } from './parser/bpmn.parser.js';

const db = new BpmnDb();

/** A diagram in one lane, with an activity, a gateway and two tasks to flow between. */
const diagram = (...flowLines: string[]) =>
  [
    'bpmn-beta LR',
    '  lane "L"',
    '    task t "T"',
    '    xor g "G"',
    '    and p "P"',
    '    start s "S"',
    '    task a "A"',
    '    task b "B"',
    '    note n "N"',
    ...flowLines.map((line) => `  ${line}`),
  ].join('\n');

/** The same, with a second pool to send messages to. */
const collaboration = (...flowLines: string[]) =>
  [
    'bpmn-beta LR',
    '  pool one "One"',
    '    task a "A"',
    '  pool two "Two"',
    '    task b "B"',
    ...flowLines.map((line) => `  ${line}`),
  ].join('\n');

const flows = (source: string) => parseBpmn(source).flows;

const edges = (source: string): Map<string, Edge & { flowId?: string; message?: string }> => {
  db.clear();
  db.parse(source);
  return new Map(
    db.getData().edges.map((edge) => [(edge as { flowId?: string }).flowId ?? edge.id, edge])
  );
};

const refusal = (source: string) => {
  try {
    parseBpmn(source);
  } catch (error) {
    return (error as Error).message;
  }
  return undefined;
};

describe('flow ids', () => {
  it.each([
    ['g f1@--> a', 'sequence', undefined],
    ['g f1@-- yes --> a', 'sequence', 'yes'],
    ['t f1@-.-> a', 'message', undefined],
    ['n f1@..> t', 'association', undefined],
    ['n f1@... t', 'association', undefined],
  ])('reads the id in `%s`', (line, kind, label) => {
    const [flow] = flows(diagram(line));
    expect(flow).toMatchObject({ id: 'f1', kind, from: line[0], label });
  });

  it('names each flow of a chain by the id written before its own arrow', () => {
    const read = flows(diagram('s --> t f2@--> g f3@-- no --> b'));
    expect(read.map((flow) => flow.id)).toEqual([undefined, 'f2', 'f3']);
    expect(read[2]).toMatchObject({ from: 'g', to: 'b', label: 'no' });
  });

  it('keeps a flow without an id exactly as before', () => {
    const [flow] = flows(diagram('g --> a'));
    expect(flow).toEqual({ from: 'g', to: 'a', kind: 'sequence', label: undefined });
  });

  it('allows an id with hyphens and underscores', () => {
    expect(flows(diagram('g to-a_1@--> a'))[0].id).toBe('to-a_1');
  });

  it('refuses a flow id given twice', () => {
    expect(refusal(diagram('g f1@--> a', 'g f1@--> b'))).toMatch(
      /line 11, column 5: the flow id "f1" is already declared/
    );
  });

  it('refuses a flow id that an element already has', () => {
    expect(refusal(diagram('g a@--> b'))).toMatch(
      /line 10, column 5: "a" is already declared as an element/
    );
  });
});

describe('flow attribute statements', () => {
  it('marks a default flow out of a gateway, and draws a slash at its source', () => {
    const source = diagram('g f1@--> a', 'g f2@-- yes --> b', 'f1@{ default: true }');
    expect(flows(source)[0].isDefault).toBe(true);
    const drawn = edges(source);
    expect(drawn.get('f1')?.arrowTypeStart).toBe('arrow_slash');
    expect(drawn.get('f1')?.classes).toContain('bpmn-flow-default');
    expect(drawn.get('f2')?.arrowTypeStart).toBe('none');
  });

  it('marks a default flow out of an activity', () => {
    expect(flows(diagram('t f1@--> a', 'f1@{ default: true }'))[0].isDefault).toBe(true);
  });

  it('draws a conditional flow out of an activity with a small diamond and its condition', () => {
    const source = diagram('t c1@--> a', 'c1@{ condition: "amount > 1000" }');
    expect(flows(source)[0].condition).toBe('amount > 1000');
    const drawn = edges(source).get('c1');
    expect(drawn?.arrowTypeStart).toBe('arrow_small_diamond');
    expect(drawn?.label).toBe('amount > 1000');
  });

  it('writes the condition of a gateway branch as its label, without a diamond', () => {
    const drawn = edges(diagram('g c1@--> a', 'c1@{ condition: "ok" }')).get('c1');
    expect(drawn?.arrowTypeStart).toBe('none');
    expect(drawn?.label).toBe('ok');
  });

  it('keeps an arrow label over a condition', () => {
    const drawn = edges(diagram('g c1@-- yes --> a', 'c1@{ condition: "x > 1" }')).get('c1');
    expect(drawn?.label).toBe('yes');
  });

  it('reads a number as the condition it is written as', () => {
    expect(flows(diagram('t c1@--> a', 'c1@{ condition: 1.50 }'))[0].condition).toBe('1.50');
  });

  it('labels a message flow and draws its envelope', () => {
    const source = collaboration('a m1@-.-> b', 'm1@{ label: "Order", message: initiating }');
    expect(flows(source)[0]).toMatchObject({ label: 'Order', message: 'initiating' });
    const drawn = edges(source).get('m1');
    expect(drawn?.label).toBe('Order');
    expect(drawn?.classes).toContain('bpmn-flow-message-initiating');
    expect(drawn?.arrowTypeStart).toBe('arrow_hollow_circle');
  });

  it('marks a non-initiating message', () => {
    const drawn = edges(collaboration('a m1@-.-> b', 'm1@{ message: non-initiating }')).get('m1');
    expect(drawn?.classes).toContain('bpmn-flow-message-non-initiating');
    expect(drawn?.label).toBe('');
  });

  it('labels an association', () => {
    expect(edges(diagram('n a1@... t', 'a1@{ label: "why" }')).get('a1')?.label).toBe('why');
  });

  it.each([
    ['none', 'none', 'none'],
    ['one', 'none', 'arrow_open_head'],
    ['both', 'arrow_open_head', 'arrow_open_head'],
  ])('draws an association in direction %s', (direction, start, end) => {
    const drawn = edges(diagram('n a1@... t', `a1@{ direction: ${direction} }`)).get('a1');
    expect(drawn?.arrowTypeStart).toBe(start);
    expect(drawn?.arrowTypeEnd).toBe(end);
  });

  it('lets direction undo the head of ..>', () => {
    const drawn = edges(diagram('n a1@..> t', 'a1@{ direction: none }')).get('a1');
    expect(drawn?.arrowTypeEnd).toBe('none');
  });

  it('applies a statement written before its flow', () => {
    expect(flows(diagram('f1@{ default: true }', 'g f1@--> a'))[0].isDefault).toBe(true);
  });

  it('leaves the edges of a diagram without flow attributes as they were', () => {
    const drawn = edges(diagram('g --> a', 't -.-> b', 'n ..> t', 'n ... a'));
    expect([...drawn.values()].map((e) => [e.arrowTypeStart, e.arrowTypeEnd])).toEqual([
      ['none', 'arrow_point'],
      ['arrow_hollow_circle', 'arrow_open_head'],
      ['none', 'arrow_open_head'],
      ['none', 'none'],
    ]);
  });
});

describe('flow attribute refusals', () => {
  it.each([
    [
      ['g f1@--> a', 'f1@{ colour: red }'],
      /"colour" is not an attribute of a flow, which takes default, condition, label, message or direction/,
    ],
    [['g f1@--> a', 'f1@{ default: yes }'], /default takes true or false, not "yes"/],
    [
      ['p f1@--> a', 'f1@{ default: true }'],
      /a default flow leaves an activity or an xor, or or complex gateway, not an and gateway \("p"\)/,
    ],
    [['s f1@--> a', 'f1@{ default: true }'], /not a start event \("s"\)/],
    [
      ['p f1@--> a', 'f1@{ condition: "x" }'],
      /a conditional flow leaves an activity or an xor, or or complex gateway/,
    ],
    [['g f1@--> a', 'f1@{ condition: "" }'], /condition takes the condition as text/],
    [
      ['g f1@--> a', 'f1@{ default: true, condition: "x" }'],
      /a default flow is taken when no condition holds/,
    ],
    [
      ['t f1@-.-> a', 'f1@{ default: true }'],
      /default is written on a sequence flow, not on a message flow/,
    ],
    [
      ['n f1@... t', 'f1@{ condition: "x" }'],
      /condition is written on a sequence flow, not on an association/,
    ],
    [
      ['g f1@--> a', 'f1@{ message: initiating }'],
      /message is written on a message flow, not on a sequence flow/,
    ],
    [
      ['t f1@-.-> a', 'f1@{ message: first }'],
      /message takes initiating or non-initiating, not "first"/,
    ],
    [
      ['g f1@--> a', 'f1@{ direction: both }'],
      /direction is written on an association, not on a sequence flow/,
    ],
    [['n f1@... t', 'f1@{ direction: two }'], /direction takes none, one or both, not "two"/],
    [['g f1@-- yes --> a', 'f1@{ label: "no" }'], /already labelled "yes" in its arrow/],
    [
      ['g f1@--> a', 'f2@{ default: true }'],
      /no flow has the id "f2"\. Write the id before the arrow/,
    ],
    [
      ['g f1@--> a', 'a@{ default: true }'],
      /"a" is an element; an element's attributes are written at the end of its own line/,
    ],
    [
      ['g f1@--> a', 'f1@{ label: "x" }', 'f1@{ default: true }'],
      /the attributes of the flow "f1" are already written at line 11/,
    ],
    [
      ['g f1@--> a', 'g f2@--> b', 'f1@{ default: true }', 'f2@{ default: true }'],
      /"g" already has the default flow "f1", so "f2" cannot be one too/,
    ],
    [['g f1@--> a', 'f1@{ default: [ }'], /cannot be read/],
  ])('refuses %j', (lines, message) => {
    expect(refusal(diagram(...lines))).toMatch(message);
  });

  it('names the line and column of the key it refuses', () => {
    expect(refusal(diagram('g f1@--> a', 'f1@{ label: "x", default: 3 }'))).toMatch(
      /^BPMN error at line 11, column 20: default takes true or false, not 3\./
    );
  });

  it('names the statement of a flow it cannot find', () => {
    expect(refusal(diagram('g --> a', 'f9@{ default: true }'))).toMatch(
      /^BPMN error at line 11, column 3: no flow has the id "f9"/
    );
  });

  it('refuses a statement whose block is left open', () => {
    expect(refusal(diagram('g f1@--> a', 'f1@{ default: true'))).toMatch(/never closed/);
  });
});
