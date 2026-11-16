import { describe, it, expect, beforeEach } from 'vitest';
import type { Node } from '../../rendering-util/types.js';
import { bpmnIcons } from '../../rendering-util/rendering-elements/shapes/bpmnIcons.js';
import { BpmnDb } from './bpmnDb.js';
import { parseBpmn } from './parser/bpmn.parser.js';

type Drawn = Node & { icon?: string; markers?: string[] };

const db = new BpmnDb();

const inLane = (...lines: string[]) =>
  ['bpmn-beta LR', '  lane "L"', ...lines.map((line) => `    ${line}`)].join('\n');

function build(source: string): Map<string, Drawn> {
  db.clear();
  db.parse(source);
  return new Map(db.getData().nodes.map((node) => [node.id, node as Drawn]));
}

const parsed = (source: string) => new Map(parseBpmn(source).nodes.map((n) => [n.id, n]));

describe('activity markers', () => {
  beforeEach(() => db.clear());

  it.each([
    ['task t "T" @{ marker: loop }', 'loop'],
    ['task t "T" @{ marker: parallel }', 'parallel'],
    ['task t "T" @{ marker: sequential }', 'sequential'],
    ['task t "T" @{ marker: [compensation, parallel] }', 'parallel'],
  ])('reads `%s` as a %s marker', (line, loop) => {
    expect(parsed(inLane(line)).get('t')?.loop).toBe(loop);
  });

  it('writes every marker into one bottom row, in the order the notation groups them', () => {
    const nodes = build(
      inLane(
        'subprocess s "S" @{ marker: [compensation, ad-hoc, parallel] }',
        'user task t "T" @{ marker: loop }'
      )
    );
    expect(nodes.get('s')?.markers).toEqual([
      'bpmn:parallel',
      'bpmn:subprocess',
      'bpmn:ad-hoc',
      'bpmn:compensation',
    ]);
    expect(nodes.get('t')?.markers).toEqual(['bpmn:loop']);
    expect(nodes.get('t')?.icon).toBe('bpmn:user');
  });

  it('draws a collapsed sub-process with the + marker at the bottom, not in the corner', () => {
    const s = build(inLane('subprocess s "S"')).get('s');
    expect(s?.markers).toEqual(['bpmn:subprocess']);
    expect(s?.icon).toBeUndefined();
  });

  it('gives a typed call activity its task glyph and a process call its + marker', () => {
    const nodes = build(
      inLane(
        'user call c1 "C1"',
        'call c2 "C2" @{ calls: process }',
        'call c3 "C3" @{ calls: task }'
      )
    );
    expect(nodes.get('c1')?.icon).toBe('bpmn:user');
    expect(nodes.get('c1')?.markers).toBeUndefined();
    expect(nodes.get('c2')?.markers).toEqual(['bpmn:subprocess']);
    expect(nodes.get('c3')?.markers).toBeUndefined();
    expect(nodes.get('c2')?.cssClasses).toContain('bpmn-call');
  });

  it('marks a compensation activity with a class as well as the marker', () => {
    const task = build(inLane('task t "T" @{ marker: compensation }')).get('t');
    expect(task?.cssClasses).toContain('bpmn-compensation');
    expect(task?.markers).toEqual(['bpmn:compensation']);
  });

  it('only names glyphs the icon pack defines', () => {
    const pack = new Set(Object.keys(bpmnIcons.icons));
    const nodes = build(
      inLane(
        'task a "A" @{ marker: loop }',
        'task b "B" @{ marker: parallel }',
        'subprocess c "C" @{ marker: [sequential, ad-hoc, compensation] }'
      )
    );
    for (const node of nodes.values()) {
      for (const marker of node.markers ?? []) {
        expect(pack.has(marker.replace(/^bpmn:/, ''))).toBe(true);
      }
    }
  });

  // The markers are attribute values, not keywords, so none of them takes away an id.
  it.each(['loop', 'parallel', 'sequential'])('still lets %s be an id', (id) => {
    expect(parsed(inLane(`task ${id} "T"`)).get(id)?.keyword).toBe('task');
  });

  it('still reads parallel-multiple as a trigger', () => {
    expect(parsed(inLane('start parallel-multiple s "S"')).get('s')?.qualifier).toBe(
      'parallel-multiple'
    );
  });

  it.each([
    ['task t "T" @{ marker: ad-hoc }', 'ad-hoc marks a subprocess, so a task cannot be ad-hoc'],
    ['call c "C" @{ marker: ad-hoc }', 'a call activity cannot be ad-hoc'],
    ['task t "T" @{ marker: [loop, parallel] }', 'so parallel cannot join loop'],
    ['subprocess s "S" @{ marker: [ad-hoc, ad-hoc] }', 'the ad-hoc marker is named twice'],
    [
      'task t "T" @{ marker: twice }',
      'marker takes loop, parallel, sequential, ad-hoc or compensation',
    ],
    ['task t "T" @{ marker: [loop, 3] }', 'not 3'],
    ['call c "C" @{ calls: system }', 'calls takes task or process, not "system"'],
    ['task t "T" @{ calls: process }', '"calls" is not an attribute of a task, which takes marker'],
    ['task t "T" @{ marker: [] }', 'not an empty list'],
    ['user call c "C" @{ calls: process }', 'a user call calls a global user task'],
  ])('refuses `%s`', (line, message) => {
    expect(() => parseBpmn(inLane(line))).toThrow(message);
  });

  it('refuses the keyword form, which is not part of the syntax', () => {
    expect(() => parseBpmn(inLane('loop task t "T"'))).toThrow();
    expect(() => parseBpmn(inLane('call subprocess c "C"'))).toThrow();
  });

  it('names the line and column of a refused marker', () => {
    expect(() => parseBpmn(inLane('task a "A"', 'task t "T" @{ marker: ad-hoc }'))).toThrow(
      /^BPMN error at line 4, column 19: /
    );
  });

  it('keeps the task type of a call to a global task', () => {
    const call = parsed(inLane('user call c "C" @{ calls: task }')).get('c');
    expect(call?.qualifier).toBe('user');
    expect(call?.callsProcess).toBe(false);
  });
});

