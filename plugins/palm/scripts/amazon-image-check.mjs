#!/usr/bin/env node
// Palm tool: amazon-image-check — lets an agent see Amazon listing images where Amazon shows them, and measures what
// Amazon checks: the main image's pure-white background, how much of the frame the product fills, a cut-off product,
// text or logos added to it; every image's size (zoom), format, colour mode and banned words; gallery text at phone size.
//
//   node amazon-image-check.mjs check listing/ [--main main.jpg] [--out look/amazon] [--plain]
//       → JSON {ok, errors, warnings, main, images, issues, sheet}. Then LOOK at <out>-sheet.png.
//       The main image is the file named *main* (or MAIN, as in B0XXXX.MAIN.jpg), else the first in name order;
//       the rest, in name order, are the gallery. A file's HTML/SVG source beside it (same name) lets the tool
//       measure its text exactly; without one, Tesseract OCR (if installed) gives Palm's estimate.
//   node amazon-image-check.mjs render main.html --size 2000x2000 --out listing/main.jpg [--quality 92]
//       → renders the HTML at exactly that size (JPG on a white page, or PNG without alpha).
//   node amazon-image-check.mjs --test
//
// Amazon's rules used here (Seller Central help, US, read 2026-11-26):
//   "Product image guide" (G1881): JPEG (recommended), TIFF, PNG, non-animated GIF; 500 px minimum and 10,000 px maximum
//   on the longest side ("Images with 1,000+ pixels on the longest side enable the zoom function"; 1,000+ recommended);
//   at least 72 dpi; RGB preferred. MAIN: "Show the product as 85% of the image", "Show the entire product within the
//   frame", "pure white background (RGB color values: 255, 255, 255)", only one unit, no props that aren't included.
//   All images: no customer reviews, five-star imagery, claims (e.g. free shipping) or seller-specific information; no
//   Amazon logos or words ("Amazon", "Prime", "Alexa"); no Amazon badges ("Amazon's Choice", "Best seller", "Top seller"…).
//   "Image suppression" (GT8RSE9S9NK4LP6Z): the main image is suppressed for text, logo, graphics or watermarks; a
//   background that isn't pure white (RGB 255 255 255); a cropped product; props; and any image for "Product too small".
//   "Technical image file requirements" (G9FUUH87RBNXGKB7): RGB yes; CMYK "Not preferred. Convert to RGB"; grayscale only
//   for grey or silver metal products; "Do not rely on ICC color profiles"; EPS, BMP, PDF, PSD… not accepted.
//   The guide gives no file-size limit, so the tool only reports the size.
// Palm's measurement and guidance (not Amazon's): how "85%" is measured (the product's bounding box on its longer side,
//   against the frame), what counts as background (outside the product's box) and as "white" (every channel 255; 254
//   counted separately as JPEG noise), stray specks, text size on a phone (each gallery image shown 390 px wide: under
//   10 px font size is hard to read), the search and page views (Palm's approximation of Amazon's layouts, Nov 2026).
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
const launch = () => loadPuppeteer().launch({ executablePath: findChrome(), headless: true, timeout: 90000, args: ['--no-sandbox', '--hide-scrollbars', '--allow-file-access-from-files', '--force-color-profile=srgb'] });

const issue = (id, level, msg, fix, file) => ({ id, level, file, msg, fix });
const round = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d;
const pct = (x) => `${round(x * 100)}%`;

// ---------- the file itself: format, size, colour mode, ICC profile, dpi ----------
function iccInfo(buf) {
  if (!buf || buf.length < 132) return null;
  const space = buf.toString('latin1', 16, 20).trim();
  let desc = '';
  const n = buf.readUInt32BE(128);
  for (let i = 0; i < n && 132 + i * 12 + 12 <= buf.length; i++) {
    const o = 132 + i * 12, sig = buf.toString('latin1', o, o + 4), off = buf.readUInt32BE(o + 4), len = buf.readUInt32BE(o + 8);
    if (sig !== 'desc' || off + len > buf.length) continue;
    const type = buf.toString('latin1', off, off + 4);
    if (type === 'desc') desc = buf.toString('latin1', off + 12, off + 12 + buf.readUInt32BE(off + 8) - 1);
    else if (type === 'mluc') { const sl = buf.readUInt32BE(off + 20), so = buf.readUInt32BE(off + 24); const u = buf.subarray(off + so, off + so + sl); let t = ''; for (let k = 0; k + 1 < u.length; k += 2) t += String.fromCharCode(u.readUInt16BE(k)); desc = t; }
  }
  return { space, desc: desc.replace(/\0/g, '').trim() };
}
export function fileInfo(b) {
  const o = { format: 'unknown' };
  if (!b || b.length < 12) return o;
  if (b.readUInt32BE(0) === 0x89504e47) {
    Object.assign(o, { format: 'png', w: b.readUInt32BE(16), h: b.readUInt32BE(20) });
    const ct = b[25]; o.mode = ct === 0 || ct === 4 ? 'grayscale' : ct === 3 ? 'palette' : 'rgb'; o.alpha = ct === 4 || ct === 6;
    for (let i = 8; i + 8 < b.length;) {
      const len = b.readUInt32BE(i), type = b.toString('latin1', i + 4, i + 8);
      if (type === 'tRNS') o.alpha = true;
      if (type === 'sRGB') o.icc = { space: 'RGB', desc: 'sRGB (chunk)' };
      if (type === 'iCCP') { const name = b.toString('latin1', i + 8, b.indexOf(0, i + 8)); o.icc = { space: '', desc: name }; try { const comp = b.subarray(b.indexOf(0, i + 8) + 2, i + 8 + len); const prof = iccInfo(inflateSync(comp)); if (prof) o.icc = { ...prof, desc: prof.desc || name }; } catch { /* name only */ } }
      if (type === 'pHYs') { const ppu = b.readUInt32BE(i + 8); if (b[i + 16] === 1) o.dpi = Math.round(ppu * 0.0254); }
      if (type === 'IEND') break;
      i += 12 + len;
    }
    return o;
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    o.format = 'jpeg'; const icc = [];
    for (let i = 2; i < b.length - 9;) {
      if (b[i] !== 0xff) { i++; continue; }
      const mk = b[i + 1]; if (mk === 0xd8 || mk === 0x01 || mk === 0xff || (mk >= 0xd0 && mk <= 0xd7)) { i += mk === 0xff ? 1 : 2; continue; }
      if (mk === 0xda) break;
      const len = b.readUInt16BE(i + 2);
      if (mk === 0xe0 && b.toString('latin1', i + 4, i + 9) === 'JFIF\0') { const u = b[i + 11], dx = b.readUInt16BE(i + 12); if (u === 1) o.dpi = dx; else if (u === 2) o.dpi = Math.round(dx * 2.54); }
      if (mk === 0xe2 && b.toString('latin1', i + 4, i + 16) === 'ICC_PROFILE\0') icc.push(b.subarray(i + 18, i + 2 + len));
      if (mk === 0xee && b.toString('latin1', i + 4, i + 9) === 'Adobe') o.adobe = true;
      if (mk >= 0xc0 && mk <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(mk)) { o.h = b.readUInt16BE(i + 5); o.w = b.readUInt16BE(i + 7); const nc = b[i + 9]; o.mode = nc === 1 ? 'grayscale' : nc === 4 ? 'cmyk' : 'rgb'; }
      i += 2 + len;
    }
    if (icc.length) o.icc = iccInfo(Buffer.concat(icc));
    return o;
  }
  if (b.toString('latin1', 0, 4) === 'GIF8') {
    Object.assign(o, { format: 'gif', w: b.readUInt16LE(6), h: b.readUInt16LE(8), mode: 'palette' });
    let frames = 0; for (let i = 13; i < b.length - 1; i++) if (b[i] === 0x21 && b[i + 1] === 0xf9) frames++;
    o.animated = frames > 1; return o;
  }
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) || (b[0] === 0x4d && b[1] === 0x4d && b[3] === 0x2a)) return { format: 'tiff' };
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return { format: 'webp' };
  if (b.toString('latin1', 0, 2) === 'BM') return { format: 'bmp', w: b.readInt32LE(18), h: Math.abs(b.readInt32LE(22)) };
  if (b.toString('latin1', 0, 4) === '%PDF') return { format: 'pdf' };
  if (b.toString('latin1', 0, 4) === '8BPS') return { format: 'psd' };
  if (b.toString('latin1', 4, 12).includes('ftyphei') || b.toString('latin1', 4, 12).includes('ftypmif')) return { format: 'heic' };
  return o;
}

