#!/usr/bin/env node
// Palm tool: theme-check — lets an agent see a site's dark mode the way its readers will: every page in light and in
// dark, on a phone (390 px) and a desktop (1280 px), side by side, with the problems boxed. Dark mode breaks in places
// you can't see while writing CSS: grey text that was fine on white drops under the contrast minimum on near-black, a
// dark logo on a transparent PNG disappears, a screenshot with a white background glares, form fields and date pickers
// stay white (no color-scheme), focus rings and field borders vanish, a map or code block stays bright, and a theme
// toggle forgets the choice or flashes the wrong theme while the page loads.
// It measures what can be measured, against the real pixels: text contrast (WCAG 2.2 SC 1.4.3, 4.5:1 or 3:1 for
// large text) with the text hidden to read what's really behind it; field boundaries and focus indicators (SC 1.4.11,
// 3:1); transparent images whose visible pixels don't stand out from the page; white-edged images, bright embeds and
// code blocks on a dark page; color-scheme; theme-color; and a header toggle: click it, reload, see the first frame.
// adds: tool. Runs on the user's machine with their Chrome/Edge/Chromium; nothing leaves it.
//
//   node theme-check.mjs check <site folder> [--pages index.html,contact.html] [--out look/theme]
//       → JSON {ok, errors, warnings, pages, toggle, issues, sheet}. Then LOOK at the sheet.
//   node theme-check.mjs --test
//
// Sources: WCAG 2.2 SC 1.4.3 Contrast (Minimum), https://www.w3.org/TR/WCAG22/#contrast-minimum, and SC 1.4.11
// Non-text Contrast, https://www.w3.org/TR/WCAG22/#non-text-contrast; prefers-color-scheme, Media Queries Level 5,
// https://www.w3.org/TR/mediaqueries-5/#prefers-color-scheme; color-scheme, CSS Color Adjustment Level 1,
// https://www.w3.org/TR/css-color-adjust-1/#color-scheme-prop. Palm's guidance, not a standard (warnings): an image
// whose edge is near-white on a dark page "glares"; a bright embed or code block; a field left light; no color-scheme;
// a light theme-color in dark; a toggle whose script may run after the first paint.

import { readFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, extname } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';

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
const launch = () => loadPuppeteer().launch({ executablePath: findChrome(), headless: true, timeout: 90000, protocolTimeout: 180000, args: ['--no-sandbox', '--hide-scrollbars'] });

