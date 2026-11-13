import { CstParser, Lexer } from 'chevrotain';
import type { CstNode, IToken } from 'chevrotain';
import * as yaml from 'js-yaml';
import * as t from './bpmn.tokens.js';
import { bpmnTokens } from './bpmn.tokens.js';
import {
  ACTIVITY_MARKERS,
  CALL_TARGETS,
  ELEMENT_ATTRIBUTES,
  LOOP_KINDS,
  TRIGGERS_BY_POSITION,
  positionsFor,
} from '../types.js';
import type { LoopKind } from '../types.js';
import { isKnownLocation, runChevrotainParse } from '../../common/parser/runChevrotainParse.js';
import { scanAttributeBlock } from './bpmnAttributeBlock.js';

const listOf = (items: string[]): string =>
  items.length > 1 ? `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}` : items[0];

class BpmnParser extends CstParser {
  constructor() {
    super(t.bpmnTokens, { recoveryEnabled: false });
    this.performSelfAnalysis();
  }

  public diagram = this.RULE('diagram', () => {
    this.MANY(() => this.CONSUME(t.Newline));
    this.OPTION(() => this.CONSUME(t.Indent));
    this.CONSUME(t.Header);
    this.OPTION2(() => this.CONSUME(t.Direction));
    this.MANY2(() => this.SUBRULE(this.line));
  });

  private line = this.RULE('line', () => {
    this.AT_LEAST_ONE(() => this.CONSUME(t.Newline));
    this.OPTION(() => this.CONSUME(t.Indent));
    this.OPTION2(() =>
      this.OR([
        { ALT: () => this.SUBRULE(this.container) },
        { ALT: () => this.SUBRULE(this.event) },
        { ALT: () => this.SUBRULE(this.gateway) },
        { ALT: () => this.SUBRULE(this.activity) },
        { ALT: () => this.SUBRULE(this.artifact) },
        { ALT: () => this.SUBRULE(this.meta) },
        { ALT: () => this.SUBRULE(this.flow) },
      ])
    );
  });

  private container = this.RULE('container', () => {
    this.OR([
      { ALT: () => this.CONSUME(t.Pool) },
      { ALT: () => this.CONSUME(t.Lane) },
      { ALT: () => this.CONSUME(t.Group) },
    ]);
    this.SUBRULE(this.nameAndLabel);
  });

  private event = this.RULE('event', () => {
    this.OR([
      { ALT: () => this.CONSUME(t.Start) },
      { ALT: () => this.CONSUME(t.Intermediate) },
      { ALT: () => this.CONSUME(t.Boundary) },
      { ALT: () => this.CONSUME(t.End) },
      { ALT: () => this.CONSUME(t.Throw) },
    ]);
    this.OPTION(() => this.CONSUME(t.Trigger));
    this.SUBRULE(this.nameAndLabel);
  });

  private gateway = this.RULE('gateway', () => {
    this.OR([
      { ALT: () => this.CONSUME(t.Xor) },
      { ALT: () => this.CONSUME(t.And) },
      { ALT: () => this.CONSUME(t.Or) },
      { ALT: () => this.CONSUME(t.EventGateway) },
      { ALT: () => this.CONSUME(t.Complex) },
    ]);
    this.SUBRULE(this.nameAndLabel);
  });

  private activity = this.RULE('activity', () => {
    this.OPTION(() => this.CONSUME(t.TaskType));
    this.OR([
      { ALT: () => this.CONSUME(t.Task) },
      { ALT: () => this.CONSUME(t.Subprocess) },
      { ALT: () => this.CONSUME(t.Call) },
    ]);
    this.SUBRULE(this.nameAndLabel);
  });

  private artifact = this.RULE('artifact', () => {
    this.OR([
      { ALT: () => this.CONSUME(t.DataStore) },
      { ALT: () => this.CONSUME(t.DataCollection) },
      { ALT: () => this.CONSUME(t.DataInput) },
      { ALT: () => this.CONSUME(t.DataOutput) },
      { ALT: () => this.CONSUME(t.DataObject) },
      { ALT: () => this.CONSUME(t.Annotation) },
    ]);
    this.SUBRULE(this.nameAndLabel);
  });

  private meta = this.RULE('meta', () => {
    this.OR([
      { ALT: () => this.CONSUME(t.Title) },
      { ALT: () => this.CONSUME(t.AccTitle) },
      { ALT: () => this.CONSUME(t.AccDescrMultiline) },
      { ALT: () => this.CONSUME(t.AccDescr) },
    ]);
  });

