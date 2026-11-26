#!/usr/bin/env node
// Palm tool: hero-check — renders a website's hero banner (a full-width photo with a headline and a button over it) at
// phone, tablet, laptop and desktop sizes, light and dark, draws a sheet to LOOK at, and measures what breaks between
// screen sizes: where each screen crops the photo (CSS object-fit / background-size cover and their position) and whether
// the subject stays in; the contrast of every line of text against the real pixels behind it; text over the subject;
// text size and the button on a phone; the image's resolution for 2× screens, its file weight, srcset/sizes/<picture>;
// a lazy-loaded or low-priority hero (LCP); the page jumping when the image arrives (CLS).
//
//   node hero-check.mjs check index.html [--selector .hero] [--subject x,y,w,h] [--source photos/photo.jpg]
//                       [--out look/hero] [--root site/] [--no-dark] [--plain]
//       → JSON {ok, errors, warnings, subject, views, issues, sheet}. Then LOOK at <out>-sheet.png.
//       --subject: the part of the photo that must stay in every crop (a face, the product), as fractions of the photo
//         (x, y, width, height from its top-left; e.g. 0.62,0.17,0.24,0.62). Without it, Palm estimates it (faces if
//         Chrome can find them, else the most colourful, contrasting region) and labels it an estimate.
//       --source: the original photo the --subject refers to. Crops you cut from it (a phone version, a <picture>
//         source) are found inside it automatically, so the subject is followed into every file.
//       A URL works too (http…); --root serves a local folder at / (default: the HTML file's folder).
//   node hero-check.mjs image photo.jpg --headline "…" [--line "…"] [--button "…"] [--position "75% 50%"]
//                       [--align left|center|right] [--scrim] [--subject x,y,w,h] [--out look/hero]
//       → builds a plain full-width hero from the photo and the words, then checks it the same way (to try a photo
//         and a position before building the real one).
//   node hero-check.mjs --self-test
//
// Facts used here (official pages, read 2026-11-26):
//   WCAG 2.2 SC 1.4.3 Contrast (Minimum), w3.org/WAI/WCAG22/Understanding/contrast-minimum: 4.5:1 for text, 3:1 for
//     large text ("at least 18 point or 14 point bold", "approximately … 24px" and "18.5px"); thresholds aren't rounded.
//     F83: "background images that do not provide sufficient contrast with foreground text" is a failure.
//   web.dev "Largest Contentful Paint": good is 2.5 s or less, poor over 4.0 s (75th percentile).
//   web.dev "Browser-level image lazy loading": "Don't lazy-load images that are likely to be in-viewport when the page
//     loads, especially LCP images"; "we recommend adding width and height attributes to all <img> tags".
//   web.dev "Cumulative Layout Shift": good is 0.1 or less, poor over 0.25.
//   shopify.dev "Don't use CSS background-image for LCP content": "Use <img> tags for hero and LCP images instead of CSS
//     background images to enable early discovery"; "You can use fetchpriority="high" to prioritize the LCP image";
//     example widths 600–2000 with sizes 100vw. shopify.dev "Serve correctly sized images with srcset and sizes":
//     without sizes "The browser defaults to downloading the largest image"; "Four to six widths are usually sufficient".
//   help.shopify.com "Uploading images": uploads can't exceed 20 megapixels or 20 MB.
// Palm's measurements and thresholds (not from a standard): how contrast is read over a photo (each line's text hidden,
//   the pixels behind its box sampled; the line passes when its contrast meets WCAG against 90% of them, with the
//   worst pixel reported too); a subject "kept" when 90% of its box is inside the crop; text "over the subject" when more
//   than 20% of a line's box covers it; the photo sharp enough when it has at least 0.75 image pixels per screen pixel;
//   file weight (over 300 KB on a phone, 900 KB on a big screen); headline 28 px or more on a phone; the button on the
//   phone's first screen and 44 px tall (Apple's HIG minimum; WCAG 2.5.8's minimum is 24 px); the viewports (390×844
//   @2x, 820×1180 @2x, 1440×900 @2x, 1920×1080 @1x).
// adds: tool. Runs on the user's machine with their Chrome/Edge/Chromium; nothing leaves it.

import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, basename, extname, relative } from 'node:path';
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
// Chrome can take a while to start when the machine is busy: wait up to 90 s.
const launch = () => loadPuppeteer().launch({ executablePath: findChrome(), headless: true, timeout: 90000, protocolTimeout: 180000,
  args: ['--no-sandbox', '--hide-scrollbars', '--force-color-profile=srgb', '--enable-experimental-web-platform-features', '--font-render-hinting=none'] });

const dbg = process.env.HERO_DEBUG ? (...a) => console.error('[hero ' + new Date().toISOString().slice(11, 19) + ']', ...a) : () => {};
const issue = (id, level, msg, fix, view) => ({ id, level, view, msg, fix });
const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const pct = (x) => `${Math.round(x * 100)}%`;
const TYPES = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.ico': 'image/x-icon' };

export const VIEWS = [
  { id: 'phone', w: 390, h: 844, dpr: 2, mobile: true, label: 'Phone 390×844 @2x' },
  { id: 'tablet', w: 820, h: 1180, dpr: 2, mobile: true, label: 'Tablet 820×1180 @2x' },
  { id: 'laptop', w: 1440, h: 900, dpr: 2, mobile: false, label: 'Laptop 1440×900 @2x' },
  { id: 'desktop', w: 1920, h: 1080, dpr: 1, mobile: false, label: 'Desktop 1920×1080 @1x' },
];

