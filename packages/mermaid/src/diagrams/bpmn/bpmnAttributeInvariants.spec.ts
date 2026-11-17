import { describe, it, expect } from 'vitest';
import { Alternation, Terminal } from 'chevrotain';
import type { IProduction } from 'chevrotain';
import * as yaml from 'js-yaml';
import { bpmnParser, parseBpmn, writtenKeys } from './parser/bpmn.parser.js';
import { scanAttributeBlock } from './parser/bpmnAttributeBlock.js';
import { BPMN_DIRECTIONS, EVENT_TRIGGERS, TASK_TYPES } from './types.js';

/**
 * These tests state what the `@{ }` block promises as rules over many inputs, rather than as
 * single examples: of two rule errors in a diagram, the one written first is reported; a line
 * that follows, and neither closes a block nor breaks the syntax, does not change the error a
 * line gives; the keys found are the keys YAML reads, and stand where they are written; a line
 * after a block left open declares a name when it opens as an element's statement does; and a
 * block of 100,000 repeats of a quote, a bracket, a separator, a tag or an anchor is read within
 * a bound that a quadratic reading would miss many times over.
 */

const inLane = (...lines: string[]) =>
  ['bpmn-beta LR', '  lane "L"', ...lines.map((line) => `    ${line}`)].join('\n');

