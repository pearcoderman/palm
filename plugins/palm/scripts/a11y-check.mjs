#!/usr/bin/env node
// Palm tool: a11y-check — checks a web page for accessibility (WCAG 2.2 AA, the level the European Accessibility Act
// and the ADA cases point to) by USING it, not just reading it: it walks the page with the Tab key and photographs
// every focus state, measures text contrast against the real pixels behind it (photos and gradients included),
// reflows it at 320px, applies the text-spacing test, watches for content that moves by itself, and reads the
// accessible names Chrome computes for every control. One focus sheet and one map to look at, plus measured problems.
// adds: tool. Runs on the user's machine with their Chrome/Edge/Chromium; nothing leaves it.
//
//   node a11y-check.mjs index.html [--out a11y] [--root <site folder>]    (or a URL)
// Prints JSON {ok, score, errors, map, focus_sheet, issues:[{rule, wcag, severity, msg, fix, where}]}.
// Then LOOK at <out>-map.png (problems boxed on the page) and <out>-focus.png (every Tab stop, in order).
// Automated checks find many problems but not all: also try the page with a screen reader (VoiceOver: ⌘F5).

import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, extname, relative } from 'node:path';
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
const TYPES = { '.html': 'text/html', '.htm': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon', '.avif': 'image/avif', '.mp4': 'video/mp4' };
async function serve(root) {
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html';
    try { const b = readFileSync(join(root, p)); r.writeHead(200, { 'content-type': TYPES[extname(p).toLowerCase()] || 'application/octet-stream' }); r.end(b); } catch { r.writeHead(404); r.end(); }
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  return srv;
}
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));

