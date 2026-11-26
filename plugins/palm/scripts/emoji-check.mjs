#!/usr/bin/env node
// Palm tool: emoji-check — lets an agent see a team's custom emoji and Discord stickers where people see them, and
// measures what the upload pages refuse and what fails at emoji size. A custom emoji is made at 128 px but seen at about
// 22 px inline in a message, 16 px in a reaction pill and 32 px in the picker, next to the standard emoji, in light and
// dark themes, on normal (1×) and high-DPI (2×) screens. A Discord sticker shows at 160 px in desktop chat.
//
//   node emoji-check.mjs check <folder> [--out look/emoji] [--plain] [--ocr auto|always|never]
//       → JSON {ok, errors, warnings, files:[…], set:{…}, issues, sheet}. Then LOOK at <out>-sheet.png.
//       The folder's emoji are its images (and those in emoji/ under it); stickers are the images in a stickers/ folder
//       or with "sticker" in their name. Keep the SVG/HTML each was made from beside it with the same name
//       (lgtm.svg next to lgtm.png) so its words can be measured exactly.
//   node emoji-check.mjs render <file.svg|file.html> [--size 128x128] [--out emoji/name.png]
//       → a PNG with a transparent background at exactly that size.
//   node emoji-check.mjs animate <anim.html> [--size 128x128] [--fps 12] [--seconds 1.5] --out emoji/name.gif|.png
//       → renders the page's CSS animation frame by frame (or calls window.palmFrame(t) if you define it) and joins
//       the frames into a looping GIF with transparency (or an APNG for a .png sticker) with ffmpeg.
//   node emoji-check.mjs --self-test
//
// Facts: see RULES below (each with its source and the date it was read).
// Palm's approximation of the apps (Nov 2026; neither publishes these for its own UI except Discord's 160 px sticker):
//   Slack and Discord messages with custom emoji at 22 px inline, 16 px in reaction pills, emoji-only messages at
//   32 px (Slack) and 48 px (Discord), the emoji picker at 32 px, Discord stickers at 160 px; light and dark themes;
//   stand-in standard emoji drawn by Palm (simple shapes; not any vendor's emoji art).
// Palm's thresholds (guidance, not a platform rule): the outline shows on a theme when 50% or more of the emoji's edge
//   pixels at 22 px (2×) contrast 1.5:1 or more with that theme's background; the drawing fills 80% or more of the
//   canvas (standard emoji fill about 90%); strokes at least 0.8 px wide at 22 px on a 1× screen; words at least 8 px
//   (font size) at 22 px; animation frames 0.02 s or longer and no more than 3 bright flashes a second.
// Text: from the emoji's SVG/HTML source if it's beside it, else from the image with Tesseract OCR if installed
//   (Palm's estimate: a word's box height ÷ 0.75 ≈ its font size; OCR misses small and styled lettering).
// adds: tool. Runs on the user's machine with their Chrome/Edge/Chromium (and ffmpeg for animate); nothing leaves it.

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve, basename, extname, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
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
const launch = () => loadPuppeteer().launch({ executablePath: findChrome(), headless: true, timeout: 90000, protocolTimeout: 240000, args: ['--no-sandbox', '--hide-scrollbars', '--allow-file-access-from-files'] });

// ---------- the rules (sources and dates) ----------
// Read 2026-11-26 (Slack's page redirected in a loop for a plain fetch and Discord's help centre is a Zendesk page, so
// both were read in headless Chrome; Discord's developer docs were read with a plain fetch):
//   Slack Help, "Add customised emoji and aliases to your workspace" (slack.com/help/articles/206870177): "Square images
//     under 128 KB and with transparent backgrounds work best. Images can be in JPG, PNG or GIF format. GIFs can include
//     up to 50 frames." Members can add them by default (owners can restrict it). Slack's page gives no pixel size.
//   Discord Support, "How to Add Custom Emojis on Discord" (support.discord.com/hc/en-us/articles/360036479811): 50
//     custom emoji per server, plus 50 animated slots with Nitro or Nitro Basic; "Emojis must be under 256KB in size";
//     JPEG, PNG, GIF and WEBP; animated emoji are GIF files; names at least 2 characters, only letters, numbers and
//     underscores.
//   Discord Developer docs, Emoji resource (docs.discord.com/developers/resources/emoji): "Emojis and animated emojis
//     have a maximum file size of 256 KiB"; the upload is "the 128x128 emoji image"; JPEG, PNG, GIF, WebP and AVIF.
//   Discord Support, "Tips for Sticker Creators FAQ" (support.discord.com/hc/en-us/articles/4402687377815): static PNG,
//     animated APNG, max 512KB, "Dimensions: 320px x 320px (exact)"; "make sure that your sticker takes up as much
//     canvas space as possible"; "Stickers in the desktop chat will render at 160x160 dp"; up to 60 FPS; usually a
//     transparent background. "Custom Stickers FAQ" (…/4403089981975): 5 sticker slots free, more with Boosts; upload
//     on desktop or web only; a sticker's file can't be replaced (delete and upload again); a related Unicode emoji
//     is required and a description (alt text) recommended.
//   Discord Developer docs, Sticker resource (docs.discord.com/developers/resources/sticker): "PNG, APNG, GIF, or
//     Lottie JSON file, max 512 KiB"; "5 seconds in length for animated stickers, and 320 x 320 pixels"; Lottie only on
//     Verified or Partnered servers.
export const RULES = {
  read: '2026-11-26',
  slack: { maxKB: 128, formats: ['png', 'jpeg', 'gif'], maxFrames: 50 },
  discordEmoji: { maxKB: 256, formats: ['png', 'jpeg', 'gif', 'webp', 'avif'], px: 128, name: /^[A-Za-z0-9_]{2,}$/ },
  sticker: { maxKB: 512, px: 320, formats: ['png', 'apng', 'gif'], maxSeconds: 5, maxFps: 60, chatPx: 160 },
};