const errorOf = (source: string): string | undefined => {
  try {
    parseBpmn(source);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

const lineOf = (message: string): number => {
  const found = /at line (\d+)/.exec(message);
  if (!found) {
    throw new Error(`An error without a line: ${message}`);
  }
  return Number(found[1]);
};

/** A small seeded generator, so a failure names an input that can be run again. */
const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

interface ErrorKind {
  name: string;
  /** The lines that hold the error; `id` keeps two kinds in one diagram apart. */
  lines: (id: string) => string[];
  /** Which of those lines the error is reported on. */
  errorLine: number;
  message: RegExp;
  /** A syntax error stops the reading, so it is reported before an earlier rule error. */
  syntax?: boolean;
  /** A block left open: reported like a rule error, and no error written after it is reported. */
  unclosed?: boolean;
}

const ERROR_KINDS: ErrorKind[] = [
  {
    name: 'a value the attribute does not take',
    lines: (id) => [`task ${id} "T" @{ marker: bogus }`],
    errorLine: 0,
    message: /marker takes/,
  },
  {
    name: 'an attribute the element does not take',
    lines: (id) => [`task ${id} @{ colour: red }`],
    errorLine: 0,
    message: /"colour" is not an attribute/,
  },
  {
    name: 'an element that takes no attributes',
    lines: (id) => [`start ${id} "S" @{ marker: loop }`],
    errorLine: 0,
    message: /takes no attributes/,
  },
  {
    name: 'a block that cannot be read',
    lines: (id) => [`task ${id} @{ marker: [ }`],
    errorLine: 0,
    message: /cannot be read/,
  },
  {
    name: 'a block that cannot be read on an element a flow ends at',
    lines: (id) => [`task ${id}x`, `${id}x --> ${id}`, `task ${id} @{ [ }`],
    errorLine: 2,
    message: /cannot be read/,
  },
  {
    name: 'a mapping where a marker is due',
    lines: (id) => [`task ${id} @{ marker: {a: 1} }`],
    errorLine: 0,
    message: /marker takes/,
  },
  {
    name: 'an id declared twice',
    lines: (id) => [`task ${id}`, `task ${id}`],
    errorLine: 1,
    message: /is already declared/,
  },
  {
    name: 'a trigger in the wrong place',
    lines: (id) => [`end timer ${id}`],
    errorLine: 0,
    message: /timer/,
  },
  {
    name: 'a flow to an undeclared element',
    lines: (id) => [`task ${id}`, `${id} --> ghost${id}`],
    errorLine: 1,
    message: /which is not declared/,
  },
  {
    name: 'an element indented under a task',
    lines: (id) => [`task ${id}`, `  task ${id}b`],
    errorLine: 1,
    message: /cannot be indented/,
  },
  {
    name: 'a block that is never closed',
    lines: (id) => [`task ${id} @{ marker: loop`],
    errorLine: 0,
    message: /is never closed/,
    unclosed: true,
  },
  {
    name: 'a block that runs on to the next line',
    lines: (id) => [`task ${id} @{ marker: loop,`, '  calls: process }'],
    errorLine: 0,
    message: /runs on to the next line/,
    unclosed: true,
  },
  {
    name: 'a syntax error',
    lines: (id) => [`task ${id} "A" "B"`],
    errorLine: 0,
    message: /Redundant input/,
    syntax: true,
  },
];

describe('of two errors, the one written first is reported, unless the second is a syntax error', () => {
  it.each(ERROR_KINDS)('reports $name alone, on its line', (kind) => {
    const message = errorOf(inLane(...kind.lines('a')));
    expect(message).toMatch(kind.message);
    expect(lineOf(message!)).toBe(3 + kind.errorLine);
  });

  const pairs = ERROR_KINDS.flatMap((first) => ERROR_KINDS.map((second) => ({ first, second })));

  it.each(pairs)('$first.name, then $second.name', ({ first, second }) => {
    const firstLines = first.lines('a');
    const source = inLane(...firstLines, ...second.lines('b'));
    // A syntax error stops the reading, so it wins over a rule error written before it.
    // No error written after a block left open is reported, so there a syntax error does not win.
    const syntaxWins = second.syntax && !first.syntax && !first.unclosed;
    const expected = syntaxWins
      ? { kind: second, line: 3 + firstLines.length + second.errorLine }
      : { kind: first, line: 3 + first.errorLine };
    const message = errorOf(source);
    expect(message).toMatch(expected.kind.message);
    expect(lineOf(message!)).toBe(expected.line);
  });

  // The pairs in which the first error is reported; the test above covers the others too.
  const firstWins = pairs.filter(
    ({ first, second }) => !(second.syntax && !first.syntax && !first.unclosed)
  );

  it.each(firstWins)('a valid line, $first.name, a valid line, then $second.name', (pair) => {
    const { first, second } = pair;
    const source = inLane(
      'task ok1 "One" @{ marker: loop }',
      ...first.lines('a'),
      'task ok2 "Two"',
      ...second.lines('b')
    );
    const message = errorOf(source);
    expect(message).toMatch(first.message);
    expect(lineOf(message!)).toBe(4 + first.errorLine);
  });
});

const PIECES = [
  '"', "'", '\\', '{', '}', '[', ']', ',', ':', ': ', ' ', '@{', '%%', '#', '?', '&', '*', '!',
  '-', 'a', 'x', '2', 'marker', 'loop', 'state', 'none', 'true', 'null', '"a"', "'b'", '\t',
  '? ', '!!str ', '&a ', '*a', '*a ', '!<tag:yaml.org,2002:str>', '!<!>', '"a}b"', ' : ', '>',
]; // prettier-ignore

const randomBody = (random: () => number): string => {
  const length = Math.floor(random() * 12);
  let body = '';
  for (let index = 0; index < length; index++) {
    body += PIECES[Math.floor(random() * PIECES.length)];
  }
  return body;
};

describe('a line with an error of its own, written after, does not change the error a line gives', () => {
  // The line that follows holds an error of its own, and nothing that could close a block.
  const next = 'end timer after';
  const random = seeded(8166);
  const cases = Array.from({ length: 1500 }, () => {
    const opener = random() < 0.5 ? 'data d @{' : 'task t "T" @{';
    const close = random() < 0.7 ? ' }' : '';
    return `${opener} ${randomBody(random)}${close}`;
  });

  it('gives the same BPMN error, or a syntax error on the same line, for 1500 generated blocks', () => {
    for (const line of cases) {
      const alone = errorOf(inLane(line));
      const followed = errorOf(inLane(line, next));
      const where = `for the line ${JSON.stringify(line)}`;
      expect(followed, where).toBeDefined();
      if (alone === undefined) {
        expect(lineOf(followed!), where).toBe(4);
        continue;
      }
      expect(lineOf(alone), where).toBe(3);
      expect(lineOf(followed!), where).toBe(3);
      if (alone.startsWith('BPMN error')) {
        expect(followed, where).toBe(alone);
      }
    }
  });
});

/**
 * The flow mapping YAML reads at the front of `text`, which opens with `{`, and where it ends.
 * The mapping ends at the first `}` up to which the text can be read as a mapping. It is read
 * as the one entry of a list, where a `}` that does not end the mapping cannot be read at all.
 */
const flowMappingAt = (text: string): { end: number; read: object } | undefined => {
  for (let brace = text.indexOf('}'); brace >= 0; brace = text.indexOf('}', brace + 1)) {
    try {
      const read = yaml.load(`[${text.slice(0, brace + 1)}]`, { schema: yaml.JSON_SCHEMA });
      const [mapping] = read as unknown[];
      if ((read as unknown[]).length === 1 && mapping && typeof mapping === 'object') {
        return { end: brace + 1, read: mapping };
      }
    } catch {
      // Not the end of the mapping.
    }
  }
  return undefined;
};

describe('a block ends where YAML ends it, and its keys are the keys YAML reads', () => {
  const random = seeded(8167);
  const bodies = Array.from({ length: 20_000 }, () => randomBody(random));

  it('holds for those of 20,000 generated blocks that YAML can read', () => {
    let readable = 0;
    let endingEarly = 0;
    let withTagOrAnchor = 0;
    for (const body of bodies) {
      const mapping = flowMappingAt(`{${body}}`);
      if (!mapping) {
        continue;
      }
      const image = `@{${body}}`;
      const where = `for the block ${JSON.stringify(image)}`;
      // The block ends with the `}` that YAML ends the mapping with, which may come before the
      // end of what was generated.
      const scanned = scanAttributeBlock(image, 0);
      expect({ closed: scanned.closed, end: scanned.end }, where).toEqual({
        closed: true,
        end: mapping.end + 1,
      });
      readable++;
      endingEarly += scanned.end < image.length ? 1 : 0;
      withTagOrAnchor += /[!&?]/.test(body) ? 1 : 0;
      const found = writtenKeys(image.slice(0, scanned.end));
      const names = found.map((entry) => entry.key);
      if (body.includes('*')) {
        // A key written with an alias has no name of its own, so it is not found. Every key
        // that is found is still one YAML reads.
        for (const name of names) {
          expect(Object.keys(mapping.read), where).toContain(name);
        }
      } else {
        expect([...names].sort(), where).toEqual(Object.keys(mapping.read).sort());
      }
      // Each key stands after the one before it, on something that is written.
      const offsets = found.map((entry) => entry.offset);
      expect(
        [...new Set(offsets)].sort((a, b) => a - b),
        where
      ).toEqual(offsets);
      for (const offset of offsets) {
        expect(offset, where).toBeGreaterThanOrEqual(2);
        expect(image[offset], where).not.toMatch(/[\t ,}]/);
      }
    }
    expect(readable).toBeGreaterThan(5000);
    expect(endingEarly).toBeGreaterThan(500);
    expect(withTagOrAnchor).toBeGreaterThan(500);
  });
});

describe('a key is found where it is written', () => {
  /**
   * How a key is written, the name YAML gives it, and where in what is written the key itself
   * starts: after a `?`, a tag or an anchor in front of it. `bare` marks a key that is nothing
   * but a `?`, a tag or an anchor, which a blank must follow.
   */
  interface WrittenKey {
    written: string;
    name: string;
    at?: number;
    bare?: boolean;
  }
  const KEYS: WrittenKey[] = [
    { written: 'marker', name: 'marker' },
    { written: '"state"', name: 'state' },
    { written: "'calls'", name: 'calls' },
    { written: '2', name: '2' },
    { written: '"a b"', name: 'a b' },
    { written: '"q\\"k"', name: 'q"k' },
    { written: "'it''s'", name: "it's" },
    { written: 'ad-hoc', name: 'ad-hoc' },
    { written: 'true', name: 'true' },
    { written: '"x: y"', name: 'x: y' },
    { written: '"a,b"', name: 'a,b' },
    { written: '"}"', name: '}' },
    { written: "'{'", name: '{' },
    { written: 'k.1', name: 'k.1' },
    { written: 'a:b', name: 'a:b' },
    { written: '-x', name: '-x' },
    // A tag or an anchor in front of the key, which the key is named without.
    { written: '!!str 0x10', name: '0x10', at: 6 },
    { written: '!!str "t}g"', name: 't}g', at: 6 },
    { written: '&k anchored', name: 'anchored', at: 3 },
    { written: '&k !!str both', name: 'both', at: 9 },
    { written: '!<tag:yaml.org,2002:str> full', name: 'full', at: 25 },
    { written: '!<tag:yaml.org,2002:str>"n}s"', name: 'n}s', at: 24 },
    { written: '!<!>near', name: 'near', at: 4 },
    { written: '!!int 7', name: '7', at: 6 },
    // The long way to write a key.
    { written: '? asked', name: 'asked', at: 2 },
    { written: '? "q}k"', name: 'q}k', at: 2 },
    { written: '?  !!str long', name: 'long', at: 9 },
    // A list or a mapping written as a key.
    { written: '[l, m]', name: 'l,m' },
    { written: '[ "}" ]', name: '}' },
    { written: '{ in: "}" }', name: '[object Object]' },
    { written: '&c [n]', name: 'n', at: 3 },
    // A key that is nothing but a tag, an anchor or a `?`.
    { written: '!!str', name: '', bare: true },
    { written: '&only', name: 'null', bare: true },
    { written: '?', name: 'null', bare: true },
    { written: '', name: 'null', bare: true },
  ];
  const VALUES = [
    'loop', '1', 'true', '""', "''", '"a, foo: b"', "'a, foo: b'", '"a\\"}"', "'a\\'", "'it''s, k: v'",
    '[a, b]', '[ "x, y: z", c ]', '{ in: 1, ner: 2 }', '{ a: [1, { b: "}" }] }', '"{"', "'['",
    '"\\\\"', 'a b c', 'null', '', '"]"', '[[], {}]', '!!str "a}b, c: d"', '&v [1, "}"]',
    '!<tag:yaml.org,2002:str>"a}b"', '!!str ', '[ ? "a}b" : 1 ]', '{ ? x : "}" }', "it's", 'a"b',
  ]; // prettier-ignore
  const SEPARATORS = [', ', ',', ' , ', ',  '];
  const random = seeded(8160);
  const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];

  it('holds for 5000 blocks built from keys and values of every shape', () => {
    const used = new Set<string>();
    for (let run = 0; run < 5000; run++) {
      let image = `@{${pick(['', ' ', '  '])}`;
      const expected: { key: string; offset: number }[] = [];
      const names = new Set<string>();
      const count = 1 + Math.floor(random() * 4);
      for (let index = 0; index < count; index++) {
        const { written, name, at = 0, bare = false } = pick(KEYS);
        if (names.has(name)) {
          continue;
        }
        if (expected.length > 0) {
          image += pick(SEPARATORS);
        }
        names.add(name);
        used.add(written);
        // A key written as nothing at all stands where its `:` does, and needs it to be a key.
        expected.push({ key: name, offset: image.length + (written === '' ? 1 : at) });
        image += written;
        if (written === '' || random() < 0.85) {
          // A `:` straight after a tag or an anchor would be part of it.
          const colon = bare ? [' : ', ' :  '] : [': ', ' : ', ':  '];
          image += `${pick(colon)}${pick(VALUES)}`;
        } else if (bare) {
          // A key with no value. A blank ends the tag, the anchor or the `?` it is.
          image += ' ';
        }
      }
      image += `${pick(['', ' '])}}`;
      const where = `for the block ${JSON.stringify(image)}`;
      const mapping = flowMappingAt(image.slice(1));
      expect(mapping?.end, where).toBe(image.length - 1);
      expect(Object.keys(mapping?.read ?? {}).sort(), where).toEqual([...names].sort());
      expect(writtenKeys(image), where).toEqual(expected);
      expect(scanAttributeBlock(image, 0).end, where).toBe(image.length);
    }
    expect(used.size).toBe(KEYS.length);
  });
});

