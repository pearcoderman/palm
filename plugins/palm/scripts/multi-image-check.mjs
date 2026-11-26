#!/usr/bin/env node
// Palm tool: multi-image-check — lets an agent see a post with several images (2–4, or a 5+ album) where X, Bluesky,
// Threads, Facebook and LinkedIn lay it out in the timeline, on a phone and a desktop, light and dark, among stand-in
// posts, and measures what fails there: each app lays 2, 3, 4 and 5+ images into its own grid and crops each image to
// its tile, so words and faces get cut, the key image may not land in the big tile, small text only reads full screen,
// and the extra images hide behind "+N" or off-screen.
//
//   node multi-image-check.mjs check <post folder> [--out look/post] [--photos photos/] [--subjects subjects.json]
//                                    [--handle @name] [--name "Shop name"] [--plain] [--ocr auto|always|never]
//       → JSON {ok, errors, warnings, images:[…], views:[…], issues, sheet}. Then LOOK at <out>-sheet.png.
//       The folder holds the images to attach (JPG/PNG), in name order (01-…, 02-…: the order they're attached), and:
//         alt.txt   one line per image: "<file name>: <alt text>" (or post.json {images:[{file, alt, subject}]})
//         post.md   optional: the post text per app under "## X", "## Bluesky", "## Threads", "## Facebook", "## LinkedIn"
//       Keep the HTML/SVG each image was made from beside it with the same name, so its text can be measured.
//       Subjects (a face, the product: what must stay in every crop): post.json images[].subject = [x,y,w,h] as fractions
//         of that image; or mark them once on the original photos with --photos <folder> --subjects <json>
//         ({"team.jpg": [[x,y,w,h], …]}, fractions of each original): each attached image is found inside its original
//         (a crop of it), or the originals placed whole inside it (a collage), by image matching (0.9 correlation or
//         better), and the boxes follow; a collage of cropped panels isn't followed (Palm estimates instead). Otherwise
//         Palm estimates one (faces if Chrome finds any, else the most colourful, contrasting region) and labels it an estimate.
//   node multi-image-check.mjs render <image.html | folder of .html> [--size 1080x1080] [--out image.jpg | folder]
//       → renders the HTML at exactly that size (JPG, or PNG without alpha).
//   node multi-image-check.mjs --self-test
//
// Facts (official pages, read 2026-11-26):
//   X: up to 4 photos per post (X API docs, Create Post); 5 MB per image (X API media upload); image description up to
//     1,000 characters (X Help, "How to make images accessible for people"); a single photo between 2:1 and 3:4 shows in
//     full (X Help, "How to post photos or GIFs on X"); posts up to 280 characters (X docs, "Counting characters").
//   Bluesky: up to 4 images per post, each up to 2,000,000 bytes, alt text required by the record, no length limit
//     (lexicon app.bsky.embed.images); posts up to 300 graphemes (app.bsky.feed.post). The grid is from Bluesky's
//     open-source app (social-app ImageLayoutGrid.tsx, changed 2026-08-13): 2 = two squares; 3 = a square on the left,
//     the right square split into two stacked tiles; 4 = 2×2, each 3:2. A newer "gallery" record (lexicon
//     app.bsky.embed.gallery: up to 20, clients limit to 10) shows more than 4 as a carousel; not every app has it yet.
//   Threads: a carousel of 2–20 images or videos; JPEG or PNG, 8 MB, aspect ratio up to 10:1, at least 320 px wide;
//     alt_text per image (no length limit published); posts up to 500 characters (Threads API docs, Posts).
//   LinkedIn: up to 20 images; 5 MB; at least 552×276; aspect 3:1 to 4:5, wider or taller is centred and cropped; in a
//     multi-photo post images render at most 4:5 and "the post will have a greater visual emphasis on the first image";
//     two images side by side keeping their ratios; with 3+, a landscape first image (wider than 4:3) sits on top with
//     the others side by side below (equal widths, the row as tall as its shortest image, the whole at most 4:5, the
//     bottom row cropped to fit), a portrait or square first image sits in a left column with the others stacked to its
//     right (LinkedIn Help, "Share photos on LinkedIn"). Alt text up to 4,086 characters, under 120 recommended;
//     under 36,152,320 pixels (LinkedIn MultiImage API docs). Posts up to 3,000 characters.
//   Facebook: you can select several photos and edit each one's alt text (Facebook Help); Meta publishes no layout,
//     count or alt-text limit for multi-photo posts.
// Palm's approximation (Nov 2026; the apps don't publish these): X's grid (2–4 photos in a 16:9 box: two halves; a
//   left half and two stacked; 2×2), Facebook's (by the first photo's shape: two halves; one big + two or three small;
//   5+ = two over three with "+N"), Threads' carousel (one row at a fixed height, each image at its own shape between
//   4:5 and 1.91:1, the rest off-screen until swiped), how many LinkedIn shows before "+N" (four), the centre crop in
//   every tile (none of the apps offer a focal point for these posts), the column widths on a 390 px phone and a desktop.
// Palm's thresholds (guidance, not a platform rule): every line of words at least 9 px (font size) as shown on a phone,
//   the biggest at least 14 px; 90% of each line and of each subject inside its tile; a subject at least 28 px across on
//   a phone; contrast 3:1 or more against the pixels behind; at least 40% of an image showing in its tile; alt text that
//   carries the words printed in the image.
// Text size: from each image's HTML/SVG source (each line measured in the page), else from the image with Tesseract OCR
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
const launch = () => loadPuppeteer().launch({ executablePath: findChrome(), headless: true, timeout: 90000, protocolTimeout: 240000, args: ['--no-sandbox', '--hide-scrollbars', '--allow-file-access-from-files', '--enable-experimental-web-platform-features'] });

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
  if (b.toString('latin1', 0, 3) === 'GIF') return { format: 'gif', w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  return { format: 'unknown' };
}

const issue = (id, level, msg, fix, file) => ({ id, level, file, msg, fix });
const round = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d;
const pct = (v) => Math.round(v * 100) + '%';
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const clampA = (a, lo, hi) => Math.min(hi, Math.max(lo, a));

// ---------- the apps (facts above; geometry = Palm's approximation unless sourced) ----------
export const APPS = {
  x: { name: 'X', max: 4, maxBytes: 5e6, alt: 1000, text: 280, formats: ['jpeg', 'png', 'gif', 'webp'] },
  bluesky: { name: 'Bluesky', max: 4, maxBytes: 2e6, alt: null, text: 300, formats: ['jpeg', 'png', 'webp', 'gif'] },
  threads: { name: 'Threads', max: 20, maxBytes: 8e6, alt: null, text: 500, formats: ['jpeg', 'png'] },
  facebook: { name: 'Facebook', max: null, maxBytes: null, alt: null, text: null, formats: ['jpeg', 'png', 'gif', 'webp'] },
  linkedin: { name: 'LinkedIn', max: 20, maxBytes: 5e6, alt: 4086, text: 3000, formats: ['jpeg', 'png', 'gif'] },
};
// media width in CSS px: on a 390 px phone, and in a desktop browser's feed column (Palm's approximation)
export const WIDTH = { phone: { x: 312, bluesky: 310, threads: 330, facebook: 390, linkedin: 390 }, desktop: { x: 506, bluesky: 528, threads: 548, facebook: 500, linkedin: 555 } };
const THREADS_H = { phone: 250, desktop: 330 };
const MIN_FS = 9, HEAD_FS = 14, KEEP = 0.9, SUBJ_PX = 28, MIN_CONTRAST = 3, MIN_SHOWN = 0.4;