// ---------- Palm's approximation of the apps (Nov 2026) and thresholds ----------
export const VIEW = { inline: 22, reaction: 16, picker: 32, slackJumbo: 32, discordJumbo: 48, sticker: 160 };
export const BG = { light: [255, 255, 255], slackDark: [26, 29, 33], discordDark: [49, 51, 56] };
const T = { edge: 0.5, edgeCR: 1.5, fill: 0.8, stroke: 0.8, text: 8, minDelay: 0.02, flashes: 3, fillSpread: 0.2 };
const issue = (id, level, msg, fix, file) => ({ id, level, ...(file ? { file } : {}), msg, fix });
const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const lum = (r, g, b) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const cr = (L1, L2) => (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
const hex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

// ---------- the file: format, size, animation (parsed here, no browser) ----------
export function imageInfo(b) {
  if (!b || b.length < 12) return { format: 'unknown' };
  if (b.readUInt32BE(0) === 0x89504e47) {
    const ct = b[25], out = { format: 'png', w: b.readUInt32BE(16), h: b.readUInt32BE(20), alpha: ct === 4 || ct === 6, frames: 1, delays: [], loops: null };
    for (let i = 8; i + 8 <= b.length;) {
      const len = b.readUInt32BE(i), type = b.toString('latin1', i + 4, i + 8);
      if (type === 'tRNS') out.alpha = true;
      if (type === 'acTL') { out.format = 'apng'; out.frames = b.readUInt32BE(i + 8); out.loops = b.readUInt32BE(i + 12); }
      if (type === 'fcTL') { const num = b.readUInt16BE(i + 28), den = b.readUInt16BE(i + 30) || 100; out.delays.push(num / den); }
      if (type === 'IEND') break;
      i += 12 + len;
    }
    return out;
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i < b.length - 9;) {
      if (b[i] !== 0xff) { i++; continue; }
      const mk = b[i + 1]; if (mk === 0xd8 || mk === 0x01 || (mk >= 0xd0 && mk <= 0xd7) || mk === 0xff) { i += mk === 0xff ? 1 : 2; continue; }
      if (mk >= 0xc0 && mk <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(mk)) return { format: 'jpeg', w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5), alpha: false, frames: 1, delays: [] };
      i += 2 + b.readUInt16BE(i + 2);
    }
    return { format: 'jpeg', alpha: false, frames: 1, delays: [] };
  }
  if (b.toString('latin1', 0, 3) === 'GIF') {
    const out = { format: 'gif', w: b.readUInt16LE(6), h: b.readUInt16LE(8), alpha: false, frames: 0, delays: [], loops: null };
    let i = 13; if (b[10] & 0x80) i += 3 * 2 ** ((b[10] & 7) + 1);
    let delay = 0;
    const skip = (j) => { while (j < b.length && b[j]) j += b[j] + 1; return j + 1; };
    while (i < b.length) {
      const k = b[i];
      if (k === 0x3b) break;
      if (k === 0x21) {
        const label = b[i + 1];
        if (label === 0xf9) { delay = b.readUInt16LE(i + 4) / 100; if (b[i + 3] & 1) out.alpha = true; }
        if (label === 0xff && b.toString('latin1', i + 3, i + 14) === 'NETSCAPE2.0') out.loops = b.readUInt16LE(i + 16);
        i = skip(i + 2);
      } else if (k === 0x2c) {
        out.frames++; out.delays.push(delay); delay = 0;
        let j = i + 10; if (b[i + 9] & 0x80) j += 3 * 2 ** ((b[i + 9] & 7) + 1);
        i = skip(j + 1);
      } else break;
    }
    return out;
  }
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const out = { format: 'webp', alpha: false, frames: 0, delays: [], loops: null };
    for (let i = 12; i + 8 <= b.length;) {
      const type = b.toString('latin1', i, i + 4), len = b.readUInt32LE(i + 4);
      if (type === 'VP8X') { out.alpha = !!(b[i + 8] & 0x10); out.w = 1 + b.readUIntLE(i + 12, 3); out.h = 1 + b.readUIntLE(i + 15, 3); }
      if (type === 'ANIM') out.loops = b.readUInt16LE(i + 12);
      if (type === 'ANMF') { out.frames++; out.delays.push(b.readUIntLE(i + 20, 3) / 1000); }
      if (type === 'VP8 ' && !out.w) { out.w = b.readUInt16LE(i + 14) & 0x3fff; out.h = b.readUInt16LE(i + 16) & 0x3fff; }
      if (type === 'VP8L' && !out.w) { const v = b.readUInt32LE(i + 9); out.w = (v & 0x3fff) + 1; out.h = ((v >> 14) & 0x3fff) + 1; out.alpha = !!((v >> 28) & 1); }
      i += 8 + len + (len & 1);
    }
    out.frames ||= 1;
    return out;
  }
  if (b.toString('latin1', 4, 12).includes('ftypavif')) return { format: 'avif', frames: 1, delays: [] };
  if (b.toString('latin1', 0, 5).match(/^\s*[<{]/)) return { format: /^\s*\{/.test(b.toString('latin1', 0, 5)) ? 'json' : 'svg', frames: 1, delays: [] };
  return { format: 'unknown', frames: 1, delays: [] };
}

// ---------- pixels ----------
// The boundary of the drawing (alpha ≥ 0.5 next to alpha < 0.5, or on the canvas edge) and how much of it stands out
// against a theme's background, composited the way the apps draw it.
// A boundary pixel shows when it, or a pixel of the drawing within r pixels of it (about 2 px on screen), stands out,
// so a light keyline round a coloured shape still shows on white through the shape just inside it.
export function edgeShows(px, n, bg, r = 2) {
  const a = (x, y) => (x < 0 || y < 0 || x >= n || y >= n) ? 0 : px[(y * n + x) * 4 + 3];
  const Lb = lum(...bg); let tot = 0, ok = 0;
  const shows = (x, y) => { const A = a(x, y); if (A < 128) return false; const k = (y * n + x) * 4, al = A / 255; return cr(lum(...[0, 1, 2].map((m) => px[k + m] * al + bg[m] * (1 - al))), Lb) >= T.edgeCR; };
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (a(x, y) < 128) continue;
    if (a(x - 1, y) >= 128 && a(x + 1, y) >= 128 && a(x, y - 1) >= 128 && a(x, y + 1) >= 128) continue;
    tot++;
    let s = false; for (let dy = -r; dy <= r && !s; dy++) for (let dx = -r; dx <= r && !s; dx++) s = shows(x + dx, y + dy);
    if (s) ok++;
  }
  return tot ? ok / tot : 0;
}
// How much of the canvas the drawing uses: its box (alpha > 10%, or on an opaque image: not the corner colour).
export function fillOf(px, n) {
  let opaque = true; for (let k = 3; k < px.length; k += 4) if (px[k] < 250) { opaque = false; break; }
  const corner = [px[0], px[1], px[2]];
  const on = (k) => opaque ? Math.hypot(px[k] - corner[0], px[k + 1] - corner[1], px[k + 2] - corner[2]) > 40 : px[k + 3] > 25;
  let x0 = n, y0 = n, x1 = -1, y1 = -1, area = 0;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (on((y * n + x) * 4)) { area++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return { opaque, fill: 0, area: 0, off: 0, box: null };
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  return { opaque, fill: Math.max(bw, bh) / n, area: area / (n * n), off: Math.hypot((x0 + x1 + 1) / 2 - n / 2, (y0 + y1 + 1) / 2 - n / 2) / n, box: [x0, y0, bw, bh] };
}
// Thinnest parts: the drawing split into its main colours (and its silhouette); each connected part's typical width
// from a distance transform (ridge median), scaled to 22 px. Only parts that stand out from what's round them count.
export function strokes(px, n) {
  const N = n * n, isOn = new Uint8Array(N);
  let opaque = true; for (let k = 3; k < px.length; k += 4) if (px[k] < 250) { opaque = false; break; }
  const hist = new Map(); let total = 0;
  for (let i = 0; i < N; i++) { if (px[i * 4 + 3] < 200) continue; total++; const key = (px[i * 4] >> 4) << 8 | (px[i * 4 + 1] >> 4) << 4 | (px[i * 4 + 2] >> 4); hist.set(key, (hist.get(key) || 0) + 1); }
  const pal = [];
  for (const [key, c] of [...hist].sort((p, q) => q[1] - p[1])) {
    if (c < total * 0.005 || pal.length >= 8) break;
    const rgb = [(key >> 8) * 16 + 8, ((key >> 4) & 15) * 16 + 8, (key & 15) * 16 + 8];
    if (!pal.some((p) => Math.hypot(p[0] - rgb[0], p[1] - rgb[1], p[2] - rgb[2]) < 48)) pal.push(rgb);
  }
  const cls = new Int8Array(N).fill(-1);
  for (let i = 0; i < N; i++) {
    if (px[i * 4 + 3] < 128) continue; isOn[i] = 1;
    let best = -1, bd = 1e9; for (let p = 0; p < pal.length; p++) { const d = Math.hypot(px[i * 4] - pal[p][0], px[i * 4 + 1] - pal[p][1], px[i * 4 + 2] - pal[p][2]); if (d < bd) { bd = d; best = p; } }
    cls[i] = best;
  }
  const parts = [];
  const measure = (mask, colour) => {
    // chamfer 3-4 distance to the nearest pixel outside the mask
    const d = new Float32Array(N); for (let i = 0; i < N; i++) d[i] = mask[i] ? 1e6 : 0;
    const at = (x, y) => (x < 0 || y < 0 || x >= n || y >= n) ? 0 : d[y * n + x];
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const i = y * n + x; if (!d[i]) continue; d[i] = Math.min(d[i], at(x - 1, y) + 3, at(x, y - 1) + 3, at(x - 1, y - 1) + 4, at(x + 1, y - 1) + 4); }
    for (let y = n - 1; y >= 0; y--) for (let x = n - 1; x >= 0; x--) { const i = y * n + x; if (!d[i]) continue; d[i] = Math.min(d[i], at(x + 1, y) + 3, at(x, y + 1) + 3, at(x + 1, y + 1) + 4, at(x - 1, y + 1) + 4); }
    const seen = new Uint8Array(N), minArea = Math.max(8, Math.round((n / 128) ** 2 * 10));
    for (let s = 0; s < N; s++) {
      if (!mask[s] || seen[s]) continue;
      const q = [s]; seen[s] = 1; const comp = [];
      while (q.length) { const i = q.pop(); comp.push(i); const x = i % n, y = (i / n) | 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= n || Y >= n) continue; const j = Y * n + X; if (mask[j] && !seen[j]) { seen[j] = 1; q.push(j); } } }
      if (comp.length < minArea) continue;
      const ridge = [];
      for (const i of comp) { const x = i % n, y = (i / n) | 0; let top = true; for (let dy = -1; dy <= 1 && top; dy++) for (let dx = -1; dx <= 1; dx++) { if (!dx && !dy) continue; if (at(x + dx, y + dy) > d[i]) { top = false; break; } } if (top) ridge.push(d[i] / 3); }
      ridge.sort((p, q2) => p - q2);
      const med = ridge[ridge.length >> 1] || 1, width = Math.max(1, 2 * med - 1);
      if (comp.length / width < 4 * width) continue; // a blob or dot, not a line
      // does it stand out from the pixels just outside it?
      let Lin = 0, Lout = 0, no = 0; const inC = new Set(comp);
      for (const i of comp) { Lin += lum(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]); }
      for (const i of comp) { const x = i % n, y = (i / n) | 0; for (const [dx, dy] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) { const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= n || Y >= n) continue; const j = Y * n + X; if (inC.has(j)) continue; const al = px[j * 4 + 3] / 255; Lout += px[j * 4 + 3] < 128 ? -1 : lum(px[j * 4], px[j * 4 + 1], px[j * 4 + 2]); no++; } }
      Lin /= comp.length;
      const outsideIsBg = Lout < 0 && no > 0;
      if (no && !outsideIsBg) { const Lo = Lout / no; if (Lo >= 0 && cr(Lin, Lo) < 1.5) continue; }
      parts.push({ colour, width_px: round(width, 1), at22: round(width * 22 / n, 2), share: round(comp.length / Math.max(1, total), 3), box: (() => { let x0 = n, y0 = n, x1 = 0, y1 = 0; for (const i of comp) { const x = i % n, y = (i / n) | 0; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); } return [x0, y0, x1 - x0 + 1, y1 - y0 + 1]; })() });
    }
  };
  for (let p = 0; p < pal.length; p++) { const m = new Uint8Array(N); let c = 0; for (let i = 0; i < N; i++) if (cls[i] === p) { m[i] = 1; c++; } if (c) measure(m, hex(pal[p])); }
  if (!opaque) measure(isOn, 'silhouette');
  parts.sort((p, q) => p.at22 - q.at22);
  return { palette: pal.map(hex), parts, thinnest_at22: parts.length ? parts[0].at22 : null };
}

