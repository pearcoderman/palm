#!/usr/bin/env node
// Palm tool: merch-check — lets an agent see print-on-demand files (T-shirt front, 11 oz mug wrap, die-cut sticker) the
// way they'll print at Printful or Printify, and measures what an agent can't see on a screen: semi-transparent pixels
// (soft shadows, glows, fades) that DTG prints as speckled halos, resolution at the print size, the mug wrap's canvas,
// a background left in, lines and text too thin or small at print size, colours that vanish on a shirt colour, stray
// pixels, and the sticker's cut line.
//
//   node merch-check.mjs check print/ [--provider printful|printify] [--colors black,navy,athletic-heather]
//                                [--sticker 3] [--out look/merch] [--plain]
//       → JSON {ok, errors, warnings, files, issues, sheet}. Then LOOK at <out>-sheet.png.
//       Each PNG/JPEG's product comes from its name: shirt|tee|tshirt|hoodie|front → shirt front; mug → 11 oz mug wrap;
//       sticker → die-cut sticker (size from the name, e.g. sticker-3in, else --sticker, else 3 in). A shirt file is
//       checked against the shirt colours in its name (black, navy, heather/grey, white; "dark" = black + navy;
//       "light" = white + athletic heather), else every colour in --colors (default white, black, athletic heather, navy).
//       A file's HTML/SVG source beside it (same name) lets the tool measure its text exactly; without one, Tesseract
//       OCR (if installed) gives Palm's estimate.
//   node merch-check.mjs render design.html --size 4500x5400 --out print/shirt-front.png
//       → renders the HTML at exactly that size as a PNG with a transparent background (leave html/body unpainted).
//   node merch-check.mjs --test
//
// Printful's rules used here (read 2026-11-26 in a browser):
//   Unisex Staple T-Shirt | Bella + Canvas 3001, product page, File guidelines (DTG): Front print area 29.21 × 35.05 cm
//   (11.5 × 13.8 in) for XS–M, 38.10 × 45.72 cm (15 × 18 in) from size L; "Submit files in PNG or JPEG format with at least
//   150 DPI"; "Create files in sRGB color profile"; "Avoid semi-transparent designs … don't translate well in DTG printing.
//   We advise using solid colors, or simulating semi-transparency by halftoning"; "Black ink will appear gray on black
//   garments because of the white underbase … Leave these areas fully transparent"; "We do not print white ink on white
//   garments". Garment colours: Printful's catalogue colour codes for that shirt (White #ffffff, Black #0c0c0c, Athletic
//   Heather #cececc, Dark Grey Heather #3e3c3d, Navy #212642).
//   White Glossy Mug, File guidelines: 11 oz print file 22.86 × 8.89 cm (9 × 3.5 in; "may vary by +/- 0.1″"), PNG or JPEG
//   with at least 300 DPI, sRGB; "avoid using tiny details or text … Bold lines and graphics usually work best for mugs".
//   Mug size 3.8″ tall, 3.2″ across (catalogue).
//   Die-Cut Stickers, File guidelines: 2, 3, 4, 5 or 6 in square print files, PNG or JPEG with at least 300 DPI; "We'll add
//   a white border around the edge of the object during printing"; "Keep only the background transparent—any other
//   transparent details will be printed white"; "make sure there are no rogue pixels still visible outside the outline";
//   "If you want a solid square or circle sticker, fill the entire print area … Otherwise, your sticker will be trimmed
//   around the edges of your artwork".
//   Help Center, "How should I prepare my print file for the best results?": PNG for DTG ("JPEG files don't support
//   transparency … may appear with a visible white background"); 150–300 DPI by product; files up to 200 MB and
//   20,000 × 20,000 px; "Avoid semi-transparent edges or fades for DTG/DTF printing"; "Semi-transparent effects like
//   shadows, fades, smoke, glow effects, and low-opacity textures may not print the way they appear on screen"; very small
//   text or thin lines blur or fade into the fabric; light designs on light products and dark on dark lose contrast.
//   "Transparency in DTG printing": semi-transparent areas print with "a lot of gaps with a visible white base. This is
//   most evident on dark fabrics."
// Printify's rules (Help Center, read 2026-11-26): JPEG, PNG and SVG; "The recommended resolution for JPEG/PNG files is 300
//   DPI; however, a lower resolution file might also be sufficient (depending on the product)"; 100 MB max for JPEG/PNG.
//   Each product's print-area size is shown only in Printify's Product Creator (behind a login, not read here), so the
//   print areas above are Printful's; pass the size Printify shows if it differs. Kiss-cut stickers: PNG with a
//   transparent background, "no residue or specks"; elements far apart are cut separately (65–200 px apart by size).
// Palm's measurement and thresholds (not Printful's or Printify's): a pixel is semi-transparent at alpha 8–247 and "soft"
//   when it's more than 2 px from any solid pixel (anti-aliased edges are fine); a shirt file fails above 0.3% soft
//   pixels; lines under 0.5 mm (shirt) or 0.3 mm (mug, sticker) at print size; text under 10 pt (shirt), 8 pt (mug) or 7 pt
//   (sticker) at print size; a colour "vanishes" on a garment under 1.6:1 contrast (WCAG formula) and a file warns when 15%
//   or more of its ink does; a shirt file is placed at the largest size its print area allows; the sticker's white border
//   ≈ 1/8 in; the mug wrap's two ends meet at the handle (so each half of the file is one face of the mug); the DTG preview
//   (semi-transparent pixels as speckles of white underbase on coloured shirts, solid black as dark grey on black) is
//   Palm's approximation of what Printful describes.
// adds: tool. Runs on the user's machine with their Chrome/Edge/Chromium; nothing leaves it.

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { inflateSync } from 'node:zlib';

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
const launch = () => loadPuppeteer().launch({ executablePath: findChrome(), headless: true, timeout: 90000, protocolTimeout: 600000, args: ['--no-sandbox', '--hide-scrollbars', '--allow-file-access-from-files', '--force-color-profile=srgb'] });

const issue = (id, level, msg, fix, file) => ({ id, level, file, msg, fix });
const round = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d;
const pct = (x) => `${round(x * 100)}%`;

// ---------- products and garments ----------
export const PRODUCTS = {
  shirt: { label: 'T-shirt front print (DTG)', area: [15, 18], areaSmall: [11.5, 13.8], dpi: { printful: 150, printify: 300 }, thinMm: 0.5, textPt: 10 },
  mug: { label: '11 oz mug wrap (sublimation)', area: [9, 3.5], dpi: { printful: 300, printify: 300 }, thinMm: 0.3, textPt: 8 },
  sticker: { label: 'die-cut sticker', sizes: [2, 3, 4, 5, 6], dpi: { printful: 300, printify: 300 }, thinMm: 0.3, textPt: 7 },
};
export const GARMENTS = { white: '#ffffff', black: '#0c0c0c', 'athletic-heather': '#cececc', 'dark-grey-heather': '#3e3c3d', navy: '#212642' };
const LIMITS = { printful: { mb: 200, px: 20000 }, printify: { mb: 100, px: null } };
export function productOf(name) {
  const n = name.toLowerCase();
  if (/mug/.test(n)) return 'mug';
  if (/sticker|decal/.test(n)) return 'sticker';
  if (/shirt|tee|hoodie|sweat|front|apparel|dtg/.test(n)) return 'shirt';
  return null;
}
export function coloursOf(name, list) {
  const n = name.toLowerCase().replace(/[_\s]+/g, '-'), out = new Set();
  if (/black/.test(n)) out.add('black');
  if (/navy/.test(n)) out.add('navy');
  if (/dark-?gr[ae]y/.test(n)) out.add('dark-grey-heather');
  else if (/heather|gr[ae]y|athletic|ash/.test(n)) out.add('athletic-heather');
  if (/white/.test(n)) out.add('white');
  if (/(^|[^a-z])dark([^a-z]|$)/.test(n)) { out.add('black'); out.add('navy'); }
  if (/(^|[^a-z])light([^a-z]|$)/.test(n)) { out.add('white'); out.add('athletic-heather'); }
  const keep = [...out].filter((k) => list.includes(k) || !/(^|[^a-z])(dark|light)([^a-z]|$)/.test(n));
  return keep.length ? keep : list;
}

// ---------- the file: format, size, colour profile ----------
export function fileInfo(b) {
  const o = { format: 'unknown' };
  if (!b || b.length < 24) return o;
  if (b.readUInt32BE(0) === 0x89504e47) {
    Object.assign(o, { format: 'png', w: b.readUInt32BE(16), h: b.readUInt32BE(20) });
    const ct = b[25]; o.alpha = ct === 4 || ct === 6;
    for (let i = 8; i + 8 < b.length;) {
      const len = b.readUInt32BE(i), type = b.toString('latin1', i + 4, i + 8);
      if (type === 'tRNS') o.alpha = true;
      if (type === 'sRGB') o.icc = 'sRGB';
      if (type === 'iCCP') { const z = b.indexOf(0, i + 8); o.icc = b.toString('latin1', i + 8, z); try { const prof = inflateSync(b.subarray(z + 2, i + 8 + len)); const t = prof.toString('latin1'); const m = t.match(/sRGB[ -~]{0,30}|Display P3|Adobe RGB[ -~]{0,10}|Generic RGB|ProPhoto/); if (m) o.icc = m[0].replace(/\0/g, '').trim(); } catch { /* name only */ } }
      if (type === 'IEND') break;
      i += 12 + len;
    }
    return o;
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    o.format = 'jpeg'; o.alpha = false;
    for (let i = 2; i < b.length - 9;) {
      if (b[i] !== 0xff) { i++; continue; }
      const mk = b[i + 1]; if (mk === 0xd8 || mk === 0x01 || mk === 0xff || (mk >= 0xd0 && mk <= 0xd7)) { i += mk === 0xff ? 1 : 2; continue; }
      if (mk === 0xda) break;
      const len = b.readUInt16BE(i + 2);
      if (mk === 0xe2 && b.toString('latin1', i + 4, i + 16) === 'ICC_PROFILE\0') { const t = b.toString('latin1', i + 18, i + 2 + len); const m = t.match(/sRGB[ -~]{0,30}|Display P3|Adobe RGB[ -~]{0,10}|Generic RGB|ProPhoto/); o.icc = m ? m[0].trim() : 'embedded profile'; }
      if (mk >= 0xc0 && mk <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(mk)) { o.h = b.readUInt16BE(i + 5); o.w = b.readUInt16BE(i + 7); o.mode = b[i + 9] === 4 ? 'cmyk' : b[i + 9] === 1 ? 'grayscale' : 'rgb'; }
      i += 2 + len;
    }
    return o;
  }
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return { format: 'webp' };
  if (b.toString('latin1', 0, 4) === '%PDF') return { format: 'pdf' };
  if (/<svg/i.test(b.toString('utf8', 0, 2000))) return { format: 'svg' };
  return o;
}