  private nameAndLabel = this.RULE('nameAndLabel', () => {
    this.OPTION(() => this.CONSUME(t.Identifier));
    this.OPTION2(() => this.CONSUME(t.QuotedString));
    this.OPTION3(() => this.CONSUME(t.Attributes));
  });

  private flow = this.RULE('flow', () => {
    this.CONSUME(t.Identifier);
    this.AT_LEAST_ONE(() => {
      this.OR([
        { ALT: () => this.CONSUME(t.LabelledArrow) },
        { ALT: () => this.CONSUME(t.MessageArrow) },
        { ALT: () => this.CONSUME(t.Arrow) },
        { ALT: () => this.CONSUME(t.AssociationArrow) },
        { ALT: () => this.CONSUME(t.AssociationLine) },
      ]);
      this.CONSUME2(t.Identifier);
    });
  });
}

export const bpmnParser = new BpmnParser();
export const BpmnBaseVisitor = bpmnParser.getBaseCstVisitorConstructorWithDefaults();

export const bpmnLexer = new Lexer(bpmnTokens, { positionTracking: 'onlyStart' });

export interface ParsedNode {
  kind:
    | 'pool'
    | 'lane'
    | 'group'
    | 'event'
    | 'gateway'
    | 'activity'
    | 'data'
    | 'store'
    | 'annotation';

  keyword: string;

  qualifier?: string;
  id: string;
  label: string;
  level: number;
  parentId?: string;

  /** How an activity repeats: a standard loop, or multi-instance in parallel or in sequence. */
  loop?: LoopKind;
  /** An activity that compensates another, drawn with the compensation marker. */
  compensation?: boolean;
  /** An ad-hoc sub-process, drawn with the tilde marker. */
  adHoc?: boolean;
  /** A call activity that calls a process rather than a task, drawn with the `+` marker. */
  callsProcess?: boolean;
  /** An exclusive gateway drawn without its `X`. */
  unmarked?: boolean;
  /** A data object's state, drawn under its name in brackets. */
  state?: string;
  /** A pool that stands for several participants of one kind. */
  multiple?: boolean;
}

export interface ParsedFlow {
  from: string;
  to: string;
  label?: string;
  kind: 'sequence' | 'message' | 'association';

  directed?: boolean;
}

export interface ParsedDiagram {
  direction: string;
  nodes: ParsedNode[];
  flows: ParsedFlow[];
  title?: string;
  accTitle?: string;
  accDescr?: string;
}

const imageOf = (token?: IToken) => token?.image ?? '';

interface Location {
  line: number;
  column: number;
}

// The lines the text being parsed was shifted up by, so an error names a line of the source.
let lineOffset = 0;

const locationOf = (token: IToken | undefined): Location | undefined =>
  token && isKnownLocation(token.startLine) && isKnownLocation(token.startColumn)
    ? { line: token.startLine + lineOffset, column: token.startColumn }
    : undefined;

const atText = (where: Location | undefined): string =>
  where ? ` at line ${where.line}, column ${where.column}` : '';

const LOCATED = /^BPMN error at line (\d+), column (\d+)/;

/** The place a BPMN error names, as `atText` wrote it. */
const locationIn = (error: unknown): Location | undefined => {
  const found = error instanceof Error ? LOCATED.exec(error.message) : null;
  return found ? { line: Number(found[1]), column: Number(found[2]) } : undefined;
};

/** The article a keyword takes in a message: `an` before a vowel sound (`end`, `intermediate`, `xor`). */
const articleFor = (word: string): string => (/^[aeiox]/i.test(word) ? 'an' : 'a');

/** Where each parsed node and flow was written, kept beside them so they stay plain data. */
const written = new WeakMap<object, Location>();

/** The first token a rule consumed, which is where its statement starts. */
const firstTokenOf = (rule: CstNode): IToken | undefined => {
  const tokens = Object.values(rule.children).flatMap((children) =>
    children.map((child) => ('tokenType' in child ? child : firstTokenOf(child)))
  );
  return tokens.reduce<IToken | undefined>(
    (first, token) => (token && (!first || token.startOffset < first.startOffset) ? token : first),
    undefined
  );
};

/** A key of an element's `@{ }` block, and where in the block's text it is written. */
interface WrittenKey {
  key: string;
  offset: number;
}

/**
 * What was written in an element's `@{ }` block: its values, its keys in the order they are
 * written, where it starts, and its text.
 */
interface WrittenAttributes {
  values: Record<string, unknown>;
  keys: WrittenKey[];
  /** Where each key is first written, counted from the start of the block. */
  offsets: Map<string, number>;
  at?: Location;
  image: string;
}