// ---------- the source's words (SVG or HTML beside the image) ----------
function findSource(file, root) {
  const stem = basename(file, extname(file)).toLowerCase();
  const cands = [];
  const walk = (d, depth) => { if (depth > 4) return; let es = []; try { es = readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { if (e.isDirectory()) { if (!/^(palm|look|node_modules|\.)/.test(e.name)) walk(join(d, e.name), depth + 1); } else if (/\.(svg|html?)$/i.test(e.name) && basename(e.name, extname(e.name)).toLowerCase() === stem) cands.push(join(d, e.name)); } };
  walk(dirname(file), 0); if (root && resolve(root) !== resolve(dirname(file))) walk(root, 0);
  return cands.sort((a, b) => (dirname(a) === dirname(file) ? -1 : 0) - (dirname(b) === dirname(file) ? -1 : 0))[0] || null;
}
async function sourceText(page, src) {
  await page.setViewport({ width: 1024, height: 1024, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(src).href, { waitUntil: 'load', timeout: 60000 });
  await page.evaluate(() => document.fonts?.ready); await new Promise((r) => setTimeout(r, 150));
  return page.evaluate(() => {
    const root = document.documentElement;
    let S;
    if (root.tagName.toLowerCase() === 'svg') { const r = root.getBoundingClientRect(); S = Math.max(r.width, r.height); }
    else { let R = 0, B = 0; for (const e of document.querySelectorAll('body *')) { const q = e.getBoundingClientRect(); if (q.width && q.height && getComputedStyle(e).visibility !== 'hidden') { R = Math.max(R, q.right); B = Math.max(B, q.bottom); } } const cs = getComputedStyle(document.body); S = Math.max(parseFloat(cs.width) < 1024 ? parseFloat(cs.width) : 0, Math.min(R, 1024), Math.min(B, 1024)); }
    const lines = [];
    for (const el of document.querySelectorAll('text, tspan, body *')) {
      const own = [...el.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent).join('').trim();
      if (!own) continue;
      const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) continue;
      let fs = parseFloat(cs.fontSize);
      if (el instanceof SVGElement) { const m = el.getScreenCTM(); if (m) fs *= Math.hypot(m.a, m.b); }
      else if (el.offsetHeight) { const r = el.getBoundingClientRect(); const k = r.height / el.offsetHeight; if (k > 0 && isFinite(k)) fs *= k; }
      const r = el.getBoundingClientRect();
      lines.push({ t: own.replace(/\s+/g, ' '), fs, x: r.x, y: r.y, w: r.width, h: r.height });
    }
    return { S, lines: lines.filter((l) => l.w > 0 && l.h > 0 && l.x < S && l.y < S && l.x + l.w > 0 && l.y + l.h > 0) };
  });
}
function hasTesseract() { try { execFileSync('tesseract', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } }
async function ocrWords(page, dataUrl, n, blank, view = 22) {
  if (blank) await page.goto(blank);
  // the emoji at 4× on white and on black, read by Tesseract; a word's box height ÷ 0.75 ≈ its font size (estimate)
  const out = [];
  for (const bg of ['#fff', '#000']) {
    const b64 = await page.evaluate(async (src, bg) => { const im = new Image(); im.src = src; await im.decode(); const z = 512, c = document.createElement('canvas'); c.width = c.height = z + 64; const x = c.getContext('2d'); x.fillStyle = bg; x.fillRect(0, 0, z + 64, z + 64); x.imageSmoothingQuality = 'high'; x.drawImage(im, 32, 32, z, z); return c.toDataURL('image/png').split(',')[1]; }, dataUrl, bg);
    const f = join(tmpdir(), `emoji-ocr-${process.pid}-${Date.now()}.png`); writeFileSync(f, Buffer.from(b64, 'base64'));
    let tsv = ''; try { tsv = execFileSync('tesseract', [f, '-', '--psm', '11', 'tsv'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString(); } catch {}
    rmSync(f, { force: true });
    for (const row of tsv.split('\n').slice(1)) { const c = row.split('\t'); if (c.length < 12) continue; const t = c[11].trim(), conf = +c[10]; if (conf < 70 || !/[A-Za-z]{2,}/.test(t)) continue; const h = +c[9] * n / 512; if (!out.some((o) => o.t.toLowerCase() === t.toLowerCase())) out.push({ t, fs: h / 0.75, h }); }
  }
  return out.map((o) => ({ t: o.t, font_px: round(o.fs, 1), at22: round(o.fs * view / n, 1) }));
}

// ---------- check ----------
function listFiles(dir) {
  const abs = resolve(dir), out = [];
  const isImg = (f) => /\.(png|gif|jpe?g|webp|avif|apng)$/i.test(f) && !/-sheet\.|preview|^f?rame[-_]?\d|^f\d{3}\./i.test(basename(f));
  const walk = (d, depth, sticker) => { for (const e of readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) { if (depth < 3 && !/^(palm|look|node_modules|frames?|src|source|\.)/i.test(e.name)) walk(join(d, e.name), depth + 1, sticker || /sticker/i.test(e.name)); } else if (isImg(e.name)) out.push({ path: join(d, e.name), sticker: sticker || /sticker/i.test(e.name) }); } };
  if (!statSync(abs).isDirectory()) { out.push({ path: abs, sticker: /sticker/i.test(abs) }); return out; }
  // a project folder with emoji/ or stickers/ in it: only those
  const subs = readdirSync(abs, { withFileTypes: true }).filter((e) => e.isDirectory() && /^(emoji|emojis|emotes|stickers?)$/i.test(e.name));
  if (subs.length) for (const e of subs) walk(join(abs, e.name), 1, /sticker/i.test(e.name));
  else walk(abs, 0, /sticker/i.test(basename(abs)));
  return out;
}
function server() {
  const s = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<!doctype html><meta charset="utf-8"><body></body>'); });
  return new Promise((ok) => s.listen(0, '127.0.0.1', () => ok(s)));
}
const MIME = { png: 'image/png', apng: 'image/png', gif: 'image/gif', jpeg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif' };

export async function check(target, { out = 'look/emoji', plain = false, ocr = 'auto', root = null } = {}) {
  const abs = resolve(target);
  if (!existsSync(abs)) throw new Error('no such file or folder: ' + target);
  const list = listFiles(abs);
  if (!list.length) throw new Error('no emoji images (PNG, GIF, JPG, WebP) in ' + target);
  const issues = [], files = [];
  const tess = ocr !== 'never' && hasTesseract();
  const srv = await server(), browser = await launch();
  try {
    const page = await browser.newPage();
    const blank = `http://127.0.0.1:${srv.address().port}/`;
    for (const { path: f, sticker } of list) {
      const buf = readFileSync(f), info = imageInfo(buf), name = relative(abs, f) || basename(f), stem = basename(f, extname(f));
      const kb = buf.length / 1024, W = info.w, H = info.h, anim = info.frames > 1;
      const rec = { file: name, kind: sticker ? 'sticker' : 'emoji', format: info.format, w: W, h: H, kb: round(kb, 1), alpha: !!info.alpha, frames: info.frames, platforms: {} };
      const add = (id, level, msg, fix) => issues.push(issue(id, level, msg, fix, name));
      if (anim) { const ds = info.delays.length ? info.delays : []; rec.duration_s = round(ds.reduce((s, x) => s + x, 0), 2); rec.min_delay_s = ds.length ? round(Math.min(...ds), 3) : null; rec.loops = info.loops; }
      // what each upload page accepts
      if (!sticker) {
        const sl = []; if (!RULES.slack.formats.includes(info.format)) sl.push(`${String(info.format).toUpperCase()} isn't one of JPG, PNG or GIF${info.format === 'apng' ? ' (an animated PNG shows still: animate as GIF)' : ''}`);
        if (kb >= RULES.slack.maxKB) sl.push(`${round(kb, 0)} KB, not under 128 KB`);
        if (info.format === 'gif' && info.frames > RULES.slack.maxFrames) sl.push(`${info.frames} GIF frames, over 50`);
        const di = []; if (!RULES.discordEmoji.formats.includes(info.format)) di.push(`${String(info.format).toUpperCase()} isn't one of JPEG, PNG, GIF, WebP${info.format === 'apng' ? ' (animated emoji are GIFs)' : ''}`);
        if (kb >= RULES.discordEmoji.maxKB) di.push(`${round(kb, 0)} KB, not under 256 KB`);
        if (!RULES.discordEmoji.name.test(stem)) di.push(`its name "${stem}" can only have letters, numbers and underscores (2 or more)`);
        rec.platforms = { slack: sl.length ? sl : 'ok', discord: di.length ? di : 'ok' };
        if (sl.length) add('slack-refuses', 'error', `Slack won't take ${name}: ${sl.join('; ')}.`, 'Slack: JPG, PNG or GIF, under 128 KB, GIFs 50 frames or fewer.');
        if (di.length) add('discord-refuses', 'error', `Discord won't take ${name} as an emoji: ${di.join('; ')}.`, 'Discord: JPEG, PNG, GIF or WebP under 256 KB, named with letters, numbers and underscores (rename on upload or name the file that way).');
        if (W && H && W !== H) add('not-square', 'error', `${name} is ${W}×${H}: emoji are shown in a square, so it's squashed or shrunk to fit.`, 'Make it 128×128.');
        else if (W && W < 64) add('too-small', 'warn', `${name} is ${W}×${H}: blurry in the picker on a 2× screen (32 px there is 64 real pixels).`, 'Make it 128×128.');
        else if (W && W !== RULES.discordEmoji.px) add('not-128', 'note', `${name} is ${W}×${H}: Discord's docs describe "the 128x128 emoji image" (Slack gives no size; 128×128 fits both).`, 'Save it at 128×128.');
      } else {
        const st = []; if (!['png', 'apng', 'gif'].includes(info.format)) st.push(`${String(info.format).toUpperCase()} isn't PNG or APNG`);
        if (W !== RULES.sticker.px || H !== RULES.sticker.px) st.push(`${W}×${H}, not exactly 320×320`);
        if (kb > RULES.sticker.maxKB) st.push(`${round(kb, 0)} KB, over 512 KB`);
        if (anim && rec.duration_s > RULES.sticker.maxSeconds) st.push(`${rec.duration_s} s long, over 5 s`);
        if (anim && rec.min_delay_s != null && rec.min_delay_s > 0 && 1 / rec.min_delay_s > RULES.sticker.maxFps + 0.5) st.push(`${round(1 / rec.min_delay_s, 0)} fps, over 60`);
        rec.platforms = { discord_sticker: st.length ? st : 'ok' };
        if (st.length) add('sticker-refused', 'error', `Discord won't take ${name} as a sticker: ${st.join('; ')}.`, 'Stickers: PNG (or APNG when animated), exactly 320×320, 512 KB or less, 5 s or less.');
        if (info.format === 'gif') add('sticker-gif', 'note', `${name} is a GIF: Discord's developer docs accept GIF stickers but its help page names only PNG and APNG.`, 'Use PNG, or APNG when animated.');
      }
      if (anim) {
        if (rec.min_delay_s != null && rec.min_delay_s < T.minDelay) add('frame-too-fast', 'warn', `${name} has frames of ${rec.min_delay_s} s: browsers and apps slow GIF frames under 0.02 s to about 0.1 s, so it plays at another speed than you made (Palm's note).`, 'Give every frame 0.02 s or more (e.g. 12–15 fps).');
        if (info.format === 'gif' && !info.loops && info.loops !== 0) add('no-loop', 'warn', `${name} has no loop setting: it plays once and stops.`, 'Save it looping (ffmpeg -loop 0).');
      }
      // pixels: the first frame at full size, at 22 px (1×) and 44 px (2×), and the frames for animation
      await page.goto(blank);
      const px = await page.evaluate(async (b64, type, n) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type }));
        const im = new Image(); im.src = url; await im.decode();
        const grab = (s) => { const c = document.createElement('canvas'); c.width = c.height = s; const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(im, 0, 0, s, s); const d = x.getImageData(0, 0, s, s).data; let bin = ''; for (let i = 0; i < d.length; i++) bin += String.fromCharCode(d[i]); return { b64: btoa(bin), url: c.toDataURL('image/png') }; };
        const res = { full: grab(n), s22: grab(22), s44: grab(44), frames: null };
        if (typeof ImageDecoder !== 'undefined') {
          try {
            const dec = new ImageDecoder({ data: bytes, type }); await dec.tracks.ready; const tr = dec.tracks.selectedTrack; const count = tr.frameCount;
            if (count > 1) {
              const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d'); const lumf = []; const thumbs = []; const durs = [];
              for (let i = 0; i < Math.min(count, 120); i++) {
                const { image } = await dec.decode({ frameIndex: i }); durs.push((image.duration || 0) / 1e6);
                x.fillStyle = '#808080'; x.fillRect(0, 0, 64, 64); x.drawImage(image, 0, 0, 64, 64); const d = x.getImageData(0, 0, 64, 64).data; let L = 0; for (let k = 0; k < d.length; k += 4) { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; L += 0.2126 * f(d[k]) + 0.7152 * f(d[k + 1]) + 0.0722 * f(d[k + 2]); } lumf.push(L / 4096);
                if (thumbs.length < 10 && i % Math.max(1, Math.ceil(Math.min(count, 120) / 10)) === 0) { const t = document.createElement('canvas'); t.width = t.height = 96; t.getContext('2d').drawImage(image, 0, 0, 96, 96); thumbs.push(t.toDataURL('image/png')); }
                image.close();
              }
              res.frames = { count, lum: lumf, durs, thumbs, rep: tr.repetitionCount };
            }
          } catch (e) { res.frames = { error: String(e) }; }
        }
        URL.revokeObjectURL(url);
        return res;
      }, buf.toString('base64'), MIME[info.format] || 'image/png', Math.max(16, Math.min(W || 128, 512)));
      const n = Math.max(16, Math.min(W || 128, 512));
      const full = Buffer.from(px.full.b64, 'base64'), p22 = Buffer.from(px.s22.b64, 'base64'), p44 = Buffer.from(px.s44.b64, 'base64');
      rec.url22 = px.s22.url;
      rec.dataUrl = `data:${MIME[info.format] || 'image/png'};base64,${buf.toString('base64')}`;
      // fill and centring
      const fl = fillOf(full, n); rec.fill = round(fl.fill); rec.off_centre = round(fl.off); rec.tile = fl.opaque;
      const fillMin = sticker ? 0.85 : T.fill;
      if (fl.fill && fl.fill < fillMin) add('padded', 'warn', `${name}'s drawing uses only ${Math.round(fl.fill * 100)}% of its ${sticker ? 'sticker' : 'emoji'} square: ${sticker ? 'Discord asks stickers to take up as much of the canvas as possible' : 'next to standard emoji (about 90%) it looks smaller than they do'} (Palm's threshold ${Math.round(fillMin * 100)}%).`, 'Trim the empty margin: let the drawing reach to within a few pixels of the edges.');
      if (fl.off > 0.08) add('off-centre', 'warn', `${name}'s drawing sits ${Math.round(fl.off * 100)}% off the middle of its square.`, 'Centre it.');
      if (fl.opaque && !sticker) add('opaque-tile', 'warn', `${name} has no transparency: it shows as a ${hex([full[0], full[1], full[2]])} square on every theme. Slack: "transparent backgrounds work best".`, 'Use a transparent PNG (a shaped badge is fine if that is the design).');
      if (fl.opaque && sticker) add('sticker-opaque', 'warn', `${name} has no transparency: the sticker shows as a box.`, 'Cut the background out (transparent PNG).');
      // edges on each theme
      rec.edge = Object.fromEntries(Object.entries(BG).map(([k, bg]) => [k, round(sticker ? edgeShows(full, n, bg, Math.max(2, Math.round(n / 32))) : edgeShows(p44, 44, bg, 4))]));
      rec.edge_1x = Object.fromEntries(Object.entries(BG).map(([k, bg]) => [k, round(edgeShows(p22, 22, bg, 2))]));
      for (const [k, v] of Object.entries(rec.edge)) if (v < T.edge) add(`edge-${k}`, 'warn', `${name} melts into the ${{ light: 'light theme (white)', slackDark: "Slack's dark theme", discordDark: "Discord's dark theme" }[k]}: only ${Math.round(v * 100)}% of its outline stands out there (contrast 1.5:1 or more, measured at ${sticker ? '320' : '22'} px; Palm's threshold 50%).`, 'Give it an outline or edge colour that contrasts with both light and dark backgrounds (e.g. a white or light keyline round a dark shape, or a dark one round a light shape).');
      // strokes
      const sk = strokes(sticker ? full : full, n);
      const scale = sticker ? VIEW.sticker / n : 1;
      rec.palette = sk.palette;
      rec.thin = sk.parts.filter((p) => (sticker ? p.width_px * scale : p.at22) < T.stroke && p.share >= 0.01).filter((p, i, all) => all.findIndex((q) => q.colour === p.colour) === i).slice(0, 6).map((p) => ({ colour: p.colour, width_px: p.width_px, [sticker ? 'at160' : 'at22']: sticker ? round(p.width_px * scale, 2) : p.at22, share: p.share }));
      rec.thinnest_at22 = sticker ? null : sk.thinnest_at22;
      if (rec.thin.length) add('thin-strokes', 'warn', `${name} has lines that blur away at ${sticker ? '160' : '22'} px: ${rec.thin.map((p) => `${p.colour === 'silhouette' ? 'the outer shape' : p.colour} ${p.width_px} px wide (${sticker ? p.at160 : p.at22} px at ${sticker ? '160' : '22'} px)`).join(', ')}. Under ${T.stroke} px on a 1× screen they turn into a faint smear (Palm's threshold).`, `Draw lines at least ${Math.ceil(T.stroke * n / (sticker ? VIEW.sticker : 22))} px wide on the ${n} px canvas, or drop the detail.`);
      // words
      const src = findSource(f, root);
      rec.text = { method: 'none', lines: [] };
      if (src) {
        try { const st = await sourceText(page, src); if (st.S > 0) { rec.text = { method: 'source', source: relative(root || abs, src) || basename(src), lines: st.lines.map((l) => ({ t: l.t, font_px: round(l.fs * n / st.S, 1), at22: round(l.fs * (sticker ? VIEW.sticker : 22) / st.S, 1) })) }; } } catch (e) { rec.text.error = String(e).slice(0, 120); }
      }
      if (rec.text.method !== 'source' && tess && !(ocr === 'auto' && src)) { rec.text = { method: 'ocr (estimate)', lines: await ocrWords(page, px.full.url, n, blank, sticker ? VIEW.sticker : 22) }; }
      else if (ocr === 'always' && tess) rec.text.ocr = await ocrWords(page, px.full.url, n, blank, sticker ? VIEW.sticker : 22);
      const small = rec.text.lines.filter((l) => l.at22 < (sticker ? 14 : T.text));
      if (small.length) add('words-small', 'warn', `${name}'s words are too small to read at ${sticker ? '160' : '22'} px: ${small.map((l) => `"${l.t}" ${l.at22} px`).join(', ')} (Palm's threshold ${sticker ? 14 : T.text} px${rec.text.method.startsWith('ocr') ? '; OCR estimate' : ''}).`, sticker ? 'Make the words bigger.' : 'Use at most 3–4 big letters (or none: a picture says it at emoji size), filling the width.');
      // animation: bright flashes per second
      if (px.frames && px.frames.lum) {
        const L = px.frames.lum, D = px.frames.durs.length ? px.frames.durs : L.map(() => 0.1);
        let flips = 0, last = 0; for (let i = 1; i < L.length; i++) { const dl = L[i] - L[i - 1]; if (Math.abs(dl) >= 0.1) { const s = Math.sign(dl); if (last && s !== last) flips++; last = s; } }
        const secs = D.reduce((s, x) => s + Math.max(x, 0.02), 0) || 1, flashes = flips / 2 / secs;
        rec.flashes_per_s = round(flashes, 1); rec.frame_thumbs = px.frames.thumbs;
        if (!rec.duration_s && D.length) rec.duration_s = round(D.reduce((s, x) => s + x, 0), 2);
        if (flashes > T.flashes) add('flashing', 'warn', `${name} flashes from dark to bright about ${round(flashes, 1)} times a second: tiring to look at in a busy channel (Palm's threshold ${T.flashes}).`, 'Slow it down or soften the change in brightness.');
      }
      files.push(rec);
    }
    // the set
    const em = files.filter((x) => x.kind === 'emoji');
    const set = {
      emoji: em.length, stickers: files.length - em.length,
      sizes: [...new Set(em.map((x) => `${x.w}x${x.h}`))], formats: [...new Set(files.map((x) => x.format))],
      fill_range: em.length ? [Math.min(...em.map((x) => x.fill)), Math.max(...em.map((x) => x.fill))] : null,
      tiles: em.filter((x) => x.tile).length,
      outline_dark_theme_min: em.length ? Math.min(...em.map((x) => Math.min(x.edge.slackDark, x.edge.discordDark))) : null,
      outline_light_min: em.length ? Math.min(...em.map((x) => x.edge.light)) : null,
      animated: files.filter((x) => x.frames > 1).map((x) => x.file),
    };
    if (set.sizes.length > 1) issues.push(issue('set-sizes', 'note', `The emoji come in ${set.sizes.length} sizes (${set.sizes.join(', ')}).`, 'Save them all at 128×128.'));
    if (set.fill_range && set.fill_range[1] - set.fill_range[0] > T.fillSpread) issues.push(issue('set-fill', 'warn', `The emoji fill their squares unevenly (${Math.round(set.fill_range[0] * 100)}–${Math.round(set.fill_range[1] * 100)}%): side by side in a message some look smaller than others.`, 'Fill every square about the same (85–95%).'));
    if (set.tiles && set.tiles < em.length) issues.push(issue('set-tiles', 'warn', `${set.tiles} of ${em.length} emoji sit on solid squares and the rest are cut out: they look like two sets.`, 'Pick one treatment for the set.'));
    // the high-DPI views: the same chats drawn at 2× (shown in the sheet at twice the size)
    const hd = [];
    for (const html of [hdChat('slack', false, files), hdChat('discord', true, files)]) {
      const p2 = await browser.newPage(); await p2.setViewport({ width: 360, height: 300, deviceScaleFactor: 2 });
      await p2.goto(blank); await p2.setContent(`<!doctype html><html><body style="margin:0">${html}</body></html>`, { waitUntil: 'load' });
      const el = await p2.$('body > div'); hd.push(await el.screenshot({ encoding: 'base64' })); await p2.close();
    }
    // the sheet
    const sheet = drawSheet({ files, plain, issues, hd });
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(resolve(out) + '-sheet.html', sheet);
    await page.goto(blank);
    await page.setViewport({ width: 1500, height: 1000, deviceScaleFactor: 1 });
    await page.setContent(sheet, { waitUntil: 'load', timeout: 120000 });
    await page.evaluate(() => Promise.all([...document.images].map((i) => i.complete && i.naturalWidth ? 0 : new Promise((r) => (i.onload = i.onerror = r)))));
    await new Promise((r) => setTimeout(r, 300));
    await page.screenshot({ path: resolve(out) + '-sheet.png', fullPage: true });
    const errors = issues.filter((i) => i.level === 'error').length, warnings = issues.filter((i) => i.level === 'warn').length;
    return {
      ok: errors === 0, errors, warnings,
      files: files.map(({ dataUrl, url22, frame_thumbs, ...r }) => r), set, issues, sheet: resolve(out) + '-sheet.png',
      notes: `Rules: Slack and Discord help and developer pages read ${RULES.read} (see the tool's header). The chat and picker mock-ups, stand-in emoji and thresholds are Palm's approximation (Nov 2026).`,
    };
  } finally { await browser.close(); srv.close(); }
}