function serve(root) {
  const s = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0].split('#')[0]);
    if (p === '/__hero_lab') { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<!doctype html><html><body></body></html>'); return; }
    if (p.endsWith('/')) p += 'index.html';
    const f = join(root, p);
    if (!f.startsWith(root)) { r.writeHead(403); r.end(); return; }
    try { const b = readFileSync(f); r.writeHead(200, { 'content-type': TYPES[extname(f).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' }); r.end(b); }
    catch { r.writeHead(404); r.end(); }
  });
  return new Promise((ok) => s.listen(0, '127.0.0.1', () => ok(s)));
}

const parseBox = (s) => { if (!s) return null; const v = String(s).split(/[ ,]+/).map(Number); if (v.length !== 4 || v.some((n) => !(n >= 0 && n <= 1.0001))) throw new Error('--subject x,y,w,h as fractions of the photo (0–1), e.g. 0.62,0.17,0.24,0.62'); return v; };

// ---------- in the page: find the hero, its photo, the crop, the text ----------
// Runs in the browser (serialised). Returns plain data.
function collect(sel) {
  const W = innerWidth, H = innerHeight;
  const shown = (e) => { for (let n = e; n && n.nodeType === 1; n = n.parentElement) { const s = getComputedStyle(n); if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity < 0.02) return false; } return true; };
  const area = (r) => Math.max(0, r.width) * Math.max(0, r.height);
  const inter = (a, b) => { const l = Math.max(a.left, b.left), t = Math.max(a.top, b.top), r = Math.min(a.right, b.right), bt = Math.min(a.bottom, b.bottom); return { left: l, top: t, right: Math.max(l, r), bottom: Math.max(t, bt), width: Math.max(0, r - l), height: Math.max(0, bt - t) }; };
  const R = (r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height });
  const urlsOf = (bi) => [...String(bi).matchAll(/url\((['"]?)(.*?)\1\)/g)].map((m) => m[2]);
  // the visuals: <img> and elements with a url() background, at least 60% of the window wide, starting in the first screen
  const visuals = [];
  for (const e of document.querySelectorAll('body *')) {
    if (!shown(e)) continue;
    const r = e.getBoundingClientRect(); if (r.width < W * 0.6 || r.top > H || r.bottom < 0 || r.height < 120) continue;
    if (e.tagName === 'IMG' && (e.currentSrc || e.src)) visuals.push({ e, kind: 'img', r });
    else { const u = urlsOf(getComputedStyle(e).backgroundImage); if (u.length) visuals.push({ e, kind: 'background', r, url: u[0] }); }
  }
  let hero = sel ? document.querySelector(sel) : null;
  let vis = null;
  if (hero) vis = visuals.filter((v) => hero === v.e || hero.contains(v.e) || v.e.contains(hero)).sort((a, b) => area(inter(b.r, { left: 0, top: 0, right: W, bottom: H })) - area(inter(a.r, { left: 0, top: 0, right: W, bottom: H })))[0] || null;
  else {
    vis = visuals.sort((a, b) => area(inter(b.r, { left: 0, top: 0, right: W, bottom: H, width: W, height: H })) - area(inter(a.r, { left: 0, top: 0, right: W, bottom: H, width: W, height: H })))[0] || null;
    if (vis) { // the hero: the photo's nearest ancestor that also holds the headline
      for (let n = vis.e; n && n !== document.body; n = n.parentElement) { if (n.querySelector('h1,h2') || (n.innerText || '').trim().length > 20) { hero = n; break; } }
      hero ||= vis.e.parentElement || vis.e;
      if (hero.getBoundingClientRect().height > H * 3) hero = vis.e.parentElement; // the whole page isn't the hero
    } else hero = document.querySelector('header + * h1, main h1, h1')?.closest('section,header,div') || null;
  }
  if (!hero) return { error: 'no hero found: pass --selector' };
  hero.setAttribute('data-hero-check', '');
  const hr = R(hero.getBoundingClientRect());
  const out = { W, H, hero: { tag: hero.tagName.toLowerCase(), cls: String(hero.className || '').slice(0, 60), rect: hr }, scrollW: document.documentElement.scrollWidth };
  // the crop: where the photo is drawn and which part of it the box shows
  const posAxis = (toks) => { // → (free) => offset
    toks = toks.filter(Boolean);
    const val = (t, free) => /%$/.test(t) ? free * parseFloat(t) / 100 : /px$/.test(t) ? parseFloat(t) : 0;
    if (!toks.length) return (f) => f / 2;
    const [a, b] = toks;
    if (/^(left|top)$/.test(a)) return b ? (f) => val(b, f) : () => 0;
    if (/^(right|bottom)$/.test(a)) return b ? (f) => f - val(b, f) : (f) => f;
    if (a === 'center') return (f) => f / 2;
    if (/calc/.test(a)) return (f) => f / 2;
    return (f) => val(a, f);
  };
  const splitPos = (s) => {
    const t = String(s).replace(/calc\([^)]*\)/g, 'calc').trim().split(/\s+/);
    // group into [x-tokens], [y-tokens]
    const kw = (x) => /^(left|right|top|bottom|center)$/.test(x);
    if (t.length <= 2) { let [x, y] = t; if (/^(top|bottom)$/.test(x) || /^(left|right)$/.test(y)) [x, y] = [y, x]; return [[x || 'center'], [y || 'center']]; }
    const groups = []; for (let i = 0; i < t.length; i++) { if (kw(t[i]) && t[i + 1] && !kw(t[i + 1])) { groups.push([t[i], t[i + 1]]); i++; } else groups.push([t[i]]); }
    let [gx, gy] = groups; if (gx && /^(top|bottom)$/.test(gx[0])) [gx, gy] = [gy, gx];
    return [gx || ['center'], gy || ['center']];
  };
  const clipOf = (e) => { // the box the drawing can show through: overflow-clipping ancestors (and the element itself)
    let c = R(e.getBoundingClientRect());
    for (let n = e.parentElement; n && n !== document.documentElement; n = n.parentElement) { const s = getComputedStyle(n); if (/(hidden|clip|auto|scroll)/.test(s.overflowX + s.overflowY) || s.clipPath !== 'none') c = inter(c, n.getBoundingClientRect()); }
    return c;
  };
  if (vis) {
    const e = vis.e, cs = getComputedStyle(e), r = R(e.getBoundingClientRect());
    const im = { kind: vis.kind, tag: e.tagName.toLowerCase(), rect: r };
    let nw, nh, ox, oy, sx, sy, box = r;
    if (vis.kind === 'img') {
      nw = e.naturalWidth; nh = e.naturalHeight;
      const bl = parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft), bt = parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop);
      const bw = r.width - bl - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight), bh = r.height - bt - parseFloat(cs.borderBottomWidth) - parseFloat(cs.paddingBottom);
      box = { left: r.left + bl, top: r.top + bt, width: bw, height: bh, right: r.left + bl + bw, bottom: r.top + bt + bh };
      const fit = cs.objectFit;
      if (fit === 'fill' || !nw) { sx = bw / nw; sy = bh / nh; }
      else { const s = fit === 'cover' ? Math.max(bw / nw, bh / nh) : fit === 'contain' ? Math.min(bw / nw, bh / nh) : fit === 'none' ? 1 : Math.min(1, bw / nw, bh / nh); sx = sy = s; }
      const [px, py] = splitPos(cs.objectPosition);
      ox = posAxis(px)(bw - nw * sx); oy = posAxis(py)(bh - nh * sy);
      Object.assign(im, { src: e.currentSrc || e.src, fit, position: cs.objectPosition, srcset: e.getAttribute('srcset') || '', sizes: e.getAttribute('sizes') || '', picture: e.parentElement?.tagName === 'PICTURE',
        sources: e.parentElement?.tagName === 'PICTURE' ? [...e.parentElement.querySelectorAll('source')].map((s) => ({ media: s.media || '', srcset: (s.srcset || '').slice(0, 300), sizes: s.sizes || '', type: s.type || '' })) : [],
        loading: e.getAttribute('loading') || '', fetchpriority: e.getAttribute('fetchpriority') || '', decoding: e.getAttribute('decoding') || '', width_attr: e.getAttribute('width'), height_attr: e.getAttribute('height'), alt: e.getAttribute('alt'), aspect: cs.aspectRatio });
    } else {
      const u = vis.url; const a = new URL(u, location.href).href;
      const layers = urlsOf(cs.backgroundImage);
      const idx = String(cs.backgroundImage).split(/,(?![^(]*\))/).findIndex((x) => /url\(/.test(x));
      const pick = (v) => String(v).split(/,(?![^(]*\))/)[Math.max(0, idx)]?.trim() || String(v).trim();
      const size = pick(cs.backgroundSize), bx = pick(cs.backgroundPositionX), by = pick(cs.backgroundPositionY);
      Object.assign(im, { src: a, fit: size, position: `${bx} ${by}`, layers: layers.length, gradient_layers: /gradient/.test(cs.backgroundImage), srcset: '', sizes: '', picture: false, sources: [], loading: '', fetchpriority: '' });
      im.need_natural = true; im._bx = bx; im._by = by; im._size = size;
    }
    if (nw) { im.natural = { w: nw, h: nh }; im.draw = { left: box.left + ox, top: box.top + oy, width: nw * sx, height: nh * sy }; im.box = box; }
    im.clip = inter(clipOf(e), box);
    out.image = im;
  }
  // the text: every visible line inside the hero (own text nodes, one box per line)
  const lines = [];
  const walker = document.createTreeWalker(hero, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.textContent.trim()) continue;
    const el = n.parentElement; if (!el || el.closest('script,style,noscript,template') || !shown(el)) continue;
    const s = getComputedStyle(el);
    let op = 1; for (let p = el; p && p !== document.documentElement; p = p.parentElement) op *= +getComputedStyle(p).opacity;
    const rg = document.createRange(); rg.selectNodeContents(n);
    const rects = [...rg.getClientRects()].filter((q) => q.width > 2 && q.height > 2);
    // one box per line: merge fragments on the same line
    const merged = [];
    for (const q of rects) { const m = merged.find((x) => Math.abs(x.top - q.top) < q.height * 0.5); if (m) { m.left = Math.min(m.left, q.left); m.right = Math.max(m.right, q.right); m.top = Math.min(m.top, q.top); m.bottom = Math.max(m.bottom, q.bottom); } else merged.push({ left: q.left, right: q.right, top: q.top, bottom: q.bottom }); }
    // the words on each line (for the report)
    const words = n.textContent.replace(/\s+/g, ' ').trim();
    const link = el.closest('a,button,[role=button],input[type=submit]');
    for (const [k, m] of merged.entries()) lines.push({ t: merged.length > 1 ? `${words.slice(0, 60)} (line ${k + 1})` : words.slice(0, 80), left: m.left, top: m.top, width: m.right - m.left, height: m.bottom - m.top,
      color: s.color, fill: s.webkitTextFillColor, fs: parseFloat(s.fontSize), weight: +s.fontWeight || 400, shadow: s.textShadow !== 'none', opacity: op, tag: el.tagName.toLowerCase(), clipText: /text/.test(s.webkitBackgroundClip || s.backgroundClip || ''),
      link: link ? (() => { const q = link.getBoundingClientRect(); return { left: q.left, top: q.top, width: q.width, height: q.height, text: (link.innerText || '').trim().slice(0, 40) }; })() : null });
  }
  out.lines = lines;
  out.h1 = !!hero.querySelector('h1');
  return out;
}

// ---------- the lab page: pixels (decoding, contrast, locating a crop in the photo, the subject estimate) ----------
const LAB = String.raw`
window.lab = {
  async load(url) { const im = new Image(); im.src = url; await im.decode(); return im; },
  grey(im, w) { const h = Math.max(1, Math.round(w * im.naturalHeight / im.naturalWidth)); const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d', { willReadFrequently: true }); x.imageSmoothingQuality = 'high'; x.drawImage(im, 0, 0, w, h); const d = x.getImageData(0, 0, w, h).data; const g = new Float32Array(w * h); for (let i = 0; i < w * h; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]; return { g, w, h }; },
  greyWH(im, w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d', { willReadFrequently: true }); x.imageSmoothingQuality = 'high'; x.drawImage(im, 0, 0, w, h); const d = x.getImageData(0, 0, w, h).data; const g = new Float32Array(w * h); for (let i = 0; i < w * h; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]; return g; },
  ncc(S, Sw, T, tw, th, X, Y) { let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = tw * th; for (let y = 0; y < th; y++) { const o = (Y + y) * Sw + X, p = y * tw; for (let x = 0; x < tw; x++) { const a = S[o + x], b = T[p + x]; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b; } } const va = saa - sa * sa / n, vb = sbb - sb * sb / n; return va > 1e-6 && vb > 1e-6 ? (sab - sa * sb / n) / Math.sqrt(va * vb) : -1; },
  // Where a crop (cut from the photo and resized) sits in the photo: normalised cross-correlation, coarse then fine.
  async locate(srcUrl, cropUrl) {
    const S = await this.load(srcUrl), C = await this.load(cropUrl);
    const cA = C.naturalHeight / C.naturalWidth;
    const search = (Sw, scales, cx, cy, rad) => { const s = this.grey(S, Sw); let best = { score: -2 };
      for (const f of scales) { const tw = Math.round(Sw * f), th = Math.round(tw * cA); if (tw < 8 || th < 8 || tw > s.w || th > s.h) continue; const T = this.greyWH(C, tw, th);
        const x0 = cx == null ? 0 : Math.max(0, Math.round(cx * Sw) - rad), x1 = cx == null ? s.w - tw : Math.min(s.w - tw, Math.round(cx * Sw) + rad);
        const y0 = cy == null ? 0 : Math.max(0, Math.round(cy * Sw) - rad), y1 = cy == null ? s.h - th : Math.min(s.h - th, Math.round(cy * Sw) + rad);
        for (let Y = y0; Y <= y1; Y++) for (let X = x0; X <= x1; X++) { const v = this.ncc(s.g, s.w, T, tw, th, X, Y); if (v > best.score) best = { score: v, x: X / Sw, y: Y / Sw, w: tw / Sw, f }; } }
      return best; };
    const coarse = []; for (let f = 0.12; f <= 1.0001; f += 0.01) coarse.push(f);
    let b = search(96, coarse);
    if (b.score < -1) return null;
    const fine = []; for (let f = b.f - 0.012; f <= b.f + 0.0121; f += 0.002) if (f > 0.05 && f <= 1.0001) fine.push(f);
    const b2 = search(384, fine, b.x, b.y, 8);
    const best = b2.score > b.score - 0.05 ? b2 : b;
    const sh = S.naturalHeight / S.naturalWidth;
    return { x: best.x, y: best.y / sh, w: best.w, h: best.w * cA / sh, score: best.score };
  },
  // Palm's subject estimate: faces if Chrome's FaceDetector works here, else the most colourful region that stands out
  // from the photo's average colour (centre-surround on a blurred copy).
  async subject(url) {
    const im = await this.load(url);
    let faces = [];
    try { if ('FaceDetector' in window) { const fd = new FaceDetector({ fastMode: false, maxDetectedFaces: 5 }); faces = (await fd.detect(im)).map((f) => f.boundingBox); } } catch {}
    if (faces.length) { const W = im.naturalWidth, H = im.naturalHeight; let x0 = 1e9, y0 = 1e9, x1 = 0, y1 = 0; for (const f of faces) { x0 = Math.min(x0, f.x - f.width * 0.4); y0 = Math.min(y0, f.y - f.height * 0.4); x1 = Math.max(x1, f.x + f.width * 1.4); y1 = Math.max(y1, f.y + f.height * 1.6); }
      x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(W, x1); y1 = Math.min(H, y1); return { box: [x0 / W, y0 / H, (x1 - x0) / W, (y1 - y0) / H], method: 'faces', faces: faces.length }; }
    const w = 160, h = Math.max(1, Math.round(w * im.naturalHeight / im.naturalWidth));
    const at = (cw) => { const ch = Math.max(1, Math.round(cw * h / w)); const a = document.createElement('canvas'); a.width = cw; a.height = ch; a.getContext('2d').drawImage(im, 0, 0, cw, ch); const b = document.createElement('canvas'); b.width = w; b.height = h; const bx = b.getContext('2d', { willReadFrequently: true }); bx.imageSmoothingQuality = 'high'; bx.drawImage(a, 0, 0, w, h); return bx.getImageData(0, 0, w, h).data; };
    // centre-surround: a detail scale (40 px wide) against its surroundings (8 px wide), weighted by colourfulness; a big
    // flat area (a wall, the sky) scores only at its edges, a colourful object that differs from what's around it scores whole
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
    // grow it with the strong regions next to it (a face above a bouquet, a product's label and lid)
    best = { ...best }; for (let grew = true; grew;) { grew = false; for (const q of comps) { if (q === comps[0] || q.used || q.sum < comps[0].sum * 0.15) continue; const gap = Math.max(q.X0 - best.X1, best.X0 - q.X1, (q.Y0 - best.Y1) * w / h, (best.Y0 - q.Y1) * w / h); if (gap < w * 0.06) { best.X0 = Math.min(best.X0, q.X0); best.Y0 = Math.min(best.Y0, q.Y0); best.X1 = Math.max(best.X1, q.X1); best.Y1 = Math.max(best.Y1, q.Y1); q.used = true; grew = true; } } }
    const g = 0.06; const bx = Math.max(0, best.X0 / w - g), by = Math.max(0, best.Y0 / h - g); return { box: [bx, by, Math.min(1, (best.X1 + 1) / w + g) - bx, Math.min(1, (best.Y1 + 1) / h + g) - by], method: 'saliency' };
  },
  // Contrast of each text line against the pixels behind it (a screenshot with the hero's text made transparent).
  async contrast(shotUrl, dpr, lines) {
    const im = await this.load(shotUrl); const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight; const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(im, 0, 0);
    const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const L = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    const parse = (s) => { const m = String(s).match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(parseFloat); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
    return lines.map((ln) => {
      const col = parse(ln.fill && !/rgba?\(0, 0, 0, 0\)/.test(ln.fill) && ln.fill !== ln.color ? ln.fill : ln.color); if (!col) return { skip: 'colour not readable' };
      const a = col.a * ln.opacity; if (a < 0.05 || ln.clipText) return { skip: 'text drawn with a gradient or transparent' };
      const X = Math.max(0, Math.round(ln.left * dpr)), Y = Math.max(0, Math.round(ln.top * dpr)), Wd = Math.min(c.width - X, Math.round(ln.width * dpr)), Hd = Math.min(c.height - Y, Math.round(ln.height * dpr));
      if (Wd < 2 || Hd < 2) return { skip: 'off screen' };
      const d = x.getImageData(X, Y, Wd, Hd).data, step = Math.max(1, Math.floor(Math.sqrt(Wd * Hd / 40000)));
      const rs = []; let mr = 0, mg = 0, mb = 0, n = 0;
      for (let yy = 0; yy < Hd; yy += step) for (let xx = 0; xx < Wd; xx += step) { const i = (yy * Wd + xx) * 4; const br = d[i], bg = d[i + 1], bb = d[i + 2];
        const fr = col.r * a + br * (1 - a), fg = col.g * a + bg * (1 - a), fb = col.b * a + bb * (1 - a);
        const l1 = L(fr, fg, fb), l2 = L(br, bg, bb); rs.push((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)); mr += br; mg += bg; mb += bb; n++; }
      rs.sort((p, q) => p - q);
      return { p10: rs[Math.floor(rs.length * 0.1)], min: rs[0], median: rs[rs.length >> 1], bg: [Math.round(mr / n), Math.round(mg / n), Math.round(mb / n)], text: [col.r, col.g, col.b, round2(a)] };
    });
    function round2(v) { return Math.round(v * 100) / 100; }
  },
};`;

// ---------- the check ----------
export async function check(target, { selector, subject, source, out = 'look/hero', plain = false, root, dark = true, views = VIEWS } = {}) {
  const isUrl = /^https?:\/\//.test(target);
  let server, base, pageUrl, rootDir;
  if (!isUrl) {
    const abs = resolve(target); if (!existsSync(abs)) throw new Error('no such file: ' + target);
    rootDir = resolve(root || dirname(abs));
    server = await serve(rootDir); base = `http://127.0.0.1:${server.address().port}`;
    pageUrl = base + '/' + relative(rootDir, abs).split('\\').join('/');
  } else { pageUrl = target; base = new URL(target).origin; }
  const subjectGiven = parseBox(subject);
  const sourceAbs = source ? resolve(source) : null;
  if (sourceAbs && !existsSync(sourceAbs)) throw new Error('no such photo: ' + source);
  const bytesOf = async (url) => { // the file's weight and bytes (for pixels)
    try { const u = new URL(url); if (server && u.origin === base) { const f = join(rootDir, decodeURIComponent(u.pathname)); return { file: f, buf: readFileSync(f) }; } if (u.protocol === 'data:') return { buf: Buffer.from(url.split(',')[1], 'base64') }; const r = await fetch(url); return { buf: Buffer.from(await r.arrayBuffer()) }; } catch { return null; }
  };
  const dataUrl = (buf, name = '') => `data:${TYPES[extname(name).toLowerCase()] || 'image/jpeg'};base64,${buf.toString('base64')}`;
  const issues = [], results = [];
  const browser = await launch();
  let sheet, subj = null;
  try {
    const lab = await browser.newPage();
    await lab.goto(server ? base + '/__hero_lab' : 'about:blank'); await lab.addScriptTag({ content: LAB });
    const photoCache = new Map();
    const loadPhoto = async (url) => { if (!photoCache.has(url)) { const b = await bytesOf(url); photoCache.set(url, b ? { ...b, data: dataUrl(b.buf, b.file || new URL(url).pathname) } : null); } return photoCache.get(url); };
    // dark mode: only if the page has a prefers-color-scheme rule
    let hasDark = false;
    const wanted = [];
    for (const v of views) wanted.push({ ...v, scheme: 'light' });
    for (const vi of views) {
      const v = { ...vi };
      dbg('render', v.id); results.push(await renderView(browser, pageUrl, selector, v, 'light'));
    }
    hasDark = results.some((r) => r.has_dark);
    if (dark && hasDark) for (const id of ['phone', 'laptop']) { const v = views.find((x) => x.id === id); if (v) results.push(await renderView(browser, pageUrl, selector, v, 'dark')); }
    // the reference photo for the subject: --source, else the biggest file shown
    let refUrl = sourceAbs ? 'file:' + sourceAbs : null, ref = null;
    if (sourceAbs) { const buf = readFileSync(sourceAbs); ref = { file: sourceAbs, buf, data: dataUrl(buf, sourceAbs) }; }
    else { const shown = results.filter((r) => r.image?.src).sort((a, b) => (b.image.natural?.w || 0) - (a.image.natural?.w || 0))[0]; if (shown) { refUrl = shown.image.src; ref = await loadPhoto(refUrl); } }
    if (subjectGiven) subj = { box: subjectGiven, method: 'given' };
    else if (ref) { subj = await lab.evaluate((u) => window.lab.subject(u), ref.data); if (subj) subj.method = subj.method === 'faces' ? "Palm's estimate (faces found by Chrome)" : "Palm's estimate (most colourful, contrasting region; pass --subject to be exact)"; }
    dbg('subject', subj && subj.method);
    // each view: where its file sits in the reference photo, then the subject in that view
    const located = new Map();
    for (const r of results) {
      const im = r.image; if (!im?.src) continue;
      const ph = await loadPhoto(im.src);
      if (ph) { im.kb = Math.round(ph.buf.length / 1024); im.file = ph.file ? relative(rootDir, ph.file) : im.src; }
      if (im.need_natural && ph) { // a CSS background: its natural size, then the drawing (cover/contain/px/% and position)
        const nat = await lab.evaluate(async (u) => { const i = await window.lab.load(u); return { w: i.naturalWidth, h: i.naturalHeight }; }, ph.data);
        im.natural = nat; const b = im.rect, bw = b.width, bh = b.height; let sx, sy;
        const sz = String(im._size).split(/\s+/);
        if (sz[0] === 'cover') sx = sy = Math.max(bw / nat.w, bh / nat.h); else if (sz[0] === 'contain') sx = sy = Math.min(bw / nat.w, bh / nat.h);
        else { const one = (t, box, n) => /%$/.test(t) ? box * parseFloat(t) / 100 / n : /px$/.test(t) ? parseFloat(t) / n : null; const a = one(sz[0], bw, nat.w), c = one(sz[1] || 'auto', bh, nat.h); sx = a ?? c ?? 1; sy = c ?? a ?? 1; }
        const ax = (s, free) => { const t = String(s).trim().split(/\s+/); const v = (x) => /%$/.test(x) ? free * parseFloat(x) / 100 : /px$/.test(x) ? parseFloat(x) : x === 'center' ? free / 2 : /right|bottom/.test(x) ? free : 0; return t.length === 2 ? (/right|bottom/.test(t[0]) ? free - v(t[1]) : v(t[1])) : v(t[0]); };
        im.draw = { left: b.left + ax(im._bx, bw - nat.w * sx), top: b.top + ax(im._by, bh - nat.h * sy), width: nat.w * sx, height: nat.h * sy }; im.box = b;
      }
      delete im._bx; delete im._by; delete im._size; delete im.need_natural;
      if (!im.draw || !im.natural) continue;
      // the file's own pixel size (an <img> with srcset w-descriptors reports a density-corrected naturalWidth, e.g. an
      // 800 px file shown at sizes=100vw on a 390 px phone says 390, so read the file itself)
      if (ph) { if (!ph.px) ph.px = await lab.evaluate(async (u) => { const i = await window.lab.load(u); return { w: i.naturalWidth, h: i.naturalHeight }; }, ph.data); im.intrinsic = im.natural; im.natural = ph.px; }
      // the part of the file the screen shows (image fractions), within the clip and within the first screen
      const c = im.clip, d = im.draw;
      const frac = (L, T, R2, B) => { const x0 = Math.max(L, d.left), y0 = Math.max(T, d.top), x1 = Math.min(R2, d.left + d.width), y1 = Math.min(B, d.top + d.height); return x1 > x0 && y1 > y0 ? [(x0 - d.left) / d.width, (y0 - d.top) / d.height, (x1 - x0) / d.width, (y1 - y0) / d.height] : [0, 0, 0, 0]; };
      im.visible = frac(c.left, c.top, c.right, c.bottom).map((v) => round(v, 3));
      im.visible_first_screen = frac(Math.max(c.left, 0), Math.max(c.top, 0), Math.min(c.right, r.view.w), Math.min(c.bottom, r.view.h)).map((v) => round(v, 3));
      im.px_per_css = round(im.natural.w / d.width, 2); // file pixels per CSS pixel (needs ≥ dpr for full sharpness)
      const ia0 = im.intrinsic || im.natural; im.stretched = Math.abs((d.width / d.height) / (ia0.w / ia0.h) - 1) > 0.03;
      // where this file sits in the reference photo
      let inRef = [0, 0, 1, 1], placed = true;
      if (ref && ph && ph.buf.length && !(ph.file && ref.file && resolve(ph.file) === resolve(ref.file)) && !ph.buf.equals(ref.buf)) {
        dbg('locate', im.src); if (!located.has(im.src)) located.set(im.src, await lab.evaluate((a, b) => window.lab.locate(a, b), ref.data, ph.data));
        const L = located.get(im.src);
        if (L && L.score >= 0.55) { inRef = [L.x, L.y, L.w, L.h]; im.in_photo = { box: inRef.map((v) => round(v, 3)), match: round(L.score, 2) }; }
        else { placed = false; im.in_photo = { box: null, match: L ? round(L.score, 2) : null }; }
      }
      im.visible_in_photo = placed ? [inRef[0] + im.visible[0] * inRef[2], inRef[1] + im.visible[1] * inRef[3], im.visible[2] * inRef[2], im.visible[3] * inRef[3]].map((v) => round(v, 3)) : null;
      if (subj && placed) {
        const [sx0, sy0, sw, sh] = subj.box;
        // the subject in this file's fractions, then on screen
        const fx = (sx0 - inRef[0]) / inRef[2], fy = (sy0 - inRef[1]) / inRef[3], fw = sw / inRef[2], fh = sh / inRef[3];
        const S = { left: d.left + fx * d.width, top: d.top + fy * d.height, width: fw * d.width, height: fh * d.height };
        S.right = S.left + S.width; S.bottom = S.top + S.height;
        const ia = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
        const total = S.width * S.height;
        const kept = total ? ia(S, c) / total : 0;
        const firstScreen = total ? ia(S, { left: Math.max(c.left, 0), top: Math.max(c.top, 0), right: Math.min(c.right, r.view.w), bottom: Math.min(c.bottom, r.view.h) }) / total : 0;
        r.subject = { kept: round(kept, 3), first_screen: round(firstScreen, 3), rect: { left: round(S.left, 1), top: round(S.top, 1), width: round(S.width, 1), height: round(S.height, 1) } };
        for (const ln of r.lines) { const la = ln.width * ln.height; ln.over_subject = la ? round(ia({ left: ln.left, top: ln.top, right: ln.left + ln.width, bottom: ln.top + ln.height }, { left: Math.max(S.left, c.left), top: Math.max(S.top, c.top), right: Math.min(S.right, c.right), bottom: Math.min(S.bottom, c.bottom) }) / la, 2) : 0; }
      }
    }
    dbg('contrast');
    // contrast per line (the screenshot with the hero's text hidden)
    for (const r of results) {
      if (!r.lines?.length) continue;
      const cs = await lab.evaluate((u, dpr, ls) => window.lab.contrast(u, dpr, ls), r._hidden, r.view.dpr, r.lines);
      r.lines.forEach((ln, i) => {
        const c = cs[i]; ln.large = ln.fs >= 24 || (ln.fs >= 18.5 && ln.weight >= 700); ln.need = ln.large ? 3 : 4.5;
        if (c.skip) { ln.contrast = null; ln.skip = c.skip; return; }
        Object.assign(ln, { contrast: round(c.p10, 2), contrast_min: round(c.min, 2), contrast_median: round(c.median, 2), behind: c.bg, text_rgba: c.text });
        ln.over_image = !!(r.image?.clip && ln.left < r.image.clip.right && ln.left + ln.width > r.image.clip.left && ln.top < r.image.clip.bottom && ln.top + ln.height > r.image.clip.top);
      });
    }
    // ---------- issues ----------
    const views_ = results;
    for (const r of views_) {
      const v = r.view, tag = `${v.id}${r.scheme === 'dark' ? ' (dark)' : ''}`;
      const add = (id, lvl, msg, fix) => issues.push(issue(id, lvl, msg, fix, tag));
      if (r.error) { add('no-hero', 'error', `${tag}: ${r.error}.`, 'Pass --selector with the hero element (e.g. .hero).'); continue; }
      if (r.scrollW > v.w + 1) add('sideways-scroll', 'error', `${tag}: the page is ${r.scrollW} px wide in a ${v.w} px window, so it scrolls sideways.`, 'Find the element wider than the screen (often a fixed width or a long word in the headline) and let it shrink.');
      if (r.not_painted) add('not-painted', 'note', `${tag}: the photo hadn't been painted after 12 s, so this view's screenshot may show the page without it.`, 'Check the page loads its photo at this size; run the check again.');
      const im = r.image;
      if (!im) add('no-photo', r.scheme === 'dark' ? 'note' : 'warn', `${tag}: no full-width photo found in the hero.`, 'Check the hero shows its photo at this size.');
      else if (r.scheme === 'light') {
        if (im.stretched) add('stretched', 'error', `${tag}: the photo is stretched (drawn ${Math.round(im.draw.width)}×${Math.round(im.draw.height)} from a ${im.natural.w}×${im.natural.h} file).`, 'Use object-fit: cover (or a background-size: cover) instead of a fixed width and height.');
        if (im.px_per_css < 0.75 * v.dpr) add('blurry', 'warn', `${tag}: the photo has ${im.px_per_css} image pixels per screen pixel here (the screen has ${v.dpr}); it will look soft. (Palm's threshold: at least ${0.75 * v.dpr}.)`, `Serve a file at least ${Math.ceil(im.draw.width * v.dpr * 0.75)} px wide at this size (srcset), cut from the original photo.`);
        const kbMax = v.mobile && v.w < 700 ? 300 : 900;
        if (im.kb > kbMax) add('heavy', 'warn', `${tag}: the photo it downloads (${basename(String(im.file || im.src))}) weighs ${im.kb} KB${im.px_per_css > 1.5 * v.dpr ? `, at ${im.px_per_css} image pixels per screen pixel (it needs about ${v.dpr})` : ''}. (Palm's guide: under ${kbMax} KB ${kbMax === 300 ? 'on a phone' : 'on a big screen'}.)`, 'Serve sized copies with srcset (and sizes), compressed (WebP or a JPEG at quality ~75–82).');
        if (im.subject_note) add('subject-note', 'note', im.subject_note);
        if (im.in_photo && !im.in_photo.box) add('not-located', 'note', `${tag}: couldn't find ${basename(String(im.file || im.src))} inside the original photo (best match ${im.in_photo.match}), so the subject wasn't followed into it.`, 'If it is a crop of the photo, keep it unfiltered (overlays as CSS, not baked in), or check this size by eye.');
        if (v.id === 'phone' && im.kind === 'img' && !im.srcset && !im.picture) add('no-srcset', 'warn', `${tag}: the hero <img> has no srcset or <picture>, so every screen downloads the same ${im.kb} KB file.`, 'Add srcset with 4–6 widths (e.g. 640, 960, 1440, 1920, 2560) and sizes="100vw" (Shopify\'s theme guide), or a <picture> with a phone crop.');
        if (v.id === 'phone' && im.kind === 'img' && im.srcset && /\d+w/.test(im.srcset) && !im.sizes && !im.picture) add('no-sizes', 'tip', `${tag}: srcset has widths but no sizes attribute; the browser assumes 100vw (fine for a full-width hero).`, 'Add sizes="100vw" to say so.');
      }
      if (r.subject && r.scheme === 'light') {
        if (r.subject.kept < 0.9) add('subject-cut', subj?.method === 'given' ? 'error' : 'warn', `${tag}: the crop shows only ${pct(r.subject.kept)} of the subject${subj?.method === 'given' ? '' : ' (' + subj.method + ')'}: the screen shows ${im.visible_in_photo ? `x ${pct(im.visible_in_photo[0])}–${pct(im.visible_in_photo[0] + im.visible_in_photo[2])}, y ${pct(im.visible_in_photo[1])}–${pct(im.visible_in_photo[1] + im.visible_in_photo[3])}` : 'part'} of the photo, the subject is at x ${pct(subj.box[0])}–${pct(subj.box[0] + subj.box[2])}, y ${pct(subj.box[1])}–${pct(subj.box[1] + subj.box[3])}. (Palm's threshold: 90% kept.)`, 'Move the crop with object-position (or background-position) towards the subject at this size, or give this size its own crop (<picture> with a <source media=…>).');
        else if (v.id === 'phone' && r.subject.first_screen < 0.5) add('subject-below-fold', 'warn', `${tag}: only ${pct(r.subject.first_screen)} of the subject is on the phone's first screen.`, 'Bring the photo up, or shorten what sits above it.');
      }
      // text
      const lines = r.lines || [];
      if (!lines.length && r.scheme === 'light') add('no-text', 'warn', `${tag}: no live text in the hero. Words drawn into the photo can't reflow, be read by search engines or screen readers, or be translated.`, 'Put the headline and button in HTML over (or beside) the photo.');
      const lightTwin = r.scheme === 'dark' ? views_.find((x) => x.view.id === v.id && x.scheme === 'light') : null;
      const sameAsLight = (ln) => lightTwin && (lightTwin.lines || []).some((l) => l.t === ln.t && l.contrast != null && Math.abs(l.contrast - ln.contrast) < 0.05);
      for (const ln of lines) {
        if (ln.contrast != null && ln.contrast < ln.need && !sameAsLight(ln)) add('contrast', 'error', `${tag}: "${ln.t}" (${Math.round(ln.fs)} px${ln.weight >= 700 ? ' bold' : ''}) has ${ln.contrast}:1 against the pixels behind it (worst ${ln.contrast_min}:1; behind it on average rgb(${ln.behind.join(',')})). WCAG 1.4.3 needs ${ln.need}:1${ln.large ? ' for large text' : ''}. (Palm reads it against 90% of the pixels behind the line.)`, 'Move the text to a calmer, darker (or lighter) part of the photo at this size, add a scrim (a gradient or panel behind the text), or change the text colour.');
        else if (ln.contrast != null && ln.contrast >= ln.need && ln.contrast_min < ln.need * 0.75 && ln.over_image && !sameAsLight(ln)) add('contrast-patchy', 'tip', `${tag}: "${ln.t}" passes on 90% of its background, but drops to ${ln.contrast_min}:1 over its busiest pixels.`, 'A light scrim behind the text evens it out.');
        if (ln.skip && r.scheme === 'light' && ln.skip !== 'off screen') add('contrast-not-measured', 'note', `${tag}: "${ln.t}": ${ln.skip}, so its contrast wasn't measured.`, 'Check it by eye on the sheet.');
        if (ln.over_subject > 0.2 && r.scheme === 'light') add('text-over-subject', 'warn', `${tag}: "${ln.t}" covers the subject (${pct(ln.over_subject)} of the line's box is over it). (Palm's threshold: 20%.)`, 'Place the text beside the subject at this size (or move the crop), so neither hides the other.');
        if (ln.left < -1 || ln.left + ln.width > v.w + 1) add('text-cut', 'error', `${tag}: "${ln.t}" runs off the screen.`, 'Let the text wrap (max-width in %, no fixed widths or nowrap).');
      }
      if (v.id === 'phone' && r.scheme === 'light' && lines.length) {
        const head = lines.filter((l) => /^h[12]$/.test(l.tag)).sort((a, b) => b.fs - a.fs)[0] || [...lines].sort((a, b) => b.fs - a.fs)[0];
        if (head && head.fs < 28) add('headline-small-phone', 'warn', `${tag}: the headline is ${Math.round(head.fs)} px on a phone. (Palm's guide: 28 px or more, so it reads at a glance.)`, 'Use clamp(), e.g. font-size: clamp(2rem, 7vw, 4rem).');
        const small = lines.filter((l) => l.fs < 14); if (small.length) add('text-small-phone', 'warn', `${tag}: ${small.length} line(s) under 14 px on a phone: ${small.slice(0, 3).map((l) => `"${l.t}" ${Math.round(l.fs)} px`).join('; ')}. (Palm's guide.)`, 'Make body text 16 px or more on phones.');
        const cta = lines.find((l) => l.link);
        if (!cta) add('no-button', 'warn', `${tag}: no link or button in the hero.`, 'Add the call to action in the hero.');
        else {
          if (cta.link.top + cta.link.height > v.h) add('cta-below-fold', 'warn', `${tag}: the button "${cta.link.text}" ends ${Math.round(cta.link.top + cta.link.height)} px down, below the phone's first screen (${v.h} px).`, 'Shorten what sits above it, or bring it up.');
          if (cta.link.height < 24) add('tap-target', 'warn', `${tag}: the button "${cta.link.text}" is ${Math.round(cta.link.height)} px tall; WCAG 2.5.8 asks for at least 24 px.`, 'Pad it to 44–48 px tall.');
          else if (cta.link.height < 44) add('tap-target', 'tip', `${tag}: the button "${cta.link.text}" is ${Math.round(cta.link.height)} px tall (Apple's guideline: 44 pt).`, 'Pad it to 44–48 px tall.');
        }
      }
      // loading (LCP) and layout shift
      if (r.scheme === 'light' && im) {
        if (im.kind === 'img' && im.loading === 'lazy') add('lazy-hero', 'error', `${tag}: the hero photo has loading="lazy". web.dev: "Don't lazy-load images that are likely to be in-viewport when the page loads, especially LCP images."`, 'Remove loading="lazy" from the hero image (keep it on images further down).');
        if (v.id === 'phone' && im.kind === 'background') add('css-background-hero', 'warn', `${tag}: the hero photo is a CSS background, found late by the browser. Shopify's guide: "Use <img> tags for hero and LCP images instead of CSS background images to enable early discovery."`, 'Use an <img> (or <picture>) with object-fit: cover, and fetchpriority="high".');
        if (v.id === 'phone' && im.kind === 'img' && r.lcp?.is_hero && im.fetchpriority !== 'high') add('no-fetchpriority', 'warn', `${tag}: the hero photo is the page's largest paint (LCP) but has no fetchpriority="high".`, 'Add fetchpriority="high" to the hero <img> (Shopify\'s and web.dev\'s advice for the LCP image).');
        if (r.shift > 2) add('cls', 'warn', `${tag}: the page jumps ${Math.round(r.shift)} px when the hero photo arrives (the box below the hero moves; measured by holding the images back). Layout shift counts against CLS (good: 0.1 or less, web.dev).`, 'Give the hero a fixed height or aspect-ratio, or width and height attributes on the <img>.');
      }
    }
    if (subj && subj.method !== 'given') issues.push(issue('subject-estimated', 'note', `No --subject given: the subject is ${subj.method}: x ${pct(subj.box[0])}–${pct(subj.box[0] + subj.box[2])}, y ${pct(subj.box[1])}–${pct(subj.box[1] + subj.box[3])} of the photo. Check it on the sheet.`, 'Pass --subject x,y,w,h (fractions of the photo) for the face or product that must stay in.'));
    dbg('sheet'); sheet = await drawSheet(browser, { results, subj, ref, refUrl, plain, out });
  } finally { await browser.close(); server?.close(); }
  for (const r of results) { delete r._hidden; delete r._shot; delete r.has_dark; if (r.image) { delete r.image.clip; delete r.image.box; } }
  const errors = issues.filter((i) => i.level === 'error').length, warnings = issues.filter((i) => i.level === 'warn').length;
  return { ok: errors === 0, errors, warnings, subject: subj, views: results.map((r) => ({ view: r.view.id, scheme: r.scheme, hero: r.hero, image: r.image, subject: r.subject, lines: (r.lines || []).map((l) => ({ t: l.t, fs: Math.round(l.fs), weight: l.weight, large: l.large, contrast: l.contrast, contrast_min: l.contrast_min, need: l.need, behind: l.behind, over_image: l.over_image, over_subject: l.over_subject, skip: l.skip, button: l.link ? Math.round(l.link.height) + ' px tall' : undefined })), lcp: r.lcp, shift_px: r.shift, error: r.error })), issues, sheet };
}

async function renderView(browser, url, selector, v, scheme) {
  const page = await browser.newPage();
  const view = { id: v.id, w: v.w, h: v.h, dpr: v.dpr, label: v.label };
  try {
    await page.setViewport({ width: v.w, height: v.h, deviceScaleFactor: v.dpr, isMobile: !!v.mobile, hasTouch: !!v.mobile });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.evaluateOnNewDocument(() => {
      window.__hc = { lcp: null };
      try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__hc.lcp = { el: e.element, url: e.url, size: e.size, t: e.startTime }; }).observe({ type: 'largest-contentful-paint', buffered: true }); } catch {}
      // Element Timing: which images have actually been painted (so no screenshot is taken before the photo shows)
      window.__hc.painted = new Set();
      try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.url && e.renderTime) window.__hc.painted.add(e.url); }).observe({ type: 'element', buffered: true }); } catch {}
      const tag = (n) => { if (n.nodeType !== 1) return; if (n.tagName === 'IMG' && !n.hasAttribute('elementtiming')) n.setAttribute('elementtiming', 'hero-check'); n.querySelectorAll?.('img:not([elementtiming])').forEach((i) => i.setAttribute('elementtiming', 'hero-check')); };
      new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) tag(n); }).observe(document, { childList: true, subtree: true });
    });
    const paintedYet = () => page.evaluate(() => { const big = [...document.images].filter((i) => { const r = i.getBoundingClientRect(); return r.width >= innerWidth * 0.6 && r.top < innerHeight && r.bottom > 0 && getComputedStyle(i).visibility !== 'hidden'; }); return big.every((i) => i.complete && i.naturalWidth > 0 && (window.__hc.painted.has(i.currentSrc) || !('PerformanceElementTiming' in window))); });
    // hold the images back first, to see whether the page jumps when they arrive
    await page.setRequestInterception(true);
    const held = []; let holding = true;
    page.on('request', (q) => { if (holding && q.resourceType() === 'image') held.push(q); else q.continue().catch(() => {}); });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    dbg(' dom', v.id); await page.evaluate(() => Promise.race([document.fonts?.ready, new Promise((r) => setTimeout(r, 1500))])); await new Promise((r) => setTimeout(r, 300));
    dbg(' before', v.id); const before = await page.evaluate((sel) => { const h = sel ? document.querySelector(sel) : null; const all = [...document.querySelectorAll('h1,h2,h3,p,footer')].filter((e) => e.getBoundingClientRect().height > 0); const probe = all.find((e) => h ? !h.contains(e) && h.compareDocumentPosition(e) & 4 : e.getBoundingClientRect().top > innerHeight * 0.3) || all[all.length - 1]; if (probe) probe.setAttribute('data-hc-probe', ''); return probe ? probe.getBoundingClientRect().top + scrollY : null; }, selector || null);
    holding = false; for (const q of held) q.continue().catch(() => {});
    await page.waitForNetworkIdle({ idleTime: 400, timeout: 30000 }).catch(() => {});
    dbg(' loaded', v.id); await page.evaluate(() => Promise.race([new Promise((r) => setTimeout(r, 8000)), Promise.all([...document.images].map((i) => i.complete ? 0 : new Promise((r) => (i.onload = i.onerror = r))))])).catch(() => {});
    // decoding="async" images can still be undecoded at the first screenshot (a blank photo): wait for every decode
    await page.evaluate(() => Promise.race([new Promise((r) => setTimeout(r, 8000)), Promise.all([...document.images].map((i) => i.decode ? i.decode().catch(() => {}) : 0))])).catch(() => {});
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await new Promise((r) => setTimeout(r, 250));
    let painted = false; for (let t0 = Date.now(); !(painted = await paintedYet()) && Date.now() - t0 < 12000;) await new Promise((r) => setTimeout(r, 250));
    dbg(' painted', v.id, painted, process.env.HERO_DEBUG ? JSON.stringify(await page.evaluate(() => [...document.images].slice(0, 3).map((i) => ({ src: i.currentSrc.slice(-30), c: i.complete, nw: i.naturalWidth, w: Math.round(i.getBoundingClientRect().width), p: window.__hc.painted.has(i.currentSrc), op: getComputedStyle(i).opacity })))) : '');
    const after = await page.evaluate(() => { const p = document.querySelector('[data-hc-probe]'); return p ? p.getBoundingClientRect().top + scrollY : null; });
    dbg(' collect', v.id); const hasDark = await page.evaluate(() => { const walk = (rules) => { for (const r of rules) { if (r.media && /prefers-color-scheme\s*:\s*dark/.test(r.media.mediaText)) return true; if (r.cssRules && walk(r.cssRules)) return true; } return false; }; for (const s of document.styleSheets) { try { if (walk(s.cssRules)) return true; } catch {} } return false; });
    const data = await page.evaluate(collect, selector || null);
    if (data.error) return { view, scheme, error: data.error, has_dark: hasDark };
    delete data._posAxis; delete data._split;
    const lcp = await page.evaluate(() => { const l = window.__hc.lcp; if (!l) return null; const h = document.querySelector('[data-hero-check]'); return { tag: l.el ? l.el.tagName.toLowerCase() : null, url: l.url ? l.url.slice(0, 200) : '', is_hero: !!(l.el && h && (h === l.el || h.contains(l.el))) && (!!l.url || l.el?.tagName === 'IMG'), in_hero: !!(l.el && h && (h === l.el || h.contains(l.el))), t_ms: Math.round(l.t) }; });
    dbg(' shots', v.id); const hb = data.hero.rect;
    const clipH = Math.min(Math.max(v.h, Math.ceil(hb.bottom + 24)), Math.round(v.h * 1.5));
    // the page must be the active tab, or Chrome may not rasterise its images for the capture
    await page.bringToFront(); await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const beyond = clipH > v.h;
    const shot = await page.screenshot({ type: 'jpeg', quality: 92, clip: { x: 0, y: 0, width: v.w, height: clipH }, captureBeyondViewport: beyond, encoding: 'base64' });
    await page.addStyleTag({ content: '[data-hero-check], [data-hero-check] * { color: transparent !important; -webkit-text-fill-color: transparent !important; text-decoration-color: transparent !important; caret-color: transparent !important }' });
    await new Promise((r) => setTimeout(r, 60));
    const hidden = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: v.w, height: clipH }, captureBeyondViewport: beyond, encoding: 'base64' });
    return { view, scheme, not_painted: !painted || undefined, hero: data.hero, image: data.image || null, lines: data.lines, scrollW: data.scrollW, lcp, shift: before != null && after != null ? round(Math.abs(after - before), 1) : null,
      has_dark: hasDark, clipH, _shot: 'data:image/jpeg;base64,' + shot, _hidden: 'data:image/png;base64,' + hidden };
  } finally { await page.close(); }
}

