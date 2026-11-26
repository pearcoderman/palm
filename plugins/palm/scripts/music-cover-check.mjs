#!/usr/bin/env node
// Palm tool: music-cover-check — lets an agent see a single's or EP's cover art where listeners see it, and measures
// what distributors reject and what fails at small sizes. A 3000×3000 cover is mostly seen tiny: a 40–64 px tile in a
// playlist row or the mini player, a lock-screen or car-screen tile, an album grid among other releases; at full size
// only on Now Playing and the release page. Distributors (DistroKid, TuneCore, CD Baby) and Apple check the file and
// what's written on it before it goes live.
//
//   node music-cover-check.mjs check <cover.jpg | folder> --artist "Name" --title "Release title" [--label "Label"]
//                                    [--explicit] [--out look/cover] [--plain] [--ocr auto|always|never]
//       → JSON {ok, errors, warnings, cover:{…}, text:{…}, sharpness:{…}, issues, sheet}. Then LOOK at <out>-sheet.png.
//       A folder: its cover.jpg/cover.png, else its biggest square image. Keep the HTML/SVG the cover was made from
//       beside it with the same name (cover.html), so its words can be measured exactly.
//   node music-cover-check.mjs info <photo | folder>
//       → each photo's size and how much of a 3000 px cover a square crop of it can fill without being enlarged.
//   node music-cover-check.mjs render <cover.html> [--size 3000x3000] [--out cover.jpg]
//       → renders the HTML at exactly that size (JPG, RGB; or PNG without alpha).
//   node music-cover-check.mjs --self-test
//
// Facts: see RULES below (each with its source and the date it was read).
// Palm's approximation of the apps (Nov 2026; none of them publish these): playlist rows with a 48 px tile on a phone
//   and 40 px on a desktop, the mini player's 40 px tile, a lock-screen player's 64 px tile, album/release grids at
//   ~160–180 px, a car screen's ~140 px tile, Now Playing at ~340 px with rounded corners; stand-in neighbour covers.
// Palm's thresholds (guidance, not a platform rule): the cover's biggest words at least 5 px (font size) on a 48 px row
//   tile; every line of words at least 7 px on a 160 px grid tile; text contrast 3:1 or more against what's behind it.
// Text: from the cover's HTML/SVG source (each line measured in the page), else from the image with Tesseract OCR if
//   installed (Palm's estimate: a line's box height ÷ 0.75 ≈ its font size; OCR misses styled lettering and can misread).
// Sharpness (Palm's estimate): in each detailed part of the cover, how much of the finest detail is there compared
//   with the next-coarser detail; an image enlarged from a smaller one (or blurred) has almost none of the finest.
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
const launch = () => loadPuppeteer().launch({ executablePath: findChrome(), headless: true, timeout: 90000, protocolTimeout: 240000, args: ['--no-sandbox', '--hide-scrollbars', '--allow-file-access-from-files'] });

// ---------- the rules (sources and dates) ----------
// Read 2026-11-26 (WebFetch got 403 on the Zendesk help centres, so those were read in headless Chrome):
//   DistroKid Help, "What Are the Requirements for Album Artwork?" (support.distrokid.com/hc/en-us/articles/360013534334):
//     .jpg; at least 1000×1000, ideally a perfect square 3000×3000 (smaller or non-square art is adjusted automatically);
//     RGB (CMYK or greyscale can give an error); stores reject art with a URL, QR codes, a page name on X, blurry,
//     pixelated, rotated or poor-quality images, unlicensed or stock photos, prices, streaming-service logos (iTunes,
//     Spotify), social media logos (X, Instagram, TikTok), nudity, references to physical media ("CD"); duplicate art
//     across releases may be rejected. A rejected cover is swapped with "Replace Artwork".
//   TuneCore, "What are TuneCore's cover art formatting requirements?" (support.tunecore.com/hc/en-us/articles/115006685728):
//     JPG, PNG or GIF under 10 MB; a perfect square, at least 1600×1600 and no larger than 3000×3000; RGB (black and
//     white too); text only the artist name and release title exactly as entered, or none; no extra or mismatched text,
//     email, URLs, contact info, pricing, "CD", "DVD", "Digital Exclusive", cut-off or blurry art, art in a corner with
//     white space round it, store names or logos.
//   CD Baby, "Artwork Requirements" (support.cdbaby.com/hc/en-us/articles/360037660592): 1400×1400 minimum, 3000×3000
//     maximum; PNG, GIF, JPG; under 25 MB; RGB not CMYK; an artist name or title on the art must precisely match;
//     generic art (a solid colour square with no text) may not be accepted. "What are the cover art guidelines and
//     restrictions?" (…/210998563): no URLs, social handles or symbols (@username), contact info, pricing, barcodes or
//     QR codes, other formats (vinyl, CD, "digital exclusive"), blurry/pixelated/distorted images, ads for merch or
//     other albums, "the word 'new' or any other time-sensitive references"; text must match the metadata exactly.
//   Spotify for Artists, "Cover art requirements" (support.spotify.com/us/artists/article/cover-art-requirements/):
//     TIFF, PNG or JPG, 640–10000 px, 1:1, sRGB 24 bits per pixel; "Don't upscale images"; no embedded colour profiles
//     or orientation metadata.
//   Apple Music for Artists, "Album cover art on Apple Music" (artists.apple.com/support/1120-cover-art): JPG, PNG or
//     GIF, a perfect square, at least 4000×4000; only the artist name and the release title exactly as released; no
//     blurry, pixelated, tilted or cropped images unless intended; no social handles, email, website, logos or
//     competitors; no pricing; no brands or advertising; "No year or dates"; no barcodes; no Parental Advisory logo on
//     a release that isn't explicit. Apple's Video and Audio Asset Guide (Music Album Cover Art Profile): JPG or PNG,
//     RGB, square, 3000×3000 recommended, 1400×1400 minimum (Apple's two pages disagree). Apple Music Style Guide 2.5,
//     section 7: no website addresses, logos, QR codes, release dates, audio-format words (Dolby Atmos, spatial audio,
//     lossless, hi-res, 24-bit…), pricing, physical packaging or retailers.
//   Bandcamp Help, "Bandcamp design tutorial": square, at least 1400×1400 (bigger is better).
//   So one file fits all of them: 3000×3000, RGB, JPG (DistroKid names only .jpg), no transparency.
//   YouTube Music's own artwork page wasn't read.
export const RULES = {
  read: '2026-11-26',
  best: 3000, minAll: 1400, tunecoreMin: 1600, distroMinPx: 1000, maxPx: 3000, maxMB: 10,
};

// ---------- the file ----------
export function imageInfo(b) {
  if (!b || b.length < 12) return { format: 'unknown' };
  if (b.readUInt32BE(0) === 0x89504e47) {
    const ct = b[25], bits = b[24];
    return { format: 'png', w: b.readUInt32BE(16), h: b.readUInt32BE(20), bits, mode: { 0: 'greyscale', 2: 'RGB', 3: 'palette', 4: 'greyscale+alpha', 6: 'RGBA' }[ct] || 'unknown', alpha: ct === 4 || ct === 6 || b.includes(Buffer.from('tRNS')) };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let adobe = null, dpi = null;
    for (let i = 2; i < b.length - 9;) {
      if (b[i] !== 0xff) { i++; continue; }
      const mk = b[i + 1]; if (mk === 0xd8 || mk === 0x01 || (mk >= 0xd0 && mk <= 0xd7) || mk === 0xff) { i += mk === 0xff ? 1 : 2; continue; }
      const len = b.readUInt16BE(i + 2);
      if (mk === 0xe0 && b.toString('latin1', i + 4, i + 9) === 'JFIF\0') { const unit = b[i + 11], dx = b.readUInt16BE(i + 12); dpi = unit === 1 ? dx : unit === 2 ? Math.round(dx * 2.54) : null; }
      if (mk === 0xee && b.toString('latin1', i + 4, i + 9) === 'Adobe') adobe = b[i + 15];
      if (mk >= 0xc0 && mk <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(mk)) {
        const nf = b[i + 9];
        return { format: 'jpeg', w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5), bits: b[i + 4], progressive: mk === 0xc2, mode: nf === 1 ? 'greyscale' : nf === 3 ? 'RGB' : nf === 4 ? (adobe === 2 ? 'YCCK' : 'CMYK') : 'unknown', alpha: false, dpi };
      }
      i += 2 + len;
    }
    return { format: 'jpeg' };
  }
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return { format: 'webp' };
  if (b.toString('latin1', 0, 3) === 'GIF') return { format: 'gif', w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  if (b.toString('latin1', 4, 12).includes('ftyp')) return { format: 'heic/avif' };
  return { format: 'unknown' };
}

// ---------- Palm's approximation of the apps (Nov 2026) ----------
export const TILE = { row: 48, desktopRow: 40, mini: 40, lock: 64, grid: 160, car: 140, nowPlaying: 340 };
const MIN_HEAD_ROW = 5, MIN_GRID = 7, MIN_CONTRAST = 3;
const issue = (id, level, msg, fix) => ({ id, level, msg, fix });
const round = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d;
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();