// ---------- text: from the HTML/SVG source, or Tesseract OCR ----------
async function measureSource(page, src, img) {
  const url = pathToFileURL(resolve(src)).href;
  const load = async (w, h) => { await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 }); await page.goto(url, { waitUntil: 'load', timeout: 60000 }); await page.evaluate(() => document.fonts?.ready); await new Promise((r) => setTimeout(r, 150)); };
  await load(img.w, img.h);
  // a source drawn at a smaller CSS size (e.g. 1x CSS rendered at 2x) is measured at its own size, then scaled
  const ext = await page.evaluate(() => { let r = 0, b = 0; for (const e of document.querySelectorAll('body *, svg')) { const q = e.getBoundingClientRect(); if (q.width && q.height) { r = Math.max(r, q.right); b = Math.max(b, q.bottom); } } const s = document.documentElement; return { r, b, sw: s.scrollWidth, sh: s.scrollHeight }; });
  let W = img.w;
  if (ext.r > 50 && ext.r < img.w * 0.8 && Math.abs(ext.r / Math.max(1, ext.b) - img.w / img.h) < 0.05) { W = Math.round(ext.r); await load(W, Math.round(ext.b)); }
  const boxes = await page.evaluate(() => {
    const out = [];
    for (const e of document.querySelectorAll('body *, svg *')) {
      const s = getComputedStyle(e); if (s.visibility === 'hidden' || s.display === 'none' || +s.opacity <= 0.05) continue;
      if (e.closest('title,desc,style,script,defs')) continue;
      const own = [...e.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()); if (!own.length) continue;
      const rg = document.createRange(); rg.selectNodeContents(e); const rects = [...rg.getClientRects()].filter((r) => r.width > 1 && r.height > 1); if (!rects.length) continue;
      const r = rg.getBoundingClientRect();
      let fs = parseFloat(s.fontSize);
      if (e instanceof SVGElement && e.getScreenCTM) { const m = e.getScreenCTM(); if (m) fs *= Math.hypot(m.a, m.b); }
      else { let t = e, k = 1; while (t && t.nodeType === 1) { const tr = getComputedStyle(t).transform; if (tr && tr !== 'none') { const m = new DOMMatrix(tr); k *= Math.hypot(m.a, m.b); } t = t.parentElement; } fs *= k; }
      out.push({ t: own.map((n) => n.textContent.trim()).join(' ').replace(/\s+/g, ' ').slice(0, 60), x: r.left, y: r.top, w: r.width, h: r.height, fs });
    }
    return out;
  });
  const k = img.w / W;
  for (const b of boxes) { b.x *= k; b.y *= k; b.w *= k; b.h *= k; b.fs *= k; }
  return boxes;
}
function hasTesseract() { try { execFileSync('tesseract', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } }
function ocrBoxes(file) {
  const tsv = execFileSync('tesseract', [file, 'stdout', '--psm', '11', 'tsv'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64e6 });
  const words = [];
  for (const line of tsv.split('\n').slice(1)) {
    const c = line.split('\t'); if (c.length < 12 || c[0] !== '5') continue;
    const t = c[11].trim(), conf = +c[10];
    if (conf < 70 || (t.match(/[\p{L}\p{N}]/gu) || []).length < 2 || +c[9] < 6) continue;
    words.push({ t, x: +c[6], y: +c[7], w: +c[8], h: +c[9] });
  }
  words.sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const wd of words) {
    const L = lines.find((l) => Math.min(l.y + l.h, wd.y + wd.h) - Math.max(l.y, wd.y) > 0.5 * Math.min(l.h, wd.h) && wd.x - (l.x + l.w) < 1.5 * Math.max(l.h, wd.h) && wd.x + wd.w > l.x);
    if (L) { const x2 = Math.max(L.x + L.w, wd.x + wd.w), y2 = Math.max(L.y + L.h, wd.y + wd.h); L.x = Math.min(L.x, wd.x); L.y = Math.min(L.y, wd.y); L.w = x2 - L.x; L.h = y2 - L.y; L.t += ' ' + wd.t; L.maxh = Math.max(L.maxh, wd.h); }
    else lines.push({ ...wd, maxh: wd.h });
  }
  // Palm's estimate: a word's box height ÷ 0.75 ≈ its font size
  return lines.map((l) => ({ t: l.t.slice(0, 60), x: l.x, y: l.y, w: l.w, h: l.h, fs: l.maxh / 0.75, ocr: true }));
}

