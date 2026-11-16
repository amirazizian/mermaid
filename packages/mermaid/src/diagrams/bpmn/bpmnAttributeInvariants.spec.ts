import { describe, it, expect } from 'vitest';
import * as yaml from 'js-yaml';
import { parseBpmn, writtenKeys } from './parser/bpmn.parser.js';

/**
 * These tests state what the `@{ }` block promises as rules over many inputs, rather than as
 * single examples: of two rule errors in a diagram, the one written first is reported; a line
 * that follows, and neither closes a block nor breaks the syntax, does not change the error a
 * line gives; a key is found where YAML reads it; and a line of any content, 200,000 units
 * long, is read within a bound that a quadratic reading would miss by minutes.
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

describe('a key is found where YAML reads it', () => {
  const random = seeded(8167);
  const bodies = Array.from({ length: 4000 }, () => randomBody(random));

  it('finds the keys YAML reads, in those of 4000 generated blocks that YAML can read', () => {
    let readable = 0;
    for (const body of bodies) {
      let read: unknown;
      try {
        read = yaml.load(`{${body}}`, { schema: yaml.JSON_SCHEMA });
      } catch {
        continue;
      }
      if (!read || typeof read !== 'object' || Array.isArray(read)) {
        continue;
      }
      readable++;
      const image = `@{${body}}`;
      const found = writtenKeys(image);
      const where = `for the block ${JSON.stringify(image)}`;
      // Every key found is one YAML reads, and stands where the scan says it does. Blocks
      // with a tag, an anchor, an alias or a `?` key are left out of this check: the pieces
      // put them together at random, mostly in ways the scan does not follow.
      const plain = !/[!&*?]/.test(body);
      for (const { key, offset } of found) {
        if (plain) {
          expect(Object.keys(read), where).toContain(key);
        }
        expect(offset, where).toBeGreaterThanOrEqual(2);
        expect(image[offset], where).not.toMatch(/[\s,{}]/);
      }
      // Every key YAML reads from a plain or quoted scalar is found. A list or a mapping
      // written as a key is not followed; the blocks built below cover those as values.
      for (const key of !plain || /[[{]/.test(body) ? [] : Object.keys(read)) {
        if (!/^[\w-]+$/.test(key) || key === 'null') {
          continue;
        }
        expect(
          found.map((entry) => entry.key),
          where
        ).toContain(key);
      }
      const offsets = found.map((entry) => entry.offset);
      expect(
        [...offsets].sort((a, b) => a - b),
        where
      ).toEqual(offsets);
    }
    expect(readable).toBeGreaterThan(1000);
  });
});

describe('a key is found where it is written', () => {
  // How a key is written, and the name YAML gives it.
  const KEYS: [string, string][] = [
    ['marker', 'marker'], ['"state"', 'state'], ["'calls'", 'calls'], ['2', '2'], ['"a b"', 'a b'],
    ['"q\\"k"', 'q"k'], ["'it''s'", "it's"], ['ad-hoc', 'ad-hoc'], ['true', 'true'], ['"x: y"', 'x: y'],
    ['"a,b"', 'a,b'], ['"}"', '}'], ["'{'", '{'], ['k.1', 'k.1'],
  ]; // prettier-ignore
  const VALUES = [
    'loop', '1', 'true', '""', "''", '"a, foo: b"', "'a, foo: b'", '"a\\"}"', "'a\\'", "'it''s, k: v'",
    '[a, b]', '[ "x, y: z", c ]', '{ in: 1, ner: 2 }', '{ a: [1, { b: "}" }] }', '"{"', "'['",
    '"\\\\"', 'a b c', 'null', '', '"]"', '[[], {}]',
  ]; // prettier-ignore
  const SEPARATORS = [', ', ',', ' , ', ',  '];
  const random = seeded(8160);
  const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];

  it('holds for 3000 blocks built from keys and values of every shape', () => {
    for (let run = 0; run < 3000; run++) {
      let image = `@{${pick(['', ' ', '  '])}`;
      const expected: { key: string; offset: number }[] = [];
      const names = new Set<string>();
      const count = 1 + Math.floor(random() * 4);
      for (let index = 0; index < count; index++) {
        const [written, name] = pick(KEYS);
        if (names.has(name)) {
          continue;
        }
        if (expected.length > 0) {
          image += pick(SEPARATORS);
        }
        names.add(name);
        expected.push({ key: name, offset: image.length });
        image += `${written}${pick([': ', ' : ', ':  '])}${pick(VALUES)}`;
      }
      image += `${pick(['', ' '])}}`;
      const where = `for the block ${JSON.stringify(image)}`;
      const read = yaml.load(image.slice(1), { schema: yaml.JSON_SCHEMA }) as object;
      expect(Object.keys(read).sort(), where).toEqual([...names].sort());
      expect(writtenKeys(image), where).toEqual(expected);
    }
  });
});

describe('a value is read as YAML reads it', () => {
  it.each([
    ['!!str "a}b"', 'a}b'],
    ['&x "a}b"', 'a}b'],
    ["!!str 'a}b'", 'a}b'],
    ['!!str plain', 'plain'],
  ])('state: %s, behind a tag or an anchor', (value, state) => {
    const node = parseBpmn(inLane(`data d @{ state: ${value} } %% note`)).nodes.find(
      (n) => n.id === 'd'
    );
    expect(node?.state).toBe(state);
  });

  it.each([
    ['task t @{ !!str "a}b": 1 }', /column 21: "a}b" is not an attribute/],
    ['task t @{ [a]:"x}y" }', /column 12: "a" is not an attribute/],
    ['task t @{ marker: {a: 1}:"x}y" }', /cannot be read|marker takes/],
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

// A reading that goes back over the line for each unit takes minutes at this length.
describe('a long line is read within two seconds', () => {
  const UNITS = [
    '"', "'", '\\', '\\"', "\\'", '""', "''", '{', '}', '[', ']', ',', ':', '@{', '"a', "'a",
    '%%', ' ', 'a: "', "a: '", '{"', '\\\\',
  ]; // prettier-ignore
  const shapes = UNITS.flatMap((unit) => [
    { unit, line: `data d @{ state: ${unit.repeat(200_000)}` },
    { unit, line: `data d @{ state: ${unit.repeat(200_000)} }` },
    { unit, line: `data d @{ state: "${unit.repeat(200_000)}` },
    { unit, line: `data d @{ ${unit.repeat(200_000)}: x }` },
  ]);

  it.each([
    ['plain', (index: number) => `k${index}: 1`],
    ['quoted', (index: number) => `"k${index}": 1`],
    ['listed', (index: number) => `k${index}: [a, "b"]`],
  ])('a block of 40,000 %s keys', (_, entry) => {
    const line = `task t @{ ${Array.from({ length: 40_000 }, (_, index) => entry(index)).join(', ')} }`;
    const started = performance.now();
    expect(errorOf(inLane(line))).toMatch(/column 15: "k0" is not an attribute/);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it.each(shapes)('200,000 of $unit: $line.length characters', ({ line }) => {
    const started = performance.now();
    errorOf(inLane(line, 'task u @{ marker: loop }'));
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