/** A block that could not be read. The error is kept until the element has been declared. */
interface UnreadableAttributes {
  unreadable: Error;
}

/** What was written in an element's `@{ }` block, held until the element knows its own kind. */
const pendingAttributes = new WeakMap<object, WrittenAttributes | UnreadableAttributes>();

const remember = (parsed: object, token: IToken | undefined): void => {
  const where = locationOf(token);
  if (where) {
    written.set(parsed, where);
  }
};

const arrowLabel = (image: string) => image.replace(/^--/, '').replace(/-+>$/, '').trim();

class BpmnVisitor extends BpmnBaseVisitor {
  private nodes: ParsedNode[] = [];
  private flows: ParsedFlow[] = [];
  private direction = 'LR';
  private title: string | undefined;
  private accTitle: string | undefined;
  private accDescr: string | undefined;
  private generated = 0;
  private declared = new Set<string>();

  private baseLevel: number | undefined;
  /** The errors found while reading, each with where its statement starts. */
  private problems: { at?: Location; error: unknown }[] = [];
  /** When set, only an error written before this place is thrown. */
  private onlyBefore: Location | undefined;
  /**
   * Text that was left out of the reading. A flow's end that is named in it may be declared
   * there, so it is not reported as undeclared.
   */
  private leftOut: string | undefined;

  constructor() {
    super();
    this.validateVisitor();
  }

  public reset(options: { onlyBefore?: Location; leftOut?: string } = {}) {
    this.onlyBefore = options.onlyBefore;
    this.leftOut = options.leftOut;
    this.nodes = [];
    this.flows = [];
    this.direction = 'LR';
    this.title = undefined;
    this.accTitle = undefined;
    this.accDescr = undefined;
    this.generated = 0;
    this.declared = new Set();
    this.baseLevel = undefined;
    this.problems = [];
  }

  /**
   * Runs `check` and keeps what it throws instead of stopping, so that once every statement
   * has been read the error written first in the source is the one reported.
   */
  private attempt<T>(at: Location | undefined, check: () => T): T | undefined {
    try {
      return check();
    } catch (error) {
      // An error that names its own place is ranked by it, so that of two errors in one
      // statement the one written first is reported.
      this.problems.push({ at: locationIn(error) ?? at, error });
      return undefined;
    }
  }

  /** Throws the error written first in the source, if any was found. */
  private throwFirstProblem(): void {
    const rank = (at?: Location) => (at ? [at.line, at.column] : [Infinity, Infinity]);
    const order = (a?: Location, b?: Location) => {
      const [lineA, columnA] = rank(a);
      const [lineB, columnB] = rank(b);
      return lineA - lineB || columnA - columnB;
    };
    const [first] = [...this.problems].sort((a, b) => order(a.at, b.at));
    if (first && (!this.onlyBefore || order(first.at, this.onlyBefore) < 0)) {
      throw first.error;
    }
  }

  public result(): ParsedDiagram {
    return {
      direction: this.direction,
      nodes: this.nodes,
      flows: this.flows,
      ...(this.title ? { title: this.title } : {}),
      ...(this.accTitle ? { accTitle: this.accTitle } : {}),
      ...(this.accDescr ? { accDescr: this.accDescr } : {}),
    };
  }

  public diagram(ctx: Record<string, CstNode[] | IToken[]>) {
    const direction = (ctx.Direction as IToken[] | undefined)?.[0];
    if (direction) {
      this.direction = direction.image;
    }
    for (const line of (ctx.line as CstNode[] | undefined) ?? []) {
      this.visit(line);
    }
    this.assignGeneratedIds();
    this.assignParents();
    const leftOut = this.leftOut;
    const declared = leftOut
      ? new Set([
          ...this.declared,
          ...this.flows
            .flatMap((flow) => [flow.from, flow.to])
            .filter((id) => leftOut.includes(id)),
        ])
      : this.declared;
    for (const flow of this.flows) {
      this.attempt(written.get(flow), () => assertFlowRefersToDeclaredElements(flow, declared));
    }
    this.throwFirstProblem();
  }

