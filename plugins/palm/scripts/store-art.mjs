#!/usr/bin/env node
// Palm tool: store-art — checks a folder of store graphics for Google Play, the Chrome Web Store, Steam, Apple Podcasts,
// Etsy or Shopify against the
// stores' current rules (exact sizes, formats, alpha, counts, the sizes Steam stopped accepting in Aug 2024, banned
// words in the HTML they were made from), and draws them the way each store shows them: the Play icon under its mask
// at list size, the feature graphic at phone width with its cutoff zones, the Chrome tile at half size on the grey
// page, Steam's small capsule at 120×45 and 184×69 in a search row, the library grid and the hero with its safe area,
// a podcast cover at 60 px in a list and on a lock screen, and a shop's first photo in the square, portrait and
// landscape crops a marketplace grid uses; and a social profile kit (avatar, YouTube banner, X header, LinkedIn
// banners, Facebook cover) on each site's desktop and phone layout with the avatar laid over it.
// One sheet to LOOK at, plus measured problems. Also renders an HTML design to an image at an exact size.
// adds: tool, fresh-data. Runs on the user's machine with their Chrome/Edge/Chromium; nothing leaves it.
//
//   node store-art.mjs check <google-play|chrome-web-store|steam|apple-podcasts|etsy|shopify|profiles> <folder> [--out art]
//       → JSON {ok, store, found:[{key, file, w, h}], missing, issues} and <out>-sheet.png. Then LOOK at the sheet.
//   node store-art.mjs render <design.html> --size 1024x500 --out upload/feature.png [--jpeg] [--alpha]
//       → renders the HTML at exactly that size. PNGs are flattened (no alpha) unless --alpha (icons, Steam logo).
//
// Sizes and rules: Palm data pack app-launch/store-art (checked 2026-11-23, from the stores' own pages); social
// profiles from design/platform-sizes (YouTube and LinkedIn Pages rechecked on their help pages 2026-11-23).

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve, extname, relative, basename } from 'node:path';

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
  if (b.readUInt32BE(0) === 0x89504e47) {
    const ct = b[25]; let alpha = ct === 4 || ct === 6;
    if (!alpha) for (let i = 8; i < b.length - 8;) { const len = b.readUInt32BE(i), type = b.toString('latin1', i + 4, i + 8); if (type === 'tRNS') { alpha = true; break; } if (type === 'IDAT') break; i += 12 + len; }
    return { format: 'png', w: b.readUInt32BE(16), h: b.readUInt32BE(20), alpha };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i < b.length - 9;) {
      if (b[i] !== 0xff) { i++; continue; }
      const mk = b[i + 1]; if (mk === 0xd8 || mk === 0x01 || (mk >= 0xd0 && mk <= 0xd7)) { i += 2; continue; }
      const len = b.readUInt16BE(i + 2);
      if (mk >= 0xc0 && mk <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(mk)) return { format: 'jpeg', w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5), alpha: false };
      i += 2 + len;
    }
    return { format: 'jpeg' };
  }
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return { format: 'webp' };
  if (b.toString('latin1', 0, 4) === 'GIF8') return { format: 'gif', w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  return { format: 'unknown' };
}

const issue = (id, level, msg, fix) => ({ id, level, msg, fix });

