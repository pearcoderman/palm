#!/usr/bin/env node
// Palm tool: reel-cover-check — lets an agent see a week's covers for Reels, TikToks and Shorts where the apps show them,
// as a set, and measures what fails there. A 1080×1920 cover is seen: cut to its middle 3:4 on the Instagram profile
// grid and the TikTok profile grid (tiles ~129 px wide on a phone, TikTok's view count over the bottom-left), full screen
// under each app's buttons and caption, and in a YouTube Shorts shelf with the title printed over its bottom. The covers
// sit side by side there, so they also need to read as one set.
//
//   node reel-cover-check.mjs check <covers folder> [--handle @name] [--titles "Title 1|Title 2|…"] [--out look/covers]
//                                   [--plain] [--ocr auto|always|never]
//       → JSON {ok, errors, warnings, covers:[…], set:{…}, issues, sheet}. Then LOOK at <out>-sheet.png.
//       Each cover is an image (JPG/PNG) in the folder, in name order (01-…, 02-…: the order they're posted). Keep the
//       HTML/SVG each was made from beside it with the same name, so its text can be measured; its <title> is used as
//       the video title in the mock Shorts shelf (or pass --titles).
//   node reel-cover-check.mjs render <cover.html | folder of .html> [--size 1080x1920] [--out cover.jpg | folder]
//       → renders the HTML at exactly that size (JPG, or PNG without alpha).
//   node reel-cover-check.mjs --self-test
//
// Facts (read 2026-11-26):
//   YouTube Help "Add custom thumbnails on YouTube" (support.google.com/youtube/answer/72431): Shorts thumbnails 9:16,
//     2160×3840 recommended, minimum height 640 px, JPG or PNG, 50 MB on desktop; custom Shorts thumbnails are uploaded
//     in YouTube Studio (Content → Shorts).
//   Meta's Instagram Graph API reference (IG User Media, cover_url): Reels covers 9:16 recommended; a cover that isn't
//     9:16 is cut to its middle-most 9:16 rectangle. Instagram's 3:4 profile grid (since Jan 2025) is a centre crop;
//     Instagram publishes no pixel size for it (Palm data pack design/platform-sizes).
//   TikTok's Content Posting API sets the cover as a frame of the video (video_cover_timestamp_ms); TikTok's in-app cover
//     editor (frame or uploaded image, with text) isn't documented on a page Palm could read.
// Palm's approximation of the apps' layouts (Nov 2026; none of the apps publish these): the grid tiles (3 across on a
//   390 px phone, ~129 px wide, a centre 3:4 crop on Instagram and TikTok), TikTok's view count over the bottom-left of a
//   tile, the full-screen buttons and captions (Reels: top 210, bottom 310, right 84 px; TikTok: top 108, bottom 320,
//   left 60, right 120 px on 1080×1920, community-measured), and the Shorts shelf tile (~183 px wide, the title over
//   its bottom ~22%).
// Palm's thresholds (guidance, not a platform rule): every line of words at least 7 px (font size) on a 129 px grid
//   tile, the title at least 11 px there; text contrast 3:1 or more against the pixels behind it; across the set, the
//   title's position within 12% of the cover's height and its size within 1.6× of each other.
// Text size: from each cover's HTML/SVG source (each line measured in the page), else from the image with Tesseract OCR
//   if installed (Palm's estimate: a word's box height ÷ 0.75 ≈ its font size; OCR misses styled lettering).
// adds: tool. Runs on the user's machine with their Chrome/Edge/Chromium; nothing leaves it.

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve, basename } from 'node:path';
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
const launch = () => loadPuppeteer().launch({ executablePath: findChrome(), headless: true, timeout: 90000, protocolTimeout: 180000, args: ['--no-sandbox', '--hide-scrollbars', '--allow-file-access-from-files'] });

export function imageInfo(b) {
  if (!b || b.length < 12) return { format: 'unknown' };
  if (b.readUInt32BE(0) === 0x89504e47) return { format: 'png', w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i < b.length - 9;) {
      if (b[i] !== 0xff) { i++; continue; }
      const mk = b[i + 1]; if (mk === 0xd8 || mk === 0x01 || (mk >= 0xd0 && mk <= 0xd7)) { i += 2; continue; }
      const len = b.readUInt16BE(i + 2);
      if (mk >= 0xc0 && mk <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(mk)) return { format: 'jpeg', w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
      i += 2 + len;
    }
    return { format: 'jpeg' };
  }
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return { format: 'webp' };
  return { format: 'unknown' };
}

// ---------- Palm's approximation of the layouts (Nov 2026), on a 1080×1920 cover ----------
export const TILE = { grid: 129, shorts: 183 };                     // px wide on a 390 px phone
const FULL = {                                                      // full-screen buttons, caption and bars
  reels: { name: 'Instagram Reels', top: 210, bottom: 310, left: 0, right: 84 },
  tiktok: { name: 'TikTok', top: 108, bottom: 320, left: 60, right: 120 },
};
const TT_BADGE = { w: 0.5, h: 0.13 };                               // TikTok view count: share of the 3:4 tile, bottom-left
const SHORTS_OVERLAY = 0.22;                                        // Shorts shelf: title over the bottom 22% of the tile
const MIN_TILE_FS = 7, HEAD_TILE_FS = 11, MIN_CONTRAST = 3, SET_POS = 0.12, SET_SIZE = 1.6;
const issue = (id, level, msg, fix, file) => ({ id, level, file, msg, fix });
const round = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d;
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

// The zones on a W×H cover (scaled from 1080×1920).
export function zones(W, H) {
  const k = W / 1080, cropH = W * 4 / 3, gy0 = (H - cropH) / 2, gy1 = gy0 + cropH;
  return {
    grid: { x0: 0, y0: gy0, x1: W, y1: gy1 },
    ttBadge: { x0: 0, y0: gy1 - TT_BADGE.h * cropH, x1: TT_BADGE.w * W, y1: gy1 },
    shorts: { x0: 0, y0: H * (1 - SHORTS_OVERLAY), x1: W, y1: H },
    reels: { x0: FULL.reels.left * k, y0: FULL.reels.top * k, x1: W - FULL.reels.right * k, y1: H - FULL.reels.bottom * k },
    tiktok: { x0: FULL.tiktok.left * k, y0: FULL.tiktok.top * k, x1: W - FULL.tiktok.right * k, y1: H - FULL.tiktok.bottom * k },
  };
}

