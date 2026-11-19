#!/usr/bin/env node
/* eslint-disable no-console -- a command-line tool reports on the console */
/* eslint-disable @typescript-eslint/restrict-template-expressions, @typescript-eslint/no-floating-promises -- untyped script */
/**
 * Renders mermaid diagram files (written for `bpmn-beta`, or any other diagram type) to SVG
 * and, with --png, to PNG, using the IIFE bundle built from this checkout and the
 * Playwright Chromium. With --xml a `bpmn-beta` diagram is also written as BPMN 2.0.2 XML with
 * diagram interchange, laid out as the SVG draws it.
 *
 *   pnpm build:mermaid           # once, or after changing the sources
 *   node scripts/bpmn-render.mjs [--png] [--xml] [--scale 2] [--theme default] [--out dir] file.mmd ...
 *
 * Each `x.mmd` is written as `x.svg` (and `x.png`, `x.bpmn`) next to it, or into --out. A file
 * that fails to parse or render is reported and the exit code is 1.
 *
 * --xml reads the TypeScript sources of the parser and the exporter through tsx (a dev
 * dependency of this repository), so it needs no build beyond the bundle the SVG is drawn with.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const debug = Boolean(process.env.BPMN_RENDER_DEBUG);
// BPMN_RENDER_DEBUG=1 loads the readable (not minified) bundle and prints the stack of a failure.
const bundle = path.resolve(
  here,
  `../packages/mermaid/dist/${debug ? 'mermaid.js' : 'mermaid.min.js'}`
);

const args = process.argv.slice(2);
const opts = { png: false, xml: false, scale: 2, theme: 'default', out: undefined, files: [] };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--png') {
    opts.png = true;
  } else if (a === '--xml') {
    opts.xml = true;
  } else if (a === '--scale') {
    opts.scale = Number(args[++i]);
  } else if (a === '--theme') {
    opts.theme = args[++i];
  } else if (a === '--out') {
    opts.out = args[++i];
  } else if (a === '-h' || a === '--help') {
    console.log(
      'usage: node scripts/bpmn-render.mjs [--png] [--xml] [--scale N] [--theme T] [--out dir] file.mmd ...'
    );
    process.exit(0);
  } else {
    opts.files.push(a);
  }
}
if (!opts.files.length) {
  console.error('no input files; see --help');
  process.exit(2);
}
if (!existsSync(bundle)) {
  console.error(`${bundle} is missing; run "pnpm build:mermaid" first`);
  process.exit(2);
}

const xml = opts.xml ? await loadXmlExport() : undefined;

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = await import('playwright'));
}
// The repository pins its own Playwright, whose browser build may not be installed; fall back to
// CHROME_PATH or to a Chromium found where a preinstalled one usually is.
const candidates = [
  process.env.CHROME_PATH,
  '/opt/pw-browsers/chromium',
  '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome',
].filter(Boolean);
let browser;
try {
  browser = await chromium.launch(
    process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}
  );
} catch (error) {
  for (const executablePath of candidates.filter((c) => existsSync(c))) {
    try {
      browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
      break;
    } catch {
      // try the next one
    }
  }
  if (!browser) {
    throw error;
  }
}
const page = await browser.newPage({ deviceScaleFactor: opts.scale });
await page.setContent(
  '<!doctype html><html><body style="margin:0;background:white"><div id="c"></div></body></html>'
);
await page.addScriptTag({ path: bundle });
await page.evaluate((theme) => {
  window.mermaid.initialize({ startOnLoad: false, theme, securityLevel: 'loose' });
}, opts.theme);

let failed = 0;
for (const file of opts.files) {
  const text = await readFile(file, 'utf8');
  const result = await page.evaluate(async (src) => {
    try {
      const { svg } = await window.mermaid.render('d' + Math.random().toString(36).slice(2), src);
      return { svg };
    } catch (e) {
      return { error: String(e?.message ?? e), stack: e?.stack };
    }
  }, text);
  const base = path.basename(file).replace(/\.(mmd|mermaid|txt)$/, '');
  const dir = opts.out ?? path.dirname(file);
  await mkdir(dir, { recursive: true });
  if (result.error || /Syntax error in text|aria-roledescription="error"/.test(result.svg)) {
    console.error(`FAIL ${file}: ${result.error ?? 'rendered the error diagram'}`);
    if (debug && result.stack) {
      console.error(result.stack);
    }
    failed++;
    continue;
  }
  const svgPath = path.join(dir, `${base}.svg`);
  await writeFile(svgPath, result.svg);
  let msg = `ok   ${file} -> ${svgPath}`;
  if (opts.png || opts.xml) {
    await page.evaluate((svg) => {
      document.getElementById('c').innerHTML = svg;
    }, result.svg);
  }
  if (opts.png) {
    const el = await page.$('#c > svg');
    const pngPath = path.join(dir, `${base}.png`);
    await el.screenshot({ path: pngPath, omitBackground: false });
    msg += `, ${pngPath}`;
  }
  if (xml) {
    if (!/aria-roledescription="bpmn"/.test(result.svg)) {
      msg += ' (not bpmn-beta, no .bpmn written)';
    } else {
      const bpmnPath = path.join(dir, `${base}.bpmn`);
      try {
        await writeFile(bpmnPath, await xml.export(text, page));
        msg += `, ${bpmnPath}`;
      } catch (e) {
        console.error(`FAIL ${file}: no BPMN XML: ${e?.message ?? e}`);
        if (debug && e?.stack) {
          console.error(e.stack);
        }
        failed++;
        continue;
      }
    }
  }
  console.log(msg);
}
await browser.close();
process.exit(failed ? 1 : 0);

/**
 * Loads the parser and the XML exporter from the TypeScript sources, and returns
 * `export(text, page)`, which writes the diagram drawn in the page's `#c` as BPMN XML.
 */