// The tiles for n images of the given aspect ratios (w/h) in a W-wide media box: [{i, x, y, w, h, plus, off}].
// Every tile crops its image to fill it, centred ("cover").
export function layout(app, aspects, W) {
  const n = aspects.length, t = [];
  const T = (i, x, y, w, h, extra = {}) => t.push({ i, x: round(x, 2), y: round(y, 2), w: round(w, 2), h: round(h, 2), ...extra });
  let H = 0;
  if (app === 'x') {
    const g = 2, k = Math.min(n, 4);
    if (k === 1) { H = W / clampA(aspects[0], 3 / 4, 2); T(0, 0, 0, W, H); }
    else {
      H = W * 9 / 16; const hw = (W - g) / 2, hh = (H - g) / 2;
      if (k === 2) { T(0, 0, 0, hw, H); T(1, hw + g, 0, hw, H); }
      else if (k === 3) { T(0, 0, 0, hw, H); T(1, hw + g, 0, hw, hh); T(2, hw + g, hh + g, hw, hh); }
      else { T(0, 0, 0, hw, hh); T(1, hw + g, 0, hw, hh); T(2, 0, hh + g, hw, hh); T(3, hw + g, hh + g, hw, hh); }
    }
  } else if (app === 'bluesky') {
    const g = 4, k = Math.min(n, 4), s = (W - g) / 2;
    if (k === 1) { H = W / clampA(aspects[0], 1 / 2, 4); T(0, 0, 0, W, H); }
    else if (k === 2) { H = s; T(0, 0, 0, s, s); T(1, s + g, 0, s, s); }
    else if (k === 3) { H = s; const hh = (s - g) / 2; T(0, 0, 0, s, s); T(1, s + g, 0, s, hh); T(2, s + g, hh + g, s, hh); }
    else { const th = s / 1.5; H = 2 * th + g; T(0, 0, 0, s, th); T(1, s + g, 0, s, th); T(2, 0, th + g, s, th); T(3, s + g, th + g, s, th); }
  } else if (app === 'threads') {
    const g = 6, h = W > 400 ? THREADS_H.desktop : THREADS_H.phone; H = h; let x = 0;
    if (n === 1) { H = W / clampA(aspects[0], 4 / 5, 1.91); T(0, 0, 0, W, H); }
    else aspects.forEach((a, i) => { const w = h * clampA(a, 4 / 5, 1.91); T(i, x, 0, w, h, x >= W - 8 ? { off: true } : x + w > W ? { partly: round((W - x) / w, 2) } : {}); x += w + g; });
  } else if (app === 'facebook') {
    const g = 3, land = aspects[0] > 1.05;
    if (n === 1) { H = W / clampA(aspects[0], 4 / 5, 1.91); T(0, 0, 0, W, H); }
    else if (n === 2) { H = W; if (land) { const hh = (W - g) / 2; T(0, 0, 0, W, hh); T(1, 0, hh + g, W, hh); } else { const hw = (W - g) / 2; T(0, 0, 0, hw, W); T(1, hw + g, 0, hw, W); } }
    else if (n <= 4) {
      const k = n - 1; H = W;
      if (land) { const bh = W * 2 / 3, sw = (W - g * (k - 1)) / k; T(0, 0, 0, W, bh - g); for (let j = 0; j < k; j++) T(j + 1, j * (sw + g), bh, sw, W - bh); }
      else { const bw = W * 2 / 3, sh = (W - g * (k - 1)) / k; T(0, 0, 0, bw - g, W); for (let j = 0; j < k; j++) T(j + 1, bw, j * (sh + g), W - bw, sh); }
    } else {
      const tw = (W - g) / 2, sw = (W - 2 * g) / 3; H = tw + g + sw;
      T(0, 0, 0, tw, tw); T(1, tw + g, 0, tw, tw); for (let j = 0; j < 3; j++) T(j + 2, j * (sw + g), tw + g, sw, sw, j === 2 && n > 5 ? { plus: n - 5 } : {});
      for (let i = 5; i < n; i++) T(i, 0, 0, 0, 0, { hidden: true });
    }
  } else if (app === 'linkedin') {
    const g = 4, A = aspects.map((a) => clampA(a, 4 / 5, 3));
    if (n === 1) { H = W / A[0]; T(0, 0, 0, W, H); }
    else if (n === 2) { H = (W - g) / (A[0] + A[1]); T(0, 0, 0, H * A[0], H); T(1, H * A[0] + g, 0, H * A[1], H); }
    else {
      const shown = Math.min(n, 4), k = shown - 1;
      if (A[0] > 4 / 3) {
        const topH = W / A[0], sw = (W - g * (k - 1)) / k;
        let rowH = Math.min(...A.slice(1, shown).map((a) => sw / a));
        const maxH = W * 5 / 4; if (topH + g + rowH > maxH) rowH = Math.max(40, maxH - topH - g);
        H = topH + g + rowH; T(0, 0, 0, W, topH);
        for (let j = 0; j < k; j++) T(j + 1, j * (sw + g), topH + g, sw, rowH, j === k - 1 && n > shown ? { plus: n - shown } : {});
      } else {
        const lw = (W - g) * 2 / 3, rw = W - g - lw; H = Math.min(lw / A[0], W * 5 / 4); const sh = (H - g * (k - 1)) / k;
        T(0, 0, 0, lw, H); for (let j = 0; j < k; j++) T(j + 1, lw + g, j * (sh + g), rw, sh, j === k - 1 && n > shown ? { plus: n - shown } : {});
      }
      for (let i = shown; i < n; i++) T(i, 0, 0, 0, 0, { hidden: true });
    }
  }
  return { W, H: round(H, 2), tiles: t };
}

// What part of an iw×ih image a tw×th tile shows (centre "cover"): fractions of the image, and the scale.
export function cropOf(iw, ih, tw, th) {
  const s = Math.max(tw / iw, th / ih), vw = Math.min(1, tw / s / iw), vh = Math.min(1, th / s / ih);
  return { x0: (1 - vw) / 2, y0: (1 - vh) / 2, x1: (1 + vw) / 2, y1: (1 + vh) / 2, s };
}
const areaIn = (b, c) => Math.max(0, Math.min(b.x1, c.x1) - Math.max(b.x0, c.x0)) * Math.max(0, Math.min(b.y1, c.y1) - Math.max(b.y0, c.y0)) / (((b.x1 - b.x0) * (b.y1 - b.y0)) || 1);

// ---------- text from the source (HTML or SVG) ----------
async function measureSource(page, src, img) {
  const url = pathToFileURL(resolve(src)).href;
  const load = async (w, h) => { await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 }); await page.goto(url, { waitUntil: 'load', timeout: 30000 }); await page.evaluate(() => document.fonts?.ready); await new Promise((r) => setTimeout(r, 150)); };
  await load(img.w, img.h);
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
      out.push({ t: own.map((n) => n.textContent.trim()).join(' ').replace(/\s+/g, ' ').slice(0, 80), x: r.left, y: r.top, w: r.width, h: r.height, fs, color: rgb(e instanceof SVGElement ? s.fill : s.color), extra, lines: rects.map((q) => ({ x: q.left, y: q.top, w: q.width, h: q.height })) });
    }
    return out;
  });
  const k = img.w / W;
  for (const b of res) { b.x *= k; b.y *= k; b.w *= k; b.h *= k; b.fs *= k; b.lines = b.lines.map((l) => ({ x: l.x * k, y: l.y * k, w: l.w * k, h: l.h * k })); }
  return res;
}

// ---------- text from the image (Tesseract OCR, if installed) ----------
function hasTesseract() { try { execFileSync('tesseract', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } }
export function ocrBoxes(file) {
  const tsv = execFileSync('tesseract', [file, 'stdout', '--psm', '11', 'tsv'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32e6 });
  const words = [];
  for (const line of tsv.split('\n').slice(1)) {
    const c = line.split('\t'); if (c.length < 12 || c[0] !== '5') continue;
    const t = c[11].trim(), conf = +c[10], x = +c[6], y = +c[7], w = +c[8], h = +c[9];
    const letters = (t.match(/\p{L}/gu) || []).length, digits = (t.match(/\p{N}/gu) || []).length;
    // photo texture reads as short junk ("al", "bf)"): keep words of 3+ letters, or numbers
    if (conf < 60 || h < 6 || !(letters >= 3 || (digits >= 1 && letters + digits >= 2))) continue;
    words.push({ t, x, y, w, h });
  }
  words.sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const wd of words) {
    const L = lines.find((l) => Math.min(l.y + l.h, wd.y + wd.h) - Math.max(l.y, wd.y) > 0.5 * Math.min(l.h, wd.h) && wd.x - (l.x + l.w) < 1.5 * Math.max(l.h, wd.h) && wd.x + wd.w > l.x);
    if (L) { const x2 = Math.max(L.x + L.w, wd.x + wd.w), y2 = Math.max(L.y + L.h, wd.y + wd.h); L.x = Math.min(L.x, wd.x); L.y = Math.min(L.y, wd.y); L.w = x2 - L.x; L.h = y2 - L.y; L.t += ' ' + wd.t; L.maxh = Math.max(L.maxh, wd.h); }
    else lines.push({ ...wd, maxh: wd.h });
  }
  return lines.map((l) => ({ t: l.t.slice(0, 80), x: l.x, y: l.y, w: l.w, h: l.h, fs: l.maxh / 0.75, lines: [{ x: l.x, y: l.y, w: l.w, h: l.h }], ocr: true }));
}