// ---------- the sheet ----------
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
async function drawSheet(browser, { results, subj, ref, plain, out }) {
  const scale = { phone: 1, tablet: 0.5, laptop: 0.5, desktop: 0.75 };
  const tile = (r) => {
    const v = r.view, k = scale[v.id] ?? 0.5, w = Math.round(v.w * k), h = Math.round((r.clipH || v.h) * k);
    let marks = '';
    if (!plain && !r.error) {
      if (r.subject) { const s = r.subject.rect, ok = r.subject.kept >= 0.9; marks += `<div style="position:absolute;left:${s.left * k}px;top:${s.top * k}px;width:${s.width * k}px;height:${s.height * k}px;border:2px dashed ${ok ? '#1c3' : '#f22'};box-sizing:border-box"></div><div style="position:absolute;left:${Math.max(0, s.left * k)}px;top:${Math.max(0, s.top * k)}px;font:700 11px system-ui;background:${ok ? '#1c3' : '#f22'};color:#fff;padding:0 3px">subject ${Math.round(r.subject.kept * 100)}%</div>`; }
      for (const ln of r.lines || []) { if (ln.contrast == null) continue; const bad = ln.contrast < ln.need; marks += `<div style="position:absolute;left:${ln.left * k}px;top:${ln.top * k}px;width:${ln.width * k}px;height:${ln.height * k}px;outline:${bad ? 2 : 1}px solid ${bad ? '#f22' : 'rgba(40,160,255,.8)'}"></div><div style="position:absolute;left:${(ln.left + ln.width) * k + 2}px;top:${ln.top * k}px;font:700 10px system-ui;background:${bad ? '#f22' : '#2a7'};color:#fff;padding:0 3px;white-space:nowrap">${ln.contrast}:1</div>`; }
    }
    const fold = (r.clipH || v.h) > v.h ? `<div style="position:absolute;left:0;right:0;top:${v.h * k}px;border-top:2px dashed #e0a020"></div><div style="position:absolute;right:4px;top:${v.h * k + 2}px;font:600 10px system-ui;color:#b07000;background:#fff8;padding:0 3px">end of first screen</div>` : '';
    return `<div style="flex:none;width:${w}px"><div style="font:600 12px system-ui;color:#444;margin-bottom:4px">${esc(v.label)}${r.scheme === 'dark' ? ', dark mode' : ''}</div><div style="position:relative;width:${w}px;height:${h}px;overflow:hidden;outline:1px solid #bbb;background:#fff">${r._shot ? `<img src="${r._shot}" style="display:block;width:${w}px;height:${h}px">` : `<div style="padding:20px;font:14px system-ui;color:#c00">${esc(r.error)}</div>`}${fold}${marks}</div></div>`;
  };
  const by = (id, sch = 'light') => results.find((r) => r.view.id === id && r.scheme === sch);
  const row = (rs) => `<div style="display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap;margin-bottom:18px">${rs.filter(Boolean).map(tile).join('')}</div>`;
  // at the screen's real pixels: a 2× phone and a 2× laptop, around the subject (or the hero's middle), 1 device pixel per pixel
  const zoom = (r) => {
    if (!r || r.error || !r._shot) return '';
    const v = r.view, s = r.subject?.rect, hb = r.hero.rect;
    const cx = s ? s.left + s.width / 2 : hb.left + hb.width / 2, cy = s ? s.top + s.height * 0.3 : hb.top + hb.height / 2;
    const Z = 340, W = v.w * v.dpr, H = (r.clipH || v.h) * v.dpr;
    const x = Math.max(0, Math.min(W - Z, cx * v.dpr - Z / 2)), y = Math.max(0, Math.min(H - Z, cy * v.dpr - Z / 2));
    return `<div style="flex:none"><div style="font:600 12px system-ui;color:#444;margin-bottom:4px">${esc(v.label)}: real pixels (${v.dpr} per CSS px), 100%</div><div style="position:relative;width:${Z}px;height:${Z}px;overflow:hidden;outline:1px solid #bbb"><img src="${r._shot}" style="position:absolute;left:${-x}px;top:${-y}px;width:${W}px;height:${H}px;max-width:none"></div></div>`;
  };
  const zooms = `<div class="sec"><h2>Up close, as a 2× screen shows it (around the subject)</h2><div style="display:flex;gap:18px">${zoom(by('phone'))}${zoom(by('tablet'))}${zoom(by('laptop'))}</div></div>`;
  // the photo with each screen's crop (agent's sheet)
  let crops = '';
  if (!plain && ref?.data) {
    const colours = { phone: '#f22', tablet: '#f90', laptop: '#2a7', desktop: '#26f' }, W = 1100;
    let m = '';
    for (const r of results.filter((x) => x.scheme === 'light' && x.image?.visible_in_photo)) { const [x, y, w, h] = r.image.visible_in_photo; m += `<div style="position:absolute;left:${x * 100}%;top:${y * 100}%;width:${w * 100}%;height:${h * 100}%;border:3px solid ${colours[r.view.id]};box-sizing:border-box"></div><div style="position:absolute;left:${x * 100}%;top:calc(${(y + h) * 100}% - 20px);font:700 13px system-ui;background:${colours[r.view.id]};color:#fff;padding:1px 5px">${r.view.id}</div>`; }
    if (subj) { const [x, y, w, h] = subj.box; m += `<div style="position:absolute;left:${x * 100}%;top:${y * 100}%;width:${w * 100}%;height:${h * 100}%;border:3px dashed #fff;outline:2px dashed #000;box-sizing:border-box"></div><div style="position:absolute;left:${x * 100}%;top:${y * 100}%;font:700 12px system-ui;background:#000;color:#fff;padding:1px 5px">subject${subj.method === 'given' ? '' : ' (estimate)'}</div>`; }
    crops = `<div class="sec"><h2>The photo, and the part of it each screen shows (white/black dashes: the subject)</h2><div style="position:relative;width:${W}px"><img src="${ref.data}" style="display:block;width:${W}px">${m}</div></div>`;
  }
  // the numbers (agent's sheet)
  let table = '';
  if (!plain) {
    const rowsH = results.map((r) => { if (r.error) return `<tr><td>${r.view.id}</td><td colspan=6>${esc(r.error)}</td></tr>`; const im = r.image || {}; const worst = (r.lines || []).filter((l) => l.contrast != null).sort((a, b) => a.contrast / a.need - b.contrast / b.need)[0];
      return `<tr><td>${r.view.id}${r.scheme === 'dark' ? ' dark' : ''}</td><td>${r.subject ? Math.round(r.subject.kept * 100) + '%' : '—'}</td><td>${worst ? `${worst.contrast}:1 (needs ${worst.need}) "${esc(worst.t.slice(0, 30))}"` : '—'}</td><td>${im.natural ? `${esc(basename(String(im.file || im.src)))} ${im.natural.w}×${im.natural.h}, ${im.kb ?? '?'} KB, ${im.px_per_css} px/px` : '—'}</td><td>${r.lcp ? (r.lcp.is_hero ? 'hero photo' : esc(r.lcp.tag)) : '—'}</td><td>${r.shift ?? '—'} px</td></tr>`; }).join('');
    table = `<div class="sec"><h2>Measured</h2><table><tr><th>view</th><th>subject kept</th><th>worst text contrast (90% of the pixels behind it)</th><th>file shown</th><th>LCP</th><th>jump when the photo loads</th></tr>${rowsH}</table></div>`;
  }
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;width:1500px;background:#ecebe8;font-family:system-ui,sans-serif}.sec{padding:16px 20px}h2{font:600 14px system-ui;margin:0 0 12px;color:#444}table{border-collapse:collapse;font:12px system-ui;background:#fff}td,th{border:1px solid #ccc;padding:4px 6px;text-align:left}</style></head><body>
<div class="sec" style="background:#2b2f33;color:#fff"><h2 style="color:#fff;font-size:16px">The hero banner at each screen size (first screen of the page; the dashed orange line is where it ends)</h2></div>
<div class="sec">${row([by('phone'), by('phone', 'dark'), by('tablet')])}${row([by('laptop'), by('laptop', 'dark')])}${row([by('desktop')])}</div>
${zooms}${crops}${table}</body></html>`;
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(resolve(out) + '-sheet.html', html);
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1500, height: 1000, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'load', timeout: 120000 });
    await page.screenshot({ path: resolve(out) + '-sheet.png', fullPage: true });
  } finally { await page.close(); }
  return resolve(out) + '-sheet.png';
}

// ---------- a quick hero from a photo and words ----------
export async function fromImage(photo, { headline = 'Your headline', line = '', button = 'Shop now', position = '50% 50%', align = 'left', scrim = false, out = 'look/hero', subject } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'hero-'));
  const name = 'photo' + extname(photo);
  writeFileSync(join(d, name), readFileSync(photo));
  const j = align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start';
  writeFileSync(join(d, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font:18px/1.5 system-ui,sans-serif}.hero{position:relative;min-height:min(80vh,700px);display:flex;align-items:center;justify-content:${j};padding:24px}.hero img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:${position};z-index:-1}.hero .t{max-width:34rem;color:#fff;text-align:${align}}${scrim ? '.hero::before{content:"";position:absolute;inset:0;background:linear-gradient(90deg,rgba(0,0,0,.55),rgba(0,0,0,.1));z-index:-1}' : ''}.hero h1{font-size:clamp(2rem,6vw,4rem);line-height:1.1;margin:0 0 .3em}.hero a{display:inline-block;background:#fff;color:#111;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:600}</style></head><body><section class="hero"><img src="${name}" alt="" fetchpriority="high"><div class="t"><h1>${esc(headline)}</h1>${line ? `<p>${esc(line)}</p>` : ''}<a href="#">${esc(button)}</a></div></section><p style="padding:20px">The rest of the page.</p></body></html>`);
  return check(join(d, 'index.html'), { selector: '.hero', subject, source: photo, out });
}

