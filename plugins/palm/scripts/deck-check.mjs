#!/usr/bin/env node
// Palm tool: deck-check — lets an agent see a slide deck the way the room, the call and the inbox will: every slide
// measured at 1920×1080 (text overflowing or clipped, colliding text, the smallest text, words per slide, contrast
// against the real pixels behind the text and again on a washed-out projector, text near the edge, titles that jump
// between slides), the deck on a 1440×900 laptop, and the PDF that gets sent (one 16:9 page per slide? backgrounds
// kept?). It draws a sheet: every slide as presenter thumbnails, each slide on a washed-out projector, the slide with
// the smallest text in a video call on a laptop, and the PDF as an email attachment with all its pages.
// adds: tool. Runs on the user's machine with their Chrome/Edge/Chromium; PDF pages are drawn with print-check.mjs
// (keep it beside this file) and Ghostscript, pdftoppm, mutool or PyMuPDF. Nothing leaves the machine.
//
//   node deck-check.mjs check <deck.html|deck.pdf|deck.pptx> [--pdf deck.pdf] [--out look/deck]
//       → JSON {ok, errors, warnings, slides:[…], pdf:{…}, issues, sheet}. Then LOOK at the sheet.
//         With an HTML deck and no --pdf (and no deck.pdf beside it), the PDF checked is the one Chrome's own
//         "Save as PDF" makes with its defaults (background graphics off), which is what people do.
//   node deck-check.mjs pdf <deck.html> --out deck.pdf
//       → a PDF with one 16:9 page per slide, backgrounds kept, text kept as text; then checks it.
//   PPTX: converted with LibreOffice (soffice) if installed; otherwise export to PDF and check that.
//   node deck-check.mjs linkedin <carousel.pdf|carousel.html> [--post post.md] [--title title.txt|"…"] [--out look/linkedin]
//       → a LinkedIn PDF carousel (document post) as the feed shows it: JSON {ok, pages, shape, per_page, issues, sheet}
//         and <out>-sheet.png: the post in the phone feed (light, dark) with its text cut at "…see more" and the title
//         over page 1, every page at the real phone size, and the desktop feed. LinkedIn's limits are official; the
//         viewer sizes and text thresholds are Palm's measurement and guidance (see LI below).
//
// Thresholds are Palm's guidance, not a published standard (none covers slides): text under 20 px on a 1920-wide
// slide shows under 10 px when a call shows the slide about 960 px wide (error); under 28 px is hard to read from the
// back of a room (warning). Contrast uses WCAG 2.2's ratios (4.5:1 for text, 3:1 for large text, w3.org/TR/WCAG22).
// The projector is Palm's simulation of a washed-out room: every colour c (0–1) shown as 0.69c + 0.195.

import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve, basename, extname, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
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
const launch = () => loadPuppeteer().launch({ executablePath: findChrome(), headless: true, timeout: 90000, protocolTimeout: 120000, args: ['--no-sandbox', '--hide-scrollbars', '--allow-file-access-from-files'] });
const DBG = (...a) => { if (process.env.DECK_DEBUG) console.error('[deck]', ...a); };
const issue = (id, level, msg, extra = {}) => ({ id, level, msg, ...extra });
const PRINT = async () => { try { return await import(pathToFileURL(join(here, 'print-check.mjs')).href); } catch { return null; } };
// Loads a page; a slow web font or tracker doesn't fail the check (it waits up to 45 s, then goes on).
const go = async (page, url) => { try { await page.goto(url, { waitUntil: 'networkidle0', timeout: 45000 }); } catch (e) { if (!/timeout/i.test(String(e))) throw e; } };
const which = (cmd) => { try { execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' }); return true; } catch { return false; } };

export const LIMITS = { errPx: 20, warnPx: 28, words: 70, edgePx: 40, titleJumpPx: 24, contrast: 4.5, contrastLarge: 3, largePx: 48, projector: 3 };

// ---------- in the page: find the slides and measure one ----------
const FIND = () => {
  const sel = 'section, article, .slide, [class*="slide"], [data-slide], .step';
  const all = [...document.querySelectorAll(sel)];
  const shown = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width >= 600 && r.height >= 300 && cs.visibility !== 'hidden' && +cs.opacity > 0.05; };
  const ratioOk = (e) => { const r = e.getBoundingClientRect(); const q = r.width / r.height; return q > 1.25 && q < 2.1; };
  let c = all.filter((e) => shown(e) && ratioOk(e));
  c = c.filter((e) => !c.some((o) => o !== e && o.contains(e)));
  return c.length;
};
const TAG = () => {
  const sel = 'section, article, .slide, [class*="slide"], [data-slide], .step';
  const all = [...document.querySelectorAll(sel)];
  const shown = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width >= 600 && r.height >= 300 && cs.visibility !== 'hidden' && +cs.opacity > 0.05; };
  const ratioOk = (e) => { const r = e.getBoundingClientRect(); const q = r.width / r.height; return q > 1.25 && q < 2.1; };
  let c = all.filter((e) => shown(e) && ratioOk(e));
  c = c.filter((e) => !c.some((o) => o !== e && o.contains(e)));
  c.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top || a.getBoundingClientRect().left - b.getBoundingClientRect().left);
  let n = +(document.body.dataset.palmN || 0);
  return c.map((e) => { if (!e.dataset.palmSlide) e.dataset.palmSlide = String(++n); document.body.dataset.palmN = String(n); return e.dataset.palmSlide; });
};
const MEASURE = (id) => {
  const el = document.querySelector(`[data-palm-slide="${id}"]`);
  const sr = el.getBoundingClientRect();
  const k = 1920 / sr.width; // positions in a 1920-wide slide
  const fk = 1920 / (el.offsetWidth || sr.width); // font px as on a 1920-wide slide (undoes CSS scaling)
  const texts = [];
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node, i = 0;
  while ((node = w.nextNode())) {
    const t = node.textContent.replace(/\s+/g, ' ').trim(); if (!t) continue;
    const p = node.parentElement; if (!p || ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(p.tagName)) continue;
    const cs = getComputedStyle(p); if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    let op = 1; for (let a = p; a && a !== document.body; a = a.parentElement) op *= +getComputedStyle(a).opacity; if (op < 0.05) continue;
    const r = document.createRange(); r.selectNodeContents(node);
    const rects = [...r.getClientRects()].filter((x) => x.width > 0.5 && x.height > 0.5).map((x) => ({ x0: (x.left - sr.left) * k, y0: (x.top - sr.top) * k, x1: (x.right - sr.left) * k, y1: (x.bottom - sr.top) * k }));
    if (!rects.length) continue;
    const b = rects.reduce((a, x) => ({ x0: Math.min(a.x0, x.x0), y0: Math.min(a.y0, x.y0), x1: Math.max(a.x1, x.x1), y1: Math.max(a.y1, x.y1) }), { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 });
    texts.push({ i: i++, t: t.slice(0, 60), words: t.split(' ').filter((x) => /\w/.test(x)).length, px: Math.round(parseFloat(cs.fontSize) * fk * 10) / 10, weight: +cs.fontWeight || 400, color: cs.color, alpha: op, rects, box: b, parent: p });
  }
  // clipped text: a box that hides overflow and has more content than room (or an ellipsis)
  const clipped = [];
  for (const e of el.querySelectorAll('*')) {
    const cs = getComputedStyle(e);
    const hides = /hidden|clip/.test(cs.overflow + cs.overflowX + cs.overflowY) || cs.textOverflow === 'ellipsis' || +cs.webkitLineClamp > 0;
    if (!hides || !e.textContent.trim()) continue;
    if (e.scrollHeight > e.clientHeight + 2 || e.scrollWidth > e.clientWidth + 2) { const r = e.getBoundingClientRect(); clipped.push({ t: e.textContent.replace(/\s+/g, ' ').trim().slice(0, 60), box: { x0: (r.left - sr.left) * k, y0: (r.top - sr.top) * k, x1: (r.right - sr.left) * k, y1: (r.bottom - sr.top) * k } }); }
  }
  // the title: the largest text (ties: the highest)
  const big = texts.slice().sort((a, b) => b.px - a.px || a.box.y0 - b.box.y0)[0];
  const isTitle = (x) => big && x.px >= big.px * 0.95 && Math.abs(x.box.y0 - big.box.y0) < 4;
  const title = big ? { t: big.t, x: Math.round(Math.min(...texts.filter(isTitle).map((x) => x.box.x0))), y: Math.round(big.box.y0), px: big.px } : null;
  return { id, w: sr.width, h: sr.height, k, texts: texts.map(({ parent, ...x }) => ({ ...x, sameParentAs: texts.findIndex((o) => o.parent === parent) })), clipped, title };
};