// ---------- the sheet ----------
// Stand-in standard emoji: simple shapes drawn by Palm (not any vendor's emoji art).
const STD = {
  smile: '<circle cx="18" cy="18" r="17" fill="#ffcc4d"/><ellipse cx="12" cy="14" rx="2.2" ry="3" fill="#664500"/><ellipse cx="24" cy="14" rx="2.2" ry="3" fill="#664500"/><path d="M9 21q9 9 18 0" stroke="#664500" stroke-width="2.6" fill="none" stroke-linecap="round"/>',
  laugh: '<circle cx="18" cy="18" r="17" fill="#ffcc4d"/><path d="M8 14q4-4 8 0M20 14q4-4 8 0" stroke="#664500" stroke-width="2.4" fill="none" stroke-linecap="round"/><path d="M8 19h20q-1 11-10 11t-10-11z" fill="#664500"/>',
  heart: '<path d="M18 33C6 24 1 17 2 10.5 3 5 8 2 12.5 3.5 15.5 4.5 17 7 18 9c1-2 2.5-4.5 5.5-5.5C28 2 33 5 34 10.5 35 17 30 24 18 33z" fill="#dd2e44"/>',
  check: '<rect x="1" y="1" width="34" height="34" rx="7" fill="#5aa832"/><path d="M9 18l6 6 12-13" stroke="#fff" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  eyes: '<ellipse cx="11" cy="18" rx="8" ry="12" fill="#fff" stroke="#444" stroke-width="1.5"/><ellipse cx="25" cy="18" rx="8" ry="12" fill="#fff" stroke="#444" stroke-width="1.5"/><circle cx="14" cy="20" r="4" fill="#222"/><circle cx="28" cy="20" r="4" fill="#222"/>',
  fire: '<path d="M18 2c3 7 12 11 12 21a12 12 0 0 1-24 0c0-6 4-9 5-13 2 3 2 6 4 7 1-6 0-10 3-15z" fill="#f4900c"/><path d="M18 17c2 4 6 6 6 10a6 6 0 0 1-12 0c0-3 3-5 6-10z" fill="#ffcc4d"/>',
  party: '<path d="M4 33l8-24 16 16z" fill="#c7409b"/><path d="M8 21l7 7M10 15l11 11" stroke="#ffcc4d" stroke-width="2.4"/><circle cx="26" cy="7" r="2.5" fill="#3b88c3"/><circle cx="31" cy="15" r="2" fill="#77b255"/><circle cx="20" cy="4" r="2" fill="#ffcc4d"/><path d="M24 12l7-7" stroke="#dd2e44" stroke-width="2.4" stroke-linecap="round"/>',
  think: '<circle cx="18" cy="18" r="17" fill="#ffcc4d"/><ellipse cx="12" cy="13" rx="2.2" ry="3" fill="#664500"/><ellipse cx="24" cy="13" rx="2.2" ry="3" fill="#664500"/><path d="M12 24h12" stroke="#664500" stroke-width="2.6" stroke-linecap="round"/>',
};
const std = (k, s) => `<svg viewBox="0 0 36 36" width="${s}" height="${s}" style="vertical-align:-${Math.round(s * 0.22)}px;flex:none">${STD[k]}</svg>`;
const STDK = Object.keys(STD);