// ---------- the lab page: contrast, locating an image in its original, the subject estimate, thumbnails ----------
const LAB = String.raw`
window.lab = {
  async load(url) { const im = new Image(); im.src = url; await im.decode(); return im; },
  grey(im, w) { const h = Math.max(1, Math.round(w * im.naturalHeight / im.naturalWidth)); const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d', { willReadFrequently: true }); x.imageSmoothingQuality = 'high'; x.drawImage(im, 0, 0, w, h); const d = x.getImageData(0, 0, w, h).data; const g = new Float32Array(w * h); for (let i = 0; i < w * h; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]; return { g, w, h }; },
  greyWH(im, w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d', { willReadFrequently: true }); x.imageSmoothingQuality = 'high'; x.drawImage(im, 0, 0, w, h); const d = x.getImageData(0, 0, w, h).data; const g = new Float32Array(w * h); for (let i = 0; i < w * h; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]; return g; },
  ncc(S, Sw, T, tw, th, X, Y) { let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = tw * th; for (let y = 0; y < th; y++) { const o = (Y + y) * Sw + X, p = y * tw; for (let x = 0; x < tw; x++) { const a = S[o + x], b = T[p + x]; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b; } } const va = saa - sa * sa / n, vb = sbb - sb * sb / n; return va > 1e-6 && vb > 1e-6 ? (sab - sa * sb / n) / Math.sqrt(va * vb) : -1; },
  // Where image C (cut from S and resized) sits in S: normalised cross-correlation, coarse then fine. Fractions of S.
  async locate(srcUrl, cropUrl, minF = 0.12) {
    const S = await this.load(srcUrl), C = await this.load(cropUrl);
    const cA = C.naturalHeight / C.naturalWidth;
    const search = (Sw, scales, cx, cy, rad) => { const s = this.grey(S, Sw); let best = { score: -2 };
      for (const f of scales) { const tw = Math.round(Sw * f), th = Math.round(tw * cA); if (tw < 8 || th < 8 || tw > s.w || th > s.h) continue; const T = this.greyWH(C, tw, th);
        const x0 = cx == null ? 0 : Math.max(0, Math.round(cx * Sw) - rad), x1 = cx == null ? s.w - tw : Math.min(s.w - tw, Math.round(cx * Sw) + rad);
        const y0 = cy == null ? 0 : Math.max(0, Math.round(cy * Sw) - rad), y1 = cy == null ? s.h - th : Math.min(s.h - th, Math.round(cy * Sw) + rad);
        for (let Y = y0; Y <= y1; Y++) for (let X = x0; X <= x1; X++) { const v = this.ncc(s.g, s.w, T, tw, th, X, Y); if (v > best.score) best = { score: v, x: X / Sw, y: Y / Sw, w: tw / Sw, f }; } }
      return best; };
    const coarse = []; for (let f = minF; f <= 1.0001; f += 0.01) coarse.push(f);
    let b = search(96, coarse);
    if (b.score < -1) return null;
    const fine = []; for (let f = b.f - 0.012; f <= b.f + 0.0121; f += 0.002) if (f > 0.05 && f <= 1.0001) fine.push(f);
    const b2 = search(384, fine, b.x, b.y, 8);
    const best = b2.score > b.score - 0.05 ? b2 : b;
    const sh = S.naturalHeight / S.naturalWidth;
    return { x: best.x, y: best.y / sh, w: best.w, h: best.w * cA / sh, score: best.score };
  },
  async subject(url) {
    const im = await this.load(url);
    let faces = [];
    try { if ('FaceDetector' in window) { const fd = new FaceDetector({ fastMode: false, maxDetectedFaces: 8 }); faces = (await fd.detect(im)).map((f) => f.boundingBox); } } catch {}
    if (faces.length) { const W = im.naturalWidth, H = im.naturalHeight; let x0 = 1e9, y0 = 1e9, x1 = 0, y1 = 0; for (const f of faces) { x0 = Math.min(x0, f.x - f.width * 0.2); y0 = Math.min(y0, f.y - f.height * 0.2); x1 = Math.max(x1, f.x + f.width * 1.2); y1 = Math.max(y1, f.y + f.height * 1.2); }
      x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(W, x1); y1 = Math.min(H, y1); return { box: [x0 / W, y0 / H, (x1 - x0) / W, (y1 - y0) / H], method: 'faces', faces: faces.length }; }
    const w = 160, h = Math.max(1, Math.round(w * im.naturalHeight / im.naturalWidth));
    const at = (cw) => { const ch = Math.max(1, Math.round(cw * h / w)); const a = document.createElement('canvas'); a.width = cw; a.height = ch; a.getContext('2d').drawImage(im, 0, 0, cw, ch); const b = document.createElement('canvas'); b.width = w; b.height = h; const bx = b.getContext('2d', { willReadFrequently: true }); bx.imageSmoothingQuality = 'high'; bx.drawImage(a, 0, 0, w, h); return bx.getImageData(0, 0, w, h).data; };
    const fine = at(40), coarse = at(8);
    const sal = new Float32Array(w * h); for (let i = 0; i < w * h; i++) { const r = fine[i * 4], g = fine[i * 4 + 1], b = fine[i * 4 + 2]; const chroma = (Math.max(r, g, b) - Math.min(r, g, b)) / 255; sal[i] = Math.hypot(r - coarse[i * 4], g - coarse[i * 4 + 1], b - coarse[i * 4 + 2]) * (0.25 + chroma) ** 1.5; }
    const sorted = [...sal].sort((a, b) => b - a), thr = sorted[Math.floor(sorted.length * 0.07)];
    const lab = new Int32Array(w * h).fill(-1), comps = [];
    for (let s = 0; s < w * h; s++) { if (sal[s] < thr || lab[s] >= 0) continue; const q = [s]; lab[s] = s; let n = 0, sum = 0, X0 = w, Y0 = h, X1 = 0, Y1 = 0;
      while (q.length) { const p = q.pop(), px = p % w, py = (p - px) / w; n++; sum += sal[p]; X0 = Math.min(X0, px); X1 = Math.max(X1, px); Y0 = Math.min(Y0, py); Y1 = Math.max(Y1, py);
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const nx = px + dx, ny = py + dy; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue; const k = ny * w + nx; if (sal[k] >= thr && lab[k] < 0) { lab[k] = s; q.push(k); } } }
      comps.push({ sum, X0, Y0, X1, Y1 }); }
    comps.sort((a, b) => b.sum - a.sum); let best = comps[0];
    if (!best) return null;
    best = { ...best }; for (let grew = true; grew;) { grew = false; for (const q of comps) { if (q === comps[0] || q.used || q.sum < comps[0].sum * 0.15) continue; const gap = Math.max(q.X0 - best.X1, best.X0 - q.X1, (q.Y0 - best.Y1) * w / h, (best.Y0 - q.Y1) * w / h); if (gap < w * 0.06) { best.X0 = Math.min(best.X0, q.X0); best.Y0 = Math.min(best.Y0, q.Y0); best.X1 = Math.max(best.X1, q.X1); best.Y1 = Math.max(best.Y1, q.Y1); q.used = true; grew = true; } } }
    const g = 0.03; const bx = Math.max(0, best.X0 / w - g), by = Math.max(0, best.Y0 / h - g); return { box: [bx, by, Math.min(1, (best.X1 + 1) / w + g) - bx, Math.min(1, (best.Y1 + 1) / h + g) - by], method: 'saliency' };
  },
  async thumb(url, max) { const im = await this.load(url); const k = Math.min(1, max / Math.max(im.naturalWidth, im.naturalHeight)); const c = document.createElement('canvas'); c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k); const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.imageSmoothingQuality = 'high'; x.drawImage(im, 0, 0, c.width, c.height); return c.toDataURL('image/jpeg', 0.9); },
  async contrasts(src, boxes) {
    const im = await this.load(src);
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
  },
};`;

