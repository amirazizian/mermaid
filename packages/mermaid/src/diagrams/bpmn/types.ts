export const BPMN_DIRECTIONS = ['LR', 'RL', 'TB', 'TD', 'BT'] as const;

export const EVENT_TRIGGERS = [
  'message',
  'timer',
  'error',
  'escalation',
  'cancel',
  'compensation',
  'conditional',
  'link',
  'signal',
  'terminate',
  'parallel-multiple',
  'multiple',
  'none',
] as const;

export const TASK_TYPES = [
  'user',
  'service',
  'receive',
  'send',
  'manual',
  'script',
  'rule',
] as const;

/**
 * The markers an activity's `marker` attribute names, drawn along its bottom edge: a standard
 * loop, multi-instance in parallel or in sequence, ad-hoc (a sub-process only), compensation.
 */
export const ACTIVITY_MARKERS = [
  'loop',
  'parallel',
  'sequential',
  'ad-hoc',
  'compensation',
] as const;

/** The markers that say how an activity repeats, of which it carries at most one. */
export const LOOP_KINDS = ['loop', 'parallel', 'sequential'] as const;

/** What a call activity calls: a global task (the default) or a process, drawn with a `+`. */
export const CALL_TARGETS = ['task', 'process'] as const;

/**
 * The attributes each element accepts in its trailing `@{ }` block. An element kind
 * missing from this table takes none, and a key missing from its row is refused.
 */
export const ELEMENT_ATTRIBUTES = {
  task: ['marker'],
  call: ['marker', 'calls'],
  subprocess: ['marker'],
  xor: ['marker'],
  data: ['state'],
  pool: ['multiple'],
} as const satisfies Record<string, readonly string[]>;

export const TRIGGERS_BY_POSITION = {
  start: [
    'none',
    'message',
    'timer',
    'conditional',
    'signal',
    'multiple',
    'parallel-multiple',
    'error',
    'escalation',
    'compensation',
  ],
  intermediate: [
    'message',
    'timer',
    'conditional',
    'link',
    'signal',
    'multiple',
    'parallel-multiple',
  ],
  throw: ['none', 'message', 'escalation', 'compensation', 'link', 'signal', 'multiple'],
  boundary: [
    'message',
    'timer',
    'error',
    'escalation',
    'cancel',
    'compensation',
    'conditional',
    'signal',
    'multiple',
    'parallel-multiple',
  ],
  end: [
    'none',
    'message',
    'error',
    'escalation',
    'cancel',
    'compensation',
    'signal',
    'terminate',
    'multiple',
  ],
} as const satisfies Record<string, readonly EventTrigger[]>;

export const positionsFor = (trigger: string): string[] =>
  Object.entries(TRIGGERS_BY_POSITION)
    .filter(([, triggers]) => (triggers as readonly string[]).includes(trigger))
    .map(([position]) => position);

export type BpmnDirection = (typeof BPMN_DIRECTIONS)[number];
export type EventTrigger = (typeof EVENT_TRIGGERS)[number];
export type TaskType = (typeof TASK_TYPES)[number];
export type ActivityMarker = (typeof ACTIVITY_MARKERS)[number];
export type LoopKind = (typeof LOOP_KINDS)[number];
export type CallTarget = (typeof CALL_TARGETS)[number];
