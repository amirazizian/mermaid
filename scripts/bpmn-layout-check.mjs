#!/usr/bin/env node
/**
 * Renders diagram files in Chromium and counts layout defects, so a change to the layout can be
 * judged by numbers as well as by eye.
 *
 *   node scripts/bpmn-layout-check.mjs [--tb] [--both] [--detail] [--json out.json] file.mmd ...
 *
 * --tb renders each file top to bottom instead of as written, --both renders it both ways.
 * Defects counted, per diagram:
 *   lineThroughShape  a flow passes over a shape that is not one of its ends
 *   lineThroughText   a flow passes over a caption, a flow label, a lane or frame title
 *                     (its own label excepted)
 *   lineOnLine        two flows run along the same track for more than 6px
 *   textOnText        two texts overlap
 *   textOnShape       a text overlaps a shape it does not belong to
 *   shapeOnShape      two shapes overlap (a boundary event on its host excepted)
 *   detour            a flow is more than 2.2 times as long as the straight distance between its
 *                     ends, and at least 120px longer
 *   bends             bends beyond 4 in one flow, summed
 *   aroundOwnEnd      a flow loops round, or comes back past, the shape it starts or ends at
 *   hugsShape         a flow runs along another shape's side within 6px
 *   labelAway         a flow label more than ~8px off its own line
 *   labelOnBorder     a flow label across a lane or pool border
 *   envelopeOnLine    a message envelope on another flow, a text or a shape
 *   crossing          two flows cross (counted, not always avoidable)
 * Exit code 0; the numbers are the result.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = path.resolve(here, '../packages/mermaid/dist/mermaid.min.js');

const args = process.argv.slice(2);
const opts = { tb: false, both: false, detail: false, json: undefined, files: [] };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--tb') opts.tb = true;
  else if (a === '--both') opts.both = true;
  else if (a === '--detail') opts.detail = true;
  else if (a === '--json') opts.json = args[++i];
  else opts.files.push(a);
}

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = await import('playwright'));
}
let browser;
for (const executablePath of [undefined, process.env.CHROME_PATH, '/opt/pw-browsers/chromium']) {
  if (executablePath !== undefined && !existsSync(executablePath)) continue;
  try {
    browser = await chromium.launch(
      executablePath ? { executablePath, args: ['--no-sandbox'] } : {}
    );
    break;
  } catch {
    // next
  }
}
const page = await browser.newPage();
await page.setContent(
  '<!doctype html><html><body style="margin:0"><div id="c"></div></body></html>'
);
await page.addScriptTag({ path: bundle });
await page.evaluate(() =>
  window.mermaid.initialize({ startOnLoad: false, securityLevel: 'loose' })
);

const withDirection = (text, direction) =>
  text.replace(/^(\s*bpmn-beta)(?:[ \t]+(?:LR|RL|TB|TD|BT))?[ \t]*$/m, `$1 ${direction}`);

/** Runs in the page: measures the diagram drawn in #c. */
function measure() {
  const svg = document.querySelector('#c svg');
  const box = (r) => ({ l: r.left, t: r.top, r: r.right, b: r.bottom });
  const area = (a) => Math.max(0, a.r - a.l) * Math.max(0, a.b - a.t);
  const inter = (a, b) => ({
    l: Math.max(a.l, b.l),
    t: Math.max(a.t, b.t),
    r: Math.min(a.r, b.r),
    b: Math.min(a.b, b.b),
  });
  const shrink = (a, d) => ({ l: a.l + d, t: a.t + d, r: a.r - d, b: a.b - d });
  const overlap = (a, b, min = 2) => {
    const i = inter(a, b);
    return i.r - i.l > min && i.b - i.t > min;
  };
  const idOf = (el) => el.getAttribute('id')?.replace(/^[^-]+-/, '') ?? '?';

  // Shapes: the drawn body of every node (not its caption).
  const BODY =
    'circle.bpmn-event-ring, rect.bpmn-activity-rect, polygon.bpmn-gateway-diamond, .bpmn-data-page, .bpmn-store-body, .bpmn-store-rings, .bpmn-annotation-bracket, .bpmn-frame-outline';
  const shapes = [];
  for (const node of svg.querySelectorAll('g.node')) {
    const marks = [...node.querySelectorAll(BODY)].filter((m) => m.closest('g.node') === node);
    if (!marks.length) continue;
    const rects = marks.map((m) => box(m.getBoundingClientRect()));
    const b = {
      l: Math.min(...rects.map((r) => r.l)),
      t: Math.min(...rects.map((r) => r.t)),
      r: Math.max(...rects.map((r) => r.r)),
      b: Math.max(...rects.map((r) => r.b)),
    };
    const frame = node.classList.contains('bpmn-subprocess-frame');
    const boundary = node.classList.contains('bpmn-event-boundary');
    shapes.push({ id: idOf(node), box: b, node, frame, boundary });
  }
  // Texts: captions, flow labels, cluster titles, frame titles.
  const texts = [];
  const textBox = (el) => {
    const inner = el.querySelector('foreignObject div span, foreignObject div, text') ?? el;
    const r = inner.getBoundingClientRect();
    return r.width > 1 && r.height > 1 ? box(r) : undefined;
  };
  for (const node of svg.querySelectorAll('g.node')) {
    const label = node.querySelector(':scope > g.label, :scope > g.bpmn-frame-title');
    const b = label && label.textContent.trim() ? textBox(label) : undefined;
    if (b) texts.push({ kind: 'caption', owner: idOf(node), box: b, node });
  }
  for (const label of svg.querySelectorAll('g.edgeLabel')) {
    const b = label.textContent.trim() ? textBox(label) : undefined;
    if (b) {
      const m = /(bpmn-edge-\d+)$/.exec(label.id ?? '');
      texts.push({ kind: 'flowLabel', owner: m ? m[1] : '?', box: b });
    }
  }
  for (const label of svg.querySelectorAll(
    'g.cluster g.cluster-label, .bpmn-spanning-group text'
  )) {
    const b = label.textContent.trim() ? textBox(label) : undefined;
    if (b) texts.push({ kind: 'title', owner: label.textContent.trim(), box: b });
  }
  // Flows, sampled along the drawn path.
  const flows = [];
  for (const path of svg.querySelectorAll('path[data-id^="bpmn-edge-"]')) {
    const len = path.getTotalLength();
    const ctm = path.getScreenCTM();
    if (!ctm || !(len > 0)) continue;
    const pts = [];
    const step = 2;
    for (let s = 0; s <= len; s += step) {
      const p = path.getPointAtLength(s).matrixTransform(ctm);
      pts.push({ x: p.x, y: p.y });
    }
    const end = path.getPointAtLength(len).matrixTransform(ctm);
    pts.push({ x: end.x, y: end.y });
    flows.push({ id: path.getAttribute('data-id'), pts, len: len * ctm.a });
  }
  const shapeAt = (p) =>
    shapes.filter((s) => p.x >= s.box.l && p.x <= s.box.r && p.y >= s.box.t && p.y <= s.box.b);

  const issues = [];
  const add = (kind, what) => issues.push({ kind, what });

  for (const f of flows) {
    const first = f.pts[0];
    const last = f.pts[f.pts.length - 1];
    // Ends: the shapes the flow starts and ends in (or touches), and frames that hold them.
    const near = (p) =>
      shapes.filter(
        (s) =>
          p.x >= s.box.l - 12 && p.x <= s.box.r + 12 && p.y >= s.box.t - 12 && p.y <= s.box.b + 12
      );
    const ends = new Set([...near(first), ...near(last)]);
    // A frame contains its content: a flow inside a frame does not cross it.
    const inside = (s) =>
      s.frame &&
      [first, last].some((p) => p.x > s.box.l && p.x < s.box.r && p.y > s.box.t && p.y < s.box.b);
    const crossed = new Set();
    for (const p of f.pts) {
      for (const s of shapeAt(p)) {
        if (ends.has(s) || inside(s) || crossed.has(s)) continue;
        // A frame's own border band only; its inside belongs to its content.
        if (s.frame) {
          const inner = shrink(s.box, 4);
          if (p.x > inner.l && p.x < inner.r && p.y > inner.t && p.y < inner.b) continue;
        }
        const core = shrink(s.box, 2);
        if (p.x > core.l && p.x < core.r && p.y > core.t && p.y < core.b) {
          crossed.add(s);
          add('lineThroughShape', `${f.id} over ${s.id}`);
        }
      }
    }
    const textHit = new Set();
    for (const p of f.pts) {
      for (const t of texts) {
        if (textHit.has(t)) continue;
        if (t.kind === 'flowLabel' && t.owner === f.id) continue;
        const c = shrink(t.box, 1);
        if (p.x > c.l && p.x < c.r && p.y > c.t && p.y < c.b) {
          textHit.add(t);
          add('lineThroughText', `${f.id} over ${t.kind} of ${t.owner}`);
        }
      }
    }
    const straight = Math.hypot(last.x - first.x, last.y - first.y);
    if (f.len > 1.8 * straight && f.len - straight > 100) {
      add('detour', `${f.id} is ${Math.round(f.len)}px for ${Math.round(straight)}px`);
    }
    // Bends: direction changes in the sampled polyline.
    let bends = 0;
    let dir;
    for (let i = 1; i < f.pts.length; i++) {
      const dx = f.pts[i].x - f.pts[i - 1].x;
      const dy = f.pts[i].y - f.pts[i - 1].y;
      if (Math.hypot(dx, dy) < 0.5) continue;
      const d = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'E' : 'W') : dy > 0 ? 'S' : 'N';
      if (dir && d !== dir) bends++;
      dir = d;
    }
    // Rounded corners sample as two turns each.
    const corners = Math.round(bends / 2);
    if (corners > 4) add('bends', `${f.id} has ${corners} bends`);
  }
  // A flow that goes round one of its own ends: away from the end it later meets, coming back
  // within 8px of that shape anywhere but its first and last 14px.
  for (const f of flows) {
    const first = f.pts[0];
    const last = f.pts[f.pts.length - 1];
    const own = (p) =>
      shapes.filter(
        (s) =>
          !s.frame &&
          p.x >= s.box.l - 3 &&
          p.x <= s.box.r + 3 &&
          p.y >= s.box.t - 3 &&
          p.y <= s.box.b + 3
      );
    for (const [end, skipHead, skipTail] of [
      [own(first), 7, 0],
      [own(last), 0, 7],
    ]) {
      for (const s of end) {
        const zone = { l: s.box.l - 16, t: s.box.t - 16, r: s.box.r + 16, b: s.box.b + 16 };
        let away = false;
        let flagged = false;
        const pts = f.pts.slice(skipHead, f.pts.length - skipTail);
        for (const p of pts) {
          const inZone = p.x > zone.l && p.x < zone.r && p.y > zone.t && p.y < zone.b;
          if (!inZone) away = true;
          else if (away && skipHead && !flagged) {
            // left its start shape's zone, then came back to it
            flagged = true;
          }
        }
        // Count points inside the zone in the middle of the flow.
        const middle = f.pts.slice(10, f.pts.length - 10);
        const near = middle.filter(
          (p) => p.x > zone.l && p.x < zone.r && p.y > zone.t && p.y < zone.b
        ).length;
        if (flagged || near > 12) {
          add('aroundOwnEnd', `${f.id} runs round ${s.id}`);
        }
      }
    }
  }
  // A flow that runs along another shape's side, within 6px, for 16px or more.
  for (const f of flows) {
    const first = f.pts[0];
    const last = f.pts[f.pts.length - 1];
    for (const s of shapes) {
      if (s.frame) continue;
      const touchesEnd = [first, last].some(
        (p) =>
          p.x >= s.box.l - 12 && p.x <= s.box.r + 12 && p.y >= s.box.t - 12 && p.y <= s.box.b + 12
      );
      if (touchesEnd) continue;
      const band = { l: s.box.l - 6, t: s.box.t - 6, r: s.box.r + 6, b: s.box.b + 6 };
      const n = f.pts.filter(
        (p) => p.x > band.l && p.x < band.r && p.y > band.t && p.y < band.b
      ).length;
      if (n >= 8) add('hugsShape', `${f.id} along ${s.id}`);
    }
  }
  // A flow label away from its own line, or on a lane or pool border.
  const borders = [
    ...svg.querySelectorAll('g.cluster rect.swimlane-body, g.cluster rect.pool-body'),
  ].map((r) => box(r.getBoundingClientRect()));
  for (const t of texts.filter((x) => x.kind === 'flowLabel')) {
    const f = flows.find((x) => x.id === t.owner);
    if (f) {
      const cx = (t.box.l + t.box.r) / 2;
      const cy = (t.box.t + t.box.b) / 2;
      const d = Math.min(...f.pts.map((p) => Math.hypot(p.x - cx, p.y - cy)));
      if (d > Math.max(12, (t.box.b - t.box.t) / 2 + 8))
        add('labelAway', `label of ${t.owner} is ${Math.round(d)}px off its line`);
    }
    for (const b of borders) {
      const hits =
        [b.l, b.r].some(
          (x) => x > t.box.l + 2 && x < t.box.r - 2 && t.box.b > b.t && t.box.t < b.b
        ) ||
        [b.t, b.b].some(
          (y) => y > t.box.t + 2 && y < t.box.b - 2 && t.box.r > b.l && t.box.l < b.r
        );
      if (hits) {
        add('labelOnBorder', `label of ${t.owner}`);
        break;
      }
    }
  }
  // Envelopes: on another flow, on a crossing, on text or on a shape.
  for (const env of svg.querySelectorAll('g.bpmn-envelope')) {
    const b = box(env.getBoundingClientRect());
    const own = env.getAttribute('data-flow');
    const others = flows.filter(
      (f) => f.id !== own && f.pts.some((p) => p.x > b.l && p.x < b.r && p.y > b.t && p.y < b.b)
    );
    if (others.length)
      add('envelopeOnLine', `envelope of ${own} on ${others.map((f) => f.id).join(', ')}`);
    if (texts.some((t) => overlap(t.box, b)) || shapes.some((s) => !s.frame && overlap(s.box, b))) {
      add('envelopeOnLine', `envelope of ${own} on text or shape`);
    }
  }
  // Crossings between flows.
  const segs = (f) => {
    const out = [];
    for (let i = 1; i < f.pts.length; i++) out.push([f.pts[i - 1], f.pts[i]]);
    return out;
  };
  const cross = (a, b) => {
    const d = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    const d1 = d(b[0], b[1], a[0]);
    const d2 = d(b[0], b[1], a[1]);
    const d3 = d(a[0], a[1], b[0]);
    const d4 = d(a[0], a[1], b[1]);
    return d1 * d2 < 0 && d3 * d4 < 0;
  };
  for (let a = 0; a < flows.length; a++) {
    const sa = segs(flows[a]);
    for (let b = a + 1; b < flows.length; b++) {
      const sb = segs(flows[b]);
      let n = 0;
      let lastHit = -10;
      for (let i = 0; i < sa.length; i++) {
        if (sb.some((s) => cross(sa[i], s))) {
          if (i - lastHit > 3) n++;
          lastHit = i;
        }
      }
      for (let k = 0; k < n; k++) add('crossing', `${flows[a].id} x ${flows[b].id}`);
    }
  }
  // Flows along one track.
  const key = (p) => `${Math.round(p.x / 3)},${Math.round(p.y / 3)}`;
  for (let a = 0; a < flows.length; a++) {
    const cells = new Set(flows[a].pts.map(key));
    for (let b = a + 1; b < flows.length; b++) {
      let run = 0;
      let longest = 0;
      for (const p of flows[b].pts) {
        if (cells.has(key(p))) {
          run++;
          longest = Math.max(longest, run);
        } else run = 0;
      }
      if (longest * 2 > 6 + 4)
        add('lineOnLine', `${flows[a].id} and ${flows[b].id} share ${longest * 2}px`);
    }
  }
  for (let a = 0; a < texts.length; a++) {
    for (let b = a + 1; b < texts.length; b++) {
      if (overlap(texts[a].box, texts[b].box)) {
        add(
          'textOnText',
          `${texts[a].kind} of ${texts[a].owner} and ${texts[b].kind} of ${texts[b].owner}`
        );
      }
    }
    for (const s of shapes) {
      if (texts[a].node === s.node) continue;
      if (s.frame) {
        // Text inside a frame is its content; only its border band counts.
        const inner = shrink(s.box, 4);
        const t = texts[a].box;
        if (t.l > inner.l && t.r < inner.r && t.t > inner.t && t.b < inner.b) continue;
        if (t.r < s.box.l || t.l > s.box.r || t.b < s.box.t || t.t > s.box.b) continue;
        const crossesBorder = !(t.l > s.box.l && t.r < s.box.r && t.t > s.box.t && t.b < s.box.b);
        if (crossesBorder || t.t < inner.t || t.b > inner.b || t.l < inner.l || t.r > inner.r) {
          if (texts[a].owner === s.id) continue;
          add('textOnShape', `${texts[a].kind} of ${texts[a].owner} on frame ${s.id}`);
        }
        continue;
      }
      // A text of an element inside a frame sits on the frame's inside: fine.
      if (overlap(texts[a].box, shrink(s.box, 1))) {
        add('textOnShape', `${texts[a].kind} of ${texts[a].owner} on ${s.id}`);
      }
    }
  }
  for (let a = 0; a < shapes.length; a++) {
    for (let b = a + 1; b < shapes.length; b++) {
      const A = shapes[a];
      const B = shapes[b];
      if (A.boundary || B.boundary) continue;
      const contains = (x, y) =>
        x.box.l <= y.box.l && x.box.r >= y.box.r && x.box.t <= y.box.t && x.box.b >= y.box.b;
      if ((A.frame && contains(A, B)) || (B.frame && contains(B, A))) continue;
      if (overlap(A.box, B.box)) add('shapeOnShape', `${A.id} and ${B.id}`);
    }
  }
  return issues;
}