export const VIEWS = { phone: { width: 390, height: 844, cap: 2600, label: 'phone 390 px' }, desktop: { width: 1280, height: 800, cap: 1900, label: 'desktop 1280 px' } };
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon', '.json': 'application/json' };
function serve(root) {
  const s = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html';
    const f = join(root, p);
    if (!f.startsWith(root) || !existsSync(f) || statSync(f).isDirectory()) { r.writeHead(404); return r.end(); }
    r.writeHead(200, { 'content-type': TYPES[extname(f).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' }); r.end(readFileSync(f));
  });
  return new Promise((ok) => s.listen(0, '127.0.0.1', () => ok(s)));
}

export const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
export const ratio = (a, b) => { const [x, y] = a > b ? [a, b] : [b, a]; return (x + 0.05) / (y + 0.05); };

// Runs in the page: every text element, field, image, embed and code block, with the colours Chrome computed.
const MEASURE = async () => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 1; const cx = cv.getContext('2d', { willReadFrequently: true });
  const rgba = (c) => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); const d = cx.getImageData(0, 0, 1, 1).data; const m = String(c).match(/rgba?\([^)]*,\s*([\d.]+)\)$/) || String(c).match(/\/\s*([\d.]+%?)\s*\)$/); let a = 1; if (m) a = m[1].endsWith('%') ? parseFloat(m[1]) / 100 : parseFloat(m[1]); if (c === 'transparent') a = 0; return [d[0], d[1], d[2], a]; };
  const sel = (el) => { let s = el.tagName.toLowerCase(); if (el.id) s += '#' + el.id; else if (el.classList.length) s += '.' + [...el.classList].slice(0, 2).join('.'); const p = el.parentElement; return p && p !== document.body ? (p.tagName.toLowerCase() + (p.id ? '#' + p.id : p.classList.length ? '.' + p.classList[0] : '') + ' > ' + s) : s; };
  const vis = (el) => { for (let e = el; e && e !== document.documentElement; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity < 0.05) return false; } const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1; };
  const box = (r) => ({ x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height });
  const out = { scheme: getComputedStyle(document.documentElement).colorScheme, texts: [], fields: [], imgs: [], embeds: [], blocks: [],
    themeColor: [...document.querySelectorAll('meta[name="theme-color"]')].filter((m) => !m.media || matchMedia(m.media).matches).map((m) => rgba(m.content)) };
  for (const el of document.body.querySelectorAll('*')) {
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(el.tagName) || el.closest('svg')) continue;
    if (!vis(el)) continue;
    const cs = getComputedStyle(el);
    const nodes = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim());
    if (nodes.length) {
      let L = 1e9, T = 1e9, R = -1e9, B = -1e9;
      for (const n of nodes) { const rg = document.createRange(); rg.selectNodeContents(n); for (const q of rg.getClientRects()) { if (q.width < 1) continue; L = Math.min(L, q.left); T = Math.min(T, q.top); R = Math.max(R, q.right); B = Math.max(B, q.bottom); } }
      if (R > L && /[\p{L}\p{N}]/u.test(nodes.map((n) => n.textContent).join(''))) {
        const size = parseFloat(cs.fontSize), bold = (parseInt(cs.fontWeight, 10) || 400) >= 700;
        out.texts.push({ sel: sel(el), text: nodes.map((n) => n.textContent).join(' ').replace(/\s+/g, ' ').trim().slice(0, 50), box: { x: L + scrollX, y: T + scrollY, w: R - L, h: B - T }, fg: rgba(cs.color), large: size >= 24 || (size >= 18.66 && bold), size });
      }
    }
    if (el.matches('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]):not([type=image]), select, textarea')) {
      const r = el.getBoundingClientRect(), bw = parseFloat(cs.borderTopWidth) || 0;
      out.fields.push({ sel: sel(el), box: box(r), border: bw >= 1 && cs.borderTopStyle !== 'none' ? rgba(cs.borderTopColor) : null, bg: rgba(cs.backgroundColor), type: el.type || el.tagName.toLowerCase() });
      const ph = el.value ? null : el.getAttribute('placeholder');
      if (el.value || ph || el.tagName === 'SELECT') out.texts.push({ sel: sel(el) + (ph ? '::placeholder' : ''), text: (el.value || ph || el.options?.[el.selectedIndex]?.text || '').slice(0, 50), box: { x: r.left + scrollX + 8, y: r.top + scrollY + 6, w: Math.max(4, Math.min(r.width - 16, 220)), h: Math.max(4, r.height - 12) }, fg: rgba(ph ? getComputedStyle(el, '::placeholder').color : cs.color), large: parseFloat(cs.fontSize) >= 24, size: parseFloat(cs.fontSize), field: true });
    }
    if (el.tagName === 'IMG' && el.complete && el.naturalWidth) {
      const r = el.getBoundingClientRect(); let tr = 0, vis2 = [];
      try {
        const w = Math.min(160, el.naturalWidth), h = Math.max(1, Math.round(w * el.naturalHeight / el.naturalWidth));
        const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(el, 0, 0, w, h);
        const d = x.getImageData(0, 0, w, h).data; let n = 0, t = 0;
        for (let i = 0; i < d.length; i += 4) { n++; if (d[i + 3] < 128) t++; else if (d[i + 3] > 200 && (i / 4) % 3 === 0) vis2.push([d[i], d[i + 1], d[i + 2]]); }
        tr = t / n; if (vis2.length > 600) vis2 = vis2.filter((_, i) => i % Math.ceil(vis2.length / 600) === 0);
      } catch { tr = -1; }
      out.imgs.push({ sel: sel(el), src: el.getAttribute('src'), box: box(r), transparent: tr, visible: tr > 0.05 ? vis2 : [], filter: cs.filter });
    }
    if (el.tagName === 'IFRAME') out.embeds.push({ sel: sel(el), box: box(el.getBoundingClientRect()) });
    if (el.tagName === 'PRE' || (el.tagName === 'CODE' && !el.closest('pre') && el.getBoundingClientRect().height > 40)) out.blocks.push({ sel: sel(el), box: box(el.getBoundingClientRect()) });
  }
  return out;
};