// WCAG relative luminance and contrast
const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = ([r, g, b]) => 0.2126 * lin(r / 255) + 0.7152 * lin(g / 255) + 0.0722 * lin(b / 255);
export const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
export const projector = (rgb) => rgb.map((c) => Math.round((0.69 * (c / 255) + 0.195) * 255));
const parseRgb = (s) => (s.match(/[\d.]+/g) || [0, 0, 0]).map(Number);

// ---------- check ----------
export async function check(target, { out = 'look/deck', pdf = null, plain = false } = {}) {
  const file = resolve(target);
  if (!existsSync(file)) throw new Error('No such file: ' + target);
  const ext = extname(file).toLowerCase();
  const outDir = resolve(out); mkdirSync(outDir, { recursive: true });
  if (ext === '.pptx' || ext === '.key' || ext === '.odp') {
    if (!which('soffice')) throw new Error(`deck-check can't open ${ext} here (LibreOffice's soffice isn't installed). Export the deck to PDF (File → Export → PDF) and check the PDF.`);
    execFileSync('soffice', ['--headless', '--convert-to', 'pdf', '--outdir', outDir, file], { stdio: 'ignore', timeout: 180000 });
    return check(join(outDir, basename(file, ext) + '.pdf'), { out, plain });
  }
  const issues = [];
  const add = (id, level, msg, extra) => issues.push(issue(id, level, msg, extra));
  const browser = await launch();
  let slides = [], pdfInfo = null, laptop = null, shots = [], pdfPages = [];
  try {
    if (ext === '.pdf') {
      ({ slides, shots } = await fromPdf(file, outDir, add));
      pdfInfo = { file: basename(file), pages: slides.length, made_by: 'given' };
    } else {
      const page = await browser.newPage();
      await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
      const url = pathToFileURL(file).href;
      await go(page, url);
      await page.evaluate(() => document.fonts?.ready);
      await new Promise((r) => setTimeout(r, 300));
      // stacked slides, or one at a time (arrow keys)
      DBG('loaded');
      let ids = await page.evaluate(TAG);
      DBG('tagged', ids);
      const mode = ids.length >= 2 ? 'stacked' : 'keys';
      if (mode === 'keys') {
        const seen = new Set(ids);
        for (let step = 0; step < 60; step++) {
          await page.keyboard.press('ArrowRight'); await new Promise((r) => setTimeout(r, 450));
          const now = await page.evaluate(TAG); const fresh = now.filter((x) => !seen.has(x));
          if (!fresh.length) { await page.keyboard.press('PageDown'); await new Promise((r) => setTimeout(r, 450)); const n2 = (await page.evaluate(TAG)).filter((x) => !seen.has(x)); if (!n2.length) break; n2.forEach((x) => seen.add(x)); ids.push(...n2); continue; }
          fresh.forEach((x) => seen.add(x)); ids.push(...fresh);
        }
        await go(page, url); await new Promise((r) => setTimeout(r, 300));
      }
      if (!ids.length) { add('no-slides', 'error', 'No slides found: make each slide a <section> (or .slide) about 16:9, one after another or shown one at a time with the arrow keys.'); }
      for (let n = 0; n < ids.length; n++) {
        if (mode === 'keys') {
          // reload, then step to slide n (tags are re-made in the same order)
          await go(page, url); await new Promise((r) => setTimeout(r, 300));
          await page.evaluate(TAG);
          for (let s = 0; s < n; s++) { await page.keyboard.press('ArrowRight'); await new Promise((r) => setTimeout(r, 300)); await page.evaluate(TAG); }
          const vis = await page.evaluate(TAG); if (!vis.length) continue;
          ids[n] = vis[vis.length - 1];
        }
        const id = ids[n];
        await page.evaluate((id) => document.querySelector(`[data-palm-slide="${id}"]`).scrollIntoView({ block: 'start' }), id);
        DBG('measure', id);
        const m = await page.evaluate(MEASURE, id);
        DBG('measured', m.texts.length);
        const el = await page.$(`[data-palm-slide="${id}"]`);
        const png = join(outDir, `slide-${String(n + 1).padStart(2, '0')}.png`);
        await el.screenshot({ path: png });
        // the background alone (text made transparent), to measure contrast against the real pixels
        await page.evaluate((id) => { const s = document.createElement('style'); s.id = 'palm-hide'; s.textContent = `[data-palm-slide="${id}"], [data-palm-slide="${id}"] *{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important;-webkit-text-stroke:0!important;text-decoration-color:transparent!important;caret-color:transparent!important}`; document.head.appendChild(s); }, id);
        const bg = Buffer.from(await el.screenshot()).toString('base64');
        await page.evaluate(() => document.getElementById('palm-hide')?.remove());
        DBG('bg shot');
        m.contrast = await page.evaluate(async (texts, bg, k) => {
          const img = await new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => ok(null); i.src = 'data:image/png;base64,' + bg; });
          if (!img) return texts.map(() => []);
          const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; const x = c.getContext('2d'); x.drawImage(img, 0, 0);
          const s = img.naturalWidth / 1920;
          return texts.map((t) => {
            const px = [];
            for (const r of t.rects) { const x0 = Math.max(0, Math.floor(r.x0 * s)), y0 = Math.max(0, Math.floor(r.y0 * s)), w = Math.max(1, Math.min(c.width - x0, Math.ceil((r.x1 - r.x0) * s))), h = Math.max(1, Math.min(c.height - y0, Math.ceil((r.y1 - r.y0) * s))); if (w < 1 || h < 1 || x0 >= c.width || y0 >= c.height) continue; const d = x.getImageData(x0, y0, w, h).data; const step = Math.max(4, Math.floor(d.length / 4 / 400) * 4); for (let q = 0; q < d.length; q += step) px.push([d[q], d[q + 1], d[q + 2]]); }
            return px;
          });
        }, m.texts.map((t) => ({ rects: t.rects })), bg, m.k);
        slides.push({ n: n + 1, ...m, png });
        shots.push(png);
      }
      DBG('slides done');
      // the same deck on a 1440×900 laptop (presenting from the browser)
      DBG('laptop');
      const lp = await browser.newPage();
      await lp.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
      await go(lp, url); await new Promise((r) => setTimeout(r, 300));
      laptop = await lp.evaluate(() => {
        const sel = 'section, article, .slide, [class*="slide"], [data-slide], .step';
        const vis = [...document.querySelectorAll(sel)].filter((e) => { const r = e.getBoundingClientRect(); return r.width >= 400 && r.height >= 200 && getComputedStyle(e).visibility !== 'hidden' && +getComputedStyle(e).opacity > 0.05; });
        const first = vis.filter((e) => !vis.some((o) => o !== e && o.contains(e)))[0];
        const r = first?.getBoundingClientRect();
        return { scrollW: document.scrollingElement.scrollWidth, innerW: innerWidth, innerH: innerHeight, slide: r ? { w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left), top: Math.round(r.top) } : null };
      });
      await lp.screenshot({ path: join(outDir, 'laptop.png') });
      await lp.close();
      DBG('laptop done');
      // the PDF that gets sent
      let pdfFile = pdf ? resolve(pdf) : [join(dirname(file), 'deck.pdf'), file.replace(/\.html?$/i, '.pdf')].find((f) => existsSync(f)) || null;
      let madeBy = 'given';
      if (!pdfFile) {
        const pp = await browser.newPage();
        await go(pp, url); await pp.evaluate(() => document.fonts?.ready);
        pdfFile = join(outDir, 'browser-save-as-pdf.pdf');
        writeFileSync(pdfFile, await pp.pdf({ preferCSSPageSize: true, printBackground: false }));
        await pp.close(); madeBy = 'Chrome "Save as PDF" with its defaults (background graphics off)';
      }
      DBG('pdf made');
      const pc = await PRINT();
      const insp = pc ? pc.inspectPdf(readFileSync(pdfFile)) : null;
      pdfInfo = { file: relative(process.cwd(), pdfFile), made_by: madeBy, pages: insp?.pages.length ?? null, size: insp?.pages[0] ? `${Math.round(insp.pages[0].w)}×${Math.round(insp.pages[0].h)} mm` : null, ratio: insp?.pages[0] ? Math.round((insp.pages[0].w / insp.pages[0].h) * 100) / 100 : null };
      if (pc && insp?.pages.length) {
        const wIn = insp.pages[0].w / 25.4, dpi = Math.max(20, Math.min(150, Math.round(960 / wIn)));
        const r = pc.rasterize(pdfFile, dpi, join(outDir, 'pdf'));
        pdfPages = r.files;
        if (!r.files.length) add('no-renderer', 'warn', 'No PDF renderer found, so the PDF pages aren\'t drawn. Install Ghostscript (brew install ghostscript), poppler (pdftoppm) or PyMuPDF.');
      } else if (!pc) add('no-print-check', 'warn', 'print-check.mjs isn\'t beside deck-check.mjs, so the PDF isn\'t measured. Get it with palm_tool and save it in the same folder.');
      // compare each PDF page with its slide
      if (pdfPages.length && shots.length) {
        const cmp = await browser.newPage();
        pdfInfo.diff = await cmp.evaluate(async (a, b) => {
          const load = (s) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => ok(null); i.src = s; });
          const small = (img) => { const c = document.createElement('canvas'); c.width = 160; c.height = 90; const x = c.getContext('2d'); x.drawImage(img, 0, 0, 160, 90); return x.getImageData(0, 0, 160, 90).data; };
          const out = [];
          for (let i = 0; i < Math.min(a.length, b.length); i++) { const x = await load(a[i]), y = await load(b[i]); if (!x || !y) { out.push(null); continue; } const p = small(x), q = small(y); let s = 0; for (let k = 0; k < p.length; k += 4) s += (Math.abs(p[k] - q[k]) + Math.abs(p[k + 1] - q[k + 1]) + Math.abs(p[k + 2] - q[k + 2])) / 3; out.push(Math.round(s / (p.length / 4))); }
          return out;
        }, shots.map((f) => 'data:image/png;base64,' + readFileSync(f).toString('base64')), pdfPages.map((f) => 'data:image/png;base64,' + readFileSync(f).toString('base64')));
        await cmp.close();
      }
    }
  } finally { await browser.close(); }

  // ---------- judge the measurements ----------
  const per = [];
  for (const s of slides) {
    const marks = [];
    const mk = (id, level, msg, box) => { add(id, level, `slide ${s.n}: ${msg}`, { slide: s.n }); if (box) marks.push({ ...box, level }); };
    const texts = s.texts || [];
    const words = texts.reduce((a, t) => a + t.words, 0);
    const minPx = texts.length ? Math.min(...texts.map((t) => t.px)) : null;
    for (const t of texts) {
      const out = t.box.x0 < -2 || t.box.y0 < -2 || t.box.x1 > 1922 || t.box.y1 > (1920 * s.h / s.w) + 2;
      if (out) mk('overflow', 'error', `"${t.t}" runs off the slide.`, t.box);
      if (t.px < LIMITS.errPx) mk('text-small', 'error', `"${t.t}" is ${t.px} px on a 1920-wide slide: under 10 px when a call shows the slide ~960 px wide.`, t.box);
      else if (t.px < LIMITS.warnPx) mk('text-small', 'warn', `"${t.t}" is ${t.px} px: hard to read from the back of a room (Palm suggests ≥${LIMITS.warnPx} px; 24 pt in PowerPoint = 48 px).`, t.box);
      const edge = Math.min(t.box.x0, t.box.y0, 1920 - t.box.x1, (1920 * s.h / s.w) - t.box.y1);
      if (!out && edge < LIMITS.edgePx && edge > -2) mk('edge', 'warn', `"${t.t}" is ${Math.max(0, Math.round(edge))} px from the edge: projectors and PDF viewers can crop it; keep text ≥${LIMITS.edgePx} px in.`, t.box);
    }
    // colliding text: line boxes of different text overlapping
    const seenPairs = new Set();
    for (let a = 0; a < texts.length; a++) for (let b = a + 1; b < texts.length; b++) {
      if (texts[a].sameParentAs === texts[b].sameParentAs) continue;
      for (const r1 of texts[a].rects) for (const r2 of texts[b].rects) {
        const ix = Math.min(r1.x1, r2.x1) - Math.max(r1.x0, r2.x0), iy = Math.min(r1.y1, r2.y1) - Math.max(r1.y0, r2.y0);
        if (ix <= 0 || iy <= 0) continue;
        const small = Math.min((r1.x1 - r1.x0) * (r1.y1 - r1.y0), (r2.x1 - r2.x0) * (r2.y1 - r2.y0));
        if (ix * iy > 0.3 * small && !seenPairs.has(a + ':' + b)) { seenPairs.add(a + ':' + b); mk('collide', 'error', `"${texts[a].t}" and "${texts[b].t}" overlap.`, { x0: Math.min(r1.x0, r2.x0), y0: Math.min(r1.y0, r2.y0), x1: Math.max(r1.x1, r2.x1), y1: Math.max(r1.y1, r2.y1) }); }
      }
    }
    for (const c of s.clipped || []) mk('clipped', 'error', `text is cut off inside its box: "${c.t}".`, c.box);
    if (words > LIMITS.words) mk('words', 'warn', `${words} words: people read instead of listening (Palm suggests ≤${LIMITS.words}; move detail to the notes or an appendix slide).`);
    // contrast against the real pixels, and on a washed-out projector
    let worst = null, worstProj = null;
    texts.forEach((t, i) => {
      const px = (s.contrast || [])[i] || []; if (!px.length) return;
      const fg0 = parseRgb(t.color); const a = (fg0[3] ?? 1) * (t.alpha ?? 1);
      const lumSorted = px.slice().sort((p, q) => lum(p) - lum(q)); const med = lumSorted[Math.floor(lumSorted.length / 2)];
      const fg = fg0.slice(0, 3).map((c, k) => Math.round(c * a + med[k] * (1 - a)));
      const rs = px.map((p) => ratio(fg, p)).sort((p, q) => p - q); const r20 = rs[Math.floor(rs.length * 0.2)];
      const rp = px.map((p) => ratio(projector(fg), projector(p))).sort((p, q) => p - q)[Math.floor(px.length * 0.2)];
      const large = t.px >= LIMITS.largePx || (t.px >= 37 && t.weight >= 700);
      const need = large ? LIMITS.contrastLarge : LIMITS.contrast;
      if (r20 < need) mk('contrast', r20 < 3 ? 'error' : 'warn', `"${t.t}" has contrast ${r20.toFixed(1)}:1 against what's behind it (WCAG asks ${need}:1 for ${large ? 'large ' : ''}text).`, t.box);
      else if (rp < LIMITS.projector) mk('projector', 'warn', `"${t.t}" drops to ${rp.toFixed(1)}:1 on a washed-out projector (Palm's simulation); darker text or a darker background holds up.`, t.box);
      if (!worst || r20 < worst.r) worst = { r: Math.round(r20 * 10) / 10, t: t.t };
      if (!worstProj || rp < worstProj.r) worstProj = { r: Math.round(rp * 10) / 10, t: t.t };
    });
    if (Math.abs(s.w / s.h - 16 / 9) > 0.06) mk('ratio', 'warn', `the slide is ${Math.round(s.w)}×${Math.round(s.h)} (${(s.w / s.h).toFixed(2)}:1), not 16:9: projectors and calls show it with bars.`);
    per.push({ n: s.n, words, min_px: minPx, title: s.title, contrast_min: worst, projector_min: worstProj, marks, png: s.png });
  }
  // titles that jump between slides (content slides: skip the first and last, which are often different on purpose)
  const mids = per.slice(1, -1).filter((p) => p.title);
  if (mids.length >= 3) {
    const mode = (a) => { const m = new Map(); a.forEach((x) => m.set(Math.round(x / 8) * 8, (m.get(Math.round(x / 8) * 8) || 0) + 1)); return [...m].sort((p, q) => q[1] - p[1])[0][0]; };
    const mx = mode(mids.map((p) => p.title.x)), my = mode(mids.map((p) => p.title.y));
    const jumps = mids.filter((p) => Math.abs(p.title.x - mx) > LIMITS.titleJumpPx || Math.abs(p.title.y - my) > LIMITS.titleJumpPx * 2);
    if (jumps.length && jumps.length <= mids.length / 2) add('title-jump', 'warn', `titles move on slides ${jumps.map((p) => p.n).join(', ')} (most titles sit at x≈${mx}, y≈${my}): the title jumps when you click to those slides.`);
  }
  // laptop
  if (laptop) {
    if (laptop.scrollW > laptop.innerW + 2) add('laptop-cut', 'error', `on a 1440×900 laptop the deck is ${laptop.scrollW} px wide: it scrolls sideways and the slide's right side is cut off when you present.`);
    else if (laptop.slide && (laptop.slide.h > laptop.innerH + 2 || laptop.slide.w > laptop.innerW + 2)) add('laptop-cut', 'error', `on a 1440×900 laptop a slide is ${laptop.slide.w}×${laptop.slide.h}: it doesn't fit the screen, so its bottom or side is cut off when you present. Size slides to the window (e.g. 100vw × 56.25vw, text in vw) or scale them.`);
  }
  // the PDF
  if (pdfInfo && slides.length && ext !== '.pdf') {
    if (pdfInfo.pages != null && pdfInfo.pages !== slides.length) add('pdf-pages', 'error', `the PDF (${pdfInfo.made_by}) has ${pdfInfo.pages} pages for ${slides.length} slides: slides are split or merged across pages. Give the print a 16:9 page per slide (@page{size:...} and break-after:page), or make the PDF with deck-check's pdf command.`);
    if (pdfInfo.ratio && Math.abs(pdfInfo.ratio - 16 / 9) > 0.06) add('pdf-ratio', 'error', `the PDF's pages are ${pdfInfo.size} (${pdfInfo.ratio}:1), not 16:9: the slides won't fill the page or will be cut.`);
    const bad = (pdfInfo.diff || []).map((d, i) => [d, i + 1]).filter(([d]) => d != null && d > 45);
    if (bad.length) add('pdf-differs', 'error', `PDF page${bad.length > 1 ? 's' : ''} ${bad.map(([, i]) => i).join(', ')} look${bad.length > 1 ? '' : 's'} different from the slide (backgrounds dropped, colours lost or the slide moved). In print CSS keep backgrounds (print-color-adjust: exact) and one slide per page.`, { pages: bad.map(([, i]) => i) });
  }
  // ---------- the sheet ----------
  const sheet = join(outDir, 'deck-sheet.png');
  try { await drawSheet({ per, pdfPages, laptop: laptop ? join(outDir, 'laptop.png') : null, pdfInfo, plain }, sheet); } catch (e) { add('sheet', 'warn', 'The sheet could not be drawn: ' + String(e.message || e).slice(0, 120)); }
  const errors = issues.filter((i) => i.level === 'error').length, warnings = issues.filter((i) => i.level === 'warn').length;
  return { ok: errors === 0 && slides.length > 0, errors, warnings, slides: per.map(({ marks, png, ...p }) => ({ ...p, png: relative(process.cwd(), png) })), pdf: pdfInfo, laptop, issues, sheet: existsSync(sheet) ? sheet : null };
}