// ---------- runs inside the page ----------
function pageAudit() {
  const out = { issues: [], sample: [], hover: [] };
  const add = (rule, wcag, severity, msg, fix, el) => out.issues.push({ rule, wcag, severity, msg, fix, where: el ? [sel(el)] : [], box: el ? box(el) : null });
  function sel(el) {
    if (!el || el === document.body) return 'body';
    let s = el.tagName.toLowerCase(); if (el.id) return s + '#' + el.id;
    if (el.className && typeof el.className === 'string' && el.className.trim()) s += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
    const t = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24);
    return t ? `${s} "${t}"` : s;
  }
  function box(el) { const r = el.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }; }
  const vis = (el) => { const r = el.getBoundingClientRect(), cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity > 0.05; };
  if (!document.documentElement.lang) add('lang', '3.1.1', 'error', 'The page has no lang attribute: screen readers may read it in the wrong voice and accent.', 'Add <html lang="en"> (or the page\'s language).');
  if (!document.title.trim()) add('title', '2.4.2', 'error', 'The page has no <title>.', 'Add a title that says what the page is.');
  const shown = (el) => { const cs = getComputedStyle(el); return el.getClientRects().length && cs.visibility !== 'hidden'; }; // opacity 0 (scroll reveals) is still read out
  // Images.
  for (const im of document.querySelectorAll('img')) if (!im.hasAttribute('alt') && shown(im)) add('img-alt', '1.1.1', 'error', 'An image has no alt attribute: screen readers read out its file name.', 'Add alt="what it shows" (or alt="" if it is decoration).', im);
  // Headings.
  const hs = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(shown);
  if (!hs.some((h) => h.tagName === 'H1')) add('h1', '1.3.1', 'warn', 'No <h1>: screen-reader users jump by headings and find no main heading.', 'Make the page\'s main heading an <h1>.');
  for (let i = 1; i < hs.length; i++) { const a = +hs[i - 1].tagName[1], b = +hs[i].tagName[1]; if (b > a + 1) { add('heading-skip', '1.3.1', 'warn', `Heading levels jump from h${a} to h${b}.`, 'Use the next level down (style it with CSS, not the tag).', hs[i]); break; } }
  if (!document.querySelector('main,[role=main]')) add('main', '1.3.1', 'tip', 'No <main> landmark: screen-reader users can\'t jump straight to the content.', 'Wrap the main content in <main>.');
  // Clickable things a keyboard can't reach.
  const focusable = (el) => el.tabIndex >= 0 && !el.disabled;
  const native = 'a[href],button,input,select,textarea,summary,[contenteditable=""],[contenteditable=true]';
  for (const el of document.querySelectorAll('body *')) {
    if (!vis(el) || el.closest(native) || focusable(el)) continue;
    const click = el.hasAttribute('onclick') || el.getAttribute('role') === 'button' || (getComputedStyle(el).cursor === 'pointer' && (!el.parentElement || getComputedStyle(el.parentElement).cursor !== 'pointer'));
    if (click && !el.querySelector(native)) add('keyboard', '2.1.1', 'error', 'Something clickable can\'t be reached or used with the keyboard (it isn\'t a button or link).', 'Make it a <button> (or <a href>), so Tab reaches it and Enter/Space work.', el);
  }
  // Hover-only menus: a submenu shown only on :hover.
  for (const sheet of document.styleSheets) {
    let rules; try { rules = sheet.cssRules; } catch { continue; }
    for (const r of rules || []) if (r.selectorText && /:hover\s*(>|\s)\s*[\w.#\[]/.test(r.selectorText) && /display|visibility|opacity/.test(r.style.cssText) && !/focus-within|focus/.test(r.selectorText)) {
      const part = r.selectorText.split(',').find((s) => s.includes(':hover'));
      const base = part.split(':hover')[0].trim(), sub = part.split(':hover')[1].trim().replace(/^>\s*/, ':scope > ');
      let el = null, kid = null; try { el = document.querySelector(base); kid = el && el.querySelector(sub); } catch {}
      if (el && kid && getComputedStyle(kid).display === 'none' || (kid && getComputedStyle(kid).visibility === 'hidden')) { el.dataset.palmHover = String(out.hover.length); out.hover.push({ i: out.hover.length, rule: r.selectorText.slice(0, 60), sub, where: sel(el), box: box(el) }); }
    }
  }
  // Target size (WCAG 2.2: 24×24 CSS px), skipping links inside running text.
  const small = [];
  for (const el of document.querySelectorAll('a[href],button,input:not([type=hidden]),select,[role=button],[role=link]')) {
    if (!vis(el)) continue; const r = el.getBoundingClientRect();
    if (el.tagName === 'A' && el.parentElement && /^(P|LI|TD|SPAN|SMALL|FOOTER|DD)$/.test(el.parentElement.tagName) && el.parentElement.textContent.trim().length > el.textContent.trim().length + 20) continue;
    if (el.type === 'checkbox' || el.type === 'radio') { if (el.labels?.length) continue; }
    if (r.width < 24 || r.height < 24) small.push(el);
  }
  if (small.length) { add('target-size', '2.5.8', 'warn', `${small.length} control(s) smaller than 24×24px: hard to hit with a finger or a shaky hand.`, 'Make them at least 24×24 (44×44 is better on phones), with padding.', small[0]); out.issues.at(-1).where = small.slice(0, 5).map(sel); }
  // Placeholder used as the only label.
  for (const f of document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]),textarea,select')) {
    if (!vis(f)) continue; const labelled = f.labels?.length || f.getAttribute('aria-label') || f.getAttribute('aria-labelledby') || f.title;
    if (!labelled && f.placeholder) add('placeholder-label', '3.3.2', 'warn', 'A form field\'s only label is its placeholder, which disappears as soon as someone types (and is often too faint).', 'Add a visible <label for="…">.', f);
  }
  // Text contrast: solid backgrounds are computed here; text over images/gradients is measured from pixels later.
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const v = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [v[0], v[1], v[2], v[3] ?? 1]; };
  const lum = ([r, g, b]) => { const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const blend = (top, bot) => { const a = top[3]; return [top[0] * a + bot[0] * (1 - a), top[1] * a + bot[1] * (1 - a), top[2] * a + bot[2] * (1 - a), 1]; };
  const seen = new Set(); const low = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = walker.nextNode());) {
    const el = n.parentElement; if (!el || seen.has(el) || !n.textContent.trim() || el.closest('svg') || !vis(el) || /^(SCRIPT|STYLE|NOSCRIPT|OPTION)$/.test(el.tagName)) continue;
    seen.add(el);
    const cs = getComputedStyle(el); let fg = parse(cs.color); if (!fg) continue;
    const size = parseFloat(cs.fontSize), bold = +cs.fontWeight >= 700, large = size >= 24 || (bold && size >= 18.66), need = large ? 3 : 4.5;
    const r = el.getBoundingClientRect();
    // What's behind the text: walk the stack under its middle.
    let bg = null, image = false;
    const stack = document.elementsFromPoint(Math.min(innerWidth - 1, Math.max(0, r.left + Math.min(r.width, 40) / 2)), Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2)));
    let layers = [];
    const chain = stack.length && stack.includes(el) ? stack.slice(stack.indexOf(el)) : (() => { const a = []; for (let e = el; e; e = e.parentElement) a.push(e); return a; })();
    for (const e of chain) {
      const s = getComputedStyle(e);
      if ((s.backgroundImage && s.backgroundImage !== 'none') || /^(IMG|VIDEO|CANVAS|PICTURE|svg)$/i.test(e.tagName)) { image = true; break; }
      const c = parse(s.backgroundColor); if (c && c[3] > 0) { layers.push(c); if (c[3] >= 1) break; }
    }
    if (image) { out.sample.push({ i: out.sample.length, where: sel(el), need, fg, box: box(el), id: (el.dataset.palmA11y = 'a' + out.sample.length) }); continue; }
    bg = layers.reverse().reduce((acc, c) => blend(c, acc), [255, 255, 255, 1]);
    if (fg[3] < 1) fg = blend(fg, bg);
    const k = ratio(fg, bg);
    if (k < need) low.push({ el, k, need });
  }
  for (const { el, k, need } of low.slice(0, 12)) add('contrast', '1.4.3', 'error', `Text contrast ${k.toFixed(2)}:1, needs ${need}:1.`, 'Darken the text (or lighten the background) until it passes.', el);
  if (low.length > 12) add('contrast', '1.4.3', 'error', `…and ${low.length - 12} more text elements under the contrast minimum.`, 'Fix the colours in the shared CSS.', null);
  // CSS animations that run forever (tickers, spinners on content), unless they stop on hover/focus or have a pause control.
  out.loops = [...new Set(document.getAnimations().filter((an) => an.effect?.getTiming().iterations === Infinity && an.effect?.target && an.playState === 'running').map((an) => an.effect.target))]
    .filter((t) => vis(t) && t.textContent.trim().length > 20 && t.getBoundingClientRect().width > 100).map((t) => { const r = t.getBoundingClientRect(); return { where: sel(t), box: box(t) }; });
  return out;
}

