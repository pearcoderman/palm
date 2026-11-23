#!/usr/bin/env node
// Palm tool: site.render — lets an agent SEE the web page it built. Opens a local HTML file (or a URL) in the user's
// Chrome at phone (390×844) and desktop (1280×800) sizes, saves full-page screenshots, and measures what agents can't
// see from the code: sideways scrolling on phones, text too small to read, tap targets too small, low contrast (where
// the background is a flat colour), images without alt text or far larger than shown, missing title / description /
// share image / viewport, broken requests and console errors. Deterministic, runs on the user's machine, no AI.
// adds: tool (eyes).
//
//   node palm/tools/site-render.mjs index.html [--out site]      → site-desktop.png, site-phone.png + JSON report
//   node palm/tools/site-render.mjs https://example.com --out site
// Then Read both PNGs and look before calling the page done.

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, extname, basename } from 'node:path';
import http from 'node:http';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };

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
const TYPES = { '.html': 'text/html', '.htm': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon', '.avif': 'image/avif' };
async function serve(root) {
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html';
    try { const b = readFileSync(join(root, p)); r.writeHead(200, { 'content-type': TYPES[extname(p).toLowerCase()] || 'application/octet-stream' }); r.end(b); } catch { r.writeHead(404); r.end(); }
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  return srv;
}

// Runs inside the page.
function measure() {
  const W = innerWidth, out = { issues: [] };
  const add = (rule, severity, msg, fix, where) => out.issues.push({ rule, severity, msg, fix, where });
  const sel = (el) => { if (!el || el === document.body) return 'body'; let s = el.tagName.toLowerCase(); if (el.id) return s + '#' + el.id; if (el.className && typeof el.className === 'string') s += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.'); return s; };
  const visible = (el) => { const r = el.getBoundingClientRect(), cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && r.right > 0 && r.left < innerWidth && r.bottom > -scrollY && cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity > 0.05 && !(r.width <= 1 && r.height <= 1); };
  // Sideways scrolling.
  const sw = document.documentElement.scrollWidth;
  if (sw > W + 2) {
    const wide = [...document.body.querySelectorAll('*')].filter((e) => visible(e) && e.getBoundingClientRect().right > W + 2 && getComputedStyle(e).position !== 'fixed').sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right).slice(0, 4).map(sel);
    add('overflow-x', 'error', `The page is ${sw}px wide in a ${W}px window: it scrolls sideways.`, 'Find the wide elements (max-width:100%, flex-wrap, overflow-wrap:anywhere, no fixed widths in px).', wide);
  }
  // Text: size and contrast.
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(parseFloat); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; };
  const lum = ({ r, g, b }) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.backgroundImage && cs.backgroundImage !== 'none') return null; const c = parse(cs.backgroundColor); if (c && c.a > 0.95) return c; } return { r: 255, g: 255, b: 255, a: 1 }; };
  const tiny = [], low = [], lowish = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  while (walker.nextNode()) {
    const t = walker.currentNode; const el = t.parentElement;
    if (!el || seen.has(el) || !t.textContent.trim() || !visible(el) || ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(el.tagName) || el.closest('svg,[aria-hidden="true"]')) continue; // SVG text uses fill, not color; aria-hidden is decoration
    seen.add(el);
    const cs = getComputedStyle(el), fs = parseFloat(cs.fontSize), bold = +cs.fontWeight >= 700;
    if (fs < 11) tiny.push(`${sel(el)} (${fs}px: "${t.textContent.trim().slice(0, 30)}")`);
    const fg = parse(cs.color), bg = bgOf(el);
    if (fg && bg) { const r = ratio(fg, bg), need = fs >= 24 || (bold && fs >= 18.66) ? 3 : 4.5; if (r < need) (r < 3 ? low : lowish).push(`${sel(el)} ${r.toFixed(2)}:1 needs ${need} ("${t.textContent.trim().slice(0, 30)}")`); }
  }
  if (tiny.length) add('tiny-text', tiny.length > 3 ? 'error' : 'warn', `${tiny.length} text block(s) under 11px.`, 'Body text 16px+, labels and small print 12–13px+ on phones.', tiny.slice(0, 5));
  if (low.length) add('contrast', 'error', `${low.length} text block(s) under 3:1: hard to read for anyone.`, 'Darken the text or lighten the background.', low.slice(0, 5));
  if (lowish.length) add('contrast-aa', 'warn', `${lowish.length} text block(s) between 3:1 and WCAG AA (4.5:1).`, 'Fine to keep for a deliberate brand colour on big buttons; fix body text. Don\'t flatten the design to fix these.', lowish.slice(0, 5));
  // Tap targets (WCAG 2.2 minimum 24×24; 44×44 recommended).
  const small = [...document.querySelectorAll('a[href],button,input,select,textarea,[role=button]')].filter(visible).filter((e) => { const r = e.getBoundingClientRect(); return (r.width < 24 || r.height < 24) && !(e.tagName === 'A' && getComputedStyle(e).display === 'inline' && e.closest('p,li')); }).map((e) => `${sel(e)} ${Math.round(e.getBoundingClientRect().width)}×${Math.round(e.getBoundingClientRect().height)}`);
  if (small.length) add('tap-targets', 'warn', `${small.length} tap target(s) smaller than 24×24px.`, 'Give buttons and links at least 44px of height on phones (padding).', small.slice(0, 5));
  // Images.
  const imgs = [...document.images].filter(visible);
  const noAlt = imgs.filter((i) => !i.hasAttribute('alt')).map((i) => i.currentSrc.split('/').pop());
  if (noAlt.length) add('img-alt', 'warn', `${noAlt.length} image(s) without alt text.`, 'Add alt (empty alt="" for decoration).', noAlt.slice(0, 5));
  const big = imgs.filter((i) => i.naturalWidth > 2.5 * i.getBoundingClientRect().width * devicePixelRatio && i.naturalWidth > 1200).map((i) => `${i.currentSrc.split('/').pop()} ${i.naturalWidth}px shown at ${Math.round(i.getBoundingClientRect().width)}px`);
  if (big.length) add('img-oversized', 'tip', `${big.length} image(s) far larger than shown.`, 'Resize or use srcset/sizes.', big.slice(0, 5));
  const broken = imgs.filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.getAttribute('src'));
  if (broken.length) add('img-broken', 'error', `${broken.length} image(s) failed to load.`, 'Fix the paths, or remove them.', broken.slice(0, 5));
  // Head.
  const meta = (n) => document.querySelector(`meta[name="${n}"],meta[property="${n}"]`)?.content || '';
  if (!document.querySelector('meta[name=viewport]')) add('viewport', 'error', 'No viewport meta: phones show a zoomed-out desktop page.', 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.');
  if (!document.title.trim()) add('title', 'error', 'No <title>.', 'Add a specific title (≤ 60 characters).');
  else if (document.title.length > 65) add('title', 'tip', `Title is ${document.title.length} characters; Google cuts at ~60.`, 'Shorten it.');
  const d = meta('description'); if (!d) add('description', 'warn', 'No meta description.', 'Add one (120–160 characters) that says what, where and why.'); else if (d.length > 170) add('description', 'tip', `Description is ${d.length} characters.`, 'Keep it to ~155.');
  if (!meta('og:image')) add('og-image', 'warn', 'No og:image: links shared in iMessage, WhatsApp, Slack show no picture.', 'Add a 1200×630 og:image (absolute URL) plus og:title and og:description.');
  if (!document.documentElement.lang) add('lang', 'tip', 'No lang on <html>.', 'Add lang="en" (or the page language).');
  const h1 = document.querySelectorAll('h1').length; if (h1 !== 1) add('h1', 'tip', `${h1} <h1> elements.`, 'Use exactly one h1.');
  if (!document.querySelector('link[rel~=icon]')) add('favicon', 'tip', 'No favicon link.', 'Add <link rel="icon" href="…">.');
  out.height = document.documentElement.scrollHeight;
  return out;
}