function chatParts(files) {
  const em = files.filter((f) => f.kind === 'emoji'), st = files.filter((f) => f.kind === 'sticker');
  const E = (i, s, extra = '') => em.length ? `<img src="${em[i % em.length].dataUrl}" width="${s}" height="${s}" style="vertical-align:-${Math.round(s * 0.22)}px;object-fit:contain;flex:none;${extra}">` : std(STDK[i % 8], s);
  return { em, st, E };
}
function slackChat(dark, files, { short = false } = {}) {
  const { em, E } = chatParts(files);
  const bg = dark ? '#1a1d21' : '#fff', fg = dark ? '#d1d2d3' : '#1d1c1d', sub = dark ? '#ababad' : '#616061', pill = dark ? '#222529' : '#f8f8f8', pb = dark ? '#35373b' : '#e8e8e8';
  const r = (inner, n) => `<span style="display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 7px;border-radius:12px;background:${pill};border:1px solid ${pb};font:600 12px system-ui;color:${sub};margin:4px 4px 0 0">${inner}<span>${n}</span></span>`;
  const msg = (who, col, body, reacts = '') => `<div style="display:flex;gap:9px;padding:7px 18px"><div style="width:36px;height:36px;border-radius:8px;background:${col};flex:none;color:#fff;font:700 15px/36px system-ui;text-align:center">${who[0]}</div><div style="min-width:0"><div style="font:900 15px system-ui;color:${fg}">${who} <span style="font:400 12px system-ui;color:${sub}">10:4${who.length % 10}</span></div><div style="font:400 15px/22px system-ui;color:${fg}">${body}</div>${reacts ? `<div>${reacts}</div>` : ''}</div></div>`;
  const n = em.length || 1;
  const rows = [
    msg('Ana', '#2a7f62', `Deploy finished, release 3.2 is live ${E(0, 22)}`, r(E(1, 16), 4) + r(std('check', 16), 3) + r(E(2, 16), 2) + r(std('party', 16), 5)),
    msg('Ben', '#9c4dcc', `Could someone review the login fix before lunch? ${E(3, 22)} ${std('eyes', 22)}`, r(E(4, 16), 1) + r(std('smile', 16), 2)),
    ...(short ? [] : [
      msg('Cara', '#d9822b', `<span style="display:inline-flex;gap:4px">${E(5, 32)}${E(6, 32)}${E(7, 32)}</span>`),
      msg('Dev', '#3a6ea5', `Standup moved to 10:30 ${std('think', 22)} new emoji are up ${Array.from({ length: Math.min(n, 8) }, (_, i) => E(i, 22)).join(' ')}`, Array.from({ length: Math.min(n, 6) }, (_, i) => r(E(i + 2, 16), (i * 3) % 7 + 1)).join('') + r(std('heart', 16), 2)),
    ]),
  ];
  return `<div style="width:${short ? 350 : 700}px;background:${bg};border-radius:10px;overflow:hidden;flex:none;border:1px solid ${dark ? '#000' : '#ddd'}"><div style="padding:10px 18px;border-bottom:1px solid ${pb};font:900 16px system-ui;color:${fg}"># releases</div>${rows.join('')}<div style="margin:6px 18px 14px;border:1px solid ${dark ? '#565856' : '#bbb'};border-radius:8px;padding:9px 12px;font:15px system-ui;color:${sub}">Message #releases</div></div>`;
}
function discordChat(dark, files, { short = false } = {}) {
  const { em, st, E } = chatParts(files);
  const bg = dark ? '#313338' : '#fff', fg = dark ? '#dbdee1' : '#313338', sub = dark ? '#949ba4' : '#5c5e66', pill = dark ? '#2b2d31' : '#ebedef', head = dark ? '#f2f3f5' : '#060607';
  const r = (inner, n) => `<span style="display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 7px;border-radius:8px;background:${pill};font:600 14px system-ui;color:${sub};margin:4px 4px 0 0">${inner}<span>${n}</span></span>`;
  const msg = (who, col, body, reacts = '') => `<div style="display:flex;gap:14px;padding:8px 16px"><div style="width:40px;height:40px;border-radius:50%;background:${col};flex:none;color:#fff;font:700 16px/40px system-ui;text-align:center">${who[0]}</div><div style="min-width:0"><div style="font:500 16px system-ui;color:${head}">${who} <span style="font:400 12px system-ui;color:${sub}">Today at 18:0${who.length}</span></div><div style="font:400 16px/22px system-ui;color:${fg}">${body}</div>${reacts ? `<div>${reacts}</div>` : ''}</div></div>`;
  const rows = [
    msg('mika', '#5865f2', `welcome to everyone who joined this week ${E(0, 22)}`, r(E(1, 16), 12) + r(std('heart', 16), 7) + r(E(2, 16), 3)),
    msg('jo_r', '#eb459e', `the new build fixed my sync problem ${E(3, 22)} thanks!`, r(E(4, 16), 5) + r(std('laugh', 16), 2)),
    ...(short ? [] : [
      msg('ravi', '#57a773', `<span style="display:inline-flex;gap:4px">${E(5, 48)}${E(6, 48)}</span>`),
      ...st.map((s, i) => msg(['ana', 'tess', 'kofi', 'lee'][i % 4], ['#f0b232', '#23a55a', '#e67e22', '#3498db'][i % 4], `<img src="${s.dataUrl}" width="160" height="160" style="display:block;margin-top:4px;object-fit:contain">`)),
      msg('sam', '#9b59b6', `release notes are pinned ${std('fire', 22)} ${E(7, 22)}`, Array.from({ length: Math.min(em.length || 1, 6) }, (_, i) => r(E(i + 1, 16), (i * 5) % 9 + 1)).join('')),
    ]),
  ];
  return `<div style="width:${short ? 350 : 700}px;background:${bg};border-radius:10px;overflow:hidden;flex:none;border:1px solid ${dark ? '#1e1f22' : '#ddd'}"><div style="padding:12px 16px;border-bottom:1px solid ${dark ? '#26282c' : '#e3e5e8'};font:600 16px system-ui;color:${head}"># general</div>${rows.join('')}<div style="margin:6px 16px 14px;background:${dark ? '#383a40' : '#ebedef'};border-radius:8px;padding:11px 14px;font:15px system-ui;color:${sub}">Message #general</div></div>`;
}
function hdChat(app, dark, files) { return app === 'slack' ? slackChat(dark, files, { short: true }) : discordChat(dark, files, { short: true }); }
function picker(app, dark, files) {
  const { em } = chatParts(files);
  const bg = dark ? (app === 'slack' ? '#1a1d21' : '#2b2d31') : '#fff', fg = dark ? '#d1d2d3' : '#1d1c1d', sub = dark ? '#949ba4' : '#616061';
  const cell = (inner) => `<div style="width:40px;height:40px;display:flex;align-items:center;justify-content:center">${inner}</div>`;
  const customs = em.map((e) => cell(`<img src="${e.dataUrl}" width="32" height="32" style="object-fit:contain">`)).join('');
  const stds = Array.from({ length: 16 }, (_, i) => cell(std(STDK[i % 8], 32))).join('');
  return `<div style="width:380px;background:${bg};border-radius:10px;padding:10px;flex:none;border:1px solid ${dark ? '#000' : '#ddd'};box-shadow:0 4px 14px rgba(0,0,0,.15)"><div style="border:1px solid ${dark ? '#444' : '#ccc'};border-radius:6px;padding:6px 10px;font:14px system-ui;color:${sub};margin-bottom:8px">Search all emoji</div><div style="font:700 12px system-ui;color:${sub};margin:6px 4px">${app === 'slack' ? 'Custom' : 'This server'}</div><div style="display:flex;flex-wrap:wrap">${customs}</div><div style="font:700 12px system-ui;color:${sub};margin:10px 4px 6px">Smileys &amp; people</div><div style="display:flex;flex-wrap:wrap">${stds}</div></div>`;
}

