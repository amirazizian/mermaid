# Instructions for coding agents on this branch

This is `private/bpmn-spinoff`, a personal branch of Mermaid that adds a `bpmn-beta` diagram type.
It is used to draw business processes found in source code as BPMN diagrams and to render them as
images.

When asked to write, fix or render a BPMN diagram, follow [`BPMN-GUIDE.md`](../BPMN-GUIDE.md) at
the repository root: it has the setup, the full syntax, how to map code to BPMN, the rules the
parser enforces, the render and layout-check commands, and style rules for readable diagrams.

Key points:

- Diagrams start with `bpmn-beta LR` (or `TB`). Never use `flowchart` for BPMN.
- Always render after writing: `node scripts/bpmn-render.mjs --png --out out/ file.mmd`. Exit code 1
  means the diagram was refused; the message gives the line and column. Fix and render again.
- Run `pnpm build:mermaid` once before rendering, and again after pulling.
- Check the result with `node scripts/bpmn-layout-check.mjs --detail file.mmd` and look at the PNG.
- Do not publish this build to npm, and do not open pull requests or issues upstream.