// A PDF deck: each page is a slide; text sizes from the PDF itself (no contrast: the colours behind text aren't known).
async function fromPdf(file, outDir, add) {
  const pc = await PRINT(); if (!pc) throw new Error('print-check.mjs must be beside deck-check.mjs to read a PDF (get it with palm_tool).');
  const insp = pc.inspectPdf(readFileSync(file));
  const wIn = insp.pages[0].w / 25.4; const dpi = Math.max(20, Math.min(200, Math.round(1920 / wIn)));
  const r = pc.rasterize(file, dpi, join(outDir, 'pages'));
  if (!r.files.length) add('no-renderer', 'warn', 'No PDF renderer found, so the pages aren\'t drawn. Install Ghostscript (brew install ghostscript), poppler (pdftoppm) or PyMuPDF.');
  const slides = insp.pages.map((p, i) => {
    const k = 1920 / p.w; // px per mm on a 1920-wide slide
    const texts = p.text.map((t, j) => ({ i: j, t: t.font || 'text', words: 0, px: Math.round(t.size * (25.4 / 72) * k * 10) / 10, weight: 400, color: 'rgb(0,0,0)', rects: [], box: { x0: t.x0 * k, y0: t.y0 * k, x1: t.x1 * k, y1: t.y1 * k }, sameParentAs: j }));
    return { n: i + 1, id: String(i + 1), w: p.w, h: p.h, k, texts, clipped: [], title: null, png: r.files[i] || null };
  });
  return { slides, shots: r.files };
}

