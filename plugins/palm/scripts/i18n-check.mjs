#!/usr/bin/env node
// Palm tool: i18n-check — lets an agent see a translated site the way its readers will: every page in every language,
// on a phone (390 px) and a desktop (1280 px), side by side with the original, with the problems boxed. German runs
// about a third longer than English and Japanese breaks lines without spaces, so a layout that fits in English can
// clip a button, truncate a menu item or push the page wider than the phone. It measures what can be measured:
// text clipped, cut off with "…" or spilling out of its box; the page wider than the screen; buttons that wrap to
// three lines; <html lang> missing or wrong (Chrome then sets Japanese partly in a Chinese font: measured from the
// fonts Chrome actually used); hreflang alternates; text, titles, descriptions, alt text and labels left untranslated;
// dates and numbers still in English format.
// adds: tool. Runs on the user's machine with their Chrome/Edge/Chromium; nothing leaves it.
//
//   node i18n-check.mjs check <site folder> [--locales de,ja] [--pages index.html,pricing.html] [--out look/i18n]
//       → JSON {ok, errors, warnings, source, locales, pages, issues, sheet}. Then LOOK at the sheet.
//   node i18n-check.mjs --test
//
// The original pages are the .html files at the top of the folder; each language is a subfolder named by its
// language code (de/, ja/, fr/, pt-br/ …) holding the same file names. --locales and --pages override what it finds.
//
// Sources: <html lang> and the lang attribute, https://html.spec.whatwg.org/multipage/dom.html#the-lang-and-xml:lang-attributes;
// hreflang alternates, https://developers.google.com/search/docs/specialty/international/localized-versions. The font
// check reads the fonts Chrome used (CSS.getPlatformFontsForNode). Palm's guidance, not a standard: a button wrapping
// to three or more lines, and dates or numbers left in English format, are warnings.

import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, extname } from 'node:path';
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
const launch = () => loadPuppeteer().launch({ executablePath: findChrome(), headless: true, timeout: 90000, protocolTimeout: 120000, args: ['--no-sandbox', '--hide-scrollbars'] });

export const VIEWS = { phone: { width: 390, height: 844, label: 'phone 390 px' }, desktop: { width: 1280, height: 800, label: 'desktop 1280 px' } };
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon', '.json': 'application/json' };
function serve(root) {
  const s = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html';
    const f = join(root, p);
    if (!f.startsWith(root) || !existsSync(f) || statSync(f).isDirectory()) { r.writeHead(404); return r.end(); }
    r.writeHead(200, { 'content-type': TYPES[extname(f).toLowerCase()] || 'application/octet-stream' }); r.end(readFileSync(f));
  });
  return new Promise((ok) => s.listen(0, '127.0.0.1', () => ok(s)));
}