// ---------- pixels: measured in Chrome (decode + canvas), one function injected into the page ----------
function pageLib() {
  const INF = 1e20;
  function dt1(f, n, d, v, z) {
    let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
    for (let q = 1; q < n; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; const r = q - v[k]; d[q] = r * r + f[v[k]]; }
  }
  // squared Euclidean distance from every pixel to the nearest pixel where T is 1
  function edt(T, W, H) {
    const n = Math.max(W, H), f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1), out = new Float32Array(W * H);
    for (let X = 0; X < W; X++) { for (let y = 0; y < H; y++) f[y] = T[y * W + X] ? 0 : INF; dt1(f, H, d, v, z); for (let y = 0; y < H; y++) out[y * W + X] = d[y]; }
    for (let y = 0; y < H; y++) { const o = y * W; for (let X = 0; X < W; X++) f[X] = out[o + X]; dt1(f, W, d, v, z); for (let X = 0; X < W; X++) out[o + X] = d[X]; }
    return out;
  }
  // connected components (8-way) of M; per component: pixel count, box, boundary pixels (4-way edge)
  function comps(M, W, H) {
    const lab = new Int32Array(W * H).fill(-1), list = [], st = new Int32Array(W * H);
    for (let s = 0; s < W * H; s++) {
      if (!M[s] || lab[s] >= 0) continue;
      const id = list.length; let sp = 0; st[sp++] = s; lab[s] = id; let n = 0, per = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
      while (sp) {
        const p = st[--sp]; n++; const px = p % W, py = (p - px) / W;
        if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
        if (px === 0 || py === 0 || px === W - 1 || py === H - 1 || !M[p - 1] || !M[p + 1] || !M[p - W] || !M[p + W]) per++;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { if (!dx && !dy) continue; const nx = px + dx, ny = py + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue; const k = ny * W + nx; if (M[k] && lab[k] < 0) { lab[k] = id; st[sp++] = k; } }
      }
      list.push({ id, n, per, x0, y0, x1: x1 + 1, y1: y1 + 1 });
    }
    return { lab, list };
  }
  const lum = (r, g, b) => { const f = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const contrast = (a, b) => { const L1 = lum(...a), L2 = lum(...b); return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05); };
  const hex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  const rgbOf = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const hash = (i) => { let x = (i ^ 0x9e3779b9) * 0x85ebca6b; x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35); x ^= x >>> 16; return (x >>> 0) / 4294967296; };
  const toUrl = (cv) => cv.toDataURL('image/png');
  const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; };

  window.palmMerch = async (src, o) => {
    const im = new Image(); im.src = src; await im.decode();
    const W = im.naturalWidth, H = im.naturalHeight, N = W * H;
    const c0 = canvas(W, H), x0 = c0.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' }); x0.drawImage(im, 0, 0);
    const d = x0.getImageData(0, 0, W, H).data;
    const res = { W, H };
    // --- alpha: solid, semi-transparent, clear; "soft" = semi-transparent and more than 2 px from any solid pixel
    const solid = new Uint8Array(N); let nSolid = 0, nPart = 0, nClear = 0;
    for (let i = 0; i < N; i++) { const a = d[i * 4 + 3]; if (a >= 248) { solid[i] = 1; nSolid++; } else if (a >= 8) nPart++; else nClear++; }
    const dSolid = edt(solid, W, H), soft = new Uint8Array(N);
    let nSoft = 0, nHalo = 0, sx0 = 1e9, sy0 = 1e9, sx1 = -1, sy1 = -1, softAlpha = 0;
    const haloR2 = (0.15 * o.dpi) ** 2;
    for (let i = 0; i < N; i++) { const a = d[i * 4 + 3]; if (a >= 8 && a < 248 && dSolid[i] > 5) { soft[i] = 1; nSoft++; softAlpha += a; if (dSolid[i] <= haloR2) nHalo++; const X = i % W, y = (i - X) / W; if (X < sx0) sx0 = X; if (X > sx1) sx1 = X; if (y < sy0) sy0 = y; if (y > sy1) sy1 = y; } }
    const ink = nSolid + nPart;
    res.alpha = { solid: nSolid, semi: nPart, clear: nClear, soft: nSoft, halo: nHalo, soft_share: ink ? nSoft / ink : 0, soft_mean_alpha: nSoft ? Math.round(softAlpha / nSoft) : null, soft_box: nSoft ? { x: sx0, y: sy0, w: sx1 - sx0 + 1, h: sy1 - sy0 + 1 } : null };
    // --- the ink box (alpha ≥ 26) and the border ring
    let ix0 = 1e9, iy0 = 1e9, ix1 = -1, iy1 = -1;
    for (let i = 0; i < N; i++) if (d[i * 4 + 3] >= 26) { const X = i % W, y = (i - X) / W; if (X < ix0) ix0 = X; if (X > ix1) ix1 = X; if (y < iy0) iy0 = y; if (y > iy1) iy1 = y; }
    res.ink_box = ix1 >= 0 ? { x: ix0, y: iy0, w: ix1 - ix0 + 1, h: iy1 - iy0 + 1 } : null;
    const ring = Math.max(2, Math.round(Math.max(W, H) * 0.01)); const rc = [[], [], [], []];
    for (let y = 0; y < H; y += 2) for (let X = 0; X < W; X += 2) { if (X >= ring && y >= ring && X < W - ring && y < H - ring) continue; const i = (y * W + X) * 4; for (let ch = 0; ch < 4; ch++) rc[ch].push(d[i + ch]); }
    const med = rc.map((v) => v.sort((a, b) => a - b)[v.length >> 1]);
    let same = 0, ringN = rc[0].length; for (let k = 0; k < ringN; k++) if (Math.abs(rc[0][k] - med[0]) + Math.abs(rc[1][k] - med[1]) + Math.abs(rc[2][k] - med[2]) <= 18 && rc[3][k] >= 248) same++;
    res.ring = { rgb: med.slice(0, 3), alpha: med[3], uniform: ringN ? same / ringN : 0 };
    // a filled box behind the design: the largest solid component is (nearly) a rectangle with a uniform edge colour
    // --- analysis grid (≤ 6 Mpx) for strokes, colours, pieces
    const k = Math.min(1, Math.sqrt(6e6 / N)), GW = Math.max(1, Math.round(W * k)), GH = Math.max(1, Math.round(H * k)), dpiG = o.dpi * (GW / W);
    let g = d;
    if (k < 1) { const cg = canvas(GW, GH), xg = cg.getContext('2d', { willReadFrequently: true }); xg.imageSmoothingEnabled = false; xg.drawImage(im, 0, 0, GW, GH); g = xg.getImageData(0, 0, GW, GH).data; }
    const GN = GW * GH, shape = new Uint8Array(GN); for (let i = 0; i < GN; i++) shape[i] = g[i * 4 + 3] >= 128 ? 1 : 0;
    // colours: clusters from "core" pixels (solid, and like their 4 neighbours), so anti-aliased blends don't count
    const bins = new Map();
    const near = (i, j) => Math.abs(g[i * 4] - g[j * 4]) + Math.abs(g[i * 4 + 1] - g[j * 4 + 1]) + Math.abs(g[i * 4 + 2] - g[j * 4 + 2]) <= 30;
    let coreN = 0;
    for (let y = 1; y < GH - 1; y++) for (let X = 1; X < GW - 1; X++) {
      const i = y * GW + X; if (g[i * 4 + 3] < 248) continue;
      // like its neighbours along one axis at least (so a 1-px hairline counts; a blend across an edge doesn't)
      if (!((near(i, i - 1) && near(i, i + 1) && g[(i - 1) * 4 + 3] >= 248 && g[(i + 1) * 4 + 3] >= 248) || (near(i, i - GW) && near(i, i + GW) && g[(i - GW) * 4 + 3] >= 248 && g[(i + GW) * 4 + 3] >= 248))) continue;
      coreN++; const key = (g[i * 4] >> 4) << 8 | (g[i * 4 + 1] >> 4) << 4 | (g[i * 4 + 2] >> 4);
      const b = bins.get(key) || [0, 0, 0, 0]; b[0]++; b[1] += g[i * 4]; b[2] += g[i * 4 + 1]; b[3] += g[i * 4 + 2]; bins.set(key, b);
    }
    const cl = [];
    for (const b of [...bins.values()].sort((p, q) => q[0] - p[0])) {
      const m = [b[1] / b[0], b[2] / b[0], b[3] / b[0]];
      const t = cl.find((c) => Math.hypot(c.rgb[0] - m[0], c.rgb[1] - m[1], c.rgb[2] - m[2]) < 48);
      if (t) { const n = t.n + b[0]; t.rgb = t.rgb.map((v, j) => (v * t.n + m[j] * b[0]) / n); t.n = n; } else cl.push({ rgb: m, n: b[0] });
    }
    const clusters = cl.filter((c) => coreN && c.n / coreN >= 0.005).slice(0, 8);
    // assign every solid pixel to its nearest cluster (within 60), count the true shares
    const owner = new Uint8Array(GN).fill(255), cnt = new Array(clusters.length).fill(0); let inkG = 0;
    for (let i = 0; i < GN; i++) {
      if (g[i * 4 + 3] < 128) continue; inkG++;
      let best = 255, bd = 60;
      for (let j = 0; j < clusters.length; j++) { const c = clusters[j].rgb; const dd = Math.hypot(c[0] - g[i * 4], c[1] - g[i * 4 + 1], c[2] - g[i * 4 + 2]); if (dd < bd) { bd = dd; best = j; } }
      owner[i] = best; if (best < 255) cnt[best]++;
    }
    res.colours = clusters.map((c, j) => ({ hex: hex(c.rgb), rgb: c.rgb.map(Math.round), share: inkG ? cnt[j] / inkG : 0 })).filter((c) => c.share >= 0.004).sort((a, b) => b.share - a.share);
    // contrast of each colour against each garment
    res.garments = (o.garments || []).map((gm) => {
      const G = rgbOf(gm.hex); let vanish = 0, weak = 0, blackOnBlack = 0, whiteOnWhite = 0;
      for (const c of res.colours) { const cr = contrast(c.rgb, G); if (cr < 1.6) vanish += c.share; else if (cr < 2.5) weak += c.share; if (lum(...G) < 0.03 && lum(...c.rgb) < 0.012) blackOnBlack += c.share; if (lum(...G) > 0.9 && c.rgb.every((v) => v >= 245)) whiteOnWhite += c.share; }
      return { key: gm.key, hex: gm.hex, vanish, weak, black_on_black: blackOnBlack, white_on_white: whiteOnWhite, worst: res.colours.map((c) => ({ hex: c.hex, share: c.share, contrast: Math.round(contrast(c.rgb, G) * 100) / 100 })).sort((a, b) => a.contrast - b.contrast).slice(0, 3) };
    });
    // --- background left in / a box behind the design
    const bgFull = nClear / N < 0.001 && res.ring.uniform > 0.9;
    let box = null;
    { const cc = comps(shape, GW, GH); const big = cc.list.sort((a, b) => b.n - a.n)[0];
      if (big) { const area = (big.x1 - big.x0) * (big.y1 - big.y0); if (big.n / area > 0.97 && area > 0.2 * GN && !bgFull) {
        // uniform colour along the box's edge?
        const e = []; for (let X = big.x0; X < big.x1; X += 3) for (const y of [big.y0 + 1, big.y1 - 2]) { const i = (y * GW + X) * 4; e.push([g[i], g[i + 1], g[i + 2]]); }
        const m = [0, 1, 2].map((ch) => e.map((p) => p[ch]).sort((a, b) => a - b)[e.length >> 1]); const u = e.filter((p) => Math.abs(p[0] - m[0]) + Math.abs(p[1] - m[1]) + Math.abs(p[2] - m[2]) <= 18).length / e.length;
        // only a white or black box with a design inside it (a coloured badge or panel is a design choice)
        let other = 0, seen = 0; if (m.every((v) => v >= 235) || m.every((v) => v <= 25)) for (let y = big.y0; y < big.y1; y += 2) for (let X = big.x0; X < big.x1; X += 2) { const i = (y * GW + X) * 4; seen++; if (Math.abs(g[i] - m[0]) + Math.abs(g[i + 1] - m[1]) + Math.abs(g[i + 2] - m[2]) > 60) other++; }
        if (u > 0.9 && seen && other / seen > 0.03) box = { x: big.x0 / k, y: big.y0 / k, w: (big.x1 - big.x0) / k, h: (big.y1 - big.y0) / k, rgb: m }; } }
      // specks: small solid components far from everything else
      const list = cc.list, total = list.reduce((s, q) => s + q.n, 0), far = 0.4 * dpiG, specks = []; // 0.4 in: a tagline's middle dot isn't a speck
      for (const q of list) {
        if (q.n > total * 0.003 || q.n > (0.06 * dpiG) ** 2) continue;
        const cx = (q.x0 + q.x1) / 2, cy = (q.y0 + q.y1) / 2;
        const close = list.some((p) => p !== q && p.n >= q.n && cx > p.x0 - far && cx < p.x1 + far && cy > p.y0 - far && cy < p.y1 + far);
        if (!close) specks.push({ x: Math.round(q.x0 / k), y: Math.round(q.y0 / k), w: Math.max(1, Math.round((q.x1 - q.x0) / k)), h: Math.max(1, Math.round((q.y1 - q.y0) / k)) });
      }
      res.specks = specks.slice(0, 20); res.speck_count = specks.length; res.parts = list.length; }
    res.background = bgFull ? { kind: 'full', rgb: res.ring.rgb } : box ? { kind: 'box', ...box } : null;
    // --- thin parts: what an opening with a disc of the minimum width removes, per colour and for the whole shape
    const r = o.thinMm / 25.4 * dpiG / 2; const thin = new Uint8Array(GN); const thinParts = [];
    if (r >= 0.4) {
      const masks = [{ name: 'shape', M: shape, rgb: null }];
      res.colours.forEach((c) => { const j = clusters.findIndex((q) => hex(q.rgb) === c.hex); if (j < 0 || c.share > 0.995) return; const M = new Uint8Array(GN); for (let i = 0; i < GN; i++) if (owner[i] === j) M[i] = 1; masks.push({ name: c.hex, M, rgb: c.rgb }); });
      for (const m of masks) {
        const inv = new Uint8Array(GN); for (let i = 0; i < GN; i++) inv[i] = m.M[i] ? 0 : 1;
        // pixel centres: a line w px wide has pixels at most ~w/2 + 0.5 from the background, so erode by r + 0.5
        const e2 = (r + 0.5) ** 2, dBg = edt(inv, GW, GH), er = new Uint8Array(GN); for (let i = 0; i < GN; i++) er[i] = m.M[i] && dBg[i] > e2 ? 1 : 0;
        const dEr = edt(er, GW, GH), rem = new Uint8Array(GN); for (let i = 0; i < GN; i++) rem[i] = m.M[i] && dEr[i] > e2 ? 1 : 0;
        const cc = comps(rem, GW, GH);
        for (const q of cc.list) {
          // length from its edge pixels: a 1-px line's pixels are edges on both sides (counted twice), a wider line's on one
          let E = 0, D = 0; const inq = (X, y) => X >= 0 && y >= 0 && X < GW && y < GH && cc.lab[y * GW + X] === q.id;
          for (let y = q.y0; y < q.y1; y++) for (let X = q.x0; X < q.x1; X++) { if (cc.lab[y * GW + X] !== q.id) continue; const l = inq(X - 1, y), rr = inq(X + 1, y), u = inq(X, y - 1), dn = inq(X, y + 1); if (!l || !rr || !u || !dn) E++; if ((!l && !rr) || (!u && !dn)) D++; }
          const len = Math.max(1, (E + D) / 2), w = q.n / len;
          if (q.n < Math.max(4 * r * r, 12) || len < Math.max(4 * r, 0.08 * dpiG) || len < 3 * w || w / dpiG * 25.4 >= o.thinMm) continue;
          if (m.rgb) { let dev = 0, nn = 0; for (let y = q.y0; y < q.y1; y++) for (let X = q.x0; X < q.x1; X++) { const i = y * GW + X; if (cc.lab[i] === q.id) { dev += Math.hypot(g[i * 4] - m.rgb[0], g[i * 4 + 1] - m.rgb[1], g[i * 4 + 2] - m.rgb[2]); nn++; } } if (dev / nn > 22) continue; }
          for (let y = q.y0; y < q.y1; y++) for (let X = q.x0; X < q.x1; X++) { const i = y * GW + X; if (cc.lab[i] === q.id) thin[i] = 1; }
          thinParts.push({ colour: m.name, width_mm: Math.round(w / dpiG * 25.4 * 100) / 100, length_in: Math.round(len / dpiG * 100) / 100, x: Math.round(q.x0 / k), y: Math.round(q.y0 / k), w: Math.round((q.x1 - q.x0) / k), h: Math.round((q.y1 - q.y0) / k) });
        }
      }
    }
    thinParts.sort((a, b) => a.width_mm - b.width_mm || b.length_in - a.length_in);
    res.thin = thinParts.slice(0, 12); res.thin_count = thinParts.length; res.thin_r_px = Math.round(r * 100) / 100;
    // --- sticker: white border (≈1/8 in, Palm's estimate) around everything with alpha ≥ 26, holes filled, pieces counted
    let stick = null;
    if (o.product === 'sticker') {
      const b = Math.max(1, Math.round(0.125 * dpiG)), PW = GW + 2 * b, PH = GH + 2 * b, cut = new Uint8Array(PW * PH);
      for (let y = 0; y < GH; y++) for (let X = 0; X < GW; X++) if (g[(y * GW + X) * 4 + 3] >= 26) cut[(y + b) * PW + X + b] = 1;
      const dc = edt(cut, PW, PH), fill = new Uint8Array(PW * PH); for (let i = 0; i < PW * PH; i++) fill[i] = dc[i] <= b * b ? 1 : 0;
      // flood the outside from the edge; what's left unreached (holes) is filled
      const out = new Uint8Array(PW * PH), st = []; for (let X = 0; X < PW; X++) { st.push(X, (PH - 1) * PW + X); } for (let y = 0; y < PH; y++) st.push(y * PW, y * PW + PW - 1);
      while (st.length) { const p = st.pop(); if (out[p] || fill[p]) continue; out[p] = 1; const X = p % PW, y = (p - X) / PW; if (X > 0) st.push(p - 1); if (X < PW - 1) st.push(p + 1); if (y > 0) st.push(p - PW); if (y < PH - 1) st.push(p + PW); }
      let fx0 = 1e9, fy0 = 1e9, fx1 = -1, fy1 = -1; for (let i = 0; i < PW * PH; i++) { fill[i] = out[i] ? 0 : 1; if (fill[i]) { const X = i % PW, y = (i - X) / PW; if (X < fx0) fx0 = X; if (X > fx1) fx1 = X; if (y < fy0) fy0 = y; if (y > fy1) fy1 = y; } }
      const pc = comps(fill, PW, PH);
      const pieces = pc.list.filter((q) => q.n > 0.002 * PW * PH).length;
      // the sticker as cut: white border, the design, the cut line (dark), drawn at grid resolution
      const sc = canvas(PW, PH), sx = sc.getContext('2d'); const id = sx.createImageData(PW, PH), sd = id.data;
      for (let i = 0; i < PW * PH; i++) if (fill[i]) { sd[i * 4] = sd[i * 4 + 1] = sd[i * 4 + 2] = 255; sd[i * 4 + 3] = 255; }
      sx.putImageData(id, 0, 0); sx.drawImage(im, b, b, GW, GH);
      const ln = sx.getImageData(0, 0, PW, PH), ld = ln.data, lw = Math.max(1, Math.round(PW / 300));
      for (let i = 0; i < PW * PH; i++) { if (!fill[i]) continue; const X = i % PW, y = (i - X) / PW; let edge = false; for (let dy = -lw; dy <= lw && !edge; dy++) for (let dx = -lw; dx <= lw; dx++) { const nx = X + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= PW || ny >= PH || !fill[ny * PW + nx]) { edge = true; break; } } if (edge) { ld[i * 4] = 70; ld[i * 4 + 1] = 70; ld[i * 4 + 2] = 76; ld[i * 4 + 3] = 255; } }
      sx.putImageData(ln, 0, 0);
      stick = { pieces, border_px: b, finished_in: { w: Math.round((fx1 - fx0 + 1) / dpiG * 100) / 100, h: Math.round((fy1 - fy0 + 1) / dpiG * 100) / 100 }, pad_in: b / dpiG, url: toUrl(sc), px: { w: PW, h: PH }, crop: { x: fx0, y: fy0, w: fx1 - fx0 + 1, h: fy1 - fy0 + 1 } };
    }
    res.sticker = stick ? { pieces: stick.pieces, finished_in: stick.finished_in } : null;
    // --- pictures for the sheet
    const pics = {};
    const S = Math.min(1, (o.product === 'mug' ? 900 : 380) / W), sw = Math.round(W * S), sh = Math.round(H * S);
    { const F = Math.min(1, 900 / Math.max(W, H)), c = canvas(W * F, H * F); c.getContext('2d').drawImage(im, 0, 0, c.width, c.height); pics.flat = toUrl(c); }
    // agent's overlays: soft pixels magenta, thin parts red
    { // a max-pool down to the sheet's size, so 1-px marks aren't averaged away
      const mp = canvas(sw, sh), xm = mp.getContext('2d'), mi = xm.createImageData(sw, sh), md = mi.data;
      for (let y = 0; y < H; y++) for (let X = 0; X < W; X++) { const i = y * W + X; const isSoft = soft[i]; const gi = Math.min(GN - 1, Math.floor(y * k) * GW + Math.floor(X * k)); const isThin = thin[gi]; if (!isSoft && !isThin) continue; const j = (Math.min(sh - 1, Math.floor(y * S)) * sw + Math.min(sw - 1, Math.floor(X * S))) * 4; if (isThin) { md[j] = 255; md[j + 1] = 20; md[j + 2] = 20; md[j + 3] = 255; } else if (md[j + 3] === 0) { md[j] = 255; md[j + 1] = 0; md[j + 2] = 200; md[j + 3] = 220; } }
      xm.putImageData(mi, 0, 0); pics.marks = toUrl(mp); }
    // DTG preview per garment (Palm's approximation): semi-transparent pixels → speckles of white underbase on coloured
    // shirts; solid near-black → dark grey on near-black shirts (Printful: "Black ink will appear gray on black garments")
    const dtg = (data, w, h, gm, fabric, sel) => {
      const G = rgbOf(gm.hex), dark = lum(...G) < 0.6, white = lum(...G) > 0.9, blackShirt = lum(...G) < 0.03, out = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        let a = data[i * 4 + 3] / 255, rr = data[i * 4], gg = data[i * 4 + 1], bb = data[i * 4 + 2], cov = a;
        if (blackShirt && a > 0.5 && lum(rr, gg, bb) < 0.012) { rr = gg = bb = 58; }
        let R, Gg, B;
        const softHere = sel ? sel(i) : (a > 0.03 && a < 0.97);
        if (!white && softHere) {
          const h1 = hash(i * 7 + 13);
          if (h1 < a * 0.55) { R = rr; Gg = gg; B = bb; cov = 1; } else if (h1 < a) { R = 236; Gg = 236; B = 232; cov = 1; } else { R = G[0]; Gg = G[1]; B = G[2]; cov = fabric ? 1 : 0; }
        } else { R = rr * a + G[0] * (1 - a); Gg = gg * a + G[1] * (1 - a); B = bb * a + G[2] * (1 - a); cov = fabric ? 1 : a; if (!fabric && a > 0) { R = rr; Gg = gg; B = bb; } }
        if (fabric) { const t = 1 + (hash(i * 3 + 1) - 0.5) * (dark ? 0.1 : 0.06); R *= t; Gg *= t; B *= t; if (/heather/.test(gm.key) && hash(i * 5 + 2) < 0.08) { const s = hash(i) < 0.5 ? 0.82 : 1.12; R *= s; Gg *= s; B *= s; } }
        out[i * 4] = R; out[i * 4 + 1] = Gg; out[i * 4 + 2] = B; out[i * 4 + 3] = Math.round(cov * 255);
      }
      return out;
    };
    // close-up at real size: a window 4 × 3 in centred on o.focus (else the ink box centre), native pixels, on the fabric
    pics.garments = {};
    if (o.product === 'shirt' && res.ink_box) {
      const fw = Math.min(W, Math.round(4 * o.dpi)), fh = Math.min(H, Math.round(3 * o.dpi));
      const fc = o.focus || { x: res.ink_box.x + res.ink_box.w / 2, y: res.ink_box.y + res.ink_box.h / 2 };
      const cx = Math.max(0, Math.min(W - fw, Math.round(fc.x - fw / 2))), cy = Math.max(0, Math.min(H - fh, Math.round(fc.y - fh / 2)));
      const crop = x0.getImageData(cx, cy, fw, fh).data;
      // small view for the shirt mock-up (soft from the full-res mask, max-pooled)
      const ps = Math.min(1, 520 / Math.max(W, H)), pw = Math.max(1, Math.round(W * ps)), ph = Math.max(1, Math.round(H * ps));
      const pc = canvas(pw, ph), px = pc.getContext('2d', { willReadFrequently: true }); px.drawImage(im, 0, 0, pw, ph); const small = px.getImageData(0, 0, pw, ph).data;
      const softSmall = new Uint8Array(pw * ph); for (let i = 0; i < N; i++) if (soft[i]) { const X = i % W, y = (i - X) / W; softSmall[Math.min(ph - 1, Math.floor(y * ps)) * pw + Math.min(pw - 1, Math.floor(X * ps))] = 1; }
      for (const gm of o.garments) {
        const a = canvas(pw, ph), ax = a.getContext('2d'), ai = ax.createImageData(pw, ph); ai.data.set(dtg(small, pw, ph, gm, false, (i) => softSmall[i] && small[i * 4 + 3] < 250)); ax.putImageData(ai, 0, 0);
        const b = canvas(fw, fh), bx = b.getContext('2d'), bi = bx.createImageData(fw, fh); bi.data.set(dtg(crop, fw, fh, gm, true, (i) => { const X = i % fw, y = (i - X) / fw; return soft[(y + cy) * W + X + cx] === 1; })); bx.putImageData(bi, 0, 0);
        const b2 = canvas(384, Math.round(384 * fh / fw)); b2.getContext('2d').drawImage(b, 0, 0, b2.width, b2.height);
        pics.garments[gm.key] = { small: toUrl(a), close: toUrl(b2) };
      }
      res.close_window = { x: cx, y: cy, w: fw, h: fh };
    }
    // mug: the wrap rolled onto an 11 oz mug (3.2 in across, 3.8 in tall; ends of the 9 in wrap at the handle), two views
    if (o.product === 'mug') {
      const ppi = 110, R = 1.6, mw = Math.round(2 * R * ppi), mh = Math.round(3.8 * ppi), areaW = o.area[0], areaH = o.area[1];
      const src2 = canvas(Math.round(areaW * 200), Math.round(areaH * 200)); src2.getContext('2d').drawImage(im, 0, 0, src2.width, src2.height);
      const views = [];
      for (const f of [0.25, 0.75]) {
        const v = canvas(mw + 140, mh + 20), vx = v.getContext('2d'); const ox = 70, oy = 10;
        // handle on the side where the wrap's ends are (Palm's reading)
        const handleLeft = f === 0.25; vx.lineWidth = 30; vx.strokeStyle = '#b9b9b4';
        vx.beginPath(); if (handleLeft) vx.ellipse(ox + 6, oy + mh * 0.48, 62, mh * 0.27, 0, Math.PI * 0.5, Math.PI * 1.5); else vx.ellipse(ox + mw - 6, oy + mh * 0.48, 62, mh * 0.27, 0, -Math.PI * 0.5, Math.PI * 0.5); vx.stroke(); vx.lineWidth = 22; vx.strokeStyle = '#f2f2ef'; vx.stroke();
        const body = vx.createLinearGradient(ox, 0, ox + mw, 0); body.addColorStop(0, '#cfcfcc'); body.addColorStop(0.35, '#ffffff'); body.addColorStop(0.7, '#f4f4f2'); body.addColorStop(1, '#c4c4c0');
        vx.fillStyle = body; vx.beginPath(); vx.roundRect(ox, oy, mw, mh, [6, 6, 16, 16]); vx.fill();
        const top = oy + Math.round((3.8 - areaH) / 2 * ppi);
        for (let sx = 0; sx < mw; sx++) {
          const xr = (sx + 0.5 - mw / 2) / (mw / 2); const th = Math.asin(Math.max(-1, Math.min(1, xr)));
          const fx = (f * areaW + th * R) / areaW * src2.width; if (fx < 0 || fx >= src2.width) continue;
          vx.globalAlpha = 1; vx.drawImage(src2, Math.floor(fx), 0, 1, src2.height, ox + sx, top, 1, Math.round(areaH * ppi));
        }
        const sh2 = vx.createLinearGradient(ox, 0, ox + mw, 0); sh2.addColorStop(0, 'rgba(0,0,0,.28)'); sh2.addColorStop(0.25, 'rgba(0,0,0,0)'); sh2.addColorStop(0.8, 'rgba(0,0,0,0)'); sh2.addColorStop(1, 'rgba(0,0,0,.3)');
        vx.fillStyle = sh2; vx.fillRect(ox, oy, mw, mh);
        vx.fillStyle = 'rgba(0,0,0,.08)'; vx.fillRect(ox, oy, mw, 6);
        views.push(toUrl(v));
      }
      pics.mug = views;
      // ink near the wrap's ends (where they meet at the handle)
      const e = Math.round(0.25 * o.dpi); let left = 0, right = 0, tot = 0;
      for (let y = 0; y < H; y += 2) for (let X = 0; X < W; X += 2) { if (d[(y * W + X) * 4 + 3] < 26) continue; const c = [d[(y * W + X) * 4], d[(y * W + X) * 4 + 1], d[(y * W + X) * 4 + 2]]; if (c.every((v) => v >= 248)) continue; tot++; if (X < e) left++; if (X >= W - e) right++; }
      res.mug = { ink_near_ends: tot ? (left + right) / tot : 0 };
    }
    if (stick) pics.sticker = { url: stick.url, px: stick.px, crop: stick.crop, dpi: dpiG };
    res.pics = pics;
    return res;
  };
}

