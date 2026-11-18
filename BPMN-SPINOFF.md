# BPMN spin-off: build and render

This branch (`private/bpmn-spinoff`) carries a `bpmn-beta` diagram type ahead of upstream. It is
for personal use and is never published to a registry.

## Build

```sh
pnpm install --frozen-lockfile   # Node 22, pnpm 10
pnpm build:mermaid               # writes packages/mermaid/dist/, including mermaid.min.js
```

`packages/mermaid/dist/mermaid.min.js` is a self-contained IIFE bundle: load it in a page with a
`<script>` tag and call `mermaid.render(id, text)` or `mermaid.run()`, as with the official build.

## Render a diagram to SVG or PNG

```sh
pnpm bpmn:render --png path/to/process.mmd            # writes process.svg and process.png beside it
pnpm bpmn:render --png --out out/ diagrams/*.mmd      # several at once, into out/
```

Options: `--png` also writes a PNG; `--scale N` sets the PNG pixel ratio (default 2);
`--theme T` picks a mermaid theme (default `default`); `--out dir` sets the output folder.
A file that does not parse is reported with the parser's message and the exit code is 1, so
the script can gate a generator in CI.

The script drives Chromium through Playwright. It uses Playwright's own browser if that is
installed, and otherwise `CHROME_PATH` or a Chromium under `/opt/pw-browsers`.

## Syntax reference

- `packages/mermaid/src/docs/syntax/bpmn.md` — the tour.
- `packages/mermaid/src/docs/syntax/bpmnElements.md` — every BPMN element and what to write.
- Sample diagrams: `e2e/platform/dev-diagrams/diagrams/bpmn/`.