export function drawSheet({ files, plain, issues = [], hd = [] }) {
  const em = files.filter((f) => f.kind === 'emoji'), st = files.filter((f) => f.kind === 'sticker');
  const checker = 'background:repeating-conic-gradient(#ddd 0% 25%,#fff 0% 50%) 0 0/16px 16px';
  const at22 = (f, bg) => `<div style="background:${bg};padding:6px;display:inline-block"><img src="${f.url22}" width="88" height="88" style="image-rendering:pixelated;display:block"></div>`;
  const fileCard = (f) => {
    const big = f.kind === 'sticker' ? 160 : 128;
    const meas = plain ? '' : `<div style="font:11px/1.4 ui-monospace,monospace;color:#444;margin-top:4px;max-width:${big + 200}px">${f.format} ${f.w}×${f.h} ${f.kb} KB${f.frames > 1 ? ` · ${f.frames} frames ${f.duration_s ?? '?'} s` : ''} · fill ${Math.round(f.fill * 100)}% · edge light/Slack dark/Discord dark ${Math.round(f.edge.light * 100)}/${Math.round(f.edge.slackDark * 100)}/${Math.round(f.edge.discordDark * 100)}%${f.thinnest_at22 != null ? ` · thinnest ${f.thinnest_at22} px at 22` : ''}${f.text.lines.length ? ` · words: ${f.text.lines.map((l) => `"${esc(l.t)}" ${l.at22}px`).join(', ')}` : ''}</div>`;
    const frames = f.frame_thumbs?.length ? `<div style="display:flex;gap:2px;margin-top:6px;${checker}">${f.frame_thumbs.map((t) => `<img src="${t}" width="48" height="48">`).join('')}</div>` : '';
    return `<figure style="margin:0;display:flex;gap:10px;align-items:flex-start;background:#fff;padding:10px;border-radius:8px"><div><div style="width:${big}px;height:${big}px;${checker}"><img src="${f.dataUrl}" width="${big}" height="${big}" style="display:block;object-fit:contain"></div><figcaption style="font:600 12px system-ui;margin-top:4px">${esc(f.file)}</figcaption>${frames}</div>${f.kind === 'emoji' ? `<div><div style="font:11px system-ui;color:#555;margin-bottom:4px">22 px, real pixels ×4: light · Slack dark · Discord dark</div><div style="display:flex;gap:4px">${at22(f, '#fff')}${at22(f, '#1a1d21')}${at22(f, '#313338')}</div>${meas}</div>` : `<div>${meas}</div>`}</figure>`;
  };
  const head = `Custom emoji${st.length ? ' and stickers' : ''}: ${em.length} emoji${st.length ? `, ${st.length} sticker${st.length > 1 ? 's' : ''}` : ''}, where people see them, among standard emoji (stand-ins drawn by Palm; Palm's approximation of Slack and Discord, Nov 2026)`;
  const iss = plain || !issues.length ? '' : `<div class="sec" style="background:#fff4f0"><h2>What the check found</h2><ul style="font:13px/1.5 system-ui;margin:0;padding-left:18px">${issues.filter((i) => i.level !== 'note').map((i) => `<li><b>${i.level}</b> ${esc(i.msg)}</li>`).join('')}</ul></div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;width:1500px;background:#ecebe8;font-family:system-ui,sans-serif}.sec{padding:18px 22px}.row{display:flex;gap:20px;flex-wrap:wrap;align-items:flex-start}h2{font:600 15px system-ui;margin:0 0 12px;color:#333}</style></head><body>
<div class="sec" style="background:#222"><h2 style="color:#eee;font-size:16px">${head}</h2></div>${iss}
<div class="sec"><h2>Slack on a normal (1×) screen: messages with emoji at 22 px, reactions at 16 px, an emoji-only message at 32 px (light, dark)</h2><div class="row">${slackChat(false, files)}${slackChat(true, files)}</div></div>
<div class="sec"><h2>Discord on a normal (1×) screen: messages at 22 px, reactions at 16 px, an emoji-only message at 48 px${st.length ? ', stickers at 160 px' : ''} (light, dark)</h2><div class="row">${discordChat(false, files)}${discordChat(true, files)}</div></div>
<div class="sec" style="background:#d9d7d2"><h2>On a high-DPI (2×) screen, shown at twice the size: Slack light, Discord dark</h2><div class="row">${hd.map((b) => `<img src="data:image/png;base64,${b}" style="display:block;flex:none">`).join('')}</div></div>
<div class="sec"><h2>The emoji picker at 32 px: Slack light, Discord dark, Slack dark</h2><div class="row">${picker('slack', false, files)}${picker('discord', true, files)}${picker('slack', true, files)}</div></div>
<div class="sec"><h2>The files as uploaded (checkerboard = transparent)${em.length ? ', and each emoji at 22 px in real pixels, enlarged 4×' : ''}</h2><div class="row">${files.map(fileCard).join('')}</div></div>
</body></html>`;
}