// Fonts that set Chinese glyph shapes (wrong for Japanese) and Japanese ones (wrong for Chinese).
const ZH_FONTS = /PingFang|蘋方|苹方|Heiti|黑体|STHeiti|STSong|Songti|YaHei|SimSun|SimHei|Noto Sans (SC|TC|HK)|Noto Serif (SC|TC)|Source Han Sans (SC|TC|CN)|Hiragino Sans GB|Lantinghei/i;
const JA_FONTS = /Hiragino (Kaku|Mincho|Maru|Sans)(?! GB)|ヒラギノ|Yu Gothic|YuGothic|Yu Mincho|游ゴシック|Meiryo|メイリオ|MS (P)?Gothic|Noto Sans JP|Noto Serif JP|Source Han Sans (JP)?$|Osaka/i;
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;
const MONTHS = /\b(January|February|March|April|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.? \d{1,2}(st|nd|rd|th)?\b|\b\d{1,2}(st|nd|rd|th) (of )?(January|February|March|April|May|June|July|August|September|October|November|December)\b/;

// Runs in the page: measures every element that holds text.
const MEASURE = () => {
  const out = { lang: document.documentElement.getAttribute('lang'), dir: document.documentElement.getAttribute('dir'), title: document.title.trim(),
    desc: (document.querySelector('meta[name="description"]')?.getAttribute('content') || '').trim(),
    hreflang: [...document.querySelectorAll('link[rel="alternate"][hreflang]')].map((l) => ({ lang: l.getAttribute('hreflang'), href: l.getAttribute('href') })),
    vw: innerWidth, pageW: document.scrollingElement.scrollWidth, problems: [], strings: [], wide: [] };
  const sel = (el) => { let s = el.tagName.toLowerCase(); if (el.id) s += '#' + el.id; else if (el.classList.length) s += '.' + [...el.classList].slice(0, 2).join('.'); const p = el.parentElement; return p && p !== document.body ? (p.tagName.toLowerCase() + (p.classList.length ? '.' + p.classList[0] : '') + ' > ' + s) : s; };
  const vis = (el) => { const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const txt = (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ').replace(/\s+/g, ' ').trim();
  const box = (r) => ({ x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) });
  const lines = (el) => { const rg = document.createRange(); rg.selectNodeContents(el); const tops = new Set([...rg.getClientRects()].filter((r) => r.width > 1).map((r) => Math.round(r.top / 4))); return tops.size; };
  for (const el of document.body.querySelectorAll('*')) {
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'svg'].includes(el.tagName) || el.closest('svg')) continue;
    if (!vis(el)) continue;
    const cs = getComputedStyle(el), r = el.getBoundingClientRect(), t = txt(el);
    if (r.right > innerWidth + 1 && cs.position !== 'fixed' && r.width <= innerWidth * 3) out.wide.push({ sel: sel(el), right: Math.round(r.right), box: box(r) });
    if (!t && !el.querySelector(':scope > *') && !['IMG', 'INPUT'].includes(el.tagName)) continue;
    for (const a of ['alt', 'title', 'aria-label', 'placeholder']) { const v = el.getAttribute(a); if (v && v.trim()) out.strings.push({ kind: a, s: v.trim() }); }
    if ((el.tagName === 'INPUT' && /^(submit|button)$/i.test(el.type)) && el.value) out.strings.push({ kind: 'text', s: el.value.trim() });
    if (!t) continue;
    out.strings.push({ kind: 'text', s: t });
    const hiddenX = /hidden|clip/.test(cs.overflowX), hiddenY = /hidden|clip/.test(cs.overflowY);
    if (cs.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1) out.problems.push({ id: 'text-truncated', sel: sel(el), text: t.slice(0, 60), box: box(r) });
    else if (hiddenX && el.scrollWidth > el.clientWidth + 1) out.problems.push({ id: 'text-clipped', sel: sel(el), text: t.slice(0, 60), box: box(r), by: el.scrollWidth - el.clientWidth });
    else if (hiddenY && el.scrollHeight > el.clientHeight + 2 && cs.webkitLineClamp === 'none') out.problems.push({ id: 'text-clipped', sel: sel(el), text: t.slice(0, 60), box: box(r), by: el.scrollHeight - el.clientHeight });
    else {
      // text spilling out of its own box (a fixed width or height with visible overflow)
      const rg = document.createRange(); rg.selectNodeContents(el); const tr = rg.getBoundingClientRect();
      const fixed = cs.width.endsWith('px') && (el.style.width || /inline-block|block|flex/.test(cs.display));
      if (tr.width > 1 && (tr.right > r.right + 3 || tr.left < r.left - 3 || tr.bottom > r.bottom + 3) && (cs.borderStyle !== 'none' || cs.backgroundColor !== 'rgba(0, 0, 0, 0)' || fixed))
        out.problems.push({ id: 'text-spills', sel: sel(el), text: t.slice(0, 60), box: box(tr) });
    }
    const isBtn = el.matches('button, [role="button"], input[type="submit"], a.btn, a.button, a[class*="btn"], a[class*="button"], a[class*="cta"]');
    if (isBtn) { const n = lines(el); if (n >= 3) out.problems.push({ id: 'button-wraps', sel: sel(el), text: t.slice(0, 60), box: box(r), lines: n }); }
    else if (el.closest('nav') && el.tagName === 'A') { const n = lines(el); if (n >= 2) out.problems.push({ id: 'nav-wraps', sel: sel(el), text: t.slice(0, 60), box: box(r), lines: n }); }
  }
  return out;
};