// Runs in a blank page: pixel statistics from screenshots (median colour, luminance spread; changed pixels).
const PX = async (b64, reqs, after) => {
  const load = async (s) => { const im = new Image(); im.src = 'data:image/png;base64,' + s; await im.decode(); const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(im, 0, 0); return { W: c.width, H: c.height, d: x.getImageData(0, 0, c.width, c.height).data }; };
  const A = await load(b64);
  const L = (r, g, b) => { const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const pick = (I, pts) => pts.map(([x, y]) => { const i = (y * I.W + x) * 4; return [I.d[i], I.d[i + 1], I.d[i + 2]]; });
  const inBox = (I, b, pad = 0) => { const x0 = Math.max(0, Math.floor(b.x - pad)), y0 = Math.max(0, Math.floor(b.y - pad)), x1 = Math.min(I.W, Math.ceil(b.x + b.w + pad)), y1 = Math.min(I.H, Math.ceil(b.y + b.h + pad)); return { x0, y0, x1, y1 }; };
  const grid = (I, b, keep) => { const { x0, y0, x1, y1 } = inBox(I, b); const pts = []; if (x1 <= x0 || y1 <= y0) return pts; const step = Math.max(1, Math.floor(Math.sqrt((x1 - x0) * (y1 - y0) / 2500))); for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) if (!keep || keep(x, y)) pts.push([x, y]); return pts; };
  const stats = (cols) => { if (!cols.length) return null; const ls = cols.map((c) => L(...c)).sort((a, b) => a - b); const med = (k) => cols.map((c) => c[k]).sort((a, b) => a - b)[cols.length >> 1]; return { n: cols.length, rgb: [med(0), med(1), med(2)], lum: ls[ls.length >> 1], p10: ls[Math.floor(ls.length * 0.1)], p90: ls[Math.floor(ls.length * 0.9)] }; };
  const res = [];
  for (const r of reqs) {
    if (r.kind === 'full') res.push(stats(pick(A, grid(A, { x: 0, y: 0, w: A.W, h: Math.min(A.H, r.h || A.H) }))));
    else if (r.kind === 'box') res.push(stats(pick(A, grid(A, r.box))));
    else if (r.kind === 'outer') { const b = r.box, p = r.pad || 6; res.push(stats(pick(A, grid(A, { x: b.x - p, y: b.y - p, w: b.w + 2 * p, h: b.h + 2 * p }, (x, y) => x < b.x || x >= b.x + b.w || y < b.y || y >= b.y + b.h)))); }
    else if (r.kind === 'inner') { const b = r.box, p = r.pad || 3; res.push(stats(pick(A, grid(A, b, (x, y) => x < b.x + p || x >= b.x + b.w - p || y < b.y + p || y >= b.y + b.h - p)))); }
    else res.push(null);
  }
  if (after) { // focus: pixels that changed between the page (A) and a clip taken with one element focused
    const B = await load(after.b64), ox = after.x, oy = after.y; let changed = [], before = [];
    for (let y = 0; y < B.H; y += 1) for (let x = 0; x < B.W; x += 1) {
      const ax = x + ox, ay = y + oy; if (ax < 0 || ay < 0 || ax >= A.W || ay >= A.H) continue;
      const i = (y * B.W + x) * 4, j = (ay * A.W + ax) * 4;
      if (Math.abs(B.d[i] - A.d[j]) + Math.abs(B.d[i + 1] - A.d[j + 1]) + Math.abs(B.d[i + 2] - A.d[j + 2]) > 60) { changed.push([B.d[i], B.d[i + 1], B.d[i + 2]]); before.push([A.d[j], A.d[j + 1], A.d[j + 2]]); }
    }
    const k = changed.map((c, n) => { const a = L(...c), b = L(...before[n]); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); }).sort((a, b) => b - a);
    res.push({ changed: changed.length, best: k.length ? k[Math.min(k.length - 1, Math.floor(k.length * 0.1))] : 0 });
  }
  return res;
};