  public line(ctx: Record<string, CstNode[] | IToken[]>) {
    const indent = (ctx.Indent as IToken[] | undefined)?.[0];
    const level = indent ? indent.image.length : 0;
    const meta = (ctx.meta as CstNode[] | undefined)?.[0];
    if (meta) {
      this.visit(meta);
      return;
    }
    for (const key of ['container', 'event', 'gateway', 'activity', 'artifact'] as const) {
      const rule = (ctx[key] as CstNode[] | undefined)?.[0];
      if (rule) {
        const at = locationOf(firstTokenOf(rule));
        const node = this.attempt(at, () => this.visit(rule) as ParsedNode);
        if (!node) {
          return;
        }
        remember(node, firstTokenOf(rule));
        this.attempt(at, () => applyAttributes(node));
        this.baseLevel ??= level;
        node.level = Math.max(0, level - this.baseLevel);
        this.nodes.push(node);
        return;
      }
    }
    const flow = (ctx.flow as CstNode[] | undefined)?.[0];
    if (flow) {
      this.visit(flow);
    }
  }

  public container(ctx: Record<string, CstNode[] | IToken[]>): ParsedNode {
    const keyword = ctx.Pool ? 'pool' : ctx.Group ? 'group' : 'lane';
    return this.element(ctx, keyword, keyword);
  }

  public event(ctx: Record<string, CstNode[] | IToken[]>): ParsedNode {
    const opener = ['Start', 'Intermediate', 'Boundary', 'End', 'Throw'].find((name) => ctx[name]);
    const keyword = opener?.toLowerCase() ?? 'start';
    const node = this.element(ctx, 'event', keyword);
    const triggerToken = (ctx.Trigger as IToken[] | undefined)?.[0];
    node.qualifier = imageOf(triggerToken) || undefined;
    this.checkTrigger(
      keyword,
      node.qualifier ?? 'none',
      triggerToken ?? (opener ? (ctx[opener] as IToken[])[0] : undefined)
    );
    return node;
  }

  private checkTrigger(keyword: string, trigger: string, at?: IToken): void {
    const allowed = TRIGGERS_BY_POSITION[keyword as keyof typeof TRIGGERS_BY_POSITION] as
      | readonly string[]
      | undefined;
    if (!allowed || allowed.includes(trigger)) {
      return;
    }
    const where = atText(locationOf(at)).trim();
    if (trigger === 'none') {
      throw new Error(
        `BPMN error ${where}: ${articleFor(keyword)} ${keyword} event must name what triggers it.`
      );
    }
    const positions = positionsFor(trigger);
    const instead = positions.length
      ? ` The notation draws ${trigger} on ${listOf(positions)} events.`
      : '';
    throw new Error(
      `BPMN error ${where}: ${articleFor(keyword)} ${keyword} event cannot carry the ${trigger} trigger.${instead}`
    );
  }

  public gateway(ctx: Record<string, CstNode[] | IToken[]>): ParsedNode {
    const byToken: Record<string, string> = {
      Xor: 'xor',
      And: 'and',
      Or: 'or',
      EventGateway: 'event-gateway',
      Complex: 'complex',
    };
    const token = Object.keys(byToken).find((name) => ctx[name]);
    return this.element(ctx, 'gateway', token ? byToken[token] : 'xor');
  }

  public activity(ctx: Record<string, CstNode[] | IToken[]>): ParsedNode {
    const keyword = ctx.Subprocess ? 'subprocess' : ctx.Call ? 'call' : 'task';
    const node = this.element(ctx, 'activity', keyword);
    node.qualifier = imageOf((ctx.TaskType as IToken[] | undefined)?.[0]) || undefined;
    return node;
  }

  public artifact(ctx: Record<string, CstNode[] | IToken[]>): ParsedNode {
    if (ctx.DataStore) {
      return this.element(ctx, 'store', 'data-store');
    }
    if (ctx.Annotation) {
      return this.element(ctx, 'annotation', 'note');
    }
    const node = this.element(ctx, 'data', 'data');
    node.qualifier = ctx.DataInput
      ? 'input'
      : ctx.DataOutput
        ? 'output'
        : ctx.DataCollection
          ? 'collection'
          : undefined;
    return node;
  }

  public meta(ctx: Record<string, IToken[]>) {
    const after = (image: string, keyword: string) =>
      image
        .slice(keyword.length)
        .replace(/^[\t :]+/, '')
        .trim();
    const title = ctx.Title?.[0];
    if (title) {
      this.title = after(imageOf(title), 'title');
    }
    const accTitle = ctx.AccTitle?.[0];
    if (accTitle) {
      this.accTitle = after(imageOf(accTitle), 'accTitle');
    }
    const accDescr = ctx.AccDescr?.[0];
    if (accDescr) {
      this.accDescr = after(imageOf(accDescr), 'accDescr');
    }
    const braced = ctx.AccDescrMultiline?.[0];
    if (braced) {
      this.accDescr = imageOf(braced)
        .replace(/^accDescr[\t ]*{/, '')
        .replace(/}$/, '')
        .trim();
    }
  }