// What moves by itself in 10 seconds (carousels, tickers): places that change at two or more separate moments.
function watchMotion() {
  return new Promise((ok) => {
    const ticks = new Map(), t0 = performance.now();
    const hit = (e, b) => { if (!e || e === document.body || e === document.documentElement) return; (ticks.get(e) || ticks.set(e, new Set()).get(e)).add(b); };
    const mo = new MutationObserver((ms) => { const b = Math.round((performance.now() - t0) / 500); for (const m of ms) { const t = m.target.nodeType === 1 ? m.target : m.target.parentElement; if (!t || t.closest?.('[data-palm-a11y-ignore]')) continue; hit(t, b); hit(t.parentElement, b); } });
    mo.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'], childList: true, characterData: true });
    setTimeout(() => {
      mo.disconnect();
      const moving = [...ticks.entries()].filter(([, s]) => s.size >= 2).map(([e]) => e);
      // The outermost moving element of each group stands for the region.
      const regions = new Set(moving.filter((e) => !moving.some((o) => o !== e && o.contains(e))));
      const res = [];
      for (let r of regions) {
        let r0 = r; while (r0.parentElement && r0.parentElement !== document.body && (r0.getBoundingClientRect().width < 40 || r0.getBoundingClientRect().height < 20)) r0 = r0.parentElement;
        r = r0; const b = r.getBoundingClientRect(); if (b.width < 40 || b.height < 16) continue;
        const near = r.closest('section,div,aside,header,main,body') || r;
        const ctl = [...(near.parentElement || near).querySelectorAll('button,[role=button],a')].some((c) => /pause|stop|play/i.test((c.getAttribute('aria-label') || '') + ' ' + c.textContent + ' ' + (c.title || '')));
        res.push({ where: r.id ? `#${r.id}` : r.tagName.toLowerCase() + (r.className && typeof r.className === 'string' ? '.' + r.className.trim().split(/\s+/)[0] : ''), ctl, box: { x: b.left + scrollX, y: b.top + scrollY, w: b.width, h: b.height } });
      }
      ok(res);
    }, 10000);
  });
}

// Crop a viewport screenshot (base64 PNG) to a viewport rectangle, in a blank page.
function cropPng(b64, r) {
  return new Promise((ok) => { const i = new Image(); i.onload = () => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(r.w)); c.height = Math.max(1, Math.round(r.h)); c.getContext('2d').drawImage(i, -Math.round(r.x), -Math.round(r.y)); ok(c.toDataURL('image/png').split(',')[1]); }; i.src = 'data:image/png;base64,' + b64; });
}