function findPages(root, pages) {
  if (pages) return pages;
  const html = readdirSync(root).filter((f) => /\.html?$/i.test(f) && !/^404/.test(f));
  // pages only shown inside an iframe (a map, a widget) aren't pages of their own
  const framed = new Set(); for (const f of html) for (const m of readFileSync(join(root, f), 'utf8').matchAll(/<iframe[^>]+src=["']\/?([^"'#?]+)/gi)) framed.add(m[1]);
  return html.filter((f) => !framed.has(f)).sort((a, b) => (a === 'index.html' ? -1 : b === 'index.html' ? 1 : a.localeCompare(b)));
}
const TOGGLE = `button, [role="button"], [role="switch"], a, input[type="checkbox"], label`;
const TOGGLE_RE = /dark|light|theme|mode|appearance|colou?r scheme|night|ダーク|ライト|テーマ/i;

export async function check(target, { pages = null, out = 'look/theme', plain = false } = {}) {
  const root = resolve(target);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error('Give the site folder (its .html pages at the top).');
  const list = findPages(root, pages);
  if (!list.length) throw new Error('No .html pages at the top of ' + target);
  mkdirSync(resolve(out, '..'), { recursive: true });
  const server = await serve(root), base = `http://127.0.0.1:${server.address().port}`;
  const browser = await launch();
  const px = await browser.newPage(); await px.setContent('<!doctype html><title>px</title>');
  const stats = (b64, reqs, after) => px.evaluate(PX, b64, reqs, after || null);
  const issues = [], shots = {}, summary = {};
  const add = (level, id, page, scheme, view, msg, extra = {}) => issues.push({ level, id, page, scheme, view, msg, ...extra });
  const open = async (rel, scheme, v) => {
    const p = await browser.newPage();
    await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
    await p.setViewport({ width: v.width, height: v.height, deviceScaleFactor: 1 });
    try { await p.goto(`${base}/${rel}`, { waitUntil: 'networkidle0', timeout: 45000 }); } catch (e) { if (!/timeout/i.test(String(e))) throw e; }
    await p.evaluate(() => document.fonts?.ready);
    const h = Math.min(await p.evaluate(() => document.scrollingElement.scrollHeight), v.cap);
    await p.setViewport({ width: v.width, height: h, deviceScaleFactor: 1 }); await new Promise((r) => setTimeout(r, 120));
    return { p, h };
  };
  const shot = async (p) => Buffer.from(await p.screenshot({ type: 'png' })).toString('base64');
  try {
    for (const page of list) {
      summary[page] = {};
      for (const scheme of ['light', 'dark']) for (const [vname, v] of Object.entries(VIEWS)) {
        const { p, h } = await open(page, scheme, v);
        const m = await p.evaluate(MEASURE);
        const A = await shot(p);
        // the same page with every letter made transparent: what's really behind each piece of text
        const hide = await p.addStyleTag({ content: '*,*::before,*::after{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important;caret-color:transparent!important;text-decoration-color:transparent!important}::placeholder{color:transparent!important}' });
        await new Promise((r) => setTimeout(r, 60));
        const B = await shot(p);
        await hide.evaluate((n) => n.remove());
        const full = (await stats(A, [{ kind: 'full', h: Math.min(h, v.height) }]))[0];
        const bgs = await stats(B, m.texts.map((t) => ({ kind: 'box', box: t.box })));
        const fieldStats = await stats(A, m.fields.flatMap((f) => [{ kind: 'outer', box: f.box, pad: 5 }, { kind: 'inner', box: f.box, pad: 3 }]));
        const imgStats = await stats(A, m.imgs.flatMap((im) => [{ kind: 'outer', box: im.box, pad: 6 }, { kind: 'inner', box: im.box, pad: 4 }]));
        const embStats = await stats(A, [...m.embeds, ...m.blocks].map((e) => ({ kind: 'box', box: e.box })));
        shots[`${page}|${scheme}|${vname}`] = { b64: A, h, w: v.width };
        summary[page][`${scheme}-${vname}`] = { page_lum: +full.lum.toFixed(3), color_scheme: m.scheme, texts: m.texts.length };
        const dark = scheme === 'dark', pageDark = full.lum < 0.25;
        // 1. text contrast (SC 1.4.3), against the pixels behind the text
        m.texts.forEach((t, i) => {
          const bg = bgs[i]; if (!bg) return;
          let fg = t.fg.slice(0, 3); if (t.fg[3] < 1) fg = fg.map((c, k) => Math.round(c * t.fg[3] + bg.rgb[k] * (1 - t.fg[3])));
          const need = t.large ? 3 : 4.5, k = ratio(lum(fg), bg.lum), worst = ratio(lum(fg), lum(fg) > bg.lum ? bg.p90 : bg.p10);
          const k2 = bg.p90 - bg.p10 > 0.25 ? Math.min(k, worst) : k; // over a photo or gradient, the worse half counts
          if (k2 < need - 0.05) add('error', 'text-contrast', page, scheme, vname, `"${t.text}" (${t.sel}) has ${k2.toFixed(2)}:1 contrast in ${scheme}${t.field ? ' (inside a form field)' : ''}; it needs ${need}:1 (WCAG 1.4.3).`, { box: t.box, ratio: +k2.toFixed(2), sel: t.sel });
        });
        // 2. form fields: boundary (SC 1.4.11) and, in dark, fields left light
        m.fields.forEach((f, i) => {
          const o = fieldStats[2 * i], inn = fieldStats[2 * i + 1]; if (!o || !inn) return;
          const kb = f.border && f.border[3] > 0.05 ? ratio(lum(f.border), o.lum) : 0, kf = ratio(inn.lum, o.lum);
          if (Math.max(kb, kf) < 2.95) add('error', 'field-boundary', page, scheme, vname, `The ${f.type} field ${f.sel} barely stands out in ${scheme}: border ${kb ? kb.toFixed(2) : 'none'}:1, fill ${kf.toFixed(2)}:1 against the page; a field's edge needs 3:1 (WCAG 1.4.11).`, { box: f.box, sel: f.sel });
          if (dark && pageDark && inn.lum > 0.6) add('warn', 'field-light', page, scheme, vname, `The ${f.type} field ${f.sel} stays light (fill luminance ${inn.lum.toFixed(2)}) on the dark page${/dark/.test(m.scheme) ? '' : '; the page doesn\'t declare color-scheme: dark, so Chrome draws native fields, date pickers and scrollbars light'}.`, { box: f.box, sel: f.sel });
        });
        // 3. images: transparent ones whose visible pixels disappear; opaque ones that glare white on a dark page
        m.imgs.forEach((im, i) => {
          const o = imgStats[2 * i], inn = imgStats[2 * i + 1]; if (!o) return;
          if (im.transparent > 0.05 && im.visible.length > 20) {
            const ok = im.visible.filter((c) => ratio(lum(c), o.lum) >= 3).length / im.visible.length;
            if (ok < 0.3 && !/invert|brightness/.test(im.filter || '')) add('error', 'image-vanishes', page, scheme, vname, `${im.src} (${im.sel}) is a transparent image whose visible pixels don't stand out from the ${scheme} page (only ${Math.round(ok * 100)}% reach 3:1, WCAG 1.4.11): a dark logo or icon disappears.`, { box: im.box, sel: im.sel });
          } else if (dark && pageDark && inn && inn.lum > 0.85 && o.lum < 0.25) add('warn', 'image-glare', page, scheme, vname, `${im.src} (${im.sel}) has a near-white edge (luminance ${inn.lum.toFixed(2)}) on the dark page, so it glares as a white box.`, { box: im.box, sel: im.sel });
        });
        // 4. embeds and code blocks left bright on a dark page
        [...m.embeds.map((e) => ({ ...e, kind: 'embed' })), ...m.blocks.map((e) => ({ ...e, kind: 'code block' }))].forEach((e, i) => {
          const s = embStats[i]; if (dark && pageDark && s && s.lum > 0.6) add('warn', e.kind === 'embed' ? 'embed-bright' : 'block-bright', page, scheme, vname, `The ${e.kind} ${e.sel} stays bright (luminance ${s.lum.toFixed(2)}) on the dark page.`, { box: e.box, sel: e.sel });
        });
        if (dark && vname === 'desktop') {
          if (!pageDark) add('error', 'not-dark', page, scheme, null, `${page} doesn't turn dark when the system is set to dark (page luminance ${full.lum.toFixed(2)}): it doesn't follow prefers-color-scheme.`);
          else {
            if (!/dark/.test(m.scheme)) add('warn', 'no-color-scheme', page, scheme, null, `${page} doesn't declare color-scheme: dark in dark mode (computed "${m.scheme}"), so native controls (date and colour pickers, selects, scrollbars) stay light.`);
            if (m.themeColor.length && m.themeColor.every((c) => lum(c) > 0.5)) add('warn', 'theme-color', page, scheme, null, `${page}'s theme-color stays light in dark mode, so the phone's browser bar stays light above a dark page. Add <meta name="theme-color" media="(prefers-color-scheme: dark)" content="…">.`);
            // 5. focus indicators by keyboard (SC 1.4.11 / 2.4.7), in dark on the desktop
            const seen = new Set(); let tabbed = 0, none = [], weak = [];
            for (let t = 0; t < 14; t++) {
              await p.keyboard.press('Tab');
              const f = await p.evaluate(() => { const e = document.activeElement; if (!e || e === document.body) return null; const r = e.getBoundingClientRect(); return { key: e.outerHTML.slice(0, 80), tag: e.tagName.toLowerCase(), text: (e.innerText || e.value || e.getAttribute('aria-label') || '').trim().slice(0, 30), x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }; });
              if (!f || seen.has(f.key)) continue; seen.add(f.key);
              if (f.w < 2 || f.y + f.h + 8 > h || f.y < 0) continue;
              const cx0 = Math.max(0, Math.floor(f.x - 8)), cy0 = Math.max(0, Math.floor(f.y - 8)); const clip = { x: cx0, y: cy0, width: Math.min(v.width - cx0, Math.ceil(f.w + 16)), height: Math.ceil(f.h + 16) };
              const after = Buffer.from(await p.screenshot({ type: 'png', clip })).toString('base64');
              const r = (await stats(A, [], { b64: after, x: clip.x, y: clip.y }))[0]; tabbed++;
              if (r.changed < 8) none.push(f); else if (r.best < 3) weak.push({ ...f, k: r.best });
            }
            if (none.length) add('error', 'focus-invisible', page, scheme, 'desktop', `${none.length} of ${tabbed} keyboard Tab stops show no visible focus in dark (${none.slice(0, 4).map((f) => `${f.tag} "${f.text}"`).join(', ')}).`, { box: none[0], sel: none[0].tag });
            if (weak.length) add('error', 'focus-contrast', page, scheme, 'desktop', `${weak.length} focus indicator${weak.length > 1 ? 's' : ''} in dark reach only ${Math.max(...weak.map((w) => w.k)).toFixed(2)}:1 against what's behind them; they need 3:1 (WCAG 1.4.11) (${weak.slice(0, 4).map((f) => `${f.tag} "${f.text}"`).join(', ')}).`, { box: weak[0] });
          }
        }
        await p.close();
      }
    }
    // 6. a theme toggle in the header: click it with the system in light, reload, look at the first frame and the last
    let toggle = { found: false };
    {
      const first = list[0];
      const { p, h } = await open(first, 'light', VIEWS.desktop);
      const before = (await stats(await shot(p), [{ kind: 'full', h: Math.min(h, 800) }]))[0].lum;
      const handle = await p.evaluateHandle((S, RE) => {
        const re = new RegExp(RE, 'i');
        const cands = [...document.querySelectorAll(S)].filter((e) => { const r = e.getBoundingClientRect(); if (r.width < 4 || r.height < 4) return false; const t = [e.innerText, e.getAttribute('aria-label'), e.getAttribute('title'), e.id, e.className && String(e.className), e.getAttribute('data-theme-toggle') !== null ? 'theme' : ''].join(' '); return re.test(t); });
        cands.sort((a, b) => (b.closest('header, nav') ? 1 : 0) - (a.closest('header, nav') ? 1 : 0));
        return cands[0] || null;
      }, TOGGLE, TOGGLE_RE.source);
      const el = handle.asElement();
      if (el) {
        toggle = { found: true, label: await el.evaluate((e) => (e.getAttribute('aria-label') || e.innerText || e.title || e.tagName).trim().slice(0, 40)), in_header: await el.evaluate((e) => !!e.closest('header, nav')) };
        await el.click(); await new Promise((r) => setTimeout(r, 400));
        const A1 = await shot(p); const afterClick = (await stats(A1, [{ kind: 'full', h: Math.min(h, 800) }]))[0].lum;
        toggle.switches = afterClick < 0.25 && before > 0.4;
        shots.toggle = [{ label: 'system light, as loaded', b64: (await (async () => { return null; })()) }];
        // reload with external scripts held back 1.2 s: what does the page paint before its scripts run?
        await p.setRequestInterception(true);
        p.on('request', (q) => { if (q.resourceType() === 'script') setTimeout(() => q.continue().catch(() => {}), 1200); else q.continue().catch(() => {}); });
        const nav = p.goto(`${base}/${first}?reload=1`, { waitUntil: 'load', timeout: 20000 }).catch(() => {});
        await new Promise((r) => setTimeout(r, 450));
        const early = await shot(p).catch(() => null);
        await nav; await p.waitForNetworkIdle({ idleTime: 300, timeout: 8000 }).catch(() => {});
        await new Promise((r) => setTimeout(r, 300));
        const late = await shot(p);
        const [eL, lL] = [early ? (await stats(early, [{ kind: 'full', h: 600 }]))[0]?.lum : null, (await stats(late, [{ kind: 'full', h: 600 }]))[0].lum];
        toggle.persists = toggle.switches && lL < 0.25; toggle.first_frame_light = eL != null && eL > 0.4;
        const head = readFileSync(join(root, first), 'utf8').split(/<body/i)[0];
        toggle.head_script = /<script(?![^>]*\b(src|defer|async|type=["']module)\b)[^>]*>[\s\S]*?(localStorage|matchMedia|data-theme|classList|colorScheme|color-scheme)/i.test(head);
        shots.toggle = [{ label: 'system light, before', b64: null }, { label: 'after clicking the toggle', b64: A1 }, { label: 'reloaded: first frame', b64: early }, { label: 'reloaded', b64: late }].filter((x) => x.b64);
        if (!toggle.switches) add('error', 'toggle-no-effect', first, 'light', 'desktop', `Clicking the theme toggle (${toggle.label}) didn't turn ${first} dark (page luminance ${before.toFixed(2)} → ${afterClick.toFixed(2)}).`);
        else if (!toggle.persists) add('error', 'toggle-forgets', first, 'light', 'desktop', `The theme toggle (${toggle.label}) works, but after a reload ${first} is light again: the choice isn't remembered.`);
        else if (toggle.first_frame_light) add('error', 'theme-flash', first, 'light', 'desktop', `After choosing dark and reloading, ${first} paints light first and turns dark only when its script runs: a white flash on every page load. Set the theme from a small inline script in <head>, before the page paints.`);
        else if (!toggle.head_script) add('warn', 'theme-flash-risk', first, 'light', 'desktop', `The saved theme isn't applied by an inline script in <head>; on a slow connection the page may paint in the wrong theme first.`);
        if (!toggle.in_header) add('warn', 'toggle-not-in-header', first, 'light', 'desktop', `The theme toggle (${toggle.label}) isn't in the header or nav.`);
      } else add('warn', 'no-toggle', first, 'light', 'desktop', `No theme toggle found on ${first} (a button or switch labelled dark, light, theme or mode).`);
      await p.close();
    }
    // the sheet: per page, light and dark, phone and desktop, problems boxed (plain: no boxes)
    const sheet = resolve(out + '-sheet.png');
    const cell = (page, scheme, vname, w) => { const s = shots[`${page}|${scheme}|${vname}`]; if (!s) return ''; const k = w / s.w;
      const marks = plain ? '' : issues.filter((i) => i.page === page && i.scheme === scheme && i.view === vname && i.box).map((i) => `<div style="position:absolute;left:${i.box.x * k - 2}px;top:${i.box.y * k - 2}px;width:${Math.max(6, i.box.w * k + 4)}px;height:${Math.max(6, i.box.h * k + 4)}px;outline:3px solid ${i.level === 'error' ? '#e0103a' : '#f5a000'}"></div>`).join('');
      return `<div class="v"><div class="lab">${scheme} · ${VIEWS[vname].label}</div><div class="frame" style="width:${w}px;height:${Math.min(s.h * k, vname === 'phone' ? 1500 : 1000)}px"><img src="data:image/png;base64,${s.b64}" style="width:${w}px;display:block">${marks}</div></div>`; };
    const rows = list.map((page) => `<h2>${page}</h2><div class="row">${cell(page, 'light', 'phone', 250)}${cell(page, 'dark', 'phone', 250)}${cell(page, 'light', 'desktop', 520)}${cell(page, 'dark', 'desktop', 520)}</div>`).join('');
    const tg = shots.toggle?.length ? `<h2>Theme toggle on ${list[0]} (system set to light; desktop)</h2><div class="row">${shots.toggle.map((t) => `<div class="v"><div class="lab">${t.label}</div><div class="frame" style="width:380px;height:240px"><img src="data:image/png;base64,${t.b64}" style="width:380px;display:block"></div></div>`).join('')}</div>` : '';
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:24px;background:#d9d8d4;font:14px/1.4 -apple-system,Helvetica,Arial,sans-serif;color:#222;width:1700px}h2{font:600 13px/1 -apple-system,Helvetica;letter-spacing:.08em;text-transform:uppercase;color:#444;margin:26px 0 10px}.row{display:flex;gap:18px;align-items:flex-start}.lab{font-size:11px;color:#555;margin-bottom:4px}.frame{position:relative;overflow:hidden;border:1px solid #999;background:#888}</style></head><body>${rows}${tg}</body></html>`;
    const sp = await browser.newPage(); await sp.setViewport({ width: 1760, height: 1000, deviceScaleFactor: 1 });
    await sp.setContent(html, { waitUntil: 'load' }); await new Promise((r) => setTimeout(r, 300));
    await sp.screenshot({ path: sheet, fullPage: true });
    const errors = issues.filter((i) => i.level === 'error').length, warnings = issues.filter((i) => i.level === 'warn').length;
    return { ok: errors === 0, errors, warnings, pages: summary, toggle, issues: issues.map(({ box, ...i }) => i), sheet };
  } finally { await browser.close(); server.close(); }
}

// ---------- self-test ----------
async function selfTest() {
  const d = mkdtempSync(join(tmpdir(), 'theme-test-'));
  // a dark logo on a transparent background, and a screenshot with a white background, drawn by Chrome
  const b = await launch(); const pg = await b.newPage();
  await pg.setViewport({ width: 200, height: 60 }); await pg.setContent('<body style="margin:0;background:transparent"><div style="font:bold 34px Helvetica;color:#1d1d1f;padding:8px">Tern</div></body>');
  writeFileSync(join(d, 'logo.png'), await pg.screenshot({ type: 'png', omitBackground: true }));
  await pg.setViewport({ width: 300, height: 180 }); await pg.setContent('<body style="margin:0;background:#fff"><div style="margin:20px;height:120px;border:1px solid #ccc;font:14px Helvetica;padding:10px">Dashboard</div></body>');
  writeFileSync(join(d, 'shot.png'), await pg.screenshot({ type: 'png' })); await b.close();
  const page = (css, js, head = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tern</title>${head}<style>${css}</style></head><body><header><img src="logo.png" alt="Tern" width="100" height="30"><button id="theme" aria-label="Toggle dark mode">◐</button></header><main><h1>Hello</h1><p class="muted">Small print that is grey.</p><img src="shot.png" alt="A dashboard" width="300" height="180"><form><input id="name" placeholder="Your name"><input type="date"></form><a href="#">A link</a><pre>const x = 1;</pre></main>${js}</body></html>`;
  const base = 'body{font:16px Helvetica;margin:0;background:#fff;color:#1d1d1f}header{display:flex;justify-content:space-between;padding:12px}main{padding:16px}.muted{color:#6b6b6b}input{border:1px solid #767676;background:#fff;color:#1d1d1f;padding:8px;margin:4px}a{color:#0645ad}pre{background:#f4f4f4;padding:10px}';
  // bad: dark colours for the page but grey text, link and code left as they were, white fields, no focus ring, a toggle that forgets
  const bad = base + '@media (prefers-color-scheme: dark){body{background:#121212;color:#eee}.muted{color:#555}a{color:#0645ad}input{border-color:#2a2a2a}}html.dark body{background:#121212;color:#eee}*:focus{outline:none}';
  writeFileSync(join(d, 'index.html'), page(bad, `<script>document.getElementById('theme').onclick=()=>document.documentElement.classList.toggle('dark')</script>`));
  const r = await check(d, { out: join(d, 'look/bad') });
  const got = new Set(r.issues.map((i) => i.id));
  for (const want of ['text-contrast', 'image-vanishes', 'image-glare', 'field-light', 'no-color-scheme', 'block-bright', 'focus-invisible', 'toggle-forgets']) if (!got.has(want)) throw new Error(`bad site: expected ${want}, got ${[...got].join(', ')}`);
  if (!existsSync(r.sheet)) throw new Error('no sheet');
  // good: real dark colours, color-scheme, a light logo filter, a dimmed screenshot with a border, a visible focus ring,
  // and a toggle that saves the choice, applied by an inline script in <head>
  const good = base + `:root{color-scheme:light dark}*:focus-visible{outline:3px solid #2f6fde;outline-offset:2px}
@media (prefers-color-scheme: dark){:root:not([data-theme=light]){color-scheme:dark}:root:not([data-theme=light]) body{background:#121212;color:#eee}:root:not([data-theme=light]) .muted{color:#a8a8a8}:root:not([data-theme=light]) a{color:#8ab4f8}:root:not([data-theme=light]) input{background:#1e1e1e;color:#eee;border-color:#8a8a8a}:root:not([data-theme=light]) input::placeholder{color:#a8a8a8}:root:not([data-theme=light]) pre{background:#1e1e1e}:root:not([data-theme=light]) header img{filter:invert(1)}:root:not([data-theme=light]) main img{filter:brightness(.8);border:1px solid #444}:root:not([data-theme=light]) *:focus-visible{outline-color:#8ab4f8}}
:root[data-theme=dark]{color-scheme:dark}:root[data-theme=dark] body{background:#121212;color:#eee}:root[data-theme=dark] .muted{color:#a8a8a8}:root[data-theme=dark] a{color:#8ab4f8}:root[data-theme=dark] input{background:#1e1e1e;color:#eee;border-color:#8a8a8a}:root[data-theme=dark] input::placeholder{color:#a8a8a8}:root[data-theme=dark] pre{background:#1e1e1e}:root[data-theme=dark] header img{filter:invert(1)}:root[data-theme=dark] main img{filter:brightness(.8)}:root[data-theme=dark] *:focus-visible{outline-color:#8ab4f8}`;
  const headJs = `<script>try{var t=localStorage.getItem('theme');if(t)document.documentElement.dataset.theme=t}catch(e){}</script><meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#121212" media="(prefers-color-scheme: dark)">`;
  writeFileSync(join(d, 'index.html'), page(good, `<script>document.getElementById('theme').onclick=()=>{var r=document.documentElement,d=r.dataset.theme==='dark'||(!r.dataset.theme&&matchMedia('(prefers-color-scheme: dark)').matches);r.dataset.theme=d?'light':'dark';localStorage.setItem('theme',r.dataset.theme)}</script>`, headJs));
  const g = await check(d, { out: join(d, 'look/good') });
  if (g.errors) throw new Error('fixed site flagged: ' + g.issues.filter((i) => i.level === 'error').map((i) => `${i.id} ${i.msg}`).join(' | '));
  console.log(`theme-check: all tests pass (bad: ${[...got].join(', ')}; fixed: ${g.warnings} warnings: ${g.issues.map((i) => i.id).join(', ')})`);
}

if (typeof process !== 'undefined' && process.argv?.[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
  const VALUED = new Set(['--out', '--pages']);
  const pos = argv.filter((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1]));
  const done = (r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); };
  const fail = (e) => { console.error(String(e.message || e)); process.exit(2); };
  if (argv.includes('--test')) selfTest().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
  else if (pos[0] === 'check' && pos[1]) check(pos[1], { pages: opt('pages') ? opt('pages').split(',') : null, out: opt('out', 'look/theme') }).then(done, fail);
  else fail('usage: theme-check.mjs check <site folder> [--pages index.html,contact.html] [--out look/theme]\n       theme-check.mjs --test');
}