// What distributors and Apple turn away when it's written on a cover (see RULES.sources).
const BANNED = [
  { id: 'url', re: /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|net|org|io|co|uk|fm|me|app|link|music|bandcamp\.com)\b/i, what: 'a web address' },
  { id: 'email', re: /\b[\w.+-]+@[\w-]+\.[\w.]+\b/, what: 'an email address' },
  { id: 'handle', re: /(?:^|\s)@[\w.]{2,}/, what: 'a social media handle' },
  { id: 'social', re: /\b(instagram|insta|tiktok|twitter|facebook|snapchat|youtube|soundcloud|follow me|follow us)\b/i, what: 'a social network or "follow" line' },
  { id: 'store', re: /\b(spotify|apple music|itunes|amazon music|deezer|tidal|youtube music|pandora|distrokid|tunecore|cd ?baby|google play|bandcamp)\b/i, what: 'a store or streaming service name' },
  { id: 'promo', re: /\b(out now|new single|new ep|new album|new music|available (?:now|on|everywhere)|pre-?save|pre-?order|stream(?:ing)? (?:now|on|it)|listen (?:now|on)|coming soon|out (?:on|this|friday|fri)\b|exclusive|limited edition|free download|buy now)\b/i, what: 'promotional text' },
  { id: 'price', re: /[$£€¥]\s?\d|\b\d+(?:[.,]\d\d)?\s?(?:usd|gbp|eur)\b|\bfree\b/i, what: 'a price' },
  { id: 'date', re: /\b\d{1,2}(?:st|nd|rd|th)?[\s./-]+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?\b|\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b/i, what: 'a release date' },
  { id: 'format-ref', re: /\b(cd|dvd|vinyl|compact disc|cassette|digital (?:exclusive|version)|dolby atmos|spatial audio|lossless|hi-?res|24-?bit)\b/i, what: 'a reference to a format or physical media' },
  { id: 'new', re: /\bnew\b/i, what: 'a time-sensitive word ("new")' },
  { id: 'year', re: /\b(?:19[5-9]\d|20[0-4]\d)\b/, what: 'a year' },
  { id: 'advisory', re: /\b(parental advisory|explicit content|explicit lyrics)\b/i, what: 'a Parental Advisory label' },
];

// ---------- text from the source (HTML or SVG) ----------
async function measureSource(page, src, img) {
  const url = pathToFileURL(resolve(src)).href;
  const load = async (w, h) => { await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 }); await page.goto(url, { waitUntil: 'load', timeout: 60000 }); await page.evaluate(() => document.fonts?.ready); await new Promise((r) => setTimeout(r, 200)); };
  await load(img.w, img.h);
  // a design made at 1000×1000 but rendered at 3× sits in the top-left of a bigger viewport: find its real size
  const ext = await page.evaluate(() => { let r = 0, b = 0; for (const e of document.querySelectorAll('body *, svg')) { const q = e.getBoundingClientRect(); if (q.width && q.height) { r = Math.max(r, q.right); b = Math.max(b, q.bottom); } } return { r, b }; });
  let W = img.w, H = img.h;
  if (ext.r > 100 && ext.r < img.w * 0.8 && Math.abs(ext.r / ext.b - img.w / img.h) < 0.05) { W = Math.round(ext.r); H = Math.round(ext.b); await load(W, H); }
  const res = await page.evaluate(async () => {
    const out = [];
    const rgb = (s) => (s.match(/[\d.]+/g) || []).slice(0, 4).map(Number);
    for (const e of document.querySelectorAll('body *, svg *')) {
      const s = getComputedStyle(e); if (s.visibility === 'hidden' || s.display === 'none' || +s.opacity <= 0.05) continue;
      if (['SCRIPT', 'STYLE', 'TITLE'].includes(e.tagName)) continue;
      const own = [...e.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()); if (!own.length) continue;
      const rg = document.createRange(); rg.selectNodeContents(e); const rects = [...rg.getClientRects()].filter((r) => r.width > 1 && r.height > 1); if (!rects.length) continue;
      const r = rg.getBoundingClientRect();
      if (r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) continue;
      let fs = parseFloat(s.fontSize);
      if (e instanceof SVGElement && e.getScreenCTM) { const m = e.getScreenCTM(); if (m) fs *= Math.hypot(m.a, m.b); }
      else { let k = 1; for (let p = e; p && p.nodeType === 1; p = p.parentElement) { const t = getComputedStyle(p).transform; if (t && t !== 'none') { const m = new DOMMatrix(t); k *= Math.hypot(m.a, m.b); } } fs *= k; }
      const strokeW = parseFloat(s.webkitTextStrokeWidth || 0) || (e instanceof SVGElement ? parseFloat(s.strokeWidth || 0) * (s.stroke !== 'none' ? 1 : 0) : 0);
      const extra = [];
      if (strokeW > 0) extra.push(rgb(e instanceof SVGElement ? s.stroke : s.webkitTextStrokeColor));
      if (s.textShadow && s.textShadow !== 'none') for (const m of s.textShadow.matchAll(/rgba?\([^)]+\)/g)) extra.push(rgb(m[0]));
      const tt = s.textTransform;
      let t = own.map((n) => n.textContent.trim()).join(' ').replace(/\s+/g, ' ');
      if (tt === 'uppercase') t = t.toUpperCase(); else if (tt === 'lowercase') t = t.toLowerCase();
      out.push({ t: t.slice(0, 80), x: r.left, y: r.top, w: r.width, h: r.height, fs, color: rgb(e instanceof SVGElement ? s.fill : s.color), extra });
    }
    // photos and images in the design: how much each is enlarged where it's drawn
    const pics = [];
    const add = async (el, src, nw, nh, fit) => { const r = el.getBoundingClientRect(); const vw = Math.min(r.right, innerWidth) - Math.max(r.left, 0), vh = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0); if (vw <= 0 || vh <= 0 || !nw || !nh) return; const sc = fit === 'contain' ? Math.min(r.width / nw, r.height / nh) : fit === 'fill' ? Math.max(r.width / nw, r.height / nh) : Math.max(r.width / nw, r.height / nh); pics.push({ src: String(src).slice(-80), nw, nh, scale: sc, area: vw * vh / (innerWidth * innerHeight) }); };
    for (const im of document.images) { const s = getComputedStyle(im); if (s.display === 'none' || s.visibility === 'hidden') continue; await add(im, im.currentSrc || im.src, im.naturalWidth, im.naturalHeight, s.objectFit); }
    for (const e of document.querySelectorAll('*')) { const bg = getComputedStyle(e).backgroundImage; const m = bg && bg.match(/url\(["']?([^"')]+)["']?\)/); if (!m) continue; const im = new Image(); im.src = m[1]; try { await im.decode(); } catch { continue; } const bs = getComputedStyle(e).backgroundSize; await add(e, m[1], im.naturalWidth, im.naturalHeight, bs === 'contain' ? 'contain' : 'cover'); }
    for (const im of document.querySelectorAll('svg image')) { const href = im.getAttribute('href') || im.getAttribute('xlink:href'); const i2 = new Image(); i2.src = new URL(href, location.href).href; try { await i2.decode(); } catch { continue; } await add(im, href, i2.naturalWidth, i2.naturalHeight, 'cover'); }
    return { boxes: out, pics };
  });
  const k = img.w / W;
  for (const b of res.boxes) { b.x *= k; b.y *= k; b.w *= k; b.h *= k; b.fs *= k; }
  for (const p of res.pics) p.scale = Math.round(p.scale * k * 100) / 100;     // enlargement in the final cover's pixels
  return { design: { w: W, h: H }, boxes: res.boxes, pics: res.pics };
}

