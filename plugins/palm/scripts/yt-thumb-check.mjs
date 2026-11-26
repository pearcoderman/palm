#!/usr/bin/env node
// Palm tool: yt-thumb-check — lets an agent see a YouTube thumbnail where YouTube shows it, and measures what fails there.
// A thumbnail is made at 1280×720 or bigger but chosen at about 360 px wide (desktop home grid and search), 168 px wide
// (the watch page's "Up next" list), full phone width (~390 px) and ~160 px in the phone's compact lists, light and dark,
// always with YouTube's duration badge over its bottom-right corner and, once watched, a red progress bar along the bottom.
//
//   node yt-thumb-check.mjs check thumbnail.jpg [--source thumbnail.html] [--title "Video title"] [--duration 18:42]
//                                [--channel "Channel"] [--out look/thumb]
//       → JSON {ok, errors, warnings, image, text, issues, sheet}. Then LOOK at <out>-sheet.png.
//   node yt-thumb-check.mjs render thumbnail.html --size 1280x720 --out thumbnail.jpg [--quality 90]
//       → renders the HTML at exactly that size (JPG, or PNG without alpha).
//   node yt-thumb-check.mjs --test
//
// What it checks
//   YouTube's rules (YouTube Help "Add video thumbnails", answer 72431, read 2026-11-26): 3840×2160 recommended ("as large
//   as possible"), minimum width 640 px, 16:9, JPG or PNG, up to 50 MB (desktop and mobile; the old 2 MB limit is gone).
//   1280×720 as the floor for a sharp thumbnail is Palm's guidance (it was YouTube's figure for years).
//   Palm's measurement (YouTube publishes none of these; Palm's approximation of the layouts in Nov 2026): the card
//   widths above; the duration badge about 38×18 px, 4 px in from the bottom-right corner at every size, so on the 168 px
//   card it covers the right ~25% and bottom ~23%; the progress bar about 4 px tall along the bottom.
//   Text size: with the thumbnail's HTML/SVG source (beside it, same name, or --source), each line of text is measured
//   from the page; without it, from the image with Tesseract OCR if installed (Palm's estimate: a word's box height
//   ÷ 0.75 ≈ its font size; OCR misses heavily styled lettering, so look at the sheet). Palm's guidance: text under 8 px
//   (font size) on the 168 px card can't be read; the biggest words should be 12 px or more there.
//   Contrast (Palm's estimate): with a source, the text colour against the median of the other pixels in its box (an
//   outline or shadow counts); from OCR, the two luminance clusters in each word's box. Under 3:1 is flagged.
// adds: tool. Runs on the user's machine with their Chrome/Edge/Chromium; nothing leaves it.

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve, basename, extname } from 'node:path';
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
const launch = () => loadPuppeteer().launch({ executablePath: findChrome(), headless: true, timeout: 90000, args: ['--no-sandbox', '--hide-scrollbars', '--allow-file-access-from-files'] });

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
  if (b.toString('latin1', 0, 4) === 'GIF8') return { format: 'gif', w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  if (b.toString('latin1', 0, 2) === 'BM') return { format: 'bmp', w: b.readInt32LE(18), h: Math.abs(b.readInt32LE(22)) };
  return { format: 'unknown' };
}

// Palm's approximation of YouTube's layouts (Nov 2026; not published by YouTube).
export const VIEWS = { grid: 360, search: 360, sidebar: 168, phone: 390, compact: 160 };
const BADGE = { w: 38, h: 18, inset: 4 }, BAR = 4;            // px, the same at every card size
const MIN_SIDEBAR_FS = 8, HEAD_SIDEBAR_FS = 12, MIN_CONTRAST = 3;
const issue = (id, level, msg, fix) => ({ id, level, msg, fix });
const round = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d;