// ---------- text from the source (HTML or SVG) ----------
async function measureSource(page, src, img) {
  const url = pathToFileURL(resolve(src)).href;
  const load = async (w, h) => { await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 }); await page.goto(url, { waitUntil: 'load', timeout: 30000 }); await page.evaluate(() => document.fonts?.ready); await new Promise((r) => setTimeout(r, 150)); };
  await load(img.w, img.h);
  // a design made at 1080×1920 but rendered at 2× sits in the top-left of a bigger viewport: find its real size
  const ext = await page.evaluate(() => { let r = 0, b = 0; for (const e of document.querySelectorAll('body *, svg')) { const q = e.getBoundingClientRect(); if (q.width && q.height) { r = Math.max(r, q.right); b = Math.max(b, q.bottom); } } return { r, b }; });
  let W = img.w, H = img.h;
  if (ext.r > 100 && ext.r < img.w * 0.8 && Math.abs(ext.r / ext.b - img.w / img.h) < 0.05) { W = Math.round(ext.r); H = Math.round(ext.b); await load(W, H); }
  const res = await page.evaluate(() => {
    const out = [];
    const rgb = (s) => (s.match(/[\d.]+/g) || []).slice(0, 4).map(Number);
    for (const e of document.querySelectorAll('body *, svg *')) {
      const s = getComputedStyle(e); if (s.visibility === 'hidden' || s.display === 'none' || +s.opacity <= 0.05) continue;
      const own = [...e.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()); if (!own.length) continue;
      const rg = document.createRange(); rg.selectNodeContents(e); const rects = [...rg.getClientRects()].filter((r) => r.width > 1 && r.height > 1); if (!rects.length) continue;
      const r = rg.getBoundingClientRect();
      let fs = parseFloat(s.fontSize);
      if (e instanceof SVGElement && e.getScreenCTM) { const m = e.getScreenCTM(); if (m) fs *= Math.hypot(m.a, m.b); }
      else { const t = s.transform; if (t && t !== 'none') { const m = new DOMMatrix(t); fs *= Math.hypot(m.a, m.b); } }
      const strokeW = parseFloat(s.webkitTextStrokeWidth || 0) || (e instanceof SVGElement ? parseFloat(s.strokeWidth || 0) * (s.stroke !== 'none' ? 1 : 0) : 0);
      const extra = [];
      if (strokeW > 0) extra.push(rgb(e instanceof SVGElement ? s.stroke : s.webkitTextStrokeColor));
      if (s.textShadow && s.textShadow !== 'none') for (const m of s.textShadow.matchAll(/rgba?\([^)]+\)/g)) extra.push(rgb(m[0]));
      out.push({ t: own.map((n) => n.textContent.trim()).join(' ').replace(/\s+/g, ' ').slice(0, 60), x: r.left, y: r.top, w: r.width, h: r.height, fs, color: rgb(e instanceof SVGElement ? s.fill : s.color), extra, lines: rects.map((q) => ({ x: q.left, y: q.top, w: q.width, h: q.height })) });
    }
    return { boxes: out, title: document.title || '' };
  });
  const k = img.w / W;
  for (const b of res.boxes) { b.x *= k; b.y *= k; b.w *= k; b.h *= k; b.fs *= k; b.lines = b.lines.map((l) => ({ x: l.x * k, y: l.y * k, w: l.w * k, h: l.h * k })); }
  return { design: { w: W, h: H }, boxes: res.boxes, title: res.title.trim() };
}

// ---------- text from the image (Tesseract OCR, if installed) ----------
function hasTesseract() { try { execFileSync('tesseract', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } }
export function ocrBoxes(file) {
  const tsv = execFileSync('tesseract', [file, 'stdout', '--psm', '11', 'tsv'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32e6 });
  const words = [];
  for (const line of tsv.split('\n').slice(1)) {
    const c = line.split('\t'); if (c.length < 12 || c[0] !== '5') continue;
    const t = c[11].trim(), conf = +c[10], x = +c[6], y = +c[7], w = +c[8], h = +c[9];
    if (conf < 60 || (t.match(/[\p{L}\p{N}]/gu) || []).length < 2 || h < 8) continue;
    words.push({ t, x, y, w, h });
  }
  words.sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const wd of words) {
    const L = lines.find((l) => Math.min(l.y + l.h, wd.y + wd.h) - Math.max(l.y, wd.y) > 0.5 * Math.min(l.h, wd.h) && wd.x - (l.x + l.w) < 1.5 * Math.max(l.h, wd.h) && wd.x + wd.w > l.x);
    if (L) { const x2 = Math.max(L.x + L.w, wd.x + wd.w), y2 = Math.max(L.y + L.h, wd.y + wd.h); L.x = Math.min(L.x, wd.x); L.y = Math.min(L.y, wd.y); L.w = x2 - L.x; L.h = y2 - L.y; L.t += ' ' + wd.t; L.maxh = Math.max(L.maxh, wd.h); }
    else lines.push({ ...wd, maxh: wd.h });
  }
  return lines.map((l) => ({ t: l.t.slice(0, 60), x: l.x, y: l.y, w: l.w, h: l.h, fs: l.maxh / 0.75, lines: [{ x: l.x, y: l.y, w: l.w, h: l.h }], ocr: true }));
}