async function loadXmlExport() {
  let tsImport;
  try {
    ({ tsImport } = await import('tsx/esm/api'));
  } catch {
    console.error('--xml needs tsx; run "pnpm install" first');
    process.exit(2);
  }
  const sources = path.resolve(here, '../packages/mermaid/src/diagrams/bpmn');
  // The ESM loader takes a URL, not a path: on Windows a `C:\...` path reads as the scheme `c:`.
  const sourceUrl = (file) => pathToFileURL(path.join(sources, file)).href;
  const { parseBpmn } = await tsImport(sourceUrl('parser/bpmn.parser.ts'), import.meta.url);
  const { toBpmnXml } = await tsImport(sourceUrl('bpmnXml.ts'), import.meta.url);
  const { version } = JSON.parse(
    await readFile(path.resolve(here, '../packages/mermaid/package.json'), 'utf8')
  );
  return {
    async export(text, page) {
      const { body, precedingLines, title } = withoutFrontMatter(text);
      const diagram = parseBpmn(body, precedingLines);
      if (title && !diagram.title) {
        diagram.title = title;
      }
      const geometry = await page.evaluate(measure, {
        nodes: diagram.nodes.map((node) => ({
          id: node.id,
          kind: node.kind,
          spanning: Boolean(node.members),
          domId: domIdOf(diagram, node.id),
        })),
        flowCount: diagram.flows.length,
      });
      return toBpmnXml(diagram, geometry, { exporterVersion: version });
    },
  };
}

/**
 * The text the bpmn parser reads: without the front matter (whose `title` is kept) and the
 * `%%{ }%%` directives, which mermaid takes out before a diagram is parsed. A directive is
 * cut out but its line breaks are kept, and the front matter's lines are passed on, so an error
 * still names a line of the file.
 */