// ---------- check a folder ----------
const IMG = /\.(png|jpe?g|webp|svg|pdf|tiff?)$/i;
export async function check(dirOrFile, { provider = 'printful', colors = 'white,black,athletic-heather,navy', sticker: stickerIn = null, out = 'look/merch', plain = false, ocr = 'auto' } = {}) {
  const abs = resolve(dirOrFile);
  if (!existsSync(abs)) throw new Error('no such folder or file: ' + dirOrFile);
  provider = /printify/i.test(provider) ? 'printify' : 'printful';
  const colourList = String(colors).toLowerCase().split(',').map((s) => s.trim().replace(/\s+/g, '-')).map((s) => s === 'heather' || s === 'grey' || s === 'gray' ? 'athletic-heather' : s).filter((s) => GARMENTS[s]);
  const dir = statSync(abs).isDirectory() ? abs : dirname(abs);
  // print files: images whose name names a product (an SVG/HTML source beside a PNG isn't a print file)
  const all = statSync(abs).isDirectory() ? readdirSync(dir).filter((f) => IMG.test(f) && !f.startsWith('.')).sort() : [basename(abs)];
  const files = all.filter((f) => productOf(f) && !(/\.svg$/i.test(f) && all.some((g) => g !== f && g.replace(/\.[^.]+$/, '') === f.replace(/\.[^.]+$/, ''))));
  if (!files.length) throw new Error('no print files in ' + dirOrFile + ' (names must say shirt/tee, mug or sticker)');
  const issues = [], results = [];
  const tess = hasTesseract();
  const browser = await launch();
  let sheet;
  try {
    const page = await browser.newPage();
    for (const f of files) {
      const p = join(dir, f), buf = readFileSync(p), info = fileInfo(buf), product = productOf(f), spec = PRODUCTS[product];
      const add = (id, lvl, msg, fix) => issues.push(issue(id, lvl, msg, fix, f));
      const r = { file: f, product, label: spec.label, format: info.format, w: info.w, h: info.h, mb: round(buf.length / 1048576, 2), icc: info.icc || null, alpha: !!info.alpha };
      results.push(r);
      if (!['png', 'jpeg'].includes(info.format)) { add('format', 'error', `${f} is ${String(info.format).toUpperCase()}: ${provider === 'printful' ? 'Printful takes PNG or JPEG' : 'Printify takes JPEG, PNG or SVG (SVG not measured here)'}.`, 'Export it as a PNG at the print size.'); continue; }
      const lim = LIMITS[provider];
      if (r.mb > lim.mb) add('file-too-big', 'error', `${f} is ${r.mb} MB; ${provider === 'printful' ? 'Printful' : 'Printify'} takes up to ${lim.mb} MB.`, 'Save it with PNG compression, or at the print size rather than bigger.');
      if (lim.px && Math.max(info.w, info.h) > lim.px) add('too-many-px', 'error', `${f} is ${info.w}×${info.h}; Printful takes up to 20,000 × 20,000 px.`, 'Scale it down to the print size.');
      if (info.icc && !/srgb/i.test(info.icc)) add('icc', 'warn', `${f} carries a "${info.icc}" colour profile; Printful asks for sRGB IEC61966-2.1.`, 'Convert to sRGB before saving.');
      if (info.mode === 'cmyk') add('cmyk', 'warn', `${f} is CMYK; both providers expect RGB (sRGB).`, 'Save it as sRGB.');
      if (info.format === 'jpeg' && product !== 'mug') add('jpeg-no-transparency', 'error', `${f} is a JPEG: ${product === 'shirt' ? 'Printful: "JPEG files don\'t support transparency, so designs … may appear with a visible white background" — on a shirt that prints as a box' : 'a die-cut sticker is cut around the artwork, and a JPEG has no transparent background to cut around'}.`, 'Export a PNG with a transparent background.');
      // resolution at the print size
      const minDpi = spec.dpi[provider];
      let dpi, printIn;
      if (product === 'shirt') { const [aw, ah] = spec.area; const wIn = Math.min(aw, ah * info.w / info.h); dpi = info.w / wIn; printIn = { w: round(wIn, 2), h: round(wIn * info.h / info.w, 2) };
        if (Math.abs(info.w / info.h - aw / ah) > 0.03) add('not-template', 'tip', `${f} is ${info.w}×${info.h}, not the shape of the front print area (${aw} × ${ah} in, Printful from size L). Palm assumes it's placed as large as the area allows (${printIn.w} × ${printIn.h} in); if you'll print it smaller, its resolution there is higher.`, `Make the file the print area itself (e.g. ${aw * minDpi}×${ah * minDpi} px at ${minDpi} DPI), with the design placed where it should print.`); }
      else if (product === 'mug') { const [aw, ah] = spec.area; dpi = info.w / aw; printIn = { w: aw, h: ah };
        if (Math.abs(info.w / info.h - aw / ah) / (aw / ah) > 0.03) add('mug-canvas', 'error', `${f} is ${info.w}×${info.h} (${round(info.w / info.h, 2)}:1); the 11 oz mug's print file is ${aw} × ${ah} in (${round(aw / ah, 2)}:1, Printful). The wrap will be stretched, cropped or squeezed into a band.`, `Make it exactly ${aw * 300}×${ah * 300} px (300 DPI) and lay the design out across the whole wrap.`); }
      else { const m = f.match(/(\d+(?:\.\d+)?)\s*(?:in|inch|")/i), size = m ? +m[1] : (stickerIn || 3); dpi = Math.max(info.w, info.h) / size; printIn = { w: round(info.w / dpi, 2), h: round(info.h / dpi, 2) }; r.sticker_size_in = size;
        if (!spec.sizes.includes(size)) add('sticker-size', 'tip', `${f}: ${size} in isn't one of Printful's die-cut sizes (2, 3, 4, 5, 6 in).`, 'Pick a listed size.'); }
      r.dpi = Math.round(dpi); r.print_in = printIn;
      if (dpi < minDpi * 0.98) add('low-dpi', provider === 'printify' && dpi >= 150 ? 'warn' : 'error', `${f}: ${Math.round(dpi)} DPI at ${printIn.w} × ${printIn.h} in. ${provider === 'printful' ? `Printful: "at least ${minDpi} DPI"` : 'Printify recommends 300 DPI'} for this product.`, `Make it at least ${Math.ceil(printIn.w * minDpi)}×${Math.ceil(printIn.h * minDpi)} px — redraw it bigger (vector/HTML), don't enlarge a small image.`);
      if (dpi > 330 && provider === 'printful') add('over-300', 'note', `${f}: ${Math.round(dpi)} DPI. Printful: "It's also best not to exceed 300 DPI."`, `Save it at ${Math.round(printIn.w * 300)}×${Math.round(printIn.h * 300)} px.`);
      // text (source, else OCR)
      const stem = f.replace(/\.[^.]+$/, '');
      const srcPath = [dir, dirname(dir)].map((dd) => { try { const n = readdirSync(dd).find((x) => /\.(html?|svg)$/i.test(x) && x !== f && x.replace(/\.[^.]+$/, '') === stem); return n && join(dd, n); } catch { return null; } }).find(Boolean);
      let text = [], method = 'none';
      if (srcPath) { try { text = await measureSource(page, srcPath, { w: info.w, h: info.h }); method = 'source'; r.source = basename(srcPath); } catch { /* fall back to OCR */ } }
      const garments = product === 'shirt' ? coloursOf(f, colourList.length ? colourList : Object.keys(GARMENTS)).map((key) => ({ key, hex: GARMENTS[key] })) : [];
      r.garments = garments.map((g) => g.key);
      // pixels
      await page.setContent('<html><body></body></html>');
      await page.evaluate(pageLib);
      const dataUrl = `data:image/${info.format};base64,${buf.toString('base64')}`;
      if (tess && (ocr === 'always' || (ocr === 'auto' && method === 'none'))) {
        // OCR on the design flattened onto white and onto black (whichever reads more)
        const tmp = mkdtempSync(join(tmpdir(), 'merch-ocr-'));
        const flat = await page.evaluate(async (src) => { const im = new Image(); im.src = src; await im.decode(); const k = Math.min(1, 5000 / Math.max(im.naturalWidth, im.naturalHeight)); const out = []; for (const bg of ['#ffffff', '#000000']) { const c = document.createElement('canvas'); c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k); const x = c.getContext('2d'); x.fillStyle = bg; x.fillRect(0, 0, c.width, c.height); x.drawImage(im, 0, 0, c.width, c.height); out.push({ url: c.toDataURL('image/png'), k }); } return out; }, dataUrl);
        let best = [];
        for (const [j, fl] of flat.entries()) { const t = join(tmp, `f${j}.png`); writeFileSync(t, Buffer.from(fl.url.split(',')[1], 'base64')); let o2 = []; try { o2 = ocrBoxes(t).map((b) => ({ ...b, x: b.x / fl.k, y: b.y / fl.k, w: b.w / fl.k, h: b.h / fl.k, fs: b.fs / fl.k })); } catch { /* unreadable */ } if (o2.length > best.length) best = o2; }
        if (method === 'none') { text = best; method = 'ocr'; } else r.ocr = best.map((b) => ({ t: b.t, pt: round(b.fs / dpi * 72) }));
      }
      r.text_method = method;
      const pt = (b) => b.fs / dpi * 72;
      r.text = text.map((b) => ({ t: b.t, pt: round(pt(b)) }));
      const smallest = text.slice().sort((a, b) => a.fs - b.fs)[0];
      const focus = smallest ? { x: smallest.x + smallest.w / 2, y: smallest.y + smallest.h / 2 } : null;
      const px = await page.evaluate((src, o) => window.palmMerch(src, o), dataUrl, { product, dpi, thinMm: spec.thinMm, garments, area: spec.area, focus });
      r.pics = px.pics; r.text_boxes = text.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h, pt: round(pt(b)) }));
      r.alpha_stats = px.alpha; r.colours = px.colours; r.contrast = px.garments; r.thin = px.thin; r.specks = px.speck_count; r.background = px.background; r.sticker = px.sticker; r.mug = px.mug || null; r.ink_box = px.ink_box;
      r.ink_in = px.ink_box ? { w: round(px.ink_box.w / dpi, 2), h: round(px.ink_box.h / dpi, 2) } : null;
      const est = method === 'ocr' ? ' (Palm\'s estimate from OCR)' : '';
      // semi-transparency
      const a = px.alpha, inkPx = a.solid + a.semi;
      if (!inkPx) { add('empty', 'error', `${f} has nothing in it to print.`, 'Put the design in the file.'); continue; }
      if (a.soft > 0) {
        const where = a.soft_box ? ` (from ${a.soft_box.x},${a.soft_box.y}, ${a.soft_box.w}×${a.soft_box.h} px; ${a.halo >= a.soft * 0.6 ? 'mostly hugging the design: a shadow, glow or halo' : 'semi-transparent areas or fades'}, average alpha ${a.soft_mean_alpha})` : '';
        const msg = `${f}: ${pct(a.soft_share)} of the design is semi-transparent away from any solid edge${where}.`;
        if (product === 'shirt' && (a.soft_share > 0.003)) add('semi-transparent', 'error', `${msg} Printful: "Semi-transparent effects like shadows, fades, smoke, glow effects, and low-opacity textures may not print the way they appear on screen" — DTG prints them with "gaps with a visible white base … most evident on dark fabrics". On the sheet, magenta.`, 'Remove the shadow/glow/fade, make every pixel either solid or fully transparent (threshold the alpha), or fake the effect with a solid halftone.');
        else if (product === 'sticker' && a.soft_share > 0.003) add('semi-transparent', 'warn', `${msg} Printful (die-cut): "Keep only the background transparent—any other transparent details will be printed white".`, 'Make every pixel of the design solid; keep transparency only around it.');
        else if (product === 'shirt' && a.soft > 50) add('semi-transparent', 'warn', `${msg} A few soft pixels: check the magenta on the sheet.`, 'Threshold the alpha so edges go straight from solid to clear.');
      }
      // background
      if (px.background?.kind === 'full' && product !== 'mug') add('background-left-in', product === 'shirt' ? 'error' : 'warn', `${f} has no transparency: its whole canvas is filled (edge colour ${'#' + px.background.rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}). ${product === 'shirt' ? 'On the shirt that prints as a rectangle of that colour' : 'Printful cuts a die-cut sticker around the artwork; a filled canvas makes it a square sticker ("fill the entire print area" only if you want a square)'}.`, 'Delete the background so only the design has pixels; save as PNG with transparency.');
      if (px.background?.kind === 'box' && product === 'shirt') add('background-box', 'error', `${f}: the design sits on a solid rectangle (${Math.round(px.background.w)}×${Math.round(px.background.h)} px, colour #${px.background.rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}) — a background left in from the logo file. It prints as a box on the shirt.`, 'Cut the design out of its background (transparent around and inside letters).');
      // specks
      if (px.speck_count) add('specks', product === 'sticker' ? 'error' : 'warn', `${f}: ${px.speck_count} stray speck${px.speck_count > 1 ? 's' : ''} away from the design (e.g. ${px.specks.slice(0, 2).map((q) => `${q.w}×${q.h} px at ${q.x},${q.y}`).join('; ')}). ${product === 'sticker' ? 'Printful: "make sure there are no rogue pixels still visible outside the outline"; each is cut as its own sticker' : 'They print as specks of ink'}.`, 'Erase them (they\'re often leftovers of a background removal).');
      // thin lines
      if (px.thin_count) add('thin-lines', 'warn', `${f}: ${px.thin_count} part${px.thin_count > 1 ? 's' : ''} thinner than ${spec.thinMm} mm at print size (Palm's minimum for a ${product}): ${px.thin.slice(0, 3).map((t) => `${t.width_mm} mm × ${t.length_in} in${t.colour !== 'shape' ? ' in ' + t.colour : ''} at ${t.x},${t.y}`).join('; ')}. Printful: thin lines "can appear blurry, lose sharpness, or fade into the fabric texture"${product === 'mug' ? '; "Bold lines and graphics usually work best for mugs"' : ''}. On the sheet, red.`, `Thicken them to ${spec.thinMm} mm or more (${Math.ceil(spec.thinMm / 25.4 * dpi)} px at this resolution) or drop them (a hairline outline is the usual culprit).`);
      // text size
      const small = text.filter((b) => pt(b) < spec.textPt).sort((p, q) => p.fs - q.fs);
      if (small.length) add('text-small', 'warn', `${f}: ${small.length} line${small.length > 1 ? 's' : ''} of text under ${spec.textPt} pt at print size (Palm's minimum for a ${product})${est}: ${small.slice(0, 4).map((b) => `"${b.t}" ${round(pt(b))} pt`).join('; ')}. Printful: small text "can appear blurry … or fade into the fabric texture"${product === 'mug' ? '; mugs: "avoid using tiny details or text"' : ''}.`, `Make it at least ${spec.textPt} pt at print size (${Math.ceil(spec.textPt / 72 * dpi)} px font size in this file) or cut it.`);
      // colours on each garment
      for (const gm of px.garments || []) {
        const name = gm.key.replace(/-/g, ' ');
        if (gm.vanish >= 0.15) add('low-contrast', gm.vanish >= 0.4 ? 'error' : 'warn', `${f} on a ${name} shirt (${gm.hex}): ${pct(gm.vanish)} of the design's ink is under 1.6:1 against the fabric (Palm's measure), so it nearly disappears: ${gm.worst.filter((w) => w.contrast < 1.6).map((w) => `${w.hex} ${pct(w.share)} of the ink, ${w.contrast}:1`).join('; ')}. Printful: "Dark designs on dark products … may look dull or low-contrast"; "White or pale designs may be hard to see on white, cream, pastel, or heather garments".`, `Make a version of the design for ${name} (e.g. the dark parts in a light colour), named for the colours it's for (…-${gm.key}.png), or don't offer that colour.`);
        if (gm.black_on_black >= 0.05) add('black-on-black', 'warn', `${f} on ${name}: ${pct(gm.black_on_black)} of the ink is near-black. Printful: "Black ink will appear gray on black garments because of the white underbase … Leave these areas fully transparent".`, 'Make those parts transparent so the shirt shows through, or a lighter colour.');
        if (gm.white_on_white >= 0.05) add('white-on-white', 'note', `${f} on white: ${pct(gm.white_on_white)} of the ink is white. Printful: "We do not print white ink on white garments" (it simply won't show).`, 'Fine if those parts are meant to disappear on white.');
      }
      // sticker pieces, mug ends
      if (product === 'sticker' && px.sticker && px.sticker.pieces > 1) add('sticker-pieces', 'warn', `${f}: the cut line makes ${px.sticker.pieces} separate pieces (parts more than ~1/4 in apart are cut separately: Printful asks for 0.25 in between objects cut separately; Printify cuts elements "far apart" as separate objects).`, 'Join the parts (a solid shape or a backing behind them) so it cuts as one sticker.');
      if (product === 'mug' && px.mug && px.mug.ink_near_ends > 0.04) { const endText = text.some((b) => b.x < 0.25 * dpi || b.x + b.w > info.w - 0.25 * dpi); add('mug-ends', endText ? 'warn' : 'tip', `${f}: ${pct(px.mug.ink_near_ends)} of the coloured ink is within 0.25 in of the wrap's ends${endText ? ', including text' : ''}. The two ends meet at the handle (and the print may shift ±0.1 in, Printful), so anything there is hidden by or split around the handle.`, 'Keep words and the logo at least 0.25 in from the left and right ends; centre each face at ¼ and ¾ of the width.'); }
    }
    if (!tess) issues.push(issue('no-ocr', 'note', 'Tesseract isn\'t installed, so text in files without an HTML/SVG source wasn\'t measured: check text size by eye on the sheet.', 'Keep each file\'s HTML/SVG source beside it (same name), or install Tesseract.'));
    sheet = await drawSheet(page, { results, plain, out, provider });
  } finally { await browser.close(); }
  for (const r of results) { delete r.pics; delete r.text_boxes; }
  const errors = issues.filter((i) => i.level === 'error').length, warnings = issues.filter((i) => i.level === 'warn').length;
  return { ok: errors === 0, errors, warnings, provider, files: results, issues, sheet };
}