// ---------- inputs ----------
function listImages(dir) {
  return readdirSync(dir).filter((f) => /\.(jpe?g|png|webp|gif)$/i.test(f) && !/sheet|^look|preview/i.test(f)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).map((f) => join(dir, f));
}
function readAlt(dir, files) {
  const alt = {}, subj = {}; let key = null;
  const match = (k) => { const s = String(k).trim().replace(/^[-*\s`"]+|[`"]+$/g, ''); return files.find((f) => f === s) || files.find((f) => f.replace(/\.\w+$/, '') === s.replace(/\.\w+$/, '')) || (/^\d+$/.test(s) ? files.find((f) => f.startsWith(s.padStart(2, '0'))) || files[+s - 1] : null); };
  const pj = join(dir, 'post.json');
  if (existsSync(pj)) { try { const j = JSON.parse(readFileSync(pj, 'utf8')); key = j.key || null; for (const im of j.images || []) { const f = match(im.file || ''); if (!f) continue; if (im.alt) alt[f] = String(im.alt); if (im.subject) subj[f] = Array.isArray(im.subject[0]) ? im.subject : [im.subject]; } } catch { /* ignore */ } }
  for (const name of ['alt.json']) { const p = join(dir, name); if (existsSync(p)) { try { const j = JSON.parse(readFileSync(p, 'utf8')); for (const [k, v] of Object.entries(j)) { const f = match(k); if (f && !alt[f]) alt[f] = String(typeof v === 'string' ? v : v.alt || ''); } } catch { /* ignore */ } } }
  for (const name of ['alt.txt', 'alt-text.txt', 'alt.md']) {
    const p = join(dir, name); if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split('\n')) { const m = line.match(/^\s*[-*]?\s*`?([^:\t|]+?)`?\s*(?::|\t|\||\s—\s|\s–\s|\s-\s)\s*(.+)$/); if (!m) continue; const f = match(m[1]); if (f && !alt[f]) alt[f] = m[2].trim(); }
  }
  return { alt, subj, key };
}
function readPostText(dir) {
  const p = ['post.md', 'posts.md', 'copy.md'].map((x) => join(dir, x)).find((x) => existsSync(x)); if (!p) return {};
  const out = {}; let cur = null;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const h = line.match(/^#{1,3}\s*(.+)$/);
    if (h) { const t = h[1].toLowerCase(); cur = /\bx\b|twitter/.test(t) ? 'x' : /bluesky|bsky/.test(t) ? 'bluesky' : /threads/.test(t) ? 'threads' : /facebook/.test(t) ? 'facebook' : /linkedin/.test(t) ? 'linkedin' : null; if (cur) out[cur] = ''; continue; }
    if (cur) out[cur] += line + '\n';
  }
  for (const k of Object.keys(out)) out[k] = out[k].replace(/^\s*```\w*\s*$/gm, '').trim();
  return out;
}
const graphemes = (s) => { try { return [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(s)].length; } catch { return [...s].length; } };
const xLength = (s) => { const t = s.replace(/https?:\/\/\S+/g, 'x'.repeat(23)); let n = 0; for (const ch of t) { const c = ch.codePointAt(0); n += (c <= 0x10ff || (c >= 0x2000 && c <= 0x200d) || (c >= 0x2010 && c <= 0x201f) || (c >= 0x2032 && c <= 0x2037)) ? 1 : 2; } return n; };
const words = (s) => (String(s).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []);
const STOP = new Set(['the', 'and', 'for', 'with', 'you', 'your', 'our', 'from', 'this', 'that', 'are', 'all', 'now', 'new']);

// ---------- the check ----------
export async function check(folder, { out = 'look/post', photos = null, subjects = null, handle = '@yourshop', name = null, plain = false, ocr = 'auto', useGiven = true } = {}) {
  // useGiven: false ignores subjects named in post.json (a grader with its own answer key)
  const dir = resolve(folder);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error('no such folder: ' + folder);
  const list = listImages(dir);
  if (!list.length) throw new Error('no images (JPG/PNG) in ' + folder);
  const files = list.map((f) => basename(f));
  const { alt, subj: subjGiven, key: keyGiven } = readAlt(dir, files);
  const postText = readPostText(dir);
  const key = keyGiven && files.includes(keyGiven) ? keyGiven : files[0];
  const issues = [], images = [];
  const tess = ocr !== 'never' && hasTesseract();
  const subjMap = subjects ? (typeof subjects === 'string' ? JSON.parse(readFileSync(subjects, 'utf8')) : subjects) : null;
  const photoList = photos ? readdirSync(resolve(photos)).filter((f) => /\.(jpe?g|png|webp)$/i.test(f) && (!subjMap || subjMap[f])).map((f) => join(resolve(photos), f)) : [];
  const views = [];
  const browser = await launch();
  let sheetPath = null;
  try {
    const page = await browser.newPage();
    const lab = await browser.newPage();
    await lab.setContent('<html><body></body></html>'); await lab.addScriptTag({ content: LAB });
    const toUrl = (f) => { const b = readFileSync(f), i = imageInfo(b); return `data:image/${i.format === 'png' ? 'png' : i.format === 'webp' ? 'webp' : i.format === 'gif' ? 'gif' : 'jpeg'};base64,${b.toString('base64')}`; };
    const photoUrls = photoList.map((f) => ({ f, name: basename(f), url: toUrl(f) }));
    for (const f of list) {
      const buf = readFileSync(f), info = imageInfo(buf), nm = basename(f);
      const im = { file: nm, format: info.format, w: info.w, h: info.h, bytes: buf.length, kb: Math.round(buf.length / 1024), alt: alt[nm] ?? null };
      images.push(im);
      if (!im.w || !im.h) { issues.push(issue('unreadable', 'error', `${nm}: couldn't read its size.`, 'Save it as JPG or PNG.', nm)); continue; }
      const url = toUrl(f);
      im.thumb = await lab.evaluate((u) => window.lab.thumb(u, 1400), url);
      im.aspect = im.w / im.h;
      // text
      const stem = nm.replace(/\.\w+$/, ''), src = readdirSync(dir).find((x) => /\.(html?|svg)$/i.test(x) && x.replace(/\.\w+$/, '') === stem);
      im.method = 'none'; im.boxes = [];
      if (src) { im.boxes = await measureSource(page, join(dir, src), { w: im.w, h: im.h }); im.method = 'source'; im.source = src; }
      if (tess && (ocr === 'always' || im.method === 'none')) { const b = ocrBoxes(f); if (im.method === 'none') { im.method = 'ocr'; im.boxes = b; } else im.ocr = b; }
      for (const set of [im.boxes, im.ocr || []]) { if (!set.length) continue; const r = await lab.evaluate((u, bs) => window.lab.contrasts(u, bs), url, set.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h, color: b.color, extra: b.extra }))); set.forEach((b, i) => { b.contrast = r[i] == null ? null : round(r[i], 2); }); }
      // subjects
      im.subjects = [];
      if (useGiven && subjGiven[nm]) im.subjects = subjGiven[nm].map((b) => ({ box: b, method: 'given' }));
      else if (photoUrls.length && subjMap) {
        // a crop of one original (forward match ≥ 0.9), else every original placed whole inside it (a collage: reverse ≥ 0.9)
        const fwd = [], rev = [];
        for (const p of photoUrls) {
          const f1 = await lab.evaluate((s, c) => window.lab.locate(s, c), p.url, url); if (f1) fwd.push({ ...f1, photo: p.name });
          const r1 = await lab.evaluate((s, c) => window.lab.locate(s, c, 0.25), url, p.url); if (r1) rev.push({ ...r1, photo: p.name });
        }
        const bf = fwd.sort((a, b) => b.score - a.score)[0];
        const found = bf && bf.score >= 0.9 ? [{ ...bf, dir: 'in-photo' }] : rev.filter((r) => r.score >= 0.9).map((r) => ({ ...r, dir: 'photo-in-image' }));
        if (found.length) {
          im.located = found.length === 1 ? { photo: found[0].photo, how: found[0].dir, score: round(found[0].score, 3), at: [found[0].x, found[0].y, found[0].w, found[0].h].map((v) => round(v, 3)) } : { photo: found.map((x) => x.photo).join(' + '), how: 'collage', score: Math.min(...found.map((x) => round(x.score, 3))), panels: found.map((x) => ({ photo: x.photo, at: [x.x, x.y, x.w, x.h].map((v) => round(v, 3)) })) };
          for (const best of found) for (const b of subjMap[best.photo] || []) {
            let x0, y0, x1, y1;
            if (best.dir === 'in-photo') { x0 = (b[0] - best.x) / best.w; y0 = (b[1] - best.y) / best.h; x1 = (b[0] + b[2] - best.x) / best.w; y1 = (b[1] + b[3] - best.y) / best.h; }
            else { x0 = best.x + b[0] * best.w; y0 = best.y + b[1] * best.h; x1 = best.x + (b[0] + b[2]) * best.w; y1 = best.y + (b[1] + b[3]) * best.h; }
            // the part already cut away when the image was made counts as cut: keep the full box, fractions may run past 0–1
            im.subjects.push({ box: [round(x0, 4), round(y0, 4), round(x1 - x0, 4), round(y1 - y0, 4)], method: 'from-photo', photo: best.photo });
          }
        }
      }
      if (!im.subjects.length && !im.located) { const e = await lab.evaluate((u) => window.lab.subject(u), url); if (e) im.subjects.push({ box: e.box.map((v) => round(v, 4)), method: e.method === 'faces' ? "Palm's estimate (faces found by Chrome)" : "Palm's estimate (most colourful, contrasting region)" }); }
      // the files each app takes
      for (const [a, A] of Object.entries(APPS)) {
        if (A.maxBytes && im.bytes > A.maxBytes) issues.push(issue(`file-size-${a}`, 'error', `${nm} is ${round(im.bytes / 1e6, 2)} MB: ${A.name} takes up to ${A.maxBytes / 1e6} MB per image.`, 'Save it as a JPG at quality ~85, or smaller (2048 px on the long side is plenty).', nm));
        if (!A.formats.includes(im.format)) issues.push(issue(`format-${a}`, 'warn', `${nm} is ${String(im.format).toUpperCase()}: ${A.name} takes ${A.formats.map((x) => x.toUpperCase()).join(', ')}.`, 'Save it as JPG (photos) or PNG (graphics).', nm));
      }
      if (im.w * im.h >= 36152320) issues.push(issue('pixels-linkedin', 'error', `${nm} is ${im.w}×${im.h}: LinkedIn takes images under 36,152,320 pixels.`, 'Make it smaller.', nm));
      if (im.w < 552 || im.h < 276) issues.push(issue('small-linkedin', 'warn', `${nm} is ${im.w}×${im.h}: LinkedIn asks for at least 552×276 (and recommends 1080 wide).`, 'Make it at least 1080 px wide.', nm));
      else if (Math.max(im.w, im.h) < 1080) issues.push(issue('low-res', 'warn', `${nm} is ${im.w}×${im.h}: under 1080 px it looks soft when opened (Palm's guidance; LinkedIn recommends 1080 wide).`, 'Make it at least 1080 px on the long side.', nm));
      // alt text
      const A = im.alt;
      if (!A || !A.trim()) issues.push(issue('alt-missing', 'error', `${nm} has no alt text. Every app here takes alt text per image (Bluesky's post record requires it); without it a screen reader says only "image".`, 'Write one or two sentences per image in alt.txt ("<file>: <alt text>"): what it shows and why it is in the post, and any words printed on it.', nm));
      else {
        if (/^(image|photo|picture|img|graphic)\s*\d*\.?$/i.test(A.trim()) || A.trim() === nm || A.trim().length < 15) issues.push(issue('alt-thin', 'warn', `${nm}: the alt text "${A.trim()}" doesn't describe the image.`, 'Say what it shows and why it is in the post.', nm));
        if (A.length > 1000) issues.push(issue('alt-long-x', 'error', `${nm}: alt text is ${A.length} characters; X takes up to 1,000.`, 'Shorten it; put the rest in the post.', nm));
        else if (A.length > 300) issues.push(issue('alt-long', 'note', `${nm}: alt text is ${A.length} characters (LinkedIn recommends under 120; long alt text is a lot to listen to).`, '', nm));
      }
    }
    const n = images.length;
    // the post's counts
    for (const [a, A] of Object.entries(APPS)) if (A.max && n > A.max) issues.push(issue(`count-${a}`, 'error', `${n} images: ${A.name} takes up to ${A.max} per post${a === 'bluesky' ? ' (its newer gallery takes up to 10, but not every Bluesky app shows it yet)' : ''}, so ${n - A.max} would be left out there (the tool shows the first ${A.max}).`, `Use 4 images or fewer everywhere, or make a separate set of 4 for ${A.name}.`));
    if (n === 1) issues.push(issue('single', 'note', 'One image: this is a single-image post, not a grid; each app shows it larger and less cropped.', ''));
    // text in the image should be in the alt text
    for (const im of images) {
      if (!im.alt || !im.boxes?.length) continue;
      const big = im.boxes.filter((b) => b.fs >= Math.max(...im.boxes.map((x) => x.fs)) * 0.35);
      const need = [...new Set(big.flatMap((b) => words(b.t)).filter((w) => !STOP.has(w)))];
      const have = new Set(words(im.alt));
      const miss = need.filter((w) => !have.has(w) && !have.has(w.replace(/s$/, '')));
      if (need.length >= 3 && miss.length / need.length > 0.5) issues.push(issue('alt-misses-text', 'warn', `${im.file}: the words printed on it aren't in its alt text (missing ${miss.slice(0, 8).map((w) => `"${w}"`).join(', ')})${im.method === 'ocr' ? " (words read by OCR: Palm's estimate)" : ''}.`, 'Put the words the image shows (the headline, date, time, place) into its alt text.', im.file));
    }
    // ---------- every app × phone/desktop ----------
    const per = {};   // per image: worst values across views
    const flag = (file, id, view, data) => { ((per[file] ??= {})[id] ??= []).push({ view, ...data }); };
    for (const dev of ['phone', 'desktop']) for (const a of Object.keys(APPS)) {
      const shown = images.filter((im) => im.w).slice(0, APPS[a].max || 99);
      const L = layout(a, shown.map((im) => im.aspect), WIDTH[dev][a]);
      const view = `${APPS[a].name} ${dev}`;
      const v = { app: a, device: dev, W: L.W, H: L.H, tiles: [] };
      const vis = L.tiles.filter((t) => !t.hidden && !t.off && t.w > 0);
      const biggest = vis.reduce((m, t) => (t.w * t.h > m.w * m.h ? t : m), vis[0]);
      const sizes = vis.map((t) => t.w * t.h), uneven = Math.max(...sizes) > 1.3 * Math.min(...sizes);
      v.big = uneven && a !== 'threads' ? shown[biggest.i].file : null;   // Threads is a carousel: no big tile
      for (const t of L.tiles) {
        const im = shown[t.i];
        const rec = { file: im.file, tile: [round(t.x), round(t.y), round(t.w), round(t.h)] };
        if (t.hidden) { rec.hidden = true; v.tiles.push(rec); flag(im.file, 'hidden', view, {}); continue; }
        if (t.off) { rec.off = true; v.tiles.push(rec); flag(im.file, 'offscreen', view, {}); continue; }
        if (t.plus) rec.plus = t.plus;
        const c = cropOf(im.w, im.h, t.w, t.h);
        rec.crop = [round(c.x0, 3), round(c.y0, 3), round(c.x1, 3), round(c.y1, 3)]; rec.shown = round((c.x1 - c.x0) * (c.y1 - c.y0), 3); rec.scale = round(c.s, 4);
        const C = { x0: c.x0 * im.w, y0: c.y0 * im.h, x1: c.x1 * im.w, y1: c.y1 * im.h };
        // text lines
        const allBoxes = im.boxes || [];
        rec.text = allBoxes.map((b) => ({ t: b.t, px: round(b.fs * c.s), inside: round(Math.min(...b.lines.map((l) => areaIn({ x0: l.x, y0: l.y, x1: l.x + l.w, y1: l.y + l.h }, C))), 2) }));
        if (rec.text.length) { rec.smallest_px = Math.min(...rec.text.map((x) => x.px)); rec.largest_px = Math.max(...rec.text.map((x) => x.px)); }
        const head = allBoxes.length ? allBoxes.reduce((m, b) => (b.fs > m.fs ? b : m)) : null;
        for (const [k, b] of allBoxes.entries()) { const x = rec.text[k]; if (x.inside < KEEP) flag(im.file, 'text-cut', view, { t: b.t, inside: x.inside, head: b === head }); }
        if (dev === 'phone' && rec.text.length && !t.plus) {
          for (const x of rec.text) if (x.px < MIN_FS && x.inside >= 0.5) flag(im.file, 'text-small', view, { t: x.t, px: x.px });
          if (head && head.fs * c.s < HEAD_FS) flag(im.file, 'head-small', view, { t: head.t, px: round(head.fs * c.s) });
        }
        // subjects
        rec.subjects = (im.subjects || []).map((s) => { const [x, y, w, h] = s.box; const B = { x0: x, y0: y, x1: x + w, y1: y + h }; const kept = areaIn(B, c); const vw = Math.max(0, Math.min(B.x1, c.x1) - Math.max(B.x0, c.x0)) * im.w * c.s, vh = Math.max(0, Math.min(B.y1, c.y1) - Math.max(B.y0, c.y0)) * im.h * c.s; return { kept: round(kept, 3), px: Math.round(Math.min(vw, vh)), method: s.method }; });
        for (const s of rec.subjects) { if (s.kept < KEEP) flag(im.file, 'subject-cut', view, { kept: s.kept, method: s.method }); else if (dev === 'phone' && s.px < SUBJ_PX && !t.plus) flag(im.file, 'subject-small', view, { px: s.px, method: s.method }); }
        if (rec.shown < MIN_SHOWN) flag(im.file, 'crop-heavy', view, { shown: rec.shown });
        v.tiles.push(rec);
      }
      if (a === 'threads') v.visible_without_swiping = v.tiles.filter((x) => !x.off).length;
      views.push(v);
    }
    // ---------- issues per image ----------
    const where = (arr) => [...new Set(arr.map((x) => x.view))].join(', ');
    for (const im of images) {
      const p = per[im.file] || {}, nm = im.file;
      const est = im.method === 'ocr' ? " (text read by OCR: Palm's estimate)" : '';
      if (p['text-cut']) {
        const heads = p['text-cut'].filter((x) => x.head), worst = p['text-cut'].reduce((m, x) => (x.inside < m.inside ? x : m));
        issues.push(issue('text-cut', heads.length ? 'error' : 'warn', `${nm}: words cut off by the tile's crop${est}: "${worst.t}" (only ${pct(worst.inside)} shows) in ${where(p['text-cut'])}.`, "Keep every word in the image's middle area that all the tiles show (see the dashed crops on the sheet), or give the words their own image shaped like its tile.", nm));
      }
      if (p['subject-cut']) {
        const given = p['subject-cut'].some((x) => x.method === 'given' || x.method === 'from-photo'), worst = p['subject-cut'].reduce((m, x) => (x.kept < m.kept ? x : m));
        issues.push(issue('subject-cut', given ? 'error' : 'warn', `${nm}: the subject${given ? '' : ' (' + worst.method + ')'} is cut by the tile's crop: only ${pct(worst.kept)} of it shows in ${where(p['subject-cut'])}.`, 'Crop the image yourself so the subject sits in the middle with room around it (a square or 4:5 crop survives most tiles), or put it in a place in the order where its tile has its shape.', nm));
      }
      if (p['text-small']) { const w = p['text-small'].reduce((m, x) => (x.px < m.px ? x : m)); issues.push(issue('text-small', 'warn', `${nm}: words too small to read in the timeline on a phone${est}: "${w.t}" shows at ${w.px} px in ${w.view} (in ${where(p['text-small'])}). Palm's guidance: ${MIN_FS} px or more there; people decide from the grid, not after opening it.`, 'Fewer words, much bigger; put the details in the post text and the alt text.', nm)); }
      if (p['head-small']) { const w = p['head-small'].reduce((m, x) => (x.px < m.px ? x : m)); issues.push(issue('head-small', 'warn', `${nm}: its biggest words ("${w.t}") show at ${w.px} px in ${w.view}${est}: they won't read at a glance (Palm's guidance: ${HEAD_FS} px or more).`, 'Make the headline much bigger, or cut words.', nm)); }
      if (p['subject-small']) { const w = p['subject-small'].reduce((m, x) => (x.px < m.px ? x : m)); issues.push(issue('subject-small', 'warn', `${nm}: the subject is only ${w.px} px across in ${w.view}${w.method === 'given' || w.method === 'from-photo' ? '' : ' (' + w.method + ')'}: too small to make out in the timeline (Palm's guidance: ${SUBJ_PX} px).`, 'Crop in closer, or put it first, where the tile is biggest.', nm)); }
      if (p['crop-heavy']) { const w = p['crop-heavy'].reduce((m, x) => (x.shown < m.shown ? x : m)); issues.push(issue('crop-heavy', 'warn', `${nm}: its tile shows only ${pct(w.shown)} of it in ${w.view} (under 40% in ${where(p['crop-heavy'])}): its shape is far from the tile's.`, 'Crop it yourself to a shape near its tiles (square or 4:5 for most places in the grid), choosing what stays.', nm)); }
      if (p.hidden) issues.push(issue('behind-more', images.findIndex((x) => x.file === nm) < 5 ? 'warn' : 'note', `${nm} isn't in the grid in ${where(p.hidden)}: it's behind "+N" until someone opens the album.`, 'Put anything that matters in the first four images.', nm));
      if (p.offscreen) issues.push(issue('off-screen', 'note', `${nm} is off-screen in ${where(p.offscreen)} until people swipe the carousel.`, 'Put the image that matters first.', nm));
      const low = (im.boxes || []).filter((b) => b.contrast != null && b.contrast < MIN_CONTRAST && b.fs * 0.3 >= 3);
      if (low.length) issues.push(issue('low-contrast', 'warn', `${nm}: words with low contrast against what's behind them${est}: ${low.slice(0, 3).map((b) => `"${b.t}" ${b.contrast}:1`).join('; ')}.`, `Aim for ${MIN_CONTRAST}:1 or more: a solid band behind the words, or a darker/lighter backdrop.`, nm));
      if (im.method === 'none') issues.push(issue('not-measured', 'note', `${nm}: no HTML/SVG source beside it and no Tesseract, so its text wasn't measured: judge it on the sheet.`, 'Keep the HTML/SVG you made it from beside it (same name).', nm));
      if (!im.subjects?.length && im.located) issues.push(issue('no-subject-marked', 'note', `${nm} is a crop of ${im.located.photo}, which has no subject marked.`, '', nm));
      if (im.subjects?.length && !['given', 'from-photo'].includes(im.subjects[0].method)) issues.push(issue('subject-estimated', 'note', `${nm}: no subject given, so it is ${im.subjects[0].method}: x ${pct(im.subjects[0].box[0])}, y ${pct(im.subjects[0].box[1])}, ${pct(im.subjects[0].box[2])} × ${pct(im.subjects[0].box[3])}. Check it on the sheet.`, 'Give the subject in post.json (images[].subject = [x,y,w,h], fractions of the image).', nm));
    }
    // the key image in the big tile
    const keyIdx = files.indexOf(key);
    const bigViews = views.filter((v) => v.big);
    const notKey = bigViews.filter((v) => v.big !== key);
    if (notKey.length) issues.push(issue('key-not-big', 'warn', `The key image (${key}) isn't in the biggest tile in ${[...new Set(notKey.map((v) => APPS[v.app].name + ' ' + v.device))].join(', ')}: ${notKey[0].big} is. Every app gives the first image the most room.`, `Attach ${key} first${keyGiven ? '' : " (or name your key image in post.json: {\"key\": \"…\"})"}.`));
    if (keyIdx > 0) issues.push(issue('key-not-first', 'warn', `The key image (${key}) is number ${keyIdx + 1}: Threads shows the first one or two without swiping, and LinkedIn and Facebook build the layout around the first.`, `Attach ${key} first.`));
    // the order each app reads (row by row) and what shows without opening
    const orderOf = (v) => v.tiles.filter((t) => !t.hidden && !t.off).map((t) => ({ f: t.file, x: t.tile[0], y: t.tile[1] })).sort((p, q) => (Math.abs(p.y - q.y) < 4 ? p.x - q.x : p.y - q.y)).map((t) => t.f);
    for (const v of views) { v.order = orderOf(v); v.in_order = v.order.every((f, i) => f === files[i]); v.hidden = v.tiles.filter((t) => t.hidden || t.off).map((t) => t.file); }
    const shuffled = views.filter((v) => !v.in_order);
    if (shuffled.length) issues.push(issue('order', 'note', `Read row by row, the grid changes the order in ${shuffled.map((v) => `${APPS[v.app].name} ${v.device} (${v.order.join(', ')})`).join('; ')}.`, 'If the images tell a sequence (before → after, step 1 → 2), check it still reads that way there.'));
    // the first image's shape decides LinkedIn's and Facebook's layout
    if (n >= 3 && images[0].aspect) issues.push(issue('first-shape', 'note', `The first image is ${images[0].aspect > 4 / 3 ? 'landscape (wider than 4:3): LinkedIn puts it on top, the others in a row below' : 'portrait or square: LinkedIn puts it in a left column, the others stacked to its right'} (LinkedIn Help); Facebook does much the same (Palm's approximation).`, ''));
    // post text
    for (const [a, txt] of Object.entries(postText)) {
      const A = APPS[a]; if (!A?.text || !txt) continue;
      const len = a === 'x' ? xLength(txt) : a === 'bluesky' ? graphemes(txt) : [...txt].length;
      if (len > A.text) issues.push(issue(`text-long-${a}`, 'error', `The ${A.name} post is ${len} ${a === 'bluesky' ? 'graphemes' : 'characters'}${a === 'x' ? ' (weighted, links count 23)' : ''}: ${A.name} takes up to ${A.text}.`, 'Shorten it.'));
    }
    // ---------- the sheet ----------
    const sheet = drawSheet({ images, views, files, postText, handle, name: name || handle.replace(/^@/, '').replace(/[._-]+/g, ' '), plain });
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(resolve(out) + '-sheet.html', sheet);
    await page.setViewport({ width: 2200, height: 1000, deviceScaleFactor: 1 });
    await page.setContent(sheet, { waitUntil: 'load' });
    await page.evaluate(() => Promise.all([...document.images].map((i) => i.complete ? 0 : new Promise((r) => (i.onload = i.onerror = r)))));
    sheetPath = resolve(out) + '-sheet.png';
    await page.screenshot({ path: sheetPath, fullPage: true });
  } finally { await browser.close(); }
  const errors = issues.filter((i) => i.level === 'error').length, warnings = issues.filter((i) => i.level === 'warn').length;
  const slim = (b) => ({ t: b.t, font_px: Math.round(b.fs), contrast: b.contrast });
  return {
    ok: errors === 0, errors, warnings, count: images.length, key,
    images: images.map((im) => ({ file: im.file, w: im.w, h: im.h, format: im.format, kb: im.kb, alt: im.alt, method: im.method, source: im.source, located: im.located, subjects: im.subjects, lines: (im.boxes || []).map(slim), ...(im.ocr ? { ocr: im.ocr.map(slim) } : {}) })),
    views: views.map((v) => ({ app: v.app, device: v.device, box: [v.W, v.H], big: v.big, order: v.order, hidden: v.hidden, tiles: v.tiles.map(({ text, ...t }) => t) })),
    issues, sheet: sheetPath, approximations: "Palm's approximation of X's, Facebook's and Threads' layouts and of the column widths, Nov 2026 (see the tool's header); Bluesky's grid is from its open-source app, LinkedIn's from LinkedIn Help",
  };
}