// ---------- text from the image (Tesseract OCR, if installed) ----------
function hasTesseract() { try { execFileSync('tesseract', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } }
// Tesseract reads display type better from a smaller copy, so it reads the cover at 1000 and 2000 px (drawn by Chrome)
// and keeps each word once.
export async function ocrBoxes(file, page) {
  const words = [], buf = readFileSync(file), info = imageInfo(buf), tmp = mkdtempSync(join(tmpdir(), 'mcc-ocr-'));
  const sizes = page && info.w ? [1000, 2000].filter((z) => z < info.w * 0.95) : [];
  const runs = [];
  for (const z of sizes) {
    await page.setContent('<html><body></body></html>');
    // plain, then (at 1000 px) only the near-white and only the near-black pixels, as black on white: white or black
    // words over a busy photo read far better that way
    for (const mode of z === 1000 ? ['plain', 'light', 'dark'] : ['plain']) {
      const b64 = await page.evaluate(async (src, z, mode) => { const im = new Image(); im.src = src; await im.decode(); const c = document.createElement('canvas'); c.width = c.height = z; const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(im, 0, 0, z, z * im.naturalHeight / im.naturalWidth); if (mode !== 'plain') { const d = x.getImageData(0, 0, z, z), p = d.data; for (let i = 0; i < p.length; i += 4) { const l = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2], sat = Math.max(p[i], p[i + 1], p[i + 2]) - Math.min(p[i], p[i + 1], p[i + 2]); const on = mode === 'light' ? l > 200 && sat < 40 : l < 45 && sat < 40; p[i] = p[i + 1] = p[i + 2] = on ? 0 : 255; } x.putImageData(d, 0, 0); } return c.toDataURL('image/png').split(',')[1]; }, `data:image/${info.format === 'png' ? 'png' : 'jpeg'};base64,${buf.toString('base64')}`, z, mode);
      const f2 = join(tmp, `ocr-${z}-${mode}.png`); writeFileSync(f2, Buffer.from(b64, 'base64')); runs.push([f2, info.w / z]);
    }
  }
  if (!runs.length) runs.push([file, 1]);
  for (const [f2, k] of runs) for (const psm of ['11', '3']) {
    let tsv = ''; try { tsv = execFileSync('tesseract', [f2, 'stdout', '--psm', psm, 'tsv'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64e6 }); } catch { continue; }
    for (const line of tsv.split('\n').slice(1)) {
      const c = line.split('\t'); if (c.length < 12 || c[0] !== '5') continue;
      const t = c[11].trim(), conf = +c[10], x = +c[6] * k, y = +c[7] * k, w = +c[8] * k, h = +c[9] * k;
      const letters = (t.match(/[\p{L}\p{N}@]/gu) || []).length;
      if (conf < 60 || letters < 2 || (letters < 3 && conf < 80) || h < 12) continue;
      if (words.some((o) => Math.min(o.x + o.w, x + w) - Math.max(o.x, x) > 0.5 * Math.min(o.w, w) && Math.min(o.y + o.h, y + h) - Math.max(o.y, y) > 0.5 * Math.min(o.h, h))) continue;
      words.push({ t, x, y, w, h, conf });
    }
  }
  words.sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const wd of words) {
    const L = lines.find((l) => Math.min(l.y + l.h, wd.y + wd.h) - Math.max(l.y, wd.y) > 0.5 * Math.min(l.h, wd.h) && wd.x - (l.x + l.w) < 1.5 * Math.max(l.h, wd.h) && wd.x + wd.w > l.x - 2 * Math.max(l.h, wd.h));
    if (L) { const x2 = Math.max(L.x + L.w, wd.x + wd.w), y2 = Math.max(L.y + L.h, wd.y + wd.h); L.x = Math.min(L.x, wd.x); L.y = Math.min(L.y, wd.y); L.w = x2 - L.x; L.h = y2 - L.y; L.ws.push(wd); L.maxh = Math.max(L.maxh, wd.h); }
    else lines.push({ ...wd, maxh: wd.h, ws: [wd] });
  }
  for (const l of lines) l.t = l.ws.sort((a, b) => a.x - b.x).map((w) => w.t).join(' ');
  return lines.map((l) => ({ t: l.t.slice(0, 80), x: l.x, y: l.y, w: l.w, h: l.h, fs: l.maxh / 0.75, ocr: true }));
}

// ---------- pixels: contrast of each line, sharpness, borders ----------
async function pixels(page, dataUrl, boxes) {
  await page.setContent('<html><body></body></html>');
  return page.evaluate(async (src, boxes) => {
    const im = new Image(); im.src = src; await im.decode();
    const W = im.naturalWidth, H = im.naturalHeight;
    const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(im, 0, 0);
    const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const L = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const contrast = boxes.map((b) => {
      const X = Math.max(0, Math.floor(b.x)), Y = Math.max(0, Math.floor(b.y)), w = Math.min(W - X, Math.ceil(b.w)), h = Math.min(H - Y, Math.ceil(b.h));
      if (w < 2 || h < 2) return null;
      const d = x.getImageData(X, Y, w, h).data, step = Math.max(1, Math.floor(Math.sqrt(w * h / 40000)));
      const px = []; for (let yy = 0; yy < h; yy += step) for (let xx = 0; xx < w; xx += step) { const i = (yy * w + xx) * 4; px.push([d[i], d[i + 1], d[i + 2]]); }
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
    // luminance (0–255) at full size, then a pyramid of 2×2 averages
    const D = x.getImageData(0, 0, W, H).data, Y0 = new Float32Array(W * H);
    for (let i = 0, j = 0; i < Y0.length; i++, j += 4) Y0[i] = 0.299 * D[j] + 0.587 * D[j + 1] + 0.114 * D[j + 2];
    // Sharpness (Palm's estimate). b1 = a 3×3 average, b2 = b1 averaged again, b4 = a much wider average. Where the
    // picture has structure (|b2 − b4| clearly above noise: an edge or texture, not a smooth sky), compare the finest
    // detail |Y − b1| with the mid detail |b2 − b4|. A crisp photo or edge keeps a good share of fine detail; an image
    // enlarged 2× or more, or blurred, has almost none left.
    const box = (a, r) => { const t = new Float32Array(a.length), o = new Float32Array(a.length); for (let y = 0; y < H; y++) { let s = 0; for (let xx = -r; xx <= r; xx++) s += a[y * W + Math.min(W - 1, Math.max(0, xx))]; for (let xx = 0; xx < W; xx++) { t[y * W + xx] = s / (2 * r + 1); s += a[y * W + Math.min(W - 1, xx + r + 1)] - a[y * W + Math.max(0, xx - r)]; } } for (let xx = 0; xx < W; xx++) { let s = 0; for (let y = -r; y <= r; y++) s += t[Math.min(H - 1, Math.max(0, y)) * W + xx]; for (let y = 0; y < H; y++) { o[y * W + xx] = s / (2 * r + 1); s += t[Math.min(H - 1, y + r + 1) * W + xx] - t[Math.max(0, y - r) * W + xx]; } } return o; };
    const b1 = box(Y0, 1), b2 = box(b1, 1), b4 = box(box(b2, 2), 2);
    const G = 8, tiles = [], st = Math.max(1, Math.round(W / 1500));
    for (let ty = 0; ty < G; ty++) for (let tx = 0; tx < G; tx++) {
      let hi = 0, mid = 0, n = 0;
      for (let y = Math.floor(ty * H / G); y < (ty + 1) * H / G; y += st) for (let xx = Math.floor(tx * W / G); xx < (tx + 1) * W / G; xx += st) { const i = y * W + xx, m = Math.abs(b2[i] - b4[i]); if (m < 1.5) continue; hi += Math.abs(Y0[i] - b1[i]); mid += m; n++; }
      tiles.push({ tx, ty, n, s: mid ? hi / mid : null });
    }
    // edges: how far in from each side the picture stays one flat colour
    const flatDepth = (side) => {
      const lineStats = (i) => { let s = 0, s2 = 0, n = 0; const step = 3; if (side === 'top' || side === 'bottom') { const y = side === 'top' ? i : H - 1 - i; for (let xx = 0; xx < W; xx += step) { const v = Y0[y * W + xx]; s += v; s2 += v * v; n++; } } else { const xx = side === 'left' ? i : W - 1 - i; for (let y = 0; y < H; y += step) { const v = Y0[y * W + xx]; s += v; s2 += v * v; n++; } } const m = s / n; return { m, sd: Math.sqrt(Math.max(0, s2 / n - m * m)) }; };
      const first = lineStats(0); if (first.sd > 6) return { depth: 0, mean: first.m };
      let i = 0; const lim = Math.floor((side === 'top' || side === 'bottom' ? H : W) / 2);
      for (; i < lim; i += 2) { const st = lineStats(i); if (st.sd > 6 || Math.abs(st.m - first.m) > 6) { if (st.sd <= 18 && Math.abs(st.m - first.m) <= 18) return { depth: 0, mean: first.m, gradual: true }; break; } }
      return { depth: i, mean: first.m };
    };
    const edges = Object.fromEntries(['top', 'bottom', 'left', 'right'].map((s) => [s, flatDepth(s)]));
    // the cover's average colour (for the Now Playing backdrop)
    const sm = document.createElement('canvas'); sm.width = sm.height = 1; const sx = sm.getContext('2d'); sx.drawImage(im, 0, 0, 1, 1); const avg = [...sx.getImageData(0, 0, 1, 1).data].slice(0, 3);
    return { contrast, tiles, edges, avg };
  }, dataUrl, boxes.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h, color: b.color, extra: b.extra })));
}