// Pixel helpers, run in a blank page: luminance of every pixel of a PNG (base64), or the difference between two.
function pixelStats(a, b, fg) {
  const load = (s) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = 'data:image/png;base64,' + s; });
  return Promise.all([load(a), b ? load(b) : null]).then(([ia, ib]) => {
    const c = document.createElement('canvas'); c.width = ia.width; c.height = ia.height; const x = c.getContext('2d');
    x.drawImage(ia, 0, 0); const A = x.getImageData(0, 0, c.width, c.height).data;
    if (ib) { x.clearRect(0, 0, c.width, c.height); x.drawImage(ib, 0, 0); const B = x.getImageData(0, 0, c.width, c.height).data; let d = 0; for (let i = 0; i < A.length; i += 4) if (Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]) > 60) d++; return { changed: d, of: A.length / 4 }; }
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const L = (r, g, bb) => 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(bb);
    const lf = L(fg[0], fg[1], fg[2]); const ks = [];
    for (let i = 0; i < A.length; i += 16) { const lb = L(A[i], A[i + 1], A[i + 2]); const [hi, lo] = lb > lf ? [lb, lf] : [lf, lb]; ks.push((hi + 0.05) / (lo + 0.05)); }
    ks.sort((p, q) => p - q);
    return { p10: ks[Math.floor(ks.length * 0.1)] || 21, median: ks[Math.floor(ks.length / 2)] || 21 };
  });
}