// ---------- text: from the HTML/SVG source, or Tesseract OCR ----------
async function measureSource(page, src, img) {
  const url = pathToFileURL(resolve(src)).href;
  const load = async (w, h) => { await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 }); await page.goto(url, { waitUntil: 'load', timeout: 30000 }); await page.evaluate(() => document.fonts?.ready); await new Promise((r) => setTimeout(r, 150)); };
  await load(img.w, img.h);
  const ext = await page.evaluate(() => { let r = 0, b = 0; for (const e of document.querySelectorAll('body *, svg')) { const q = e.getBoundingClientRect(); if (q.width && q.height) { r = Math.max(r, q.right); b = Math.max(b, q.bottom); } } return { r, b }; });
  let W = img.w, H = img.h;
  if (ext.r > 100 && ext.r < img.w * 0.8 && Math.abs(ext.r / ext.b - img.w / img.h) < 0.05) { W = Math.round(ext.r); H = Math.round(ext.b); await load(W, H); }
  const boxes = await page.evaluate(() => {
    const out = [];
    for (const e of document.querySelectorAll('body *, svg *')) {
      const s = getComputedStyle(e); if (s.visibility === 'hidden' || s.display === 'none' || +s.opacity <= 0.05) continue;
      if (e.closest('title,desc,style,script')) continue;
      const own = [...e.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()); if (!own.length) continue;
      const rg = document.createRange(); rg.selectNodeContents(e); const rects = [...rg.getClientRects()].filter((r) => r.width > 1 && r.height > 1); if (!rects.length) continue;
      const r = rg.getBoundingClientRect();
      let fs = parseFloat(s.fontSize);
      if (e instanceof SVGElement && e.getScreenCTM) { const m = e.getScreenCTM(); if (m) fs *= Math.hypot(m.a, m.b); }
      else { const t = s.transform; if (t && t !== 'none') { const m = new DOMMatrix(t); fs *= Math.hypot(m.a, m.b); } }
      out.push({ t: own.map((n) => n.textContent.trim()).join(' ').replace(/\s+/g, ' ').slice(0, 80), x: r.left, y: r.top, w: r.width, h: r.height, fs });
    }
    // pictures drawn into the design that aren't photos: <img> of an SVG/logo file, inline <svg> with paths
    const logos = [...document.querySelectorAll('img')].filter((i) => /\.svg($|\?)|logo/i.test(i.getAttribute('src') || '')).map((i) => i.getAttribute('src'));
    return { out, logos };
  });
  const k = img.w / W;
  for (const b of boxes.out) { b.x *= k; b.y *= k; b.w *= k; b.h *= k; b.fs *= k; }
  return { boxes: boxes.out, logos: boxes.logos };
}
function hasTesseract() { try { execFileSync('tesseract', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } }
export function ocrBoxes(file) {
  const tsv = execFileSync('tesseract', [file, 'stdout', '--psm', '11', 'tsv'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32e6 });
  const words = [];
  for (const line of tsv.split('\n').slice(1)) {
    const c = line.split('\t'); if (c.length < 12 || c[0] !== '5') continue;
    const t = c[11].trim(), conf = +c[10];
    if (conf < 70 || (t.match(/[\p{L}\p{N}]/gu) || []).length < 2 || +c[9] < 8) continue;
    words.push({ t, x: +c[6], y: +c[7], w: +c[8], h: +c[9], conf });
  }
  words.sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const wd of words) {
    const L = lines.find((l) => Math.min(l.y + l.h, wd.y + wd.h) - Math.max(l.y, wd.y) > 0.5 * Math.min(l.h, wd.h) && wd.x - (l.x + l.w) < 1.5 * Math.max(l.h, wd.h) && wd.x + wd.w > l.x);
    if (L) { const x2 = Math.max(L.x + L.w, wd.x + wd.w), y2 = Math.max(L.y + L.h, wd.y + wd.h); L.x = Math.min(L.x, wd.x); L.y = Math.min(L.y, wd.y); L.w = x2 - L.x; L.h = y2 - L.y; L.t += ' ' + wd.t; L.maxh = Math.max(L.maxh, wd.h); }
    else lines.push({ ...wd, maxh: wd.h });
  }
  // Palm's estimate: a word's box height ÷ 0.75 ≈ its font size
  return lines.map((l) => ({ t: l.t.slice(0, 80), x: l.x, y: l.y, w: l.w, h: l.h, fs: l.maxh / 0.75, ocr: true }));
}
// Amazon's banned content for every image (Product image guide, "Requirements for all product images").
const BANNED = [
  [/\bamazon\b|\bprime\b|\balexa\b/i, 'Amazon logos or words ("Amazon", "Prime", "Alexa")'],
  [/amazon'?s\s*choice|premium\s*choice|best\s*-?\s*sell|top\s*-?\s*sell|#\s*1\s*best/i, 'an Amazon-style badge ("Amazon\'s Choice", "Best seller", "Top seller")'],
  [/★|☆|⭐|\b[1-5](\.\d)?\s*(\/\s*5\s*)?stars?\b|\b\d[\d,.]*\s*(customer\s*)?(reviews|ratings)\b|five[- ]star/i, 'customer reviews or five-star imagery'],
  [/free\s*(shipping|delivery|returns)/i, 'a claim like "free shipping"'],
];
const bannedIn = (t) => BANNED.filter(([re]) => re.test(t)).map(([, why]) => why);

// ---------- pixels: decode in Chrome, measure ----------
async function measurePixels(page, dataUrl, { main }) {
  await page.setContent('<html><body></body></html>');
  return page.evaluate(async (src, main) => {
    const im = new Image(); im.src = src; await im.decode();
    const W = im.naturalWidth, H = im.naturalHeight;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const x = c.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' }); x.drawImage(im, 0, 0);
    const d = x.getImageData(0, 0, W, H).data;
    let transparent = 0; for (let i = 3; i < d.length; i += 4) if (d[i] < 250) transparent++;
    const res = { W, H, transparent: transparent / (W * H) };
    if (!main) { // gallery: just the border, for the record
      return res;
    }
    // "ink": a pixel clearly not white (sum of the three channels' distance from 255 over 24; Palm's threshold).
    // Components on a 4-px grid; the product = every component at least 2% of the biggest; the rest are specks.
    const G = Math.max(2, Math.round(Math.max(W, H) / 600)), gw = Math.ceil(W / G), gh = Math.ceil(H / G);
    const cell = new Uint8Array(gw * gh);
    // the reference: the border's median colour (so a product on an off-white backdrop is still found)
    const bord = [[], [], []];
    for (let X = 0; X < W; X += 3) for (const y of [0, 1, H - 2, H - 1]) { const i = (y * W + X) * 4; for (let ch = 0; ch < 3; ch++) bord[ch].push(d[i + ch] * d[i + 3] / 255 + 255 * (1 - d[i + 3] / 255)); }
    for (let y = 0; y < H; y += 3) for (const X of [0, 1, W - 2, W - 1]) { const i = (y * W + X) * 4; for (let ch = 0; ch < 3; ch++) bord[ch].push(d[i + ch] * d[i + 3] / 255 + 255 * (1 - d[i + 3] / 255)); }
    const ref = bord.map((v) => v.sort((a, b) => a - b)[v.length >> 1]);
    for (let y = 0; y < H; y++) for (let X = 0; X < W; X++) { const i = (y * W + X) * 4; const a = d[i + 3] / 255; const r = d[i] * a + 255 * (1 - a), g = d[i + 1] * a + 255 * (1 - a), b = d[i + 2] * a + 255 * (1 - a); if (Math.abs(ref[0] - r) + Math.abs(ref[1] - g) + Math.abs(ref[2] - b) > 24) cell[Math.floor(y / G) * gw + Math.floor(X / G)] = 1; }
    const lab = new Int32Array(gw * gh).fill(-1), comps = [];
    for (let s = 0; s < cell.length; s++) {
      if (!cell[s] || lab[s] >= 0) continue;
      const id = comps.length, q = [s]; lab[s] = id; let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
      while (q.length) { const p = q.pop(); n++; const px = p % gw, py = (p - px) / gw; x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) { const nx = px + dx, ny = py + dy; if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue; const k = ny * gw + nx; if (cell[k] && lab[k] < 0) { lab[k] = id; q.push(k); } } }
      comps.push({ n, x0: x0 * G, y0: y0 * G, x1: Math.min(W, (x1 + 1) * G), y1: Math.min(H, (y1 + 1) * G) });
    }
    comps.sort((a, b) => b.n - a.n);
    const big = comps.length ? comps[0].n : 0;
    const parts = comps.filter((q) => q.n >= big * 0.02), specks = comps.filter((q) => q.n < big * 0.02);
    const box = parts.length ? { x0: Math.min(...parts.map((q) => q.x0)), y0: Math.min(...parts.map((q) => q.y0)), x1: Math.max(...parts.map((q) => q.x1)), y1: Math.max(...parts.map((q) => q.y1)) } : null;
    res.box = box; res.parts = parts.length;
    // the product's left edge at mid-height (where the zoom view looks: cut-out fringes and jagged edges show there)
    if (box) { const y = Math.round((box.y0 + box.y1) / 2); for (let X = box.x0; X < box.x1; X++) { const i = (y * W + X) * 4; if (Math.abs(ref[0] - d[i]) + Math.abs(ref[1] - d[i + 1]) + Math.abs(ref[2] - d[i + 2]) > 24) { res.edge = { x: X, y }; break; } } }
    res.specks = specks.slice(0, 12).map((q) => ({ x: q.x0, y: q.y0, w: q.x1 - q.x0, h: q.y1 - q.y0, px: q.n * G * G }));
    res.speck_count = specks.length;
    // background = outside the product's box grown by 2% of the longer side; the border ring = outer 1%.
    const m = Math.round(Math.max(W, H) * 0.02), ring = Math.max(2, Math.round(Math.max(W, H) * 0.01));
    const inBox = (X, y) => box && X >= box.x0 - m && X < box.x1 + m && y >= box.y0 - m && y < box.y1 + m;
    let bg = 0, exact = 0, near = 0, rN = 0, rExact = 0, sum = [0, 0, 0], minL = 255, devSum = 0;
    const heat = x.createImageData(W, H), hd = heat.data;
    for (let y = 0; y < H; y++) for (let X = 0; X < W; X++) {
      const i = (y * W + X) * 4;
      const a = d[i + 3] / 255; const r = Math.round(d[i] * a + 255 * (1 - a)), g = Math.round(d[i + 1] * a + 255 * (1 - a)), b = Math.round(d[i + 2] * a + 255 * (1 - a));
      const isRing = X < ring || y < ring || X >= W - ring || y >= H - ring;
      if (isRing) { rN++; if (r === 255 && g === 255 && b === 255 && a === 1) rExact++; }
      if (inBox(X, y)) continue;
      bg++; sum[0] += r; sum[1] += g; sum[2] += b; const lo = Math.min(r, g, b); minL = Math.min(minL, lo);
      const dev = 255 - lo; devSum += dev;
      if (dev === 0 && a === 1) exact++; if (dev <= 1) near++;
      // heat map (for the agent's sheet): off-white background pixels, magenta; the stronger the further off
      if (dev > 0) { hd[i] = 255; hd[i + 1] = 0; hd[i + 2] = 200; hd[i + 3] = Math.min(170, 70 + dev * 10); }
    }
    res.bg = bg ? { share_exact: exact / bg, share_254: near / bg, mean: sum.map((v) => Math.round(v / bg * 10) / 10), darkest: minL, mean_off: Math.round(devSum / bg * 100) / 100 } : null;
    res.ring = { share_exact: rN ? rExact / rN : 1 };
    const hc = document.createElement('canvas'); hc.width = W; hc.height = H; hc.getContext('2d').putImageData(heat, 0, 0);
    res.heat = hc.toDataURL('image/png');
    return res;
  }, dataUrl, main);
}