describe('a value is read as YAML reads it', () => {
  it.each([
    ['!!str "a}b"', 'a}b'],
    ['&x "a}b"', 'a}b'],
    ["!!str 'a}b'", 'a}b'],
    ['!!str plain', 'plain'],
    ['!<tag:yaml.org,2002:str> "a}b"', 'a}b'],
    ['!<tag:yaml.org,2002:str>"a}b"', 'a}b'],
    ['!<!>"a}b"', 'a}b'],
    ['&x !!str "a}b"', 'a}b'],
  ])('state: %s, behind a tag or an anchor', (value, state) => {
    const node = parseBpmn(inLane(`data d @{ state: ${value} } %% note`)).nodes.find(
      (n) => n.id === 'd'
    );
    expect(node?.state).toBe(state);
  });

  it.each([
    ['task t @{ !!str "a}b": 1 }', /column 21: "a}b" is not an attribute/],
    ['task t @{ [a]:"x}y" }', /column 15: "a" is not an attribute/],
    ['task t @{ marker: {a: 1}:"x}y" }', /cannot be read|marker takes/],
    // A key written with an alias is named by what it stands for, and placed at the block.
    ['data d @{ state: &a ok, *a :"x}y" }', /column 12: "ok" is not an attribute/],
    ['task t @{ marker: &a loop, [*a]:"x}y" }', /column 12: "loop" is not an attribute/],
  ])('reads `%s` to its end', (line, message) => {
    expect(errorOf(inLane(line, 'end timer after'))).toMatch(message);
    expect(lineOf(errorOf(inLane(line, 'end timer after'))!)).toBe(3);
  });

  const VALUES = [
    'approved', "it's", "rock'n'roll", 'a"b', '"quoted"', "'single'", '"a\\"}"', "'it''s'", '"a}b"',
    "'a}b'", 'x:y', 'a b c', '"a, b: c"', "'a, b: c'", '2', '"it\'s"', "'say \"hi\"'", "don't}",
    'a\\b', "'a\\'", '"%% not a comment"', "o'clock, x",
  ]; // prettier-ignore
  const TAILS = ['', ' ', ' %% a comment', " %% it's a comment }", ' %% "quoted" @{ }'];
  const cases = VALUES.flatMap((value) => TAILS.map((tail) => ({ value, tail })));

  it.each(cases)('state: $value, followed by `$tail`', ({ value, tail }) => {
    const line = `data d @{ state: ${value} }${tail}`;
    let expected: unknown;
    try {
      expected = (
        yaml.load(`{ state: ${value} }`, { schema: yaml.JSON_SCHEMA }) as { state: unknown }
      ).state;
    } catch {
      expected = undefined;
    }
    const source = inLane(line);
    // With a line after it that has an error of its own, on line 4.
    const followed = inLane(line, 'end timer after');
    const keys = Object.keys(
      (() => {
        try {
          return yaml.load(`{ state: ${value} }`, { schema: yaml.JSON_SCHEMA }) as object;
        } catch {
          return {};
        }
      })()
    );
    if (keys.length === 1 && (typeof expected === 'string' || typeof expected === 'number')) {
      const node = parseBpmn(source).nodes.find((n) => n.id === 'd');
      expect(node?.state).toBe(String(expected).trim());
    } else {
      // Not one state: whatever is wrong is reported on this line, as a BPMN error or a
      // syntax error, not on the line after it.
      expect(lineOf(errorOf(followed)!)).toBe(3);
    }
  });
});