// ---------- the stores' rules (data pack app-launch/store-art, checked 2026-11-23) ----------
export const STORES = {
  'google-play': {
    name: 'Google Play',
    assets: [
      { key: 'icon', label: 'App icon', w: 512, h: 512, required: true, png: true, maxKB: 1024 },
      { key: 'feature', label: 'Feature graphic', w: 1024, h: 500, required: true, noAlpha: true },
      { key: 'tv-banner', label: 'TV banner', w: 1280, h: 720, hint: /tv|banner/i, noAlpha: true },
    ],
    shots: { label: 'Phone screenshots', min: 2, max: 8, good: 4, minSide: 320, maxSide: 3840, ratio: 2.3, recSide: 1080, maxMB: 8, noAlpha: true },
    words: [/\bbest\b/i, /#\s?1\b/, /\bnumber one\b/i, /\btop[- ]?(rated|ranked|\d+)?\b/i, /\bnew\b/i, /\bfree\b/i, /\bdiscount/i, /\bsale\b/i, /\b\d+\s?(k|m|million)\+? (downloads|users)/i, /\bdownload now\b/i, /\binstall now\b/i, /\bplay now\b/i, /\btry (it )?now\b/i, /\baward/i, /\beditor'?s choice\b/i, /★|\d(\.\d)? stars?/i, /\$\d|€\d|£\d/],
    wordsWhy: 'Google Play bans ranking, awards, price/promotion words (Best, #1, Top, New, Free, Sale…) and calls to action (Download now, Play now) in graphics.',
  },
  'chrome-web-store': {
    name: 'Chrome Web Store',
    assets: [
      { key: 'icon', label: 'Store icon', w: 128, h: 128, required: true, png: true, padding: 16 },
      { key: 'small-tile', label: 'Small promo tile', w: 440, h: 280, recommended: 'Listings without one are shown after those that have one.' },
      { key: 'marquee', label: 'Marquee promo tile', w: 1400, h: 560 },
    ],
    shots: { label: 'Screenshots', min: 1, max: 5, sizes: [[1280, 800], [640, 400]] },
    words: [/\beditor'?s choice\b/i, /\bnumber one\b/i, /#\s?1\b/, /\bbest\b/i, /\baward/i, /★/],
    wordsWhy: 'The Chrome Web Store says promo images should have little or no text and no claims like "Editor\'s Choice" or "Number One".',
  },
  steam: {
    name: 'Steam',
    assets: [
      { key: 'header', label: 'Header capsule', w: 920, h: 430, required: true, hint: /^(?!.*library).*$/i },
      { key: 'small', label: 'Small capsule', w: 462, h: 174, required: true },
      { key: 'main', label: 'Main capsule', w: 1232, h: 706, required: true },
      { key: 'vertical', label: 'Vertical capsule', w: 748, h: 896, required: true },
      { key: 'background', label: 'Page background', w: 1438, h: 810 },
      { key: 'library-capsule', label: 'Library capsule', w: 600, h: 900, required: true },
      { key: 'library-header', label: 'Library header', w: 920, h: 430, required: true, hint: /library/i, fallback: 'header' },
      { key: 'library-hero', label: 'Library hero', w: 3840, h: 1240, required: true, png: true, noText: true },
      { key: 'library-logo', label: 'Library logo', logo: true, required: true, png: true, alpha: true },
      { key: 'community-icon', label: 'Community icon', w: 184, h: 184, required: true, jpg: true },
    ],
    old: [[460, 215, 'header capsule (now 920×430)'], [231, 87, 'small capsule (now 462×174)'], [616, 353, 'main capsule (now 1232×706)'], [374, 448, 'vertical capsule (now 748×896)'], [1920, 620, 'library hero (now 3840×1240)'], [640, 360, 'logo/hero at an old size'], [300, 450, 'library capsule (now 600×900)']],
    shots: { label: 'Screenshots', min: 5, minW: 1920, minH: 1080, ratio169: true },
    words: [/\bwishlist/i, /\bpre-?(order|purchase)/i, /\bbuy now\b/i, /\bplay now\b/i, /\bavailable now\b/i, /\bout now\b/i, /\bcoming soon\b/i, /\b\d{1,3}\s?% (off|discount)/i, /\bsale\b/i, /\baward/i, /\bgame of the year\b/i, /\bgoty\b/i, /\boverwhelmingly positive\b/i, /\bvery positive\b/i, /\b\d+\/10\b/, /★/],
    wordsWhy: 'Steam capsules may show only game art, the game name and an official subtitle: no review scores, awards, sale text or calls to action (rule in force since 1 Sept 2022).',
  },
  // podcasters.apple.com/support/5514 (show cover) and 5516 (episode art)
  'apple-podcasts': {
    name: 'Apple Podcasts',
    square: { min: 1400, max: 3000, best: 3000, formats: ['png', 'jpeg'], noAlpha: true },
    words: [], wordsWhy: '',
  },
  // help.etsy.com/hc/en-us/articles/115015663347
  etsy: {
    name: 'Etsy',
    photos: { min: 1, firstMin: 635, rec: 2000, maxKBWarn: 1024, formats: ['jpeg', 'png', 'gif'], noAlpha: 'Etsy shows transparent parts of an image as black.', firstLandscapeOrSquare: true },
    words: [], wordsWhy: '',
  },
  // help.shopify.com/en/manual/products/product-media/product-media-types
  shopify: {
    name: 'Shopify',
    photos: { min: 1, maxSide: 5000, maxMP: 25, maxMB: 20, squareRec: 2048, sameRatio: true, formats: ['jpeg', 'png', 'gif', 'webp'] },
    words: [], wordsWhy: '',
  },
};

// Social profiles. Official: YouTube Help 10456525 (banner 16:9, min 2048×1152, 2560×1440 for TV, safe area 1235×338
// at 2048 wide, ≤6 MB; profile picture rendered at 98×98, ≤15 MB), LinkedIn Help a563309 (Page cover 1512×256 min and
// recommended, logo 400×400, min 268, PNG/JPEG ≤3 MB), X Help (header 1500×500, photo 400×400, photo ≤2 MB), Facebook
// Help 125379114252045 (cover 851×315, at least 400×150). LinkedIn's member banner 1584×396 / 8 MB is a community
// figure (LinkedIn's page wasn't found). Where each site lays the avatar over the banner, and how phones crop, is
// Palm's measurement of the current layouts, not published: the sheet says so.
STORES.profiles = {
  name: 'Social profiles',
  profiles: [
    { key: 'youtube', label: 'YouTube banner', ratio: 16 / 9, tol: 0.01, rec: [2560, 1440], min: [2048, 1152], maxMB: 6, hint: /you ?tube|yt|channel/i, skip: 'not on YouTube' },
    { key: 'x', label: 'X header', ratio: 3, tol: 0.01, rec: [1500, 500], min: [1500, 500], minLevel: 'warn', hint: /\bx\b|x[-_]|twitter|header/i, not: /bluesky|bsky/i, skip: 'not on X' },
    { key: 'linkedin', label: 'LinkedIn profile banner', ratio: 4, tol: 0.01, rec: [1584, 396], min: [1584, 396], minLevel: 'warn', maxMB: 8, maxLevel: 'warn', hint: /linked ?in|li[-_]|profile|personal|member/i, skip: 'no personal LinkedIn' },
    { key: 'linkedin-page', label: 'LinkedIn Page cover', ratio: 1512 / 256, tol: 0.02, rec: [1512, 256], min: [1512, 256], maxMB: 3, old: [1128, 191], hint: /page|company|cover|linked/i, skip: 'no LinkedIn Page' },
    { key: 'facebook', label: 'Facebook cover', ratio: 851 / 315, tol: 0.04, rec: [851, 315], min: [400, 150], hint: /face ?book|fb/i, skip: 'not on Facebook' },
  ],
  avatar: { min: 400, maxMB: 2, hint: /avatar|profile|pfp|logo|icon|photo|picture|mark/i },
  words: [], wordsWhy: '',
};

// Social profiles: one avatar (square) and a banner per site, matched by shape (file names break ties).
function profileArt(S, imgs, issues, found, used) {
  const pool = imgs.filter((im) => !/sheet|look|context|preview/i.test(basename(im.file)));
  const ok = (im) => ['png', 'jpeg'].includes(im.format);
  const squares = pool.filter((im) => im.w === im.h).sort((a, b) => (S.avatar.hint.test(basename(b.file)) ? 1 : 0) - (S.avatar.hint.test(basename(a.file)) ? 1 : 0));
  const av = squares[0];
  if (!av) issues.push(issue('missing-avatar', 'error', 'No profile picture (a square image; 400×400 or larger works everywhere: X shows 400×400, YouTube renders 98×98, LinkedIn wants 400×400 for a Page logo).', 'Render one square avatar, e.g. --size 800x800.'));
  else {
    used.add(av.file); found.push({ key: 'avatar', label: 'Profile picture', file: av.rel, w: av.w, h: av.h, format: av.format, alpha: av.alpha, kb: av.kb, abs: av.file });
    if (av.w < S.avatar.min) issues.push(issue('avatar-small', 'warn', `The profile picture is ${av.w}×${av.h}; X and LinkedIn want 400×400.`, 'Render it at 800×800.'));
    if (av.kb > S.avatar.maxMB * 1024) issues.push(issue('avatar-mb', 'error', `The profile picture is ${(av.kb / 1024).toFixed(1)} MB; X takes up to ${S.avatar.maxMB} MB.`, 'Save it as JPG, or smaller.'));
    if (!ok(av)) issues.push(issue('avatar-format', 'error', `The profile picture is ${av.format.toUpperCase()}; use PNG or JPG (LinkedIn takes only those).`, 'Save it as PNG or JPG.'));
    if (av.alpha) issues.push(issue('avatar-alpha', 'warn', 'The profile picture has transparency. LinkedIn shows it on white and X/YouTube on light or dark, so the edges change from site to site.', 'Give it a solid background.'));
    for (const im of squares.slice(1)) if (!used.has(im.file)) { used.add(im.file); issues.push(issue('extra', 'warn', `${im.rel}: another square image; only one profile picture is used (name it "avatar" to choose).`, 'Remove it.')); }
  }
  for (const p of S.profiles) {
    let cand = pool.filter((im) => !used.has(im.file) && Math.abs(im.w / im.h - p.ratio) / p.ratio <= p.tol && !(p.not && p.not.test(basename(im.file))));
    cand.sort((a, b) => (p.hint.test(basename(b.file)) ? 1 : 0) - (p.hint.test(basename(a.file)) ? 1 : 0) || b.w - a.w);
    const im = cand[0];
    if (!im) { issues.push(issue('missing-' + p.key, 'warn', `No ${p.label} (${p.rec.join('×')}). Skip this if ${p.skip}.`, `Render it with --size ${p.rec.join('x')}.`)); continue; }
    used.add(im.file); found.push({ key: p.key, label: p.label, file: im.rel, w: im.w, h: im.h, format: im.format, alpha: im.alpha, kb: im.kb, abs: im.file });
    for (const x of cand.slice(1)) if (p.hint.test(basename(x.file)) === p.hint.test(basename(im.file)) && x.w === im.w) { used.add(x.file); issues.push(issue('extra', 'warn', `${x.rel}: a second ${p.label}; only one is used.`, 'Remove it.')); }
    if (p.old && im.w === p.old[0] && im.h === p.old[1]) issues.push(issue('old-size', 'error', `${p.label} ${im.rel} is ${im.w}×${im.h}, LinkedIn's old size. Pages now take ${p.rec.join('×')} (both minimum and recommended, 2026).`, `Render it at ${p.rec.join('×')}.`));
    else if (im.w < p.min[0] || im.h < p.min[1]) issues.push(issue('size-' + p.key, p.minLevel || 'error', `${p.label} ${im.rel} is ${im.w}×${im.h}; it needs at least ${p.min.join('×')}${p.rec[0] !== p.min[0] ? ` (${p.rec.join('×')} recommended)` : ''}.`, `Render it at ${p.rec.join('×')}.`));
    else if (p.key === 'youtube' && im.w < p.rec[0]) issues.push(issue('size-youtube', 'warn', `The YouTube banner is ${im.w}×${im.h}; YouTube recommends 2560×1440 so it's sharp on TVs.`, 'Render it at 2560×1440.'));
    if (p.maxMB && im.kb > p.maxMB * 1024) issues.push(issue('mb-' + p.key, p.maxLevel || 'error', `${p.label} is ${(im.kb / 1024).toFixed(1)} MB; the limit is ${p.maxMB} MB.`, 'Save it as JPG at quality ~85.'));
    if (!ok(im)) issues.push(issue('format-' + p.key, 'error', `${p.label} ${im.rel} is ${im.format.toUpperCase()}; use JPG or PNG.`, 'Save it as JPG or PNG.'));
    if (im.alpha) issues.push(issue('alpha-' + p.key, 'warn', `${p.label} ${im.rel} has transparency; sites fill it with their own background colour.`, 'Flatten it (render without --alpha).'));
  }
}

function walk(dir, out = []) {
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    if (f.name.startsWith('.') || f.name === 'node_modules') continue;
    const p = join(dir, f.name);
    if (f.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

// Opaque-ness of corners and edges, for icon rules (rounded corners on Play, padding on Chrome).
async function alphaProbe(page, file) {
  const url = 'data:image/png;base64,' + readFileSync(file).toString('base64');
  return page.evaluate(async (u) => {
    const img = new Image(); img.src = u; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const x = c.getContext('2d'); x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data, W = c.width, H = c.height;
    const a = (i, j) => d[(j * W + i) * 4 + 3];
    const corner = Math.min(a(0, 0), a(W - 1, 0), a(0, H - 1), a(W - 1, H - 1));
    let edge = 0, n = 0; const band = Math.max(1, Math.round(W / 8));
    for (let j = 0; j < H; j += 2) for (let i = 0; i < W; i += 2) if (i < band || j < band || i >= W - band || j >= H - band) { edge += a(i, j) > 20 ? 1 : 0; n++; }
    return { corner, center: a(W >> 1, H >> 1), edgeOpaque: edge / n };
  }, url);
}

async function htmlText(file) {
  const s = readFileSync(file, 'utf8').replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  return s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

// Apple Podcasts: one show cover (required) and episode art (optional, file names with "episode"), square 1400–3000.
function squareArt(S, imgs, files, issues, found, used, root) {
  const q = S.square;
  const isEp = (f) => /episode|(^|[^a-z])ep[\s_-]?\d/i.test(basename(f));
  const ep = imgs.filter((im) => isEp(im.file)), covers = imgs.filter((im) => !isEp(im.file) && !/sheet|look|context/i.test(basename(im.file))).sort((a, b) => (/cover|show/i.test(basename(b.file)) ? 1 : 0) - (/cover|show/i.test(basename(a.file)) ? 1 : 0));
  const one = (im, key, label) => {
    used.add(im.file); found.push({ key, label, file: im.rel, w: im.w, h: im.h, format: im.format, alpha: im.alpha, kb: im.kb, abs: im.file });
    if (im.w !== im.h) issues.push(issue('square-' + key, 'error', `${label} ${im.rel} is ${im.w}×${im.h}; it must be square.`, `Make it ${q.best}×${q.best}.`));
    else if (im.w < q.min || im.w > q.max) issues.push(issue('size-' + key, 'error', `${label} ${im.rel} is ${im.w}×${im.h}; Apple Podcasts accepts ${q.min}×${q.min} to ${q.max}×${q.max}.`, `Make it ${q.best}×${q.best}.`));
    else if (im.w < q.best) issues.push(issue('size-' + key, 'warn', `${label} is ${im.w}×${im.h}; Apple prefers the largest, ${q.best}×${q.best}.`, `Render it at ${q.best}×${q.best}.`));
    if (!q.formats.includes(im.format)) issues.push(issue('format-' + key, 'error', `${label} ${im.rel} is ${im.format.toUpperCase()}; it must be PNG or JPG.`, 'Save it as PNG or JPG.'));
    if (q.noAlpha && im.alpha) issues.push(issue('alpha-' + key, 'error', `${label} ${im.rel} has an alpha channel; Apple says artwork can't contain transparency and shouldn't have an alpha channel.`, 'Render it without --alpha (store-art flattens PNGs), or save as JPG.'));
  };
  if (!covers.length) issues.push(issue('missing-cover', 'error', `No show cover (square, ${q.min}–${q.max} px; ${q.best}×${q.best} preferred).`, `Render it with --size ${q.best}x${q.best}.`));
  else { one(covers[0], 'cover', 'Show cover'); for (const im of covers.slice(1)) issues.push(issue('extra', 'warn', `${im.rel}: only one show cover is used; name episode art with "episode" or "ep1" in the file name.`, 'Remove or rename it.')); }
  for (const im of ep) one(im, 'episode', 'Episode art');
  S._episodeHtml = files.filter((f) => isEp(f) && /\.html?$/i.test(f));
}

// Etsy / Shopify: every image is a listing photo, in file-name order (the first is the main photo).
function shopPhotos(S, imgs, issues, found, used) {
  const p = S.photos;
  const photos = imgs.filter((im) => !/sheet|look|context/i.test(basename(im.file))).sort((a, b) => a.rel.localeCompare(b.rel));
  if (photos.length < p.min) issues.push(issue('photos-count', 'error', `No listing photos found.`, 'Add them.'));
  photos.forEach((im, i) => {
    used.add(im.file); found.push({ key: i ? 'photo' : 'main', label: i ? `Photo ${i + 1}` : 'Main photo', file: im.rel, w: im.w, h: im.h, format: im.format, alpha: im.alpha, kb: im.kb, abs: im.file });
    if (!p.formats.includes(im.format)) issues.push(issue('format', 'error', `${im.rel} is ${im.format.toUpperCase()}; ${S.name} takes ${p.formats.map((f) => f.toUpperCase()).join(', ')}.`, 'Save it as JPG or PNG.'));
    if (p.noAlpha && im.alpha) issues.push(issue('alpha', 'error', `${im.rel} has transparency. ${p.noAlpha}`, 'Flatten it onto a background (render without --alpha, or save as JPG).'));
    if (p.firstMin && i === 0 && Math.min(im.w, im.h) < p.firstMin) issues.push(issue('main-small', 'error', `The first photo is ${im.w}×${im.h}; Etsy wants at least ${p.firstMin} px on each side or the listing shows lower in search.`, `Make it at least ${p.rec}×${p.rec}.`));
    else if (p.rec && Math.min(im.w, im.h) < p.rec) issues.push(issue('photo-small', 'warn', `${im.rel} is ${im.w}×${im.h}; Etsy recommends at least ${p.rec} px on each side.`, `Render it at ${p.rec} px or more.`));
    if (p.firstLandscapeOrSquare && i === 0 && im.h > im.w) issues.push(issue('main-portrait', 'error', `The first photo is portrait (${im.w}×${im.h}); Etsy says the first photo should be landscape or square so its thumbnails crop well.`, 'Make the first photo landscape or square, with a border the crops can lose.'));
    if (p.maxKBWarn && im.kb > p.maxKBWarn) issues.push(issue('photo-kb', 'warn', `${im.rel} is ${im.kb} KB; Etsy says images over 1 MB may not finish uploading on a slow connection.`, 'Save as JPG at quality ~85.'));
    if (p.maxSide && (im.w > p.maxSide || im.h > p.maxSide || im.w * im.h > p.maxMP * 1e6)) issues.push(issue('photo-big', 'error', `${im.rel} is ${im.w}×${im.h}; Shopify takes up to ${p.maxSide}×${p.maxSide} px or ${p.maxMP} megapixels.`, 'Make it smaller (2048×2048 for square photos).'));
    if (p.maxMB && im.kb > p.maxMB * 1024) issues.push(issue('photo-mb', 'error', `${im.rel} is over ${p.maxMB} MB.`, 'Compress it.'));
    if (p.squareRec && im.w === im.h && im.w < p.squareRec) issues.push(issue('photo-small', 'warn', `${im.rel} is ${im.w}×${im.h}; for square product photos Shopify says ${p.squareRec}×${p.squareRec} usually displays best.`, `Render it at ${p.squareRec}×${p.squareRec}.`));
  });
  if (p.sameRatio && photos.length > 1) {
    const r = (im) => (im.w / im.h).toFixed(2), first = r(photos[0]), odd = photos.filter((im) => r(im) !== first);
    if (odd.length) issues.push(issue('ratio-mixed', 'warn', `Not all photos share the main photo's aspect ratio (${photos[0].w}×${photos[0].h}): ${odd.map((x) => `${x.rel} ${x.w}×${x.h}`).join(', ')}. Shopify themes show images at the same size only with a consistent aspect ratio.`, 'Use one aspect ratio for the main photos.'));
  }
}

export async function check(store, folder, { out = 'art' } = {}) {
  const S = STORES[store];
  if (!S) throw new Error(`store must be one of: ${Object.keys(STORES).join(', ')}`);
  const root = resolve(folder);
  const files = walk(root);
  const imgs = files.filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f)).map((f) => {
    const b = readFileSync(f), info = imageInfo(b);
    return { file: f, rel: relative(root, f), kb: Math.round(b.length / 1024), ...info };
  }).filter((x) => x.w && x.h);
  const issues = [], found = [], used = new Set();

  // Steam: sizes it stopped accepting in Aug 2024.
  for (const [w, h, what] of S.old || []) for (const im of imgs) if (im.w === w && im.h === h) { issues.push(issue('old-size', 'error', `${im.rel} is ${w}×${h}, the old ${what}. Steam no longer accepts the old sizes (since Aug 2024).`, 'Make it at the current size.')); used.add(im.file); }

  if (S.square) squareArt(S, imgs, files, issues, found, used, root);
  if (S.photos) shopPhotos(S, imgs, issues, found, used);
  if (S.profiles) profileArt(S, imgs, issues, found, used);
  for (const a of S.assets || []) {
    let cand = imgs.filter((im) => !used.has(im.file) && (a.logo ? im.format === 'png' && ((im.w === 1280 && im.h <= 720) || (im.h === 720 && im.w <= 1280)) : im.w === a.w && im.h === a.h));
    if (a.hint && cand.length > 1) cand = cand.filter((im) => a.hint.test(im.rel)).concat(cand.filter((im) => !a.hint.test(im.rel)));
    else if (a.hint && cand.length === 1 && !a.hint.test(cand[0].rel) && S.assets.some((b) => b !== a && b.w === a.w && b.h === a.h)) cand = a.fallback ? [] : cand;
    const im = cand[0];
    if (!im) {
      if (a.required && a.fallback && found.some((f) => f.key === a.fallback)) issues.push(issue('missing-' + a.key, 'warn', `No ${a.label} (${a.w}×${a.h}); Steam falls back to the ${a.fallback} capsule.`, `Add one named with "library" in the file name if it should differ.`));
      else if (a.required) issues.push(issue('missing-' + a.key, 'error', `No ${a.label}${a.logo ? ' (PNG with transparency, 1280 wide and/or 720 tall)' : ` at exactly ${a.w}×${a.h}`}.`, 'Make it at that exact size (render <design.html> --size WxH).'));
      else if (a.recommended) issues.push(issue('missing-' + a.key, 'warn', `No ${a.label} (${a.w}×${a.h}). ${a.recommended}`, 'Add it.'));
      continue;
    }
    used.add(im.file); found.push({ key: a.key, label: a.label, file: im.rel, w: im.w, h: im.h, format: im.format, alpha: im.alpha, kb: im.kb, abs: im.file });
    if (a.png && im.format !== 'png') issues.push(issue('format-' + a.key, 'error', `${a.label} ${im.rel} is ${im.format.toUpperCase()}; it must be PNG.`, 'Save it as PNG.'));
    if (a.jpg && im.format !== 'jpeg') issues.push(issue('format-' + a.key, 'warn', `${a.label} ${im.rel} is ${im.format.toUpperCase()}; Steam asks for JPG.`, 'Save it as .jpg.'));
    if (a.noAlpha && im.alpha) issues.push(issue('alpha-' + a.key, 'error', `${a.label} ${im.rel} has an alpha channel; the store rejects it.`, 'Flatten it (render without --alpha, or save as JPEG).'));
    if (a.alpha && !im.alpha) issues.push(issue('alpha-' + a.key, 'error', `${a.label} ${im.rel} has no transparency; it's laid over the hero art.`, 'Render it with --alpha on a transparent background.'));
    if (a.maxKB && im.kb > a.maxKB) issues.push(issue('kb-' + a.key, 'error', `${a.label} is ${im.kb} KB (max ${a.maxKB} KB).`, 'Compress it.'));
  }

  // Screenshots: everything else that isn't one of the named assets.
  const sh = S.shots || { min: 0, label: 'Screenshots' }, shots = !S.shots ? [] : imgs.filter((im) => !used.has(im.file) && !/sheet|look|preview-|context/i.test(basename(im.file)));
  const good = [], bad = [];
  for (const im of shots) {
    const long = Math.max(im.w, im.h), short = Math.min(im.w, im.h); let why = null;
    if (sh.sizes && !sh.sizes.some(([w, h]) => im.w === w && im.h === h)) why = `${im.w}×${im.h}, not ${sh.sizes.map((s) => s.join('×')).join(' or ')}`;
    if (sh.minSide && (short < sh.minSide || long > sh.maxSide)) why = `${im.w}×${im.h}, outside ${sh.minSide}–${sh.maxSide} px`;
    else if (sh.ratio && long / short > sh.ratio + 1e-6) why = `${im.w}×${im.h}: the long side is ${(long / short).toFixed(2)}× the short side (max ${sh.ratio}×)`;
    if (sh.minW && (im.w < sh.minW || im.h < sh.minH)) why = `${im.w}×${im.h}, under ${sh.minW}×${sh.minH}`;
    else if (sh.ratio169 && Math.abs(im.w / im.h - 16 / 9) > 0.01) why = `${im.w}×${im.h} isn't 16:9`;
    if (why) { bad.push(im); issues.push(issue('shot-size', 'error', `${im.rel}: ${why}. It won't be accepted as a ${sh.label.toLowerCase().replace(/s$/, '')}.`, 'Remove it from the upload folder or remake it at an accepted size.')); continue; }
    if (sh.noAlpha && im.alpha) issues.push(issue('shot-alpha', 'error', `${im.rel} has an alpha channel; Play rejects it.`, 'Flatten it or save as JPEG.'));
    if (sh.maxMB && im.kb > sh.maxMB * 1024) issues.push(issue('shot-mb', 'error', `${im.rel} is over ${sh.maxMB} MB.`, 'Compress it.'));
    if (sh.recSide && short < sh.recSide) issues.push(issue('shot-small', 'warn', `${im.rel} is ${im.w}×${im.h}; Play wants at least 1080 px (e.g. 1080×1920) for its recommendations.`, 'Render at 1080×1920.'));
    good.push(im);
  }
  good.sort((a, b) => a.rel.localeCompare(b.rel));
  if (good.length < sh.min) issues.push(issue('shots-count', 'error', `${good.length} usable ${sh.label.toLowerCase()}; ${S.name} needs at least ${sh.min}.`, 'Add more.'));
  if (sh.max && good.length > sh.max) issues.push(issue('shots-count', 'error', `${good.length} ${sh.label.toLowerCase()}; ${S.name} takes at most ${sh.max}.`, 'Keep the best ones.'));
  if (sh.good && good.length >= sh.min && good.length < sh.good) issues.push(issue('shots-few', 'warn', `${good.length} screenshots; Play needs at least ${sh.good} (3 for games) for an app to be eligible for its recommendations.`, 'Add more.'));
  for (const im of good) found.push({ key: 'screenshot', label: sh.label, file: im.rel, w: im.w, h: im.h, format: im.format, kb: im.kb, abs: im.file });

  // Banned words in the HTML the graphics were made from.
  for (const f of S._episodeHtml || []) { const t = await htmlText(f); if (t.length) issues.push(issue('episode-text', 'error', `Episode art (${relative(root, f)}) has text ("${t.slice(0, 40)}"); Apple says to avoid any text or the podcast logo in episode art.`, 'Remove the text; let the image carry the episode.')); }
  for (const f of files.filter((x) => /\.html?$/i.test(x))) {
    const t = await htmlText(f), hits = [...new Set(S.words.map((r) => (t.match(r) || [])[0]).filter(Boolean))];
    if (hits.length) issues.push(issue('words', 'error', `${relative(root, f)} says ${hits.map((h) => `"${h}"`).join(', ')}. ${S.wordsWhy}`, 'Take those words out of the graphic.'));
    const a = found.find((x) => x.key === 'library-hero' && basename(x.file).replace(/\.\w+$/, '') === basename(f).replace(/\.\w+$/, ''));
    if (a && t.length > 0) issues.push(issue('hero-text', 'error', `The library hero (${relative(root, f)}) has text ("${t.slice(0, 40)}"); Steam wants no text at all on it (the logo is a separate file laid over it).`, 'Remove the text from the hero.'));
  }

  // Icon pixel rules and the sheet.
  const browser = await launch();
  let sheet = null;
  try {
    const page = await browser.newPage();
    const icon = found.find((x) => x.key === 'icon');
    if (icon && icon.format === 'png') {
      const p = await alphaProbe(page, icon.abs);
      if (store === 'google-play' && p.corner < 128 && p.center > 200) issues.push(issue('icon-rounded', 'warn', 'The icon\'s corners are transparent: it looks pre-rounded. Play applies its own mask (30% radius) and shadow, so a rounded icon ends up with a double edge or a halo.', 'Make the icon a full square; let Play round it.'));
      if (store === 'chrome-web-store' && p.edgeOpaque > 0.35) issues.push(issue('icon-padding', 'warn', `The icon's art reaches the edges (${Math.round(p.edgeOpaque * 100)}% of the outer 16 px is opaque). Chrome's spec is 96×96 art with 16 px of transparent padding each side.`, 'Shrink the art to 96×96 centred on a transparent 128×128.'));
    }
    sheet = resolve(out + '-sheet.png');
    mkdirSync(dirname(sheet), { recursive: true });
    const html = drawSheet(store, found);
    const tmp = resolve(out + '-sheet.html');
    writeFileSync(tmp, html);
    await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(tmp).href, { waitUntil: 'load', timeout: 60000 });
    await page.evaluate(() => document.fonts?.ready);
    await new Promise((ok) => setTimeout(ok, 300));
    await page.screenshot({ path: sheet, fullPage: true });
  } finally { await browser.close(); }

  const errors = issues.filter((i) => i.level === 'error').length;
  return { ok: !errors, store, errors, warnings: issues.length - errors, found: found.map(({ abs, ...x }) => x), issues, sheet,
    look: `LOOK at ${sheet}: is the name readable at the smallest sizes? Does each piece make sense on its own? Is anything important in a cutoff zone or outside the safe area?` };
}

// ---------- the sheet: each asset where and how the store shows it ----------
function drawSheet(store, found) {
  const u = (k) => { const f = found.find((x) => x.key === k); return f ? pathToFileURL(f.abs).href : null; };
  const shots = found.filter((x) => x.key === 'screenshot').map((x) => pathToFileURL(x.abs).href);
  const img = (src, w, h, extra = '') => src ? `<img src="${src}" style="width:${w}px;height:${h}px;object-fit:cover;display:block;${extra}">` : `<div class="miss" style="width:${w}px;height:${h}px">missing</div>`;
  const css = `body{margin:0;font:14px/1.4 -apple-system,system-ui,sans-serif;background:#fff;color:#111}.sec{padding:22px 28px;border-bottom:1px solid #ddd}.sec h2{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:#666;margin:0 0 14px}
  .row{display:flex;gap:22px;align-items:flex-start;flex-wrap:wrap}.lab{font-size:12px;color:#666;margin-top:6px}.miss{background:repeating-linear-gradient(45deg,#fdd,#fdd 8px,#fee 8px,#fee 16px);color:#a00;display:flex;align-items:center;justify-content:center;font-size:12px}
  .dark{background:#111;color:#eee}.dark .lab{color:#aaa}.box{position:relative}.zone{position:absolute;border:2px dashed #ff2d55;pointer-events:none}`;
  let body = '';
  if (store === 'google-play') {
    const ic = u('icon'), fg = u('feature');
    const listRow = (bg, fgc) => `<div style="background:${bg};color:${fgc};padding:14px;border-radius:12px;width:330px">${[0, 1, 2].map((i) => `<div style="display:flex;gap:12px;align-items:center;margin:8px 0">${i === 1 ? img(ic, 48, 48, 'border-radius:14px;box-shadow:0 1px 3px rgba(0,0,0,.35)') : `<div style="width:48px;height:48px;border-radius:14px;background:${fgc === '#fff' ? '#333' : '#ddd'}"></div>`}<div><div style="font-weight:600">${i === 1 ? 'Your app' : 'Other app'}</div><div style="font-size:12px;opacity:.7">4.5 ★</div></div></div>`).join('')}</div>`;
    body += `<div class="sec"><h2>Icon, masked by Play (30% radius) in a list at 48 px, light and dark; and full size</h2><div class="row">${listRow('#fff', '#111')}${listRow('#1f1f1f', '#fff')}<div>${img(ic, 192, 192, 'border-radius:58px;box-shadow:0 2px 6px rgba(0,0,0,.3)')}<div class="lab">192 px, masked</div></div></div></div>`;
    body += `<div class="sec"><h2>Feature graphic: full size with the cutoff zones (keep logo, name and key UI inside the dashed box), and at phone width</h2><div class="row"><div class="box">${img(fg, 1024, 500)}<div class="zone" style="left:12%;right:12%;top:14%;bottom:14%"></div><div class="lab">1024×500. The dashed box is Palm's estimate of the safe centre; Google doesn't publish exact cutoff sizes.</div></div><div>${img(fg, 360, 176)}<div class="lab">360 px wide, as on a phone</div></div></div></div>`;
    body += `<div class="sec"><h2>Screenshots as the listing shows them (about 300 px tall), in order</h2><div class="row" style="flex-wrap:nowrap;overflow:hidden">${shots.slice(0, 8).map((s, i) => `<div>${`<img src="${s}" style="height:300px;display:block;border-radius:8px">`}<div class="lab">${i + 1}</div></div>`).join('') || '<div class="miss" style="width:300px;height:300px">no screenshots</div>'}</div></div>`;
  } else if (store === 'chrome-web-store') {
    const ic = u('icon'), st = u('small-tile'), mq = u('marquee');
    body += `<div class="sec"><h2>Icon on light and dark, at 128 and toolbar sizes (32, 16)</h2><div class="row">${['#fff', '#202124'].map((bg) => `<div style="background:${bg};padding:16px;display:flex;gap:18px;align-items:center;border-radius:8px">${img(ic, 128, 128)}${img(ic, 32, 32)}${img(ic, 16, 16)}</div>`).join('')}</div></div>`;
    body += `<div class="sec" style="background:#f1f3f4"><h2>Small promo tile on the store's grey page: at half size (220×140, the store says it must read there) among others, and full size</h2><div class="row">${[0, 1, 2].map((i) => `<div style="background:#fff;border-radius:8px;overflow:hidden;width:220px">${i === 1 ? img(st, 220, 140) : '<div style="width:220px;height:140px;background:#c9d3dc"></div>'}<div style="padding:8px;font-size:12px">${i === 1 ? '<b>Your extension</b>' : 'Other extension'}</div></div>`).join('')}<div>${img(st, 440, 280)}<div class="lab">440×280</div></div></div></div>`;
    body += `<div class="sec"><h2>Marquee tile (home page carousel), at 700×280</h2>${img(mq, 700, 280)}</div>`;
    body += `<div class="sec"><h2>Screenshots as shown (640×400)</h2><div class="row">${shots.slice(0, 5).map((s) => `<img src="${s}" style="width:640px;height:400px;object-fit:fill;display:block;border:1px solid #ddd">`).join('') || '<div class="miss" style="width:640px;height:400px">no screenshots</div>'}</div></div>`;
  } else if (store === 'apple-podcasts') {
    const cv = u('cover'), eps = found.filter((x) => x.key === 'episode').map((x) => pathToFileURL(x.abs).href);
    const list = (bg, fg, sz) => `<div style="background:${bg};color:${fg};padding:14px;border-radius:12px;width:360px">${[0, 1, 2, 3].map((i) => `<div style="display:flex;gap:12px;align-items:center;margin:8px 0">${i === 1 ? img(cv, sz, sz, 'border-radius:6px') : `<div style="width:${sz}px;height:${sz}px;border-radius:6px;background:hsl(${i * 80 + 20},45%,${fg === '#fff' ? 35 : 70}%)"></div>`}<div><div style="font-weight:600;font-size:13px">${i === 1 ? 'Your show' : 'Another show'}</div><div style="font-size:11px;opacity:.6">Episode · 42 min</div></div></div>`).join('')}</div>`;
    body += `<div class="sec"><h2>Show cover in a list at 60 px and in search at 44 px, light and dark: can you read the name? Would you know it again?</h2><div class="row">${list('#fff', '#111', 60)}${list('#1c1c1e', '#fff', 60)}${list('#fff', '#111', 44)}</div></div>`;
    body += `<div class="sec dark" style="background:linear-gradient(#3a3a5a,#121218)"><h2 style="color:#bbb">Lock screen / Now Playing (about 300 px), and full cover at 600 px</h2><div class="row"><div style="width:340px;padding:20px;border-radius:24px;background:rgba(255,255,255,.12)">${img(cv, 300, 300, 'border-radius:12px')}<div style="margin-top:10px;font-weight:600">Episode title</div><div style="font-size:12px;opacity:.7">Your show</div></div>${img(cv, 600, 600)}</div></div>`;
    if (eps.length) body += `<div class="sec"><h2>Episode art (${eps.length}): no text, no logo; shown on Now Playing and episode pages</h2><div class="row">${eps.slice(0, 6).map((e) => img(e, 240, 240, 'border-radius:8px')).join('')}</div></div>`;
  } else if (store === 'profiles') {
    const F = (k) => found.find((x) => x.key === k);
    const av = F('avatar'), avu = av ? pathToFileURL(av.abs).href : null;
    // A banner shown in a box of bw×bh, scaled to `scale`× the box width (1 = fits the width), aligned centre or left.
    const ban = (k, bw, bh, { scale = 1, pos = 'center', label = '' } = {}) => { const f = F(k); if (!f) return `<div class="miss" style="width:${bw}px;height:${bh}px">no ${label || k}</div>`; const sc = Math.max(scale, (bh * f.w / f.h) / bw); return `<div style="width:${bw}px;height:${bh}px;background:#888 url('${pathToFileURL(f.abs).href}') ${pos} / ${Math.round(bw * sc)}px auto no-repeat"></div>`; };
    const face = (sz, round = true, ring = '#fff') => avu ? `<img src="${avu}" style="width:${sz}px;height:${sz}px;object-fit:cover;display:block;border-radius:${round ? '50%' : Math.round(sz * 0.08) + 'px'};box-shadow:0 0 0 ${Math.max(2, Math.round(sz / 30))}px ${ring}">` : `<div class="miss" style="width:${sz}px;height:${sz}px;border-radius:${round ? '50%' : '6px'}">avatar</div>`;
    const over = (banner, w, h, sz, left, top, { round = true, ring = '#fff', bg = '#fff', fg = '#111', name = 'Your name', sub = '', zone = '' } = {}) => `<div style="background:${bg};color:${fg};width:${w}px;border-radius:10px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.25)"><div class="box" style="height:${h}px">${banner}${zone}</div><div style="position:relative;height:${Math.max(0, top - h + sz) + 52}px"><div style="position:absolute;left:${left}px;top:${top - h}px">${face(sz, round, ring)}</div><div style="position:absolute;left:${left}px;top:${Math.max(0, top - h + sz) + 8}px;font-weight:700">${name}</div>${sub ? `<div style="position:absolute;left:${left}px;top:${Math.max(0, top - h + sz) + 26}px;font-size:12px;opacity:.65">${sub}</div>` : ''}</div></div>`;
    // Avatar at the sizes it's actually seen.
    const avRow = (bg, fg) => `<div style="background:${bg};color:${fg};padding:14px;border-radius:10px;width:300px">${[0, 1, 2].map((i) => `<div style="display:flex;gap:10px;align-items:center;margin:8px 0">${i === 1 ? face(40, true, 'transparent') : `<div style="width:40px;height:40px;border-radius:50%;background:${fg === '#fff' ? '#333' : '#ddd'}"></div>`}<div><div style="font-weight:600;font-size:13px">${i === 1 ? 'You' : 'Someone else'}</div><div style="font-size:12px;opacity:.6">replied · 2h</div></div></div>`).join('')}</div>`;
    body += `<div class="sec"><h2>Profile picture where it's seen: in replies and comments at 40 px and as small as 24 px, light and dark; YouTube's 98 px; a LinkedIn Page's square logo</h2><div class="row">${avRow('#fff', '#111')}${avRow('#000', '#fff')}<div style="display:flex;gap:14px;align-items:flex-end">${face(24, true, 'transparent')}${face(32, true, 'transparent')}${face(98, true, 'transparent')}${face(98, false, 'transparent')}</div></div></div>`;
    // YouTube: TV shows the whole 16:9; desktop shows a centre band (~2560×423 of 2560×1440); phones a narrower centre (~1546×423). Safe area 1235×338 at 2048 wide (official).
    const yt = F('youtube');
    const safe = (bw, scaleW) => `<div class="zone" style="left:${(bw - scaleW * 1235 / 2048) / 2}px;width:${scaleW * 1235 / 2048}px;top:50%;height:${scaleW * 338 / 2048}px;transform:translateY(-50%)"></div>`;
    body += `<div class="sec dark" style="background:#0f0f0f"><h2 style="color:#aaa">YouTube banner: on a TV (all of it), on desktop (a centre band) and on a phone (a narrower centre). Dashed box: YouTube's safe area for text and logos (official); the band crops are Palm's measurement</h2><div class="row"><div><div class="box">${ban('youtube', 480, 270, { label: 'YouTube banner' })}${yt ? safe(480, 480) : ''}</div><div class="lab">TV, 16:9</div></div><div><div class="box">${ban('youtube', 820, 136, { label: 'YouTube banner' })}${yt ? safe(820, 820) : ''}</div><div style="display:flex;gap:14px;align-items:center;margin-top:14px">${face(72, true, 'transparent')}<div style="color:#fff"><div style="font-size:20px;font-weight:700">Your channel</div><div style="font-size:12px;color:#aaa">@yourchannel · 1.2K subscribers</div></div></div><div class="lab">desktop</div></div><div style="width:390px"><div class="box" style="overflow:hidden">${ban('youtube', 390, 107, { scale: 2560 / 1546, label: 'YouTube banner' })}${yt ? safe(390, 390 * 2560 / 1546) : ''}</div><div style="display:flex;gap:10px;align-items:center;margin-top:10px">${face(56, true, 'transparent')}<div style="color:#fff;font-weight:700">Your channel</div></div><div class="lab">phone</div></div></div></div>`;
    // X: 3:1 header, avatar circle over its lower left. Phones can trim the top and bottom (community: ~60 of 500 px each).
    const xTrim = (bw, bh) => `<div class="zone" style="left:0;width:${bw}px;top:${bh * 0.12}px;height:${bh * 0.76}px"></div>`;
    body += `<div class="sec"><h2>X header with the profile picture over its lower left: desktop (dark) and phone (light). Dashed lines: phones may trim about 12% top and bottom (community measurement)</h2><div class="row">${over(ban('x', 600, 200, { label: 'X header' }), 600, 200, 134, 16, 133, { bg: '#000', fg: '#e7e9ea', ring: '#000', name: 'Your name', sub: '@yourhandle' })}${over(ban('x', 390, 130, { label: 'X header' }), 390, 130, 80, 16, 100, { ring: '#fff', name: 'Your name', sub: '@yourhandle', zone: F('x') ? xTrim(390, 130) : '' })}</div></div>`;
    // LinkedIn member: 4:1 banner, round photo over the lower left. Company Page: ~5.9:1 cover, square logo over the lower left.
    body += `<div class="sec" style="background:#f4f2ee"><h2>LinkedIn: profile banner with the round photo over its lower left, desktop and phone; Page cover with the square logo over it, desktop and phone (overlap positions: Palm's measurement)</h2><div class="row">${over(ban('linkedin', 804, 201, { label: 'LinkedIn banner' }), 804, 201, 152, 24, 125, { name: 'Your Name', sub: 'Founder at Your Studio' })}${over(ban('linkedin', 390, 98, { label: 'LinkedIn banner' }), 390, 98, 88, 16, 54, { name: 'Your Name', sub: 'Founder at Your Studio' })}</div><div class="row" style="margin-top:18px">${over(ban('linkedin-page', 804, 136, { label: 'LinkedIn Page cover' }), 804, 136, 104, 24, 84, { round: false, name: 'Your Studio', sub: 'Design services · 120 followers' })}${over(ban('linkedin-page', 390, 66, { label: 'LinkedIn Page cover' }), 390, 66, 64, 16, 34, { round: false, name: 'Your Studio', sub: '120 followers' })}</div></div>`;
    // Facebook: cover shown wide on desktop; phones show a taller, narrower centre (Facebook: 820×312 desktop, 640×360 phone).
    body += `<div class="sec" style="background:#f0f2f5"><h2>Facebook Page cover: desktop (about 820×312) and phone (about 640×360, so the sides are cut), with the profile picture over the lower left</h2><div class="row">${over(ban('facebook', 820, 312, { scale: 820 / 820, label: 'Facebook cover' }), 820, 312, 168, 24, 250, { name: 'Your Page', sub: '1.2K likes' })}${over(ban('facebook', 390, 219, { scale: (219 * 851 / 315) / 390, label: 'Facebook cover' }), 390, 219, 96, 16, 180, { name: 'Your Page', sub: '1.2K likes' })}</div></div>`;
  } else if (store === 'etsy' || store === 'shopify') {
    const main = u('main'), all = found.filter((x) => x.key === 'main' || x.key === 'photo').map((x) => pathToFileURL(x.abs).href);
    const ph = (i) => `<div style="width:100%;height:100%;background:hsl(${i * 47 + 30},18%,${80 - (i % 3) * 6}%)"></div>`;
    const card = (w, h, i, mine) => `<div style="width:${w}px"><div style="width:${w}px;height:${h}px;overflow:hidden;border-radius:${store === 'etsy' ? 8 : 4}px">${mine ? img(main, w, h, 'object-position:center') : ph(i)}</div><div style="font-size:12px;margin-top:6px">${mine ? '<b>Your product</b>' : 'Another product'}</div><div style="font-size:12px;opacity:.7">$24.00</div></div>`;
    body += `<div class="sec"><h2>${store === 'etsy' ? 'Etsy crops the first photo to square, portrait and landscape thumbnails, centred: is the product whole in each?' : 'Collection grid (square, as most themes crop): does the product read among others?'}</h2><div class="row">${store === 'etsy'
      ? `<div>${img(main, 240, 240)}<div class="lab">square</div></div><div>${img(main, 200, 250)}<div class="lab">portrait 4:5</div></div><div>${img(main, 300, 225)}<div class="lab">landscape 4:3</div></div>`
      : ''}</div><div class="row" style="margin-top:16px">${[0, 1, 2, 3, 4].map((i) => card(store === 'etsy' ? 210 : 190, store === 'etsy' ? 168 : 190, i, i === 1)).join('')}</div></div>`;
    body += `<div class="sec"><h2>Listing page: main photo large with the others as thumbnails, in order (${all.length})</h2><div class="row"><div>${img(main, 520, 520, 'object-fit:contain;background:#f5f5f5')}</div><div style="display:grid;grid-template-columns:repeat(4,110px);gap:8px">${all.map((s) => `<img src="${s}" style="width:110px;height:110px;object-fit:cover;display:block;border:1px solid #ddd">`).join('')}</div></div></div>`;
    body += `<div class="sec"><h2>On a phone (390 px wide)</h2>${img(main, 390, 390, 'object-fit:contain;background:#f5f5f5')}</div>`;
  } else {
    const g = (k) => u(k);
    const searchRow = (w, h, title) => `<div style="display:flex;gap:10px;align-items:center;background:#16202d;padding:6px;margin:4px 0;width:620px">${img(g('small'), w, h)}<div style="color:#c7d5e0;font-size:13px">${title}</div></div>`;
    body += `<div class="sec dark" style="background:#1b2838"><h2 style="color:#8f98a0">Small capsule in search and lists at 120×45 and 184×69: is the name readable?</h2>${searchRow(120, 45, 'Your game')}${searchRow(184, 69, 'Your game')}<div class="row" style="margin-top:12px"><div>${img(g('small'), 462, 174)}<div class="lab">462×174</div></div></div></div>`;
    body += `<div class="sec dark" style="background:#1b2838"><h2 style="color:#8f98a0">Header (460×215, as on the store page) · Main capsule (616×353, home carousel) · Vertical (374×448, sales)</h2><div class="row">${img(g('header'), 460, 215)}${img(g('main'), 616, 353)}${img(g('vertical'), 374, 448)}</div></div>`;
    body += `<div class="sec dark" style="background:#23262e"><h2 style="color:#8f98a0">Library grid (capsules at 150×225) and the library hero with the logo over it; dashed box: the safe area that's never cropped</h2><div class="row">${[0, 1, 2, 3, 4].map((i) => i === 2 ? img(g('library-capsule'), 150, 225) : '<div style="width:150px;height:225px;background:#3a3f4a"></div>').join('')}</div>
      <div class="box" style="margin-top:18px;width:1240px;height:400px;overflow:hidden">${img(g('library-hero'), 1240, 400)}<div class="zone" style="left:${(1240 - 1240 * 860 / 1920) / 2}px;width:${1240 * 860 / 1920}px;top:${(400 - 400 * 380 / 620) / 2}px;height:${400 * 380 / 620}px"></div>${g('library-logo') ? `<img src="${g('library-logo')}" style="position:absolute;left:40px;bottom:30px;max-width:420px;max-height:150px">` : ''}</div>
      <div class="row" style="margin-top:14px"><div>${img(g('community-icon'), 32, 32)}<div class="lab">community icon, 32 px</div></div><div>${img(g('library-header'), 230, 107)}<div class="lab">library header, recent games</div></div></div></div>`;
    body += `<div class="sec"><h2>Screenshots (${shots.length}): gameplay only</h2><div class="row">${shots.slice(0, 8).map((s) => `<img src="${s}" style="width:300px;height:169px;object-fit:cover;display:block">`).join('') || '<div class="miss" style="width:300px;height:169px">no screenshots</div>'}</div></div>`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`;
}

// ---------- render an HTML design at an exact size ----------
export async function render(file, { out, size, jpeg = false, alpha = false, quality = 90 } = {}) {
  const [w, h] = String(size).split('x').map(Number);
  if (!w || !h) throw new Error('--size WxH is required, e.g. --size 1024x500');
  const browser = await launch();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(resolve(file)).href, { waitUntil: 'load', timeout: 30000 });
    await page.evaluate(() => document.fonts?.ready);
    await new Promise((ok) => setTimeout(ok, 200));
    const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight,
      small: [...document.querySelectorAll('body *')].filter((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())).map((e) => parseFloat(getComputedStyle(e).fontSize)) }));
    mkdirSync(dirname(resolve(out)), { recursive: true });
    const asJpeg = jpeg || /\.jpe?g$/i.test(out);
    if (!asJpeg && !alpha) await page.evaluate(() => { if (getComputedStyle(document.body).backgroundColor === 'rgba(0, 0, 0, 0)' && getComputedStyle(document.documentElement).backgroundColor === 'rgba(0, 0, 0, 0)') document.documentElement.style.background = '#fff'; });
    await page.screenshot({ path: out, type: asJpeg ? 'jpeg' : 'png', ...(asJpeg ? { quality } : {}), omitBackground: !asJpeg && alpha, clip: { x: 0, y: 0, width: w, height: h } });
    let buf = readFileSync(out), info = imageInfo(buf);
    if (!asJpeg && !alpha && info.alpha) {
      // Puppeteer writes RGBA PNGs: re-encode through a canvas as JPEG-like opaque PNG isn't possible, so draw onto an opaque canvas and save RGB.
      const page2 = await browser.newPage();
      const data = await page2.evaluate(async (u, W, H) => { const i = new Image(); i.src = u; await i.decode(); const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d', { alpha: false }); x.fillStyle = '#fff'; x.fillRect(0, 0, W, H); x.drawImage(i, 0, 0); return c.toDataURL('image/png'); }, 'data:image/png;base64,' + buf.toString('base64'), w, h);
      buf = stripAlpha(Buffer.from(data.split(',')[1], 'base64'));
      writeFileSync(out, buf); info = imageInfo(buf);
    }
    const issues = [];
    if (m.sw > w + 1 || m.sh > h + 1) issues.push(issue('overflow', 'warn', `The HTML is ${m.sw}×${m.sh}, bigger than ${w}×${h}: part of it is cut off.`, `Fit everything inside: html,body{width:${w}px;height:${h}px;overflow:hidden}.`));
    const minFont = m.small.length ? Math.min(...m.small) : null;
    return { ok: !issues.length, out, w, h, format: info.format, alpha: !!info.alpha, kb: Math.round(buf.length / 1024), smallestText: minFont, issues };
  } finally { await browser.close(); }
}

// Re-encodes an RGBA PNG (opaque pixels) as RGB, so stores that refuse alpha accept it. Pure JS (zlib).
import zlib from 'node:zlib';
function stripAlpha(png) {
  const info = imageInfo(png); if (!info.alpha || png[25] !== 6 || png[24] !== 8) return png;
  const W = info.w, H = info.h; const idat = []; let i = 8;
  while (i < png.length) { const len = png.readUInt32BE(i), type = png.toString('latin1', i + 4, i + 8); if (type === 'IDAT') idat.push(png.subarray(i + 8, i + 8 + len)); i += 12 + len; }
  const raw = zlib.inflateSync(Buffer.concat(idat)), bpp = 4, stride = W * bpp, out = Buffer.alloc(H * (W * 3 + 1));
  const prev = Buffer.alloc(stride), cur = Buffer.alloc(stride);
  for (let y = 0; y < H; y++) {
    const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0; let v = row[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1; else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[x] = v & 255;
    }
    out[y * (W * 3 + 1)] = 0;
    for (let x = 0; x < W; x++) { out[y * (W * 3 + 1) + 1 + x * 3] = cur[x * 4]; out[y * (W * 3 + 1) + 2 + x * 3] = cur[x * 4 + 1]; out[y * (W * 3 + 1) + 3 + x * 3] = cur[x * 4 + 2]; }
    cur.copy(prev);
  }
  const chunk = (type, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td) >>> 0); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([png.subarray(0, 8), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(out, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
let CRC; function crc32(b) { if (!CRC) { CRC = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c; } } let c = -1; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return c ^ -1; }

// ---------- self-test ----------
async function selfTest() {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const d = mkdtempSync(join(tmpdir(), 'store-art-'));
  const mk = (name, w, h, body, opts = {}) => { const f = join(d, name + '.html'); writeFileSync(f, `<html><body style="margin:0;width:${w}px;height:${h}px;${opts.bg === false ? 'background:transparent' : 'background:#2a6'};font:bold ${Math.round(h / 4)}px sans-serif;color:#fff;display:flex;align-items:center;justify-content:center">${body}</body></html>`); return render(f, { out: join(d, 'up', (opts.dir || '') + name + (opts.jpg ? '.jpg' : '.png')), size: `${w}x${h}`, alpha: !!opts.alpha }); };
  const f = await mk('feature', 1024, 500, 'Best app');
  if (f.alpha) throw new Error('render should flatten alpha');
  await mk('icon', 512, 512, 'A');
  await mk('s1', 1080, 1920, 'one'); await mk('s2', 1080, 1920, 'two'); await mk('bad', 1080, 3000, 'tall');
  const r = await check('google-play', join(d, 'up'), { out: join(d, 'gp') });
  const ids = r.issues.map((i) => i.id);
  for (const want of ['shot-size', 'shots-few']) if (!ids.includes(want)) throw new Error('play: expected ' + want + ' in ' + ids.join(','));
  // Steam: old size flagged, missing assets flagged.
  const sd = join(d, 'steam'); mkdirSync(sd);
  await render(join(d, 'feature.html'), { out: join(sd, 'old-header.png'), size: '460x215' });
  const s = await check('steam', sd, { out: join(d, 'st') });
  if (!s.issues.some((i) => i.id === 'old-size') || !s.issues.some((i) => i.id === 'missing-small')) throw new Error('steam checks: ' + s.issues.map((i) => i.id).join(','));
  // Words in the HTML source.
  writeFileSync(join(d, 'up', 'feature.html'), '<p>Best app, download now</p>');
  const w = await check('google-play', join(d, 'up'), { out: join(d, 'gp2') });
  if (!w.issues.some((i) => i.id === 'words')) throw new Error('words not flagged');
  // Podcasts: wrong size and alpha; episode text.
  const pd = join(d, 'pod'); mkdirSync(pd);
  await render(join(d, 'feature.html'), { out: join(pd, 'cover.png'), size: '1200x1200', alpha: true });
  writeFileSync(join(pd, 'episode-1.html'), '<p>Episode 1</p>');
  const pc = await check('apple-podcasts', pd, { out: join(d, 'pod') });
  for (const want of ['size-cover', 'episode-text']) if (!pc.issues.some((i) => i.id === want)) throw new Error('podcasts: expected ' + want + ' in ' + pc.issues.map((i) => i.id).join(','));
  // Etsy: portrait first photo, too small.
  const ed = join(d, 'etsy'); mkdirSync(ed);
  await render(join(d, 'feature.html'), { out: join(ed, '01.png'), size: '500x700' });
  const et = await check('etsy', ed, { out: join(d, 'etsy') });
  for (const want of ['main-small', 'main-portrait']) if (!et.issues.some((i) => i.id === want)) throw new Error('etsy: expected ' + want + ' in ' + et.issues.map((i) => i.id).join(','));
  // Shopify: a square photo under 2048 (warn), one side over 5000 px (error), and mixed aspect ratios (warn).
  const shd = join(d, 'shopify'); mkdirSync(shd);
  await render(join(d, 'feature.html'), { out: join(shd, '01-main.png'), size: '1200x1200' });
  await render(join(d, 'feature.html'), { out: join(shd, '02-wide.jpg'), size: '5200x400', jpeg: true });
  const sh = await check('shopify', shd, { out: join(d, 'shop') });
  for (const want of ['photo-small', 'photo-big', 'ratio-mixed']) if (!sh.issues.some((i) => i.id === want)) throw new Error('shopify: expected ' + want + ' in ' + sh.issues.map((i) => i.id).join(','));
  // and a clean Shopify set raises no errors or warnings
  const shok = join(d, 'shopify-ok'); mkdirSync(shok);
  for (const n of ['01', '02']) await render(join(d, 'feature.html'), { out: join(shok, n + '.jpg'), size: '2048x2048', jpeg: true });
  const sk = await check('shopify', shok, { out: join(d, 'shopok') });
  if (sk.issues.length) throw new Error('shopify clean set flagged: ' + sk.issues.map((i) => i.id).join(','));
  // Social profiles: no avatar, a YouTube banner under 2048 wide, LinkedIn's old Page size; then a clean kit.
  const pr = join(d, 'profiles'); mkdirSync(pr);
  await render(join(d, 'feature.html'), { out: join(pr, 'youtube.jpg'), size: '1920x1080', jpeg: true });
  await render(join(d, 'feature.html'), { out: join(pr, 'linkedin-page.jpg'), size: '1128x191', jpeg: true });
  const pf = await check('profiles', pr, { out: join(d, 'prof') });
  for (const want of ['missing-avatar', 'size-youtube', 'old-size', 'missing-x']) if (!pf.issues.some((i) => i.id === want)) throw new Error('profiles: expected ' + want + ' in ' + pf.issues.map((i) => i.id).join(','));
  const pk = join(d, 'profiles-ok'); mkdirSync(pk);
  await render(join(d, 'feature.html'), { out: join(pk, 'avatar.png'), size: '800x800' });
  for (const [n, sz] of [['youtube', '2560x1440'], ['x-header', '1500x500'], ['linkedin', '1584x396'], ['linkedin-page', '1512x256'], ['facebook', '851x315']]) await render(join(d, 'feature.html'), { out: join(pk, n + '.jpg'), size: sz, jpeg: true });
  const pg = await check('profiles', pk, { out: join(d, 'profok') });
  if (pg.issues.length || pg.found.length !== 6) throw new Error('profiles clean kit: ' + pg.issues.map((i) => i.id).join(',') + ' found ' + pg.found.map((f) => f.key).join(','));
  console.log(`store-art: all tests pass (play ${r.errors} errors, steam ${s.errors} errors; sheet ${r.sheet})`);
}

if (typeof process !== 'undefined' && process.argv?.[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
  const VALUED = new Set(['--out', '--size', '--quality']);
  const pos = argv.filter((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1]));
  const done = (r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); };
  const fail = (e) => { console.error(String(e.message || e)); process.exit(2); };
  if (argv.includes('--test')) selfTest().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
  else if (pos[0] === 'render' && pos[1]) render(pos[1], { out: opt('out', 'out.png'), size: opt('size'), jpeg: argv.includes('--jpeg'), alpha: argv.includes('--alpha'), quality: +opt('quality', 90) }).then(done, fail);
  else if (pos[0] === 'check' && pos[1] && pos[2]) check(pos[1], pos[2], { out: opt('out', 'art') }).then(done, fail);
  else fail('usage: store-art.mjs check <google-play|chrome-web-store|steam|apple-podcasts|etsy|shopify|profiles> <folder> [--out art]\n       store-art.mjs render <design.html> --size 1024x500 --out upload/feature.png [--jpeg] [--alpha]');
}