// Palm's estimate per tile (see pixels()): s = fine detail ÷ mid detail where the cover has edges or texture. Measured
// Nov 2026 on test covers: sharp photos 1.2–1.5, crisp type and shapes about 0.55–0.65, photos enlarged 3× 0.48–0.53,
// a soft phone photo enlarged 2.5× 0.26. So under SHARP_T it has lost its fine detail; a 3× enlargement of a sharp,
// grainy photo can still pass (the HTML source check catches that one exactly).
export const SHARP_T = 0.45;
export function sharpnessOf(tiles, W) {
  const minN = (W / Math.max(1, Math.round(W / 1500)) / 8) ** 2 * 0.03;
  const detailed = tiles.filter((t) => t.n >= minN && t.s != null);
  if (!detailed.length) return { detailed_tiles: 0, note: 'No edges or texture to measure (flat colour or smooth gradients).' };
  const soft = detailed.filter((t) => t.s < SHARP_T);
  const ss = detailed.map((t) => t.s).sort((a, b) => a - b);
  return {
    detailed_tiles: detailed.length, soft_tiles: soft.length, soft_share: round(soft.length / detailed.length, 2),
    median: round(ss[ss.length >> 1], 2), threshold: SHARP_T,
    soft_map: soft.map((t) => [t.tx, t.ty, t.s < SHARP_T * 0.7 ? 2 : 1]),
  };
}

function pickCover(dir) {
  if (statSync(dir).isFile()) return dir;
  const imgs = readdirSync(dir).filter((f) => /\.(jpe?g|png|gif|webp|tiff?|heic|bmp)$/i.test(f) && !/sheet|look|preview/i.test(f));
  const named = imgs.find((f) => /^cover\.(jpe?g|png)$/i.test(f)) || imgs.find((f) => /cover/i.test(f) && /\.(jpe?g|png)$/i.test(f));
  if (named) return join(dir, named);
  let best = null, bestA = 0;
  for (const f of imgs) { const i = imageInfo(readFileSync(join(dir, f))); const a = (i.w || 0) * (i.h || 0) * (i.w === i.h ? 2 : 1); if (a > bestA) { bestA = a; best = f; } }
  return best ? join(dir, best) : null;
}