// ---------- contrast of each line against the cover's own pixels ----------
async function contrasts(page, dataUrl, boxes) {
  if (!boxes.length) return;
  await page.setContent('<html><body></body></html>');
  const res = await page.evaluate(async (src, boxes) => {
    const im = new Image(); im.src = src; await im.decode();
    const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight; const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(im, 0, 0);
    const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const L = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    return boxes.map((b) => {
      const X = Math.max(0, Math.floor(b.x)), Y = Math.max(0, Math.floor(b.y)), W = Math.min(c.width - X, Math.ceil(b.w)), H = Math.min(c.height - Y, Math.ceil(b.h));
      if (W < 2 || H < 2) return null;
      const d = x.getImageData(X, Y, W, H).data, step = Math.max(1, Math.floor(Math.sqrt(W * H / 40000)));
      const px = []; for (let yy = 0; yy < H; yy += step) for (let xx = 0; xx < W; xx += step) { const i = (yy * W + xx) * 4; px.push([d[i], d[i + 1], d[i + 2]]); }
      if (b.color) {
        const tc = b.color, far = px.filter((p) => Math.abs(p[0] - tc[0]) + Math.abs(p[1] - tc[1]) + Math.abs(p[2] - tc[2]) > 60);
        const lum = (far.length < px.length * 0.15 ? px : far).map((p) => L(...p)).sort((a, b) => a - b), bg = lum[Math.floor(lum.length / 2)];
        const tl = L(tc[0], tc[1], tc[2]);
        let best = ratio(tl, bg); for (const e of b.extra || []) if (e.length >= 3 && (e[3] ?? 1) > 0.5) best = Math.max(best, ratio(tl, L(e[0], e[1], e[2])));
        return best;
      }
      const lum = px.map((p) => L(...p)); const hist = new Array(64).fill(0); for (const v of lum) hist[Math.min(63, Math.floor(v * 64))]++;
      let bestT = 32, bestV = -1; const n = lum.length; let sum = 0; for (let i = 0; i < 64; i++) sum += i * hist[i];
      let wB = 0, sB = 0; for (let t = 0; t < 64; t++) { wB += hist[t]; if (!wB || wB === n) continue; sB += t * hist[t]; const mB = sB / wB, mF = (sum - sB) / (n - wB), v = wB * (n - wB) * (mB - mF) ** 2; if (v > bestV) { bestV = v; bestT = t; } }
      const lo = lum.filter((v) => v * 64 <= bestT + 1), hi = lum.filter((v) => v * 64 > bestT + 1);
      if (!lo.length || !hi.length) return null;
      const m = (a) => a.reduce((s, v) => s + v, 0) / a.length;
      return ratio(m(lo), m(hi));
    });
  }, dataUrl, boxes.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h, color: b.color, extra: b.extra })));
  boxes.forEach((b, i) => { b.contrast = res[i] == null ? null : round(res[i], 2); });
}

// share of a line's area inside a zone rectangle
const inside = (l, z) => Math.max(0, Math.min(l.x + l.w, z.x1) - Math.max(l.x, z.x0)) * Math.max(0, Math.min(l.y + l.h, z.y1) - Math.max(l.y, z.y0)) / (l.w * l.h || 1);
const outside = (l, z) => 1 - inside(l, z);

function listCovers(dir) {
  return readdirSync(dir).filter((f) => /\.(jpe?g|png|webp)$/i.test(f) && !/sheet|look|preview|frame|still|photo/i.test(f)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).map((f) => join(dir, f));
}