// ---------- text from the source (HTML or SVG) ----------
async function measureSource(page, src, img) {
  const url = pathToFileURL(resolve(src)).href;
  const load = async (w, h) => { await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 }); await page.goto(url, { waitUntil: 'load', timeout: 30000 }); await page.evaluate(() => document.fonts?.ready); await new Promise((r) => setTimeout(r, 150)); };
  await load(img.w, img.h);
  // A design made at 1280×720 but screenshotted at 2× sits in the top-left of a bigger viewport: find its real size.
  let ext = await page.evaluate(() => { let r = 0, b = 0; for (const e of document.querySelectorAll('body *, svg')) { const q = e.getBoundingClientRect(); if (q.width && q.height) { r = Math.max(r, q.right); b = Math.max(b, q.bottom); } } return { r, b }; });
  let W = img.w, H = img.h;
  if (ext.r > 100 && ext.r < img.w * 0.8 && Math.abs(ext.r / ext.b - img.w / img.h) < 0.05) { W = Math.round(ext.r); H = Math.round(ext.b); await load(W, H); }
  const boxes = await page.evaluate(() => {
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
      const color = rgb(e instanceof SVGElement ? s.fill : s.color);
      out.push({ t: own.map((n) => n.textContent.trim()).join(' ').replace(/\s+/g, ' ').slice(0, 60), x: r.left, y: r.top, w: r.width, h: r.height, fs, color, extra, lines: rects.map((q) => ({ x: q.left, y: q.top, w: q.width, h: q.height })) });
    }
    return out;
  });
  // to image pixels
  const k = img.w / W;
  for (const b of boxes) { b.x *= k; b.y *= k; b.w *= k; b.h *= k; b.fs *= k; b.lines = b.lines.map((l) => ({ x: l.x * k, y: l.y * k, w: l.w * k, h: l.h * k })); }
  return { design: { w: W, h: H }, boxes };
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
    words.push({ t, x, y, w, h, conf });
  }
  // words on one line (overlapping heights, close together) → one box; its font size ≈ tallest word ÷ 0.75 (Palm's estimate)
  words.sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const wd of words) {
    const L = lines.find((l) => Math.min(l.y + l.h, wd.y + wd.h) - Math.max(l.y, wd.y) > 0.5 * Math.min(l.h, wd.h) && wd.x - (l.x + l.w) < 1.5 * Math.max(l.h, wd.h) && wd.x + wd.w > l.x);
    if (L) { const x2 = Math.max(L.x + L.w, wd.x + wd.w), y2 = Math.max(L.y + L.h, wd.y + wd.h); L.x = Math.min(L.x, wd.x); L.y = Math.min(L.y, wd.y); L.w = x2 - L.x; L.h = y2 - L.y; L.t += ' ' + wd.t; L.maxh = Math.max(L.maxh, wd.h); }
    else lines.push({ ...wd, maxh: wd.h });
  }
  return lines.map((l) => ({ t: l.t.slice(0, 60), x: l.x, y: l.y, w: l.w, h: l.h, fs: l.maxh / 0.75, lines: [{ x: l.x, y: l.y, w: l.w, h: l.h }], ocr: true }));
}

// ---------- contrast: sample the thumbnail itself ----------
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
        // nearly every pixel close to the text colour: the backdrop is the same colour as the text
        const lum = (far.length < px.length * 0.15 ? px : far).map((p) => L(...p)).sort((a, b) => a - b), bg = lum[Math.floor(lum.length / 2)];
        const tl = L(tc[0], tc[1], tc[2]);
        let best = ratio(tl, bg); for (const e of b.extra || []) if (e.length >= 3 && (e[3] ?? 1) > 0.5) best = Math.max(best, ratio(tl, L(e[0], e[1], e[2])));
        return best;
      }
      // OCR boxes: Otsu split of luminance into two clusters; contrast of their means
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

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