async function drawSheet({ per, pdfPages, laptop, pdfInfo, plain }, outFile) {
  const browser = await launch();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1500, height: 1000, deviceScaleFactor: 1 });
    const src = (f) => f && existsSync(f) ? 'data:image/png;base64,' + readFileSync(f).toString('base64') : '';
    const slides = per.map((p) => ({ n: p.n, src: src(p.png), marks: plain ? [] : p.marks, minPx: p.min_px, words: p.words }));
    const worst = per.slice().filter((p) => p.min_px != null).sort((a, b) => a.min_px - b.min_px)[0] || per[1] || per[0];
    const pages = pdfPages.map(src);
    const html = `<!doctype html><html><head><style>
      body{margin:0;font:14px/1.35 -apple-system,system-ui,sans-serif;background:#ecebe8;color:#111;width:1500px}
      .sec{padding:22px 28px;background:#fff;margin-bottom:10px}
      h2{font-size:13px;letter-spacing:.05em;text-transform:uppercase;color:#555;margin:0 0 12px}
      .grid{display:grid;gap:14px}.lab{font-size:12px;color:#555;margin-top:4px}
      .sl{position:relative;background:#ddd;box-shadow:0 1px 3px rgba(0,0,0,.3);overflow:hidden}.sl img{display:block;width:100%;height:100%;object-fit:contain}
      .mk{position:absolute;border:2px solid #e0245e;background:rgba(224,36,94,.08)}.mk.warn{border-color:#f08c00;background:rgba(240,140,0,.06)}
      .proj{background:#2a2a2e;padding:16px;border-radius:4px}.proj .sl{filter:contrast(.75) brightness(1.02)}.proj .sl:after{content:"";position:absolute;inset:0;background:rgba(255,255,240,.08)}
      .laptop{width:1280px;height:800px;background:#1f1f22;border-radius:12px;position:relative;margin:0 auto;box-shadow:0 0 0 14px #3a3a3e}
      .call{position:absolute;left:24px;top:46px;width:946px;height:532px}.tiles{position:absolute;right:24px;top:46px;width:262px;display:grid;gap:10px}
      .tiles div{height:147px;border-radius:8px;background:linear-gradient(135deg,#4a5568,#2d3748)}.bar{position:absolute;left:0;right:0;bottom:0;height:62px;background:#141416;border-radius:0 0 12px 12px}
      .mail{width:640px;background:#fff;border:1px solid #ddd;border-radius:8px;padding:18px}.att{display:flex;gap:14px;align-items:center;border:1px solid #ddd;border-radius:8px;padding:10px;width:420px}
      .att .sl{width:200px;height:113px}.pg{display:flex;gap:8px;flex-wrap:wrap}.pg img{height:90px;box-shadow:0 1px 3px rgba(0,0,0,.3);background:#fff}
    </style></head><body>
      <div class="sec"><h2>Every slide, as the presenter sees the deck (${slides.length} slides)</h2><div class="grid" style="grid-template-columns:repeat(4,345px)">
        ${slides.map((s) => `<div><div class="sl" style="width:345px;height:194px">${s.src ? `<img src="${s.src}">` : ''}${s.marks.map((m) => `<div class="mk ${m.level === 'warn' ? 'warn' : ''}" style="left:${m.x0 / 1920 * 100}%;top:${m.y0 / 1080 * 100}%;width:${(m.x1 - m.x0) / 1920 * 100}%;height:${(m.y1 - m.y0) / 1080 * 100}%"></div>`).join('')}</div><div class="lab">${s.n}${plain ? '' : ` · ${s.words} words · smallest ${s.minPx ?? '–'} px`}</div></div>`).join('')}
      </div></div>
      <div class="sec proj"><h2 style="color:#bbb">On a projector at the back of the room (washed out: Palm's simulation)</h2><div class="grid" style="grid-template-columns:repeat(2,700px)">
        ${slides.map((s) => `<div class="sl" style="width:700px;height:394px">${s.src ? `<img src="${s.src}">` : ''}</div>`).join('')}
      </div></div>
      ${worst ? `<div class="sec"><h2>Shared in a video call on a laptop (slide ${worst.n}${plain ? '' : ', the smallest text'}), at the size it shows</h2>
        <div class="laptop"><div class="call sl"><img src="${src(worst.png)}"></div><div class="tiles"><div></div><div></div><div></div></div><div class="bar"></div></div></div>` : ''}
      ${laptop ? `<div class="sec"><h2>Presented from the browser on a 1440×900 laptop (what the screen shows)</h2><img src="${src(laptop)}" style="width:960px;box-shadow:0 1px 4px rgba(0,0,0,.3)"></div>` : ''}
      ${pdfInfo ? `<div class="sec"><h2>Sent as a PDF${plain ? '' : ` (${pdfInfo.made_by})`}: the attachment, then every page</h2>
        <div class="mail"><div style="font-weight:600;margin-bottom:10px">Our seed round deck</div><div class="att"><div class="sl">${pages[0] ? `<img src="${pages[0]}">` : ''}</div><div><div style="font-weight:600">${basename(pdfInfo.file || 'deck.pdf')}</div><div class="lab">${pdfInfo.pages ?? '?'} pages · PDF</div></div></div></div>
        <div class="pg" style="margin-top:16px">${pages.map((p) => `<img src="${p}">`).join('')}</div></div>` : ''}
    </body></html>`;
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => Promise.all([...document.images].map((i) => i.complete ? 0 : new Promise((r) => { i.onload = r; i.onerror = r; }))));
    await page.screenshot({ path: outFile, fullPage: true });
  } finally { await browser.close(); }
}