// ---------- the sheet ----------
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
// A T-shirt silhouette (size L: body 20 in across); the print placed 3 in below the collar, at its print size.
function shirtSvg(fill, key) {
  const heather = /heather/.test(key);
  return `<svg viewBox="0 0 300 330" width="300" height="330" style="position:absolute;left:0;top:0"><defs><filter id="n${key}"><feTurbulence type="fractalNoise" baseFrequency="${heather ? 1.6 : 0.9}" numOctaves="2" seed="3"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="table" tableValues="0 ${heather ? 0.35 : 0.12}"/></feComponentTransfer><feComposite in2="SourceGraphic" operator="in"/></filter></defs><path d="M96 14 C110 30 190 30 204 14 L262 38 L298 104 L254 126 L238 102 L240 322 L60 322 L62 102 L46 126 L2 104 L38 38 Z" fill="${fill}" stroke="rgba(0,0,0,.18)" stroke-width="1.2"/><path d="M96 14 C110 30 190 30 204 14 L262 38 L298 104 L254 126 L238 102 L240 322 L60 322 L62 102 L46 126 L2 104 L38 38 Z" fill="${fill}" filter="url(#n${key})"/><path d="M104 16 C118 36 182 36 196 16" fill="none" stroke="rgba(0,0,0,.25)" stroke-width="3"/></svg>`;
}
async function drawSheet(page, { results, plain, out, provider }) {
  const checker = 'background-color:#fff;background-image:linear-gradient(45deg,#e4e4e4 25%,transparent 25%,transparent 75%,#e4e4e4 75%),linear-gradient(45deg,#e4e4e4 25%,transparent 25%,transparent 75%,#e4e4e4 75%);background-size:16px 16px;background-position:0 0,8px 8px';
  const secs = [];
  for (const r of results) {
    if (!r.pics) { secs.push(`<div class="sec"><h2>${esc(r.file)}: not drawn (${esc(r.format)})</h2></div>`); continue; }
    const head = `<h2>${esc(r.file)} · ${esc(r.label)} · ${r.w}×${r.h} px${plain ? '' : ` · ${r.dpi} DPI at ${r.print_in.w} × ${r.print_in.h} in`}</h2>`;
    // the flat file on a checkerboard (agent's copy: soft pixels magenta, thin parts red, text sizes)
    const fw = r.product === 'mug' ? 900 : 380, k = fw / r.w, fh = Math.round(r.h * k);
    let marks = '';
    if (!plain) {
      marks += `<img src="${r.pics.marks}" style="position:absolute;left:0;top:0;width:${fw}px;height:${fh}px">`;
      for (const b of r.text_boxes || []) marks += `<div style="position:absolute;left:${b.x * k}px;top:${b.y * k}px;width:${b.w * k}px;height:${b.h * k}px;outline:1px solid #2a7;"></div><div style="position:absolute;left:${b.x * k}px;top:${(b.y + b.h) * k}px;font:600 10px system-ui;color:#fff;background:#2a7;padding:0 2px">${b.pt} pt</div>`;
      if (r.product === 'mug') marks += `<div style="position:absolute;left:0;top:0;width:${0.25 * r.dpi * k}px;height:${fh}px;background:rgba(255,140,0,.18)"></div><div style="position:absolute;right:0;top:0;width:${0.25 * r.dpi * k}px;height:${fh}px;background:rgba(255,140,0,.18)"></div><div style="position:absolute;left:${fw / 2}px;top:0;height:${fh}px;border-left:1px dashed #39f"></div>`;
    }
    const flat = `<div style="width:${fw}px;flex:none"><div class="cap">The file as uploaded (checkerboard = transparent)${plain ? '' : '; <span style="color:#d0a">magenta</span> = semi-transparent pixels, <span style="color:#e22">red</span> = thinner than Palm\'s minimum, green = text with its size at print'}</div><div style="position:relative;width:${fw}px;height:${fh}px;${checker};outline:1px solid #bbb"><img src="${r.pics.flat}" style="position:absolute;left:0;top:0;width:${fw}px;height:${fh}px">${marks}</div></div>`;
    let views = '';
    if (r.product === 'shirt') {
      // shirt: body 20 in = 180 px (x 60..240) → 9 px/in; print area top 3 in below the collar (y≈30 + 27)
      const ppi = 9, pw = r.print_in.w * ppi, ph = r.print_in.h * ppi, left = 150 - pw / 2, top = 58;
      views = `<div style="flex:1;min-width:0"><div style="display:flex;flex-wrap:wrap;gap:14px">${r.garments.map((key) => { const g = r.pics.garments[key]; if (!g) return ''; return `<div style="background:#fff;padding:8px;border-radius:6px"><div class="cap">${esc(key.replace(/-/g, ' '))} (${GARMENTS[key]}) — on a phone, size L</div><div style="position:relative;width:300px;height:330px;background:#f4f4f2">${shirtSvg(GARMENTS[key], key)}<img src="${g.small}" style="position:absolute;left:${left}px;top:${top}px;width:${pw}px;height:${ph}px"></div><div class="cap" style="margin-top:6px">Close-up at real size (a 4 × 3 in patch on a 96 dpi screen)</div><img src="${g.close}" style="display:block;width:384px;max-width:384px"></div>`; }).join('')}</div><div class="cap" style="margin-top:4px">DTG preview: Palm's approximation (semi-transparent pixels print as speckles of white underbase on coloured shirts; solid black prints dark grey on black, per Printful's file guidelines).</div></div>`;
    } else if (r.product === 'mug') {
      views = `<div><div style="display:flex;gap:18px;align-items:flex-end">${(r.pics.mug || []).map((u, i) => `<div><div class="cap">${i ? 'Handle on the right: the right half of the wrap faces you' : 'Handle on the left: the left half of the wrap faces you'}</div><img src="${u}" style="display:block;background:#ecebe8"></div>`).join('')}</div><div class="cap">Real size on a 96 dpi screen ≈ 0.87× this (the mug drawn at 110 px per inch). Palm's approximation: the wrap's two ends meet at the handle.</div></div>`;
    } else if (r.product === 'sticker' && r.pics.sticker) {
      const s = r.pics.sticker, real = 96 / s.dpi, big = 288 / s.dpi;
      const im = (sc) => `<div style="width:${s.crop.w * sc}px;height:${s.crop.h * sc}px;overflow:hidden;position:relative;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))"><img src="${s.url}" style="position:absolute;left:${-s.crop.x * sc}px;top:${-s.crop.y * sc}px;width:${s.px.w * sc}px;height:${s.px.h * sc}px;max-width:none"></div>`;
      views = `<div style="display:flex;gap:28px;align-items:center;background:#8a8f96;padding:22px;border-radius:10px"><div><div class="cap" style="color:#fff">On a laptop lid at real size (96 dpi screen)</div>${im(real)}</div><div><div class="cap" style="color:#fff">3× (the cut line in dark grey; white border ≈ 1/8 in, Palm's estimate of Printful's added border)</div>${im(big)}</div></div>`;
    }
    secs.push(`<div class="sec">${head}<div style="display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap">${flat}${views}</div></div>`);
  }
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;width:1500px;background:#ecebe8;font-family:system-ui,sans-serif}.sec{padding:16px 20px;border-bottom:1px solid #d6d4cf}h2{font:600 14px system-ui;margin:0 0 10px;color:#333}.cap{font:500 12px system-ui;color:#555;margin-bottom:5px;max-width:900px}</style></head><body>
<div class="sec" style="background:#2b2f36;color:#fff"><h2 style="color:#fff;font-size:16px">Print-on-demand files: ${results.length} (${esc(provider === 'printify' ? 'Printify' : 'Printful')}), drawn on the products (Palm's mock-ups, not the provider's)</h2></div>
${secs.join('\n')}
</body></html>`;
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(resolve(out) + '-sheet.html', html);
  await page.setViewport({ width: 1500, height: 1000, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => Promise.all([...document.images].map((i) => i.complete ? 0 : new Promise((r) => (i.onload = i.onerror = r)))));
  await page.screenshot({ path: resolve(out) + '-sheet.png', fullPage: true });
  return resolve(out) + '-sheet.png';
}

// ---------- render HTML to a transparent PNG ----------
export async function render(file, { out, size } = {}) {
  const [w, h] = String(size || '').split('x').map(Number);
  if (!w || !h) throw new Error('--size WxH, e.g. 4500x5400 (shirt front at 300 DPI), 2700x1050 (11 oz mug), 900x900 (3 in sticker)');
  if (!/\.png$/i.test(out || '')) throw new Error('--out must be a .png (print files need transparency)');
  const browser = await launch();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(resolve(file)).href, { waitUntil: 'load', timeout: 60000 });
    await page.evaluate(() => document.fonts?.ready); await new Promise((r) => setTimeout(r, 200));
    await page.evaluate(() => Promise.all([...document.images].map((i) => i.complete ? 0 : new Promise((r) => (i.onload = i.onerror = r)))));
    const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight, bg: [getComputedStyle(document.documentElement).backgroundColor, getComputedStyle(document.body).backgroundColor] }));
    mkdirSync(dirname(resolve(out)), { recursive: true });
    await page.screenshot({ path: out, type: 'png', omitBackground: true, clip: { x: 0, y: 0, width: w, height: h } });
    const issues = [];
    if (m.sw > w + 1 || m.sh > h + 1) issues.push(issue('overflow', 'warn', `The HTML is ${m.sw}×${m.sh}, bigger than ${w}×${h}: part of it is cut off.`, `html,body{width:${w}px;height:${h}px;overflow:hidden}`));
    if (m.bg.some((c) => c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent')) issues.push(issue('page-background', 'warn', `The page has a background (${m.bg.join(', ')}), so the PNG has no transparency around the design.`, 'Remove the html/body background (leave it unpainted) unless the product is a full-bleed mug wrap.'));
    return { ok: !issues.length, out, w, h, kb: Math.round(statSync(out).size / 1024), issues };
  } finally { await browser.close(); }
}

// ---------- self-test ----------
async function selfTest() {
  const d = mkdtempSync(join(tmpdir(), 'merch-check-'));
  const page = (w, h, body) => `<html><body style="margin:0;width:${w}px;height:${h}px;overflow:hidden;position:relative;font-family:Arial">${body}</body></html>`;
  mkdirSync(join(d, 'good')); mkdirSync(join(d, 'bad'));
  // good: a crisp mark and big words, solid pixels only, light ink for dark shirts
  writeFileSync(join(d, 'good', 'shirt-front-black-navy.html'), page(2250, 2700, '<div style="position:absolute;left:325px;top:300px;width:1600px;height:900px;background:#e8d9b8;border-radius:80px"></div><div style="position:absolute;left:325px;top:1300px;width:1600px;text-align:center;font:700 260px Arial;color:#f2ede4">CRAGLOFT</div>'));
  writeFileSync(join(d, 'good', 'mug-11oz.html'), page(2700, 1050, '<div style="position:absolute;left:300px;top:300px;width:750px;height:450px;background:#2f7f86"></div><div style="position:absolute;left:1700px;top:380px;font:700 150px Arial;color:#23262b">SEND IT</div>'));
  writeFileSync(join(d, 'good', 'sticker-3in.html'), page(900, 900, '<div style="position:absolute;left:150px;top:150px;width:600px;height:600px;border-radius:50%;background:#2f7f86"></div><div style="position:absolute;left:150px;top:390px;width:600px;text-align:center;font:700 100px Arial;color:#fff">CRAG</div>'));
  for (const f of ['shirt-front-black-navy', 'mug-11oz', 'sticker-3in']) { const [w, h] = f.startsWith('shirt') ? [2250, 2700] : f.startsWith('mug') ? [2700, 1050] : [900, 900]; await render(join(d, 'good', f + '.html'), { out: join(d, 'good', f + '.png'), size: `${w}x${h}` }); }
  const g = await check(join(d, 'good'), { out: join(d, 'good-look'), colors: 'black,navy' });
  const gl = g.issues.filter((i) => ['error', 'warn'].includes(i.level));
  if (gl.length) throw new Error('good: ' + JSON.stringify(gl, null, 1));
  // bad: soft drop shadow, hairline outline, tiny tagline, charcoal ink for a black shirt, low resolution, a white box;
  // a mug at the wrong shape; a sticker with a white background and a stray speck
  writeFileSync(join(d, 'bad', 'shirt-front.html'), page(1200, 1440, '<div style="position:absolute;left:200px;top:200px;width:800px;height:500px;background:#2b2d31;border:1px solid #9aa;box-shadow:24px 30px 40px rgba(0,0,0,.45)"></div><div style="position:absolute;left:200px;top:760px;font:700 10px Arial;color:#2b2d31">BOULDERING · EST. 2019</div><div style="position:absolute;left:60px;top:1300px;width:4px;height:4px;background:#2b2d31"></div>'));
  await render(join(d, 'bad', 'shirt-front.html'), { out: join(d, 'bad', 'shirt-front.png'), size: '1200x1440' });
  writeFileSync(join(d, 'bad', 'mug.html'), page(2000, 2000, '<div style="position:absolute;inset:0;background:#fff"></div><div style="position:absolute;left:600px;top:600px;width:800px;height:800px;background:#2f7f86"></div>'));
  await render(join(d, 'bad', 'mug.html'), { out: join(d, 'bad', 'mug.png'), size: '2000x2000' });
  writeFileSync(join(d, 'bad', 'sticker.html'), page(900, 900, '<div style="position:absolute;inset:0;background:#fff"></div><div style="position:absolute;left:200px;top:200px;width:500px;height:500px;background:#2f7f86"></div>'));
  await render(join(d, 'bad', 'sticker.html'), { out: join(d, 'bad', 'sticker.png'), size: '900x900' });
  writeFileSync(join(d, 'bad', 'tee-boxed.html'), page(2250, 2700, '<div style="position:absolute;left:300px;top:300px;width:1650px;height:1000px;background:#fff"></div><div style="position:absolute;left:500px;top:500px;width:600px;height:600px;background:#2f7f86"></div><div style="position:absolute;left:1150px;top:700px;font:700 160px Arial;color:#2b2d31">CRAG</div>'));
  await render(join(d, 'bad', 'tee-boxed.html'), { out: join(d, 'bad', 'tee-boxed.png'), size: '2250x2700' });
  const b = await check(join(d, 'bad'), { out: join(d, 'bad-look'), colors: 'black,athletic-heather,navy' });
  const ids = b.issues.map((i) => i.id + '@' + i.file);
  for (const want of ['semi-transparent@shirt-front.png', 'low-dpi@shirt-front.png', 'text-small@shirt-front.png', 'low-contrast@shirt-front.png', 'thin-lines@shirt-front.png', 'specks@shirt-front.png', 'mug-canvas@mug.png', 'background-left-in@sticker.png', 'background-box@tee-boxed.png']) if (!ids.includes(want)) throw new Error('bad: expected ' + want + ' in ' + ids.join(', '));
  console.log(`merch-check: all tests pass (good: no warnings; bad: ${[...new Set(ids)].join(', ')}; sheets in ${d})`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (k, dflt) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : dflt; };
  const VALUED = new Set(['--out', '--size', '--provider', '--colors', '--sticker']);
  const pos = argv.filter((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1]));
  const done = (r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); };
  const fail = (e) => { console.error(String(e.message || e)); process.exit(2); };
  if (argv.includes('--test') || argv.includes('--self-test')) selfTest().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
  else if (pos[0] === 'render' && pos[1]) render(pos[1], { out: opt('out', 'print/design.png'), size: opt('size') }).then(done, fail);
  else if (pos[0] === 'check' && pos[1]) check(pos[1], { provider: opt('provider', 'printful'), colors: opt('colors', 'white,black,athletic-heather,navy'), sticker: opt('sticker') ? +opt('sticker') : null, out: opt('out', 'look/merch'), plain: argv.includes('--plain') }).then(done, fail);
  else fail('usage: merch-check.mjs check print/ [--provider printful|printify] [--colors black,navy,athletic-heather] [--sticker 3] [--out look/merch]\n       merch-check.mjs render design.html --size 4500x5400 --out print/shirt-front.png\n       merch-check.mjs --test');
}