  public nameAndLabel(ctx: Record<string, IToken[]>) {
    const quoted = ctx.QuotedString?.[0];
    const attributes = ctx.Attributes?.[0];
    return {
      id: imageOf(ctx.Identifier?.[0]),
      label: quoted ? quoted.image.slice(1, -1) : '',
      at: locationOf(ctx.Identifier?.[0]),
      ...(attributes ? { attributes: readAttributes(attributes) } : {}),
    };
  }

  public flow(ctx: Record<string, IToken[]>) {
    const byOffset = (a: IToken, b: IToken) => (a.startOffset ?? 0) - (b.startOffset ?? 0);
    const ids = [...(ctx.Identifier ?? [])].sort(byOffset);
    const connectors = [
      ...(ctx.LabelledArrow ?? []),
      ...(ctx.MessageArrow ?? []),
      ...(ctx.Arrow ?? []),
      ...(ctx.AssociationArrow ?? []),
      ...(ctx.AssociationLine ?? []),
    ].sort(byOffset);

    for (const [index, connector] of connectors.entries()) {
      const from = ids[index];
      const to = ids[index + 1];
      if (!from || !to) {
        break;
      }
      const name = connector.tokenType.name;
      const isAssociation = name === 'AssociationArrow' || name === 'AssociationLine';
      const parsedFlow: ParsedFlow = {
        from: from.image,
        to: to.image,
        kind: isAssociation ? 'association' : name === 'MessageArrow' ? 'message' : 'sequence',
        ...(isAssociation ? { directed: name === 'AssociationArrow' } : {}),
        label: name === 'LabelledArrow' ? arrowLabel(connector.image) : undefined,
      };
      remember(parsedFlow, from);
      this.flows.push(parsedFlow);
    }
  }

  private element(
    ctx: Record<string, CstNode[] | IToken[]>,
    kind: ParsedNode['kind'],
    keyword: string
  ): ParsedNode {
    const named = this.visit((ctx.nameAndLabel as CstNode[])[0]) as {
      id: string;
      label: string;
      at?: Location;
      attributes?: WrittenAttributes;
    };
    if (named.id) {
      this.declare(named.id, named.at);
    }
    const node: ParsedNode = {
      kind,
      keyword,
      id: named.id,
      label: named.label || named.id || '',
      level: 0,
    };
    if (named.attributes) {
      pendingAttributes.set(node, named.attributes);
    }
    return node;
  }

  private declare(id: string, at?: Location) {
    if (this.declared.has(id)) {
      throw new Error(
        `BPMN error${atText(at)}: "${id}" is already declared. Give each element its own id.`
      );
    }
    this.declared.add(id);
  }

  /** An element written without an id gets one that no element names. */
  private assignGeneratedIds() {
    for (const node of this.nodes.filter((candidate) => !candidate.id)) {
      do {
        node.id = `${node.keyword}-${++this.generated}`;
      } while (this.declared.has(node.id));
      this.declared.add(node.id);
    }
  }

  private assignParents() {
    for (const [index, node] of this.nodes.entries()) {
      for (let back = index - 1; back >= 0; back--) {
        if (this.nodes[back].level < node.level) {
          node.parentId = this.nodes[back].id;
          break;
        }
      }
      this.attempt(written.get(node), () =>
        assertPlaced(
          node,
          this.nodes.find((candidate) => candidate.id === node.parentId)
        )
      );
    }
  }
}

/** How an element is named in a message: the words its author would recognise. */
const describe = (node: ParsedNode): string => {
  switch (node.kind) {
    case 'event':
      return `${articleFor(node.keyword)} ${node.keyword} event`;
    case 'gateway':
      return `${articleFor(node.keyword)} ${node.keyword} gateway`;
    case 'data':
      return node.qualifier ? `a data-${node.qualifier}` : 'a data object';
    case 'store':
      return 'a data store';
    case 'annotation':
      return 'a note';
    case 'activity':
      return node.keyword === 'call' ? 'a call activity' : `a ${node.keyword}`;
    default:
      return `a ${node.keyword}`;
  }
};

const PLAIN_KEY = /^[A-Z_a-z][\w-]*$/;
const YAML_WORDS = new Set([
  'true',
  'false',
  'null',
  'True',
  'False',
  'Null',
  'TRUE',
  'FALSE',
  'NULL',
]);