export async function check(target, { artist = '', title = '', label = '', explicit = false, out = 'look/cover', plain = false, ocr = 'auto' } = {}) {
  const abs = resolve(target);
  if (!existsSync(abs)) throw new Error('no such file or folder: ' + target);
  const f = pickCover(abs);
  if (!f) throw new Error('no cover image (JPG/PNG) in ' + target);
  const buf = readFileSync(f), info = imageInfo(buf), W = info.w, H = info.h, name = basename(f), mb = buf.length / 1048576;
  const issues = [];
  const cover = { file: name, format: info.format, w: W, h: H, mode: info.mode, alpha: !!info.alpha, bits: info.bits, mb: round(mb, 2), dpi: info.dpi ?? null };
  // the file
  if (!['jpeg', 'png'].includes(info.format)) issues.push(issue('format', 'error', `${name} is ${String(info.format).toUpperCase()}: send a JPG or PNG.`, 'Save it as a JPG (RGB, quality 90+).'));
  if (W && H && W !== H) issues.push(issue('not-square', 'error', `${name} is ${W}×${H}: cover art must be a perfect square.`, 'Make it 3000×3000.'));
  if (W && H && Math.min(W, H) < RULES.minAll) issues.push(issue('too-small', 'error', `${name} is ${W}×${H}: under the 1400×1400 CD Baby, Apple's asset guide and Bandcamp ask for (DistroKid's floor is 1000, TuneCore's 1600).`, 'Make it 3000×3000 from sources that are at least that big.'));
  else if (W && H && Math.min(W, H) < RULES.best) issues.push(issue('under-3000', 'warn', `${name} is ${W}×${H}: the distributors and Apple recommend 3000×3000${Math.min(W, H) < RULES.tunecoreMin ? ' (and TuneCore asks for at least 1600)' : ''}.`, 'Make it 3000×3000.'));
  if (W && H && Math.max(W, H) > RULES.maxPx) issues.push(issue('over-3000', 'warn', `${name} is ${W}×${H}: TuneCore and CD Baby take no more than 3000×3000.`, 'Save it at exactly 3000×3000.'));
  if (info.format === 'png') issues.push(issue('png', 'note', `${name} is a PNG: fine for most stores, but DistroKid's page names only .jpg.`, 'Save a JPG (quality 90+) for DistroKid.'));
  if (info.mode && !['RGB', 'RGBA', 'palette'].includes(info.mode)) issues.push(issue('colour-mode', info.mode === 'greyscale' ? 'warn' : 'error', `${name} is ${info.mode}, not RGB${info.mode === 'greyscale' ? ': some stores want RGB even for a black-and-white cover' : ': stores show CMYK files with wrong colours or reject them'}.`, 'Save it as an RGB JPG.'));
  if (info.alpha) issues.push(issue('alpha', 'warn', `${name} has an alpha channel (transparency): stores flatten it onto a colour you don't choose.`, 'Save it as a JPG, or a PNG without alpha.'));
  if (mb > RULES.maxMB) issues.push(issue('file-size', 'warn', `${name} is ${round(mb, 1)} MB: over the ${RULES.maxMB} MB some distributors take.`, 'Save it as a JPG at quality 90.'));

  const tess = ocr !== 'never' && hasTesseract();
  const browser = await launch();
  let text = { method: 'none', lines: [] }, px = null, sharp = null;
  const dataUrl = `data:image/${info.format === 'png' ? 'png' : info.format === 'gif' ? 'gif' : 'jpeg'};base64,${buf.toString('base64')}`;
  try {
    const page = await browser.newPage();
    const stem = name.replace(/\.\w+$/, '');
    const srcs = readdirSync(dirname(f)).filter((x) => /\.(html?|svg)$/i.test(x) && !/sheet/i.test(x));
    const src = srcs.find((x) => x.replace(/\.\w+$/, '') === stem) || (srcs.length === 1 ? srcs[0] : null);
    let boxes = [], ocrB = null;
    if (src && W) {
      const m = await measureSource(page, join(dirname(f), src), { w: W, h: H }); text.method = 'source'; text.source = src; boxes = m.boxes;
      text.pics = m.pics.filter((p) => p.area >= 0.03).map((p) => ({ src: p.src, natural: `${p.nw}×${p.nh}`, enlarged: p.scale, share_of_cover: round(p.area, 2) }));
      const big = text.pics.filter((p) => p.enlarged > 1.25);
      if (big.length) issues.push(issue('photo-enlarged', big.some((p) => p.enlarged >= 1.8) ? 'error' : 'warn', `In ${src}, ${big.map((p) => `${p.src.split('/').pop()} (${p.natural}) is drawn ${p.enlarged}× its real size over ${Math.round(p.share_of_cover * 100)}% of the cover`).join('; ')}: it will look soft or pixelated at full size. Spotify says don't upscale; distributors and Apple reject blurry or pixelated art.`, 'Use a bigger original, show the photo smaller (no more than its own pixels), or crop less of it.'));
    }
    if (tess && W && (ocr === 'always' || text.method === 'none')) { ocrB = await ocrBoxes(f, page); if (text.method === 'none') { text.method = 'ocr'; boxes = ocrB; ocrB = null; } }
    if (W) {
      px = await pixels(page, dataUrl, [...boxes, ...(ocrB || [])]);
      [...boxes, ...(ocrB || [])].forEach((b, i) => { b.contrast = px.contrast[i] == null ? null : round(px.contrast[i], 2); });
      sharp = sharpnessOf(px.tiles, W);
    }
    for (const b of [...boxes, ...(ocrB || [])]) { b.row_px = round(b.fs * TILE.row / W); b.grid_px = round(b.fs * TILE.grid / W); }
    text.lines = boxes; if (ocrB) text.ocr = ocrB;
    const est = text.method === 'ocr' ? " (Palm's estimate from OCR)" : '';

    // what's written on it
    const all = [...boxes, ...(ocrB || [])];
    const flagged = new Map();
    for (const b of all) for (const r of BANNED) {
      if (r.id === 'advisory' && explicit) continue;
      if (r.id === 'price' && /\bfree\b/i.test(b.t) && /\bfree\b/i.test(`${artist} ${title} ${label}`)) continue;
      const m = String(b.t).match(r.re);
      if (m && !`${artist} ${title} ${label}`.toLowerCase().includes(m[0].trim().toLowerCase())) { b.banned = r.id; if (!flagged.has(r.id)) flagged.set(r.id, { r, b }); }
    }
    for (const [, { r, b }] of flagged) issues.push(issue('banned-' + r.id, 'error', `"${b.t}" has ${r.what}${b.ocr ? " (Palm's reading by OCR)" : ''}${r.id === 'advisory' ? ' on a release not marked explicit' : ''}: distributors and Apple list this among what they reject on cover art (DistroKid, TuneCore, CD Baby, Apple, read ${RULES.read}).`, r.id === 'advisory' ? 'Take it off, or mark the release explicit.' : 'Take it off the cover: put it in the release\'s promo posts instead.'));
    if (explicit && !all.some((b) => /parental advisory|explicit/i.test(b.t))) issues.push(issue('explicit-note', 'note', 'The release is marked explicit. A Parental Advisory label on the cover is optional for most stores; never put one on a clean release.', ''));

    // matches the metadata?
    const words = norm(all.filter((b) => !b.ocr || text.method === 'ocr').sort((a, b) => a.y - b.y || a.x - b.x).map((b) => b.t).join(' '));
    text.reads = words;
    if (words && (artist || title)) {
      const okWords = new Set(norm(`${artist} ${title} ${label} feat ft featuring with and x the a`).split(' '));
      const nt = norm(title), na = norm(artist);
      const hasTitle = nt && (` ${words} `).includes(` ${nt} `), hasArtist = na && (` ${words} `).includes(` ${na} `);
      text.has_title = !!hasTitle; text.has_artist = !!hasArtist;
      const extra = [...new Set(words.split(' ').filter((w) => w.length >= 2 && !okWords.has(w) && !/^\d$/.test(w)))];
      text.extra_words = extra;
      const lvl = text.method === 'ocr' ? 'warn' : 'error';
      if (nt && !hasTitle && nt.split(' ').some((w) => w.length > 2 && words.split(' ').includes(w))) issues.push(issue('title-mismatch', lvl, `The cover's words ("${words.slice(0, 80)}") don't contain the release title exactly as in your metadata ("${title}")${est}. Stores reject a cover whose title or artist differs from the metadata.`, `Write the title exactly as "${title}" (capital letters are a style choice; spelling and words are not), or leave it off.`));
      if (na && !hasArtist && na.split(' ').some((w) => w.length > 2 && words.split(' ').includes(w))) issues.push(issue('artist-mismatch', lvl, `The cover's words don't contain the artist name exactly as in your metadata ("${artist}")${est}.`, `Write it exactly as "${artist}", or leave it off.`));
      const notFlagged = extra.filter((w) => !all.some((b) => b.banned && norm(b.t).split(' ').includes(w)));
      if (notFlagged.length) issues.push(issue('extra-text', text.method === 'ocr' ? 'note' : 'warn', `Words on the cover that aren't the artist, the title or the label: ${notFlagged.slice(0, 8).map((w) => `"${w}"`).join(', ')}${est}. Stores turn away text that isn't in the release's metadata.`, 'Keep the words on the cover to the artist name and the title (and the label, if any).'));
    }

    // size and contrast where it's seen
    if (boxes.length) {
      const head = boxes.reduce((a, b) => (b.fs > a.fs ? b : a));
      text.head = { t: head.t, font_px: Math.round(head.fs), row_px: head.row_px, grid_px: head.grid_px };
      if (head.row_px < MIN_HEAD_ROW) issues.push(issue('head-small', 'warn', `The biggest words ("${head.t}", ${Math.round(head.fs)} px) are ${head.row_px} px on a ${TILE.row} px playlist row tile${est}: there the cover is only its picture and colours (Palm's guidance: ${MIN_HEAD_ROW} px or more if the words are meant to read in a list).`, `If the words should read in playlists, make them at least ${Math.ceil(MIN_HEAD_ROW * W / TILE.row)} px; if not, make sure the picture alone is recognisable at ${TILE.row} px.`));
      const small = boxes.filter((b) => b.grid_px < MIN_GRID).sort((a, b) => a.fs - b.fs);
      if (small.length) issues.push(issue('text-small', 'warn', `${small.length} line${small.length > 1 ? 's' : ''} can't be read on a ${TILE.grid} px album tile or a car screen${est}: ${small.slice(0, 4).map((b) => `"${b.t}" ${Math.round(b.fs)} px → ${b.grid_px} px`).join('; ')} (Palm's guidance: ${MIN_GRID} px or more there).`, `Make every line at least ${Math.ceil(MIN_GRID * W / TILE.grid)} px on this ${W}-px cover, or leave it off.`));
      const low = boxes.filter((b) => b.contrast != null && b.contrast < MIN_CONTRAST);
      if (low.length) issues.push(issue('low-contrast', 'warn', `Low contrast against what's behind it (Palm's estimate): ${low.slice(0, 3).map((b) => `"${b.t}" ${b.contrast}:1`).join('; ')}.`, `Aim for ${MIN_CONTRAST}:1 or more: a calmer, darker or lighter area behind the words, or a heavier weight.`));
    } else if (text.method !== 'none') issues.push(issue('no-text', 'note', `No words found on the cover${est}. That's allowed: the picture alone has to be recognisable at ${TILE.row} px.`, ''));
    else issues.push(issue('not-measured', 'note', 'No HTML/SVG source beside the cover and no Tesseract: its words weren\'t measured. Judge them on the sheet.', 'Keep the HTML you made it from beside it (cover.html).'));

    // sharpness (Palm's estimate)
    if (sharp && sharp.detailed_tiles) {
      if (sharp.soft_share >= 0.4) issues.push(issue('soft', 'warn', `${Math.round(sharp.soft_share * 100)}% of the cover's edges and textures hold no fine detail: they look enlarged from a smaller image or blurred (Palm's estimate: fine-detail score ${sharp.median} where ${SHARP_T} or more is crisp). Distributors and Apple reject blurry or pixelated art, Spotify says don't upscale, and it shows on Now Playing and big screens. If it's meant to be out of focus, check the 100% crop on the sheet looks clean, not blocky.`, 'Use a source at least as big as the area it fills (a full-bleed photo on a 3000 px cover needs about 3000 px), a different photo, or a treatment that doesn\'t need fine detail from the photo (shapes, type, a smaller photo area).'));
      else if (sharp.soft_share >= 0.2) issues.push(issue('soft-parts', 'note', `${Math.round(sharp.soft_share * 100)}% of the cover's edges and textures look soft (Palm's estimate). Fine if they're meant to be out of focus.`, ''));
    }
    if (sharp && !sharp.detailed_tiles && !boxes.length) issues.push(issue('generic', 'warn', 'The cover is flat colour with no words: CD Baby says generic artwork (a solid colour square with no text) may not be accepted.', 'Give it an image, a shape or the artist and title.'));
    // borders and empty space
    if (px) {
      const E = px.edges, dep = Object.fromEntries(Object.entries(E).map(([k, v]) => [k, v.depth / (k === 'top' || k === 'bottom' ? H : W)]));
      text.edges = Object.fromEntries(Object.entries(dep).map(([k, v]) => [k, round(v, 3)]));
      const band = (v) => v >= 0.008 && v <= 0.15;
      const sides = Object.entries(dep).filter(([, v]) => band(v)).map(([k]) => k);
      if (sides.length === 4) issues.push(issue('border', 'warn', `A plain band ${Math.round(Math.min(...Object.values(dep)) * W)}–${Math.round(Math.max(...Object.values(dep)) * W)} px wide runs round every edge: it reads as a border or frame. Distributors turn away borders and art that doesn't fill the square, and apps round the corners.`, 'Let the art run to all four edges.'));
      else if ((band(dep.top) && band(dep.bottom) && !band(dep.left)) || (band(dep.left) && band(dep.right) && !band(dep.top))) issues.push(issue('letterbox', 'warn', `Plain bands on two opposite edges (${sides.join(', ')}): the picture doesn't fill the square.`, 'Crop the picture to the square instead of fitting it inside.'));
    }

    // the sheet
    const sheet = drawSheet({ dataUrl, cover, artist, title, avg: px?.avg || [40, 40, 40], text, sharp, plain });
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(resolve(out) + '-sheet.html', sheet);
    await page.setViewport({ width: 1500, height: 1000, deviceScaleFactor: 1 });
    await page.setContent(sheet, { waitUntil: 'load', timeout: 120000 });
    await page.evaluate(() => Promise.all([...document.images].map((i) => i.complete ? 0 : new Promise((r) => (i.onload = i.onerror = r)))));
    await page.screenshot({ path: resolve(out) + '-sheet.png', fullPage: true });
  } finally { await browser.close(); }
  const errors = issues.filter((i) => i.level === 'error').length, warnings = issues.filter((i) => i.level === 'warn').length;
  const slim = (b) => ({ t: b.t, font_px: Math.round(b.fs), at_row_px: b.row_px, at_grid_px: b.grid_px, contrast: b.contrast, ...(b.banned ? { banned: b.banned } : {}) });
  const sharpOut = sharp || {};
  return {
    ok: errors === 0, errors, warnings, cover, file: f,
    text: { method: text.method, source: text.source, pics: text.pics, reads: text.reads, has_title: text.has_title, has_artist: text.has_artist, extra_words: text.extra_words, head: text.head, edges: text.edges, lines: text.lines.map(slim), ...(text.ocr ? { ocr: text.ocr.map(slim) } : {}) },
    sharpness: sharp ? sharpOut : null, issues, sheet: resolve(out) + '-sheet.png',
    notes: `Rules: distributor and Apple help pages read ${RULES.read} (see the tool's header). Sizes, thresholds, the sharpness estimate and the app mock-ups are Palm's approximation (Nov 2026).`,
  };
}