// ---------- the sheet ----------
const THEME = {
  x: (d) => d ? { bg: '#000', fg: '#e7e9ea', sub: '#71767b', line: '#2f3336', accent: '#1d9bf0' } : { bg: '#fff', fg: '#0f1419', sub: '#536471', line: '#eff3f4', accent: '#1d9bf0' },
  bluesky: (d) => d ? { bg: '#151d28', fg: '#f1f3f5', sub: '#8c9ab0', line: '#2e3b4d', accent: '#1083fe' } : { bg: '#fff', fg: '#0b0f14', sub: '#6a7d94', line: '#e2e7ee', accent: '#1083fe' },
  threads: (d) => d ? { bg: '#101010', fg: '#f3f5f7', sub: '#777', line: '#323232', accent: '#f3f5f7' } : { bg: '#fff', fg: '#000', sub: '#999', line: '#e5e5e5', accent: '#000' },
  facebook: (d) => d ? { bg: '#18191a', card: '#242526', fg: '#e4e6eb', sub: '#b0b3b8', line: '#3e4042', accent: '#2d88ff' } : { bg: '#f0f2f5', card: '#fff', fg: '#050505', sub: '#65676b', line: '#ced0d4', accent: '#0866ff' },
  linkedin: (d) => d ? { bg: '#000', card: '#1b1f23', fg: '#e9e9e9', sub: '#a0a0a0', line: '#38434f', accent: '#71b7fb' } : { bg: '#f4f2ee', card: '#fff', fg: '#191919', sub: '#666', line: '#e8e8e8', accent: '#0a66c2' },
};
const STANDIN = ['Coffee machine finally fixed. Small wins.', 'Anyone know a good plumber near the station?', 'Our Thursday quiz is back next week, same time.', 'Rain all day. Perfect soup weather.'];
const avatar = (s, hue = 30, sq = false) => `<div style="width:${s}px;height:${s}px;border-radius:${sq ? '4px' : '50%'};flex:none;background:linear-gradient(135deg,hsl(${hue} 45% 62%),hsl(${hue + 40} 40% 38%))"></div>`;