// ---------- pdf: one 16:9 page per slide, backgrounds kept ----------
export async function makePdf(target, { out = 'deck.pdf' } = {}) {
  const file = resolve(target), o = resolve(out); mkdirSync(dirname(o), { recursive: true });
  const browser = await launch();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    const url = pathToFileURL(file).href;
    await go(page, url); await page.evaluate(() => document.fonts?.ready);
    let ids = await page.evaluate(TAG);
    if (ids.length < 2) { // one slide at a time: walk with the arrow keys, then show them all, stacked
      const seen = new Set(ids);
      for (let s = 0; s < 60; s++) { await page.keyboard.press('ArrowRight'); await new Promise((r) => setTimeout(r, 400)); const f = (await page.evaluate(TAG)).filter((x) => !seen.has(x)); if (!f.length) break; f.forEach((x) => seen.add(x)); }
      ids = [...seen];
    }
    await page.emulateMediaType('screen');
    const w = await page.evaluate((ids) => {
      const els = ids.map((id) => document.querySelector(`[data-palm-slide="${id}"]`)).filter(Boolean);
      const W = els[0]?.offsetWidth || 1920, H = els[0]?.offsetHeight || 1080;
      const s = document.createElement('style');
      s.textContent = `html,body{margin:0!important;padding:0!important;background:none!important;overflow:visible!important;height:auto!important}
        body > *:not([data-palm-keep]){display:none!important}
        [data-palm-slide]{display:block!important;position:relative!important;left:auto!important;top:auto!important;transform:none!important;opacity:1!important;visibility:visible!important;margin:0!important;width:${W}px!important;height:${H}px!important;break-after:page;break-inside:avoid;overflow:hidden!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}`;
      document.head.appendChild(s);
      // keep each slide's ancestors visible
      for (const e of els) for (let a = e; a && a !== document.body; a = a.parentElement) a.setAttribute('data-palm-keep', '');
      for (const e of els) for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) { a.style.setProperty('display', 'block', 'important'); a.style.setProperty('transform', 'none', 'important'); a.style.setProperty('position', 'static', 'important'); a.style.setProperty('height', 'auto', 'important'); a.style.setProperty('overflow', 'visible', 'important'); }
      return { W, H };
    }, ids);
    writeFileSync(o, await page.pdf({ width: `${w.W}px`, height: `${w.H}px`, printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 }, preferCSSPageSize: false }));
  } finally { await browser.close(); }
  const r = await check(file, { pdf: o, out: join(dirname(o), 'look', basename(o, '.pdf')) });
  return { pdf: o, ...r };
}

