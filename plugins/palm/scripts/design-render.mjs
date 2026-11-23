#!/usr/bin/env node
// Palm tool: design.render — lets an agent SEE its Quick Design design. It renders the design with Quick Design's own
// drawing code and fonts (the same pixels the person will get when they open the link), saves a PNG per page, and
// measures every text box for real: how many lines it wraps to, its true height, words split across lines, overlaps
// and text off the page. Then it runs design-check on the measured design. Runs on the user's machine with their
// Chrome/Edge/Chromium (puppeteer-core); nothing is sent to an AI and nothing is stored on our side.
// adds: tool (an agent can't see its render; it guesses widths and gets them wrong).
//
//   node palm/tools/design-render.mjs design.json [--out design.png] [--scale 1] [--base https://www.yuzool.com]
//   cat design.json | node palm/tools/design-render.mjs - --out design.png
// Prints JSON: {ok, pngs:[...], measured:{texts:[...]}, check:{score, issues}, link}
// Then LOOK at the PNG (e.g. Claude Code: Read the .png) before calling the design done.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import http from 'node:http';
import { check } from './design-check.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };

function loadPuppeteer() {
  for (const base of [process.env.PALM_NODE_MODULES, here, join(here, '..'), process.cwd(), join(here, '../../yz-hd-tools')].filter(Boolean)) {
    try { return createRequire(join(base, 'x.js'))('puppeteer-core'); } catch { /* next */ }
  }
  throw new Error('puppeteer-core is not installed. Run: npm i puppeteer-core');
}
function findChrome() {
  const c = [process.env.PALM_CHROME, process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
    'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'];
  const p = c.find((x) => x && existsSync(x));
  if (!p) throw new Error('No Chrome, Edge or Chromium found. Set PALM_CHROME to its path.');
  return p;
}

// --base local: serve this repo's src/ (for tests); otherwise the live site.
async function localServer() {
  const root = resolve(here, '../../src');
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html';
    try { const b = readFileSync(join(root, p)); r.writeHead(200, { 'content-type': types[p.slice(p.lastIndexOf('.'))] || 'application/octet-stream' }); r.end(b); } catch { r.writeHead(404); r.end(); }
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  return { srv, base: `http://127.0.0.1:${srv.address().port}` };
}