describe('element attributes', () => {
  beforeEach(() => db.clear());

  it('draws an exclusive gateway without its X when asked', () => {
    const nodes = build(inLane('xor a "A" @{ marker: none }', 'xor c "C"'));
    expect(nodes.get('a')?.icon).toBeUndefined();
    expect(nodes.get('c')?.icon).toBe('bpmn:exclusive');
  });

  it('writes a data object state under its name', () => {
    const nodes = build(
      inLane('data d "Order" @{ state: approved }', 'data-input i "Form" @{ state: 2 }')
    );
    expect(nodes.get('d')?.label).toBe('Order<br>[approved]');
    expect(nodes.get('i')?.label).toBe('Form<br>[2]');
    expect(nodes.get('d')?.metadata?.state).toBe('approved');
    expect(nodes.get('i')?.metadata?.state).toBe('2');
  });

  it('marks a pool that stands for several participants', () => {
    const nodes = build('bpmn-beta LR\n  pool p "Suppliers" @{ multiple: true }\n  pool q "Buyer"');
    expect(nodes.get('p')?.metadata?.multiplicity).toBe(true);
    expect(nodes.get('q')?.metadata?.multiplicity).toBeUndefined();
  });

  it('accepts an empty block', () => {
    expect(() => parseBpmn(inLane('task t "T" @{}'))).not.toThrow();
  });

  it.each([
    ['task t "T" @{ colour: red }', '"colour" is not an attribute of a task, which takes marker'],
    ['subprocess s "S" @{ state: x }', 'which takes marker'],
    ['and g "G" @{ marker: none }', 'an and gateway takes no attributes'],
    ['start s "S" @{ marker: loop }', 'a start event takes no attributes'],
    ['data-store ds "D" @{ state: x }', 'a data store takes no attributes'],
    ['pool p "P" @{ multiple: yes }', 'multiple takes true or false, not "yes"'],
    ['xor g "G" @{ marker: hidden }', 'marker takes none, not "hidden"'],
    ['xor g "G" @{ marker: false }', 'marker takes none, not false'],
    ['xor g "G" @{ marker: true }', 'marker takes none, not true'],
    ['task t "T" @{ marker: loop', 'is never closed'],
    ['data d "D" @{ state: "[x]" }', 'state takes a name without brackets'],
    ['data d "D" @{ state: "" }', 'state takes a name without brackets'],
    ['task t "T" @{ marker: [ }', 'cannot be read'],
    ['task t "T" @{ - a }', 'cannot be read'],
  ])('refuses `%s`', (line, message) => {
    expect(() => parseBpmn(inLane(line))).toThrow(message);
  });

  it('names the line and column of the key it refuses', () => {
    expect(() => parseBpmn(inLane('task t "T" @{ colour: red }'))).toThrow(
      /^BPMN error at line 3, column 19: /
    );
    expect(() => parseBpmn(inLane('task t "T" @{ marker: loop, colour: red }'))).toThrow(
      /^BPMN error at line 3, column 33: /
    );
  });

  it('names the block, not a key, for an element that takes no attributes', () => {
    expect(() => parseBpmn(inLane('start s "S" @{ marker: loop }'))).toThrow(
      /^BPMN error at line 3, column 17: /
    );
  });

  it('reads a } inside a quoted value as part of the value', () => {
    expect(parsed(inLane('data d "D" @{ state: "a}b" }')).get('d')?.state).toBe('a}b');
  });

  it('refuses a block that runs on to the next line, where it opened', () => {
    expect(() =>
      parseBpmn(inLane('task t "T" @{ marker: loop,', '  calls: process }', 'task u "U"'))
    ).toThrow(/^BPMN error at line 3, column 16: the attributes block opened here runs on/);
  });

  it('reports the error written first, whichever check finds it', () => {
    // The placement error on line 4 comes before the attribute error on line 5.
    expect(() =>
      parseBpmn(inLane('task a "A"', '  task b "B"', 'task t1 "T" @{ marker: bogus }'))
    ).toThrow(/^BPMN error at line 4, column 7: a task cannot be indented under the task "a"/);
    // And the attribute error on line 3 comes before the undeclared flow end on line 4.
    expect(() => parseBpmn(inLane('task t "T" @{ marker: bogus }', 't --> nowhere'))).toThrow(
      /^BPMN error at line 3, column 19: marker takes/
    );
  });

  it('finds the key it refuses outside quoted values', () => {
    // "foo: b" inside the quoted state is not the key foo, which is written at column 35.
    expect(() => parseBpmn(inLane('data d @{ state: "a, foo: b", foo: 1 }'))).toThrow(
      /^BPMN error at line 3, column 35: "foo" is not an attribute of a data object/
    );
    expect(() => parseBpmn(inLane('task t @{ "colour": red }'))).toThrow(
      /^BPMN error at line 3, column 15: "colour" is not an attribute/
    );
  });

  it('reads an escaped quote inside a quoted value', () => {
    expect(parsed(inLane('data d @{ state: "a\\"}" }')).get('d')?.state).toBe('a"}');
    // YAML gives a backslash no meaning in single quotes: the value ends at the next quote.
    expect(parsed(inLane("data d @{ state: 'a\\' }")).get('d')?.state).toBe('a\\');
    // So here the block closes after `a\`, and what is left on the line is refused there.
    expect(() => parseBpmn(inLane("data d @{ state: 'a\\'}' }", 'task t'))).toThrow(/at line 3/);
  });

  it('reads a quote inside an unquoted value as a plain character', () => {
    expect(parsed(inLane("data d @{ state: it's } %% a note")).get('d')?.state).toBe("it's");
    expect(parsed(inLane('data d @{ state: 5" } %% a note')).get('d')?.state).toBe('5"');
    expect(() => parseBpmn(inLane("data d @{ state: it's, foo: 1 }"))).toThrow(
      /^BPMN error at line 3, column 28: "foo" is not an attribute of a data object/
    );
  });

  it('draws a state alone when the data object has no name', () => {
    const nodes = [...build(inLane('data @{ state: approved }')).values()];
    const data = nodes.find((node) => node.metadata?.state === 'approved');
    expect(data?.label).toBe('[approved]');
  });

  it('checks the keys in the order they are written', () => {
    // Object.entries would put the integer-like key 2 first.
    expect(() => parseBpmn(inLane('task t @{ marker: bogus, 2: x }'))).toThrow(
      /^BPMN error at line 3, column 15: marker takes/
    );
  });

  it('refuses a block left open on its line before a later syntax error', () => {
    expect(() =>
      parseBpmn(inLane('task t @{ marker: loop', 'task u @{ marker: loop } "U"'))
    ).toThrow(/^BPMN error at line 3, column 12: the attributes block opened here is never closed/);
    // A syntax error written before the open block still comes first.
    expect(() => parseBpmn(inLane('task a "A" "B"', 'task t @{ marker: loop'))).toThrow(
      /^Error parsing bpmn diagram: Redundant input.* at line 3, column 16$/
    );
  });

  it.each([
    [
      ['task t "T" @{ marker: bogus }', 'task u @{ marker: loop'],
      /^BPMN error at line 3, column 19: marker takes/,
    ],
    [
      ['task t "T"', 'task t "T2"', 'task u @{ marker: loop'],
      /^BPMN error at line 4, column 10: "t" is already declared/,
    ],
    [['end timer e', 'task u @{ marker: loop'], /^BPMN error at line 3, column \d+: .*timer/],
    [
      ['task t', 't --> zz', 'task u @{ marker: loop'],
      /^BPMN error at line 4, column 5: the flow "t --> zz" refers to "zz"/,
    ],
    [
      ['task a "A"', '  task b "B"', 'task u @{ marker: loop'],
      /^BPMN error at line 4, column 7: a task cannot be indented/,
    ],
    // The same, when what follows the open block cannot be read either.
    [
      ['task t "T" @{ marker: bogus }', 'task u @{ marker: loop', 'task v "V" "W"'],
      /^BPMN error at line 3, column 19: marker takes/,
    ],
  ])('reports an error written before a block left open: %j', (lines, message) => {
    expect(() => parseBpmn(inLane(...lines))).toThrow(message);
  });

  it.each([
    // A flow written before the open block may end at an element declared after it.
    [['task t', 't --> v', 'task u @{ marker: loop', 'task v']],
    [['task t', 't --> v', 'task u @{ marker: loop', 'task v "V" "W"']],
    // An error written after the block does not come before it.
    [['task u @{ marker: loop', 'task t "T" @{ marker: bogus }']],
    [['task u @{ marker: loop', 'u --> zz']],
  ])('reports a block left open before anything after it: %j', (lines) => {
    const line = 3 + lines.findIndex((text) => text.endsWith('loop'));
    expect(() => parseBpmn(inLane(...lines))).toThrow(
      new RegExp(
        `^BPMN error at line ${line}, column 12: the attributes block opened here is never`
      )
    );
  });

  it('reports an error written before a block that runs on to the next line', () => {
    expect(() =>
      parseBpmn(inLane('task t "T"', 'task t "T2" @{ marker: loop,', '  calls: process }'))
    ).toThrow(/^BPMN error at line 4, column 10: "t" is already declared/);
  });

  it.each([['task u "U}"'], ['%% }'], ['task u "U" %% }'], ['task u @{ marker: "}" }']])(
    'does not take a } in `%s` on the next line for the end of the block',
    (next) => {
      expect(() => parseBpmn(inLane('task t @{ marker: loop', next))).toThrow(
        /^BPMN error at line 3, column 12: the attributes block opened here is never closed/
      );
    }
  );

  it('finds a key after a single-quoted value that ends in a backslash', () => {
    // YAML gives a backslash no meaning in single quotes: the state is `a\`, and foo is a key.
    expect(() => parseBpmn(inLane("data d @{ state: 'a\\', foo: 1 }"))).toThrow(
      /^BPMN error at line 3, column 28: "foo" is not an attribute of a data object/
    );
    expect(parsed(inLane("data d @{ state: 'it''s' }")).get('d')?.state).toBe("it's");
  });

  it('reads a line of 400,000 characters with a quote that is never closed within a second', () => {
    const source = inLane('data d @{ state: "' + '\\"'.repeat(200_000));
    const started = performance.now();
    expect(() => parseBpmn(source)).toThrow('is never closed');
    expect(performance.now() - started).toBeLessThan(1000);
  });

  // Inputs an independent review found wrong, each with the error it must give.
  it.each<[string[], RegExp]>([
    // A quote inside an unquoted value is a plain character.
    [["data d @{ state: don't, x: 'a}' }"], /^BPMN error at line 3, column 29: "x" is not/],
    [["data d @{ state: 'a\\', foo: 'b}' }"], /^BPMN error at line 3, column 28: "foo" is not/],
    [["data d @{ state: don't, x: can't }"], /^BPMN error at line 3, column 29: "x" is not/],
    // A block that cannot be read still declares its element.
    [['task A', 'A --> B', 'task B @{ [ }'], /^BPMN error at line 5, column 12: .* cannot be read/],
    [
      ['task a', 'a --> t', 'task t @{ [ }', 'task u @{ marker: loop'],
      /^BPMN error at line 5, column 12: .* cannot be read/,
    ],
    [
      ['task A', 'A --> C', 'task B @{ marker: loop', 'task C @{ [['],
      /^BPMN error at line 5, column 12: .* is never closed/,
    ],
    // Of two errors in one statement, the one written first.
    [['task A', '  task B @{ bogus: 1 }'], /^BPMN error at line 4, column 7: a task cannot be/],
    [['task A', '  start s @{ a: 1 }'], /^BPMN error at line 4, column 7: a start cannot be/],
    [['boundary timer b @{ a: 1 }'], /^BPMN error at line 3, column 5: a boundary event must/],
    [['task A', '  task B @{ [ }'], /^BPMN error at line 4, column 7: a task cannot be/],
    [['task A', 'task A @{ [ }'], /^BPMN error at line 4, column 10: "A" is already declared/],
    [['end timer e @{ [ }'], /^BPMN error at line 3, column 9: an end event cannot carry/],
    // An undeclared flow end is still reported when what follows the open block is unreadable.
    [
      ['task t', 't --> zz', 'task u @{ marker: loop', 'task v $'],
      /^BPMN error at line 4, column 5: the flow "t --> zz" refers to "zz"/,
    ],
    [
      ['task t', 't --> zz', 'task u @{ marker: loop', 'task v "V" "W"'],
      /^BPMN error at line 4, column 5: the flow "t --> zz" refers to "zz"/,
    ],
    // A mapping nested in the block is part of it.
    [
      ['task t @{ marker: {a: 1} }'],
      /^BPMN error at line 3, column 15: marker takes .* not {"a":1}/,
    ],
    [['task t @{ marker: {a: 1}, bogus: 2 }'], /^BPMN error at line 3, column 15: marker takes/],
    [['task t @{ a: {b: 1}'], /^BPMN error at line 3, column 12: .* is never closed/],
    // A key is named and placed as YAML reads it.
    [['task t @{ marker:loop }'], /^BPMN error at line 3, column 15: "marker:loop" is not/],
    [
      ['call c @{ calls: process, marker:loop }'],
      /^BPMN error at line 3, column 31: "marker:loop" is not/,
    ],
    [['task t @{ a:b: 1, zzz: 2 }'], /^BPMN error at line 3, column 15: "a:b" is not/],
    [['task t @{ ? colour : red, zzz: 1 }'], /^BPMN error at line 3, column 17: "colour" is not/],
    [['task t @{ marker: loop, : a }'], /^BPMN error at line 3, column 29: "null" is not/],
    [['task t @{ marker: loop, ---: a }'], /^BPMN error at line 3, column 29: "---" is not/],
    // The line after an open block is a statement of its own, not the rest of the block.
    [['task A @{ marker: loop', 'accDescr { hi }'], /^BPMN error at line 3, .* is never closed/],
    [
      ['task B', 'task A @{ marker: loop', 'A -- {x} --> B'],
      /^BPMN error at line 4, column 12: .* is never closed/,
    ],
    [
      ['task t @{ marker: loop', 'task u"U}"'],
      /^BPMN error at line 3, column 12: .* is never closed/,
    ],
    // A } on the next line closes the block, which runs on. The element that line declares
    // is not lost: the flow that ends at it is not reported.
    [
      ['task A', 'A --> B', 'task C @{ marker: loop', 'task B }'],
      /^BPMN error at line 5, column 12: .* runs on to the next line/,
    ],
    // An undeclared flow end is reported though its id is part of a word in or after the block.
    [['task t', 't --> a', 'task u @{ marker: loop'], /^BPMN error at line 4, .* refers to "a"/],
    [['task a', 'a --> b', 'task u @{ marker: bogus'], /^BPMN error at line 4, .* refers to "b"/],
    [
      ['task a', 'a --> c', 'call u @{ calls: process'],
      /^BPMN error at line 4, column 5: .* refers to "c"/,
    ],
    [
      ['task t', 't --> zz', 'task u @{ marker: loop', 'task v "pizza" "W"'],
      /^BPMN error at line 4, column 5: .* refers to "zz"/,
    ],
    [
      ['task t', 't --> zz', 'task u @{ marker: loop', 'zz --> t', 'task v $'],
      /^BPMN error at line 4, column 5: .* refers to "zz"/,
    ],
    [
      ['task t', 't --> zz', 'task u @{ marker: loop', '%% zz comes later', 'task v $'],
      /^BPMN error at line 4, column 5: .* refers to "zz"/,
    ],
    // But not when what cannot be read after the block declares it.
    [
      ['task t', 't --> zz', 'task u @{ marker: loop', 'task zz "Z"', 'task v $'],
      /^BPMN error at line 5, column 12: .* is never closed/,
    ],
    // A block closed further down runs on.
    [['task t @{', '  marker: loop', '}'], /^BPMN error at line 3, column 12: .* runs on/],
    [['data d @{', "  state: it's ready }"], /^BPMN error at line 3, column 12: .* runs on/],
  ])('gives the right error for %j', (lines, message) => {
    expect(() => parseBpmn(inLane(...lines))).toThrow(message);
  });

  it.each(['1.0', '007', '0x10', '1e3', '.inf', '2'])('keeps the state %s as written', (state) => {
    expect(parsed(inLane(`data d @{ state: ${state} }`)).get('d')?.state).toBe(state);
  });

  it('shows a long block shortened in the message', () => {
    const message = (() => {
      try {
        parseBpmn(inLane(`task t @{ marker: [ ${'x'.repeat(100_000)} }`));
      } catch (error) {
        return (error as Error).message;
      }
    })();
    expect(message).toMatch(/cannot be read/);
    expect(message!.length).toBeLessThan(400);
  });

  it.each([
    'task t @{ marker: &a [*a] }',
    'data d @{ state: &a [*a] }',
    'xor g @{ marker: &a [*a] }',
    'call c @{ calls: &a {x: *a} }',
  ])('refuses a value that holds itself, with a located error: %s', (line) => {
    expect(() => parseBpmn(inLane(line))).toThrow(/^BPMN error at line 3, column \d+: .* takes /);
  });

  it('refuses a value that aliases multiply, quickly and in a short message', () => {
    const lists = Array.from(
      { length: 30 },
      (_, k) =>
        `&a${k} [${Array(10)
          .fill(k ? `*a${k - 1}` : 'x')
          .join(',')}]`
    );
    const started = performance.now();
    let message = '';
    try {
      parseBpmn(inLane(`data d @{ state: [${lists.join(', ')}] }`));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(performance.now() - started).toBeLessThan(2000);
    expect(message).toMatch(
      /^BPMN error at line 3, column 15: state takes a name without brackets/
    );
    expect(message.length).toBeLessThan(400);
  });

  it('shows a long key and a long value shortened in the message', () => {
    const long = 'x'.repeat(100_000);
    for (const line of [`task t @{ ${long}: 1 }`, `task t @{ marker: ${long} }`]) {
      let message = '';
      try {
        parseBpmn(inLane(line));
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/^BPMN error at line 3, column \d+: /);
      expect(message.length).toBeLessThan(400);
    }
  });

  it.each([
    // The id of an undeclared flow end is a word on a later line of a block that runs on.
    [['task t', 't --> process', 'call u @{ marker: loop,', '  calls: process }'], 4, 5],
    [['task t', 't --> loop', 'task u @{', '  marker: loop', '}'], 4, 5],
    [['task t', 't --> loop', 'task u @{', '  "marker": loop', '}'], 4, 5],
    [
      ['data p0 @{ state: ok }', 'p0 --> loop', 'task p0', 'task u @{', '  marker: loop', '}'],
      4,
      5,
    ],
  ])('reports the flow written before a block that runs on: %j', (lines, line, column) => {
    expect(() => parseBpmn(inLane(...lines))).toThrow(
      new RegExp(`^BPMN error at line ${line}, column ${column}: the flow `)
    );
  });

  it('does not report a flow whose end a line taken by the block may declare', () => {
    expect(() => parseBpmn(inLane('task t', 't --> u', 'task v @{', '  task u', '}'))).toThrow(
      /^BPMN error at line 5, column 12: .* runs on/
    );
  });

  it('reads the ids after an open block in linear time', () => {
    const started = performance.now();
    expect(() => parseBpmn(inLane('task u @{ marker: loop', 'a '.repeat(100_000)))).toThrow();
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it.each(['"abc }', '"abc } ', '"abc }\t', '"abc } %% note', "'abc } ", "'abc } %% note"])(
    'refuses an open quote for the quote, whatever follows the }: %j',
    (value) => {
      expect(() => parseBpmn(inLane(`data d @{ state: ${value}`))).toThrow(
        /^BPMN error at line 3, column 12: .* cannot be read \(unexpected end of the stream within a (double|single) quoted scalar\)/
      );
    }
  );

  it('reads a tag written in full, and a ? key inside a list', () => {
    expect(
      parsed(inLane('data d @{ state: !<tag:yaml.org,2002:str> "a}b" }')).get('d')?.state
    ).toBe('a}b');
    expect(() => parseBpmn(inLane('task t @{ marker: [ ? "a}b" : 1 ] }'))).toThrow(
      /^BPMN error at line 3, column 15: marker takes .*, not {"a}b":1}\./
    );
  });

  it('names a tagged key as YAML does, and points at it', () => {
    expect(() => parseBpmn(inLane('task t @{ marker: loop, !!str 0x10: x }'))).toThrow(
      /^BPMN error at line 3, column 35: "0x10" is not an attribute/
    );
  });

  it.each([
    ['!!float 1.0', '1'],
    ['!!int 7', '7'],
  ])('takes the tagged number %s as the state', (written, state) => {
    expect(parsed(inLane(`data d @{ state: ${written} }`)).get('d')?.state).toBe(state);
  });

  it('names an event-gateway once', () => {
    expect(() => parseBpmn(inLane('event-gateway g @{ marker: none }'))).toThrow(
      'an event-gateway takes no attributes.'
    );
  });

  it('refuses a block on a lane, which takes nothing yet', () => {
    expect(() => parseBpmn('bpmn-beta LR\n  lane l "L" @{ multiple: true }')).toThrow(
      'a lane takes no attributes'
    );
  });
});