export async function siteRender(target, { out = 'site', root = null } = {}) {
  let srv = null, url = target;
  if (!/^https?:\/\//.test(target)) {
    // --root: serve the whole site from that folder, so absolute paths (/fonts/…, /img/…) resolve.
    const p = resolve(target); const isDir = existsSync(p) && statSync(p).isDirectory();
    const base = root ? resolve(root) : (isDir ? p : dirname(p));
    srv = await serve(base);
    const relPath = (isDir ? p + '/' : p).slice(base.length).replace(/^\/+/, '');
    url = `http://127.0.0.1:${srv.address().port}/${relPath}`;
  }
  const browser = await loadPuppeteer().launch({ executablePath: findChrome(), headless: 'new', timeout: 90000, args: ['--no-first-run', '--no-default-browser-check'] });
  const console_ = [], failed = [];
  try {
    const page = await browser.newPage();
    page.on('console', (m) => { if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) console_.push(m.text().slice(0, 160)); }); // failed loads are counted under requests
    page.on('pageerror', (e) => console_.push(String(e).slice(0, 160)));
    // Only the page's own files count; third-party analytics etc. fail from localhost anyway.
    const own = (u) => !/^https?:/.test(target) ? u.startsWith('http://127.0.0.1') : new URL(u).host === new URL(target).host;
    page.on('requestfailed', (r) => { if (own(r.url())) failed.push(r.url().slice(0, 120)); });
    page.on('response', (r) => { if (r.status() >= 400 && own(r.url())) failed.push(`${r.status()} ${r.url().slice(0, 110)}`); });
    const shots = {}; let phone = null, desktop = null;
    for (const [name, vp] of [['phone', { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }], ['desktop', { width: 1280, height: 800, deviceScaleFactor: 1 }]]) {
      await page.setViewport(vp);
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
      // Scroll through once so scroll-triggered reveals and lazy images happen, then back to the top.
      // …and watch for fixed/sticky bars sitting on top of headings or buttons at each stop.
      const covered = await page.evaluate(async () => {
        const hits = new Set();
        // Content scrolling under a sticky header is normal. Defects: covered at the top, at the very bottom, or where
        // an in-page link lands. First scroll through once (reveals, lazy images), then check those stops.
        for (let y = 0; y < document.documentElement.scrollHeight; y += innerHeight * 0.7) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 100)); }
        const stops = [() => scrollTo(0, 0), () => scrollTo(0, document.documentElement.scrollHeight)];
        for (const a of document.querySelectorAll('a[href^="#"]')) { const id = decodeURIComponent(a.getAttribute('href').slice(1)); const t = id && document.getElementById(id); if (t) stops.push(() => t.scrollIntoView({ block: 'start', behavior: 'instant' })); }
        for (const go of stops.slice(0, 14)) {
          go(); await new Promise((r) => setTimeout(r, 150));
          const bars = [...document.body.querySelectorAll('*')].filter((e) => { const cs = getComputedStyle(e); return (cs.position === 'fixed' || cs.position === 'sticky') && e.getBoundingClientRect().height > 0 && e.getBoundingClientRect().height < innerHeight * 0.5; }).map((e) => ({ e, r: e.getBoundingClientRect() }));
          for (const t of document.querySelectorAll('h1,h2,h3,a.btn,button,[class*=button]')) {
            const r = t.getBoundingClientRect(); if (r.bottom < 0 || r.top > innerHeight || !r.height) continue;
            for (const b of bars) {
              if (b.e.contains(t) || t.contains(b.e)) continue;
              const ix = Math.min(r.right, b.r.right) - Math.max(r.left, b.r.left), iy = Math.min(r.bottom, b.r.bottom) - Math.max(r.top, b.r.top);
              // The bar is drawn on top of the element (elementFromPoint at the overlap's centre is inside the bar).
              if (ix > 8 && iy > Math.min(12, r.height / 2)) { const top = document.elementFromPoint(Math.max(r.left, b.r.left) + ix / 2, Math.max(r.top, b.r.top) + iy / 2); if (top && b.e.contains(top)) hits.add(`${t.tagName.toLowerCase()} "${t.textContent.trim().slice(0, 28)}" under ${b.e.tagName.toLowerCase()}${b.e.className && typeof b.e.className === 'string' ? '.' + b.e.className.trim().split(/\s+/)[0] : ''}`); }
            }
          }
        }
        scrollTo(0, 0);
        return [...hits].slice(0, 5);
      });
      await new Promise((r) => setTimeout(r, 700));
      const m = await page.evaluate(measure);
      if (covered.length) m.issues.push({ rule: 'covered', severity: 'error', msg: `A fixed or sticky bar covers ${covered.length} heading(s)/button(s) while scrolling.`, fix: 'Add scroll-margin-top to anchored sections, pad the page for the bar, or make the bar smaller.', where: covered });
      // Dark mode too: most agents never look at it. Only contrast is re-measured.
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
      await new Promise((r) => setTimeout(r, 250));
      const dk = await page.evaluate(measure);
      for (const i of dk.issues.filter((x) => x.rule === 'contrast')) m.issues.push({ ...i, rule: 'contrast-dark', msg: 'Dark mode: ' + i.msg });
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
      await new Promise((r) => setTimeout(r, 250));
      const file = resolve(`${out}-${name}.png`);
      // Chrome can't capture more than ~16,384 device pixels in one image (past that it repeats the top of the page),
      // so tall pages are captured in slices and stitched.
      const dpr = vp.deviceScaleFactor || 1, total = Math.min(m.height, Math.floor(30000 / dpr));
      if (total * dpr <= 16000) await page.screenshot({ path: file, fullPage: true, captureBeyondViewport: true });
      else {
        const step = Math.floor(6000 / dpr), parts = [];
        for (let y = 0; y < total; y += step) parts.push(await page.screenshot({ encoding: 'base64', clip: { x: 0, y, width: vp.width, height: Math.min(step, total - y) }, captureBeyondViewport: true }));
        const st = await browser.newPage();
        const png = await st.evaluate(async (parts, w) => {
          const ims = await Promise.all(parts.map((p) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = 'data:image/png;base64,' + p; })));
          const c = document.createElement('canvas'); c.width = w; c.height = ims.reduce((h, i) => h + i.height, 0);
          let y = 0; const x = c.getContext('2d'); for (const i of ims) { x.drawImage(i, 0, y); y += i.height; }
          return c.toDataURL('image/png').split(',')[1];
        }, parts, vp.width * dpr);
        await st.close();
        const { writeFileSync: wf } = await import('node:fs'); wf(file, Buffer.from(png, 'base64'));
      }
      shots[name] = file;
      if (name === 'phone') phone = m; else desktop = m;
    }
    const issues = [...phone.issues.map((i) => ({ ...i, at: 'phone' })), ...desktop.issues.filter((i) => !['viewport', 'title', 'description', 'og-image', 'lang', 'h1', 'favicon', 'img-alt'].includes(i.rule)).map((i) => ({ ...i, at: 'desktop' }))];
    if (console_.length) issues.push({ rule: 'console', severity: 'warn', msg: `${console_.length} console error(s).`, where: [...new Set(console_)].slice(0, 4), fix: 'Fix the scripts.' });
    if (failed.length) issues.push({ rule: 'requests', severity: 'warn', msg: `${failed.length} failed request(s).`, where: [...new Set(failed)].slice(0, 4), fix: 'Fix or remove the missing files.' });
    const w = { error: 20, warn: 6, tip: 1 };
    const score = Math.max(0, 100 - issues.reduce((s, i) => s + (w[i.severity] || 0), 0));
    return { ok: !issues.some((i) => i.severity === 'error'), score, shots, issues, look: 'Read both PNGs and look before you finish: is anything cramped, cut off, misaligned or unreadable on the phone? Does the first screen say what it is and what to do?' };
  } finally { await browser.close(); srv?.close(); }
}

if (typeof process !== 'undefined' && process.argv?.[1] === fileURLToPath(import.meta.url)) {
  const t = process.argv[2];
  if (!t || t.startsWith('--')) { console.error('usage: site-render.mjs <index.html|folder|url> [--out site] [--root <site folder for absolute paths>]'); process.exit(2); }
  process.stdout.write(JSON.stringify(await siteRender(t, { out: arg('out', 'site'), root: arg('root', null) }), null, 2) + '\n');
}