export function drawSheet({ images, views, files, postText, handle, name, plain }) {
  const byFile = Object.fromEntries(images.map((im) => [im.file, im]));
  const tileHtml = (t, radius) => {
    if (t.hidden || !t.tile || t.tile[2] <= 0) return '';
    const im = byFile[t.file]; const [x, y, w, h] = t.tile;
    return `<div style="position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;overflow:hidden;background:#888;${radius || ''}"><img src="${im.thumb}" style="width:100%;height:100%;object-fit:cover;object-position:center;display:block">${t.plus ? `<div style="position:absolute;inset:0;background:rgba(0,0,0,.45);color:#fff;display:flex;align-items:center;justify-content:center;font:600 ${Math.round(Math.min(w, h) / 3)}px system-ui">+${t.plus}</div>` : ''}</div>`;
  };
  const media = (v, radius, border) => `<div style="position:relative;width:${v.W}px;height:${v.H}px;overflow:hidden;${radius ? `border-radius:${radius}px;` : ''}${border ? `border:1px solid ${border};` : ''}">${v.tiles.map((t) => tileHtml(t)).join('')}</div>`;
  const text = (a) => postText[a] || postText.x || postText.bluesky || postText.linkedin || postText.facebook || postText.threads || `${name} has news: a post with ${images.length} images.`;
  const para = (s, clamp, more) => `<div style="white-space:pre-wrap;${clamp ? `display:-webkit-box;-webkit-line-clamp:${clamp};-webkit-box-orient:vertical;overflow:hidden;` : ''}">${esc(s)}</div>${more || ''}`;
  const icons = (list, col) => `<div style="display:flex;justify-content:space-between;color:${col};font:13px system-ui;padding-top:8px">${list.map((x) => `<span>${x}</span>`).join('')}</div>`;
  const standinPost = (a, th, i) => {
    const s = STANDIN[i % STANDIN.length];
    if (a === 'facebook' || a === 'linkedin') return `<div style="background:${th.card};margin:8px 0;padding:12px 14px;border-radius:${a === 'linkedin' ? 8 : 0}px"><div style="display:flex;gap:8px;align-items:center">${avatar(36, 200 + i * 60, a === 'linkedin')}<div><div style="font:600 14px system-ui">Someone ${i + 1}</div><div style="font:12px system-ui;color:${th.sub}">3h</div></div></div><div style="font:14px/19px system-ui;margin-top:8px">${s}</div></div>`;
    return `<div style="display:flex;gap:10px;padding:12px 14px;border-bottom:1px solid ${th.line}">${avatar(a === 'threads' ? 36 : 40, 200 + i * 60)}<div style="flex:1"><div style="font:700 14px system-ui">Someone ${i + 1} <span style="font-weight:400;color:${th.sub}">@someone${i + 1} · 3h</span></div><div style="font:14px/19px system-ui">${s}</div></div></div>`;
  };
  const post = (v, dark) => {
    const a = v.app, th = THEME[a](dark), W = v.W;
    const nm = esc(name), hd = esc(handle.startsWith('@') ? handle : '@' + handle);
    let body;
    if (a === 'x') body = `<div style="display:flex;gap:10px;padding:12px 14px;border-bottom:1px solid ${th.line}">${avatar(40)}<div style="width:${W}px"><div style="font:700 15px system-ui">${nm} <span style="font-weight:400;color:${th.sub}">${hd} · 2h</span></div><div style="font:15px/20px system-ui;margin:2px 0 10px">${para(text('x'))}</div>${media(v, 16, th.line)}${icons(['💬 4', '⟲ 12', '♡ 48', '▥ 2.1K', '⤴'], th.sub)}</div></div>`;
    else if (a === 'bluesky') body = `<div style="display:flex;gap:10px;padding:12px 14px;border-bottom:1px solid ${th.line}">${avatar(42)}<div style="width:${W}px"><div style="font:700 15px system-ui">${nm} <span style="font-weight:400;color:${th.sub}">${hd} · 2h</span></div><div style="font:15px/20px system-ui;margin:2px 0 10px">${para(text('bluesky'))}</div>${media(v, 8)}${icons(['💬 4', '⟲ 9', '♡ 41', '⋯'], th.sub)}</div></div>`;
    else if (a === 'threads') body = `<div style="padding:12px 14px;border-bottom:1px solid ${th.line}"><div style="display:flex;gap:10px">${avatar(36)}<div style="flex:1;min-width:0"><div style="font:600 15px system-ui">${esc(handle.replace(/^@/, ''))} <span style="font-weight:400;color:${th.sub}">2h</span></div><div style="font:15px/21px system-ui;margin:2px 0 10px">${para(text('threads'))}</div><div style="position:relative;width:${W}px;height:${v.H}px;overflow:hidden">${v.tiles.filter((t) => t.tile && t.tile[2] > 0).map((t) => tileHtml({ ...t, tile: t.tile }, 'border-radius:8px;')).join('')}</div>${icons(['♡ 37', '💬 5', '⟲ 3', '➤'], th.sub)}</div></div></div>`;
    else if (a === 'facebook') body = `<div style="background:${th.card};margin:8px 0"><div style="display:flex;gap:8px;align-items:center;padding:12px 14px">${avatar(40, 30)}<div><div style="font:600 15px system-ui">${nm}</div><div style="font:12px system-ui;color:${th.sub}">2h · 🌐</div></div></div><div style="font:15px/20px system-ui;padding:0 14px 10px">${para(text('facebook'), 5, `<span style="color:${th.sub};font-weight:600">See more</span>`)}</div>${media(v)}<div style="padding:4px 14px 10px">${icons(['👍❤️ 86', '12 comments', '4 shares'], th.sub)}<div style="border-top:1px solid ${th.line};margin-top:8px;padding-top:6px;display:flex;justify-content:space-around;color:${th.sub};font:600 14px system-ui"><span>👍 Like</span><span>💬 Comment</span><span>↪ Share</span></div></div></div>`;
    else body = `<div style="background:${th.card};margin:8px 0;border-radius:${W > 400 ? 8 : 0}px;overflow:hidden"><div style="display:flex;gap:8px;align-items:center;padding:12px 14px">${avatar(48, 30, true)}<div><div style="font:600 14px system-ui">${nm}</div><div style="font:12px system-ui;color:${th.sub}">1,204 followers<br>2h · 🌐</div></div></div><div style="font:14px/20px system-ui;padding:0 14px 10px">${para(text('linkedin'), 3, `<span style="color:${th.sub}">…more</span>`)}</div>${media(v)}<div style="padding:4px 14px 10px">${icons(['👍💡 57', '9 comments · 3 reposts'], th.sub)}<div style="border-top:1px solid ${th.line};margin-top:8px;padding-top:6px;display:flex;justify-content:space-around;color:${th.sub};font:600 13px system-ui"><span>👍 Like</span><span>💬 Comment</span><span>⟲ Repost</span><span>➤ Send</span></div></div></div>`;
    const outer = v.device === 'phone' ? 390 : W + (a === 'facebook' || a === 'linkedin' ? 0 : a === 'threads' ? 78 : 82);
    return `<div style="width:${outer}px;background:${th.bg};color:${th.fg};flex:none;overflow:hidden">${standinPost(a, th, 0)}${body}${standinPost(a, th, 1)}</div>`;
  };
  const fig = (inner, label) => `<figure style="margin:0;flex:none"><div style="border-radius:10px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.25)">${inner}</div><figcaption>${esc(label)}</figcaption></figure>`;
  const order = ['x', 'bluesky', 'threads', 'facebook', 'linkedin'];
  const secs = order.map((a) => {
    const ph = views.find((v) => v.app === a && v.device === 'phone'), dk = views.find((v) => v.app === a && v.device === 'desktop');
    const label = { x: 'X (Palm\'s approximation of its grid)', bluesky: 'Bluesky (grid from its open-source app)', threads: 'Threads (Palm\'s approximation of its carousel; swipe for the rest)', facebook: 'Facebook (Palm\'s approximation of its layout)', linkedin: 'LinkedIn (layout from LinkedIn Help)' }[a];
    return `<div class="sec"><h2>${label}: phone (light, dark) and desktop (light, dark)</h2><div class="row">${fig(post(ph, false), 'phone, light')}${fig(post(ph, true), 'phone, dark')}${fig(post(dk, false), 'desktop, light')}${fig(post(dk, true), 'desktop, dark')}</div></div>`;
  }).join('');
  // the images at full size: plain for the judge; with every phone crop, the text boxes and the subjects for the agent
  const fw = 330;
  const COL = { x: '#1d9bf0', bluesky: '#0bd', threads: '#e0e', facebook: '#f80', linkedin: '#0c4' };
  const full = (im) => {
    if (!im.w) return '';
    const k = fw / Math.max(im.w, im.h) * Math.max(1, im.w / im.h), ww = Math.round(im.w * k), hh = Math.round(im.h * k);
    let marks = '';
    if (!plain) {
      for (const v of views.filter((x) => x.device === 'phone')) for (const t of v.tiles.filter((x) => x.file === im.file && x.crop)) { const [x0, y0, x1, y1] = t.crop; marks += `<div style="position:absolute;left:${x0 * ww}px;top:${y0 * hh}px;width:${(x1 - x0) * ww}px;height:${(y1 - y0) * hh}px;border:2px dashed ${COL[v.app]};box-sizing:border-box"></div>`; }
      for (const s of im.subjects || []) { const [x, y, w, h] = s.box; marks += `<div style="position:absolute;left:${x * ww}px;top:${y * hh}px;width:${w * ww}px;height:${h * hh}px;border:3px dotted #fff;outline:2px dotted #000;box-sizing:border-box"></div>`; }
      for (const b of im.boxes || []) marks += `<div style="position:absolute;left:${b.x / im.w * ww}px;top:${b.y / im.h * hh}px;width:${b.w / im.w * ww}px;height:${b.h / im.h * hh}px;border:1.5px solid #f33;box-sizing:border-box"></div>`;
    }
    return `<figure style="margin:0;flex:none"><div style="position:relative;width:${ww}px;height:${hh}px;overflow:hidden;background:#ccc"><img src="${im.thumb}" style="width:100%;height:100%;display:block">${marks}</div><figcaption style="max-width:${Math.max(ww, 330)}px">${esc(im.file)} · ${im.w}×${im.h} · alt text: ${im.alt ? esc(im.alt) : plain ? 'none' : '<b style="color:#c00">none</b>'}</figcaption></figure>`;
  };
  // other counts (agent's sheet only): the first 2, 3 and 4 images in each app on a phone
  let counts = '';
  if (!plain && images.length >= 2) {
    const rows = [2, 3, 4, 5].filter((k) => k <= images.length || k === images.length).map((k) => { const set = images.filter((im) => im.w).slice(0, k); return `<div class="row" style="align-items:flex-start"><div style="width:60px;font:600 13px system-ui">first ${k}</div>${order.map((a) => { const L = layout(a, set.slice(0, APPS[a].max || 99).map((im) => im.aspect), WIDTH.phone[a]); const v = { W: L.W, H: L.H, tiles: L.tiles.map((t) => ({ file: set[t.i].file, tile: [t.x, t.y, t.w, t.h], plus: t.plus, hidden: t.hidden || t.off })) }; return `<figure style="margin:0;flex:none;transform:scale(.6);transform-origin:0 0;width:${Math.round(v.W * 0.6)}px;height:${Math.round(v.H * 0.6) + 18}px"><div style="position:relative;width:${v.W}px;height:${v.H}px;overflow:hidden;background:#fff">${v.tiles.map((t) => tileHtml(t)).join('')}</div><figcaption style="font-size:18px">${APPS[a].name}</figcaption></figure>`; }).join('')}</div>`; }).join('');
    counts = `<div class="sec"><h2>If you posted only the first 2, 3 or 4 (phone)</h2>${rows}</div>`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;width:2200px;background:#ecebe8;font-family:system-ui,sans-serif}.sec{padding:14px 20px}.row{display:flex;gap:18px;flex-wrap:wrap;align-items:flex-start}h2{font:600 15px system-ui;margin:0 0 10px;color:#333}figcaption{font:500 12px system-ui;color:#555;margin-top:4px;max-width:600px}</style></head><body>
<div class="sec" style="background:#222"><h2 style="color:#eee;font-size:16px">A post with ${images.length} image${images.length === 1 ? '' : 's'}, attached in this order: ${images.map((im) => esc(im.file)).join(', ')}. In each app's timeline among other posts (stand-ins). Layout mock-ups are Palm's approximation (Nov 2026) except where named.</h2></div>
${secs}
<div class="sec"><h2>The images at full size, with their alt text${plain ? '' : ': dashed = the part each app shows on a phone (blue X, cyan Bluesky, pink Threads, orange Facebook, green LinkedIn); white dots = the subject; red boxes = measured words'}</h2><div class="row">${images.map(full).join('')}</div></div>
${counts}
</body></html>`;
}

// ---------- render HTML to an image ----------
export async function render(file, { out, size = '1080x1080', quality = 90 } = {}) {
  const [w, h] = String(size).split('x').map(Number);
  if (!w || !h) throw new Error('--size WxH, e.g. 1080x1080');
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
  // the geometry first
  const sq = layout('bluesky', [1, 1, 1], 310); if (sq.tiles[0].w !== sq.tiles[0].h || Math.abs(sq.tiles[1].h * 2 + 4 - sq.H) > 0.1) throw new Error('bluesky 3: ' + JSON.stringify(sq));
  const li = layout('linkedin', [1.5, 1, 1, 1, 1, 1], 390); if (li.tiles[0].w !== 390 || li.tiles[3].plus !== 2 || !li.tiles[5].hidden) throw new Error('linkedin landscape: ' + JSON.stringify(li));
  const lp = layout('linkedin', [0.8, 1, 1], 390); if (!(lp.tiles[0].w > lp.tiles[1].w && lp.tiles[1].x > 0 && lp.tiles[2].y > 0)) throw new Error('linkedin portrait: ' + JSON.stringify(lp));
  const c = cropOf(1500, 1000, 100, 100); if (Math.abs(c.x0 - 1 / 6) > 1e-6 || c.y0 !== 0) throw new Error('crop: ' + JSON.stringify(c));
  const d = mkdtempSync(join(tmpdir(), 'multi-image-'));
  const page = (w, h, body, bg = '#2f5d4e') => `<html><body style="margin:0;width:${w}px;height:${h}px;overflow:hidden;background:${bg};font-family:Arial,sans-serif;position:relative">${body}</body></html>`;
  // good: three squares, words big and central, alt text with the words
  const good = join(d, 'good'); mkdirSync(good);
  const T = ['OPEN SAT', 'NEW OVEN', 'FREE COFFEE'];
  T.forEach((t, i) => writeFileSync(join(good, `0${i + 1}-g.html`), page(1080, 1080, `<div style="position:absolute;left:300px;right:300px;top:400px;font:900 120px/1.05 Arial;color:#fff;text-align:center">${t}</div>`)));
  await render(good, { out: good, size: '1080x1080' });
  writeFileSync(join(good, 'alt.txt'), T.map((t, i) => `0${i + 1}-g.jpg: A green card with the words "${t.toLowerCase()}" in big white letters.`).join('\n'));
  writeFileSync(join(good, 'post.json'), JSON.stringify({ images: T.map((_, i) => ({ file: `0${i + 1}-g.jpg`, subject: [0.25, 0.3, 0.5, 0.4] })) }));
  const g = await check(good, { out: join(d, 'good'), ocr: 'never' });
  const gw = g.issues.filter((i) => i.level !== 'note');
  if (gw.length || g.images.some((im) => im.method !== 'source')) throw new Error('good: ' + JSON.stringify(gw) + JSON.stringify(g.images.map((im) => im.method)));
  // bad: five images; a wide one with words at both edges and a subject at the edge; a tall flyer with small text; no alt
  const bad = join(d, 'bad'); mkdirSync(bad);
  writeFileSync(join(bad, '01-wide.html'), page(1800, 900, '<div style="position:absolute;left:30px;top:380px;font:900 110px Arial;color:#fff">LEFT</div><div style="position:absolute;right:30px;top:380px;font:900 110px Arial;color:#fff">RIGHT</div>'));
  writeFileSync(join(bad, '02-flyer.html'), page(800, 1600, '<div style="position:absolute;left:60px;top:200px;font:700 70px Arial;color:#fff">FLYER</div><div style="position:absolute;left:60px;top:1000px;font:400 22px Arial;color:#fff">small print at the bottom of the flyer</div><div style="position:absolute;left:60px;top:800px;font:700 60px Arial;color:#3a6b5b">LOW</div>'));
  for (const k of ['03', '04', '05']) writeFileSync(join(bad, `${k}-x.html`), page(1080, 1080, `<div style="position:absolute;left:300px;top:450px;font:900 120px Arial;color:#fff">${k}</div>`));
  await render(join(bad, '01-wide.html'), { out: join(bad, '01-wide.jpg'), size: '1800x900' });
  await render(join(bad, '02-flyer.html'), { out: join(bad, '02-flyer.jpg'), size: '800x1600' });
  for (const k of ['03', '04', '05']) await render(join(bad, `${k}-x.html`), { out: join(bad, `${k}-x.jpg`), size: '1080x1080' });
  writeFileSync(join(bad, 'post.json'), JSON.stringify({ key: '03-x.jpg', images: [{ file: '01-wide.jpg', subject: [0.0, 0.3, 0.12, 0.4] }, { file: '03-x.jpg', alt: 'img' }] }));
  writeFileSync(join(bad, 'post.md'), '## X\n' + 'word '.repeat(70) + '\n## Bluesky\nShort.\n');
  const b = await check(bad, { out: join(d, 'bad'), ocr: 'never' });
  const ids = b.issues.map((i) => i.id);
  for (const want of ['count-x', 'count-bluesky', 'text-cut', 'subject-cut', 'text-small', 'crop-heavy', 'alt-missing', 'alt-thin', 'low-contrast', 'key-not-big', 'key-not-first', 'behind-more', 'text-long-x']) if (!ids.includes(want)) throw new Error('bad: expected ' + want + ' in ' + ids.join(','));
  if (b.ok) throw new Error('bad: should have errors');
  // subjects followed from the original photo into a crop of it
  const ph = join(d, 'photos'); mkdirSync(ph);
  writeFileSync(join(ph, 'p.html'), page(1500, 1000, '<div style="position:absolute;left:80px;top:300px;width:200px;height:260px;border-radius:50%;background:#e9b"></div><div style="position:absolute;left:650px;top:280px;width:220px;height:300px;border-radius:50%;background:#fc3"></div><div style="position:absolute;left:1220px;top:300px;width:200px;height:260px;border-radius:50%;background:#7cf"></div>' + Array.from({ length: 30 }, (_, i) => `<div style="position:absolute;left:${(i * 137) % 1450}px;top:${700 + (i * 53) % 260}px;width:40px;height:30px;background:hsl(${i * 37} 60% 50%)"></div>`).join(''), '#456'));
  await render(join(ph, 'p.html'), { out: join(ph, 'p.jpg'), size: '1500x1000' });
  const cr = join(d, 'crop'); mkdirSync(cr);
  // a square crop from the middle (cuts the two outer faces)
  writeFileSync(join(cr, '01.html'), `<html><body style="margin:0;width:1000px;height:1000px;overflow:hidden;background:url('${pathToFileURL(join(ph, 'p.jpg')).href}') -250px 0/1500px 1000px"></body></html>`);
  await render(join(cr, '01.html'), { out: join(cr, '01.jpg'), size: '1000x1000' });
  const { unlinkSync } = await import('node:fs'); unlinkSync(join(cr, '01.html'));
  writeFileSync(join(cr, 'alt.txt'), '01.jpg: Three people standing in a row in front of a blue wall, smiling.');
  const s = await check(cr, { out: join(d, 'crop'), photos: ph, subjects: { 'p.jpg': [[0.05, 0.28, 0.9, 0.3]] }, ocr: 'never' });
  if (!s.images[0].located || s.images[0].located.photo !== 'p.jpg' || !s.issues.some((i) => i.id === 'subject-cut' && i.level === 'error')) throw new Error('located: ' + JSON.stringify(s.images[0]) + JSON.stringify(s.issues.map((i) => i.id)));
  console.log(`located the crop in its photo at ${JSON.stringify(s.images[0].located.at)} (score ${s.images[0].located.score})`);
  console.log(`multi-image-check: all tests pass (good: no warnings; bad: ${[...new Set(ids)].join(', ')}; sheets in ${d})`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (k, dflt) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : dflt; };
  const VALUED = new Set(['--out', '--size', '--quality', '--handle', '--name', '--ocr', '--photos', '--subjects']);
  const pos = argv.filter((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1]));
  const done = (r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); };
  const fail = (e) => { console.error(String(e.message || e)); process.exit(2); };
  if (argv.includes('--self-test') || argv.includes('--test')) selfTest().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
  else if (pos[0] === 'render' && pos[1]) render(pos[1], { out: opt('out'), size: opt('size', '1080x1080'), quality: +opt('quality', 90) }).then(done, fail);
  else if (pos[0] === 'check' && pos[1]) check(pos[1], { out: opt('out', 'look/post'), photos: opt('photos'), subjects: opt('subjects'), handle: opt('handle', '@yourshop'), name: opt('name'), plain: argv.includes('--plain'), ocr: opt('ocr', 'auto') }).then(done, fail);
  else fail('usage: multi-image-check.mjs check <post folder> [--out look/post] [--photos photos/ --subjects subjects.json] [--handle @name] [--name "Shop"] [--plain]\n       multi-image-check.mjs render <image.html | folder> [--size 1080x1080] [--out image.jpg | folder]\n       multi-image-check.mjs --self-test');
}