// ---------- render SVG/HTML to a transparent PNG ----------
async function openSized(page, abs, w, h) {
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  if (/\.svg$/i.test(abs)) {
    const svg = readFileSync(abs, 'utf8');
    await page.setContent(`<!doctype html><html><head><style>html,body{margin:0;width:${w}px;height:${h}px;background:transparent;overflow:hidden}svg{display:block;width:${w}px;height:${h}px}</style></head><body>${svg.replace(/<\?xml[^>]*>/, '')}</body></html>`, { waitUntil: 'load' });
  } else await page.goto(pathToFileURL(abs).href, { waitUntil: 'load', timeout: 60000 });
  await page.evaluate(() => document.fonts?.ready); await new Promise((r) => setTimeout(r, 200));
}
export async function render(file, { out, size = '128x128' } = {}) {
  const [w, h] = String(size).split('x').map(Number);
  if (!w || !h) throw new Error('--size WxH, e.g. 128x128');
  const abs = resolve(file), o = resolve(out || abs.replace(/\.(svg|html?)$/i, '.png'));
  const browser = await launch();
  try {
    const page = await browser.newPage();
    await openSized(page, abs, w, h);
    mkdirSync(dirname(o), { recursive: true });
    await page.screenshot({ path: o, type: 'png', omitBackground: true, clip: { x: 0, y: 0, width: w, height: h } });
  } finally { await browser.close(); }
  return { ok: true, out: o, w, h, kb: round(statSync(o).size / 1024, 1), next: `node emoji-check.mjs check <folder> --out look/emoji, then look at the sheet` };
}
export async function animate(file, { out, size = '128x128', fps = 12, seconds = 1.5 } = {}) {
  const [w, h] = String(size).split('x').map(Number);
  const abs = resolve(file), o = resolve(out || abs.replace(/\.html?$/i, '.gif'));
  const n = Math.max(2, Math.round(fps * seconds)), dir = mkdtempSync(join(tmpdir(), 'emoji-frames-'));
  const browser = await launch();
  try {
    const page = await browser.newPage();
    await openSized(page, abs, w, h);
    for (let i = 0; i < n; i++) {
      const t = i / fps;
      await page.evaluate((t) => { for (const a of document.getAnimations()) { a.pause(); a.currentTime = t * 1000; } if (typeof window.palmFrame === 'function') window.palmFrame(t); }, t);
      await page.screenshot({ path: join(dir, `f${String(i).padStart(3, '0')}.png`), type: 'png', omitBackground: true, clip: { x: 0, y: 0, width: w, height: h } });
    }
  } finally { await browser.close(); }
  mkdirSync(dirname(o), { recursive: true });
  const inp = ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', String(fps), '-i', join(dir, 'f%03d.png')];
  if (/\.gif$/i.test(o)) execFileSync('ffmpeg', [...inp, '-filter_complex', 'split[a][b];[a]palettegen=reserve_transparent=1:max_colors=128[p];[b][p]paletteuse=alpha_threshold=128:dither=none', '-loop', '0', o]);
  else execFileSync('ffmpeg', [...inp, '-plays', '0', '-f', 'apng', o]);
  rmSync(dir, { recursive: true, force: true });
  const info = imageInfo(readFileSync(o));
  return { ok: true, out: o, w, h, frames: info.frames, seconds: round(n / fps, 2), kb: round(statSync(o).size / 1024, 1) };
}

