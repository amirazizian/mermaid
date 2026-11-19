# Writing `bpmn-beta` diagrams: a guide for coding agents

This guide is for an AI coding agent (or a person) who reads a codebase and writes the business
processes it implements as BPMN diagrams in Mermaid's `bpmn-beta` syntax, then renders them to
images. It is self-contained: you can copy it into another repository.

The `bpmn-beta` diagram type exists only on the branch `private/bpmn-spinoff` of
`github.com/amirazizian/mermaid`. The official Mermaid release does not have it yet, so diagrams
must be rendered with the build from that branch (see [Rendering](#rendering)).

## Contents

1. [Setup](#setup)
2. [The workflow](#the-workflow)
3. [Syntax](#syntax)
4. [Mapping code to BPMN](#mapping-code-to-bpmn)
5. [Rules the parser enforces](#rules-the-parser-enforces)
6. [Rendering](#rendering)
7. [Checking the layout](#checking-the-layout)
8. [Style rules for readable diagrams](#style-rules-for-readable-diagrams)
9. [Limitations](#limitations)
10. [A complete example](#a-complete-example)

## Setup

Needs Node 22 and pnpm 10.

```sh
git clone --branch private/bpmn-spinoff https://github.com/amirazizian/mermaid.git bpmn-mermaid
cd bpmn-mermaid
pnpm install --frozen-lockfile
pnpm build:mermaid        # writes packages/mermaid/dist/mermaid.min.js
```

Rendering uses Playwright with Chromium. If Playwright has no browser installed yet, run
`npx playwright install chromium` once, or set `CHROME_PATH` to an installed Chrome or Chromium.

## The workflow

1. Read the code path you are documenting (an endpoint, a job, a message handler, a saga) and list
   its steps, decisions, waits, error paths and the systems it talks to.
2. Write one `.mmd` file per process, in the syntax below.
3. Render it: `node scripts/bpmn-render.mjs --png --out out/ path/to/process.mmd`. A diagram that
   does not parse is refused with the line and column of the problem and exit code 1. Fix it and
   render again.
4. Check the layout: `node scripts/bpmn-layout-check.mjs --detail path/to/process.mmd`. Look at the
   PNG. If something reads badly, apply [the style rules](#style-rules-for-readable-diagrams).
5. Optionally export BPMN 2.0 XML for modelling tools: add `--xml` to the render command.

## Syntax

A diagram starts with `bpmn-beta` and a direction, `LR` (left to right, the default and the BPMN
convention) or `TB` (top to bottom). Only use `LR` or `TB`.

```
bpmn-beta LR
title Order handling
  pool shop "Shop"
    lane sales "Sales"
      start s1 "Order received"
      user task t1 "Check order"
    lane wh "Warehouse"
      task t2 "Ship"
      end e1 "Shipped"
  s1 --> t1 --> t2 --> e1
```

### The shape of a line

Every element is written on its own line:

```
[modifier] keyword [id] ["label"] [@{ attributes }]
```

- **id**: starts with a letter or `_`, then letters, digits, `_`, and internal hyphens (`step-2`).
  Give an id to every element a flow refers to. Ids must be unique across the diagram. Keywords
  (`start`, `end`, `task`, `data`, `message`, …) cannot be ids; `starter`, `database` are fine.
- **label**: double-quoted, on one line, no double quote inside. Keep it short (2–5 words).
- **attributes**: a trailing `@{ key: value, key: value }` block, on the same line.
- **Indentation is containment**: an element indented under a pool, lane, group or sub-process
  belongs to it. Use spaces only, never tabs, and indent consistently (2 spaces per level).
- Comments start with `%%`.
- `title`, `accTitle: …` and `accDescr: …` are optional, each on its own line after the header.

### Pools and lanes

```
pool p "Company"                    %% a participant
  lane sales "Sales"                %% a role inside it
    lane inside "Inside sales"      %% lanes can nest; a lane holding lanes holds nothing else
      task t1 "Call"
pool bank "Bank"                    %% a pool with nothing inside is a black box
pool suppliers "Suppliers" @{ multiple: true }   %% several participants of one kind
```

Lanes may be used without a pool. Every flow element should be inside a lane (or a sub-process),
otherwise it is put in an unnamed default lane.

### Events

`position [trigger] id "label"` — the position always comes first.

| Position       | Meaning                                                          |
| -------------- | ---------------------------------------------------------------- |
| `start`        | starts the process                                               |
| `intermediate` | waits for something part-way through (must name a trigger)       |
| `throw`        | sends/raises something part-way through                          |
| `boundary`     | attached to an activity, indented under it (must name a trigger) |
| `end`          | ends the process                                                 |

Triggers: `message`, `timer`, `error`, `escalation`, `cancel`, `compensation`, `conditional`,
`link`, `signal`, `terminate`, `multiple`, `parallel-multiple`. Not every trigger is allowed at
every position (BPMN 2.0.2 rules; e.g. `terminate` only on `end`, `timer` never on `end`). The
parser tells you where a trigger belongs if you misplace it.

```
start message s1 "Order received"
intermediate timer w1 "Wait 2 days"
throw signal x1 "Notify all"
end error e2 "Payment failed"
end terminate e3 "Abort"
```

### Activities

```
task t1 "Generic step"
user task t2 "Approve"          %% types: user, service, receive, send, manual, script, rule
service task t3 "Call API"
subprocess sp1 "Pack goods"     %% collapsed sub-process (drawn with +)
call c1 "Invoicing"             %% call activity (calls a global task)
call c2 "Billing" @{ calls: process }      %% calls another process
task t4 "Retry" @{ marker: loop }          %% markers: loop, parallel, sequential, compensation
subprocess s2 "Research" @{ marker: [ad-hoc, parallel] }   %% ad-hoc only on subprocess
```

An activity takes at most one of `loop`, `parallel` (multi-instance in parallel) and `sequential`.

### Expanded sub-processes, event sub-processes, transactions

A `subprocess` with elements indented under it is drawn open, with its own flow inside:

```
subprocess sp "Handle the order"
  start a "Begin"
  task b "Pick items"
  end c "Picked"
  a --> b --> c
  boundary timer late "2 days" @{ interrupting: false }   %% attached to sp's border
```

- `@{ kind: event }`: an event sub-process (dotted). It has exactly one start event, which names a
  trigger, and no sequence flow in or out. Its start may be `@{ interrupting: false }`.
- `@{ kind: transaction }`: a transaction (double border). Handle cancellation with a
  `boundary cancel` on it.
- A sequence flow must not cross a sub-process border: flow into the sub-process itself.
- A sub-process may hold tasks, events, gateways, groups, artifacts and other sub-processes, not
  pools or lanes.

### Boundary events

Indent a `boundary` event directly under the activity it is attached to. Its outgoing flow is the
exception path.

```
service task t1 "Charge card"
  boundary error b1 "Declined"
  boundary timer b2 "30 s" @{ interrupting: false }   %% dashed: the task keeps running
```

`error`, `cancel` and `compensation` boundary events always interrupt.

### Gateways

| Keyword         | Gateway                                        |
| --------------- | ---------------------------------------------- |
| `xor`           | exclusive: one path (if / else / switch)       |
| `and`           | parallel: all paths (fork and join)            |
| `or`            | inclusive: one or more paths                   |
| `event-gateway` | the next event decides (whichever comes first) |
| `complex`       | complex condition                              |

```
xor g1 "In stock?"
xor g2 "Urgent?" @{ marker: none }                 %% exclusive gateway drawn without its X
event-gateway g3 "Wait" @{ instantiate: true }     %% starts the process (also: parallel)
```

Label branch flows; the gateway label is a question.

### Flows

| Syntax           | Flow                              |
| ---------------- | --------------------------------- |
| `a --> b`        | sequence flow                     |
| `a -- yes --> b` | sequence flow with a label        |
| `a -.-> b`       | message flow (between pools only) |
| `a ..> b`        | association with an arrowhead     |
| `a ... b`        | association without arrowhead     |

Flows chain: `a --> b --> c`. Both ends must be declared elements (ids). Flows are usually written
at the end of the diagram, at the top-level indentation.

**Flow ids and attributes.** Put an id straight before the arrow (`f1@-->`, no spaces) and write the
flow's attributes in their own statement:

```
gw f1@-- yes --> approve
gw f2@--> reject
f2@{ default: true }                      %% default flow: slash at the source
check f3@--> escalate
f3@{ condition: "amount > 1000" }         %% conditional flow; diamond when it leaves a task
buyer m1@-.-> seller
m1@{ label: "Order", message: initiating }   %% envelope on a message flow (or non-initiating)
note1 a1@... task1
a1@{ direction: both, label: "rule" }     %% association: none, one or both
```

Rules: `default` and `condition` only on sequence flows leaving a task or an `xor`/`or`/`complex`
gateway; one default per source; a default flow has no condition; `message` only on message
flows; `direction` only on associations; a flow labelled in its arrow cannot also take `label`.

### Artifacts

```
data d1 "Order" @{ state: approved }   %% data object, with an optional state
data-input in1 "Request"
data-output out1 "Receipt"
data-collection items "Line items"
data-store db "Orders DB"
note n1 "Checked nightly"              %% text annotation
group g "Warehouse work"               %% dash-dot box around what is indented under it
  task t1 "Pick"
group span "Shipping" @{ members: [t2, t3] }   %% across lanes/pools: top level, names members
```

Connect artifacts with associations: `d1 ..> t1` (task reads it), `t1 ..> d1` (task writes it),
`n1 ... t1` (note about the task). An artifact is drawn beside the first element it is associated
with.

## Mapping code to BPMN

| In the code                                         | In BPMN                                                                                                                                                  |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP endpoint, queue consumer, cron job (entry)     | `start message` / `start timer` event                                                                                                                    |
| Normal return / completion                          | `end` event                                                                                                                                              |
| Function that does work                             | `task` (`service task` for calls to other systems/APIs, `user task` for human steps, `script task` for local computation, `rule task` for rules engines) |
| Call into a large helper with its own steps         | collapsed `subprocess`, or an expanded one if the steps matter                                                                                           |
| Call into another documented process/service        | `call` with `@{ calls: process }`                                                                                                                        |
| `if / else`, `switch`                               | `xor` gateway; label each branch; mark the `else` path as `default: true`                                                                                |
| Several independent branches that may all run       | `or` gateway                                                                                                                                             |
| Parallel work (`Promise.all`, threads, fan-out)     | `and` gateway to fork, another `and` to join                                                                                                             |
| Loop over items                                     | `@{ marker: sequential }` (one by one) or `parallel` (concurrently) on the task                                                                          |
| Retry loop                                          | `@{ marker: loop }`, or an explicit flow back to an earlier task                                                                                         |
| `await` on a message, webhook, reply                | `intermediate message` event, or a `receive task`                                                                                                        |
| Sleep / delay / scheduled wait                      | `intermediate timer` event                                                                                                                               |
| Timeout on an operation                             | `boundary timer` on the task (interrupting); `@{ interrupting: false }` if it only triggers a side action                                                |
| `try / catch` around a step                         | `boundary error` on that task, leading to the handling path                                                                                              |
| Error that ends the process                         | `end error`                                                                                                                                              |
| Compensating actions / rollback (saga)              | `subprocess … @{ kind: transaction }` with a `boundary cancel`, and tasks marked `compensation`                                                          |
| Global exception handler, cancellation listener     | `subprocess … @{ kind: event }` with a triggered start                                                                                                   |
| Publishing an event/notification                    | `throw message` / `throw signal`, or a `send task`                                                                                                       |
| Waiting for whichever of several events comes first | `event-gateway` followed by `intermediate` events                                                                                                        |
| External system / other service                     | a separate `pool` (empty = black box) with message flows to it                                                                                           |
| Module / team / component responsible               | `lane`                                                                                                                                                   |
| DB table, file, cache read or written               | `data-store` (persistent) or `data` (in-flight object) with associations                                                                                 |
| Important comment / business rule                   | `note` associated with the element                                                                                                                       |

Prefer the business meaning over code structure: one task per meaningful step, not per function.
Typical diagram size: 5–25 flow elements. Split larger processes with `call` activities.

## Rules the parser enforces

A diagram that breaks a rule is refused with `BPMN error at line N, column C: …` and a message
saying what to write instead. The common ones:

- an id declared twice, or a flow naming an id that is not declared;
- a trigger at a position BPMN does not allow, or an `intermediate`/`boundary` event without one;
- an element indented under something that cannot hold it (only pools, lanes, groups and
  sub-processes hold elements; a `boundary` event must sit directly under an activity);
- an attribute an element does not take, or a value it cannot use;
- the flow attribute rules above, the event sub-process rules, and a sequence flow crossing a
  sub-process border;
- an attribute block not closed on its own line.

Fix the line named in the message and render again. Do not work around a refusal by dropping
information silently; if something cannot be expressed, put it in a `note`.

## Rendering

From the clone of the `private/bpmn-spinoff` branch:

```sh
pnpm build:mermaid                                              # once, and after pulling
node scripts/bpmn-render.mjs --png --out out/ docs/processes/*.mmd
node scripts/bpmn-render.mjs --png --xml --out out/ order.mmd   # also order.bpmn
```

Options: `--png` writes a PNG next to the SVG; `--scale N` sets the PNG pixel ratio (default 2);
`--theme default|neutral|forest|dark`; `--out dir`; `--xml` writes BPMN 2.0.2 XML with layout,
which bpmn.io and Camunda Modeler open. The exit code is 1 if any file fails, so the command can run
in CI. `BPMN_RENDER_DEBUG=1` prints a stack trace for a render failure.

To render in a web page instead, load `packages/mermaid/dist/mermaid.min.js` from the branch build
in place of the official Mermaid bundle.

## Checking the layout

```sh
node scripts/bpmn-layout-check.mjs --detail order.mmd          # as written
node scripts/bpmn-layout-check.mjs --both --detail order.mmd   # LR and TB
```

It counts layout defects per diagram: lines through shapes or texts, lines on top of each other,
overlapping texts, flows looping round their own end, labels off their line, envelopes on other
lines, shapes outside their lane, long detours and crossings. A few crossings are normal; anything
else is worth a look at the PNG and, if it reads badly, a change to the diagram (next section).

## Style rules for readable diagrams

The layout engine places everything automatically; these habits give it the best start:

1. **Declare elements in flow order** within each lane: start event first, then the steps in the
   order they run, end events last. Declaration order guides the layout.
2. **Keep the happy path straight**: write it as one chain (`s1 --> t1 --> t2 --> e1`), then the
   alternative branches.
3. **One end event per outcome** (`end e1 "Shipped"`, `end error e2 "Rejected"`) rather than many
   flows converging on one end event.
4. **Few lanes** (2–5) and few pools. Put an external system in its own pool, usually empty (a
   black box), and connect it with message flows.
5. **Short labels**: 2–5 words for tasks, a question for gateways, 1–3 words for branch labels.
6. **Name branch conditions on the flows** (`gw -- yes --> t2`) or with `condition:`; mark the
   fallback branch `default: true`.
7. **Join what you fork**: close an `and` fork with an `and` join, and an `or` with an `or`.
8. **Prefer LR**; use TB for tall, narrow processes with many lanes.
9. **Do not hand-tune positions**: there is no syntax for coordinates. Reorder declarations or
   split the process instead.

## Limitations

- Only `LR` and `TB` are reliable; lane titles are misplaced in `RL` and `BT`.
- Very large diagrams (50+ elements) can take long to lay out, especially in `TB`; split them.
- Conversation and choreography diagrams are not supported.
- BPMN XML is export only (no import). Event definitions in the XML carry no message/timer details,
  and labels have no positions.
- A message flow to an element inside an expanded sub-process is drawn to the sub-process border.
- The syntax is a beta and may change when an official Mermaid release ships BPMN; the diagrams will
  then be converted once.

## A complete example

```
bpmn-beta LR
title Checkout
  pool shop "Web shop"
    lane web "Storefront"
      start message s1 "Order submitted"
      service task price "Price the order"
      xor pay "Payment method?"
      service task card "Charge card"
        boundary error declined "Declined"
      send task invoice "Send invoice"
      end e1 "Order paid"
      end error e2 "Payment failed"
    lane ops "Operations"
      user task review "Manual review"
      data-store db "Orders DB"
      note n1 "Over 5000 needs review"
  pool psp "Payment provider"
  s1 --> price --> pay
  price big@--> review
  big@{ condition: "total > 5000" }
  review --> pay
  pay -- card --> card
  pay inv@--> invoice
  inv@{ default: true }
  card --> e1
  invoice --> e1
  declined --> e2
  card m1@-.-> psp
  m1@{ label: "Charge", message: initiating }
  price ..> db
  n1 ... review
```