function withoutFrontMatter(text) {
  let body = text.replace(/\r\n?/g, '\n');
  let precedingLines = 0;
  let title;
  const front = /^([^\S\n]*)-{3}[^\S\n]*\n(.*?)\n\1-{3}[^\S\n]*\n+/s.exec(body);
  if (front) {
    precedingLines = front[0].split('\n').length - 1;
    title = /^title:\s*(["']?)(.*?)\1\s*$/m.exec(front[2])?.[2];
    body = body.slice(front[0].length);
  }
  body = body.replace(/%%{.*?}%%/gs, (directive) => directive.replace(/[^\n]/g, ''));
  return { body, precedingLines, title };
}

/**
 * The DOM id an element is drawn with, less the svg id: its own id, or `${scope}-${id}` inside
 * an expanded sub-process, as `bpmnDb.scopeOf` places it (a boundary event where its activity
 * is).
 */
function domIdOf(diagram, id) {
  const byId = new Map(diagram.nodes.map((node) => [node.id, node]));
  let node = byId.get(id);
  if (node?.keyword === 'boundary' && node.parentId) {
    node = byId.get(node.parentId);
  }
  let parentId = node?.parentId;
  const seen = new Set();
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (parent?.expanded) {
      return `${parent.id}-${id}`;
    }
    parentId = parent?.parentId;
  }
  return id;
}

/**
 * Runs in the page: the bounds of every element's drawn shape and the waypoints of every flow,
 * in the SVG's user coordinates moved so that its viewBox starts at 0,0 (one unit is one pixel
 * of the SVG drawn at its natural size). An event, a gateway or a data object is measured by its
 * shape, not its caption; a pool or a lane by its band and its title.
 */
function measure({ nodes, flowCount }) {
  const svg = document.querySelector('#c > svg');
  const toUser = svg.getScreenCTM().inverse();
  const view = svg.viewBox.baseVal;
  const origin = { x: view?.x ?? 0, y: view?.y ?? 0 };
  const point = (el, x, y) => {
    const p = new DOMPoint(x, y).matrixTransform(toUser.multiply(el.getScreenCTM()));
    return { x: p.x - origin.x, y: p.y - origin.y };
  };
  const boxOf = (els) => {
    const corners = els.flatMap((el) => {
      const b = el.getBBox();
      return [
        point(el, b.x, b.y),
        point(el, b.x + b.width, b.y),
        point(el, b.x, b.y + b.height),
        point(el, b.x + b.width, b.y + b.height),
      ];
    });
    if (!corners.length) {
      return undefined;
    }
    const xs = corners.map((c) => c.x);
    const ys = corners.map((c) => c.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
  };
  // The drawn shape of a node, first match wins: an annotation is measured by its invisible
  // bounds, which take in its text as well as its bracket.
  const BODIES = [
    ':scope > g.bpmn-activity-body > rect.bpmn-activity-rect',
    ':scope > g.bpmn-frame > path.bpmn-frame-outline',
    ':scope > g.bpmn-event-body',
    ':scope > g.bpmn-gateway-body',
    ':scope > g.bpmn-data-body',
    ':scope > rect.bpmn-bounds',
    ':scope > g[class$="-body"]',
  ];
  const shapes = {};
  for (const node of nodes) {
    let parts;
    if (node.spanning) {
      const rect = svg.querySelector(
        `g.bpmn-spanning-group[data-id="${CSS.escape(node.id)}"] > rect`
      );
      parts = rect ? [rect] : [];
    } else {
      const el = svg.querySelector(`[id="${CSS.escape(`${svg.id}-${node.domId}`)}"]`);
      if (!el) {
        continue;
      }
      if (node.kind === 'pool' || node.kind === 'lane') {
        parts = [...el.querySelectorAll(':scope > rect')];
      } else if (node.kind === 'group') {
        parts = [el.querySelector('rect.outer') ?? el];
      } else {
        parts = [BODIES.map((selector) => el.querySelector(selector)).find(Boolean) ?? el];
      }
    }
    const box = boxOf(parts);
    if (box) {
      shapes[node.id] = box;
    }
  }
  const edges = {};
  for (let index = 0; index < flowCount; index++) {
    const path = svg.querySelector(`path[data-edge="true"][data-id="bpmn-edge-${index}"]`);
    const encoded = path?.getAttribute('data-points');
    if (!encoded) {
      continue;
    }
    try {
      edges[index] = JSON.parse(atob(encoded)).map((p) => point(path, p.x, p.y));
    } catch {
      // Drawn without readable points: the exporter joins the shapes' centres instead.
    }
  }
  return { shapes, edges };
}
