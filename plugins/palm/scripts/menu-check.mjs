#!/usr/bin/env node
// Palm tool: menu-check — lets an agent see a restaurant or café menu the way guests meet it: the printed page at arm's
// length in daylight and in a dim dining room, the phone page the table's QR code opens (390 px, light and dark), and the
// QR code itself as a phone camera sees it from the table. Measures what the agent can't see from its own files:
//   print (via print-check, beside this file): page size, bleed, text near the cut, photo ppi, smallest text, how many
//     pages it really is, and how small most of the type is;
//   phone page: sideways scrolling, the smallest text, allergen notes too small to read, prices pushed onto a different
//     line from their dish (so they stop lining up), and how heavy the images are on a café's wi-fi;
//   QR code: decoded with jsQR (Apache-2.0) from the image file AND from the printed page, then again as a phone at 40 cm
//     and 60 cm in dim light would see it; its printed size, its quiet zone and its contrast; where it points.
// adds: tool. Runs on the user's machine with their Chrome/Edge/Chromium; nothing leaves it.
// Needs: print-check.mjs beside it, `npm i puppeteer-core jsqr`, and a PDF renderer for the page images (Ghostscript,
// pdftoppm, mutool or PyMuPDF; print-check finds whichever is there).
//
//   node menu-check.mjs check <folder> [--trim a4] [--bleed 3mm] [--url https://…] [--out look/menu]
//       → JSON {ok, errors, warnings, print, phone, qr, issues, sheet}. Then LOOK at <out>-sheet.png.
//   node menu-check.mjs --test
//
// Thresholds marked "Palm's guidance" are Palm's own, not a standard: menus are read in dim light, at arm's length.
// The QR quiet zone (4 modules) is from the QR Code standard, ISO/IEC 18004.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve, basename, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { check as printCheck, rasterize, inspectPdf, render as printRender } from './print-check.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const BASES = [process.env.PALM_NODE_MODULES, here, join(here, '..'), process.cwd(), join(here, '../../yz-hd-tools')].filter(Boolean);
function loadPuppeteer() {
  for (const b of BASES) { try { return createRequire(join(b, 'x.js'))('puppeteer-core'); } catch { /* next */ } }
  throw new Error('puppeteer-core is not installed. Run: npm i puppeteer-core');
}
// jsQR's browser build, injected into the page (it decodes from canvas pixels there).
function jsqrSource() {
  const cands = [process.env.PALM_JSQR];
  for (const b of BASES) { try { cands.push(createRequire(join(b, 'x.js')).resolve('jsqr/dist/jsQR.js')); } catch { /* next */ } }
  cands.push(join(here, '../../src/authenticator/vendor/jsQR-1.4.0.js')); // Palm's own repo
  const f = cands.find((x) => x && existsSync(x));
  return f ? readFileSync(f, 'utf8') : null;
}
function findChrome() {
  const c = [process.env.PALM_CHROME, process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'];
  const p = c.find((x) => x && existsSync(x)); if (!p) throw new Error('No Chrome, Edge or Chromium found. Set PALM_CHROME to its path.'); return p;
}
const launch = () => loadPuppeteer().launch({ executablePath: findChrome(), headless: true, timeout: 90000, args: ['--no-sandbox', '--hide-scrollbars'] });
const issue = (id, level, msg, fix) => ({ id, level, msg, ...(fix ? { fix } : {}) });
const r1 = (x) => Math.round(x * 10) / 10;
const TYPES = { '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.pdf': 'application/pdf' };
function serve(root) {
  const s = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html';
    const f = join(root, p); if (!f.startsWith(root)) { r.writeHead(403); return r.end(); }
    try { const b = readFileSync(f); const ty = TYPES[extname(f).toLowerCase()] || 'application/octet-stream'; r.writeHead(200, { 'content-type': /^text\//.test(ty) ? ty + '; charset=utf-8' : ty, 'content-length': b.length }); r.end(b); } catch { r.writeHead(404); r.end(); }
  });
  return new Promise((ok) => s.listen(0, '127.0.0.1', () => ok(s)));
}
const SKIP = /(^|\/)(look|palm|node_modules|\.git)\//;
const list = (root) => readdirSync(root, { recursive: true }).map(String).filter((f) => !SKIP.test(f + '/') && !SKIP.test(f) && statSync(join(root, f)).isFile());

// ---------- the phone page ----------
const PRICE = /^\s*(?:[£$€¥]\s?)?\d{1,4}(?:[.,]\d{1,2})?\s*(?:€|kr|zł)?\s*$/;
const ALLERGEN = /\b(gluten|wheat|dairy|milk|lactose|nuts?|peanuts?|eggs?|soya?|sesame|celery|mustard|sulph|lupin|mollusc|crustacean|fish|allergen|vegan|vegetarian)\b|\((?:v|vg|ve|gf|df|n)\)|\b(?:gf|vg|df)\b/i;
async function phonePage(browser, root, rel) {
  const srv = await serve(root);
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const out = {};
  try {
    for (const scheme of ['light', 'dark']) {
      const page = await browser.newPage();
      let bytes = 0, biggest = { url: '', kb: 0 }; const imgs = [];
      page.on('response', async (res) => { try { const t = res.headers()['content-type'] || ''; const n = +(res.headers()['content-length'] || 0); if (/^image\//.test(t) || /\.(jpe?g|png|webp|avif|gif)$/i.test(res.url())) { bytes += n; imgs.push(n); if (n / 1024 > biggest.kb) biggest = { url: res.url().replace(base, ''), kb: Math.round(n / 1024) }; } } catch {} });
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
      await page.goto(base + rel.split('/').map(encodeURIComponent).join('/'), { waitUntil: 'networkidle0', timeout: 60000 });
      await page.evaluate(() => document.fonts?.ready);
      // scroll through once so lazy images load and count
      await page.evaluate(async () => { for (let y = 0; y < document.documentElement.scrollHeight; y += 700) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 40)); } window.scrollTo(0, 0); });
      await new Promise((r) => setTimeout(r, 300));
      const m = await page.evaluate((PRICE_SRC, ALL_SRC) => {
        const PRICE = new RegExp(PRICE_SRC), ALLERGEN = new RegExp(ALL_SRC, 'i');
        const vw = 390; // the phone's width (mobile Chrome widens its layout viewport to fit a too-wide page, so innerWidth can't be trusted)
        const res = { scrollWidth: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight, minPx: 999, minText: '', allergenMin: 999, allergenText: '', small: 0, texts: 0, prices: 0, priceSplit: 0, splitExamples: [] };
        const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const visible = (el) => { const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity > 0.05; };
        const rangeRects = (n) => { const r = document.createRange(); r.selectNodeContents(n); return [...r.getClientRects()].filter((x) => x.width > 0 && x.height > 0); };
        for (let n = w.nextNode(); n; n = w.nextNode()) {
          const t = n.textContent.replace(/\s+/g, ' ').trim(); if (!t) continue;
          const el = n.parentElement; if (!el || !visible(el) || /^(SCRIPT|STYLE|NOSCRIPT|TITLE)$/.test(el.tagName)) continue;
          const rects = rangeRects(n); if (!rects.length) continue;
          if (el.closest('[aria-hidden="true"]')) continue;
          const px = parseFloat(getComputedStyle(el).fontSize); res.texts++;
          if (px < res.minPx) { res.minPx = px; res.minText = t.slice(0, 60); }
          if (px < 12) res.small++;
          if (ALLERGEN.test(t) && t.length < 200 && px < res.allergenMin) { res.allergenMin = px; res.allergenText = t.slice(0, 60); }
          if (PRICE.test(t)) {
            res.prices++;
            // the dish this price belongs to: the nearest ancestor that also holds words
            let box = el; while (box && box !== document.body && !/[A-Za-zÀ-ÿ]{3}/.test(box.textContent.replace(t, ''))) box = box.parentElement;
            if (!box || box === document.body) continue;
            const w2 = document.createTreeWalker(box, NodeFilter.SHOW_TEXT); let name = null;
            for (let k = w2.nextNode(); k; k = w2.nextNode()) { if (k !== n && /[A-Za-zÀ-ÿ]{3}/.test(k.textContent) && rangeRects(k).length) { name = k; break; } }
            if (!name) continue;
            const nr = rangeRects(name), pr = rects[0];
            const nameLine = nr[nr.length - 1] || nr[0];
            // same row as the dish name's first or last line = lined up; otherwise it was pushed down (or up)
            const same = nr.some((r) => Math.abs((r.top + r.bottom) / 2 - (pr.top + pr.bottom) / 2) < Math.max(r.height, pr.height) * 0.6);
            if (!same) { res.priceSplit++; if (res.splitExamples.length < 3) res.splitExamples.push(name.textContent.replace(/\s+/g, ' ').trim().slice(0, 40) + ' … ' + t); }
            void nameLine;
          }
        }
        res.overflow = res.scrollWidth > vw + 1;
        // text that runs past the screen's edge: a row that scrolls sideways inside the page (section buttons, a table)
        // or is clipped reads as cut off on a phone even when the page itself doesn't scroll sideways
        res.cut = 0; res.cutExamples = [];
        const w3 = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n = w3.nextNode(); n; n = w3.nextNode()) {
          const t = n.textContent.replace(/\s+/g, ' ').trim(); if (!t || !n.parentElement || !visible(n.parentElement) || n.parentElement.closest('[aria-hidden="true"]')) continue;
          if (rangeRects(n).some((r) => r.right > vw + 1 || r.left < -1)) { res.cut++; if (res.cutExamples.length < 3) res.cutExamples.push(t.slice(0, 30)); }
        }
        const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor; if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c; } return 'rgb(255, 255, 255)'; };
        res.bg = bgOf(document.body); res.fg = getComputedStyle(document.body).color;
        return res;
      }, PRICE.source, ALLERGEN.source);
      const shot = join(root, '.menu-check-' + scheme + '.png');
      await page.screenshot({ path: shot, clip: { x: 0, y: 0, width: 390, height: Math.min(m.height, 2400) } });
      out[scheme] = { ...m, shot, imageKB: Math.round(bytes / 1024), images: imgs.length, biggest };
      await page.close();
    }
  } finally { srv.close(); }
  return out;
}