// ---------- self-test ----------
async function selfTest() {
  const d = mkdtempSync(join(tmpdir(), 'hero-check-'));
  const b = await launch();
  try { // a wide photo: bright busy left, a red "subject" disc on the right, calm dark band at the bottom right; and a phone crop of it
    const p = await b.newPage(); await p.setViewport({ width: 2400, height: 1350 });
    await p.setContent(`<canvas id=c width=2400 height=1350></canvas><script>const x=c.getContext('2d');x.fillStyle='#f4f6f8';x.fillRect(0,0,2400,1350);for(let i=0;i<400;i++){x.fillStyle=['#fff','#dfe7ee','#c9d6c4'][i%3];x.fillRect((i*97)%1100,(i*53)%1350,40,30);}x.fillStyle='#4a5560';x.fillRect(1100,0,1300,1350);x.fillStyle='#d12';x.beginPath();x.arc(1850,560,260,0,7);x.fill();x.fillStyle='#fc3';x.beginPath();x.arc(1850,560,90,0,7);x.fill();</script>`);
    await p.screenshot({ path: join(d, 'photo.jpg'), type: 'jpeg', quality: 90 });
    await p.setViewport({ width: 900, height: 1200 }); // crop x 1400–2300 → resized to 600×800
    await p.setContent(`<body style="margin:0"><img src="data:image/jpeg;base64,${readFileSync(join(d, 'photo.jpg')).toString('base64')}" style="display:block;margin-left:-1400px;margin-top:-75px;width:2400px;height:1350px"></body>`);
    await p.screenshot({ path: join(d, 'phone-crop.jpg'), type: 'jpeg', quality: 88, clip: { x: 0, y: 0, width: 900, height: 1200 } });
  } finally { await b.close(); }
  const subject = '0.66,0.22,0.23,0.42';
  // bad: centred cover crop (loses the subject on a phone), white text over the bright left, lazy, no srcset, no size
  writeFileSync(join(d, 'bad.html'), `<!doctype html><html><head><meta name=viewport content="width=device-width,initial-scale=1"><style>body{margin:0;font:16px system-ui}.hero{position:relative;height:600px}.hero img{width:100%;height:100%;object-fit:cover}.hero .t{position:absolute;left:24px;top:120px;color:#fff}.hero h1{font-size:22px}</style></head><body><section class="hero"><img src="photo.jpg" loading="lazy" alt=""><div class="t"><h1>Fresh flowers today</h1><a href="#" style="color:#fff;font-size:12px">Order</a></div></section><p>Below.</p></body></html>`);
  const bad = await check(join(d, 'bad.html'), { selector: '.hero', subject, source: join(d, 'photo.jpg'), out: join(d, 'bad') });
  const ids = bad.issues.map((i) => `${i.id}@${i.view}`);
  for (const want of ['subject-cut@phone', 'contrast@phone', 'lazy-hero@phone', 'no-srcset@phone', 'headline-small-phone@phone']) if (!ids.includes(want)) throw new Error('bad: expected ' + want + ' in ' + ids.join(', '));
  // good: <picture> with the phone crop, object-position towards the subject on big screens, a scrim, eager + fetchpriority
  writeFileSync(join(d, 'good.html'), `<!doctype html><html><head><meta name=viewport content="width=device-width,initial-scale=1"><style>body{margin:0;font:17px system-ui}.hero{position:relative;height:640px;display:flex;align-items:flex-end;padding:24px;box-sizing:border-box}.hero picture,.hero img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:80% 40%}.hero::after{content:"";position:absolute;inset:0;background:linear-gradient(0deg,rgba(0,0,0,.85),rgba(0,0,0,.65) 50%,rgba(0,0,0,0) 85%)}.hero .t{position:relative;z-index:1;color:#fff;max-width:28rem}.hero h1{font-size:clamp(2rem,6vw,3.5rem);margin:0 0 12px}.hero a{display:inline-block;background:#fff;color:#111;padding:14px 22px;border-radius:99px}</style></head><body><section class="hero"><picture><source media="(max-width: 600px)" srcset="phone-crop.jpg"><img src="photo.jpg" srcset="photo.jpg 2400w" sizes="100vw" width="2400" height="1350" fetchpriority="high" alt="A red flower"></picture><div class="t"><h1>Fresh flowers today</h1><a href="#">Order flowers</a></div></section><p>Below.</p></body></html>`);
  const good = await check(join(d, 'good.html'), { selector: '.hero', subject, source: join(d, 'photo.jpg'), out: join(d, 'good') });
  const gerr = good.issues.filter((i) => i.level === 'error' || (i.level === 'warn' && !['heavy', 'blurry'].includes(i.id)));
  if (gerr.length) throw new Error('good: ' + JSON.stringify(gerr, null, 1));
  const ph = good.views.find((v) => v.view === 'phone'), lap = good.views.find((v) => v.view === 'laptop' && v.scheme === 'light');
  if (!(lap.image.px_per_css > 1.5) || lap.image.natural.w !== 2400) throw new Error('good: srcset file size misread: ' + JSON.stringify(lap.image.natural) + ' ' + lap.image.px_per_css);
  if (!ph.image.in_photo?.box || Math.abs(ph.image.in_photo.box[0] - 1400 / 2400) > 0.03) throw new Error('good: the phone crop was not located in the photo: ' + JSON.stringify(ph.image.in_photo));
  // estimate (no --subject): finds the red disc
  const est = await check(join(d, 'good.html'), { selector: '.hero', source: join(d, 'photo.jpg'), out: join(d, 'est'), views: [VIEWS[0]], dark: false });
  const [ex, ey, ew, eh] = est.subject.box; if (!(ex < 0.7 && ex + ew > 0.85 && ey < 0.35 && ey + eh > 0.5)) throw new Error('estimate missed the subject: ' + JSON.stringify(est.subject));
  console.log(`hero-check: all tests pass (bad: ${ids.join(', ')}; good: phone crop found at x ${ph.image.in_photo.box[0]} (match ${ph.image.in_photo.match}); estimate: ${est.subject.method}; sheets in ${d})`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (k, dflt) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : dflt; };
  const VALUED = new Set(['--out', '--selector', '--subject', '--source', '--root', '--headline', '--line', '--button', '--position', '--align']);
  const pos = argv.filter((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1]));
  const done = (r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); };
  const fail = (e) => { console.error(String(e.stack || e.message || e)); process.exit(2); };
  if (argv.includes('--self-test') || argv.includes('--test')) selfTest().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
  else if (pos[0] === 'check' && pos[1]) check(pos[1], { selector: opt('selector'), subject: opt('subject'), source: opt('source'), out: opt('out', 'look/hero'), root: opt('root'), dark: !argv.includes('--no-dark'), plain: argv.includes('--plain') }).then(done, fail);
  else if (pos[0] === 'image' && pos[1]) fromImage(pos[1], { headline: opt('headline'), line: opt('line'), button: opt('button'), position: opt('position'), align: opt('align'), scrim: argv.includes('--scrim'), subject: opt('subject'), out: opt('out', 'look/hero') }).then(done, fail);
  else fail('usage: hero-check.mjs check index.html [--selector .hero] [--subject x,y,w,h] [--source photo.jpg] [--out look/hero]\n       hero-check.mjs image photo.jpg --headline "…" [--line "…"] [--button "…"] [--position "75% 50%"] [--scrim]\n       hero-check.mjs --self-test');
}