// ---------- the sheet ----------
// Stand-in releases: abstract covers (no real artists, titles or artwork).
const NB = [
  ['#e9d8a6', '#005f73', 'circle'], ['#ff6b6b', '#2b2d42', 'type:GLASSHOUSE'], ['#90e0ef', '#03045e', 'stripes'], ['#ffd6a5', '#9c6644', 'type:slow days'],
  ['#2d6a4f', '#d8f3dc', 'blob'], ['#f72585', '#3a0ca3', 'grad'], ['#14213d', '#fca311', 'type:LUMEN'], ['#cdb4db', '#6d597a', 'circle'],
  ['#264653', '#e76f51', 'stripes'], ['#fefae0', '#bc6c25', 'type:Parade'], ['#111', '#e0e0e0', 'blob'], ['#ffb4a2', '#6d6875', 'grad'],
];
const standIn = (i, r = 0) => {
  const [a, b, kind] = NB[i % NB.length];
  let inner = '';
  if (kind === 'circle') inner = `<div style="position:absolute;left:22%;top:22%;width:56%;height:56%;border-radius:50%;background:${b}"></div>`;
  else if (kind === 'stripes') inner = `<div style="position:absolute;inset:0;background:repeating-linear-gradient(135deg,${b} 0 12%,transparent 12% 24%)"></div>`;
  else if (kind === 'blob') inner = `<div style="position:absolute;left:10%;top:30%;width:80%;height:55%;border-radius:45% 55% 40% 60%;background:${b};filter:blur(2px)"></div>`;
  else if (kind === 'grad') inner = `<div style="position:absolute;inset:0;background:radial-gradient(circle at 30% 70%,${b},transparent 70%)"></div>`;
  else { const w = kind.slice(5); inner = `<svg viewBox="0 0 100 100" style="position:absolute;inset:0;width:100%;height:100%"><text x="50" y="58" text-anchor="middle" font-family="Georgia,serif" font-weight="700" font-size="${w.length > 8 ? 13 : 19}" fill="${b}">${w}</text></svg>`; }
  return `<div style="position:relative;width:100%;height:100%;overflow:hidden;background:${a};border-radius:${r}px">${inner}</div>`;
};
const STAND_TITLES = [['Low Light', 'June Okafor'], ['Glasshouse', 'The Paper Cuts'], ['Undertow', 'Mara Lind'], ['slow days', 'kiko'], ['Field Notes', 'Arlo Penn'], ['Neon Prayer', 'SAINTS & SODA'], ['Lumen', 'Odessa Vale'], ['Soft Focus', 'Pell'], ['Coastline', 'Harbour Kids'], ['Parade', 'Ellery'], ['Static', 'Nadia Rowe'], ['Weekday', 'Fern & Field']];