const norm = (s) => s.replace(/\s+/g, ' ').trim();
const latinWords = (s) => (s.match(/[A-Za-zÀ-ÿ]{2,}/g) || []).length;

function findLayout(root, locales, pages) {
  const src = pages || readdirSync(root).filter((f) => /\.html?$/i.test(f) && !/^404/.test(f)).sort((a, b) => (a === 'index.html' ? -1 : b === 'index.html' ? 1 : a.localeCompare(b)));
  const locs = locales || readdirSync(root).filter((d) => /^[a-z]{2,3}([-_][a-zA-Z]{2,4})?$/.test(d) && statSync(join(root, d)).isDirectory() && src.some((p) => existsSync(join(root, d, p))));
  return { src, locs };
}

export async function check(target, { locales = null, pages = null, out = 'look/i18n', plain = false } = {}) {
  const root = resolve(target);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error('Give the site folder (the original pages at its top, each language in a subfolder).');
  const { src, locs } = findLayout(root, locales, pages);
  if (!src.length) throw new Error('No .html pages at the top of ' + target);
  if (!locs.length) throw new Error('No language folders found (de/, ja/ …) holding the same pages. Use --locales.');
  mkdirSync(resolve(out, '..'), { recursive: true });
  const server = await serve(root), base = `http://127.0.0.1:${server.address().port}`;
  const browser = await launch();
  const issues = [], results = {}, shots = {};
  const add = (level, id, page, locale, view, msg, extra = {}) => issues.push({ level, id, page, locale, view, msg, ...extra });
  try {
    for (const page of src) {
      results[page] = {};
      for (const loc of ['', ...locs]) {
        const rel = loc ? `${loc}/${page}` : page;
        const key = loc || 'source';
        if (!existsSync(join(root, rel))) { if (loc) add('error', 'page-missing', page, loc, null, `${rel} doesn't exist: the ${loc} site has no ${page}.`); continue; }
        results[page][key] = {};
        for (const [vname, v] of Object.entries(VIEWS)) {
          const p = await browser.newPage();
          await p.setViewport({ width: v.width, height: v.height, deviceScaleFactor: 1 });
          try { await p.goto(`${base}/${rel}`, { waitUntil: 'networkidle0', timeout: 45000 }); } catch (e) { if (!/timeout/i.test(String(e))) throw e; }
          await p.evaluate(() => document.fonts?.ready);
          const m = await p.evaluate(MEASURE);
          // the fonts Chrome used for CJK text (only once, on the phone view)
          if (vname === 'phone' && CJK.test(m.strings.map((s) => s.s).join(''))) {
            const c = await p.target().createCDPSession(); await c.send('DOM.enable'); await c.send('CSS.enable');
            const doc = await c.send('DOM.getDocument', { depth: -1 });
            const { nodeIds } = await c.send('DOM.querySelectorAll', { nodeId: doc.root.nodeId, selector: 'body *' });
            const fams = new Map();
            for (const id of nodeIds.slice(0, 400)) {
              try { const f = await c.send('CSS.getPlatformFontsForNode', { nodeId: id }); for (const x of f.fonts) fams.set(x.familyName, (fams.get(x.familyName) || 0) + x.glyphCount); } catch { /* not a text node */ }
            }
            m.fonts = Object.fromEntries([...fams].sort((a, b) => b[1] - a[1]));
          }
          const full = Math.min(await p.evaluate(() => document.scrollingElement.scrollHeight), vname === 'phone' ? 3000 : 2000);
          await p.setViewport({ width: v.width, height: full, deviceScaleFactor: 1 });
          shots[`${page}|${key}|${vname}`] = Buffer.from(await p.screenshot({ type: 'png', clip: { x: 0, y: 0, width: Math.max(v.width, Math.min(m.pageW, v.width * 1.6)), height: full } })).toString('base64');
          m.shotW = Math.max(v.width, Math.min(m.pageW, v.width * 1.6)); m.shotH = full;
          results[page][key][vname] = m;
          await p.close();
        }
      }
      // judge each locale against the source
      const S = results[page].source;
      for (const loc of locs) {
        const L = results[page][loc]; if (!L) continue;
        const ph = L.phone, primary = (ph.lang || '').toLowerCase().split(/[-_]/)[0], want = loc.toLowerCase().split(/[-_]/)[0];
        if (!ph.lang) add('error', 'lang-missing', page, loc, null, `${loc}/${page} has no <html lang>. Browsers, screen readers and search engines then treat it as unknown${CJK.test(ph.title + ph.strings.map((s) => s.s).join('')) ? '; Chrome sets Japanese/Chinese text in whichever CJK font it guesses' : ''}. Add lang="${loc}".`);
        else if (primary !== want) add('error', 'lang-wrong', page, loc, null, `${loc}/${page} says <html lang="${ph.lang}"> but it's in ${loc}. Set lang="${loc}".`);
        if (ph.fonts) {
          const names = Object.keys(ph.fonts), zh = names.filter((n) => ZH_FONTS.test(n)), ja = names.filter((n) => JA_FONTS.test(n));
          if (want === 'ja' && zh.length) add('error', 'cjk-wrong-font', page, loc, 'phone', `Japanese text on ${loc}/${page} is partly set in a Chinese font (${zh.join(', ')}; ${zh.reduce((a, n) => a + ph.fonts[n], 0)} glyphs), so some kanji take Chinese shapes. Chrome used: ${names.join(', ')}. Usually lang is missing or wrong; or name a Japanese font in font-family.`);
          if (/^zh/.test(want) && ja.length) add('error', 'cjk-wrong-font', page, loc, 'phone', `Chinese text on ${loc}/${page} is partly set in a Japanese font (${ja.join(', ')}). Set lang="${loc}" or name a Chinese font.`);
        }
        const others = locs.filter((x) => x !== loc);
        const hl = new Set(ph.hreflang.map((h) => h.lang.toLowerCase().split(/[-_]/)[0]));
        const missingHl = [...['en', ...locs].map((x) => x.toLowerCase().split(/[-_]/)[0])].filter((x) => !hl.has(x));
        if (missingHl.length) add('warn', 'hreflang-missing', page, loc, null, `${loc}/${page} doesn't list its other languages as <link rel="alternate" hreflang> (missing: ${missingHl.join(', ')}), so search engines may show the wrong language.`);
        // untranslated: same as the original, unless every other language kept it too (a name)
        const srcSet = new Set(S.phone.strings.map((s) => norm(s.s)));
        const keptEverywhere = (s) => others.length > 0 && others.every((o) => (results[page][o]?.phone.strings || []).some((x) => norm(x.s) === s));
        const same = (kind, s) => { s = norm(s); return s && srcSet.has(s) && latinWords(s) >= 2 && s.length >= 8 && !/^[\w.+-]+@[\w.-]+$|^https?:/.test(s) && !keptEverywhere(s); };
        if (ph.title && ph.title === S.phone.title && !keptEverywhere(ph.title)) add('error', 'untranslated', page, loc, null, `The <title> of ${loc}/${page} is still in the original language: "${ph.title}".`);
        if (ph.desc && ph.desc === S.phone.desc) add('error', 'untranslated', page, loc, null, `The meta description of ${loc}/${page} is still in the original language.`);
        const attr = [...new Set(ph.strings.filter((x) => x.kind !== 'text' && same(x.kind, x.s)).map((x) => `${x.kind}="${norm(x.s).slice(0, 50)}"`))];
        if (attr.length) add('error', 'untranslated', page, loc, null, `${attr.length} alt text/label${attr.length > 1 ? 's' : ''} on ${loc}/${page} left in the original language: ${attr.slice(0, 4).join('; ')}. Screen readers read them out.`);
        const vis = [...new Set(ph.strings.filter((x) => x.kind === 'text' && same('text', x.s)).map((x) => norm(x.s).slice(0, 50)))];
        if (vis.length) add('warn', 'untranslated', page, loc, null, `${vis.length} piece${vis.length > 1 ? 's' : ''} of visible text on ${loc}/${page} are the same as the original: ${vis.slice(0, 5).map((s) => `"${s}"`).join(', ')}. Translate them unless they're names.`);
        const body = ph.strings.filter((x) => x.kind === 'text').map((x) => x.s).join(' \n ');
        if (want !== 'en' && MONTHS.test(body)) add('warn', 'date-format', page, loc, null, `${loc}/${page} still writes a date the English way ("${body.match(MONTHS)[0]}"). Use the ${loc} format.`);
        if (/^(de|fr|es|it|pt|nl|sv|da|nb|fi|pl|cs|tr|ru)$/.test(want)) { const n = body.match(/\b\d{1,3}(,\d{3})+(\.\d+)?\b|\b\d+\.\d{2}\b(?!\s*%)/); if (n) add('warn', 'number-format', page, loc, null, `${loc}/${page} writes "${n[0]}" in English number format; ${loc} uses a decimal comma (and a space or point for thousands).`); }
        for (const [vname, m] of Object.entries(L)) {
          const sm = S[vname];
          if (m.pageW > m.vw + 1 && !(sm.pageW > sm.vw + 1)) { const w = m.wide.sort((a, b) => b.right - a.right)[0]; add('error', 'page-too-wide', page, loc, vname, `On a ${VIEWS[vname].label} ${loc}/${page} is ${m.pageW} px wide, so it scrolls sideways${w ? `: ${w.sel} reaches ${w.right} px` : ''}. The original fits.`, { box: w?.box }); }
          const srcKeys = new Set(sm.problems.map((x) => `${x.id}|${x.sel}`));
          for (const pr of m.problems) {
            if (srcKeys.has(`${pr.id}|${pr.sel}`)) continue; // already so in the original
            const lvl = pr.id === 'nav-wraps' || pr.id === 'button-wraps' ? 'warn' : 'error';
            const what = { 'text-truncated': 'is cut off with "…"', 'text-clipped': `is clipped (${pr.by} px hidden)`, 'text-spills': 'spills out of its box', 'button-wraps': `wraps to ${pr.lines} lines`, 'nav-wraps': `wraps to ${pr.lines} lines in the menu` }[pr.id];
            add(lvl, pr.id, page, loc, vname, `On a ${VIEWS[vname].label}, "${pr.text}" (${pr.sel}) on ${loc}/${page} ${what}.`, { box: pr.box });
          }
        }
      }
    }
    // the sheet: per page, the original and each language, phone and desktop, problems boxed
    const sheet = resolve(out + '-sheet.png');
    const rows = src.map((page) => {
      const cols = ['source', ...locs].filter((k) => results[page][k]).map((key) => {
        const v = (vname, w) => { const m = results[page][key][vname]; const s = shots[`${page}|${key}|${vname}`]; const k = w / VIEWS[vname].width;
          const marks = plain ? '' : issues.filter((i) => i.page === page && i.locale === key && i.view === vname && i.box).map((i) => `<div style="position:absolute;left:${i.box.x * k}px;top:${i.box.y * k}px;width:${Math.max(6, i.box.w * k)}px;height:${Math.max(6, i.box.h * k)}px;outline:3px solid ${i.level === 'error' ? '#e0103a' : '#f5a000'}"></div>`).join('');
          return `<div class="v"><div class="lab">${VIEWS[vname].label}</div><div class="frame" style="width:${w}px;height:${Math.min(m.shotH * k, vname === 'phone' ? 1500 : 900)}px"><img src="data:image/png;base64,${s}" style="width:${m.shotW * k}px;display:block">${marks}</div></div>`; };
        return `<div class="col"><h3>${key === 'source' ? 'Original' : key}${key !== 'source' ? '' : ''}</h3><div class="pair">${v('phone', 300)}${v('desktop', 560)}</div></div>`;
      }).join('');
      return `<h2>${page}</h2><div class="row">${cols}</div>`;
    }).join('');
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:24px;background:#ecebe8;font:14px/1.4 -apple-system,Helvetica,Arial,sans-serif;color:#222}h2{font:600 13px/1 -apple-system,Helvetica;letter-spacing:.08em;text-transform:uppercase;color:#555;margin:26px 0 10px}h3{margin:0 0 8px;font:600 15px -apple-system,Helvetica}.row{display:flex;gap:28px;align-items:flex-start}.col{background:#fff;padding:14px;border-radius:10px}.pair{display:flex;gap:14px;align-items:flex-start}.lab{font-size:11px;color:#777;margin-bottom:4px}.frame{position:relative;overflow:hidden;border:1px solid #ccc;background:#fff}</style></head><body>${rows}</body></html>`;
    const sp = await browser.newPage(); await sp.setViewport({ width: 400 + (locs.length + 1) * 920, height: 1000, deviceScaleFactor: 1 });
    await sp.setContent(html, { waitUntil: 'load' }); await new Promise((r) => setTimeout(r, 300));
    await sp.screenshot({ path: sheet, fullPage: true });
    const errors = issues.filter((i) => i.level === 'error').length, warnings = issues.filter((i) => i.level === 'warn').length;
    const summary = Object.fromEntries(src.map((page) => [page, Object.fromEntries(Object.entries(results[page]).map(([k, r]) => [k, { lang: r.phone.lang, page_width: { phone: r.phone.pageW, desktop: r.desktop.pageW }, fonts: r.phone.fonts ? Object.keys(r.phone.fonts) : undefined }]))]));
    return { ok: errors === 0, errors, warnings, source: src, locales: locs, pages: summary, issues: issues.map(({ box, ...i }) => i), sheet };
  } finally { await browser.close(); server.close(); }
}