export async function check(folder, { handle = '@yourname', titles = null, out = 'look/covers', plain = false, ocr = 'auto', files = null } = {}) {
  const dir = resolve(folder);
  if (!existsSync(dir)) throw new Error('no such folder: ' + folder);
  const list = files || (statSync(dir).isDirectory() ? listCovers(dir) : [dir]);
  if (!list.length) throw new Error('no cover images (JPG/PNG) in ' + folder);
  const titleList = Array.isArray(titles) ? titles : titles ? String(titles).split('|') : [];
  const issues = [], covers = [];
  let set = { count: list.length };
  const tess = ocr !== 'never' && hasTesseract();
  const browser = await launch();
  try {
    const page = await browser.newPage();
    for (const [i, f] of list.entries()) {
      const buf = readFileSync(f), info = imageInfo(buf), W = info.w, H = info.h, name = basename(f);
      const cv = { file: name, format: info.format, w: W, h: H, kb: Math.round(buf.length / 1024), dataUrl: `data:image/${info.format === 'png' ? 'png' : info.format === 'webp' ? 'webp' : 'jpeg'};base64,${buf.toString('base64')}` };
      covers.push(cv);
      if (!W || !H) { issues.push(issue('unreadable', 'error', `${name}: couldn't read its size.`, 'Save it as JPG or PNG.', name)); cv.boxes = []; continue; }
      if (!['jpeg', 'png'].includes(info.format)) issues.push(issue('format', 'warn', `${name} is ${info.format.toUpperCase()}; JPG or PNG is what every app takes.`, 'Save it as JPG.', name));
      if (Math.abs(W / H - 9 / 16) > 0.01) issues.push(issue('aspect', 'error', `${name} is ${W}×${H} (${round(W / H, 3)}:1), not 9:16: Instagram cuts a non-9:16 cover to its middle 9:16 (Meta's API docs), and every grid crops it again.`, 'Make it exactly 1080×1920.', name));
      else if (W < 1080) issues.push(issue('low-res', 'warn', `${name} is ${W}×${H}: under 1080×1920 it looks soft full screen (Palm's guidance; YouTube recommends 2160×3840 for Shorts).`, 'Make it 1080×1920 or bigger.', name));
      if (H < 640) issues.push(issue('too-small', 'error', `${name}: ${H} px tall, under YouTube's 640 px minimum height for Shorts thumbnails.`, 'Make it 1080×1920.', name));
      // text
      const stem = name.replace(/\.\w+$/, ''), srcs = readdirSync(dirname(f)).filter((x) => /\.(html?|svg)$/i.test(x));
      const src = srcs.find((x) => x.replace(/\.\w+$/, '') === stem);
      cv.method = 'none'; cv.boxes = [];
      if (src) { const m = await measureSource(page, join(dirname(f), src), { w: W, h: H }); cv.method = 'source'; cv.source = src; cv.boxes = m.boxes; cv.title = m.title; }
      if (tess && (ocr === 'always' || cv.method === 'none')) { const b = ocrBoxes(f); if (cv.method === 'none') { cv.method = 'ocr'; cv.boxes = b; } else cv.ocr = b; }
      cv.title = titleList[i] || cv.title || stem.replace(/^\d+[-_ ]*/, '').replace(/[-_]+/g, ' ');
      await contrasts(page, cv.dataUrl, cv.boxes); if (cv.ocr) await contrasts(page, cv.dataUrl, cv.ocr);
      const kT = TILE.grid / W;
      for (const b of [...cv.boxes, ...(cv.ocr || [])]) b.tile_px = round(b.fs * kT);
      if (cv.method === 'none') { issues.push(issue('not-measured', 'note', `${name}: no HTML/SVG source beside it and no Tesseract, so its text wasn't measured: judge it on the sheet.`, 'Keep the HTML/SVG you made it from beside it (same name).', name)); continue; }
      const bs = cv.boxes, est = cv.method === 'ocr' ? " (Palm's estimate from OCR)" : '';
      if (!bs.length) { issues.push(issue('no-text', 'note', `${name}: no words found${est}. Fine if the cover has none; in a grid of covers, a few big words say what each video is.`, '', name)); continue; }
      const Z = zones(W, H);
      const head = bs.reduce((a, b) => (b.fs > a.fs ? b : a));
      cv.head = { t: head.t, fs: Math.round(head.fs), tile_px: head.tile_px, cy: round((head.y + head.h / 2) / H, 3), cx: round((head.x + head.w / 2) / W, 3), x0: round(head.x / W, 3) };
      cv.smallest_tile_px = Math.min(...bs.map((b) => b.tile_px)); cv.largest_tile_px = head.tile_px;
      // cut by the 3:4 grid crop
      const cut = bs.filter((b) => b.lines.some((l) => outside(l, Z.grid) > 0.15));
      if (cut.length) {
        const isHead = cut.includes(head);
        issues.push(issue('grid-crop', isHead ? 'error' : 'warn', `${name}: on the Instagram and TikTok profile grids (the middle 3:4: y ${Math.round(Z.grid.y0)}–${Math.round(Z.grid.y1)}) these words are cut off: ${cut.slice(0, 3).map((b) => `"${b.t}"`).join(', ')}.`, `Keep every word between y ${Math.round(Z.grid.y0)} and ${Math.round(Z.grid.y1)} (on ${W}×${H}).`, name));
      }
      // too small at grid size
      const small = bs.filter((b) => b.tile_px < MIN_TILE_FS).sort((a, b) => a.tile_px - b.tile_px);
      if (small.length) issues.push(issue('text-small', 'warn', `${name}: ${small.length} line${small.length > 1 ? 's' : ''} can't be read on a ${TILE.grid} px grid tile${est}: ${small.slice(0, 3).map((b) => `"${b.t}" ${Math.round(b.fs)} px → ${b.tile_px} px`).join('; ')}. Palm's guidance: ${MIN_TILE_FS} px or more there.`, `Make every word at least ${Math.ceil(MIN_TILE_FS / kT)} px (font size) on this ${W}-wide cover, or cut it: the caption can carry the rest.`, name));
      if (head.tile_px < HEAD_TILE_FS) issues.push(issue('title-small', 'warn', `${name}: the biggest words ("${head.t}") are ${Math.round(head.fs)} px, ${head.tile_px} px on a grid tile${est}: they won't read at a glance in the grid.`, `Make the title at least ${Math.ceil(HEAD_TILE_FS / kT)} px; fewer words, bigger.`, name));
      // under the apps' UI
      const under = (z) => bs.filter((b) => b.lines.some((l) => inside(l, z) > 0.2));
      const badge = under(Z.ttBadge).filter((b) => !cut.includes(b));
      if (badge.length) issues.push(issue('under-view-count', 'warn', `${name}: "${badge[0].t}" sits where TikTok prints the view count on the profile grid (bottom-left of the 3:4 tile, Palm's approximation).`, 'Keep words out of the bottom-left of the middle 3:4.', name));
      const sh = under(Z.shorts);
      if (sh.length) issues.push(issue('under-shorts-title', 'warn', `${name}: "${sh[0].t}" sits in the bottom ${Math.round(SHORTS_OVERLAY * 100)}%, where a YouTube Shorts shelf prints the video's title over the cover (Palm's approximation).`, `Keep words above y ${Math.round(Z.shorts.y0)}.`, name));
      for (const [a, z] of [['reels', Z.reels], ['tiktok', Z.tiktok]]) {
        const u = bs.filter((b) => b.lines.some((l) => outside(l, z) > 0.2));
        if (u.length) issues.push(issue('under-ui-' + a, 'warn', `${name}: "${u[0].t}" sits under ${FULL[a].name}'s buttons, caption or top bar when the cover shows full screen.`, `Keep words inside x ${Math.round(z.x0)}–${Math.round(z.x1)}, y ${Math.round(z.y0)}–${Math.round(z.y1)}.`, name));
      }
      const low = bs.filter((b) => b.contrast != null && b.contrast < MIN_CONTRAST && b.tile_px >= 3);
      if (low.length) issues.push(issue('low-contrast', 'warn', `${name}: low contrast against what's behind it (Palm's estimate): ${low.slice(0, 3).map((b) => `"${b.t}" ${b.contrast}:1`).join('; ')}.`, `Aim for ${MIN_CONTRAST}:1 or more: a solid band behind the words, a darker/lighter backdrop, or an outline.`, name));
    }
    // the set
    const sized = covers.filter((c) => c.w && c.h);
    set = { count: covers.length, sizes: [...new Set(sized.map((c) => `${c.w}x${c.h}`))] };
    if (set.sizes.length > 1) issues.push(issue('set-sizes', 'warn', `The covers aren't all one size: ${set.sizes.join(', ')}.`, 'Make them all 1080×1920.'));
    const heads = covers.filter((c) => c.head);
    if (heads.length >= 2) {
      const ys = heads.map((c) => c.head.cy), fss = heads.map((c) => c.head.fs);
      set.title_y_range = round(Math.max(...ys) - Math.min(...ys), 3); set.title_size_ratio = round(Math.max(...fss) / Math.min(...fss), 2);
      set.title_y = Object.fromEntries(heads.map((c) => [c.file, c.head.cy])); set.title_px = Object.fromEntries(heads.map((c) => [c.file, c.head.fs]));
      if (set.title_y_range > SET_POS) issues.push(issue('set-position', 'warn', `Across the set the title moves up and down by ${Math.round(set.title_y_range * 100)}% of the cover's height (${heads.map((c) => `${c.file} ${Math.round(c.head.cy * 100)}%`).join(', ')}): side by side in the grid they don't read as one series (Palm's guidance: within ${SET_POS * 100}%).`, 'Put the title in the same place on every cover.'));
      if (set.title_size_ratio > SET_SIZE) issues.push(issue('set-size', 'warn', `Across the set the title's size varies ${set.title_size_ratio}× (${heads.map((c) => `${c.file} ${c.head.fs} px`).join(', ')}) (Palm's guidance: within ${SET_SIZE}×).`, 'Use one title size (shorten the long titles rather than shrinking them).'));
    }
    const sheet = drawSheet({ covers, handle, plain });
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(resolve(out) + '-sheet.html', sheet);
    await page.setViewport({ width: 1660, height: 1000, deviceScaleFactor: 1 });
    await page.setContent(sheet, { waitUntil: 'load' });
    await page.evaluate(() => Promise.all([...document.images].map((i) => i.complete ? 0 : new Promise((r) => (i.onload = i.onerror = r)))));
    await page.screenshot({ path: resolve(out) + '-sheet.png', fullPage: true });
  } finally { await browser.close(); }
  const errors = issues.filter((i) => i.level === 'error').length, warnings = issues.filter((i) => i.level === 'warn').length;
  const slim = (b) => ({ t: b.t, font_px: Math.round(b.fs), at_tile_px: b.tile_px, contrast: b.contrast });
  return {
    ok: errors === 0, errors, warnings,
    covers: covers.map((c) => ({ file: c.file, w: c.w, h: c.h, format: c.format, kb: c.kb, method: c.method, source: c.source, title: c.title, smallest_at_tile: c.smallest_tile_px ?? null, largest_at_tile: c.largest_tile_px ?? null, head: c.head || null, lines: (c.boxes || []).map(slim), ...(c.ocr ? { ocr: c.ocr.map(slim) } : {}) })),
    set, issues, sheet: resolve(out) + '-sheet.png', thresholds: "Palm's guidance (see the tool's header), not a platform rule",
  };
}