export function drawSheet({ dataUrl, cover, artist, title, avg, text, sharp, plain }) {
  const A = artist || 'Artist', Tt = title || 'Title';
  const art = (s, r = 0, extra = '') => `<img src="${dataUrl}" style="width:${s}px;height:${s}px;border-radius:${r}px;object-fit:cover;display:block;flex:none;${extra}">`;
  const tile = (i, s, r = 0) => `<div style="width:${s}px;height:${s}px;flex:none">${standIn(i, r)}</div>`;
  const rows = (n, ours, s, r, fg, sub, off = 0) => Array.from({ length: n }, (_, k) => {
    const me = k === ours, [t, a] = me ? [Tt, A] : STAND_TITLES[(k + off) % STAND_TITLES.length];
    return `<div style="display:flex;gap:12px;align-items:center;padding:5px 0">${me ? art(s, r) : tile(k + off, s, r)}<div style="min-width:0;flex:1"><div style="font:500 15px/19px system-ui;color:${fg};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(t)}</div><div style="font:400 13px/17px system-ui;color:${sub}">${esc(a)}</div></div><div style="color:${sub};font-size:16px">⋯</div></div>`;
  }).join('');
  // phone playlists
  const spotifyPhone = () => `<div class="ph" style="background:linear-gradient(#3b3b3b 0,#121212 200px)"><div style="padding:16px 16px 6px;color:#fff;font:700 22px system-ui">Late Night Rain</div><div style="padding:0 16px 10px;color:#b3b3b3;font:400 12px system-ui">Playlist · 64 songs</div><div style="padding:0 16px">${rows(8, 3, TILE.row, 2, '#fff', '#b3b3b3')}</div>
  <div style="margin:10px 8px 8px;background:#4a3b3b;border-radius:8px;padding:8px;display:flex;gap:10px;align-items:center">${art(TILE.mini, 4)}<div style="flex:1;min-width:0"><div style="font:600 13px system-ui;color:#fff">${esc(Tt)}</div><div style="font:400 12px system-ui;color:#ddd">${esc(A)}</div></div><div style="color:#fff;font-size:20px">♡ ▶</div></div></div>`;
  const applePhone = (dark) => `<div class="ph" style="background:${dark ? '#000' : '#fff'}"><div style="padding:16px 16px 6px;color:${dark ? '#fff' : '#000'};font:700 22px system-ui">Rainy Day Pop</div><div style="padding:0 16px 10px;color:#fa2d48;font:500 13px system-ui">Playlist</div><div style="padding:0 16px">${rows(8, 4, TILE.row, 5, dark ? '#fff' : '#000', '#8e8e93', 3)}</div>
  <div style="margin:10px 8px 8px;background:${dark ? 'rgba(40,40,42,.95)' : 'rgba(246,246,248,.96)'};border-radius:14px;padding:8px;display:flex;gap:10px;align-items:center;box-shadow:0 2px 10px rgba(0,0,0,.15)">${art(TILE.mini, 5)}<div style="flex:1;min-width:0;font:500 14px system-ui;color:${dark ? '#fff' : '#000'}">${esc(Tt)}</div><div style="font-size:20px;color:${dark ? '#fff' : '#000'}">▶ ⏭</div></div></div>`;
  // desktop: a playlist and a grid of new releases
  const desktopList = () => `<div style="width:560px;background:#121212;padding:14px 18px;border-radius:8px"><div style="color:#b3b3b3;font:400 12px system-ui;border-bottom:1px solid #2a2a2a;padding-bottom:6px;margin-bottom:4px"># &nbsp; Title</div>${Array.from({ length: 7 }, (_, k) => { const me = k === 2, [t, a] = me ? [Tt, A] : STAND_TITLES[(k + 5) % STAND_TITLES.length]; return `<div style="display:flex;gap:12px;align-items:center;padding:4px 0"><div style="width:16px;color:#b3b3b3;font:13px system-ui">${k + 1}</div>${me ? art(TILE.desktopRow, 2) : tile(k + 5, TILE.desktopRow, 2)}<div><div style="color:#fff;font:400 14px system-ui">${esc(t)}</div><div style="color:#b3b3b3;font:400 12px system-ui">${esc(a)}</div></div><div style="margin-left:auto;color:#b3b3b3;font:13px system-ui">3:${(17 + k * 7) % 60 < 10 ? '0' : ''}${(17 + k * 7) % 60}</div></div>`; }).join('')}</div>`;
  const grid = (dark, r) => `<div style="background:${dark ? '#1c1c1e' : '#fff'};padding:14px 18px;border-radius:8px;width:${6 * 172 + 30}px"><div style="font:700 18px system-ui;color:${dark ? '#fff' : '#000'};margin-bottom:10px">New releases</div><div style="display:flex;gap:12px">${Array.from({ length: 6 }, (_, k) => { const me = k === (dark ? 3 : 1), [t, a] = me ? [Tt, A] : STAND_TITLES[(k + (dark ? 2 : 7)) % STAND_TITLES.length]; return `<div style="width:${TILE.grid}px">${me ? art(TILE.grid, r) : tile(k + (dark ? 2 : 7), TILE.grid, r)}<div style="font:500 13px system-ui;color:${dark ? '#fff' : '#000'};margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(t)}</div><div style="font:400 12px system-ui;color:#8e8e93">${esc(a)} · Single</div></div>`; }).join('')}</div></div>`;
  // lock screen, car, now playing
  const [r0, g0, b0] = avg;
  const lock = () => `<div style="width:300px;height:560px;border-radius:36px;overflow:hidden;position:relative;background:linear-gradient(160deg,#2b4162,#12100e);flex:none"><div style="text-align:center;color:#fff;margin-top:46px;font:600 15px system-ui;opacity:.85">Friday 16 January</div><div style="text-align:center;color:#fff;font:700 72px/1 system-ui">9:41</div>
  <div style="position:absolute;left:12px;right:12px;bottom:110px;background:rgba(60,60,70,.55);backdrop-filter:blur(20px);border-radius:22px;padding:12px;color:#fff"><div style="display:flex;gap:10px;align-items:center">${art(TILE.lock, 8)}<div style="min-width:0"><div style="font:600 14px system-ui;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(Tt)}</div><div style="font:400 13px system-ui;opacity:.75">${esc(A)}</div></div></div><div style="height:4px;background:rgba(255,255,255,.3);border-radius:2px;margin:12px 0 6px"><div style="width:35%;height:4px;background:#fff;border-radius:2px"></div></div><div style="text-align:center;font-size:22px">⏮ &nbsp; ⏸ &nbsp; ⏭</div></div></div>`;
  const car = () => `<div style="width:560px;height:300px;background:#0b0b0c;border-radius:16px;display:flex;flex:none;overflow:hidden"><div style="width:62px;background:#1b1b1d;display:flex;flex-direction:column;gap:14px;padding-top:16px;align-items:center">${['#5ac8fa', '#34c759', '#fa2d48', '#ff9f0a'].map((c) => `<div style="width:34px;height:34px;border-radius:9px;background:${c}"></div>`).join('')}</div><div style="flex:1;padding:22px 24px;color:#fff"><div style="display:flex;gap:18px;align-items:center">${art(TILE.car, 8)}<div><div style="font:700 20px system-ui">${esc(Tt)}</div><div style="font:400 16px system-ui;opacity:.7">${esc(A)}</div></div></div><div style="height:4px;background:#333;border-radius:2px;margin:24px 0 14px"><div style="width:52%;height:4px;background:#fff;border-radius:2px"></div></div><div style="text-align:center;font-size:28px">⏮ &nbsp;&nbsp; ⏸ &nbsp;&nbsp; ⏭</div></div></div>`;
  const nowPlaying = () => `<div style="width:390px;height:760px;border-radius:40px;overflow:hidden;position:relative;flex:none;background:linear-gradient(rgb(${r0},${g0},${b0}),rgb(${Math.round(r0 * 0.35)},${Math.round(g0 * 0.35)},${Math.round(b0 * 0.35)}))"><div style="height:60px"></div><div style="display:flex;justify-content:center;padding-top:40px">${art(TILE.nowPlaying, 10, 'box-shadow:0 18px 40px rgba(0,0,0,.45)')}</div><div style="padding:30px 26px 0;color:#fff"><div style="font:700 21px system-ui">${esc(Tt)}</div><div style="font:400 19px system-ui;opacity:.7">${esc(A)}</div><div style="height:5px;background:rgba(255,255,255,.3);border-radius:3px;margin:22px 0 4px"><div style="width:30%;height:5px;background:rgba(255,255,255,.9);border-radius:3px"></div></div><div style="display:flex;justify-content:space-between;font:12px system-ui;opacity:.6"><span>1:02</span><span>-2:19</span></div><div style="text-align:center;font-size:36px;margin-top:18px">⏮ &nbsp; ⏸ &nbsp; ⏭</div></div></div>`;
  // full size, and a crop at full resolution from the middle
  const fullW = 760;
  const k = cover.w ? fullW / cover.w : 1;
  let marks = '';
  if (!plain && cover.w) {
    const G = 8, ts = fullW / G;
    for (const [tx, ty, lvl] of sharp?.soft_map || []) marks += `<div style="position:absolute;left:${tx * ts}px;top:${ty * ts}px;width:${ts}px;height:${ts}px;background:repeating-linear-gradient(45deg,rgba(255,140,0,${0.18 + lvl * 0.08}) 0 6px,transparent 6px 12px)"></div>`;
    for (const b of text.lines || []) { const bad = b.banned || b.grid_px < MIN_GRID || (b.contrast != null && b.contrast < MIN_CONTRAST); marks += `<div style="position:absolute;left:${b.x * k}px;top:${b.y * k}px;width:${b.w * k}px;height:${b.h * k}px;border:2px solid ${bad ? '#f33' : '#3c6'};box-sizing:border-box"></div><div style="position:absolute;left:${b.x * k}px;top:${(b.y + b.h) * k}px;font:600 11px system-ui;color:#fff;background:${bad ? '#c22' : '#285'};padding:0 3px;white-space:nowrap">${b.banned ? 'NOT ALLOWED: ' + b.banned + ' · ' : ''}${b.row_px}px in a row · ${b.grid_px}px in a grid${b.contrast != null ? ' · ' + b.contrast + ':1' : ''}</div>`; }
  }
  const cropPx = 600, cx = cover.w ? Math.max(0, Math.round(cover.w / 2 - cropPx / 2)) : 0;
  const crop = cover.w ? `<div style="width:${cropPx}px;height:${cropPx}px;overflow:hidden;position:relative;flex:none"><img src="${dataUrl}" style="position:absolute;left:${-cx}px;top:${-cx}px;width:${cover.w}px;height:${cover.h}px;max-width:none;image-rendering:auto"></div>` : '';
  const head = plain
    ? `Cover art for "${esc(Tt)}" by ${esc(A)}: where listeners see it, among other releases (stand-ins; Palm's approximation of the apps' layouts, Nov 2026)`
    : `Cover art for "${esc(Tt)}" by ${esc(A)}: ${esc(cover.file)}, ${cover.w}×${cover.h} ${String(cover.format).toUpperCase()} ${cover.mode || ''}, ${cover.mb} MB. Where listeners see it, among other releases (stand-ins; Palm's approximation of the apps, Nov 2026)`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;width:1500px;background:#ecebe8;font-family:system-ui,sans-serif}.sec{padding:18px 22px}.row{display:flex;gap:20px;flex-wrap:wrap;align-items:flex-start}h2{font:600 15px system-ui;margin:0 0 12px;color:#333}.ph{width:390px;flex:none;border-radius:28px;overflow:hidden;padding-top:14px}figcaption{font:500 12px system-ui;color:#555;margin-top:6px}</style></head><body>
<div class="sec" style="background:#222"><h2 style="color:#eee;font-size:16px">${head}</h2></div>
<div class="sec"><h2>Playlists on a phone (390 px): a Spotify-style playlist with the mini player, and an Apple Music-style playlist (light, dark)</h2><div class="row">${spotifyPhone()}${applePhone(false)}${applePhone(true)}</div></div>
<div class="sec"><h2>On a desktop: a playlist, and a new-releases shelf (light with square tiles, dark with rounded tiles)</h2><div class="row">${desktopList()}<div style="display:flex;flex-direction:column;gap:14px">${grid(false, 2)}${grid(true, 8)}</div></div></div>
<div class="sec" style="background:#d9d7d2"><h2>Lock screen, car screen and Now Playing</h2><div class="row" style="align-items:center">${lock()}${car()}${nowPlaying()}</div></div>
<div class="sec"><h2>The cover at full size${plain ? '' : ': boxes = measured words with their size in a 48 px playlist row and a 160 px album tile, and their contrast; orange stripes = areas that look enlarged or blurred (estimate)'}, and the middle of the file at 100% (${cropPx}×${cropPx} px, actual pixels)</h2><div class="row"><figure style="margin:0"><div style="position:relative;width:${fullW}px;height:${fullW}px;overflow:hidden">${art(fullW)}${marks}</div><figcaption>${esc(cover.file)}</figcaption></figure><figure style="margin:0">${crop}<figcaption>100%: the middle ${cropPx}×${cropPx} pixels</figcaption></figure></div></div>
</body></html>`;
}

// ---------- the photos you have: how much of a cover each can fill without being enlarged ----------
export function info(target, { size = 3000 } = {}) {
  const abs = resolve(target), list = statSync(abs).isDirectory() ? readdirSync(abs).filter((f) => /\.(jpe?g|png|gif|webp|tiff?|heic)$/i.test(f)).map((f) => join(abs, f)) : [abs];
  const images = list.map((f) => { const i = imageInfo(readFileSync(f)); const short = Math.min(i.w || 0, i.h || 0); return { file: basename(f), format: i.format, w: i.w, h: i.h, mode: i.mode, square_crop_px: short || null, fills_cover_share: short ? round(Math.min(1, short / size), 2) : null, note: !short ? "couldn't read its size" : short >= size ? `a square crop is ${short} px: enough for a full-bleed ${size} px cover` : `a square crop is only ${short} px: full-bleed on a ${size} px cover it would be enlarged ${round(size / short, 2)}× and look soft. Use it at no more than ${short} px across, or pick another photo.` }; });
  return { ok: true, size, images };
}

// ---------- render HTML to the cover ----------
export async function render(file, { out, size = '3000x3000', quality = 92 } = {}) {
  const [w, h] = String(size).split('x').map(Number);
  if (!w || !h) throw new Error('--size WxH, e.g. 3000x3000');
  const abs = resolve(file), o = resolve(out || abs.replace(/\.html?$/i, '.jpg'));
  const browser = await launch(), issues = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(abs).href, { waitUntil: 'load', timeout: 60000 });
    await page.evaluate(() => document.fonts?.ready); await new Promise((r) => setTimeout(r, 300));
    const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight, broken: [...document.images].filter((i) => !i.naturalWidth).map((i) => i.getAttribute('src')) }));
    mkdirSync(dirname(o), { recursive: true });
    const jpeg = !/\.png$/i.test(o);
    await page.evaluate(() => { if (getComputedStyle(document.body).backgroundColor === 'rgba(0, 0, 0, 0)' && getComputedStyle(document.documentElement).backgroundColor === 'rgba(0, 0, 0, 0)') document.documentElement.style.background = '#fff'; });
    await page.screenshot({ path: o, type: jpeg ? 'jpeg' : 'png', ...(jpeg ? { quality } : { omitBackground: false }), clip: { x: 0, y: 0, width: w, height: h } });
    if (m.sw > w + 1 || m.sh > h + 1) issues.push(issue('overflow', 'warn', `${basename(abs)} is ${m.sw}×${m.sh}, bigger than ${w}×${h}: part of it is cut off.`, `html,body{width:${w}px;height:${h}px;overflow:hidden;margin:0}`));
    if (m.broken.length) issues.push(issue('broken-image', 'error', `Images that didn't load: ${m.broken.join(', ')}.`, 'Check the paths (relative to the HTML file).'));
  } finally { await browser.close(); }
  return { ok: !issues.length, out: o, w, h, kb: Math.round(statSync(o).size / 1024), issues };
}