/**
 * The keywords the grammar lets open an element's statement: the words of the choice each of
 * its element rules starts with. They are read from the grammar, so that a keyword added to it
 * is tested here without being listed again.
 */
const elementKeywords = (): string[] => {
  const words = (production: IProduction): string[] =>
    production instanceof Terminal
      ? [(production.terminalType.PATTERN as RegExp).source.replaceAll('\\', '')]
      : ((production as { definition?: IProduction[] }).definition ?? []).flatMap(words);
  const rules = bpmnParser.getGAstProductions();
  return ['container', 'event', 'gateway', 'activity', 'artifact'].flatMap((rule) =>
    words(rules[rule].definition.find((production) => production instanceof Alternation)!)
  );
};

describe('a line after a block left open declares a name when it opens as a statement does', () => {
  const flowError = /^BPMN error at line 4, column 5: the flow "t --> zz" refers to "zz"/;
  const blockError = /^BPMN error at line 5, column 12: the attributes block opened here/;
  /** The error for a flow to `zz` written before a block that `next` follows. */
  const errorsWith = (next: string): (string | undefined)[] => [
    // The block runs on, and `next` is the line that closes it.
    errorOf(inLane('task t', 't --> zz', 'task u @{', `${next} }`)),
    // The block is never closed, and what follows `next` cannot be read.
    errorOf(inLane('task t', 't --> zz', 'task u @{ marker: loop', next, 'task v $')),
  ];

  const keywords = elementKeywords();

  it('reads the keywords from the grammar', () => {
    expect(keywords).toEqual(
      expect.arrayContaining(['pool', 'start', 'end', 'xor', 'task', 'call', 'data-store', 'note'])
    );
  });

  it.each(keywords)('`%s zz` declares zz', (keyword) => {
    for (const message of errorsWith(`${keyword} zz`)) {
      expect(message).toMatch(blockError);
    }
    for (const message of errorsWith(`  ${keyword}\tzz "Z"`)) {
      expect(message).toMatch(blockError);
    }
  });

  it.each(TASK_TYPES.flatMap((type) => ['task', 'subprocess', 'call'].map((kind) => [type, kind])))(
    '`%s %s zz` declares zz',
    (type, kind) => {
      for (const message of errorsWith(`${type} ${kind} zz`)) {
        expect(message).toMatch(blockError);
      }
    }
  );

  it.each(
    ['start', 'intermediate', 'boundary', 'end', 'throw'].flatMap((event) =>
      EVENT_TRIGGERS.map((trigger) => [event, trigger])
    )
  )('`%s %s zz` declares zz', (event, trigger) => {
    for (const message of errorsWith(`${event} ${trigger} zz`)) {
      expect(message).toMatch(blockError);
    }
  });

  // Lines that name zz without declaring it: the flow to it is reported.
  it.each([
    ...EVENT_TRIGGERS.map((trigger) => `${trigger} zz`),
    ...TASK_TYPES.map((type) => `${type} zz`),
    ...BPMN_DIRECTIONS.map((direction) => `${direction} zz`),
    ...EVENT_TRIGGERS.map((trigger) => `task ${trigger} zz`),
    ...TASK_TYPES.map((type) => `${type} xor zz`),
    'zz',
    'zz: 1',
    'marker: zz',
    'state: task zz',
    'compensation, zz ]',
    'none, zz: y',
    'multiple: true, zz: 1',
    'task, zz: process',
    'task: zz',
    'task "T" zz',
    'task t2 zz',
    '- task zz',
    '"task" zz',
    'x task zz',
    'tasks zz',
    'task-x zz',
    'user, task zz',
    'end timer, zz',
    'end timer timer zz',
    'zz --> t',
    't --> zz',
    'title zz',
    'accTitle: zz',
  ])('`%s` does not declare zz', (next) => {
    for (const message of errorsWith(next)) {
      expect(message).toMatch(flowError);
    }
  });
});