export async function render(design, { out = 'design.png', scale = 1, base = process.env.PALM_BASE || 'https://www.yuzool.com' } = {}) {
  let srv = null;
  if (base === 'local') ({ srv, base } = await localServer());
  const puppeteer = loadPuppeteer();
  const browser = await puppeteer.launch({ executablePath: findChrome(), headless: 'new', timeout: 90000, args: ['--no-first-run', '--no-default-browser-check'] });
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    // Don't count renders as visits or load anything the render doesn't need.
    page.on('request', (r) => (/tinylytics|googletagmanager/.test(r.url()) ? r.abort() : r.continue()));
    await page.setViewport({ width: 800, height: 600 });
    await page.goto(base + '/quick-design/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => window.QD && typeof QD.renderToCanvas === 'function', { timeout: 30000 });
    const res = await page.evaluate(async (input, scale) => {
      const F = await import('/quick-design/format.js');
      const lists = (await (await fetch('/quick-design/templates.json')).json()).lists;
      const s = F.sanitize(input, lists);
      if (!s.doc) return { errors: s.errors, warnings: s.warnings };
      const doc = s.doc;
      await QD.docFonts(doc); await document.fonts.ready;
      doc.pages.forEach((p) => p.els.forEach((e) => QD.fitText(e)));
      try { await QD.assetsReady(doc); } catch { /* photos arrive empty anyway */ }
      const pngs = doc.pages.map((p) => QD.renderToCanvas(p, doc, scale, {}).toDataURL('image/png'));
      // How people actually see it: ~360 px wide on a phone feed (320 for a thumbnail in a list).
      const small = doc.pages.map((p) => QD.renderToCanvas(p, doc, (doc.w > doc.h * 1.5 ? 320 : 360) / doc.w, {}).toDataURL('image/png'));
      const texts = [];
      doc.pages.forEach((p, pi) => p.els.forEach((e, ei) => {
        if (e.t !== 'text' || e.hid) return;
        // QD.layoutText arrived 2026-11-21; older pages only give the measured height.
        const L = QD.layoutText ? QD.layoutText(e) : { lines: Array.from({ length: Math.max(1, Math.round(e.h / (e.fs * (e.lh || 1.15)))) }, () => ({ s: '', w: 0 })) };
        const lines = L.lines.map((l) => l.s);
        if (!QD.layoutText) { texts.push({ page: pi, el: ei, txt: String(e.txt).slice(0, 40), lines: lines.length, h: Math.round(e.h), boxW: Math.round(e.w), broken: [] }); return; }
        const words = String(e.up ? String(e.txt).toUpperCase() : e.txt).split(/\s+/).filter(Boolean);
        const broken = words.filter((w) => !lines.some((l) => l.split(/\s+/).includes(w)) && w.length > 1);
        const widest = Math.max(0, ...L.lines.map((l) => l.w || 0));
        texts.push({ page: pi, el: ei, txt: String(e.txt).slice(0, 40), lines, h: Math.round(e.h), widest: Math.round(widest), boxW: Math.round(e.w), broken });
      }));
      // Several pages: one contact sheet, pages side by side at 720 px tall, to see the set at once.
      let sheet = null;
      if (doc.pages.length > 1) {
        const k = 720 / doc.h, gap = 24, pw = Math.round(doc.w * k);
        const c = document.createElement('canvas'); c.width = doc.pages.length * (pw + gap) - gap; c.height = 720;
        const x = c.getContext('2d'); x.fillStyle = '#888'; x.fillRect(0, 0, c.width, c.height);
        doc.pages.forEach((p, i) => x.drawImage(QD.renderToCanvas(p, doc, k, {}), i * (pw + gap), 0));
        sheet = c.toDataURL('image/png');
      }
      return { doc, pngs, small, sheet, texts, warnings: s.warnings };
    }, design, scale);
    if (!res.doc) return { ok: false, errors: res.errors, warnings: res.warnings };

    const pngs = res.pngs.map((d, i) => {
      const f = res.pngs.length === 1 ? out : out.replace(/(\.png)?$/i, `-${i + 1}.png`);
      writeFileSync(f, Buffer.from(d.split(',')[1], 'base64'));
      writeFileSync(f.replace(/\.png$/i, '-phone.png'), Buffer.from(res.small[i].split(',')[1], 'base64'));
      return resolve(f);
    });
    let sheet = null;
    if (res.sheet) { sheet = resolve(out.replace(/(\.png)?$/i, '-sheet.png')); writeFileSync(sheet, Buffer.from(res.sheet.split(',')[1], 'base64')); }
    // Measured issues replace design-check's estimates.
    for (const t of res.texts) if (t.widest != null) res.doc.pages[t.page].els[t.el]._tw = t.widest;
    const c = check({ design: res.doc, measured: true });
    res.doc.pages.forEach((p) => p.els.forEach((e) => delete e._tw));
    for (const t of res.texts) {
      if (t.broken.length) c.issues.unshift({ rule: 'word-break', severity: 'error', page: t.page, el: t.el, msg: `"${t.broken.join('", "')}" is split across lines in "${t.txt}" (measured).`, fix: `Widen the box (widest line ${t.widest}px vs box ${t.boxW}px) or lower fs.` });
    }
    c.ok = !c.issues.some((i) => i.severity === 'error');
    const link = 'https://www.yuzool.com/quick-design/#j=' + encodeURIComponent(JSON.stringify(res.doc));
    return { ok: c.ok, pngs, sheet, phone: pngs.map((f) => f.replace(/\.png$/i, '-phone.png')),
      look: 'Open the PNG and the -phone.png (its size in a feed) and look before you finish: what reads first, what is cramped or accidental, what is too small to read at phone size.', measured: { texts: res.texts }, check: { score: c.score, issues: c.issues }, warnings: res.warnings, link };
  } finally {
    await browser.close();
    srv?.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const src = process.argv[2];
  if (!src || src.startsWith('--')) { console.error('usage: design-render.mjs <design.json|-> [--out design.png] [--scale 1] [--base local|https://www.yuzool.com]'); process.exit(2); }
  const raw = JSON.parse(readFileSync(src === '-' ? 0 : src, 'utf8'));
  const r = await render(raw.design || raw, { out: arg('out', 'design.png'), scale: +arg('scale', 1), base: arg('base', process.env.PALM_BASE || 'https://www.yuzool.com') });
  const { link, ...rest } = r;
  process.stdout.write(JSON.stringify({ ...rest, link: link ? link.slice(0, 120) + '… (full link in design.link.txt)' : undefined }, null, 2) + '\n');
  if (link) writeFileSync(arg('out', 'design.png').replace(/\.png$/i, '') + '.link.txt', link + '\n');
}