// ---------- self-test ----------
async function selfTest() {
  const d = mkdtempSync(join(tmpdir(), 'music-cover-'));
  // a detailed "photo": seeded noise and shapes drawn on a canvas at a given size
  const photoHtml = (n) => `<html><body style="margin:0"><canvas id="c" width="${n}" height="${n}"></canvas><script>const c=document.getElementById('c'),x=c.getContext('2d');let s=5;const r=()=>((s=(s*16807)%2147483647)/2147483647);x.fillStyle='#223';x.fillRect(0,0,${n},${n});for(let i=0;i<${Math.round(n * n / 900)};i++){x.fillStyle='hsl('+Math.floor(r()*360)+',60%,'+Math.floor(30+r()*50)+'%)';x.fillRect(r()*${n},r()*${n},2+r()*${n / 60},2+r()*${n / 60});}const id=x.getImageData(0,0,${n},${n}),dd=id.data;for(let i=0;i<dd.length;i+=4){const q=(r()-.5)*30;dd[i]+=q;dd[i+1]+=q;dd[i+2]+=q;}x.putImageData(id,0,0);</script></body></html>`;
  writeFileSync(join(d, 'p3000.html'), photoHtml(3000)); writeFileSync(join(d, 'p1000.html'), photoHtml(1000));
  await render(join(d, 'p3000.html'), { out: join(d, 'photo3000.jpg') });
  await render(join(d, 'p1000.html'), { out: join(d, 'photo1000.jpg'), size: '1000x1000' });
  const cov = (img, body) => `<html><head><title>c</title></head><body style="margin:0;width:3000px;height:3000px;overflow:hidden;position:relative;font-family:Arial,sans-serif"><img src="${img}" style="position:absolute;inset:0;width:3000px;height:3000px;object-fit:cover">${body}</body></html>`;
  // good: sharp photo, big title and artist that match
  const good = join(d, 'good'); mkdirSync(good);
  writeFileSync(join(good, 'cover.html'), cov('../photo3000.jpg', '<div style="position:absolute;left:200px;top:300px;font:900 380px/1 Arial;color:#fff;text-shadow:0 0 30px #000">NIGHT BUS HOME</div><div style="position:absolute;left:200px;top:2400px;font:700 220px/1 Arial;color:#fff;text-shadow:0 0 30px #000">Test Artist</div>'));
  const rg = await render(join(good, 'cover.html'), { out: join(good, 'cover.jpg') }); if (!rg.ok) throw new Error('render good: ' + JSON.stringify(rg));
  const g = await check(good, { artist: 'Test Artist', title: 'Night Bus Home', out: join(d, 'good') });
  const gw = g.issues.filter((i) => i.level !== 'note');
  if (gw.length || g.text.method !== 'source' || !g.text.has_title || !g.text.has_artist) throw new Error('good: ' + JSON.stringify(g.issues) + JSON.stringify(g.text));
  // bad: enlarged 1000 px photo, promo text, handle, wrong title, tiny line, border
  const bad = join(d, 'bad'); mkdirSync(bad);
  writeFileSync(join(bad, 'cover.html'), `<html><body style="margin:0;width:3000px;height:3000px;overflow:hidden;position:relative;background:#fff;font-family:Arial,sans-serif"><img src="../photo1000.jpg" style="position:absolute;left:90px;top:90px;width:2820px;height:2820px"><div style="position:absolute;left:200px;top:300px;font:900 300px/1 Arial;color:#fff">NIGHT BUS</div><div style="position:absolute;left:200px;top:2500px;font:700 120px/1 Arial;color:#fff">NEW SINGLE · OUT 16 JAN</div><div style="position:absolute;left:200px;top:2700px;font:400 60px/1 Arial;color:#ccd">@test.artist</div></body></html>`);
  await render(join(bad, 'cover.html'), { out: join(bad, 'cover.jpg') });
  const b = await check(bad, { artist: 'Test Artist', title: 'Night Bus Home', out: join(d, 'bad') });
  const ids = b.issues.map((i) => i.id);
  for (const want of ['banned-promo', 'banned-handle', 'banned-date', 'banned-new', 'title-mismatch', 'text-small', 'photo-enlarged', 'border']) if (!ids.includes(want)) throw new Error('bad: expected ' + want + ' in ' + ids.join(',') + ' sharp=' + JSON.stringify(b.sharpness) + ' edges=' + JSON.stringify(b.text.edges));
  if (b.ok) throw new Error('bad: should have errors');
  // the file: CMYK-free sizes, not square, too small
  const ws = join(d, 'wrong'); mkdirSync(ws); writeFileSync(join(ws, 'cover.html'), '<html><body style="margin:0;background:#345"></body></html>');
  await render(join(ws, 'cover.html'), { out: join(ws, 'cover.png'), size: '1400x1200' });
  const w = await check(join(ws, 'cover.png'), { out: join(d, 'wrong') });
  for (const want of ['not-square', 'too-small', 'generic']) if (!w.issues.some((i) => i.id === want)) throw new Error('wrong: expected ' + want + ': ' + JSON.stringify(w.issues));
  // image only: a small photo blown up to 3000 px is found from its pixels
  writeFileSync(join(d, 'p500.html'), photoHtml(500)); await render(join(d, 'p500.html'), { out: join(d, 'photo500.jpg'), size: '500x500' });
  const up = join(d, 'up'); mkdirSync(up); writeFileSync(join(d, 'up.html'), '<html><body style="margin:0;width:3000px;height:3000px;overflow:hidden"><img src="photo500.jpg" style="width:3000px;height:3000px"></body></html>');
  await render(join(d, 'up.html'), { out: join(up, 'cover.jpg') });
  const u = await check(up, { out: join(d, 'up'), ocr: 'never' });
  if (!u.issues.some((i) => i.id === 'soft')) throw new Error('up: expected soft: ' + JSON.stringify(u.sharpness));
  if (g.sharpness.soft_share > 0.1) throw new Error('good: sharp photo looks soft: ' + JSON.stringify(g.sharpness));
  // image only: OCR (if Tesseract is installed)
  if (hasTesseract()) {
    const im = join(d, 'only'); mkdirSync(im); writeFileSync(join(im, 'cover.jpg'), readFileSync(join(bad, 'cover.jpg')));
    const o = await check(im, { artist: 'Test Artist', title: 'Night Bus Home', out: join(d, 'ocr') });
    if (o.text.method !== 'ocr' || !o.text.lines.length) throw new Error('ocr: ' + JSON.stringify(o.text));
    if (!o.issues.some((i) => i.id.startsWith('banned-'))) throw new Error('ocr: promo text not found: ' + JSON.stringify(o.text.lines));
    console.log('ocr lines:', o.text.lines.map((l) => `${l.t}=${l.font_px}px`).join(' | '));
  } else console.log('(Tesseract not installed: OCR path not tested)');
  console.log(`music-cover-check: all tests pass (good: sharpness ${JSON.stringify(g.sharpness)}; bad: ${[...new Set(ids)].join(', ')}, enlarged-photo sharpness ${JSON.stringify(u.sharpness)}; sheets in ${d})`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (k, dflt) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : dflt; };
  const VALUED = new Set(['--out', '--size', '--quality', '--artist', '--title', '--label', '--ocr']);
  const pos = argv.filter((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1]));
  const done = (r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); };
  const fail = (e) => { console.error(String(e.message || e)); process.exit(2); };
  if (argv.includes('--self-test') || argv.includes('--test')) selfTest().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
  else if (pos[0] === 'info' && pos[1]) done(info(pos[1], { size: +opt('size', 3000) }));
  else if (pos[0] === 'render' && pos[1]) render(pos[1], { out: opt('out'), size: opt('size', '3000x3000'), quality: +opt('quality', 92) }).then(done, fail);
  else if (pos[0] === 'check' && pos[1]) check(pos[1], { artist: opt('artist', ''), title: opt('title', ''), label: opt('label', ''), explicit: argv.includes('--explicit'), out: opt('out', 'look/cover'), plain: argv.includes('--plain'), ocr: opt('ocr', 'auto') }).then(done, fail);
  else fail('usage: music-cover-check.mjs check <cover.jpg | folder> --artist "Name" --title "Title" [--label L] [--explicit] [--out look/cover] [--plain]\n       music-cover-check.mjs render <cover.html> [--size 3000x3000] [--out cover.jpg]\n       music-cover-check.mjs --self-test');
}
