import { CstParser, Lexer } from 'chevrotain';
import type { CstNode, IToken, TokenType } from 'chevrotain';
import * as yaml from 'js-yaml';
import * as t from './bpmn.tokens.js';
import { bpmnTokens } from './bpmn.tokens.js';
import {
  ACTIVITY_MARKERS,
  ALWAYS_INTERRUPTING,
  CALL_TARGETS,
  SUBPROCESS_KINDS,
  ELEMENT_ATTRIBUTES,
  LOOP_KINDS,
  TRIGGERS_BY_POSITION,
  positionsFor,
} from '../types.js';
import type { LoopKind, SubprocessKind } from '../types.js';
import { isKnownLocation, runChevrotainParse } from '../../common/parser/runChevrotainParse.js';
import { scanAttributeBlock } from './bpmnAttributeBlock.js';
import type { BlockKey } from './bpmnAttributeBlock.js';

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
        { ALT: () => this.SUBRULE(this.flowAttributes) },
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

  /** `f1@{ ... }`: the attributes of the flow written with the id `f1`. */
  private flowAttributes = this.RULE('flowAttributes', () => {
    this.CONSUME(t.Identifier);
    this.CONSUME(t.Attributes);
  });

  private flow = this.RULE('flow', () => {
    this.CONSUME(t.Identifier);
    this.AT_LEAST_ONE(() => {
      this.OPTION(() => this.CONSUME(t.EdgeId));
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
  /**
   * The elements a group is drawn around when it spans lanes or pools, which indentation
   * cannot say: `members: [a, b]`.
   */
  members?: string[];
  /** A sub-process that is an event sub-process or a transaction: `kind: event | transaction`. */
  subprocessKind?: SubprocessKind;
  /** A sub-process drawn open, with the elements indented under it inside it. */
  expanded?: boolean;
  /**
   * An event-based gateway that starts a process when one of its events occurs (`true`), or
   * once all of them have (`parallel`).
   */
  instantiate?: 'exclusive' | 'parallel';
  /** A start or boundary event written `interrupting: false`, drawn with a dashed ring. */
  nonInterrupting?: boolean;
}

export interface ParsedFlow {
  from: string;
  to: string;
  label?: string;
  kind: 'sequence' | 'message' | 'association';

  /** The id written before the flow's arrow, as `f1@-->`; absent when none is written. */
  id?: string;
  /** An association with an arrowhead at its target end (`..>`, or `direction: one`). */
  directed?: boolean;
  /** An association with arrowheads at both ends, `direction: both`. */
  bidirectional?: boolean;
  /** A sequence flow taken when no other leaving its source is: `default: true`. */
  isDefault?: boolean;
  /** A sequence flow's condition, `condition: "..."`, drawn as its label when it has no other. */
  condition?: string;
  /** The message a message flow carries, drawn as an envelope on the line. */
  message?: 'initiating' | 'non-initiating';
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
 * written, where it starts, and the text between its `@{` and its `}`.
 */
interface WrittenAttributes {
  values: Record<string, unknown>;
  keys: WrittenKey[];
  /** Where each key is first written, counted from the start of the block. */
  offsets: Map<string, number>;
  at?: Location;
  inside: string;
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
  /** The flows given an id, by that id. */
  private flowIds = new Map<string, ParsedFlow>();
  /** The `f1@{ ... }` statements, applied once every flow has been read. */
  private flowStatements: {
    id: string;
    at?: Location;
    attributes?: WrittenAttributes | UnreadableAttributes;
  }[] = [];

  private baseLevel: number | undefined;
  /** The errors found while reading, each with the place it names, or else where its statement starts. */
  private problems: { at?: Location; error: unknown }[] = [];
  /** When set, only an error written before this place is thrown. */
  private onlyBefore: Location | undefined;
  /**
   * The ids that text left out of the reading may declare. A flow that ends at one of them is
   * not reported as undeclared.
   */
  private leftOut: ReadonlySet<string> | undefined;

  constructor() {
    super();
    this.validateVisitor();
  }

  public reset(options: { onlyBefore?: Location; leftOut?: ReadonlySet<string> } = {}) {
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
    this.flowIds = new Map();
    this.flowStatements = [];
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
      // An error that names its own place is ranked by it, so that of the errors kept for one
      // statement (its attributes and its placement) the one written first is reported.
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
    this.checkSubprocesses();
    this.checkSpanningGroups();
    const declared = this.leftOut?.size
      ? new Set([...this.declared, ...this.leftOut])
      : this.declared;
    for (const flow of this.flows) {
      this.attempt(written.get(flow), () => assertFlowRefersToDeclaredElements(flow, declared));
      if (flow.id) {
        const id = flow.id;
        this.attempt(written.get(flow), () => {
          if (this.declared.has(id)) {
            throw new Error(
              `BPMN error${atText(flowIdLocation.get(flow))}: "${id}" is already declared as an element. Give the flow an id of its own.`
            );
          }
        });
      }
    }
    this.applyFlowStatements();
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
    const statement = (ctx.flowAttributes as CstNode[] | undefined)?.[0];
    if (statement) {
      this.visit(statement);
      return;
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
    const edgeIds = ctx.EdgeId ?? [];

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
      const idToken = edgeIds.find(
        (token) => token.startOffset + token.image.length === connector.startOffset
      );
      if (idToken) {
        const id = idToken.image.slice(0, -1);
        const where = locationOf(idToken);
        if (where) {
          flowIdLocation.set(parsedFlow, where);
        }
        if (this.flowIds.has(id)) {
          this.problems.push({
            at: where,
            error: new Error(
              `BPMN error${atText(where)}: the flow id "${id}" is already declared. Give each flow its own id.`
            ),
          });
        } else {
          parsedFlow.id = id;
          this.flowIds.set(id, parsedFlow);
        }
      }
      this.flows.push(parsedFlow);
    }
  }

  public flowAttributes(ctx: Record<string, IToken[]>) {
    const idToken = ctx.Identifier[0];
    this.flowStatements.push({
      id: idToken.image,
      at: locationOf(idToken),
      attributes: readAttributes(ctx.Attributes[0]),
    });
  }

  /**
   * The sub-process an element belongs to, the one its flow runs in: the nearest sub-process
   * it is indented under, or none at the top level. A boundary event belongs where its
   * activity does, since it sits on the activity's border.
   */
  private scopeOf(node: ParsedNode | undefined): string | undefined {
    const byId = new Map(this.nodes.map((candidate) => [candidate.id, candidate]));
    let current = node;
    if (current?.keyword === 'boundary') {
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    let parentId = current?.parentId;
    const seen = new Set<string>();
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = byId.get(parentId);
      if (parent?.keyword === 'subprocess') {
        return parent.id;
      }
      parentId = parent?.parentId;
    }
    return undefined;
  }

  /**
   * Marks each sub-process with elements indented under it as expanded, and checks the rules
   * of sub-processes and their events: a non-interrupting start event begins an event
   * sub-process, an event sub-process has one start event, which names its trigger, and
   * neither it nor a flow crosses into or out of a sub-process.
   */
  private checkSubprocesses() {
    const byId = new Map(this.nodes.map((node) => [node.id, node]));
    for (const node of this.nodes) {
      const parent = node.parentId ? byId.get(node.parentId) : undefined;
      if (parent?.keyword === 'subprocess' && node.keyword !== 'boundary') {
        parent.expanded = true;
      }
    }
    for (const node of this.nodes) {
      const at = written.get(node);
      if (node.keyword === 'start' && node.nonInterrupting) {
        const scope = this.scopeOf(node);
        this.attempt(at, () => {
          if (!scope || byId.get(scope)?.subprocessKind !== 'event') {
            throw new Error(
              `BPMN error${atText(at)}: only the start event of an event sub-process can be interrupting: false. Indent it under a subprocess with kind: event.`
            );
          }
        });
      }
    }
    for (const sub of this.nodes.filter((node) => node.subprocessKind === 'event')) {
      const at = written.get(sub);
      const starts = this.nodes.filter(
        (node) => node.keyword === 'start' && this.scopeOf(node) === sub.id
      );
      this.attempt(at, () => {
        if (sub.expanded && starts.length !== 1) {
          throw new Error(
            `BPMN error${atText(at)}: the event sub-process "${sub.id}" has ${starts.length} start events. An event sub-process starts with exactly one.`
          );
        }
        const untriggered = starts.find((start) => !start.qualifier);
        if (untriggered) {
          throw new Error(
            `BPMN error${atText(written.get(untriggered))}: the start event of the event sub-process "${sub.id}" must name what triggers it.`
          );
        }
      });
      for (const flow of this.flows.filter(
        (candidate) =>
          candidate.kind === 'sequence' && (candidate.from === sub.id || candidate.to === sub.id)
      )) {
        this.attempt(written.get(flow), () => {
          throw new Error(
            `BPMN error${atText(written.get(flow))}: the event sub-process "${sub.id}" is started by its own start event, so no sequence flow enters or leaves it.`
          );
        });
      }
    }
    for (const flow of this.flows.filter((candidate) => candidate.kind === 'sequence')) {
      const from = byId.get(flow.from);
      const to = byId.get(flow.to);
      if (!from || !to) {
        continue;
      }
      const fromScope = this.scopeOf(from);
      const toScope = this.scopeOf(to);
      if (fromScope !== toScope) {
        this.attempt(written.get(flow), () => {
          const side = (scope: string | undefined) =>
            scope ? `inside the subprocess "${scope}"` : 'outside every subprocess';
          throw new Error(
            `BPMN error${atText(written.get(flow))}: the sequence flow "${flow.from} --> ${flow.to}" crosses a sub-process border: "${flow.from}" is ${side(fromScope)} and "${flow.to}" is ${side(toScope)}. Flow into the sub-process itself instead.`
          );
        });
      }
    }
  }

  /**
   * A group written with `members` is drawn around elements anywhere in the diagram, so it
   * names declared elements, is written outside every pool and lane, and holds nothing
   * indented under it.
   */
  private checkSpanningGroups() {
    for (const group of this.nodes.filter((node) => node.members)) {
      const at = written.get(group);
      this.attempt(at, () => {
        if (group.parentId) {
          throw new Error(
            `BPMN error${atText(at)}: a group with members is drawn around elements in any lane or pool, so it is written at the top level, not under "${group.parentId}".`
          );
        }
        if (this.nodes.some((node) => node.parentId === group.id)) {
          throw new Error(
            `BPMN error${atText(at)}: the group "${group.id}" names its members, so nothing is indented under it.`
          );
        }
        const missing = group.members!.find(
          (member) => member === group.id || !this.declared.has(member)
        );
        if (missing) {
          throw new Error(
            `BPMN error${atText(at)}: the group "${group.id}" names "${missing}" as a member, which is not ${missing === group.id ? 'another' : 'a declared'} element.`
          );
        }
      });
    }
  }

  /** Applies each `f1@{ ... }` statement to the flow it names, once every flow is known. */
  private applyFlowStatements() {
    const applied = new Map<string, Location | undefined>();
    const sourceOf = (flow: ParsedFlow) => this.nodes.find((node) => node.id === flow.from);
    for (const statement of this.flowStatements) {
      this.attempt(statement.at, () => {
        const flow = this.flowIds.get(statement.id);
        if (!flow) {
          const element = this.declared.has(statement.id)
            ? ` "${statement.id}" is an element; an element's attributes are written at the end of its own line.`
            : ' Write the id before the arrow of the flow, as f1@-->.';
          throw new Error(
            `BPMN error${atText(statement.at)}: no flow has the id "${statement.id}".${element}`
          );
        }
        if (applied.has(statement.id)) {
          const first = applied.get(statement.id);
          throw new Error(
            `BPMN error${atText(statement.at)}: the attributes of the flow "${statement.id}" are already written${first ? ` at line ${first.line}` : ''}. Write them in one statement.`
          );
        }
        applied.set(statement.id, statement.at);
        if (statement.attributes) {
          applyFlowAttributes(flow, statement.attributes, sourceOf(flow));
        }
      });
    }
    // A source has at most one default flow.
    const defaults = new Map<string, ParsedFlow>();
    for (const flow of this.flows) {
      if (!flow.isDefault) {
        continue;
      }
      const earlier = defaults.get(flow.from);
      if (earlier) {
        this.attempt(written.get(flow), () => {
          throw new Error(
            `BPMN error${atText(written.get(flow))}: "${flow.from}" already has the default flow "${earlier.id}", so "${flow.id}" cannot be one too.`
          );
        });
      } else {
        defaults.set(flow.from, flow);
      }
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
      return node.keyword === 'event-gateway'
        ? 'an event-gateway'
        : `${articleFor(node.keyword)} ${node.keyword} gateway`;
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

/**
 * The name YAML gives a key of a block, so that `"2"`, `'2'` and `2` all name the key `2`. The
 * key is read with what follows it in the block: its `:`, or the end of its entry. A key that
 * cannot be read on its own, as one written with an alias cannot, has no name here.
 */
function keyName({ text, colon }: BlockKey): string | undefined {
  let end = text.length;
  while (end > 0 && (text[end - 1] === ' ' || text[end - 1] === '\t')) {
    end--;
  }
  const word = text.slice(0, end);
  if (PLAIN_KEY.test(word) && !YAML_WORDS.has(word)) {
    return word;
  }
  try {
    const read: unknown = yaml.load(colon ? `{${text}: 0}` : `{${text}}`, {
      schema: yaml.JSON_SCHEMA,
    });
    const names = read && typeof read === 'object' ? Object.keys(read) : [];
    return names.length === 1 ? names[0] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The keys written at the top of an element's `@{ }` block, in the order they are written. A
 * key that has no name of its own is left out.
 */
export function writtenKeys(image: string): WrittenKey[] {
  return scanAttributeBlock(image, 0).keys.flatMap((key) => {
    const name = keyName(key);
    return name === undefined ? [] : [{ key: name, offset: key.offset }];
  });
}

/**
 * Where the `}` that closes a block stands in the block's text, if the block is closed. A block
 * whose last quote is left open is taken as closed by the first `}` in the quoted text that
 * has nothing after it on the line but blanks and a `%%` comment, so that the block is refused
 * for the quote, not for the `}`.
 */
function closingBrace(image: string): number | undefined {
  const scanned = scanAttributeBlock(image, 0);
  if (scanned.closed) {
    return scanned.end - 1;
  }
  if (scanned.openQuote === undefined) {
    return undefined;
  }
  let brace = image.indexOf('}', scanned.openQuote);
  while (brace >= 0) {
    let after = brace + 1;
    while (image[after] === ' ' || image[after] === '\t') {
      after++;
    }
    if (after === image.length || image.startsWith('%%', after)) {
      return brace;
    }
    brace = image.indexOf('}', after);
  }
  return undefined;
}

/** A block, a key or a value as a message shows it: whole, unless it is long. */
const shown = (image: string): string =>
  image.length > 80 ? `${image.slice(0, 60)} … ${image.slice(-15)}` : image;

/**
 * A value as a message shows it, the way JSON writes it; a number JSON cannot write is shown
 * the way YAML writes it. A long value is cut short, and so is one that holds itself, which
 * YAML's anchors and aliases can write.
 */
function shownValue(value: unknown): string {
  let room = 80;
  const show = (part: unknown, depth: number): string => {
    if (typeof part === 'number' && !Number.isFinite(part)) {
      const text = Number.isNaN(part) ? '.nan' : part > 0 ? '.inf' : '-.inf';
      room -= text.length;
      return text;
    }
    if (part === null || typeof part !== 'object') {
      const text = shown(JSON.stringify(part) ?? String(part));
      room -= text.length;
      return text;
    }
    if (depth > 3) {
      room -= 1;
      return '…';
    }
    const parts: string[] = [];
    const entries: [string | undefined, unknown][] = Array.isArray(part)
      ? part.map((entry) => [undefined, entry])
      : Object.entries(part);
    for (const [name, entry] of entries) {
      if (room <= 0) {
        parts.push('…');
        break;
      }
      const label = name === undefined ? '' : `${shown(JSON.stringify(name))}:`;
      room -= label.length + 1;
      parts.push(label + show(entry, depth + 1));
    }
    room -= 2;
    return Array.isArray(part) ? `[${parts.join(',')}]` : `{${parts.join(',')}}`;
  };
  return show(value, 0);
}

/** Reads the inside of `@{ ... }` as a YAML flow mapping. */
function readAttributes(token: IToken): WrittenAttributes | UnreadableAttributes {
  const at = locationOf(token);
  const image = token.image;
  const unreadable = (reason: string) => ({
    unreadable: new Error(
      `BPMN error${atText(at)}: the attributes ${shown(image)} cannot be read${reason}. Write them as key: value pairs separated by commas.`
    ),
  });
  const inside = image.slice(2, closingBrace(image));
  let values: unknown;
  try {
    values = yaml.load(`{${inside}}`, { schema: yaml.JSON_SCHEMA });
  } catch (error) {
    // The reason may quote the block, a long name in it for one, so it is shortened as well.
    const reason = error instanceof yaml.YAMLException ? error.reason : String(error);
    return unreadable(` (${shown(reason)})`);
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
  return { values: values as Record<string, unknown>, keys, offsets, at, inside };
}

/**
 * A number as it is written: `1.0` stays `1.0`, not `1`. Where the block cannot be read without
 * its types (it holds a tag such as `!!float`), the number is given as YAML reads it.
 */
function asWritten(written: WrittenAttributes, key: string, value: number): unknown {
  try {
    const read = yaml.load(`{${written.inside}}`, { schema: yaml.FAILSAFE_SCHEMA });
    return (read as Record<string, unknown>)[key];
  } catch {
    return String(value);
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
        `${where}: marker takes ${listOf([...known])}, or a list of them, not ${shownValue(marker)}.`
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
  if (
    node.kind === 'activity' ||
    node.kind === 'pool' ||
    node.keyword === 'xor' ||
    node.keyword === 'event-gateway' ||
    node.keyword === 'group' ||
    node.keyword === 'start' ||
    node.keyword === 'boundary'
  ) {
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
  // A key that has no name of its own (one written with an alias) comes last.
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
        `BPMN error${atText(keyLocation(written, key))}: "${shown(key)}" is not an attribute of ${describe(node)}, which takes ${listOf([...allowed])}.`
      );
    }
    const where = `BPMN error${atText(keyLocation(written, key))}`;
    const wrongValue = (expected: string) =>
      new Error(`${where}: ${key} takes ${expected}, not ${shownValue(value)}.`);
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
      case 'members':
        if (
          !Array.isArray(value) ||
          value.length === 0 ||
          !value.every((member) => typeof member === 'string' && member.trim())
        ) {
          throw wrongValue('a list of element ids');
        }
        node.members = value.map((member: string) => member.trim());
        break;
      case 'instantiate':
        if (value === true) {
          node.instantiate = 'exclusive';
        } else if (value === 'parallel') {
          node.instantiate = 'parallel';
        } else if (value !== false) {
          throw wrongValue('true, false or parallel');
        }
        break;
      case 'kind':
        if (typeof value !== 'string' || !(SUBPROCESS_KINDS as readonly string[]).includes(value)) {
          throw wrongValue(listOf([...SUBPROCESS_KINDS]));
        }
        node.subprocessKind = value as SubprocessKind;
        break;
      case 'interrupting':
        if (!isBoolean(value)) {
          throw wrongValue('true or false');
        }
        if (!value && (ALWAYS_INTERRUPTING as readonly string[]).includes(node.qualifier ?? '')) {
          throw new Error(
            `${where}: ${articleFor(node.qualifier ?? '')} ${node.qualifier} ${node.keyword} event always interrupts, so it cannot be interrupting: false.`
          );
        }
        node.nonInterrupting = !value;
        break;
      case 'state': {
        const state = typeof value === 'number' ? asWritten(written, key, value) : value;
        if (typeof state !== 'string' || !state.trim() || /[[\]]/.test(state)) {
          throw wrongValue('a name without brackets');
        }
        node.state = state.trim();
        break;
      }
    }
  }
}

/** Where a flow's id is written, for an error about the id. */
const flowIdLocation = new WeakMap<ParsedFlow, Location>();

/** The attributes a flow takes in its `f1@{ ... }` statement. */
export const FLOW_ATTRIBUTES = ['default', 'condition', 'label', 'message', 'direction'] as const;
export const MESSAGE_KINDS = ['initiating', 'non-initiating'] as const;
export const ASSOCIATION_DIRECTIONS = ['none', 'one', 'both'] as const;

const FLOW_NAMES: Record<ParsedFlow['kind'], string> = {
  sequence: 'a sequence flow',
  message: 'a message flow',
  association: 'an association',
};

/** The gateways a default or conditional flow may leave; a parallel or event-based one decides nothing. */
const DECIDING_GATEWAYS = new Set(['xor', 'or', 'complex']);

/** Whether a sequence flow out of `source` may carry a condition or be its default. */
const decides = (source: ParsedNode | undefined): boolean =>
  source?.kind === 'activity' ||
  (source?.kind === 'gateway' && DECIDING_GATEWAYS.has(source.keyword));

/** Checks a flow's `f1@{ ... }` statement against the kind of flow it names, and records each value. */
function applyFlowAttributes(
  flow: ParsedFlow,
  attributes: WrittenAttributes | UnreadableAttributes,
  source: ParsedNode | undefined
): void {
  if ('unreadable' in attributes) {
    throw attributes.unreadable;
  }
  const allowed = FLOW_ATTRIBUTES as readonly string[];
  const name = FLOW_NAMES[flow.kind];
  const sourceName = source ? `${describe(source)} ("${source.id}")` : `"${flow.from}"`;
  for (const [key, value] of entriesInWrittenOrder(attributes)) {
    const where = `BPMN error${atText(keyLocation(attributes, key))}`;
    if (!allowed.includes(key)) {
      throw new Error(
        `${where}: "${shown(key)}" is not an attribute of a flow, which takes ${listOf([...allowed])}.`
      );
    }
    const wrongValue = (expected: string) =>
      new Error(`${where}: ${key} takes ${expected}, not ${shownValue(value)}.`);
    const onlyOn = (kind: ParsedFlow['kind']) => {
      if (flow.kind !== kind) {
        throw new Error(`${where}: ${key} is written on ${FLOW_NAMES[kind]}, not on ${name}.`);
      }
    };
    switch (key) {
      case 'default':
        if (!isBoolean(value)) {
          throw wrongValue('true or false');
        }
        onlyOn('sequence');
        if (value && !decides(source)) {
          throw new Error(
            `${where}: a default flow leaves an activity or an xor, or or complex gateway, not ${sourceName}.`
          );
        }
        flow.isDefault = value;
        break;
      case 'condition': {
        const condition = typeof value === 'number' ? asWritten(attributes, key, value) : value;
        if (typeof condition !== 'string' || !condition.trim()) {
          throw wrongValue('the condition as text');
        }
        onlyOn('sequence');
        if (!decides(source)) {
          throw new Error(
            `${where}: a conditional flow leaves an activity or an xor, or or complex gateway, not ${sourceName}.`
          );
        }
        flow.condition = condition.trim();
        break;
      }
      case 'label': {
        const label = typeof value === 'number' ? asWritten(attributes, key, value) : value;
        if (typeof label !== 'string' || !label.trim()) {
          throw wrongValue('the label as text');
        }
        if (flow.label !== undefined) {
          throw new Error(
            `${where}: the flow is already labelled "${flow.label}" in its arrow. Write its label once.`
          );
        }
        flow.label = label.trim();
        break;
      }
      case 'message':
        if (typeof value !== 'string' || !(MESSAGE_KINDS as readonly string[]).includes(value)) {
          throw wrongValue(listOf([...MESSAGE_KINDS]));
        }
        onlyOn('message');
        flow.message = value as ParsedFlow['message'];
        break;
      case 'direction':
        if (
          typeof value !== 'string' ||
          !(ASSOCIATION_DIRECTIONS as readonly string[]).includes(value)
        ) {
          throw wrongValue(listOf([...ASSOCIATION_DIRECTIONS]));
        }
        onlyOn('association');
        flow.directed = value !== 'none';
        flow.bidirectional = value === 'both';
        break;
    }
  }
  if (flow.isDefault && flow.condition !== undefined) {
    throw new Error(
      `BPMN error${atText(attributes.at)}: a default flow is taken when no condition holds, so it cannot carry a condition of its own.`
    );
  }
}

const CONTAINER_KINDS = new Set<ParsedNode['kind']>(['pool', 'lane', 'group']);

/** The kinds a sub-process holds: what a process holds, but not its pools and lanes. */
const IN_SUBPROCESS = new Set<ParsedNode['kind']>([
  'group',
  'event',
  'gateway',
  'activity',
  'data',
  'store',
  'annotation',
]);

/**
 * Only a pool, a lane, a group or a sub-process holds other elements, and a boundary event sits
 * on an activity. A boundary event indented straight under a sub-process is attached to it.
 */
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
  if (parent?.keyword === 'subprocess') {
    if (!IN_SUBPROCESS.has(node.kind)) {
      throw new Error(
        `${where}: ${articleFor(node.keyword)} ${node.keyword} cannot be indented under the subprocess "${parent.id}". A sub-process holds flow elements, artifacts and groups, not pools or lanes.`
      );
    }
    return;
  }
  if (parent && !CONTAINER_KINDS.has(parent.kind)) {
    throw new Error(
      `${where}: ${articleFor(node.keyword)} ${node.keyword} cannot be indented under the ${parent.keyword} "${parent.id}", because only a pool, a lane, a group or a subprocess holds other elements.`
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
    .tokens.find(
      (token) => token.tokenType === t.Attributes && closingBrace(token.image) === undefined
    );
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
  leftOut: ReadonlySet<string>
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

// The keywords that open an element's statement, as the grammar's rules above have them. The
// tests read the keywords from the grammar, and fail for one that is missing here.
const EVENT_KEYWORDS: ReadonlySet<TokenType> = new Set([
  t.Start,
  t.Intermediate,
  t.Boundary,
  t.End,
  t.Throw,
]);
const ACTIVITY_KEYWORDS: ReadonlySet<TokenType> = new Set([t.Task, t.Subprocess, t.Call]);
const OTHER_KEYWORDS: ReadonlySet<TokenType> = new Set([
  t.Pool,
  t.Lane,
  t.Group,
  t.Xor,
  t.And,
  t.Or,
  t.EventGateway,
  t.Complex,
  t.DataStore,
  t.DataCollection,
  t.DataInput,
  t.DataOutput,
  t.DataObject,
  t.Annotation,
]);

const BLANKS = /^[\t ]*$/;

/**
 * The ids that `text` may declare: on each of its lines that opens as an element's statement
 * does, the name that statement gives. Such a line opens with a keyword and the name comes
 * next; a task type may stand before the keyword of an activity, and a trigger after the
 * keyword of an event. Nothing but blanks may stand before or between these words. What
 * follows the name is not looked at, so `text` need not be readable as a diagram.
 */
function idsDeclaredIn(text: string): Set<string> {
  const ids = new Set<string>();
  const { tokens } = bpmnLexer.tokenize(text);
  const endOf = (token: IToken): number => token.startOffset + token.image.length;
  /** The token after `tokens[index]`, when nothing but blanks stands between the two. */
  const nextAfter = (index: number): IToken | undefined => {
    const next = tokens[index + 1] as IToken | undefined;
    return next && BLANKS.test(text.slice(endOf(tokens[index]), next.startOffset))
      ? next
      : undefined;
  };
  let opensLine = true;
  for (const [index, token] of tokens.entries()) {
    const type = token.tokenType;
    if (type === t.Newline || type === t.Indent) {
      opensLine ||= type === t.Newline;
      continue;
    }
    const first = opensLine;
    opensLine = false;
    const lineStart = token.startOffset - ((token.startColumn ?? 1) - 1);
    if (!first || !BLANKS.test(text.slice(lineStart, token.startOffset))) {
      continue;
    }
    let keyword = index;
    if (type === t.TaskType) {
      // A task type comes before the keyword of an activity.
      const next = nextAfter(index);
      if (!next || !ACTIVITY_KEYWORDS.has(next.tokenType)) {
        continue;
      }
      keyword = index + 1;
    } else if (EVENT_KEYWORDS.has(type)) {
      // A trigger may follow the keyword of an event.
      if (nextAfter(index)?.tokenType === t.Trigger) {
        keyword = index + 1;
      }
    } else if (!ACTIVITY_KEYWORDS.has(type) && !OTHER_KEYWORDS.has(type)) {
      continue;
    }
    const name = nextAfter(keyword);
    if (name?.tokenType === t.Identifier) {
      ids.add(name.image);
    }
  }
  return ids;
}

/**
 * Refuses a block that is not closed on its line. An error written before the block comes
 * first: a syntax error, or one of the diagram's rules, which are checked on the text with
 * the block blanked out. A flow before the block is not held to be undeclared when a line
 * that is left out of that check opens as an element's statement does, and names the element
 * the flow ends at: a line the block takes, or any later line when what follows the block
 * cannot be read.
 */
function refuseUnclosedBlock(config: ParseConfig, input: string, block: IToken): never {
  const blockEnd = block.startOffset + block.image.length;
  runChevrotainParse({ ...config, visit: () => undefined }, input.slice(0, blockEnd));

  // The block runs on when a later line closes it, before opening a block or a comment.
  const across = scanAttributeBlock(input, block.startOffset, true);
  const leftOutEnd = across.closed ? across.end : blockEnd;
  const start = input.slice(0, block.startOffset);
  const at = locationOf(block);
  // The lines taken for the rest of the block are left out of the reading, and one of them may
  // be a statement of its own that declares an element. A flow written before the block that
  // ends at such an element is not reported as undeclared.
  const whole =
    start +
    input.slice(block.startOffset, leftOutEnd).replace(/[^\n\r]/g, ' ') +
    input.slice(leftOutEnd);
  if (!readForProblemsBefore(config, whole, at, idsDeclaredIn(input.slice(blockEnd, leftOutEnd)))) {
    // What follows the block cannot be read. The text before it still can, and what follows
    // may declare the elements its flows end at.
    readForProblemsBefore(config, start, at, idsDeclaredIn(input.slice(blockEnd)));
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