export async function check(file, { source, title = 'Your video title', duration = '12:34', channel = 'Your channel', out = 'look/thumb', plain = false, ocr = 'auto' } = {}) {
  const abs = resolve(file);
  if (!existsSync(abs)) throw new Error('no such file: ' + file);
  const buf = readFileSync(abs), info = imageInfo(buf), bytes = statSync(abs).size;
  const issues = [];
  const W = info.w, H = info.h;
  const image = { file: basename(abs), format: info.format, w: W, h: H, kb: Math.round(bytes / 1024) };
  if (!['jpeg', 'png'].includes(info.format)) issues.push(issue('format', info.format === 'gif' || info.format === 'bmp' ? 'warn' : 'error', `The file is ${info.format.toUpperCase()}; YouTube asks for JPG or PNG.`, 'Save it as JPG (or PNG).'));
  if (!W || !H) throw new Error('could not read the image size');
  if (W < 640) issues.push(issue('too-small', 'error', `${W}×${H}: YouTube's minimum width is 640 px.`, 'Make it 1280×720 or bigger (3840×2160 is YouTube\'s recommendation).'));
  else if (W < 1280 || H < 720) issues.push(issue('low-res', 'warn', `${W}×${H}: under 1280×720, it looks soft on TVs and big screens (Palm's guidance; YouTube recommends 3840×2160).`, 'Make it 1280×720 or bigger.'));
  if (Math.abs(W / H - 16 / 9) > 0.01) issues.push(issue('aspect', 'error', `${W}×${H} is ${round(W / H, 3)}:1, not 16:9 (1.778): YouTube shows it letterboxed or cropped.`, 'Use exactly 16:9, e.g. 1280×720, 1920×1080 or 3840×2160.'));
  if (bytes > 50 * 1024 * 1024) issues.push(issue('file-size', 'error', `${round(bytes / 1048576)} MB: over YouTube's 50 MB limit.`, 'Save as JPG at quality 85–90.'));

  // text boxes
  let text = { method: 'none', boxes: [] };
  if (!source) {
    const stem = basename(abs).replace(/\.\w+$/, ''), dir = dirname(abs);
    const cands = readdirSync(dir).filter((f) => /\.(html?|svg)$/i.test(f));
    source = cands.find((f) => f.replace(/\.\w+$/, '') === stem) || (cands.length === 1 ? cands[0] : null);
    if (source) source = join(dir, source);
  }
  const browser = await launch();
  try {
    const page = await browser.newPage();
    if (source && existsSync(source)) {
      const m = await measureSource(page, source, { w: W, h: H });
      text = { method: 'source', source: basename(source), design: m.design, boxes: m.boxes };
    }
    if (ocr === 'always' || (ocr === 'auto' && text.method === 'none')) {
      if (hasTesseract()) { const b = ocrBoxes(abs); if (text.method === 'none') text = { method: 'ocr', boxes: b }; else text.ocr = b; }
      else if (text.method === 'none') issues.push(issue('not-measured', 'note', 'No HTML/SVG source beside the thumbnail and no Tesseract installed, so its text size and contrast weren\'t measured: judge them on the sheet\'s 168 px row.', 'Keep the HTML/SVG you made it from beside it (same name), or install Tesseract.'));
    }
    const dataUrl = `data:image/${info.format === 'png' ? 'png' : 'jpeg'};base64,${buf.toString('base64')}`;
    await contrasts(page, dataUrl, text.boxes);
    if (text.ocr) await contrasts(page, dataUrl, text.ocr);

    // measured checks at the 168 px "Up next" size
    const kS = VIEWS.sidebar / W;
    const sized = (bs) => bs.map((b) => ({ ...b, side_px: round(b.fs * kS) }));
    text.boxes = sized(text.boxes); if (text.ocr) text.ocr = sized(text.ocr);
    const bs = text.boxes;
    if (text.method !== 'none' && !bs.length) issues.push(issue('no-text-found', 'note', text.method === 'ocr' ? 'OCR found no readable words (fine if the thumbnail has none; OCR also misses heavily styled lettering). Judge it on the sheet.' : 'The source has no text.', ''));
    const est = text.method === 'ocr' ? ' (Palm\'s estimate from OCR)' : '';
    if (bs.length) {
      const big = Math.max(...bs.map((b) => b.side_px));
      text.largest_at_sidebar = big; text.smallest_at_sidebar = Math.min(...bs.map((b) => b.side_px));
      text.words = bs.reduce((n, b) => n + b.t.split(/\s+/).filter(Boolean).length, 0);
      const small = bs.filter((b) => b.side_px < MIN_SIDEBAR_FS).sort((a, b) => a.side_px - b.side_px);
      if (small.length) issues.push(issue('text-small', 'warn', `${small.length} line${small.length > 1 ? 's' : ''} of text can't be read on the 168 px "Up next" card${est}: ${small.slice(0, 4).map((b) => `"${b.t}" ${Math.round(b.fs)} px → ${b.side_px} px`).join('; ')}. Palm's guidance: ${MIN_SIDEBAR_FS} px or more there.`, `Make every word at least ${Math.ceil(MIN_SIDEBAR_FS / kS)} px tall (font size) on this ${W}-wide image, or cut it: the title already sits beside the thumbnail.`));
      if (big < HEAD_SIDEBAR_FS) issues.push(issue('headline-small', 'warn', `The biggest words are about ${Math.round(big / kS)} px, ${big} px on the 168 px card${est}: they won't read at a glance in "Up next" or on a phone's compact list.`, `Make the main words at least ${Math.ceil(HEAD_SIDEBAR_FS / kS)} px (font size); fewer words, bigger.`));
      // duration badge and progress bar, at the 168 px card where they cover the most
      const bx = W - (BADGE.w + BADGE.inset) / kS, by = H - (BADGE.h + BADGE.inset) / kS, barY = H - BAR / kS;
      const ov = (l, x0, y0) => Math.max(0, l.x + l.w - Math.max(l.x, x0)) * Math.max(0, l.y + l.h - Math.max(l.y, y0)) / (l.w * l.h || 1);
      const under = bs.filter((b) => b.lines.some((l) => ov(l, bx, by) > 0.12));
      if (under.length) issues.push(issue('under-badge', 'warn', `"${under[0].t}" sits where YouTube puts the duration badge (${duration}) on small cards: the bottom-right ${Math.round((1 - bx / W) * 100)}% × ${Math.round((1 - by / H) * 100)}% at 168 px (Palm's measurement).`, 'Keep words, faces and the key object out of the bottom-right corner.'));
      const onBar = bs.filter((b) => b.lines.some((l) => l.y + l.h > barY + 1));
      if (onBar.length && !under.includes(onBar[0])) issues.push(issue('under-progress', 'tip', `"${onBar[0].t}" runs into the bottom edge, where the red progress bar is drawn once someone has started watching.`, 'Leave a few percent of space along the bottom.'));
      const low = bs.filter((b) => b.contrast != null && b.contrast < MIN_CONTRAST && b.side_px >= 4);
      if (low.length) issues.push(issue('low-contrast', 'warn', `Low contrast against what's behind it (Palm's estimate): ${low.slice(0, 3).map((b) => `"${b.t}" ${b.contrast}:1`).join('; ')}. At small sizes this turns to mush.`, `Aim for ${MIN_CONTRAST}:1 or more: a solid panel, a darker/lighter backdrop, or an outline.`));
    }
    // a tip if the thumbnail just repeats the title
    if (bs.length && title) {
      const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter((w) => w.length > 2);
      const tw = new Set(norm(title)), ow = norm(bs.map((b) => b.t).join(' '));
      if (ow.length >= 6 && ow.filter((w) => tw.has(w)).length / ow.length > 0.8) issues.push(issue('repeats-title', 'tip', 'Most of the words on the thumbnail repeat the title, which is shown right beside it.', 'Let the image and a few new words do the work; the title says the rest.'));
    }

    const sheet = await drawSheet(page, { dataUrl, W, H, title, duration, channel, plain, bs, kS, image });
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(resolve(out) + '-sheet.html', sheet.html);
    await page.setViewport({ width: 1500, height: 1000, deviceScaleFactor: 1 });
    await page.setContent(sheet.html, { waitUntil: 'load' });
    await page.evaluate(() => Promise.all([...document.images].map((i) => i.complete ? 0 : new Promise((r) => (i.onload = i.onerror = r)))));
    await page.screenshot({ path: resolve(out) + '-sheet.png', fullPage: true });
  } finally { await browser.close(); }
  const errors = issues.filter((i) => i.level === 'error').length, warnings = issues.filter((i) => i.level === 'warn').length;
  const slim = (b) => ({ t: b.t, font_px: Math.round(b.fs), at_168px: b.side_px, contrast: b.contrast });
  return { ok: errors === 0, errors, warnings, image, text: { method: text.method, source: text.source, design: text.design, words: text.words ?? 0, largest_at_sidebar: text.largest_at_sidebar ?? null, smallest_at_sidebar: text.smallest_at_sidebar ?? null, lines: text.boxes.map(slim), ...(text.ocr ? { ocr: text.ocr.map(slim) } : {}) }, issues, sheet: resolve(out) + '-sheet.png' };
}