// ---------- self-test ----------
async function selfTest() {
  const d = mkdtempSync(join(tmpdir(), 'emoji-check-'));
  const good = join(d, 'good'), bad = join(d, 'bad'); mkdirSync(join(good, 'stickers'), { recursive: true }); mkdirSync(bad);
  // good: bold, filled, white keyline round a dark shape, 3 big letters, a sticker at 320
  writeFileSync(join(good, 'ok_shipped.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect x="4" y="4" width="120" height="120" rx="26" fill="#1d2b4f" stroke="#fff" stroke-width="8"/><text x="64" y="84" text-anchor="middle" font-family="Arial" font-weight="900" font-size="58" fill="#ffd166">OK</text></svg>');
  writeFileSync(join(good, 'heart_us.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path d="M64 118C20 86 2 62 6 36 9 16 28 4 44 9c10 3 16 11 20 18 4-7 10-15 20-18 16-5 35 7 38 27 4 26-14 50-58 82z" fill="#ff6f59" stroke="#fff" stroke-width="8" stroke-linejoin="round"/></svg>');
  writeFileSync(join(good, 'stickers', 'hello.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320"><circle cx="160" cy="160" r="150" fill="#2bb3a6" stroke="#fff" stroke-width="12"/><text x="160" y="190" text-anchor="middle" font-family="Arial" font-weight="900" font-size="90" fill="#fff">HI!</text></svg>');
  for (const f of ['ok_shipped', 'heart_us']) await render(join(good, f + '.svg'), { out: join(good, f + '.png'), size: '128x128' });
  await render(join(good, 'stickers', 'hello.svg'), { out: join(good, 'stickers', 'hello.png'), size: '320x320' });
  const g = await check(good, { out: join(d, 'good') });
  const gw = g.issues.filter((i) => i.level !== 'note');
  if (gw.length) throw new Error('good: ' + JSON.stringify(gw, null, 1));
  // bad: dark navy thin-line logo with lots of padding, long small words, hyphenated name, non-square, an opaque JPEG, a big file
  writeFileSync(join(bad, 'looks-good-to-me.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><circle cx="64" cy="64" r="30" fill="none" stroke="#1d2b4f" stroke-width="2"/><text x="64" y="69" text-anchor="middle" font-family="Arial" font-size="12" fill="#1d2b4f">looks good</text></svg>');
  await render(join(bad, 'looks-good-to-me.svg'), { out: join(bad, 'looks-good-to-me.png'), size: '128x128' });
  writeFileSync(join(bad, 'wide.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 128"><rect width="200" height="128" rx="20" fill="#ff6f59"/></svg>');
  await render(join(bad, 'wide.svg'), { out: join(bad, 'wide.png'), size: '200x128' });
  writeFileSync(join(d, 'noise.html'), '<html><body style="margin:0"><canvas id="c" width="512" height="512"></canvas><script>const c=document.getElementById("c"),x=c.getContext("2d"),D=x.createImageData(512,512);let s=3;for(let i=0;i<D.data.length;i++)D.data[i]=(s=(s*16807)%2147483647)&255;x.putImageData(D,0,0)</script></body></html>');
  await render(join(d, 'noise.html'), { out: join(bad, 'huge.png'), size: '512x512' });
  // an animated GIF that flashes black and white, frames too fast
  writeFileSync(join(d, 'flash.html'), '<html><head><style>html,body{margin:0;width:128px;height:128px;background:transparent}div{width:128px;height:128px;border-radius:50%;animation:f .2s steps(1) infinite}@keyframes f{0%{background:#000}50%{background:#fff}}</style></head><body><div></div></body></html>');
  await animate(join(d, 'flash.html'), { out: join(bad, 'flash.gif'), fps: 50, seconds: 1 });
  const b = await check(bad, { out: join(d, 'bad') });
  const ids = b.issues.map((i) => i.id);
  for (const want of ['edge-slackDark', 'padded', 'thin-strokes', 'words-small', 'discord-refuses', 'not-square', 'slack-refuses', 'flashing']) if (!ids.includes(want)) throw new Error('bad: expected ' + want + ' in ' + ids.join(',') + '\n' + JSON.stringify(b.files.map((f) => ({ f: f.file, edge: f.edge, fill: f.fill, thin: f.thin, text: f.text, fl: f.flashes_per_s, md: f.min_delay_s })), null, 1));
  const fl = b.files.find((f) => f.file === 'flash.gif'); if (!(fl.frames > 10 && fl.loops === 0)) throw new Error('gif parse: ' + JSON.stringify(fl));
  console.log(`emoji-check: all tests pass (bad found: ${[...new Set(ids)].join(', ')}; sheets in ${d})`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (k, dflt) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : dflt; };
  const VALUED = new Set(['--out', '--size', '--ocr', '--fps', '--seconds', '--root']);
  const pos = argv.filter((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1]));
  const done = (r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); };
  const fail = (e) => { console.error(String(e.message || e)); process.exit(2); };
  if (argv.includes('--self-test') || argv.includes('--test')) selfTest().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
  else if (pos[0] === 'render' && pos[1]) render(pos[1], { out: opt('out'), size: opt('size', '128x128') }).then(done, fail);
  else if (pos[0] === 'animate' && pos[1]) animate(pos[1], { out: opt('out'), size: opt('size', '128x128'), fps: +opt('fps', 12), seconds: +opt('seconds', 1.5) }).then(done, fail);
  else if (pos[0] === 'check' && pos[1]) check(pos[1], { out: opt('out', 'look/emoji'), plain: argv.includes('--plain'), ocr: opt('ocr', 'auto'), root: opt('root', null) }).then(done, fail);
  else fail('usage: emoji-check.mjs check <folder> [--out look/emoji] [--plain]\n       emoji-check.mjs render <file.svg|html> [--size 128x128] [--out emoji/name.png]\n       emoji-check.mjs animate <anim.html> [--size 128x128] [--fps 12] [--seconds 1.5] --out emoji/name.gif\n       emoji-check.mjs --self-test');
}
