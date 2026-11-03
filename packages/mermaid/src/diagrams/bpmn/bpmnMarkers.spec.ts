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
    ['loop task t "T"', 'standard'],
    ['parallel task t "T"', 'parallel'],
    ['sequential task t "T"', 'sequential'],
    ['task t "T" @{ loop: true }', 'standard'],
    ['task t "T" @{ loop: standard }', 'standard'],
    ['task t "T" @{ loop: parallel }', 'parallel'],
    ['task t "T" @{ loop: sequential }', 'sequential'],
  ])('reads `%s` as a %s loop', (line, loop) => {
    expect(parsed(inLane(line)).get('t')?.loop).toBe(loop);
  });

  it('writes the modifiers and the attributes into one bottom row, in the order the notation groups them', () => {
    const nodes = build(
      inLane('parallel ad-hoc subprocess s "S" @{ compensation: true }', 'loop user task t "T"')
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
    const nodes = build(inLane('user call c1 "C1"', 'call subprocess c2 "C2"', 'call c3 "C3"'));
    expect(nodes.get('c1')?.icon).toBe('bpmn:user');
    expect(nodes.get('c1')?.markers).toBeUndefined();
    expect(nodes.get('c2')?.markers).toEqual(['bpmn:subprocess']);
    expect(nodes.get('c3')?.markers).toBeUndefined();
    expect(nodes.get('c2')?.cssClasses).toContain('bpmn-call');
  });

  it('marks a compensation activity with a class as well as the marker', () => {
    expect(build(inLane('task t "T" @{ compensation: true }')).get('t')?.cssClasses).toContain(
      'bpmn-compensation'
    );
  });

  it('only names glyphs the icon pack defines', () => {
    const pack = new Set(Object.keys(bpmnIcons.icons));
    const nodes = build(
      inLane('loop task a "A"', 'parallel task b "B"', 'sequential ad-hoc subprocess c "C"')
    );
    for (const node of nodes.values()) {
      for (const marker of node.markers ?? []) {
        expect(pack.has(marker.replace(/^bpmn:/, ''))).toBe(true);
      }
    }
  });

  it('still reads parallel-multiple as a trigger', () => {
    expect(parsed(inLane('start parallel-multiple s "S"')).get('s')?.qualifier).toBe(
      'parallel-multiple'
    );
  });

  it.each([
    ['ad-hoc task t "T"', 'ad-hoc marks a subprocess, so a task cannot be ad-hoc'],
    ['ad-hoc call c "C"', 'a call activity cannot be ad-hoc'],
    ['loop parallel task t "T"', 'takes one of loop, parallel and sequential'],
    ['ad-hoc ad-hoc subprocess s "S"', 'ad-hoc is written twice'],
    ['loop task t "T" @{ loop: parallel }', 'the loop marker is already written'],
    ['ad-hoc subprocess s "S" @{ adhoc: true }', 'ad-hoc is already written'],
  ])('refuses `%s`', (line, message) => {
    expect(() => parseBpmn(inLane(line))).toThrow(message);
  });

  it('names the line and column of a refused marker', () => {
    expect(() => parseBpmn(inLane('task a "A"', 'ad-hoc task t "T"'))).toThrow(
      /^BPMN error at line 4, column 5: /
    );
  });
});

describe('element attributes', () => {
  beforeEach(() => db.clear());

  it('draws an exclusive gateway without its X when asked', () => {
    const nodes = build(
      inLane('xor a "A" @{ marker: none }', 'xor b "B" @{ marker: false }', 'xor c "C"')
    );
    expect(nodes.get('a')?.icon).toBeUndefined();
    expect(nodes.get('b')?.icon).toBeUndefined();
    expect(nodes.get('c')?.icon).toBe('bpmn:exclusive');
  });

  it('writes a data object state under its name', () => {
    const nodes = build(
      inLane('data d "Order" @{ state: approved }', 'data-input i "Form" @{ state: 2 }')
    );
    expect(nodes.get('d')?.label).toBe('Order<br>[approved]');
    expect(nodes.get('i')?.label).toBe('Form<br>[2]');
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
    [
      'task t "T" @{ colour: red }',
      '"colour" is not an attribute of a task, which takes loop or compensation',
    ],
    ['subprocess s "S" @{ state: x }', 'which takes loop, compensation or adhoc'],
    ['and g "G" @{ marker: none }', 'an and gateway takes no attributes'],
    ['start s "S" @{ loop: true }', 'a start event takes no attributes'],
    ['data-store ds "D" @{ state: x }', 'a data store takes no attributes'],
    [
      'task t "T" @{ loop: twice }',
      'loop takes true, standard, parallel or sequential, not "twice"',
    ],
    ['task t "T" @{ compensation: yes }', 'compensation takes true or false, not "yes"'],
    ['xor g "G" @{ marker: hidden }', 'marker takes true, false or none'],
    ['data d "D" @{ state: "[x]" }', 'state takes a name without brackets'],
    ['data d "D" @{ state: "" }', 'state takes a name without brackets'],
    ['task t "T" @{ loop: [ }', 'cannot be read'],
    ['task t "T" @{ - a }', 'cannot be read'],
  ])('refuses `%s`', (line, message) => {
    expect(() => parseBpmn(inLane(line))).toThrow(message);
  });

  it('names the line and column of the block it refuses', () => {
    expect(() => parseBpmn(inLane('task t "T" @{ colour: red }'))).toThrow(
      /^BPMN error at line 3, column 16: /
    );
  });

  it('refuses a block on a lane, which takes nothing yet', () => {
    expect(() => parseBpmn('bpmn-beta LR\n  lane l "L" @{ multiple: true }')).toThrow(
      'a lane takes no attributes'
    );
  });
});