// ---------- check a folder ----------
const IMG = /\.(jpe?g|png|gif|tiff?|webp|bmp|heic|psd|pdf)$/i;
export async function check(dirOrFile, { main: mainName, out = 'look/amazon', plain = false, ocr = 'auto' } = {}) {
  const abs = resolve(dirOrFile);
  if (!existsSync(abs)) throw new Error('no such folder or file: ' + dirOrFile);
  const dir = statSync(abs).isDirectory() ? abs : dirname(abs);
  let files = statSync(abs).isDirectory() ? readdirSync(dir).filter((f) => IMG.test(f) && !f.startsWith('.')).sort() : [basename(abs)];
  if (!files.length) throw new Error('no images in ' + dirOrFile);
  const mainFile = mainName ? basename(mainName) : files.find((f) => /(^|[^a-z])main([^a-z]|$)/i.test(f)) || files[0];
  files = [mainFile, ...files.filter((f) => f !== mainFile)];
  const issues = [], images = [];
  const tess = hasTesseract();
  const browser = await launch();
  let sheet;
  try {
    const page = await browser.newPage();
    for (const [k, f] of files.entries()) {
      const isMain = k === 0, p = join(dir, f), buf = readFileSync(p), info = fileInfo(buf), bytes = buf.length;
      const im = { file: f, role: isMain ? 'main' : 'gallery', format: info.format, w: info.w, h: info.h, kb: Math.round(bytes / 1024), mode: info.mode, icc: info.icc ? info.icc.desc || info.icc.space : null, dpi: info.dpi ?? null };
      images.push(im);
      const add = (id, lvl, msg, fix) => issues.push(issue(id, lvl, msg, fix, f));
      // format (Amazon)
      if (!['jpeg', 'png', 'gif', 'tiff'].includes(info.format)) { add('format', 'error', `${f} is ${info.format.toUpperCase()}: Amazon takes JPEG (recommended), TIFF, PNG or non-animated GIF.`, 'Save it as JPEG.'); continue; }
      if (info.animated) add('animated-gif', 'error', `${f} is an animated GIF: Amazon takes non-animated GIFs only.`, 'Save it as JPEG.');
      // size and zoom (Amazon)
      let decodeUrl = `data:image/${info.format};base64,${buf.toString('base64')}`;
      if (info.format === 'tiff') {
        try { const t = join(mkdtempSync(join(tmpdir(), 'amz-')), 'x.png'); execFileSync('sips', ['-s', 'format', 'png', p, '--out', t], { stdio: 'ignore' }); const pb = readFileSync(t), pi = fileInfo(pb); im.w = pi.w; im.h = pi.h; decodeUrl = `data:image/png;base64,${pb.toString('base64')}`; }
        catch { add('not-measured', 'note', `${f} is TIFF and couldn't be decoded here, so its pixels weren't measured.`, 'Check it as a JPEG copy.'); continue; }
      }
      const W = im.w, H = im.h, long = Math.max(W, H);
      if (long < 500) add('too-small', 'error', `${f}: ${W}×${H}. Amazon won't upload under 500 px on the longest side.`, 'Make it 2000 px or more on the longest side; don\'t enlarge a small photo.');
      else if (long < 1000) add('no-zoom', 'warn', `${f}: ${W}×${H}. Under 1,000 px on the longest side, so shoppers can't zoom (Amazon recommends 1,000+).`, 'Make it 1,000 px or more on the longest side (Palm suggests 2000×2000).');
      if (long > 10000) add('too-big', 'error', `${f}: ${W}×${H}. Amazon's maximum is 10,000 px on the longest side.`, 'Scale it down.');
      if (info.dpi != null && info.dpi < 72) add('dpi', 'warn', `${f} says ${info.dpi} dpi; Amazon asks for at least 72.`, 'Save with 72 dpi or more (it doesn\'t change the pixels).');
      // colour (Amazon's technical page)
      if (info.mode === 'cmyk') add('cmyk', 'warn', `${f} is CMYK: Amazon says "Not preferred. Convert to RGB before uploading."`, 'Convert it to RGB (sRGB).');
      if (info.mode === 'grayscale') add('grayscale', 'warn', `${f} is grayscale: Amazon accepts that only for grey or silver metal products.`, 'Save it as RGB.');
      if (info.icc && !/srgb/i.test(info.icc.desc || '') && info.icc.space !== 'GRAY') add('icc-profile', 'warn', `${f} carries a "${info.icc.desc || info.icc.space}" colour profile. Amazon: "Do not rely on ICC color profiles"; colours may shift.`, 'Convert to sRGB and save.');
      if (info.alpha && info.format === 'png') im.alpha = true;
      if (H && W && Math.abs(W / H - 1) > 0.02) add('not-square', 'tip', `${f} is ${W}×${H}, not square. Amazon's search tiles and gallery are square-ish, so it will sit in white bars (Palm's observation).`, 'Use one square size for the set, e.g. 2000×2000.');
      // pixels
      const px = await measurePixels(page, decodeUrl, { main: isMain });
      im.decodeUrl = decodeUrl; if (px.heat) im.heat = px.heat;
      if (px.transparent > 0.001) add('transparent', isMain ? 'error' : 'warn', `${f} has transparent pixels (${pct(px.transparent)}). Amazon doesn't say how it shows them; ${isMain ? 'the main image needs RGB 255,255,255 there, not transparency' : 'flatten it'} (Palm's guidance).`, 'Flatten it onto pure white and save as JPEG.');
      // text: source, else OCR
      const stem = f.replace(/\.[^.]+$/, '');
      // its source: same name, beside it or one folder up (e.g. listing/main.jpg from ./main.html)
      const srcPath = [dir, dirname(dir)].map((dd) => { try { const n = readdirSync(dd).find((x) => /\.(html?|svg)$/i.test(x) && x.replace(/\.[^.]+$/, '') === stem); return n && join(dd, n); } catch { return null; } }).find(Boolean);
      let text = [], method = 'none', logos = [];
      if (srcPath) { const m = await measureSource(page, srcPath, { w: W, h: H }); text = m.boxes; logos = m.logos; method = 'source'; im.source = basename(srcPath); }
      if (tess && (ocr === 'always' || (ocr === 'auto' && method === 'none'))) {
        let o = []; try { o = ocrBoxes(join(dir, f)); } catch { /* unreadable for OCR */ }
        if (method === 'none') { text = o; method = o.length || tess ? 'ocr' : 'none'; } else im.ocr = o.map((b) => b.t);
      }
      im.text_method = method;
      const kPhone = 390 / W;
      im.text = text.map((b) => ({ t: b.t, font_px: Math.round(b.fs), at_phone_px: round(b.fs * kPhone) }));
      const est = method === 'ocr' ? ' (Palm\'s estimate from OCR)' : '';
      const allText = [...text.map((b) => b.t), ...(im.ocr || [])].join(' · ');
      const bad = bannedIn(allText);
      if (bad.length) add('banned-content', 'error', `${f} shows ${bad.join(' and ')}${est}: "${allText.slice(0, 140)}". Amazon doesn't allow that in any product image.`, 'Take it out (reviews and ratings belong in the reviews, not the images).');
      if (isMain) {
        const b = px.box;
        im.main = { product_box: b && { x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 }, fill_long: b ? round(Math.max((b.x1 - b.x0) / W, (b.y1 - b.y0) / H), 3) : 0, fill_w: b ? round((b.x1 - b.x0) / W, 3) : 0, fill_h: b ? round((b.y1 - b.y0) / H, 3) : 0, bg: px.bg, ring_exact: round(px.ring.share_exact, 4), specks: px.speck_count, speck_boxes: px.specks, edge: px.edge || null };
        if (!b) add('no-product', 'error', `${f}: no product found — the image is (almost) all white.`, 'Put the product in the image.');
        else {
          const fill = im.main.fill_long;
          if (fill < 0.85) add('product-small', 'warn', `${f}: the product spans ${pct(fill)} of the frame on its longer side (${b.x1 - b.x0}×${b.y1 - b.y0} px in ${W}×${H}). Amazon: "Show the product as 85% of the image"; "Product too small" is a suppression reason.`, `Crop in or scale the product up so its longer side spans 85% or more of the frame (about ${Math.ceil(0.85 * (b.y1 - b.y0 >= b.x1 - b.x0 ? H : W))} px here), centred, with the whole product inside.`);
          const edge = Math.max(1, Math.round(Math.max(W, H) * 0.002));
          const touches = [b.x0 <= edge && 'left', b.y0 <= edge && 'top', b.x1 >= W - edge && 'right', b.y1 >= H - edge && 'bottom'].filter(Boolean);
          if (touches.length) add('cropped', 'error', `${f}: the product runs to the ${touches.join(' and ')} edge, so part of it may be cut off. Amazon suppresses a main image with "a portion of the product cropped".`, 'Show the whole product with a little white all round.');
          if (px.bg) {
            const ok = px.bg.share_exact >= 0.97 && px.ring.share_exact >= 0.995;
            im.main.white_ok = ok;
            if (!ok) add('not-white', 'error', `${f}: the background isn't pure white. Outside the product, ${pct(px.bg.share_exact)} of pixels are exactly 255,255,255 (border: ${pct(px.ring.share_exact)}); the average is ${px.bg.mean.join(',')} and the darkest ${px.bg.darkest}. Amazon requires "pure white (RGB color values: 255, 255, 255)" and suppresses a "Non-white background". (Palm's threshold: 97% of the background and 99.5% of the border exactly 255.)`, 'Paint every background pixel 255,255,255: put the cut-out on pure white, clean the remover app\'s leftovers (shadow halo, scraps), and don\'t add a grey gradient or vignette. On the sheet, magenta = not pure white.');
          }
          if (px.speck_count) add('specks', 'warn', `${f}: ${px.speck_count} stray speck${px.speck_count > 1 ? 's' : ''} away from the product (e.g. ${px.specks.slice(0, 2).map((q) => `${q.w}×${q.h} px at ${q.x},${q.y}`).join('; ')}): leftovers from the background removal, or dust (Palm's measurement).`, 'Paint them out with pure white.');
        }
        if (text.length) add('main-text', 'error', `${f} has text on it${est}: ${text.slice(0, 4).map((b) => `"${b.t}"`).join(', ')}. Amazon suppresses a main image with "text, logo, graphics, or watermarks"${method === 'ocr' ? ' (fine only if the words are printed on the product itself: OCR can\'t tell)' : ''}.`, 'Keep the main image to the product alone on white; put words in the gallery images.');
        if (logos.length) add('main-logo', 'error', `${f}'s source places a logo or graphic (${logos.slice(0, 2).join(', ')}). Amazon suppresses a main image with "text, logo, graphics, or watermarks".`, 'Remove it from the main image (a logo printed on the product itself is fine).');
      } else if (text.length) {
        const small = text.filter((b) => b.fs * kPhone < 10).sort((a, b) => a.fs - b.fs);
        if (small.length) add('text-small-phone', 'warn', `${f}: ${small.length} line${small.length > 1 ? 's' : ''} of text too small to read when the image fills a phone (390 px wide)${est}: ${small.slice(0, 4).map((b) => `"${b.t}" ${Math.round(b.fs)} px → ${round(b.fs * kPhone)} px`).join('; ')}. Palm's guidance: 10 px or more there.`, `Make every word at least ${Math.ceil(10 / kPhone)} px (font size) on this ${W}-wide image, or cut it.`);
      }
    }
    const nGallery = images.length - 1;
    if (nGallery < 6) issues.push(issue('few-images', 'note', `${nGallery} gallery image${nGallery === 1 ? '' : 's'} besides the main one. Amazon recommends at least six more and one video.`, 'Add more angles, detail, scale and in-use shots when you have the photos.'));
    if (!tess) issues.push(issue('no-ocr', 'note', 'Tesseract isn\'t installed, so text in images without an HTML/SVG source wasn\'t read: check the main image for added words by eye.', 'Keep each image\'s HTML beside it (same name), or install Tesseract.'));
    sheet = await drawSheet(page, { images, plain, out });
  } finally { await browser.close(); }
  for (const im of images) delete im.decodeUrl, delete im.heat;
  const errors = issues.filter((i) => i.level === 'error').length, warnings = issues.filter((i) => i.level === 'warn').length;
  return { ok: errors === 0, errors, warnings, main: images[0]?.main ?? null, images, issues, sheet };
}