export async function a11yCheck(target, { out = 'a11y', root = null } = {}) {
  const isUrl = /^https?:\/\//i.test(target);
  let srv = null, url = target;
  if (!isUrl) {
    const abs = resolve(target); const file = statSync(abs).isDirectory() ? join(abs, 'index.html') : abs;
    root = root ? resolve(root) : dirname(file); srv = await serve(root);
    url = `http://127.0.0.1:${srv.address().port}/${relative(root, file).split('/').map(encodeURIComponent).join('/')}`;
  }
  const puppeteer = loadPuppeteer();
  const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true, timeout: 90000, args: ['--no-sandbox', '--hide-scrollbars', '--font-render-hinting=none'] });
  mkdirSync(dirname(resolve(out + '-map.png')), { recursive: true });
  try {
    const tool = await browser.newPage(), page = await browser.newPage();
    await page.bringToFront(); // a background tab pauses animations and observers
    const px = (a, b, fg) => tool.evaluate(pixelStats, a, b, fg);
    // A screenshot of part of the viewport: plain viewport capture, cropped (robust to scrolling and sticky headers).
    const grab = async (r) => { const vw = page.viewport(); const x = Math.max(0, r.x), y = Math.max(0, r.y); const c = { x, y, w: Math.min(vw.width - x, r.w - (x - r.x)), h: Math.min(vw.height - y, r.h - (y - r.y)) }; if (c.w < 2 || c.h < 2) return null; return tool.evaluate(cropPng, await page.screenshot({ encoding: 'base64' }), c); };
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    await page.evaluate(() => document.fonts?.ready); await wait(300);
    const motion = await page.evaluate(watchMotion);
    const a = await page.evaluate(pageAudit);
    const issues = a.issues;

    // Menus that open on hover: can the keyboard open them (focus inside, or Enter on the trigger)?
    for (const h of a.hover) {
      const open = async () => page.evaluate((i, sub) => { const el = document.querySelector(`[data-palm-hover="${i}"]`); const k = el?.querySelector(sub); if (!k) return false; const cs = getComputedStyle(k); return cs.display !== 'none' && cs.visibility !== 'hidden' && k.getBoundingClientRect().height > 0; }, h.i, h.sub);
      const has = await page.evaluate((i) => { const t = document.querySelector(`[data-palm-hover="${i}"]`)?.querySelector('a[href],button,[tabindex]:not([tabindex="-1"])'); if (!t) return false; t.focus(); return true; }, h.i);
      let ok = has && await open();
      if (has && !ok) { await page.keyboard.press('Enter'); await wait(150); ok = await open(); }
      await page.evaluate(() => { document.activeElement?.blur?.(); if (location.hash) history.replaceState(null, '', location.pathname); window.scrollTo(0, 0); });
      if (!ok) issues.push({ rule: 'hover-only', wcag: '2.1.1', severity: 'error', msg: `A menu or panel opens only on mouse hover (${h.rule}): with the keyboard (focus, then Enter) it stays shut, and touch users can't open it either.`, fix: 'Open it on :focus-within too, or make its trigger a <button aria-expanded> that toggles it.', where: [h.where], box: h.box });
    }

    // Text over images and gradients: hide the glyphs, photograph what's behind them, measure.
    for (const s of a.sample.slice(0, 30)) {
      const b = s.box; if (b.w < 2 || b.h < 2) continue;
      const vr = await page.evaluate((id) => { document.documentElement.style.scrollBehavior = 'auto'; const e = document.querySelector(`[data-palm-a11y="${id}"]`); e.scrollIntoView({ block: 'center', behavior: 'instant' }); e.dataset.palmColor = e.style.color; e.style.setProperty('color', 'transparent', 'important'); e.style.setProperty('-webkit-text-fill-color', 'transparent', 'important'); const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }, s.id);
      await wait(120);
      const shot = await grab(vr);
      await page.evaluate((id) => { const e = document.querySelector(`[data-palm-a11y="${id}"]`); e.style.color = e.dataset.palmColor; e.style.removeProperty('-webkit-text-fill-color'); }, s.id);
      if (!shot) continue;
      const k = await px(shot, null, s.fg);
      if (k.p10 < s.need) issues.push({ rule: 'contrast-image', wcag: '1.4.3', severity: 'error', msg: `Text over a photo or gradient: contrast falls to ${k.p10.toFixed(2)}:1 behind parts of it (median ${k.median.toFixed(2)}:1), needs ${s.need}:1.`, fix: 'Put a solid or dark-enough scrim behind the text (e.g. a background colour with ~0.6 opacity on the text box), or move the text off the busy part of the photo.', where: [s.where], box: s.box });
    }

    // Keyboard: Tab through the page, photographing each focus state with and without focus.
    const stops = [];
    await page.evaluate(() => { document.activeElement?.blur?.(); window.scrollTo(0, 0); });
    const total = await page.evaluate(() => [...document.querySelectorAll('a[href],button,input,select,textarea,summary,[tabindex]')].filter((e) => e.tabIndex >= 0 && !e.disabled && e.getClientRects().length).length);
    const seen = new Map();
    for (let i = 0; i < Math.min(80, total + 6); i++) {
      await page.keyboard.press('Tab'); await wait(60);
      const f = await page.evaluate(() => {
        const e = document.activeElement; if (!e || e === document.body) return null;
        document.documentElement.style.scrollBehavior = 'auto'; e.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
        const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
        if (!e.dataset.palmTab) e.dataset.palmTab = String(Math.random()).slice(2, 9);
        const t = (e.getAttribute('aria-label') || e.textContent || e.value || e.placeholder || '').trim().replace(/\s+/g, ' ').slice(0, 30);
        const hidden = r.width < 1 || r.height < 1 || cs.visibility === 'hidden' || +cs.opacity < 0.05 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth;
        return { key: e.dataset.palmTab, tag: e.tagName.toLowerCase(), text: t, x: r.left, y: r.top, w: r.width, h: r.height, sx: scrollX, sy: scrollY, hidden };
      });
      if (!f) break;
      if (seen.has(f.key)) { f.repeat = seen.get(f.key); stops.push(f); break; }
      if (f.sy !== (stops.at(-1)?.sy ?? 0)) await wait(1000); // let scroll-reveal animations finish
      Object.assign(f, await page.evaluate(() => {
        const e = document.activeElement, r = e.getBoundingClientRect(); let op = 1; for (let p = e; p; p = p.parentElement) op *= +getComputedStyle(p).opacity;
        const cs = getComputedStyle(e);
        return { x: r.left, y: r.top, w: r.width, h: r.height, sx: scrollX, sy: scrollY, hidden: r.width < 1 || r.height < 1 || cs.visibility === 'hidden' || op < 0.05 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth };
      }));
      seen.set(f.key, stops.length);
      if (!f.hidden) {
        const clip = { x: f.x - 8, y: f.y - 8, w: f.w + 16, h: f.h + 16 };
        const on = await grab(clip);
        if (on) {
          await page.evaluate(() => { const e = document.activeElement; e.dataset.palmBlur = '1'; e.blur(); });
          await wait(40);
          const off = await grab(clip);
          await page.evaluate((k) => document.querySelector(`[data-palm-tab="${k}"]`)?.focus({ preventScroll: true }), f.key);
          await wait(40);
          const d = await px(on, off);
          f.visible = d.changed >= Math.max(12, Math.min(f.w, f.h) * 0.8);
          f.img = on;
        }
      }
      stops.push(f);
    }
    const tabbed = stops.filter((s) => s.repeat == null);
    const noRing = tabbed.filter((s) => !s.hidden && s.visible === false);
    if (noRing.length) issues.push({ rule: 'focus-visible', wcag: '2.4.7', severity: 'error', msg: `${noRing.length} of ${tabbed.length} Tab stops show no visible focus (nothing changes when they're focused): keyboard users can't see where they are.`, fix: 'Don\'t remove outlines; add a clear :focus-visible style (e.g. outline: 3px solid <brand colour>; outline-offset: 2px) that contrasts with the background.', where: noRing.slice(0, 6).map((s) => `${s.tag} "${s.text}"`) });
    const ghost = tabbed.filter((s) => s.hidden);
    if (ghost.length) issues.push({ rule: 'focus-hidden', wcag: '2.4.11', severity: 'error', msg: `${ghost.length} Tab stop(s) land on something invisible or off-screen (a closed menu, a hidden slide, a collapsed panel).`, fix: 'Hide closed things with display:none / hidden / inert, so Tab skips them; or show them when focused.', where: ghost.slice(0, 6).map((s) => `${s.tag} "${s.text}"`) });
    const last = stops.at(-1);
    if (last?.repeat != null && last.repeat > 0 && tabbed.length < total - 1) issues.push({ rule: 'focus-trap', wcag: '2.1.2', severity: 'error', msg: `The keyboard gets stuck: Tab cycles through ${tabbed.length - last.repeat} element(s) and never reaches the rest of the page.`, fix: 'Only trap focus inside an open dialog, and let Escape close it.', where: [`${last.tag} "${last.text}"`] });

    // Motion that can't be paused.
    for (const l of a.loops || []) motion.push({ where: l.where, box: l.box, ctl: await page.evaluate((w) => !![...document.querySelectorAll('button,[role=button]')].find((c) => /pause|stop/i.test((c.getAttribute('aria-label') || '') + ' ' + c.textContent)), l.where), css: true });
    for (const m of motion) if (!m.ctl) issues.push({ rule: 'auto-motion', wcag: '2.2.2', severity: 'error', msg: `Content moves or changes by itself (${m.where}) with no pause button: it distracts and can't be read at your own pace.`, fix: 'Add a visible Pause button, stop it on hover/focus, and don\'t auto-advance when prefers-reduced-motion is set.', where: [m.where], box: m.box });

    // Map: the desktop page with every problem boxed.
    const boxes = issues.filter((i) => i.box && i.box.w > 0).map((i, n) => ({ ...i.box, n: n + 1, sev: i.severity, rule: i.rule }));
    await page.evaluate((bs) => {
      const layer = document.createElement('div'); layer.id = 'palm-a11y-layer'; layer.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none';
      for (const b of bs) { const d = document.createElement('div'); d.style.cssText = `position:absolute;left:${b.x - 3}px;top:${b.y - 3}px;width:${b.w + 6}px;height:${b.h + 6}px;outline:3px solid ${b.sev === 'error' ? '#e00' : '#f90'};`; const t = document.createElement('span'); t.textContent = b.rule; t.style.cssText = `position:absolute;left:-3px;top:-20px;background:${b.sev === 'error' ? '#e00' : '#f90'};color:#fff;font:600 12px/16px system-ui;padding:1px 5px;white-space:nowrap`; d.append(t); layer.append(d); }
      document.body.append(layer); document.activeElement?.blur?.(); window.scrollTo(0, 0);
    }, boxes);
    const map = `${out}-map.png`;
    await page.screenshot({ path: map, fullPage: true, captureBeyondViewport: true });
    await page.evaluate(() => document.getElementById('palm-a11y-layer')?.remove());

    // Reflow at 320px (= 1280px zoomed to 400%) and the text-spacing test.
    await page.setViewport({ width: 320, height: 640, deviceScaleFactor: 1 }); await wait(300);
    const reflow = await page.evaluate(() => {
      const W = innerWidth, hox = getComputedStyle(document.documentElement).overflowX, box_ = getComputedStyle(document.body).overflowX;
      const pageClips = /hidden|clip/.test(hox) || (hox === 'visible' && /hidden|clip/.test(box_)); // body's overflow applies to the page when html's is visible
      const scrolls = !pageClips && document.documentElement.scrollWidth > W + 2;
      // Clipped by its own box (a ticker, a table that scrolls inside itself) is fine; cut off by the page is not.
      const ownClip = (e) => { for (let a = e.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) if (/hidden|auto|scroll|clip/.test(getComputedStyle(a).overflowX)) return true; return false; };
      const name = (e) => e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\s+/)[0] : '');
      const wide = [...document.body.querySelectorAll('*')].filter((e) => { const r = e.getBoundingClientRect(); return r.right > W + 2 && r.width > 0 && getComputedStyle(e).position !== 'fixed' && !ownClip(e); });
      const top = wide.filter((e) => !wide.some((o) => o !== e && o.contains(e))).slice(0, 3).map(name);
      if (scrolls) return { sw: document.documentElement.scrollWidth, wide: top, cut: false };
      return top.length ? { sw: Math.max(...wide.map((e) => Math.round(e.getBoundingClientRect().right))), wide: top, cut: true } : null;
    });
    if (reflow) issues.push({ rule: 'reflow', wcag: '1.4.10', severity: 'error', msg: reflow.cut ? `At 320px wide (what 400% zoom gives) content runs to ${reflow.sw}px and the page cuts it off (overflow hidden on the page): people who zoom can't read it at all.` : `At 320px wide (what 400% zoom gives) the page is ${reflow.sw}px wide: people who zoom have to scroll sideways to read every line.`, fix: 'Remove fixed widths (use max-width:100%, flex-wrap, tables that scroll inside their own box).', where: reflow.wide });
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 }); await wait(200);
    const clipped = await page.evaluate(() => {
      const st = document.createElement('style'); st.textContent = '*{line-height:1.5!important;letter-spacing:.12em!important;word-spacing:.16em!important}p{margin-bottom:2em!important}'; document.head.append(st);
      const spills = (e) => { const r = e.getBoundingClientRect(), w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT); for (let n; (n = w.nextNode());) { if (!n.textContent.trim() || n.parentElement.closest('[aria-hidden="true"]')) continue; const g = document.createRange(); g.selectNodeContents(n); for (const q of g.getClientRects()) if (q.bottom > r.bottom + 2 || q.right > r.right + 2) return true; } return false; };
      const res = [...document.body.querySelectorAll('*')].filter((e) => { const cs = getComputedStyle(e); return e.textContent.trim() && /hidden|clip/.test(cs.overflow + cs.overflowY) && e.scrollHeight > e.clientHeight + 3 && e.clientHeight > 1 && e.clientWidth > 1 && spills(e); }) // 1px boxes are the visually-hidden pattern (read out, not shown).slice(0, 4).map((e) => e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/)[0] : ''));
      st.remove(); return res;
    });
    if (clipped.length) issues.push({ rule: 'text-spacing', wcag: '1.4.12', severity: 'warn', msg: `With wider letter and line spacing (people with dyslexia use it), text gets cut off in ${clipped.length} box(es).`, fix: 'Let boxes grow with their text: no fixed heights with overflow:hidden on text.', where: clipped });

    // Names Chrome computes for every control (what a screen reader says).
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    const cdp = await page.createCDPSession();
    const { nodes } = await cdp.send('Accessibility.getFullAXTree');
    const roles = new Set(['button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'searchbox', 'slider', 'switch', 'menuitem', 'tab', 'listbox', 'spinbutton']);
    const nameless = nodes.filter((n) => !n.ignored && roles.has(n.role?.value) && !(n.name?.value || '').trim());
    if (nameless.length) {
      const where = [];
      for (const n of nameless.slice(0, 6)) { try { const { node } = await cdp.send('DOM.describeNode', { backendNodeId: n.backendDOMNodeId }); const at = Object.fromEntries((node.attributes || []).reduce((a, v, i, arr) => (i % 2 ? a : a.concat([[v, arr[i + 1]]])), [])); where.push(`${n.role.value}: <${node.localName}${at.class ? ' class="' + at.class + '"' : ''}${at.href ? ' href="' + at.href + '"' : ''}${at.type ? ' type="' + at.type + '"' : ''}>`); } catch { where.push(n.role.value); } }
      issues.push({ rule: 'name', wcag: '4.1.2', severity: 'error', msg: `${nameless.length} control(s) have no name a screen reader can say (it announces just "button" or "link"): icon-only buttons, empty links, unlabelled fields.`, fix: 'Give each one visible text, an aria-label, or a <label>; for an SVG icon in a button, aria-label on the button and aria-hidden="true" on the svg.', where });
    }

    // Focus sheet: every Tab stop in order, red where nothing shows.
    const tiles = tabbed.filter((s) => s.img).slice(0, 40);
    let focusSheet = null;
    if (tiles.length) {
      await tool.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
      await tool.setContent(`<!doctype html><style>body{margin:0;padding:12px;background:#eee;font:12px/1.3 system-ui;display:flex;flex-wrap:wrap;gap:10px;width:1256px}figure{margin:0;background:#fff;padding:6px;border:3px solid #3a3;max-width:400px}figure.bad{border-color:#e00}figcaption{margin-top:4px;color:#333;max-width:380px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}img{display:block;max-width:380px;max-height:160px}</style>${tiles.map((s, i) => `<figure class="${s.visible ? '' : 'bad'}"><img src="data:image/png;base64,${s.img}"><figcaption>${i + 1}. ${s.tag} ${String(s.text).replace(/[<&]/g, '')}${s.visible ? '' : ' · NO VISIBLE FOCUS'}</figcaption></figure>`).join('')}`);
      focusSheet = `${out}-focus.png`;
      await tool.screenshot({ path: focusSheet, fullPage: true });
    }

    const W = { error: 12, warn: 4, tip: 1 };
    const errors = issues.filter((i) => i.severity === 'error').length;
    const score = Math.max(0, 100 - issues.reduce((s, i) => s + W[i.severity], 0));
    const clean = issues.map(({ box, ...i }) => i);
    return { ok: errors === 0, score, errors, url: srv ? '(local) ' + target : url, tab_stops: tabbed.length, map, focus_sheet: focusSheet, issues: clean,
      look: `LOOK at ${map} (problems boxed on the page)${focusSheet ? ` and ${focusSheet} (every Tab stop in order; red = nothing shows when focused)` : ''}. Automated checks find many problems, not all: also try the page with a screen reader.` };
  } finally { srv?.close(); await browser.close(); }
}