// ---------- QR codes ----------
// Decodes in the page: the image as it is, then as a phone camera sees it from the table in dim light.
async function decodeQR(page, dataUrl, { pxPerMm = null } = {}) {
  return page.evaluate(async (src, pxPerMm) => {
    const img = new Image(); img.src = src; await img.decode();
    const W = img.naturalWidth || 1000, H = img.naturalHeight || 1000;
    const read = (w, h, filter) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d', { willReadFrequently: true }); x.fillStyle = '#fff'; x.fillRect(0, 0, w, h); x.filter = filter || 'none'; x.drawImage(img, 0, 0, w, h); const d = x.getImageData(0, 0, w, h); return { d, c }; };
    const full = read(W, H);
    const r = jsQR(full.d.data, W, H, { inversionAttempts: 'attemptBoth' });
    if (!r) return { found: false };
    const L = r.location; const side = (Math.hypot(L.topRightCorner.x - L.topLeftCorner.x, L.topRightCorner.y - L.topLeftCorner.y) + Math.hypot(L.bottomLeftCorner.x - L.topLeftCorner.x, L.bottomLeftCorner.y - L.topLeftCorner.y)) / 2;
    const modules = 17 + 4 * r.version, mod = side / modules;
    const xs = [L.topLeftCorner.x, L.topRightCorner.x, L.bottomLeftCorner.x, L.bottomRightCorner.x], ys = [L.topLeftCorner.y, L.topRightCorner.y, L.bottomLeftCorner.y, L.bottomRightCorner.y];
    const box = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
    const lum = (x, y) => { const i = (Math.round(y) * W + Math.round(x)) * 4, d = full.d.data; return (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255; };
    // contrast between dark and light modules, sampled inside the code
    const vals = []; for (let i = 0; i < 400; i++) { const x = box.x0 + (box.x1 - box.x0) * ((i * 37) % 100) / 100, y = box.y0 + (box.y1 - box.y0) * ((i * 61) % 100) / 100; vals.push(lum(x, y)); }
    vals.sort((a, b) => a - b); const dark = vals.slice(0, 80).reduce((a, b) => a + b, 0) / 80, light = vals.slice(-80).reduce((a, b) => a + b, 0) / 80;
    const mid = (dark + light) / 2;
    // a finder pattern's corner module is dark, unless the whole code is inverted (light on dark)
    const inverted = lum(box.x0 + mod * 3.5, box.y0 + mod * 3.5) > mid; // the finder pattern's centre is dark on a normal code
    // quiet zone: how many modules of plain background (the code's light colour) around it before anything else
    let quiet = 0;
    for (let k = 1; k <= 6; k++) {
      const o = (k - 0.5) * mod; let clean = true;
      for (let t = 0; t <= 24 && clean; t++) {
        const fx = box.x0 + (box.x1 - box.x0) * t / 24, fy = box.y0 + (box.y1 - box.y0) * t / 24;
        for (const [x, y] of [[fx, box.y0 - o], [fx, box.y1 + o], [box.x0 - o, fy], [box.x1 + o, fy]]) {
          if (x < 0 || y < 0 || x >= W || y >= H) { clean = false; break; }
          if (inverted ? lum(x, y) > mid : lum(x, y) < mid) { clean = false; break; }
        }
      }
      if (!clean) break; quiet = k;
    }
    // the table test: a phone camera (about 3000 px across a 65° view) at 40 and 60 cm, in dim light
    const table = {};
    if (pxPerMm) for (const cm of [40, 60]) {
      const camPxPerMm = 3000 / (2 * cm * 10 * Math.tan(32.5 * Math.PI / 180));
      const s = camPxPerMm / pxPerMm, w = Math.max(40, Math.round(W * s)), h = Math.max(40, Math.round(H * s));
      const v = read(w, h, 'brightness(0.45) contrast(0.85) blur(0.6px)');
      const rr = jsQR(v.d.data, w, h, { inversionAttempts: 'attemptBoth' });
      table[cm] = !!rr && rr.data === r.data;
    }
    return { found: true, data: r.data, version: r.version, modules, modulePx: mod, sidePx: side, box, quiet, contrast: Math.round((light - dark) * 100) / 100, inverted, table };
  }, dataUrl, pxPerMm);
}
const dataUrl = (file) => `data:${TYPES[extname(file).toLowerCase()] || 'image/png'};base64,${readFileSync(file).toString('base64')}`;

// ---------- check ----------
export async function check(target, { trim = 'a4', bleed = '3mm', url = null, out = 'look/menu', plain = false } = {}) {
  const root = resolve(target);
  const files = list(root);
  const issues = [];
  const add = (id, level, msg, fix) => issues.push(issue(id, level, msg, fix));
  const res = { print: null, phone: null, qr: [] };
  const jsqr = jsqrSource();
  const tmp = mkdtempSync(join(tmpdir(), 'palm-menu-'));
  const o = resolve(out); mkdirSync(dirname(o), { recursive: true });
  const browser = await launch();
  const pagesPng = [];
  try {
    // 1. print
    const pdfs = files.filter((f) => /\.pdf$/i.test(f));
    if (!pdfs.length) add('no-pdf', 'error', 'No PDF found: the printer needs the menu as a PDF at the finished size plus bleed.', `node palm/tools/print-check.mjs render menu-print.html --trim ${trim} --bleed ${bleed} --out print/menu.pdf`);
    else {
      res.print = { files: [], sheets: [] };
      for (const [k, f] of pdfs.entries()) {
        const pr = await printCheck(join(root, f), { trim, bleed, out: o + '-print' + (pdfs.length > 1 ? '-' + (k + 1) : ''), plain });
        res.print.files.push(...pr.files.map((x) => ({ file: f, pages: x.pages.map((p) => ({ size: p.size, trim: p.trim, bleed: p.bleed, min_text_pt: p.min_text_pt, min_ppi: p.min_ppi })) })));
        if (pr.sheet) res.print.sheets.push(pr.sheet);
        for (const i of pr.issues.filter((x) => x.level !== 'info')) issues.push({ ...i, id: 'print-' + i.id, msg: i.msg.startsWith(f) ? i.msg : `${f}: ${i.msg}` });
      }
      for (const f of pdfs) {
        const info = inspectPdf(readFileSync(join(root, f)));
        // How small is most of the type? A menu is read in dim light: Palm's guidance is 10–12 pt for dishes and prices.
        const sizes = info.pages.flatMap((p) => p.text.flatMap((t) => Array(Math.max(1, t.n || 1)).fill(t.size))).filter((x) => x > 3).sort((a, b) => a - b);
        const median = sizes.length ? sizes[Math.floor(sizes.length / 2)] : null;
        res.print.median_text_pt = median ? r1(median) : null; res.print.pages = (res.print.pages || 0) + info.pages.length;
        if (median && median < 10.8) add('menu-text-small', 'warn', `${f}: most of the text is ${r1(median)} pt; menus are read at arm's length in dim light, often by older guests (Palm's guidance: 11–13 pt for dishes and prices, allergen and description lines at least 9 pt).`, 'Make the type bigger and give it room: use the back of the page (two pages) rather than shrinking everything onto one.');
        const ras = rasterize(join(root, f), 150, join(tmp, 'p' + pagesPng.length));
        const centre = (pg) => { const t = (pg?.text || []).filter((x) => x.size > 3); if (!t.length) return [pg ? pg.w / 2 : 105, pg ? pg.h / 2 : 148]; const xs = t.map((x) => (x.x0 + x.x1) / 2).sort((a, b) => a - b), ys = t.map((x) => (x.y0 + x.y1) / 2).sort((a, b) => a - b); return [xs[xs.length >> 1], ys[ys.length >> 1]]; };
        ras.files.forEach((p, i) => pagesPng.push({ file: f, page: i + 1, png: p, w: info.pages[i]?.w, h: info.pages[i]?.h, centre: centre(info.pages[i]) }));
        // the printed QR: decode it from the page at 300 dpi
        if (jsqr) {
          const hi = rasterize(join(root, f), 300, join(tmp, 'q' + pagesPng.length));
          const qp = await browser.newPage(); await qp.setContent('<body></body>'); await qp.addScriptTag({ content: jsqr });
          for (const [i, p] of hi.files.entries()) {
            const d = await decodeQR(qp, dataUrl(p), { pxPerMm: 300 / 25.4 });
            if (d.found) res.qr.push({ where: `${f} page ${i + 1} (printed)`, printed: true, file: f, page: i + 1, ...d, side_mm: r1(d.sidePx / (300 / 25.4)), module_mm: r1(d.modulePx / (300 / 25.4) * 10) / 10 });
          }
          await qp.close();
        }
      }
      if (res.print.pages > 2) add('menu-pages', 'warn', `The menu PDF has ${res.print.pages} pages; check that sections didn't spill onto extra pages.`);
    }
    // 2. the phone page
    const htmls = files.filter((f) => /\.html?$/i.test(f) && !/print|pdf|a4|letter/i.test(basename(f)));
    const pick = htmls.find((f) => /(^|\/)menu\/index\.html$/i.test(f)) || htmls.find((f) => /menu/i.test(basename(f))) || htmls.find((f) => /(^|\/)index\.html$/i.test(f)) || htmls[0];
    if (!pick) add('no-phone-page', 'error', 'No phone menu page (HTML) found for the QR code to open.');
    else {
      const ph = await phonePage(browser, root, pick);
      const L = ph.light;
      res.phone = { page: pick, min_px: L.minPx, min_text: L.minText, allergen_min_px: L.allergenMin < 999 ? L.allergenMin : null, overflow: L.overflow || ph.dark.overflow, prices: L.prices, price_split: L.priceSplit, split_examples: L.splitExamples, image_kb: L.imageKB, biggest_image: L.biggest, height_px: L.height };
      res.phone.cut = L.cut; res.phone.dark_differs = L.bg !== ph.dark.bg || L.fg !== ph.dark.fg;
      if (L.cut > 0) add('phone-cut-off', 'warn', `${pick}: ${L.cut} piece(s) of text run past the edge of a 390 px phone (e.g. "${L.cutExamples.join('", "')}"), so they look cut off; a row that scrolls sideways inside the page often goes unnoticed.`, 'Let the row wrap onto two lines (flex-wrap: wrap), or make it fit the width.');
      if (!res.phone.dark_differs) add('phone-no-dark', 'warn', `${pick}: the page looks the same in dark mode; at a dim table a bright white page dazzles and many guests have dark mode on (Palm's guidance: give it a dark theme with prefers-color-scheme).`);
      if (L.overflow || ph.dark.overflow) add('phone-sideways', 'error', `${pick}: the page is wider than a 390 px phone (${Math.max(L.scrollWidth, ph.dark.scrollWidth)} px), so guests scroll sideways.`, 'Find the wide element (a table, a long word, a fixed width) and let it wrap or shrink.');
      if (L.minPx < 12) add('phone-text-tiny', 'error', `${pick}: some text is ${L.minPx} px ("${L.minText}"); under 12 px is hard to read on a phone (Palm's guidance; iOS's smallest text style is 11 pt).`);
      else if (L.minPx < 14) add('phone-text-small', 'warn', `${pick}: the smallest text is ${L.minPx} px ("${L.minText}"); 14 px or more reads better on a phone at a table (Palm's guidance).`);
      if (L.allergenMin < 13) add('allergen-small', 'warn', `${pick}: allergen or dietary notes are as small as ${L.allergenMin} px ("${L.allergenText}"); guests who need them read them most closely (Palm's guidance: same size as the dish description, at least 13 px).`);
      if (L.priceSplit > 0 && L.priceSplit < L.prices) add('price-wrap', 'warn', `${pick}: ${L.priceSplit} of ${L.prices} prices sit on a different line from their dish (e.g. ${L.splitExamples.join('; ')}), so on a 390 px phone the prices no longer line up.`, 'Keep the price on the dish line: let the name wrap beside a fixed-width price (flex with the price flex: none), or put every price on its own line the same way.');
      if (L.imageKB > 1500) add('phone-heavy', 'warn', `${pick}: the images weigh ${L.imageKB} KB (biggest ${L.biggest.url}, ${L.biggest.kb} KB); on a busy café wi-fi or 4G the menu appears slowly (Palm's guidance: under 1 MB in total).`, 'Resize photos to 2× their shown width and save as WebP or JPEG at ~80.');
      res.phone.shots = { light: L.shot, dark: ph.dark.shot };
    }
    // 3. QR image files
    if (!jsqr) add('no-qr-decoder', 'warn', 'jsQR is not installed, so the QR code was not decoded. Run: npm i jsqr');
    else {
      const qrFiles = files.filter((f) => /qr/i.test(basename(f)) && /\.(png|jpe?g|svg|webp)$/i.test(f));
      const qp = await browser.newPage(); await qp.setContent('<body></body>'); await qp.addScriptTag({ content: jsqr });
      for (const f of qrFiles) {
        let src = dataUrl(join(root, f));
        if (/\.svg$/i.test(f)) { // draw the SVG big enough to decode
          await qp.setViewport({ width: 1000, height: 1000 });
          src = await qp.evaluate(async (s) => { const i = new Image(); i.src = s; await i.decode(); const c = document.createElement('canvas'); const k = 1000 / Math.max(i.naturalWidth || 300, i.naturalHeight || 300); c.width = Math.round((i.naturalWidth || 300) * k); c.height = Math.round((i.naturalHeight || 300) * k); const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(i, 0, 0, c.width, c.height); return c.toDataURL('image/png'); }, src);
        }
        const d = await decodeQR(qp, src);
        res.qr.push({ where: f, printed: false, ...d });
        if (!d.found) add('qr-unreadable', 'error', `${f}: the QR code in this file doesn't scan (jsQR found no code).`, 'Make it again with a generator (e.g. npm i qrcode; npx qrcode -w 1200 -o qr.png <url>), dark on light, with a margin.');
        else if (d.quiet < 4) add('qr-quiet-zone', 'warn', `${f}: only ${d.quiet} module(s) of clear margin around the code; the QR standard (ISO/IEC 18004) asks for 4, and placed tight against other artwork it can fail to scan.`, 'Keep a light margin of at least 4 modules on every side.');
      }
      await qp.close();
    }
    for (const q of res.qr.filter((x) => x.found)) {
      if (!/^https?:\/\//i.test(q.data)) add('qr-not-link', 'warn', `${q.where}: the QR code holds "${q.data.slice(0, 60)}", not a web address.`);
      if (url && q.data.replace(/\/$/, '') !== url.replace(/\/$/, '')) add('qr-wrong-link', 'error', `${q.where}: the QR code opens ${q.data}, not ${url}.`);
      if (q.inverted) add('qr-inverted', 'warn', `${q.where}: the code is light on dark; some phone cameras won't read inverted codes. Dark modules on a light background scan everywhere.`);
      if (q.contrast < 0.5) add('qr-contrast', 'warn', `${q.where}: low contrast between the dark and light modules (${q.contrast} of 1); dim light makes it worse.`);
      if (q.printed) {
        if (q.side_mm < 25) add('qr-small', q.side_mm < 18 ? 'error' : 'warn', `${q.where}: the printed code is ${q.side_mm} mm across; read from the table (40–60 cm) that's small (a widely used rule of thumb: code width ≥ scanning distance ÷ 10, so 40–60 mm; Palm's guidance: at least 30 mm on a table menu).`);
        if (q.table[40] === false || q.table[60] === false) add('qr-table', q.table[40] === false ? 'error' : 'warn', `${q.where}: in Palm's table test (a phone camera at ${q.table[40] === false ? '40' : '60'} cm in dim light) the code didn't scan.`, 'Print it bigger, darker on lighter, with a clear margin.');
      }
    }
    const printedFound = res.qr.some((q) => q.printed && q.found);
    if (pdfs.length && jsqr && !printedFound) add('qr-not-on-print', 'warn', 'No scannable QR code was found on the printed menu; guests at the table need it on the page (or on a table card).');
    // 4. the sheet
    const sheet = o + '-sheet.png';
    await drawSheet(browser, { pagesPng, phone: res.phone, qr: res.qr, plain }, sheet);
    res.sheet = sheet;
    if (res.phone?.shots) { for (const s of Object.values(res.phone.shots)) try { rmSync(s); } catch {} delete res.phone.shots; }
  } finally { await browser.close(); try { rmSync(tmp, { recursive: true, force: true }); } catch {} }
  const errors = issues.filter((i) => i.level === 'error').length, warnings = issues.filter((i) => i.level === 'warn').length;
  return { ok: errors === 0, errors, warnings, ...res, issues };
}

async function drawSheet(browser, { pagesPng, phone, qr, plain }, outFile) {
  const img = (f) => `data:image/png;base64,${readFileSync(f).toString('base64')}`;
  const page1 = pagesPng[0];
  const H = 640;
  let body = '';
  if (page1) {
    const ratio = (page1.w || 216) / (page1.h || 303);
    body += `<section><h2>The printed menu at arm's length: in daylight, and in a dim dining room</h2><div class="row">${pagesPng.slice(0, 2).map((p) => `<figure><img src="${img(p.png)}" style="height:${H}px;width:${Math.round(H * ratio)}px"><figcaption>${plain ? '' : p.file + ' · '}page ${p.page}, daylight</figcaption></figure><figure><img src="${img(p.png)}" style="height:${H}px;width:${Math.round(H * ratio)}px;filter:brightness(.5) sepia(.35) contrast(.9)"><figcaption>page ${p.page}, dim restaurant light</figcaption></figure>`).join('')}</div>
      <h2>Close up (page 1 where most of the text is, as the printed page looks at reading distance)</h2>${(() => { const k = 3.78 * 1.6, [, cy] = page1.centre || [(page1.w || 216) / 2, (page1.h || 303) / 2]; return `<div class="crop" style="width:1300px;height:520px;overflow:hidden;position:relative;background:#fff"><img src="${img(page1.png)}" style="position:absolute;width:${Math.round((page1.w || 216) * k)}px;left:${Math.round(Math.min(0, Math.max(1300 - (page1.w || 216) * k, 650 - ((page1.w || 216) / 2) * k)))}px;top:${Math.round(Math.min(0, Math.max(520 - (page1.h || 303) * k, 260 - cy * k)))}px;box-shadow:none"></div>`; })()}</section>`;
  }
  if (phone?.shots) body += `<section><h2>The phone page the QR code opens (390 px wide), light and dark</h2><div class="row">${['light', 'dark'].map((s) => `<figure><img src="${img(phone.shots[s])}" style="width:390px"><figcaption>${s}</figcaption></figure>`).join('')}</div></section>`;
  const qs = qr.filter((q) => q.found && q.printed);
  if (pagesPng.length && qs.length) {
    const q = qs[0]; const p = pagesPng.find((x) => x.file === q.file && x.page === q.page) || page1; // the page the code was found on
    // the code with what's printed round it (a caption under it, the panel it sits in), so nothing is cut by the crop
    const k = 150 / 300, side = (q.box.x1 - q.box.x0) * k, pad = Math.max(q.modulePx * 6 * k, side * 0.35);
    const x0 = Math.max(0, q.box.x0 * k - pad), y0 = Math.max(0, q.box.y0 * k - pad), wpx = side + 2 * pad;
    const scale = 260 / wpx;
    body += `<section><h2>The QR code on the printed menu, at real size and as a phone sees it from the table in dim light</h2><div class="row"><figure><div style="width:260px;height:260px;overflow:hidden;position:relative;background:#fff"><img src="${img(p.png)}" style="position:absolute;transform-origin:0 0;transform:scale(${scale});left:${-x0 * scale}px;top:${-y0 * scale}px"></div><figcaption>${plain ? 'enlarged' : `${q.side_mm} mm across · ${q.modules}×${q.modules} modules`}</figcaption></figure><figure><div style="width:260px;height:260px;overflow:hidden;position:relative;background:#fff;filter:brightness(.45) contrast(.85) blur(.6px)"><img src="${img(p.png)}" style="position:absolute;transform-origin:0 0;transform:scale(${scale});left:${-x0 * scale}px;top:${-y0 * scale}px"></div><figcaption>dim light${plain ? '' : ` · scans at 40 cm: ${q.table[40] ? 'yes' : 'NO'}, 60 cm: ${q.table[60] ? 'yes' : 'NO'}`}</figcaption></figure></div></section>`;
  } else if (pagesPng.length) body += `<section><h2>The QR code on the printed menu</h2><p class="none">${plain ? 'No QR code found on the printed page.' : 'No scannable QR code was found on the printed page.'}</p></section>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#e9e7e2;font:15px/1.4 -apple-system,system-ui,sans-serif;color:#222;width:1400px}section{padding:22px 28px;border-bottom:1px solid #ccc}h2{font-size:13px;letter-spacing:.05em;text-transform:uppercase;color:#555;margin:0 0 14px}.row{display:flex;gap:22px;flex-wrap:wrap;align-items:flex-start}figure{margin:0}figure img{display:block;box-shadow:0 2px 10px rgba(0,0,0,.25)}figcaption{font-size:12px;color:#666;margin-top:6px}.none{color:#a00}</style></head><body>${body}</body></html>`;
  const pg = await browser.newPage(); await pg.setViewport({ width: 1400, height: 900 });
  await pg.setContent(html, { waitUntil: 'load' }); await pg.evaluate(() => Promise.all([...document.images].map((i) => i.complete ? 0 : new Promise((r) => (i.onload = r)))));
  await pg.screenshot({ path: outFile, fullPage: true }); await pg.close();
}

// ---------- self-test ----------
async function selfTest() {
  const d = mkdtempSync(join(tmpdir(), 'menu-test-'));
  const gen = join(here, '../../src/authenticator/vendor/qrcode-generator-1.4.4.js');
  const qrSvg = (txt, cell, margin) => { // a QR as SVG, made with the repo's generator when present (dev self-test only)
    const src = readFileSync(gen, 'utf8'); const m = { exports: {} }; new Function('module', 'exports', 'define', src)(m, m.exports, undefined); const q = (m.exports.qrcode || m.exports)(0, 'M'); q.addData(txt); q.make(); return q.createSvgTag(cell, margin);
  };
  const hasGen = existsSync(gen);
  const qr = hasGen ? qrSvg('https://cafe.example/menu', 4, 0) : '';
  const items = Array.from({ length: 14 }, (_, i) => `<div class="it"><span class="n">${i === 3 ? 'Slow-roasted tomato and smoked chilli sourdough toastie with mature cheddar' : 'Flat white ' + i}</span><span class="p">£${(3 + i / 4).toFixed(2)}</span><div class="a">(V) contains milk, gluten</div></div>`).join('');
  writeFileSync(join(d, 'menu-print.html'), `<html><head><style>@page{margin:0}body{margin:0}section{width:216mm;height:303mm;background:#f4efe6;font:7pt Georgia;padding:15mm;box-sizing:border-box}.it{display:flex;justify-content:space-between}.a{font-size:6pt}</style></head><body><section><h1 style="font-size:20pt">Test Café</h1>${items}<div style="width:14mm;height:14mm">${qr.replace('<svg ', '<svg style="width:14mm;height:14mm" ')}</div></section></body></html>`);
  await printRender(join(d, 'menu-print.html'), { trim: 'a4', bleed: '3mm', out: join(d, 'print/menu.pdf') });
  mkdirSync(join(d, 'menu'));
  writeFileSync(join(d, 'menu/index.html'), `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font:15px system-ui}.it{display:flex;flex-wrap:wrap;justify-content:space-between;padding:6px 12px}.a{font-size:10px;width:100%}table{width:600px}nav{display:flex;overflow-x:auto;white-space:nowrap;gap:8px;padding:8px}nav a{padding:6px 14px;border:1px solid #999;border-radius:20px}</style></head><body><nav><a>Coffee</a><a>Tea and other drinks</a><a>Breakfast</a><a>Lunch</a><a>Bakes</a></nav><table><tr><td>wide</td></tr></table>${items}</body></html>`);
  if (hasGen) writeFileSync(join(d, 'menu/qr.svg'), qrSvg('https://cafe.example/menu', 8, 32)); // margin is in px: 4 modules
  const r = await check(d, { out: join(d, 'look/menu'), url: 'https://cafe.example/menu' });
  const ids = r.issues.map((i) => i.id);
  const want = ['phone-sideways', 'phone-cut-off', 'phone-no-dark', 'phone-text-tiny', 'allergen-small', 'price-wrap', 'menu-text-small'].concat(hasGen ? ['qr-small'] : []);
  for (const w of want) if (!ids.includes(w)) throw new Error(`self-test: expected ${w}, got ${ids.join(',')}`);
  if (hasGen && !r.qr.some((q) => !q.printed && q.found && q.data === 'https://cafe.example/menu' && q.quiet >= 4)) throw new Error('self-test: the QR file should decode with a 4-module margin: ' + JSON.stringify(r.qr.map((q) => ({ w: q.where, f: q.found, quiet: q.quiet }))));
  if (hasGen && !r.qr.some((q) => q.printed && q.found && Math.abs(q.side_mm - 14) < 2)) throw new Error('self-test: the printed QR should decode at ~14 mm: ' + JSON.stringify(r.qr.map((q) => ({ w: q.where, mm: q.side_mm }))));
  if (!existsSync(r.sheet)) throw new Error('self-test: no sheet');
  // a clean menu: big type, prices beside dishes, a 40 mm code
  const c = mkdtempSync(join(tmpdir(), 'menu-clean-'));
  const good = Array.from({ length: 8 }, (_, i) => `<div class="it"><span class="n">Dish ${i}</span><span class="p">£${(8 + i).toFixed(2)}</span></div><p class="a">(V) contains milk</p>`).join('');
  writeFileSync(join(c, 'menu-print.html'), `<html><head><style>@page{margin:0}body{margin:0}section{width:216mm;height:303mm;background:#f4efe6;font:12pt Georgia;padding:15mm;box-sizing:border-box}.it{display:flex;justify-content:space-between}.a{font-size:11pt;margin:0 0 4mm}</style></head><body><section>${good}<div style="width:42mm;height:42mm;padding:4mm;background:#fff">${qr.replace('<svg ', '<svg style="width:42mm;height:42mm" ')}</div></section></body></html>`);
  await printRender(join(c, 'menu-print.html'), { trim: 'a4', bleed: '3mm', out: join(c, 'print/menu.pdf') });
  writeFileSync(join(c, 'index.html'), `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font:17px system-ui;padding:0 16px}.it{display:flex;justify-content:space-between;gap:12px}.p{flex:none}.a{font-size:15px;margin:0 0 12px}@media (prefers-color-scheme:dark){body{background:#151412;color:#eee}}</style></head><body>${good}</body></html>`);
  const rc = await check(c, { out: join(c, 'look/menu'), url: 'https://cafe.example/menu' });
  const bad = rc.issues.filter((i) => i.level !== 'info' && !(!hasGen && i.id === 'qr-not-on-print'));
  if (bad.length) throw new Error('self-test: the clean menu was flagged: ' + bad.map((i) => i.id + ' ' + i.msg.slice(0, 90)).join(' | '));
  console.log(`menu-check: all tests pass (broken menu: ${ids.join(', ')}; sheet ${r.sheet})`);
  rmSync(c, { recursive: true, force: true });
}

if (typeof process !== 'undefined' && process.argv?.[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
  const fail = (e) => { console.error(String(e?.message || e)); process.exit(2); };
  if (argv.includes('--test')) selfTest().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
  else if (argv[0] === 'check' && argv[1]) check(argv[1], { trim: opt('trim', 'a4'), bleed: opt('bleed', '3mm'), url: opt('url', null), out: opt('out', 'look/menu'), plain: argv.includes('--plain') }).then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); }, fail);
  else fail('usage: menu-check.mjs check <folder> [--trim a4] [--bleed 3mm] [--url https://…] [--out look/menu]\n       menu-check.mjs --test');
}