// ---------- the sheet ----------
// Stand-in neighbours: abstract colour fields with bars where words would be (no real videos or brands).
const NB = [['#1d3557', '#e63946', '#f1faee'], ['#264653', '#e9c46a', '#fff'], ['#3a0ca3', '#f72585', '#fff'], ['#2b2d42', '#8d99ae', '#edf2f4'], ['#5f0f40', '#fb8b24', '#fff'], ['#0b3d2e', '#9ef01a', '#fff'], ['#6d597a', '#eaac8b', '#fff']];
function neighbour(i, w) {
  const [a, b, c] = NB[i % NB.length], h = w * 9 / 16;
  return `<div style="position:absolute;inset:0;background:linear-gradient(${120 + i * 40}deg,${a} 0 55%,${b})"><div style="position:absolute;right:8%;top:14%;width:${h * 0.7}px;height:${h * 0.7}px;border-radius:50%;background:${b};opacity:.8;filter:blur(${w / 60}px)"></div><div style="position:absolute;left:7%;top:18%;width:42%;height:${h * 0.16}px;background:${c};border-radius:3px"></div><div style="position:absolute;left:7%;top:42%;width:30%;height:${h * 0.16}px;background:${c};border-radius:3px;opacity:.9"></div></div>`;
}
const DUR = ['10:21', '24:07', '8:55', '15:30', '31:12', '6:48', '19:03'];
export async function drawSheet(page, { dataUrl, W, H, title, duration, channel, plain, bs, kS, image }) {
  const thumb = (w, { mine = true, i = 0, prog = 0, r = 12, dur } = {}) => {
    const h = Math.round(w * 9 / 16);
    const inner = mine ? `<img src="${dataUrl}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover">` : neighbour(i, w);
    return `<div style="position:relative;width:${w}px;height:${h}px;border-radius:${r}px;overflow:hidden;flex:none;background:#000">${inner}<div style="position:absolute;right:${BADGE.inset}px;bottom:${BADGE.inset + (prog ? BAR : 0)}px;height:${BADGE.h}px;padding:0 4px;border-radius:4px;background:rgba(0,0,0,.8);color:#fff;font:500 12px/18px Roboto,Arial,sans-serif">${esc(mine ? duration : dur || DUR[i % DUR.length])}</div>${prog ? `<div style="position:absolute;left:0;right:0;bottom:0;height:${BAR}px;background:rgba(255,255,255,.35)"><div style="width:${prog}%;height:100%;background:#f00"></div></div>` : ''}</div>`;
  };
  const T = (dark) => dark ? { bg: '#0f0f0f', fg: '#f1f1f1', sub: '#aaa' } : { bg: '#fff', fg: '#0f0f0f', sub: '#606060' };
  const av = (s, mine) => `<div style="width:${s}px;height:${s}px;border-radius:50%;flex:none;background:${mine ? '#2f5d4e' : '#bbb'}"></div>`;
  const clamp = (n) => `display:-webkit-box;-webkit-line-clamp:${n};-webkit-box-orient:vertical;overflow:hidden`;
  const gridCard = (t, mine, i, dark) => `<div style="width:360px"><div>${thumb(360, { mine, i })}</div><div style="display:flex;gap:12px;margin-top:12px">${av(36, mine)}<div><div style="font:500 16px/22px Roboto,Arial,sans-serif;color:${T(dark).fg};${clamp(2)}">${esc(t)}</div><div style="font:400 14px/20px Roboto,Arial,sans-serif;color:${T(dark).sub};margin-top:4px">${esc(mine ? channel : 'Another channel')}<br>${mine ? '12K views · 2 days ago' : `${(i * 37) % 900 + 40}K views · ${i + 1} weeks ago`}</div></div></div></div>`;
  const other = 'Another video in the feed';
  const grid = (dark) => `<div class="sec" style="background:${T(dark).bg}"><h2 style="color:${T(dark).sub}">Desktop home, ${dark ? 'dark' : 'light'}: 360 px cards</h2><div class="row">${gridCard(other, false, dark ? 3 : 0, dark)}${gridCard(title, true, 0, dark)}${gridCard(other, false, dark ? 4 : 1, dark)}</div></div>`;
  const searchRow = (t, mine, i, dark) => `<div style="display:flex;gap:16px;margin-bottom:16px">${thumb(360, { mine, i })}<div style="max-width:560px"><div style="font:400 18px/26px Roboto,Arial,sans-serif;color:${T(dark).fg};${clamp(2)}">${esc(t)}</div><div style="font:400 12px/18px Roboto,Arial,sans-serif;color:${T(dark).sub}">${mine ? '12K views · 2 days ago' : '210K views · 1 year ago'}</div><div style="display:flex;gap:8px;align-items:center;margin:12px 0;font:400 12px Roboto,Arial,sans-serif;color:${T(dark).sub}">${av(24, mine)}${esc(mine ? channel : 'Another channel')}</div></div></div>`;
  const search = (dark) => `<div class="sec" style="background:${T(dark).bg}"><h2 style="color:${T(dark).sub}">Desktop search results, ${dark ? 'dark' : 'light'}: 360 px</h2>${searchRow(other, false, 2, dark)}${searchRow(title, true, 0, dark)}</div>`;
  const sideItem = (t, mine, i, dark, prog) => `<div style="display:flex;gap:8px;margin-bottom:8px;width:402px">${thumb(168, { mine, i, prog, r: 8 })}<div><div style="font:500 14px/20px Roboto,Arial,sans-serif;color:${T(dark).fg};${clamp(2)}">${esc(t)}</div><div style="font:400 12px/18px Roboto,Arial,sans-serif;color:${T(dark).sub}">${esc(mine ? channel : 'Another channel')}<br>${mine ? '12K views · 2 days ago' : '88K views · 3 weeks ago'}</div></div></div>`;
  const side = (dark, prog) => `<div style="background:${T(dark).bg};padding:14px"><div style="color:${T(dark).sub};font:600 13px system-ui;margin-bottom:10px">Watch page "Up next", ${dark ? 'dark' : 'light'}${prog ? ', partly watched' : ''}: 168 px</div>${sideItem(other, false, 5, dark)}${sideItem(title, true, 0, dark, prog)}${sideItem(other, false, 6, dark)}${sideItem(other, false, 1, dark)}</div>`;
  const phoneFeed = (dark) => `<div style="width:390px;background:${T(dark).bg};flex:none;padding-bottom:10px"><div style="color:${T(dark).sub};font:600 13px system-ui;padding:10px 12px">Phone home feed, ${dark ? 'dark' : 'light'}: 390 px</div>${thumb(390, { mine: true, r: 0 })}<div style="display:flex;gap:12px;padding:12px">${av(36, true)}<div><div style="font:500 15px/21px Roboto,Arial,sans-serif;color:${T(dark).fg};${clamp(2)}">${esc(title)}</div><div style="font:400 12px/18px Roboto,Arial,sans-serif;color:${T(dark).sub}">${esc(channel)} · 12K views · 2 days ago</div></div></div><div style="height:90px;overflow:hidden">${thumb(390, { mine: false, i: dark ? 5 : 2, r: 0 })}</div></div>`;
  const compact = (dark) => `<div style="width:390px;background:${T(dark).bg};flex:none;padding:10px 12px;box-sizing:border-box"><div style="color:${T(dark).sub};font:600 13px system-ui;margin-bottom:10px">Phone "Up next" / history list, ${dark ? 'dark' : 'light'}: 160 px</div>${[[false, 3], [true, 0], [false, 6]].map(([m, i]) => `<div style="display:flex;gap:10px;margin-bottom:10px">${thumb(160, { mine: m, i, prog: m ? 62 : 0, r: 8 })}<div style="font:400 14px/20px Roboto,Arial,sans-serif;color:${T(dark).fg};${clamp(3)}">${esc(m ? title : other)}<div style="font-size:12px;color:${T(dark).sub}">${esc(m ? channel : 'Another channel')}</div></div></div>`).join('')}</div>`;
  // full size, with (agent sheet only) the badge zone and each measured line
  const fw = 1100, fk = fw / W, fh = Math.round(H * fk);
  let marks = '';
  if (!plain) {
    const bx = (BADGE.w + BADGE.inset) / kS * fk, by = (BADGE.h + BADGE.inset) / kS * fk;
    marks += `<div style="position:absolute;right:0;bottom:0;width:${bx}px;height:${by}px;border:3px dashed #ff0;box-sizing:border-box"></div><div style="position:absolute;right:4px;bottom:${by + 4}px;font:600 13px system-ui;color:#ff0;text-shadow:0 0 3px #000">duration badge at 168 px</div>`;
    for (const b of bs) { const bad = b.side_px < MIN_SIDEBAR_FS || (b.contrast != null && b.contrast < MIN_CONTRAST); marks += `<div style="position:absolute;left:${b.x * fk}px;top:${b.y * fk}px;width:${b.w * fk}px;height:${b.h * fk}px;border:2px solid ${bad ? '#f33' : '#3c6'};box-sizing:border-box"></div><div style="position:absolute;left:${b.x * fk}px;top:${b.y * fk + b.h * fk}px;font:600 12px system-ui;color:#fff;background:${bad ? '#c22' : '#285'};padding:0 3px">${b.side_px} px at 168${b.contrast != null ? ` · ${b.contrast}:1` : ''}</div>`; }
  }
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;width:1500px;background:#ecebe8;font-family:system-ui,sans-serif}.sec{padding:16px 20px}.row{display:flex;gap:16px}h2{font:600 14px system-ui;margin:0 0 12px}</style></head><body>
<div class="sec" style="background:#222;color:#eee"><h2 style="color:#eee;font-size:16px">YouTube thumbnail: ${esc(image.file)} · ${image.w}×${image.h} · ${image.format.toUpperCase()} · ${image.kb} KB, where YouTube shows it (Palm's approximation of YouTube's layouts, Nov 2026; duration badge and progress bar drawn on top)</h2></div>
${grid(false)}${grid(true)}${search(false)}
<div class="sec" style="display:flex;gap:16px;background:#ecebe8">${side(false, 0)}${side(true, 35)}</div>
<div class="sec" style="display:flex;gap:16px;align-items:flex-start;background:#ecebe8">${phoneFeed(false)}${phoneFeed(true)}${compact(true)}</div>
<div class="sec" style="background:#ecebe8"><h2>Full size${plain ? '' : ': dashed = where the duration badge sits on a 168 px card; boxes = measured text, its size on the 168 px card and contrast'}</h2><div style="position:relative;width:${fw}px;height:${fh}px"><img src="${dataUrl}" style="width:${fw}px;height:${fh}px;display:block">${marks}</div></div>
</body></html>`;
  return { html };
}

// ---------- render HTML to the thumbnail ----------
export async function render(file, { out, size = '1280x720', quality = 90 } = {}) {
  const [w, h] = String(size).split('x').map(Number);
  if (!w || !h) throw new Error('--size WxH, e.g. 1280x720');
  const browser = await launch();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(resolve(file)).href, { waitUntil: 'load', timeout: 30000 });
    await page.evaluate(() => document.fonts?.ready); await new Promise((r) => setTimeout(r, 200));
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
  const d = mkdtempSync(join(tmpdir(), 'yt-thumb-'));
  // good: two big words top-left on a dark panel, nothing bottom-right
  writeFileSync(join(d, 'good.html'), '<html><body style="margin:0;width:1280px;height:720px;overflow:hidden;background:#2f5d4e;font-family:Arial,sans-serif"><div style="position:absolute;left:60px;top:60px;font:900 190px/1 Arial;color:#fff">3 TOOLS</div><div style="position:absolute;left:60px;top:280px;font:800 110px/1 Arial;color:#f3e6cc">ONE STOOL</div></body></html>');
  const g0 = await render(join(d, 'good.html'), { out: join(d, 'good.jpg') });
  if (!g0.ok) throw new Error('render: ' + JSON.stringify(g0));
  const g = await check(join(d, 'good.jpg'), { out: join(d, 'good'), title: 'Build a stool', duration: '18:42' });
  if (g.issues.some((i) => i.level !== 'note' && i.level !== 'tip') || g.text.method !== 'source' || g.text.lines.length !== 2) throw new Error('good: ' + JSON.stringify(g.issues) + JSON.stringify(g.text));
  // bad: designed at 1280×720, rendered at 1280×700 (not 16:9), small subtitle, text bottom-right, low-contrast line
  writeFileSync(join(d, 'bad.html'), '<html><body style="margin:0;width:1280px;height:700px;overflow:hidden;background:#c98b4b;font-family:Arial,sans-serif"><div style="position:absolute;left:60px;top:60px;font:900 150px/1 Arial;color:#fff;text-shadow:0 4px 0 #000">STEP STOOL</div><div style="position:absolute;left:60px;top:260px;font:400 38px/1 Arial;color:#222">a beginner friendly build with no power tools at all</div><div style="position:absolute;left:60px;top:360px;font:700 90px/1 Arial;color:#d49a5a">PINE</div><div style="position:absolute;right:30px;bottom:30px;font:800 70px/1 Arial;color:#fff;background:#222;padding:6px">FREE PLAN</div></body></html>');
  await render(join(d, 'bad.html'), { out: join(d, 'bad.jpg'), size: '1280x700' });
  const b = await check(join(d, 'bad.jpg'), { out: join(d, 'bad'), duration: '18:42' });
  const ids = b.issues.map((i) => i.id);
  for (const want of ['aspect', 'text-small', 'under-badge', 'low-contrast']) if (!ids.includes(want)) throw new Error('bad: expected ' + want + ' in ' + ids.join(','));
  // 2× design (1280×720 page rendered into a 2560×1440 viewport is measured at its design size)
  writeFileSync(join(d, 'big.html'), '<html><body style="margin:0;background:#222"><div style="width:1280px;height:720px;position:relative;background:#2f5d4e"><div style="position:absolute;left:60px;top:60px;font:900 200px/1 Arial;color:#fff">BIG</div></div></body></html>');
  const big = await check(join(d, 'good.jpg'), { source: join(d, 'big.html'), out: join(d, 'big') });
  if (Math.abs(big.text.lines[0].font_px - 200) > 2) throw new Error('design-size detection: ' + JSON.stringify(big.text));
  // image only: OCR (if Tesseract is installed)
  if (hasTesseract()) {
    const o = await check(join(d, 'bad.jpg'), { source: join(d, 'nope.html'), out: join(d, 'ocr'), ocr: 'always' });
    const im = join(d, 'only'); mkdirSync(im); writeFileSync(join(im, 'x.jpg'), readFileSync(join(d, 'bad.jpg')));
    const o2 = await check(join(im, 'x.jpg'), { out: join(d, 'ocr2') });
    if (o2.text.method !== 'ocr' || !o2.text.lines.length) throw new Error('ocr: ' + JSON.stringify(o2.text));
    if (!o2.issues.some((i) => i.id === 'text-small')) throw new Error('ocr: small subtitle not found ' + JSON.stringify(o2.text.lines));
    console.log('ocr lines:', o2.text.lines.map((l) => `${l.t}=${l.font_px}px`).join(' | '), o.ok);
  } else console.log('(Tesseract not installed: OCR path not tested)');
  console.log(`yt-thumb-check: all tests pass (good: no warnings; bad: ${ids.join(', ')}; sheets in ${d})`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (k, dflt) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : dflt; };
  const VALUED = new Set(['--out', '--size', '--quality', '--source', '--title', '--duration', '--channel']);
  const pos = argv.filter((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1]));
  const done = (r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); };
  const fail = (e) => { console.error(String(e.message || e)); process.exit(2); };
  if (argv.includes('--test')) selfTest().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
  else if (pos[0] === 'render' && pos[1]) render(pos[1], { out: opt('out', 'thumbnail.jpg'), size: opt('size', '1280x720'), quality: +opt('quality', 90) }).then(done, fail);
  else if (pos[0] === 'check' && pos[1]) check(pos[1], { source: opt('source'), title: opt('title'), duration: opt('duration'), channel: opt('channel'), out: opt('out', 'look/thumb'), plain: argv.includes('--plain') }).then(done, fail);
  else fail('usage: yt-thumb-check.mjs check thumbnail.jpg [--source thumbnail.html] [--title "…"] [--duration 18:42] [--channel "…"] [--out look/thumb]\n       yt-thumb-check.mjs render thumbnail.html --size 1280x720 --out thumbnail.jpg\n       yt-thumb-check.mjs --test');
}