async function selfTest() {
  const { mkdtempSync, writeFileSync } = await import('node:fs'); const { tmpdir } = await import('node:os');
  const d = mkdtempSync(join(tmpdir(), 'palm-a11y-'));
  writeFileSync(join(d, 'bad.html'), `<!doctype html><html><head><title>Bad</title><style>button,a{outline:none}.hero{background:linear-gradient(90deg,#fff,#ddd);padding:40px}.hero p{color:#bbb}.menu ul{display:none}.menu:hover ul{display:block}.wide{width:900px}</style></head><body>
<div class="hero"><p>Light text on a light gradient</p></div><p style="color:#aaa">Faint text</p><img src="x.png"><div onclick="alert(1)">Book now</div>
<button><svg width="16" height="16"></svg></button><a href="/a">A link</a><input placeholder="Email"><nav class="menu">Menu<ul><li><a href="/b">B</a></li></ul></nav>
<div id="slides"><span>1</span></div><div class="wide">wide</div><script>let i=0;setInterval(()=>{document.querySelector('#slides span').textContent=++i},700)</script></body></html>`);
  writeFileSync(join(d, 'good.html'), `<!doctype html><html lang="en"><head><title>Good</title><style>body{font:18px system-ui;color:#222}a,button{display:inline-block;padding:12px}:focus-visible{outline:3px solid #0050b3;outline-offset:2px}</style></head><body><main><h1>Hello</h1><p>Plain readable text.</p><img src="x.png" alt="A thing"><p><a href="/a">Read more about it</a></p><label for="e">Email</label> <input id="e" style="padding:10px"><button>Send</button></main></body></html>`);
  const bad = await a11yCheck(join(d, 'bad.html'), { out: join(d, 'bad') });
  const good = await a11yCheck(join(d, 'good.html'), { out: join(d, 'good') });
  const rules = new Set(bad.issues.map((i) => i.rule));
  for (const r of ['lang', 'img-alt', 'keyboard', 'name', 'placeholder-label', 'hover-only', 'contrast', 'contrast-image', 'focus-visible', 'auto-motion', 'reflow']) if (!rules.has(r)) throw new Error('bad page missed ' + r + ': ' + [...rules]);
  if (!good.ok) throw new Error('good page flagged: ' + JSON.stringify(good.issues));
  console.log(`a11y-check: all tests pass (bad ${bad.score}, good ${good.score})`);
}

if (typeof process !== 'undefined' && process.argv?.[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
  const VALUED = new Set(['--out', '--root']);
  const target = argv.find((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1]));
  if (argv.includes('--test')) selfTest().catch((e) => { console.error(e); process.exit(1); });
  else if (!target) { console.error('usage: a11y-check.mjs <index.html | folder | https://…> [--out a11y] [--root dir]'); process.exit(2); }
  else a11yCheck(target, { out: opt('out', 'a11y'), root: opt('root') }).then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); }, (e) => { console.error(String(e.stack || e)); process.exit(2); });
}