// ---------- the sheet ----------
// Stand-in competitors: plain shapes on pure white, filling ~85% (no real products or brands).
const RIVALS = [
  (s) => `<div style="position:absolute;left:${s * .36}px;top:${s * .07}px;width:${s * .28}px;height:${s * .86}px;border-radius:${s * .06}px ${s * .06}px ${s * .03}px ${s * .03}px;background:linear-gradient(90deg,#1f3b5a,#4f78a3 40%,#1a3049)"></div>`,
  (s) => `<div style="position:absolute;left:${s * .3}px;top:${s * .08}px;width:${s * .4}px;height:${s * .84}px;border-radius:${s * .04}px;background:linear-gradient(90deg,#b5b9bd,#eef0f1 45%,#8f9498)"></div>`,
  (s) => `<div style="position:absolute;left:${s * .33}px;top:${s * .08}px;width:${s * .34}px;height:${s * .84}px;border-radius:${s * .17}px ${s * .17}px ${s * .05}px ${s * .05}px;background:linear-gradient(90deg,#7a2430,#c9535f 40%,#6a1e28)"></div>`,
  (s) => `<div style="position:absolute;left:${s * .38}px;top:${s * .07}px;width:${s * .24}px;height:${s * .86}px;border-radius:${s * .05}px;background:linear-gradient(90deg,#222,#555 40%,#111)"></div>`,
  (s) => `<div style="position:absolute;left:${s * .08}px;top:${s * .3}px;width:${s * .84}px;height:${s * .4}px;border-radius:${s * .03}px;background:linear-gradient(#e7a23a,#c7811d)"></div>`,
];
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
async function drawSheet(page, { images, plain, out }) {
  const main = images[0];
  const img = (im, s, extra = '') => im?.decodeUrl ? `<img src="${im.decodeUrl}" style="width:${s}px;height:${s}px;object-fit:contain;display:block;${extra}">` : `<div style="width:${s}px;height:${s}px;background:repeating-linear-gradient(45deg,#fdd 0 8px,#fff 8px 16px)"></div>`;
  const bar = (w, c = '#ddd', h = 10) => `<div style="height:${h}px;width:${w}px;background:${c};border-radius:3px;margin-top:6px"></div>`;
  // desktop search: white page, square image boxes ~260 px (Palm's approximation, Nov 2026)
  const tile = (s, mine, i, blend) => `<div style="width:${s}px;flex:none"><div style="position:relative;width:${s}px;height:${s}px;background:${blend ? '#f7f7f7' : '#fff'}">${mine ? img(main, s, blend ? 'mix-blend-mode:multiply' : '') : `<div style="position:absolute;inset:0;background:#fff;${blend ? 'mix-blend-mode:multiply' : ''}">${RIVALS[i % RIVALS.length](s)}</div>`}</div>${bar(s * .9, '#c8c8c8')}${bar(s * .6, '#c8c8c8')}<div style="display:flex;gap:6px;align-items:center;margin-top:8px"><div style="font:700 ${Math.max(14, s / 12)}px Arial;color:#0f1111">$${mine ? '32.00' : ['24.99', '29.95', '34.00', '19.99', '27.50'][i % 5]}</div></div></div>`;
  const desk = `<div class="sec" style="background:#fff"><h2>Amazon search on a desktop: square image boxes about 260 px on a white page, stand-in products around yours (Palm's approximation, Nov 2026)</h2><div style="display:flex;gap:28px">${tile(260, false, 0)}${tile(260, true)}${tile(260, false, 1)}${tile(260, false, 2)}${tile(260, false, 3)}</div></div>`;
  const phone = `<div style="width:390px;flex:none;background:#fff;padding:10px 8px;box-sizing:border-box"><div style="color:#555;font:600 13px system-ui;margin-bottom:8px">Phone search, 2 columns (~180 px images on a light grey tile, multiplied)</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">${tile(180, false, 3, true)}${tile(180, true, 0, true)}${tile(180, false, 2, true)}${tile(180, false, 4, true)}</div></div>`;
  // product page, desktop: thumbnails ~40 px down the left, the main image ~500 px, zoom at 100%
  const thumbs = images.map((im, i) => `<div style="width:40px;height:40px;border:${i === 0 ? '2px solid #e77600' : '1px solid #bbb'};border-radius:4px;overflow:hidden;margin-bottom:8px;background:#fff">${img(im, 40 - (i === 0 ? 4 : 2))}</div>`).join('');
  const b = main?.main?.product_box;
  let zoom = '<div style="width:320px;height:320px;display:flex;align-items:center;justify-content:center;background:#f3f3f3;color:#666;font:14px system-ui;text-align:center">No zoom: under 1,000 px<br>on the longest side</div>';
  if (main?.decodeUrl && Math.max(main.w, main.h) >= 1000) {
    const e = main.main?.edge, cx = e ? e.x + 50 : b ? b.x + b.w / 2 : main.w / 2, cy = e ? e.y : b ? b.y + b.h * 0.35 : main.h / 2;
    zoom = `<div style="width:320px;height:320px;overflow:hidden;position:relative;background:#fff;border:1px solid #ddd"><img src="${main.decodeUrl}" style="position:absolute;left:${160 - cx}px;top:${160 - cy}px;width:${main.w}px;height:${main.h}px;max-width:none"></div>`;
  }
  const page1 = `<div style="flex:1;background:#fff;padding:10px 14px"><div style="color:#555;font:600 13px system-ui;margin-bottom:10px">Product page on a desktop: thumbnails, the main image (~500 px), and the hover zoom at 100% on the product's edge</div><div style="display:flex;gap:14px;align-items:flex-start"><div>${thumbs}</div>${img(main, 500)}<div>${zoom}<div style="width:320px">${bar(300, '#ccc', 14)}${bar(240, '#ccc', 14)}${bar(120, '#e0e0e0')}</div></div></div></div>`;
  // every image on a phone, as swiped (full width, 390 px)
  const gal = images.map((im, i) => `<div style="flex:none;width:390px;background:#fff"><div style="font:600 12px system-ui;color:#555;padding:6px 8px">${i + 1} of ${images.length} · ${esc(im.file)}${im.role === 'main' ? ' (main)' : ''}</div>${img(im, 390)}<div style="display:flex;gap:6px;justify-content:center;padding:8px">${images.map((_, j) => `<div style="width:7px;height:7px;border-radius:50%;background:${j === i ? '#007185' : '#ccc'}"></div>`).join('')}</div></div>`).join('');
  // full size main (agent's sheet: off-white pixels in magenta, the product box, the 85% guide, specks circled)
  let full = '';
  if (main?.decodeUrl) {
    const fw = 720, k = fw / main.w, fh = Math.round(main.h * k);
    let marks = '';
    if (!plain && main.main) {
      if (main.heat) marks += `<img src="${main.heat}" style="position:absolute;left:0;top:0;width:${fw}px;height:${fh}px">`;
      if (b) marks += `<div style="position:absolute;left:${b.x * k}px;top:${b.y * k}px;width:${b.w * k}px;height:${b.h * k}px;border:2px solid #1a3;box-sizing:border-box"></div><div style="position:absolute;left:${b.x * k}px;top:${(b.y + b.h) * k + 2}px;font:600 12px system-ui;color:#fff;background:#1a3;padding:0 4px">product ${round(main.main.fill_long * 100)}% of the frame</div>`;
      marks += `<div style="position:absolute;left:${fw * .075}px;top:${fh * .075}px;width:${fw * .85}px;height:${fh * .85}px;border:2px dashed #39f;box-sizing:border-box"></div><div style="position:absolute;right:${fw * .075 + 4}px;top:${fh * .075 + 4}px;font:600 12px system-ui;color:#39f">85%</div>`;
      for (const q of main.main.speck_boxes || []) marks += `<div style="position:absolute;left:${q.x * k - 14}px;top:${q.y * k - 14}px;width:${q.w * k + 28}px;height:${q.h * k + 28}px;border:3px solid #f22;border-radius:50%;box-sizing:border-box"></div>`;
    }
    const facts = main.main ? `<div style="font:14px/1.6 system-ui;color:#222;max-width:640px">${plain ? '' : `<b>Measured</b><br>Product: ${round(main.main.fill_long * 100)}% of the frame on its longer side (Amazon: 85%)<br>Background exactly 255,255,255: ${main.main.bg ? pct(main.main.bg.share_exact) : '—'} (border ${pct(main.main.ring_exact)}); average ${main.main.bg ? main.main.bg.mean.join(',') : '—'}<br>Stray specks: ${main.main.specks}<br><span style="color:#c0c">magenta</span> = background pixels that aren't pure white · green = product box · blue dashes = 85% of the frame · red circles = specks<br>`}${images.map((im) => `${esc(im.file)}: ${im.w}×${im.h} ${String(im.format).toUpperCase()} ${im.kb} KB${im.mode ? ' ' + im.mode.toUpperCase() : ''}${im.icc ? ' · ' + esc(im.icc) : ''}`).join('<br>')}</div>` : '';
    full = `<div class="sec" style="background:#ecebe8"><h2>The main image at full size${plain ? '' : ', with what was measured'}</h2><div style="display:flex;gap:24px;align-items:flex-start"><div style="position:relative;width:${fw}px;height:${fh}px;background:#fff;outline:1px solid #ccc">${img(main, fw).replace(`height:${fw}px`, `height:${fh}px`)}${marks}</div>${facts}</div></div>`;
  }
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;width:1500px;background:#ecebe8;font-family:system-ui,sans-serif}.sec{padding:16px 20px}h2{font:600 14px system-ui;margin:0 0 12px;color:#444}</style></head><body>
<div class="sec" style="background:#232f3e;color:#fff"><h2 style="color:#fff;font-size:16px">Amazon listing images: ${images.length} (main: ${esc(main?.file)}), where Amazon shows them (Palm's approximation of Amazon's layouts, Nov 2026; the other products are stand-ins)</h2></div>
${desk}
<div class="sec" style="display:flex;gap:16px;align-items:flex-start;background:#ecebe8">${phone}${page1}</div>
<div class="sec" style="background:#ecebe8"><h2>Every image on a phone, as swiped (full width, 390 px)</h2><div style="display:flex;flex-wrap:wrap;gap:16px">${gal}</div></div>
${full}
</body></html>`;
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(resolve(out) + '-sheet.html', html);
  await page.setViewport({ width: 1500, height: 1000, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => Promise.all([...document.images].map((i) => i.complete ? 0 : new Promise((r) => (i.onload = i.onerror = r)))));
  await page.screenshot({ path: resolve(out) + '-sheet.png', fullPage: true });
  return resolve(out) + '-sheet.png';
}

// ---------- render HTML to an image ----------
export async function render(file, { out, size = '2000x2000', quality = 92 } = {}) {
  const [w, h] = String(size).split('x').map(Number);
  if (!w || !h) throw new Error('--size WxH, e.g. 2000x2000');
  const browser = await launch();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(resolve(file)).href, { waitUntil: 'load', timeout: 30000 });
    await page.evaluate(() => document.fonts?.ready); await new Promise((r) => setTimeout(r, 200));
    await page.evaluate(() => Promise.all([...document.images].map((i) => i.complete ? 0 : new Promise((r) => (i.onload = i.onerror = r)))));
    const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight }));
    mkdirSync(dirname(resolve(out)), { recursive: true });
    const jpeg = !/\.png$/i.test(out);
    await page.evaluate(() => { if (getComputedStyle(document.body).backgroundColor === 'rgba(0, 0, 0, 0)' && getComputedStyle(document.documentElement).backgroundColor === 'rgba(0, 0, 0, 0)') document.documentElement.style.background = '#fff'; });
    await page.screenshot({ path: out, type: jpeg ? 'jpeg' : 'png', ...(jpeg ? { quality } : {}), clip: { x: 0, y: 0, width: w, height: h } });
    const issues = [];
    if (m.sw > w + 1 || m.sh > h + 1) issues.push(issue('overflow', 'warn', `The HTML is ${m.sw}×${m.sh}, bigger than ${w}×${h}: part of it is cut off.`, `html,body{width:${w}px;height:${h}px;overflow:hidden}`));
    return { ok: !issues.length, out, w, h, kb: Math.round(statSync(out).size / 1024), issues };
  } finally { await browser.close(); }
}

// ---------- self-test ----------
async function selfTest() {
  const d = mkdtempSync(join(tmpdir(), 'amazon-image-'));
  const bottle = (top, hgt, extra = '') => `<div style="position:absolute;left:${1000 - hgt * 0.14}px;top:${top}px;width:${hgt * 0.28}px;height:${hgt}px;border-radius:60px 60px 20px 20px;background:linear-gradient(90deg,#5e7563,#a9bfa9 30%,#4b5f50)"></div>${extra}`;
  const page = (body, bg = '#fff') => `<html><body style="margin:0;width:2000px;height:2000px;overflow:hidden;position:relative;background:${bg};font-family:Arial">${body}</body></html>`;
  // good: product 88% tall on pure white, gallery with big text
  mkdirSync(join(d, 'good')); mkdirSync(join(d, 'bad'));
  writeFileSync(join(d, 'good', 'main.html'), page(bottle(120, 1760)));
  writeFileSync(join(d, 'good', '02-size.html'), page(bottle(200, 1500) + '<div style="position:absolute;left:80px;top:120px;font:700 110px Arial">27 cm tall</div>'));
  await render(join(d, 'good', 'main.html'), { out: join(d, 'good', 'main.jpg') });
  await render(join(d, 'good', '02-size.html'), { out: join(d, 'good', '02-size.jpg') });
  const g = await check(join(d, 'good'), { out: join(d, 'good-look') });
  const gl = g.issues.filter((i) => ['error', 'warn'].includes(i.level));
  if (gl.length || !(g.main.fill_long > 0.85) || g.main.bg.share_exact < 0.99) throw new Error('good: ' + JSON.stringify({ issues: gl, main: g.main }));
  // bad: off-white (#f6f6f6) background, small product, a speck, a badge with stars on the main, tiny gallery text, a "Best seller" line
  writeFileSync(join(d, 'bad', 'main.html'), page(bottle(500, 1000) + '<div style="position:absolute;left:150px;top:1800px;width:30px;height:12px;background:#7a5a3a"></div><div style="position:absolute;right:120px;top:140px;font:700 70px Arial;color:#c00">4.8 ★★★★★</div>', '#f6f6f6'));
  writeFileSync(join(d, 'bad', '02-facts.html'), page(bottle(200, 1500) + '<div style="position:absolute;left:80px;top:120px;font:400 34px Arial">Keeps drinks cold for 24 hours and hot for 12</div><div style="position:absolute;left:80px;top:1800px;font:700 90px Arial">Best Seller</div>'));
  await render(join(d, 'bad', 'main.html'), { out: join(d, 'bad', 'main.jpg') });
  await render(join(d, 'bad', '02-facts.html'), { out: join(d, 'bad', '02-facts.jpg') });
  const b = await check(join(d, 'bad'), { out: join(d, 'bad-look') });
  const ids = b.issues.map((i) => i.id + '@' + i.file);
  for (const want of ['not-white@main.jpg', 'product-small@main.jpg', 'main-text@main.jpg', 'banned-content@main.jpg', 'text-small-phone@02-facts.jpg', 'banned-content@02-facts.jpg']) if (!ids.includes(want)) throw new Error('bad: expected ' + want + ' in ' + ids.join(','));
  // a cropped product and a CMYK-free PNG with transparency
  mkdirSync(join(d, 'crop'));
  writeFileSync(join(d, 'crop', 'main.html'), page(bottle(-100, 2300)));
  await render(join(d, 'crop', 'main.html'), { out: join(d, 'crop', 'main.jpg') });
  const c = await check(join(d, 'crop'), { out: join(d, 'crop-look') });
  if (!c.issues.some((i) => i.id === 'cropped')) throw new Error('crop: ' + c.issues.map((i) => i.id));
  // image only (no source): OCR finds the added words on the main image
  if (hasTesseract()) {
    mkdirSync(join(d, 'ocr')); writeFileSync(join(d, 'ocr-main.html'), page(bottle(120, 1760) + '<div style="position:absolute;left:100px;top:160px;font:800 120px Arial;color:#222">LEAK PROOF</div>'));
    await render(join(d, 'ocr-main.html'), { out: join(d, 'ocr', 'main.jpg') });
    const o = await check(join(d, 'ocr'), { out: join(d, 'ocr-look') });
    if (!o.issues.some((i) => i.id === 'main-text' || i.id === 'banned-content')) throw new Error('ocr: ' + JSON.stringify(o.images[0].text));
  } else console.log('(Tesseract not installed: OCR path not tested)');
  console.log(`amazon-image-check: all tests pass (good: no warnings, fill ${g.main.fill_long}; bad: ${ids.join(', ')}; sheets in ${d})`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (k, dflt) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : dflt; };
  const VALUED = new Set(['--out', '--size', '--quality', '--main']);
  const pos = argv.filter((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1]));
  const done = (r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); };
  const fail = (e) => { console.error(String(e.message || e)); process.exit(2); };
  if (argv.includes('--test')) selfTest().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
  else if (pos[0] === 'render' && pos[1]) render(pos[1], { out: opt('out', 'main.jpg'), size: opt('size', '2000x2000'), quality: +opt('quality', 92) }).then(done, fail);
  else if (pos[0] === 'check' && pos[1]) check(pos[1], { main: opt('main'), out: opt('out', 'look/amazon'), plain: argv.includes('--plain') }).then(done, fail);
  else fail('usage: amazon-image-check.mjs check listing/ [--main main.jpg] [--out look/amazon]\n       amazon-image-check.mjs render main.html --size 2000x2000 --out listing/main.jpg\n       amazon-image-check.mjs --test');
}