// A reading that goes back over the block for each unit takes most of a minute at these lengths
// on a fast machine. The bound leaves room for a machine several times slower than that.
describe('a long block is read within five seconds', () => {
  const UNITS = [
    '"', "'", '\\', '\\"', "\\'", '""', "''", '{', '}', '[', ']', ',', ':', '@{', '"a', "'a",
    '%%', ' ', 'a: "', "a: '", '{"', '\\\\', '!', '!<', '!<,', '!<a>', '!!str ', '&', '&a ', '*',
    '*a ', '?', '? ', '"a":&x', '"a":!<', '}%%', '>', '#',
  ]; // prettier-ignore
  const shapes = UNITS.flatMap((unit) => [
    { unit, line: `data d @{ state: ${unit.repeat(100_000)}` },
    { unit, line: `data d @{ state: ${unit.repeat(100_000)} }` },
    { unit, line: `data d @{ state: "${unit.repeat(100_000)}` },
    { unit, line: `data d @{ ${unit.repeat(100_000)}: x }` },
  ]);

  it.each([
    ['plain', (index: number) => `k${index}: 1`],
    ['quoted', (index: number) => `"k${index}": 1`],
    ['listed', (index: number) => `k${index}: [a, "b"]`],
    ['tagged', (index: number) => `!!str k${index}: &a${index} 1`],
  ])('a block of 100,000 %s keys', (_, entry) => {
    const line = `task t @{ ${Array.from({ length: 100_000 }, (_, index) => entry(index)).join(', ')} }`;
    const started = performance.now();
    expect(errorOf(inLane(line))).toMatch(/column \d+: "k0" is not an attribute/);
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it.each(shapes)('100,000 of $unit: $line.length characters', ({ line }) => {
    const started = performance.now();
    errorOf(inLane(line, 'task u @{ marker: loop }'));
    expect(performance.now() - started).toBeLessThan(5000);
  });

  // The lines after a block left open are read on, to find whether one of them closes it. That
  // reading takes a few milliseconds at this length, and took minutes when it was quadratic.
  it.each(UNITS)('100,000 of %s on the line after a block left open', (unit) => {
    const started = performance.now();
    scanAttributeBlock(`@{ marker: loop\n${unit.repeat(100_000)}`, 0, true);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it.each(['"a":&x', '!<,'])('a diagram with 50,000 of %s after a block left open', (unit) => {
    const started = performance.now();
    expect(errorOf(inLane('task t @{ marker: loop', unit.repeat(50_000)))).toMatch(
      /is never closed/
    );
    expect(performance.now() - started).toBeLessThan(5000);
  });

  // A line separator is no line break here, so it stands inside the block's text.
  it.each(['\u2028', '\u2029'])('100,000 of }%%%% before the separator %j', (separator) => {
    const started = performance.now();
    expect(errorOf(inLane(`data d @{ state: "${'}%%'.repeat(100_000)}${separator}`))).toMatch(
      /cannot be read \(unexpected end of the stream within a double quoted scalar\)/
    );
    expect(performance.now() - started).toBeLessThan(5000);
  });
});