// ---------- self-test ----------
async function selfTest() {
  const d = mkdtempSync(join(tmpdir(), 'i18n-test-'));
  const css = `body{font-family:Helvetica,Arial,sans-serif;margin:0}nav{display:flex;gap:16px;padding:12px;white-space:nowrap}.btn{display:inline-block;width:150px;padding:10px;background:#0a6;color:#fff;overflow:hidden;white-space:nowrap}.tag{display:inline-block;width:110px;text-overflow:ellipsis;overflow:hidden;white-space:nowrap;background:#eee}.card{width:300px;padding:12px}`;
  writeFileSync(join(d, 'style.css'), css);
  const page = (lang, t) => `<!doctype html><html${lang ? ` lang="${lang}"` : ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${t.title}</title><meta name="description" content="${t.desc}"><link rel="stylesheet" href="/style.css"></head><body><nav><a href="#">${t.nav[0]}</a><a href="#">${t.nav[1]}</a><a href="#">${t.nav[2]}</a></nav><main class="card"><h1>${t.h1}</h1><p>${t.p}</p><img src="/x.png" alt="${t.alt}" width="10" height="10"><a class="btn" href="#">${t.btn}</a> <span class="tag">${t.tag}</span><p>${t.date}</p></main></body></html>`;
  const en = { title: 'Tidepool: book a table', desc: 'Book a table at Tidepool in two taps.', nav: ['Home', 'Menu', 'Book'], h1: 'Book a table', p: 'Choose a time that suits you.', alt: 'The dining room at night', btn: 'Book now', tag: 'Popular', date: 'Updated March 3, 2026 · from $12.50' };
  writeFileSync(join(d, 'index.html'), page('en', en));
  mkdirSync(join(d, 'de')); mkdirSync(join(d, 'ja'));
  // German: long words clip the fixed-width button and truncate the tag; alt text and title left in English; English date
  writeFileSync(join(d, 'de/index.html'), page('de', { ...en, desc: 'Reservieren Sie einen Tisch.', nav: ['Startseite', 'Speisekarte', 'Reservieren'], h1: 'Tisch reservieren', p: 'Wählen Sie eine passende Uhrzeit.', btn: 'Jetzt verbindlich reservieren', tag: 'Besonders beliebt', date: 'Aktualisiert March 3, 2026 · ab $12.50' }));
  // Japanese with lang="en" copied from the original: Chrome mixes in a Chinese font
  writeFileSync(join(d, 'ja/index.html'), page('en', { title: 'タイドプール：席の予約', desc: '2タップで席を予約できます。', nav: ['ホーム', 'メニュー', '予約'], h1: '席を予約する', p: 'ご都合の良い時間を選択してください。直角。', alt: '夜のダイニングルーム', btn: '今すぐ予約', tag: '人気', date: '2026年3月3日更新 · 12.50ドルから' }));
  const r = await check(d, { out: join(d, 'look/bad') });
  const got = new Set(r.issues.map((i) => `${i.locale}:${i.id}`));
  for (const want of ['de:text-clipped', 'de:text-truncated', 'de:untranslated', 'de:date-format', 'de:number-format', 'ja:lang-wrong', 'ja:cjk-wrong-font']) if (!got.has(want)) throw new Error(`bad site: expected ${want}, got ${[...got].join(', ')}`);
  if (!existsSync(r.sheet)) throw new Error('no sheet');
  // fixed: flexible widths, wrapping, lang set, everything translated, hreflang, local formats
  const css2 = css.replace('width:150px;padding:10px;background:#0a6;color:#fff;overflow:hidden;white-space:nowrap', 'max-width:100%;padding:10px;background:#0a6;color:#fff').replace('width:110px;text-overflow:ellipsis;overflow:hidden;white-space:nowrap;', '').replace('white-space:nowrap}', 'flex-wrap:wrap}');
  writeFileSync(join(d, 'style.css'), css2);
  const hl = '<link rel="alternate" hreflang="en" href="/"><link rel="alternate" hreflang="de" href="/de/"><link rel="alternate" hreflang="ja" href="/ja/">';
  const fix = (f) => writeFileSync(f, readFileSync(f, 'utf8').replace('</title>', '</title>' + hl));
  writeFileSync(join(d, 'de/index.html'), page('de', { title: 'Tidepool: Tisch reservieren', desc: 'Reservieren Sie einen Tisch.', nav: ['Startseite', 'Speisekarte', 'Reservieren'], h1: 'Tisch reservieren', p: 'Wählen Sie eine passende Uhrzeit.', alt: 'Der Speisesaal am Abend', btn: 'Jetzt verbindlich reservieren', tag: 'Besonders beliebt', date: 'Aktualisiert am 3. März 2026 · ab 12,50 $' }));
  writeFileSync(join(d, 'ja/index.html'), page('ja', { title: 'タイドプール：席の予約', desc: '2タップで席を予約できます。', nav: ['ホーム', 'メニュー', '予約'], h1: '席を予約する', p: 'ご都合の良い時間を選択してください。直角。', alt: '夜のダイニングルーム', btn: '今すぐ予約', tag: '人気', date: '2026年3月3日更新 · 12.50ドルから' }));
  for (const f of ['index.html', 'de/index.html', 'ja/index.html']) fix(join(d, f));
  const g = await check(d, { out: join(d, 'look/good') });
  if (g.errors) throw new Error('fixed site flagged: ' + g.issues.filter((i) => i.level === 'error').map((i) => `${i.locale}:${i.id} ${i.msg}`).join(' | '));
  console.log(`i18n-check: all tests pass (bad: ${[...got].join(', ')}; fixed: ${g.warnings} warnings; ja fonts ${g.pages['index.html'].ja.fonts?.join(', ')})`);
}

if (typeof process !== 'undefined' && process.argv?.[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
  const VALUED = new Set(['--out', '--locales', '--pages']);
  const pos = argv.filter((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1]));
  const done = (r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); };
  const fail = (e) => { console.error(String(e.message || e)); process.exit(2); };
  if (argv.includes('--test')) selfTest().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
  else if (pos[0] === 'check' && pos[1]) check(pos[1], { locales: opt('locales') ? opt('locales').split(',') : null, pages: opt('pages') ? opt('pages').split(',') : null, out: opt('out', 'look/i18n') }).then(done, fail);
  else fail('usage: i18n-check.mjs check <site folder> [--locales de,ja] [--pages index.html,pricing.html] [--out look/i18n]\n       i18n-check.mjs --test');
}