/** A key as YAML names it in a flow mapping, so that `"2"`, `'2'` and `2` all name the key `2`. */
function keyName(written: string): string {
  if (PLAIN_KEY.test(written) && !YAML_WORDS.has(written)) {
    return written;
  }
  try {
    const read: unknown = yaml.load(`{${written}: 0}`, { schema: yaml.JSON_SCHEMA });
    const names = read && typeof read === 'object' ? Object.keys(read) : [];
    return names.length === 1 ? names[0] : written;
  } catch {
    return written;
  }
}

/** The keys written at the top of an element's `@{ }` block, in the order they are written. */
export function writtenKeys(image: string): WrittenKey[] {
  return scanAttributeBlock(image, 0).keys.map(({ text, offset }) => ({
    key: keyName(text),
    offset,
  }));
}

/**
 * Whether a block's text ends where the block closes. A block whose last quote is left open is
 * taken as closed when it ends in `}`, so that it is refused for the quote, not for the `}`.
 */
function isClosed(image: string): boolean {
  const scanned = scanAttributeBlock(image, 0);
  return scanned.closed || (scanned.openQuote && image.endsWith('}'));
}

/** A block as a message shows it: whole, unless it is long. */
const shown = (image: string): string =>
  image.length > 80 ? `${image.slice(0, 60)} … ${image.slice(-15)}` : image;

/** Reads the inside of `@{ ... }` as a YAML flow mapping. */
function readAttributes(token: IToken): WrittenAttributes | UnreadableAttributes {
  const at = locationOf(token);
  const image = token.image;
  const unreadable = (reason: string) => ({
    unreadable: new Error(
      `BPMN error${atText(at)}: the attributes ${shown(image)} cannot be read${reason}. Write them as key: value pairs separated by commas.`
    ),
  });
  let values: unknown;
  try {
    values = yaml.load(`{${image.slice(2, -1)}}`, { schema: yaml.JSON_SCHEMA });
  } catch (error) {
    return unreadable(` (${error instanceof yaml.YAMLException ? error.reason : String(error)})`);
  }
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    return unreadable('');
  }
  const keys = writtenKeys(image);
  const offsets = new Map<string, number>();
  for (const { key, offset } of keys) {
    if (!offsets.has(key)) {
      offsets.set(key, offset);
    }
  }
  return { values: values as Record<string, unknown>, keys, offsets, at, image };
}