// ---------- linkedin: a PDF carousel ("document post") as LinkedIn's feed shows it ----------
// Official (LinkedIn Help, read 2026-11-24): documents up to 100 MB and 300 pages; PPT, PPTX, DOC, DOCX or PDF (PDF
// recommended); "PDFs with multiple sized pages must be fit to the same page size"; add a title; hyperlinks must be
// secure; animations show as still images; posts up to 3,000 characters (linkedin.com/help/linkedin/answer/a518909,
// a528176). Palm's measurement, not LinkedIn's: the document viewer is about 390 px wide on a phone and 555 px in the
// desktop feed, and the post text shows about 3 lines before "…see more". Text-size thresholds are Palm's guidance.
export const LI = { maxMB: 100, maxPages: 300, postMax: 3000, phoneW: 390, deskW: 555, errPx: 9, warnPx: 12, hookPx: 22, words: 45 };
async function htmlToPdf(file, out) {
  const browser = await launch();
  try {
    const page = await browser.newPage(); await page.setViewport({ width: 1080, height: 1350, deviceScaleFactor: 1 });
    await go(page, pathToFileURL(resolve(file)).href); await page.evaluate(() => document.fonts?.ready);
    const ids = await page.evaluate(TAG);
    const sz = await page.evaluate((ids) => { const e = document.querySelector(`[data-palm-slide="${ids[0]}"]`); return e ? { W: e.offsetWidth, H: e.offsetHeight } : { W: 1080, H: 1350 }; }, ids);
    await page.addStyleTag({ content: `@page{size:${sz.W}px ${sz.H}px;margin:0}html,body{margin:0!important}[data-palm-slide]{break-after:page;break-inside:avoid;-webkit-print-color-adjust:exact;print-color-adjust:exact}` });
    writeFileSync(out, await page.pdf({ width: `${sz.W}px`, height: `${sz.H}px`, printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } }));
  } finally { await browser.close(); }
  return out;
}
export async function linkedin(target, { post = null, title = null, out = 'look/linkedin', plain = false } = {}) {
  const pc = await PRINT(); if (!pc) throw new Error('print-check.mjs must be beside deck-check.mjs (get it with palm_tool).');
  const outFile = resolve(out); mkdirSync(dirname(outFile), { recursive: true });
  let pdf = resolve(target);
  if (/\.html?$/i.test(pdf)) pdf = await htmlToPdf(pdf, outFile + '.pdf');
  const buf = readFileSync(pdf), mb = buf.length / 1048576;
  const insp = pc.inspectPdf(buf);
  const issues = []; const add = (id, level, msg, extra) => issues.push(issue(id, level, msg, extra));
  const postText = post && existsSync(post) ? readFileSync(post, 'utf8').trim() : (post || '');
  const titleText = title && existsSync(title) ? readFileSync(title, 'utf8').trim() : (title || '');
  const P = insp.pages;
  if (!P.length) throw new Error('No pages in ' + pdf);
  if (mb > LI.maxMB) add('li-file-big', 'error', `The file is ${mb.toFixed(1)} MB; LinkedIn takes documents up to 100 MB.`);
  if (P.length > LI.maxPages) add('li-pages', 'error', `${P.length} pages; LinkedIn takes up to 300.`);
  const same = P.every((p) => Math.abs(p.w - P[0].w) < 1 && Math.abs(p.h - P[0].h) < 1);
  if (!same) add('li-mixed-sizes', 'error', 'Pages are different sizes. LinkedIn says pages must be fit to the same size; mixed pages jump in the viewer.');
  const r0 = P[0].w / P[0].h;
  const shape = Math.abs(r0 - 1) < 0.03 ? '1:1' : Math.abs(r0 - 0.8) < 0.03 ? '4:5' : Math.abs(r0 - 16 / 9) < 0.04 ? '16:9' : `${P[0].w.toFixed(0)}×${P[0].h.toFixed(0)} mm`;
  if (r0 > 1.05) add('li-landscape', 'warn', `Pages are landscape (${shape}). In the phone feed a landscape page is about ${Math.round(LI.phoneW / r0)} px tall, so everything on it is small; square (1:1) or portrait (4:5) fills the screen (Palm's measurement).`);
  if (/\/URI\s*\(\s*http:/.test(buf.toString('latin1'))) add('li-insecure-link', 'warn', 'The PDF has an http:// link; LinkedIn asks for secure (https) links.');
  const pages = P.map((p, i) => {
    const k = LI.phoneW / p.w; // css px per mm on a phone
    const px = p.text.map((t) => Math.round(t.size * (25.4 / 72) * k * 10) / 10);
    const chars = p.text.reduce((a, t) => a + (t.n || 0), 0);
    return { n: i + 1, w_mm: Math.round(p.w), h_mm: Math.round(p.h), min_px: px.length ? Math.min(...px) : null, max_px: px.length ? Math.max(...px) : null, words_est: Math.round(chars / 6), text_runs: p.text.length };
  });
  for (const pg of pages) {
    if (pg.min_px == null) { if (pg.n === 1) add('li-no-text', 'warn', 'Page 1 has no real text (an image of text?), so sizes can\'t be measured; LinkedIn shows it as the cover.', { page: 1 }); continue; }
    if (pg.min_px < LI.errPx) add('li-text-small', 'error', `Page ${pg.n}: the smallest text is ${pg.min_px} px on a phone (the viewer is about ${LI.phoneW} px wide). Under ${LI.errPx} px can't be read without zooming, which the viewer doesn't allow.`, { page: pg.n });
    else if (pg.min_px < LI.warnPx) add('li-text-small', 'warn', `Page ${pg.n}: the smallest text is ${pg.min_px} px on a phone; under ${LI.warnPx} px is a strain to read while scrolling.`, { page: pg.n });
    if (pg.words_est > LI.words) add('li-words', 'warn', `Page ${pg.n}: about ${pg.words_est} words (estimated from the PDF). People swipe in a second or two per page; over ~${LI.words} words they skip it (Palm's guidance).`, { page: pg.n });
  }
  if (pages[0].max_px != null && pages[0].max_px < LI.hookPx) add('li-hook-small', 'warn', `Page 1 is the only page most people see; its biggest text is ${pages[0].max_px} px on a phone. Make the hook at least ${LI.hookPx} px there.`, { page: 1 });
  if (!titleText) add('li-no-title', 'warn', 'No document title. LinkedIn asks for one and shows it on the document in the feed (pass --title "…" or a title.txt).');
  if (postText.length > LI.postMax) add('li-post-long', 'error', `The post text is ${postText.length} characters; LinkedIn posts take up to 3,000.`);
  if (!postText) add('li-no-post', 'warn', 'No post text given (pass --post post.md). The text above the document is what makes people open it.');
  // draw the pages
  const dpi = Math.max(30, Math.min(300, Math.round(780 / (P[0].w / 25.4))));
  const r = pc.rasterize(pdf, dpi, outFile + '-pages');
  if (!r.files.length) add('no-renderer', 'warn', 'No PDF renderer found, so the pages aren\'t drawn. Install Ghostscript (brew install ghostscript), poppler (pdftoppm) or PyMuPDF.');
  const sheet = outFile + '-sheet.png';
  if (r.files.length) await drawLinkedIn({ files: r.files, pages, postText, titleText, ratio: P[0].h / P[0].w, plain }, sheet);
  const errors = issues.filter((i) => i.level === 'error').length, warnings = issues.filter((i) => i.level === 'warn').length;
  return { ok: errors === 0, errors, warnings, file: pdf, size_mb: Math.round(mb * 100) / 100, pages: pages.length, shape, same_size: same, post_chars: postText.length, title: titleText || null, per_page: pages, issues, sheet: existsSync(sheet) ? sheet : null };
}
async function drawLinkedIn({ files, pages, postText, titleText, ratio, plain }, outFile) {
  const browser = await launch();
  try {
    const page = await browser.newPage(); await page.setViewport({ width: 1500, height: 1000, deviceScaleFactor: 1 });
    const src = (f) => 'data:image/png;base64,' + readFileSync(f).toString('base64');
    const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const card = (w, dark, n) => `<div class="card ${dark ? 'dk' : ''}" style="width:${w}px">
      <div class="hd"><div class="av"></div><div><b>Priya Raman</b><div class="sub">Co-founder · 2h · 🌐</div></div></div>
      <div class="txt" data-full="${esc(postText || '').replace(/"/g, '&quot;')}"></div>
      <div class="doc"><div class="tb">${esc(titleText || 'Untitled document')} · ${pages.length} pages</div>
        <div class="pv" style="height:${Math.round(w * Math.min(ratio, 1.25))}px"><img src="${src(files[n])}"></div></div>
      <div class="act"><span>👍 Like</span><span>💬 Comment</span><span>↻ Repost</span><span>➤ Send</span></div></div>`;
    const html = `<!doctype html><html><head><style>
      body{margin:0;font:14px/1.4 -apple-system,system-ui,sans-serif;background:#ecebe8;color:#111;width:1500px}
      .sec{padding:22px 28px;background:#fff;margin-bottom:10px}.sec.dkbg{background:#000}
      h2{font-size:13px;letter-spacing:.05em;text-transform:uppercase;color:#555;margin:0 0 12px}.dkbg h2{color:#999}
      .row{display:flex;gap:24px;align-items:flex-start;flex-wrap:wrap}.lab{font-size:12px;color:#555;margin-top:4px}
      .card{background:#fff;border:1px solid #ddd;border-radius:8px;overflow:hidden;color:#191919}.card.dk{background:#1b1f23;border-color:#333;color:#e9e9e9}
      .hd{display:flex;gap:8px;padding:12px;align-items:center}.av{width:40px;height:40px;border-radius:50%;background:#9aa7b4}.sub{font-size:12px;opacity:.65}
      .txt{padding:0 12px;margin-bottom:10px;line-height:1.4;white-space:pre-wrap;overflow-wrap:anywhere}.txt .more{opacity:.65;font-weight:600}
      .doc{position:relative}.tb{position:absolute;left:0;right:0;top:0;z-index:2;background:rgba(0,0,0,.72);color:#fff;font-size:13px;padding:7px 10px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .pv{position:relative;overflow:hidden;background:#f3f2ef;display:flex;align-items:center;justify-content:center}.dk .pv{background:#000}
      .pv img{width:100%;display:block}.pn{position:absolute;right:8px;bottom:8px;background:rgba(0,0,0,.7);color:#fff;font-size:12px;border-radius:10px;padding:2px 8px}
      .nx{position:absolute;right:6px;top:50%;margin-top:-16px;width:32px;height:32px;border-radius:50%;background:rgba(0,0,0,.55);color:#fff;font-size:22px;text-align:center;line-height:30px}
      .act{display:flex;justify-content:space-around;padding:10px 4px;font-size:13px;opacity:.75;border-top:1px solid rgba(128,128,128,.25)}
      .pg{width:390px}.pg img{width:390px;display:block;box-shadow:0 1px 3px rgba(0,0,0,.3)}
    </style></head><body>
      <div class="sec"><h2>In the phone feed (light): what people see before they swipe${plain ? '' : ` · post text cut after about 3 lines, title bar over the first page (Palm's measurement)`}</h2><div class="row">${card(LI.phoneW, false, 0)}</div></div>
      <div class="sec dkbg"><h2>In the phone feed (dark mode)</h2><div class="row">${card(LI.phoneW, true, 0)}</div></div>
      <div class="sec"><h2>Every page as it's swiped on a phone (${pages.length} pages, shown ${LI.phoneW} px wide, the real size)</h2><div class="row">
        ${files.map((f, i) => `<div class="pg"><img src="${src(f)}"><div class="lab">${i + 1}${plain ? '' : ` · smallest ${pages[i]?.min_px ?? '–'} px · ~${pages[i]?.words_est ?? '?'} words`}</div></div>`).join('')}</div></div>
      <div class="sec"><h2>In the desktop feed (${LI.deskW} px)</h2><div class="row">${card(LI.deskW, false, 0)}</div></div>
    </body></html>`;
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => Promise.all([...document.images].map((i) => i.complete ? 0 : new Promise((r) => { i.onload = r; i.onerror = r; }))));
    // "…see more": keep as much of the text as fits in 3 lines, then "… see more" inline (Palm's measurement of the feed)
    await page.evaluate(() => {
      for (const t of document.querySelectorAll('.txt')) {
        const full = t.dataset.full || '', lh = parseFloat(getComputedStyle(t).lineHeight) || 20, max = lh * 3 + 2;
        const set = (n) => { t.textContent = full.slice(0, n).replace(/\s+$/, ''); if (n < full.length) { t.append('… '); const m = document.createElement('span'); m.className = 'more'; m.textContent = 'see more'; t.append(m); } };
        set(full.length); if (t.scrollHeight <= max) continue;
        let lo = 0, hi = full.length; while (lo < hi) { const mid = (lo + hi + 1) >> 1; set(mid); if (t.scrollHeight <= max) lo = mid; else hi = mid - 1; }
        set(lo);
      }
    });
    await page.screenshot({ path: outFile, fullPage: true });
  } finally { await browser.close(); }
}

// ---------- self-test ----------
async function selfTest() {
  const d = mkdtempSync(join(tmpdir(), 'deck-test-'));
  // bad: fixed 1920×1080 slides (cut on a laptop), tiny text, grey on white, overflowing text, no print CSS
  writeFileSync(join(d, 'bad.html'), `<html><head><style>body{margin:0;font-family:Helvetica}section{width:1920px;height:1080px;position:relative;overflow:hidden;background:#fff;color:#111}h1{position:absolute;left:120px;top:100px;font-size:80px;margin:0}</style></head><body>
    <section style="background:#0d2b45;color:#fff"><h1>Seed round</h1></section>
    <section><h1>Problem</h1><p style="position:absolute;left:120px;top:300px;font-size:14px;margin:0">tiny footnote text nobody can read</p><p style="position:absolute;left:120px;top:400px;font-size:40px;color:#bbb;margin:0">pale grey claim</p></section>
    <section><h1 style="left:400px">Market</h1><p style="position:absolute;left:1500px;top:500px;font-size:60px;margin:0;white-space:nowrap">a line that runs off the right edge</p></section>
    <section><h1>Team</h1><div style="position:absolute;left:120px;top:300px;width:400px;height:60px;overflow:hidden;font-size:40px">a long paragraph that does not fit in its little box at all</div></section>
    <section style="background:#0d2b45;color:#fff"><h1>Thanks</h1></section></body></html>`);
  DBG('test: bad');
  const bad = await check(join(d, 'bad.html'), { out: join(d, 'look/bad') });
  const ids = new Set(bad.issues.map((i) => i.id));
  for (const want of ['text-small', 'contrast', 'overflow', 'clipped', 'laptop-cut', 'pdf-pages', 'pdf-differs']) if (!ids.has(want)) throw new Error(`bad deck: expected ${want}, got ${[...ids].join(',')}`);
  if (bad.slides.length !== 5) throw new Error('bad deck: expected 5 slides, got ' + bad.slides.length);
  // good: slides sized to the window, text in vw, print CSS with one 16:9 page per slide and backgrounds kept
  writeFileSync(join(d, 'good.html'), `<html><head><style>@page{size:1280px 720px;margin:0}html,body{margin:0}body{font-family:Helvetica;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    section{width:100vw;height:56.25vw;position:relative;overflow:hidden;background:#0d2b45;color:#fff;break-after:page}
    h1{position:absolute;left:6vw;top:5vw;font-size:4.2vw;margin:0}p{position:absolute;left:6vw;top:14vw;font-size:2vw;margin:0;width:70vw}
    @media print{section{width:1280px;height:720px}h1{font-size:54px;left:77px;top:64px}p{font-size:26px;left:77px;top:180px;width:900px}}</style></head><body>
    <section><h1>Fernbank</h1><p>Seed round, 2026</p></section><section><h1>Problem</h1><p>Small farms lose a fifth of their crop to late frost.</p></section>
    <section><h1>Solution</h1><p>A $40 sensor that texts before the frost.</p></section><section><h1>Thanks</h1><p>hello@fernbank.example</p></section></body></html>`);
  DBG('test: good');
  const good = await check(join(d, 'good.html'), { out: join(d, 'look/good') });
  if (good.errors) throw new Error('good deck flagged: ' + good.issues.filter((i) => i.level === 'error').map((i) => i.id + ' ' + i.msg).join(' | '));
  if (good.pdf.pages !== 4) throw new Error('good deck: PDF pages ' + good.pdf.pages);
  // pdf command on the bad deck: one 16:9 page per slide, backgrounds kept
  DBG('test: makePdf');
  const made = await makePdf(join(d, 'bad.html'), { out: join(d, 'bad.pdf') });
  if (made.pdf && (made.pdf.pages !== 5 || Math.abs(made.pdf.ratio - 1.78) > 0.03)) throw new Error('pdf command: ' + JSON.stringify(made.pdf));
  if (made.issues.some((i) => i.id === 'pdf-pages' || i.id === 'pdf-differs' || i.id === 'pdf-ratio')) throw new Error('pdf command output flagged: ' + made.issues.filter((i) => /^pdf/.test(i.id)).map((i) => i.msg).join(' | '));
  if (!existsSync(good.sheet)) throw new Error('no sheet');
  // contrast maths
  if (Math.abs(ratio([0, 0, 0], [255, 255, 255]) - 21) > 0.01) throw new Error('ratio');
  if (!(ratio(projector([0, 0, 0]), projector([255, 255, 255])) < 21)) throw new Error('projector');
  // linkedin: a landscape carousel with tiny text, no title and an over-long post; then a clean 4:5 one
  DBG('test: linkedin');
  writeFileSync(join(d, 'li-bad.html'), `<html><head><style>body{margin:0;font-family:Helvetica}section{width:1920px;height:1080px;position:relative;background:#fff;color:#111;overflow:hidden}h1{font-size:60px;margin:80px}p{font-size:22px;margin:0 80px}</style></head><body>
    <section><h1>Q3 update</h1><p>${'a lot of small words on one slide '.repeat(12)}</p></section><section><h1>Numbers</h1><p>tiny footnote</p></section><section><h1>Thanks</h1></section></body></html>`);
  const lb = await linkedin(join(d, 'li-bad.html'), { post: 'x'.repeat(3100), out: join(d, 'look/li-bad') });
  const lids = new Set(lb.issues.map((i) => i.id));
  for (const want of ['li-landscape', 'li-text-small', 'li-no-title', 'li-post-long', 'li-words']) if (!lids.has(want)) throw new Error(`linkedin bad: expected ${want}, got ${[...lids].join(',')}`);
  if (lb.pages !== 3) throw new Error('linkedin bad: pages ' + lb.pages);
  writeFileSync(join(d, 'li-good.html'), `<html><head><style>body{margin:0;font-family:Helvetica}section{width:1080px;height:1350px;position:relative;background:#14213D;color:#F7F5F0;overflow:hidden}h1{font-size:110px;line-height:1.05;margin:120px 90px 40px}p{font-size:48px;line-height:1.3;margin:0 90px}</style></head><body>
    <section><h1>Month-end close takes 7.5 days.</h1><p>Data entry is only 11% of it.</p></section><section><h1>38% is waiting.</h1><p>For receipts, contracts and approvals.</p></section>
    <section><h1>Chase on the 25th.</h1><p>Every missing item, a name and a date.</p></section></body></html>`);
  const lg = await linkedin(join(d, 'li-good.html'), { post: 'We timed 41 month-end closes. The slow part isn\'t data entry.', title: 'Where month-end close time goes', out: join(d, 'look/li-good') });
  if (lg.errors || lg.warnings) throw new Error('linkedin good flagged: ' + lg.issues.map((i) => i.id + ' ' + i.msg).join(' | '));
  if (lg.shape !== '4:5' || !existsSync(lg.sheet)) throw new Error('linkedin good: shape ' + lg.shape + ' sheet ' + lg.sheet);
  console.log(`deck-check: all tests pass (bad: ${[...ids].join(',')}; good: ${good.slides.length} slides, PDF ${good.pdf.pages} pages ${good.pdf.size}; pdf command: ${made.pdf.pages} pages ${made.pdf.size}; sheet ${good.sheet}; linkedin bad: ${[...lids].join(',')}, good sheet ${lg.sheet})`);
}

if (typeof process !== 'undefined' && process.argv?.[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
  const VALUED = new Set(['--out', '--pdf', '--post', '--title']);
  const pos = argv.filter((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1]));
  const done = (r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); };
  const fail = (e) => { console.error(String(e.message || e)); process.exit(2); };
  if (argv.includes('--test')) selfTest().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
  else if (pos[0] === 'check' && pos[1]) check(pos[1], { out: opt('out', 'look/deck'), pdf: opt('pdf') }).then(done, fail);
  else if (pos[0] === 'pdf' && pos[1]) makePdf(pos[1], { out: opt('out', 'deck.pdf') }).then(done, fail);
  else if (pos[0] === 'linkedin' && pos[1]) linkedin(pos[1], { post: opt('post'), title: opt('title'), out: opt('out', 'look/linkedin') }).then(done, fail);
  else fail('usage: deck-check.mjs check <deck.html|deck.pdf|deck.pptx> [--pdf deck.pdf] [--out look/deck]\n       deck-check.mjs pdf <deck.html> --out deck.pdf\n       deck-check.mjs linkedin <carousel.pdf|carousel.html> [--post post.md] [--title "…"|title.txt] [--out look/linkedin]');
}
