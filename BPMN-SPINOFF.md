# BPMN spin-off: build and render

This branch (`private/bpmn-spinoff`) carries a `bpmn-beta` diagram type ahead of upstream. It is
for personal use and is never published to a registry.

## Build

```sh
pnpm install --frozen-lockfile   # Node 22, pnpm 10
pnpm build:mermaid               # writes packages/mermaid/dist/, including mermaid.min.js
```

`pnpm build:mermaid` cleans every package first, which removes `@mermaid-js/parser`'s type
declarations. The pre-commit hook type-checks the docs against them, so after a build run
`pnpm build:types` once before committing.

`packages/mermaid/dist/mermaid.min.js` is a self-contained IIFE bundle: load it in a page with a
`<script>` tag and call `mermaid.render(id, text)` or `mermaid.run()`, as with the official build.

## Render a diagram to SVG, PNG or BPMN XML

```sh
pnpm bpmn:render --png path/to/process.mmd            # writes process.svg and process.png beside it
pnpm bpmn:render --png --out out/ diagrams/*.mmd      # several at once, into out/
```

Options: `--png` also writes a PNG; `--xml` also writes BPMN XML (see below); `--scale N` sets the PNG pixel ratio (default 2);
`--theme T` picks a mermaid theme (default `default`); `--out dir` sets the output folder.
A file that does not parse is reported with the parser's message and the exit code is 1, so
the script can gate a generator in CI.

The script drives Chromium through Playwright. It uses Playwright's own browser if that is
installed, and otherwise `CHROME_PATH` or a Chromium under `/opt/pw-browsers`.

## Exporting BPMN XML

```sh
pnpm bpmn:render --xml --png --out out/ diagrams/*.mmd   # also writes out/x.bpmn for each x.mmd
```

`--xml` writes a BPMN 2.0.2 XML file with diagram interchange (DI) beside each SVG, for
Camunda Modeler, bpmn.io and other BPMN tools; it is an export only, nothing reads XML back.
The layout is the SVG's: the script renders the diagram, measures every element's drawn shape
and every flow's waypoints in the page, and hands them with the parsed diagram to
`toBpmnXml(diagram, geometry)` in `packages/mermaid/src/diagrams/bpmn/bpmnXml.ts`. Coordinates
are the SVG's user units with its viewBox moved to 0,0, so they equal PNG pixels divided by the
PNG scale (when the SVG is not shrunk to fit the 1280px page). The parser and the exporter are
loaded from the TypeScript sources through `tsx` (a dev dependency), so `node
scripts/bpmn-render.mjs` keeps working and no extra build is needed. A diagram that is not
`bpmn-beta` gets no `.bpmn`; a file that cannot be exported counts as a failure (exit code 1).

`toBpmnXml` is pure. Called without geometry it writes the semantics only, with no
`BPMNDiagram` (bpmn.io then has nothing to draw); there is no fallback layout.

What maps to what:

- Pools are `participant`s of a `collaboration`; a pool with contents gets a `process`
  (`Process_<poolId>`), an empty pool is a black box without `processRef`, and
  `multiple: true` writes `participantMultiplicity minimum="2"` (maximum the largest int, since
  the schema's default maximum is 1). Without pools there is one process; with pools, anything
  outside them goes to an extra process whose participant is drawn around it. Message flows
  without any pool also get a collaboration with that participant.
- Lanes are `laneSet`/`lane` with `flowNodeRef` to the top-level flow nodes in them (a node in a
  nested lane is listed in its parent lanes too; nested lanes are `childLaneSet`s).
- Events: `start`/`intermediate`/`throw`/`end`/`boundary` are `startEvent`,
  `intermediateCatchEvent`, `intermediateThrowEvent`, `endEvent`, `boundaryEvent`
  (`attachedToRef`, `cancelActivity="false"` when non-interrupting; `isInterrupting="false"` on a
  non-interrupting start). One event definition per trigger; `multiple` writes a message and a
  signal definition, `parallel-multiple` the same with `parallelMultiple="true"`; a conditional
  definition has an empty `tFormalExpression` condition and a link definition is named by the
  label.
- Activities: `task` and its typed forms (`rule` is `businessRuleTask`), `callActivity`,
  `subProcess` (`triggeredByEvent` for `kind: event`), `transaction`, `adHocSubProcess`;
  `loop` is `standardLoopCharacteristics`, `parallel`/`sequential` are
  `multiInstanceLoopCharacteristics` (`isSequential`), `compensation` is
  `isForCompensation="true"`. An expanded sub-process holds its elements and flows.
- Gateways map one to one; `default` names the default flow (also on activities); an
  event-based gateway with `instantiate` writes `instantiate="true"` and, for `parallel`,
  `eventGatewayType="Parallel"`. An unmarked `xor` is `isMarkerVisible="false"` in DI.
- Sequence flows carry `name` (the arrow label, else the condition) and a `conditionExpression`
  (`tFormalExpression`). Message flows are in the collaboration; one with `message` gets a
  `message` root element and `messageRef`, and its DI edge says `messageVisibleKind`.
  Associations carry `associationDirection` `None`/`One`/`Both`.
- Data: `data` and `data-collection` are a `dataObject` (`isCollection`) plus the drawn
  `dataObjectReference`, with a `dataState` for `state`; `data-store` is a `dataStoreReference`
  plus a root `dataStore`. `data-input` and `data-output` are the process's `ioSpecification`
  `dataInput`/`dataOutput` (inside a sub-process, which has none, they fall back to data
  objects). A directed association from data to an activity is that activity's
  `dataInputAssociation` (targeting a `__targetRef_placeholder` property, as BPMN tools write
  it), and from an activity to data its `dataOutputAssociation`.
- `note` is a `textAnnotation`; `group` a `group` with a `category`/`categoryValue`; a group
  with `members` across pools belongs to the collaboration.
- Ids: the author's element and flow ids are kept (made valid NCNames, suffixed `_2`... on a
  clash); flows without an id are `Flow_<n>`, `MessageFlow_<n>`, `Association_<n>`,
  `DataInputAssociation_<n>`... with `n` the flow's position in the text.
- DI: one `BPMNPlane` on the collaboration (or the process), a `BPMNShape` per element
  (`isHorizontal` on pools and lanes from the direction, `isExpanded` on sub-processes and call
  activities) and a `BPMNEdge` per flow. Labels (`BPMNLabel`) are left out, so tools place them.

Approximated or left out: no `BPMNLabel` positions; a typed call activity (`user call`) is a
plain `callActivity` with no `calledElement` (bpmn.io always draws a call activity's `+`);
event definitions carry no message, signal, error or timer details; data associations with
events stay associations; a sequence flow that crosses pools is written into its source's
process, which BPMN does not allow; message flows to elements inside an expanded sub-process
reference those elements but their waypoints end at the sub-process border, as drawn.

## Syntax reference

- `packages/mermaid/src/docs/syntax/bpmn.md` — the tour.
- `packages/mermaid/src/docs/syntax/bpmnElements.md` — every BPMN element and what to write.
- Sample diagrams: `e2e/platform/dev-diagrams/diagrams/bpmn/`.