/** A value as it is written, where YAML would read a number: `1.0` stays `1.0`, not `1`. */
function asWritten(written: WrittenAttributes, key: string): unknown {
  try {
    const read = yaml.load(`{${written.image.slice(2, -1)}}`, { schema: yaml.FAILSAFE_SCHEMA });
    return (read as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';

/**
 * An activity's `marker`: one marker or a list of them, from ACTIVITY_MARKERS. At most one says
 * how it repeats, `ad-hoc` marks a sub-process only, and none may be named twice.
 */
function applyActivityMarkers(node: ParsedNode, value: unknown, where: string): void {
  const markers = Array.isArray(value) ? value : [value];
  const known = ACTIVITY_MARKERS as readonly string[];
  if (markers.length === 0) {
    throw new Error(
      `${where}: marker takes ${listOf([...known])}, or a list of them, not an empty list. Leave marker out for an activity without markers.`
    );
  }
  const seen = new Set<string>();
  for (const marker of markers) {
    if (typeof marker !== 'string' || !known.includes(marker)) {
      throw new Error(
        `${where}: marker takes ${listOf([...known])}, or a list of them, not ${JSON.stringify(marker)}.`
      );
    }
    if (seen.has(marker)) {
      throw new Error(`${where}: the ${marker} marker is named twice.`);
    }
    seen.add(marker);
    if ((LOOP_KINDS as readonly string[]).includes(marker)) {
      if (node.loop) {
        throw new Error(
          `${where}: an activity takes one of ${listOf([...LOOP_KINDS])}, so ${marker} cannot join ${node.loop}.`
        );
      }
      node.loop = marker as LoopKind;
    } else if (marker === 'ad-hoc') {
      if (node.keyword !== 'subprocess') {
        throw new Error(
          `${where}: ad-hoc marks a subprocess, so ${describe(node)} cannot be ad-hoc.`
        );
      }
      node.adHoc = true;
    } else {
      node.compensation = true;
    }
  }
}

/** The row of `ELEMENT_ATTRIBUTES` an element reads its attributes from. */
const attributeRowOf = (node: ParsedNode): readonly string[] | undefined => {
  if (node.kind === 'data') {
    return ELEMENT_ATTRIBUTES.data;
  }
  if (node.kind === 'activity' || node.kind === 'pool' || node.keyword === 'xor') {
    return ELEMENT_ATTRIBUTES[node.keyword as keyof typeof ELEMENT_ATTRIBUTES];
  }
  return undefined;
};

/**
 * Where `key` is written inside an element's `@{ }` block, so an error about it points at the
 * key rather than at the `@{` that opens the block.
 */
function keyLocation(written: WrittenAttributes, key: string): Location | undefined {
  const offset = written.offsets.get(key);
  return written.at && offset !== undefined
    ? { line: written.at.line, column: written.at.column + offset }
    : written.at;
}

/** An element's attributes in the order they are written, not the order `Object.entries` gives. */
function entriesInWrittenOrder(written: WrittenAttributes): [string, unknown][] {
  const keys = new Set<string>();
  for (const key of written.offsets.keys()) {
    if (Object.hasOwn(written.values, key)) {
      keys.add(key);
    }
  }
  // A key the scan did not follow (a list or a mapping written as a key) comes last.
  for (const key of Object.keys(written.values)) {
    keys.add(key);
  }
  return [...keys].map((key) => [key, written.values[key]]);
}

/** Checks an element's `@{ }` block against what that element takes, and records each value. */
function applyAttributes(node: ParsedNode): void {
  const written = pendingAttributes.get(node);
  if (!written) {
    return;
  }
  if ('unreadable' in written) {
    throw written.unreadable;
  }
  const allowed = attributeRowOf(node);
  if (!allowed) {
    throw new Error(`BPMN error${atText(written.at)}: ${describe(node)} takes no attributes.`);
  }

  for (const [key, value] of entriesInWrittenOrder(written)) {
    if (!allowed.includes(key)) {
      throw new Error(
        `BPMN error${atText(keyLocation(written, key))}: "${key}" is not an attribute of ${describe(node)}, which takes ${listOf([...allowed])}.`
      );
    }
    const where = `BPMN error${atText(keyLocation(written, key))}`;
    const wrongValue = (expected: string) =>
      new Error(`${where}: ${key} takes ${expected}, not ${JSON.stringify(value)}.`);
    switch (key) {
      case 'multiple':
        if (!isBoolean(value)) {
          throw wrongValue('true or false');
        }
        node.multiple = value;
        break;
      case 'calls':
        if (typeof value !== 'string' || !(CALL_TARGETS as readonly string[]).includes(value)) {
          throw wrongValue(listOf([...CALL_TARGETS]));
        }
        if (value === 'process' && node.qualifier) {
          throw new Error(
            `${where}: a ${node.qualifier} call calls a global ${node.qualifier} task, so it cannot call a process. Drop ${node.qualifier} to call a process, or calls: process to call the task.`
          );
        }
        node.callsProcess = value === 'process';
        break;
      case 'marker':
        if (node.kind === 'activity') {
          applyActivityMarkers(node, value, where);
        } else if (value === 'none') {
          node.unmarked = true;
        } else {
          throw wrongValue('none');
        }
        break;
      case 'state': {
        const state = typeof value === 'number' ? asWritten(written, key) : value;
        if (typeof state !== 'string' || !state.trim() || /[[\]]/.test(state)) {
          throw wrongValue('a name without brackets');
        }
        node.state = state.trim();
        break;
      }
    }
  }
}

const CONTAINER_KINDS = new Set<ParsedNode['kind']>(['pool', 'lane', 'group']);

/** Only a pool, a lane or a group holds other elements, and a boundary event sits on an activity. */
function assertPlaced(node: ParsedNode, parent: ParsedNode | undefined): void {
  const where = `BPMN error${atText(written.get(node))}`;
  if (node.keyword === 'boundary') {
    if (parent?.kind !== 'activity') {
      throw new Error(
        `${where}: a boundary event must be indented under the activity it is attached to.`
      );
    }
    return;
  }
  if (parent && !CONTAINER_KINDS.has(parent.kind)) {
    throw new Error(
      `${where}: ${articleFor(node.keyword)} ${node.keyword} cannot be indented under the ${parent.keyword} "${parent.id}", because only a pool, a lane or a group holds other elements.`
    );
  }
}

const visitor = new BpmnVisitor();

const arrowOf = (flow: ParsedFlow): string => {
  if (flow.kind === 'message') {
    return '-.->';
  }
  if (flow.kind === 'association') {
    return flow.directed ? '..>' : '...';
  }
  return '-->';
};

/** A flow end that names no declared element has nothing to attach to, so it is refused here. */
function assertFlowRefersToDeclaredElements(flow: ParsedFlow, declared: ReadonlySet<string>): void {
  for (const id of [flow.from, flow.to]) {
    if (!declared.has(id)) {
      throw new Error(
        `BPMN error${atText(written.get(flow))}: the flow "${flow.from} ${arrowOf(flow)} ${flow.to}" refers to "${id}", which is not declared. Declare it as an element before using it.`
      );
    }
  }
}

const LINE_BREAK = /\r\n|\r|\n/;

/** Where chevrotain's last error stands; a missing token (end of input) sits after the last character. */
function syntaxErrorLocation(input: string, token: IToken): Location {
  const known = locationOf(token);
  if (known) {
    return known;
  }
  const lines = input.split(LINE_BREAK);
  return { line: lines.length + lineOffset, column: lines[lines.length - 1].length + 1 };
}

/** The first `@{` block that is not closed on its own line, if any. */
function firstUnclosedBlock(input: string): IToken | undefined {
  if (!input.includes('@{')) {
    return undefined;
  }
  return bpmnLexer
    .tokenize(input)
    .tokens.find((token) => token.tokenType === t.Attributes && !isClosed(token.image));
}

type ParseConfig = Omit<Parameters<typeof runChevrotainParse>[0], 'visit'>;

/**
 * Reads `text` for the errors a diagram's rules give, and throws the first that is written
 * before `before`. Returns whether the text could be read at all: a lexing or syntax error in
 * it is not thrown.
 */
function readForProblemsBefore(
  config: ParseConfig,
  text: string,
  before: Location | undefined,
  leftOut: string
): boolean {
  let read = false;
  try {
    runChevrotainParse(
      {
        ...config,
        visit: (cst) => {
          read = true;
          visitor.reset({ onlyBefore: before, leftOut });
          visitor.visit(cst);
        },
      },
      text
    );
  } catch (error) {
    if (read) {
      throw error;
    }
  }
  return read;
}

/**
 * Refuses a block that is not closed on its line. An error written before the block comes
 * first, as it would if the block were closed: a syntax error, or one of the diagram's rules,
 * which are checked on the text with the block blanked out.
 */
function refuseUnclosedBlock(config: ParseConfig, input: string, block: IToken): never {
  const blockEnd = block.startOffset + block.image.length;
  runChevrotainParse({ ...config, visit: () => undefined }, input.slice(0, blockEnd));

  // The block runs on when a later line closes it, before opening a block or a comment.
  const across = scanAttributeBlock(input, block.startOffset, true);
  const leftOutEnd = across.closed ? across.end : blockEnd;
  const leftOut = input.slice(block.startOffset, leftOutEnd);
  const start = input.slice(0, block.startOffset);
  const at = locationOf(block);
  // What is left out may declare an element, when a line taken for the rest of the block is a
  // statement of its own; and what follows the block may not be readable at all. Either way a
  // flow that ends at an element named in the text left out is not reported as undeclared.
  const whole = start + leftOut.replace(/[^\n\r]/g, ' ') + input.slice(leftOutEnd);
  if (!readForProblemsBefore(config, whole, at, leftOut)) {
    readForProblemsBefore(config, start, at, input.slice(block.startOffset));
  }

  // Drop what the last reading left, so the error below is not taken for a syntax error.
  bpmnParser.input = [];
  const opened = `BPMN error${atText(at)}: the attributes block opened here`;
  if (across.closed) {
    throw new Error(
      `${opened} runs on to the next line. Write an element's attributes on its own line, between @{ and }.`
    );
  }
  throw new Error(`${opened} is never closed. Close it with } on the same line.`);
}

/**
 * Parses `input`. A located error names the line of the source the text came from: pass the
 * number of lines that were removed in front of `input` (front matter) as `precedingLines`.
 */
export function parseBpmn(input: string, precedingLines = 0): ParsedDiagram {
  bpmnParser.input = [];
  lineOffset = precedingLines;
  const config: ParseConfig = {
    diagramType: 'bpmn',
    lexer: bpmnLexer,
    parser: bpmnParser,
    entry: () => bpmnParser.diagram(),
    lineOffset: precedingLines,
  };
  try {
    // A block left open is refused where it opens, before anything written after it.
    const unclosed = firstUnclosedBlock(input);
    if (unclosed) {
      refuseUnclosedBlock(config, input, unclosed);
    }
    runChevrotainParse(
      {
        ...config,
        visit: (cst) => {
          visitor.reset();
          visitor.visit(cst);
        },
      },
      input
    );
  } catch (error) {
    const syntaxError = bpmnParser.errors[0];
    if (!syntaxError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}${atText(syntaxErrorLocation(input, syntaxError.token))}`);
  }
  return visitor.result();
}