// ---------- the sheet ----------
// Stand-in posts: abstract colour fields (no real videos or brands).
const NB = [['#1d3557', '#e63946'], ['#264653', '#e9c46a'], ['#3a0ca3', '#f72585'], ['#2b2d42', '#8d99ae'], ['#5f0f40', '#fb8b24'], ['#0b3d2e', '#9ef01a'], ['#6d597a', '#eaac8b'], ['#3d405b', '#f2cc8f']];
const standIn = (i) => { const [a, b] = NB[i % NB.length]; return `<div style="position:absolute;inset:0;background:linear-gradient(${110 + i * 47}deg,${a} 0 50%,${b})"><div style="position:absolute;left:12%;top:38%;width:70%;height:9%;background:rgba(255,255,255,.85);border-radius:2px"></div></div>`; };
const T = (dark) => dark ? { bg: '#000', fg: '#f5f5f5', sub: '#a8a8a8', line: '#262626' } : { bg: '#fff', fg: '#000', sub: '#737373', line: '#dbdbdb' };
const VIEWS = ['1,204', '3,912', '842', '12.4K', '2,310', '5,067', '688', '9,875', '1.1K', '4,420', '2.7K', '731'];

export function drawSheet({ covers, handle, plain }) {
  const set = covers.filter((c) => c.dataUrl);
  const newest = [...set].reverse();                                  // the grid shows the newest first
  const img = (c, fit = 'cover') => `<img src="${c.dataUrl}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:${fit};object-position:center">`;
  const avatar = (s) => `<div style="width:${s}px;height:${s}px;border-radius:50%;flex:none;background:radial-gradient(circle at 35% 35%,#d9c7a8,#7a6a52)"></div>`;
  const reelGlyph = '<svg width="14" height="14" viewBox="0 0 24 24" style="position:absolute;right:6px;top:6px;filter:drop-shadow(0 0 2px rgba(0,0,0,.6))"><rect x="3" y="3" width="18" height="18" rx="5" fill="none" stroke="#fff" stroke-width="2.2"/><path d="M10 9l5 3-5 3z" fill="#fff"/></svg>';
  const tileW = 129, tileH = Math.round(tileW * 4 / 3);
  const igPhone = (dark) => {
    const t = T(dark), tiles = [...newest.map((c) => ({ c })), ...Array.from({ length: 12 - Math.min(newest.length, 12) }, (_, i) => ({ i: i + (dark ? 3 : 0) }))].slice(0, 12);
    return `<div style="width:390px;background:${t.bg};flex:none;font-family:-apple-system,system-ui,sans-serif;color:${t.fg}">
<div style="padding:10px 14px;font:700 17px system-ui">${esc(handle.replace(/^@/, ''))}</div>
<div style="display:flex;align-items:center;gap:22px;padding:4px 14px">${avatar(78)}<div style="display:flex;gap:22px;text-align:center;font:600 15px system-ui">${[['148', 'posts'], ['12.6K', 'followers'], ['311', 'following']].map(([n, l]) => `<div>${n}<div style="font:400 13px system-ui">${l}</div></div>`).join('')}</div></div>
<div style="padding:8px 14px 10px;font:400 13px/18px system-ui"><b>${esc(handle.replace(/^@/, ''))}</b><br><span style="color:${t.sub}">Bio line one · bio line two</span></div>
<div style="display:flex;border-top:1px solid ${t.line}">${['▦', '▷', '☺'].map((g, i) => `<div style="flex:1;text-align:center;padding:8px 0;font-size:18px;${i === 0 ? `border-bottom:1.5px solid ${t.fg}` : `color:${t.sub}`}">${g}</div>`).join('')}</div>
<div style="display:grid;grid-template-columns:repeat(3,${tileW}px);gap:1.5px;justify-content:center">${tiles.map((x) => `<div style="position:relative;width:${tileW}px;height:${tileH}px;overflow:hidden;background:#333">${x.c ? img(x.c) + reelGlyph : standIn(x.i)}</div>`).join('')}</div></div>`;
  };
  const ttPhone = (dark) => {
    const t = T(dark), tiles = [...newest.map((c) => ({ c })), ...Array.from({ length: 12 - Math.min(newest.length, 12) }, (_, i) => ({ i: i + (dark ? 5 : 2) }))].slice(0, 12);
    return `<div style="width:390px;background:${dark ? '#121212' : '#fff'};flex:none;font-family:system-ui,sans-serif;color:${t.fg}">
<div style="text-align:center;padding:10px 0 4px;font:700 16px system-ui">${esc(handle.replace(/^@/, ''))}</div>
<div style="display:flex;justify-content:center;padding:6px">${avatar(84)}</div>
<div style="text-align:center;font:600 14px system-ui">${esc(handle.startsWith('@') ? handle : '@' + handle)}</div>
<div style="display:flex;justify-content:center;gap:28px;padding:10px;text-align:center;font:700 16px system-ui">${[['311', 'Following'], ['9,804', 'Followers'], ['118K', 'Likes']].map(([n, l]) => `<div>${n}<div style="font:400 12px system-ui;color:${t.sub}">${l}</div></div>`).join('')}</div>
<div style="display:flex;justify-content:center;gap:6px;padding:0 0 10px"><div style="background:${dark ? '#2f2f2f' : '#f1f1f2'};padding:8px 26px;border-radius:4px;font:600 14px system-ui">Edit profile</div><div style="background:${dark ? '#2f2f2f' : '#f1f1f2'};padding:8px 20px;border-radius:4px;font:600 14px system-ui">Share profile</div></div>
<div style="display:flex;border-bottom:1px solid ${t.line}">${['▥', '🔒', '♡'].map((g, i) => `<div style="flex:1;text-align:center;padding:8px 0;font-size:16px;${i === 0 ? `border-bottom:2px solid ${t.fg}` : `color:${t.sub}`}">${g}</div>`).join('')}</div>
<div style="display:grid;grid-template-columns:repeat(3,${tileW}px);gap:1px;justify-content:center">${tiles.map((x, k) => `<div style="position:relative;width:${tileW}px;height:${tileH}px;overflow:hidden;background:#333">${x.c ? img(x.c) : standIn(x.i)}<div style="position:absolute;left:0;right:0;bottom:0;height:34px;background:linear-gradient(transparent,rgba(0,0,0,.45))"></div><div style="position:absolute;left:6px;bottom:5px;color:#fff;font:600 12px system-ui;text-shadow:0 0 3px rgba(0,0,0,.5)">▷ ${VIEWS[k % VIEWS.length]}</div>${k === 0 ? '<div style="position:absolute;left:5px;top:5px;background:#fe2c55;color:#fff;font:600 10px system-ui;padding:2px 4px;border-radius:2px">Pinned</div>' : ''}</div>`).join('')}</div></div>`;
  };
  // full screen with each app's interface (drawn on a 390×693 phone, shown at 0.78)
  const icon = (s, label) => `<div style="text-align:center;color:#fff;font:600 11px system-ui;text-shadow:0 0 3px rgba(0,0,0,.6)"><div style="font-size:${s}px;line-height:1">${label[0]}</div>${label[1] || ''}</div>`;
  const reelsFull = (c) => `<div style="position:relative;width:390px;height:693px;overflow:hidden;background:#000;font-family:system-ui">${img(c)}
<div style="position:absolute;left:0;right:0;top:0;height:76px;background:linear-gradient(rgba(0,0,0,.35),transparent)"></div><div style="position:absolute;left:14px;top:34px;color:#fff;font:700 20px system-ui">Reels ⌄</div><div style="position:absolute;right:14px;top:34px;color:#fff;font-size:22px">◎</div>
<div style="position:absolute;right:8px;bottom:92px;display:flex;flex-direction:column;gap:16px">${icon(26, ['♡', '1,204'])}${icon(24, ['💬', '38'])}${icon(24, ['↻', '12'])}${icon(24, ['➤', '96'])}${icon(22, ['⋯'])}</div>
<div style="position:absolute;left:0;right:0;bottom:0;height:150px;background:linear-gradient(transparent,rgba(0,0,0,.55))"></div>
<div style="position:absolute;left:12px;right:60px;bottom:22px;color:#fff;font:400 13px/18px system-ui;text-shadow:0 0 2px rgba(0,0,0,.5)"><div style="display:flex;align-items:center;gap:8px;font-weight:600">${avatar(30)}${esc(handle.replace(/^@/, ''))}<span style="border:1px solid #fff;border-radius:6px;padding:1px 8px">Follow</span></div><div style="margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(c.title)} … more</div><div style="margin-top:4px;font-size:12px">♫ Original audio</div></div></div>`;
  const ttFull = (c) => `<div style="position:relative;width:390px;height:693px;overflow:hidden;background:#000;font-family:system-ui">${img(c)}
<div style="position:absolute;left:0;right:0;top:0;height:70px;background:linear-gradient(rgba(0,0,0,.35),transparent)"></div><div style="position:absolute;left:0;right:0;top:30px;text-align:center;color:#fff;font:600 16px system-ui;text-shadow:0 0 3px rgba(0,0,0,.5)"><span style="opacity:.7">Following</span> &nbsp; For You</div><div style="position:absolute;right:14px;top:28px;color:#fff;font-size:20px">⌕</div>
<div style="position:absolute;right:8px;bottom:96px;display:flex;flex-direction:column;gap:16px;align-items:center">${avatar(44)}${icon(28, ['♥', '3,912'])}${icon(26, ['💬', '57'])}${icon(26, ['🔖', '210'])}${icon(26, ['↪', '44'])}<div style="width:36px;height:36px;border-radius:50%;background:#333;border:8px solid #222"></div></div>
<div style="position:absolute;left:0;right:0;bottom:0;height:170px;background:linear-gradient(transparent,rgba(0,0,0,.5))"></div>
<div style="position:absolute;left:12px;right:80px;bottom:24px;color:#fff;font:400 14px/19px system-ui;text-shadow:0 0 2px rgba(0,0,0,.5)"><div style="font-weight:700;font-size:15px">${esc(handle.replace(/^@/, ''))}</div><div style="margin-top:4px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(c.title)} #recipe #dinner</div><div style="margin-top:6px;font-size:13px">♫ original sound</div></div></div>`;
  const scaled = (inner, label, k = 0.78) => `<figure style="margin:0;flex:none"><div style="width:${Math.round(390 * k)}px;height:${Math.round(693 * k)}px;overflow:hidden;border-radius:14px"><div style="transform:scale(${k});transform-origin:0 0">${inner}</div></div><figcaption>${esc(label)}</figcaption></figure>`;
  const shortsTile = (c, dark) => `<div style="position:relative;width:183px;height:326px;border-radius:8px;overflow:hidden;flex:none;background:#333">${img(c)}<div style="position:absolute;left:0;right:0;bottom:0;height:40%;background:linear-gradient(transparent,rgba(0,0,0,.7))"></div><div style="position:absolute;right:6px;top:6px;color:#fff;font:700 16px system-ui;text-shadow:0 0 3px #000">⋮</div><div style="position:absolute;left:8px;right:8px;bottom:8px;color:#fff;font-family:Roboto,Arial,sans-serif"><div style="font:500 14px/19px Roboto,Arial,sans-serif;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(c.title)}</div><div style="font:400 12px/16px Roboto,Arial,sans-serif;opacity:.9">${VIEWS[(set.indexOf(c) + 3) % VIEWS.length]} views</div></div></div>`;
  const shorts = (dark) => `<div style="background:${dark ? '#0f0f0f' : '#fff'};padding:12px 14px;color:${dark ? '#f1f1f1' : '#0f0f0f'}"><div style="font:700 17px Roboto,Arial,sans-serif;margin-bottom:10px">▶ Shorts</div><div style="display:flex;gap:8px;flex-wrap:wrap">${newest.map((c) => shortsTile(c, dark)).join('')}</div></div>`;
  // full size with Palm's marks (the agent's sheet only)
  const fw = 300;
  const full = (c) => {
    if (!c.w) return '';
    const k = fw / c.w, fh = Math.round(c.h * k), Z = zones(c.w, c.h);
    let marks = '';
    if (!plain) {
      const rect = (z, col, dash) => `<div style="position:absolute;left:${z.x0 * k}px;top:${z.y0 * k}px;width:${(z.x1 - z.x0) * k}px;height:${(z.y1 - z.y0) * k}px;border:2px ${dash} ${col};box-sizing:border-box"></div>`;
      marks += `<div style="position:absolute;left:0;right:0;top:0;height:${Z.grid.y0 * k}px;background:rgba(255,0,0,.28)"></div><div style="position:absolute;left:0;right:0;top:${Z.grid.y1 * k}px;bottom:0;background:rgba(255,0,0,.28)"></div>`;
      marks += rect(Z.ttBadge, '#ff0', 'dashed') + rect(Z.shorts, '#0cf', 'dotted') + rect(Z.reels, '#f0f', 'dashed') + rect(Z.tiktok, '#0f8', 'dashed');
      for (const b of c.boxes || []) { const bad = b.tile_px < MIN_TILE_FS || (b.contrast != null && b.contrast < MIN_CONTRAST); marks += `<div style="position:absolute;left:${b.x * k}px;top:${b.y * k}px;width:${b.w * k}px;height:${b.h * k}px;border:2px solid ${bad ? '#f33' : '#3c6'};box-sizing:border-box"></div><div style="position:absolute;left:${b.x * k}px;top:${(b.y + b.h) * k}px;font:600 10px system-ui;color:#fff;background:${bad ? '#c22' : '#285'};padding:0 2px;white-space:nowrap">${b.tile_px}px${b.contrast != null ? ' · ' + b.contrast + ':1' : ''}</div>`; }
    }
    return `<figure style="margin:0;flex:none"><div style="position:relative;width:${fw}px;height:${fh}px;overflow:hidden">${img(c, 'fill')}${marks}</div><figcaption>${esc(c.file)}</figcaption></figure>`;
  };
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;width:1660px;background:#ecebe8;font-family:system-ui,sans-serif}.sec{padding:16px 20px}.row{display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start}h2{font:600 15px system-ui;margin:0 0 12px;color:#333}figcaption{font:500 12px system-ui;color:#555;margin-top:4px}</style></head><body>
<div class="sec" style="background:#222"><h2 style="color:#eee;font-size:16px">Covers for Reels, TikTok and Shorts: ${set.length} covers, posted in this order: ${set.map((c) => esc(c.file)).join(', ')}. Where the apps show them (Palm's approximation of the apps' layouts, Nov 2026; other posts are stand-ins)</h2></div>
<div class="sec"><h2>Profile grids on a 390 px phone, newest first: Instagram (light, dark) and TikTok (light, dark)</h2><div class="row">${igPhone(false)}${igPhone(true)}${ttPhone(false)}${ttPhone(true)}</div></div>
<div class="sec"><h2>Full screen in Instagram Reels, with the app's buttons and caption</h2><div class="row">${set.map((c) => scaled(reelsFull(c), c.file)).join('')}</div></div>
<div class="sec"><h2>Full screen in TikTok, with the app's buttons and caption</h2><div class="row">${set.map((c) => scaled(ttFull(c), c.file)).join('')}</div></div>
<div class="sec"><h2>YouTube Shorts shelf on a phone (light, dark), newest first</h2>${shorts(false)}${shorts(true)}</div>
<div class="sec"><h2>The set at full size${plain ? '' : ': red = cut off on the 3:4 grids; yellow dashed = TikTok\'s view count on the grid; blue dotted = Shorts title; pink / green dashed = inside Reels / TikTok buttons; boxes = measured text, its size on a 129 px grid tile and its contrast'}</h2><div class="row">${set.map(full).join('')}</div></div>
</body></html>`;
}

// ---------- render HTML to the cover ----------
export async function render(file, { out, size = '1080x1920', quality = 90 } = {}) {
  const [w, h] = String(size).split('x').map(Number);
  if (!w || !h) throw new Error('--size WxH, e.g. 1080x1920');
  const abs = resolve(file);
  const many = statSync(abs).isDirectory();
  const list = many ? readdirSync(abs).filter((f) => /\.html?$/i.test(f)).sort().map((f) => join(abs, f)) : [abs];
  const browser = await launch(), done = [];
  try {
    const page = await browser.newPage();
    for (const f of list) {
      const o = many ? join(out ? resolve(out) : abs, basename(f).replace(/\.html?$/i, '.jpg')) : resolve(out || abs.replace(/\.html?$/i, '.jpg'));
      await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
      await page.goto(pathToFileURL(f).href, { waitUntil: 'load', timeout: 30000 });
      await page.evaluate(() => document.fonts?.ready); await new Promise((r) => setTimeout(r, 200));
      const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight }));
      mkdirSync(dirname(o), { recursive: true });
      const jpeg = !/\.png$/i.test(o);
      await page.evaluate(() => { if (getComputedStyle(document.body).backgroundColor === 'rgba(0, 0, 0, 0)' && getComputedStyle(document.documentElement).backgroundColor === 'rgba(0, 0, 0, 0)') document.documentElement.style.background = '#fff'; });
      await page.screenshot({ path: o, type: jpeg ? 'jpeg' : 'png', ...(jpeg ? { quality } : {}), clip: { x: 0, y: 0, width: w, height: h } });
      const issues = [];
      if (m.sw > w + 1 || m.sh > h + 1) issues.push(issue('overflow', 'warn', `${basename(f)} is ${m.sw}×${m.sh}, bigger than ${w}×${h}: part of it is cut off.`, `html,body{width:${w}px;height:${h}px;overflow:hidden}`));
      done.push({ out: o, w, h, kb: Math.round(statSync(o).size / 1024), issues });
    }
  } finally { await browser.close(); }
  return { ok: done.every((d) => !d.issues.length), rendered: done };
}

// ---------- self-test ----------
async function selfTest() {
  const d = mkdtempSync(join(tmpdir(), 'reel-cover-'));
  const page = (title, body) => `<html><head><title>${title}</title></head><body style="margin:0;width:1080px;height:1920px;overflow:hidden;background:#2f5d4e;font-family:Arial,sans-serif;position:relative">${body}</body></html>`;
  const good = join(d, 'good'); mkdirSync(good);
  ['Lemon pasta', 'Tray chicken', 'Crispy rice'].forEach((t, i) => writeFileSync(join(good, `0${i + 1}-c.html`), page(t, `<div style="position:absolute;left:120px;right:180px;top:620px;font:900 150px/1.05 Arial;color:#fff">${t.toUpperCase()}</div><div style="position:absolute;left:120px;top:1000px;font:700 80px/1 Arial;color:#f3e6cc">EP ${i + 1}</div>`)));
  const r1 = await render(good, { out: good }); if (!r1.ok || r1.rendered.length !== 3) throw new Error('render: ' + JSON.stringify(r1));
  const g = await check(good, { out: join(d, 'good'), handle: '@test' });
  const gw = g.issues.filter((i) => i.level === 'warn' || i.level === 'error');
  if (gw.length || g.covers.some((c) => c.method !== 'source') || g.covers[0].title !== 'Lemon pasta') throw new Error('good: ' + JSON.stringify(g.issues) + JSON.stringify(g.covers.map((c) => [c.method, c.title])));
  const bad = join(d, 'bad'); mkdirSync(bad);
  // 01: title above the grid crop, small handle bottom-left (TikTok view count, Shorts title), low-contrast line
  writeFileSync(join(bad, '01-a.html'), page('A', '<div style="position:absolute;left:80px;top:90px;font:900 120px/1 Arial;color:#fff">TOP TITLE</div><div style="position:absolute;left:80px;top:1560px;font:400 40px/1 Arial;color:#fff">@small.handle</div><div style="position:absolute;left:80px;top:900px;font:700 90px/1 Arial;color:#3a6b5b">LOW</div>'));
  // 02: title near the bottom and much smaller (set inconsistent), far right under the buttons
  writeFileSync(join(bad, '02-b.html'), page('B', '<div style="position:absolute;left:560px;top:1300px;font:900 64px/1 Arial;color:#fff;white-space:nowrap">SMALL TITLE HERE</div>'));
  await render(bad, { out: bad });
  const b = await check(bad, { out: join(d, 'bad') });
  const ids = b.issues.map((i) => i.id);
  for (const want of ['grid-crop', 'text-small', 'under-view-count', 'under-shorts-title', 'low-contrast', 'set-position', 'set-size', 'under-ui-reels', 'under-ui-tiktok']) if (!ids.includes(want)) throw new Error('bad: expected ' + want + ' in ' + ids.join(','));
  if (b.ok) throw new Error('bad: the title cut by the grid should be an error');
  // a wrong size
  const ws = join(d, 'wrong'); mkdirSync(ws); writeFileSync(join(ws, 'x.html'), page('X', '<div style="position:absolute;left:100px;top:700px;font:900 150px Arial;color:#fff">HI</div>'));
  await render(join(ws, 'x.html'), { out: join(ws, 'x.jpg'), size: '1080x1350' });
  const w = await check(ws, { out: join(d, 'wrong') });
  if (!w.issues.some((i) => i.id === 'aspect')) throw new Error('wrong size: ' + JSON.stringify(w.issues));
  // image only: OCR (if Tesseract is installed)
  if (hasTesseract()) {
    const im = join(d, 'only'); mkdirSync(im); writeFileSync(join(im, '01.jpg'), readFileSync(join(bad, '01-a.jpg')));
    const o = await check(im, { out: join(d, 'ocr') });
    if (o.covers[0].method !== 'ocr' || !o.covers[0].lines.length) throw new Error('ocr: ' + JSON.stringify(o.covers[0]));
    console.log('ocr lines:', o.covers[0].lines.map((l) => `${l.t}=${l.font_px}px`).join(' | '));
  } else console.log('(Tesseract not installed: OCR path not tested)');
  console.log(`reel-cover-check: all tests pass (good: no warnings; bad: ${[...new Set(ids)].join(', ')}; sheets in ${d})`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (k, dflt) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : dflt; };
  const VALUED = new Set(['--out', '--size', '--quality', '--handle', '--titles', '--ocr']);
  const pos = argv.filter((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1]));
  const done = (r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); };
  const fail = (e) => { console.error(String(e.message || e)); process.exit(2); };
  if (argv.includes('--self-test') || argv.includes('--test')) selfTest().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
  else if (pos[0] === 'render' && pos[1]) render(pos[1], { out: opt('out'), size: opt('size', '1080x1920'), quality: +opt('quality', 90) }).then(done, fail);
  else if (pos[0] === 'check' && pos[1]) check(pos[1], { handle: opt('handle', '@yourname'), titles: opt('titles'), out: opt('out', 'look/covers'), plain: argv.includes('--plain'), ocr: opt('ocr', 'auto') }).then(done, fail);
  else fail('usage: reel-cover-check.mjs check <covers folder> [--handle @name] [--titles "A|B|…"] [--out look/covers] [--plain]\n       reel-cover-check.mjs render <cover.html | folder> [--size 1080x1920] [--out cover.jpg | folder]\n       reel-cover-check.mjs --self-test');
}