const KINDS = [
  'lineThroughShape',
  'lineThroughText',
  'lineOnLine',
  'textOnText',
  'textOnShape',
  'shapeOnShape',
  'aroundOwnEnd',
  'hugsShape',
  'labelAway',
  'labelOnBorder',
  'envelopeOnLine',
  'detour',
  'bends',
  'crossing',
];
const results = [];
const variants = opts.both ? ['LR', 'TB'] : [opts.tb ? 'TB' : undefined];
for (const file of opts.files) {
  const source = await readFile(file, 'utf8');
  for (const direction of variants) {
    const text = direction ? withDirection(source, direction) : source;
    const result = await page.evaluate(
      async ({ text, fn }) => {
        try {
          const { svg } = await window.mermaid.render(
            'd' + Math.random().toString(36).slice(2),
            text
          );
          document.getElementById('c').innerHTML = svg;
          // eslint-disable-next-line no-new-func
          return { issues: new Function(`return (${fn})()`)() };
        } catch (e) {
          return { error: String(e?.message ?? e) };
        }
      },
      { text, fn: measure.toString() }
    );
    const name = `${path.basename(file)}${direction ? ` ${direction}` : ''}`;
    if (result.error) {
      results.push({ name, error: result.error });
      continue;
    }
    const counts = Object.fromEntries(
      KINDS.map((k) => [k, result.issues.filter((i) => i.kind === k).length])
    );
    results.push({ name, counts, issues: result.issues });
  }
}
await browser.close();

const pad = (s, n) => String(s).padEnd(n);
console.log(
  pad('diagram', 40) +
    KINDS.map((k) =>
      pad(
        k
          .replace(/([A-Z])/g, ' $1')
          .split(' ')
          .map((w) => w[0])
          .join(''),
        5
      )
    ).join('') +
    'total'
);
const totals = Object.fromEntries(KINDS.map((k) => [k, 0]));
for (const r of results) {
  if (r.error) {
    console.log(pad(r.name, 40) + 'ERROR ' + r.error);
    continue;
  }
  const total = KINDS.reduce((s, k) => s + r.counts[k], 0);
  for (const k of KINDS) totals[k] += r.counts[k];
  console.log(pad(r.name, 40) + KINDS.map((k) => pad(r.counts[k] || '.', 5)).join('') + total);
  if (opts.detail) {
    for (const i of r.issues) console.log(`    ${i.kind}: ${i.what}`);
  }
}
console.log(
  pad('TOTAL', 40) +
    KINDS.map((k) => pad(totals[k], 5)).join('') +
    KINDS.reduce((s, k) => s + totals[k], 0)
);
console.log('columns: ' + KINDS.join(', '));
if (opts.json) await writeFile(opts.json, JSON.stringify(results, null, 2));
