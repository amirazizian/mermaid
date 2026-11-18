#!/usr/bin/env node
/**
 * Renders mermaid diagram files (written for `bpmn-beta`, or any other diagram type) to SVG
 * and, with --png, to PNG, using the IIFE bundle built from this checkout and the
 * Playwright Chromium.
 *
 *   pnpm build:mermaid           # once, or after changing the sources
 *   node scripts/bpmn-render.mjs [--png] [--scale 2] [--theme default] [--out dir] file.mmd ...
 *
 * Each `x.mmd` is written as `x.svg` (and `x.png`) next to it, or into --out. A file that
 * fails to parse or render is reported and the exit code is 1.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = path.resolve(here, '../packages/mermaid/dist/mermaid.min.js');

const args = process.argv.slice(2);
const opts = { png: false, scale: 2, theme: 'default', out: undefined, files: [] };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--png') opts.png = true;
  else if (a === '--scale') opts.scale = Number(args[++i]);
  else if (a === '--theme') opts.theme = args[++i];
  else if (a === '--out') opts.out = args[++i];
  else if (a === '-h' || a === '--help') {
    console.log('usage: node scripts/bpmn-render.mjs [--png] [--scale N] [--theme T] [--out dir] file.mmd ...');
    process.exit(0);
  } else opts.files.push(a);
}
if (!opts.files.length) {
  console.error('no input files; see --help');
  process.exit(2);
}
if (!existsSync(bundle)) {
  console.error(`${bundle} is missing; run "pnpm build:mermaid" first`);
  process.exit(2);
}

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
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
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
await page.setContent('<!doctype html><html><body style="margin:0;background:white"><div id="c"></div></body></html>');
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
      return { error: String(e?.message ?? e) };
    }
  }, text);
  const base = path.basename(file).replace(/\.(mmd|mermaid|txt)$/, '');
  const dir = opts.out ?? path.dirname(file);
  await mkdir(dir, { recursive: true });
  if (result.error || /Syntax error in text|aria-roledescription="error"/.test(result.svg)) {
    console.error(`FAIL ${file}: ${result.error ?? 'rendered the error diagram'}`);
    failed++;
    continue;
  }
  const svgPath = path.join(dir, `${base}.svg`);
  await writeFile(svgPath, result.svg);
  let msg = `ok   ${file} -> ${svgPath}`;
  if (opts.png) {
    await page.evaluate((svg) => {
      document.getElementById('c').innerHTML = svg;
    }, result.svg);
    const el = await page.$('#c > svg');
    const pngPath = path.join(dir, `${base}.png`);
    await el.screenshot({ path: pngPath, omitBackground: false });
    msg += `, ${pngPath}`;
  }
  console.log(msg);
}
await browser.close();
process.exit(failed ? 1 : 0);
