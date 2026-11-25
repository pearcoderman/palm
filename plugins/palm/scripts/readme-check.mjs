#!/usr/bin/env node
// Palm tool: readme-check — lets an agent see a README the way GitHub shows it: rendered by GitHub's own Markdown
// renderer, in GitHub's light and dark themes, on a desktop and on a phone, with every image and link checked against
// the repository. A README breaks in places you can't see while writing it on a Mac: a logo or diagram drawn dark on a
// transparent background disappears in dark mode; `Assets/logo.png` works on macOS (case-insensitive) and is a broken
// image on GitHub; `<style>`, `<script>` and `<iframe>` are shown as raw text; a heading level is skipped; a code block
// has no language; an image has no alt text; a wide table or line of code runs off a phone.
// It measures what can be measured: relative images and links resolved case-sensitively (anchors against the
// headings), each image's visible pixels against GitHub's light and dark page in the theme it's actually shown in
// (`<picture>` with prefers-color-scheme, `#gh-dark-mode-only`), image and README sizes, absolute images that don't
// load, tags GitHub escapes, heading order, code fences without a language, alt text, and sideways scrolling on a phone.
// adds: tool. Runs on the user's machine with their Chrome/Edge/Chromium. The README's Markdown is sent to GitHub's
// public Markdown API (api.github.com/markdown) to render it exactly; --offline renders it locally (markdown-it, if
// installed) and approximates GitHub's escaping.
//
//   node readme-check.mjs check <repo folder> [--readme README.md] [--out look/readme] [--offline]
//       → JSON {ok, errors, warnings, renderer, images, issues, sheet}. Then LOOK at the sheet.
//   node readme-check.mjs --test
//
// Sources (GitHub's own pages, read 2026-11-25):
//   - Relative links and image paths are relative to the current file; links starting with / are relative to the
//     repository root: https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax#relative-links
//   - The <picture> element is supported (same page). Theme-specific images with <picture> + prefers-color-scheme:
//     https://github.blog/changelog/2022-08-15-specify-theme-context-for-images-in-markdown-ga/
//   - README content beyond 500 KiB is truncated: https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes
//   - Social preview: under 1 MB, at least 640×320, 1280×640 for best display:
//     https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview
//   - Non-text contrast 3:1, WCAG 2.2 SC 1.4.11: https://www.w3.org/TR/WCAG22/#non-text-contrast; alt text, SC 1.1.1.
// Palm's guidance, not GitHub's rules (warnings): an image fainter than 3:1 against a theme's page; images over 1 MB;
// a skipped heading level; a fence without a language (no highlighting); install/usage not near the top; a table or
// code line that scrolls sideways on a 390 px phone. GitHub's page colours (#ffffff light, #0d1117 dark) are Palm's
// reading of github.com, not a published spec.

import { readFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, extname, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import http from 'node:http';

const here = dirname(fileURLToPath(import.meta.url));
function loadModule(name) {
  for (const base of [process.env.PALM_NODE_MODULES, here, join(here, '..'), process.cwd(), join(here, '../../yz-hd-tools'), join(here, '../../src')].filter(Boolean)) {
    try { return createRequire(join(base, 'x.js'))(name); } catch { /* next */ }
  }
  return null;
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
function launch() {
  const pup = loadModule('puppeteer-core');
  if (!pup) throw new Error('puppeteer-core is not installed. Run: npm i puppeteer-core');
  return pup.launch({ executablePath: findChrome(), headless: true, timeout: 90000, protocolTimeout: 180000, args: ['--no-sandbox', '--hide-scrollbars'] });
}

export const THEMES = { light: { bg: '#ffffff', fg: '#1f2328', muted: '#59636e', border: '#d1d9e0', code: '#f6f8fa', link: '#0969da', rgb: [255, 255, 255] }, dark: { bg: '#0d1117', fg: '#f0f6fc', muted: '#9198a1', border: '#3d444d', code: '#151b23', link: '#4493f8', rgb: [13, 17, 23] } };
// Whole README, not just the top (a 2,600 px cut favoured shorter READMEs: 25 Nov eval). Phone at 1.5× keeps a
// 9,000 px page under Chrome's 16,384 px screenshot limit.
export const VIEWS = { desktop: { width: 1280, height: 900, cap: 9000, scale: 1, label: 'desktop' }, phone: { width: 390, height: 844, cap: 9000, scale: 1.5, label: 'phone 390 px' } };
export const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
export const ratio = (a, b) => { const [x, y] = a > b ? [a, b] : [b, a]; return (x + 0.05) / (y + 0.05); };
// Tags GitHub's sanitizer shows as text instead of running (seen in its renderer's output).
const ESCAPED = ['style', 'script', 'iframe', 'object', 'embed', 'form', 'input', 'textarea', 'button', 'select', 'link', 'meta', 'base', 'svg'];
const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.html': 'text/html; charset=utf-8' };

// GitHub's heading anchors: lowercase, punctuation dropped (hyphens and underscores kept), spaces to hyphens, -1, -2 for repeats.
export function slug(text, seen = new Map()) {
  let s = String(text).trim().toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
  const n = seen.get(s) || 0; seen.set(s, n + 1);
  return n ? `${s}-${n}` : s;
}

async function renderGithub(md) {
  const key = createHash('sha256').update(md).digest('hex').slice(0, 24);
  const cdir = join(tmpdir(), 'palm-readme-cache'); mkdirSync(cdir, { recursive: true });
  const cf = join(cdir, key + '.html');
  if (existsSync(cf)) return readFileSync(cf, 'utf8');
  const r = await fetch('https://api.github.com/markdown', { method: 'POST', headers: { accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'palm-readme-check' }, body: JSON.stringify({ text: md, mode: 'markdown' }), signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`GitHub's Markdown API answered ${r.status}${r.status === 403 ? ' (rate limit: 60 renders an hour without a token)' : ''}`);
  const h = await r.text(); writeFileSync(cf, h); return h;
}
function renderLocal(md) {
  const MarkdownIt = loadModule('markdown-it');
  if (!MarkdownIt) throw new Error('Offline rendering needs markdown-it (npm i markdown-it), or run without --offline to use GitHub\'s renderer.');
  let h = new MarkdownIt({ html: true, linkify: true }).render(md);
  // Approximate GitHub's sanitizer: these tags are shown as text.
  const re = new RegExp(`<(/?)(${ESCAPED.join('|')})\\b([^>]*)>`, 'gi');
  h = h.replace(re, (m) => m.replace(/</g, '&lt;').replace(/>/g, '&gt;'));
  return h;
}

function listCase(dir) { try { return readdirSync(dir); } catch { return null; } }
// Does this path exist with exactly this case, as on GitHub (macOS's disk ignores case)?
function existsExact(root, rel) {
  const parts = rel.split('/').filter((p) => p && p !== '.');
  let cur = root, wrongCase = false;
  for (const p of parts) {
    if (p === '..') { cur = dirname(cur); continue; }
    const names = listCase(cur);
    if (!names) return { ok: false };
    if (names.includes(p)) { cur = join(cur, p); continue; }
    const near = names.find((n) => n.toLowerCase() === p.toLowerCase());
    if (!near) return { ok: false };
    wrongCase = true; cur = join(cur, near);
  }
  if (wrongCase) return { ok: false, caseOnly: existsSync(cur) ? relative(root, cur).split(sep).join('/') : null };
  return { ok: existsSync(cur), file: cur, dir: existsSync(cur) && statSync(cur).isDirectory() };
}
function resolveRel(root, readmeDir, url) {
  const clean = decodeURIComponent(url.split('#')[0].split('?')[0]);
  if (!clean) return null;
  const abs = clean.startsWith('/') ? join(root, clean) : resolve(readmeDir, clean);
  const rel = relative(root, abs).split(sep).join('/');
  return rel.startsWith('..') ? { outside: true, rel } : { rel };
}
const isAbs = (u) => /^[a-z][a-z0-9+.-]*:/i.test(u) || u.startsWith('//');

function pngSize(buf) { return buf.length > 24 && buf.toString('ascii', 1, 4) === 'PNG' ? { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) } : null; }

function pageHtml(body, theme, repoName) {
  const t = THEMES[theme];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="${theme}">
<style>
*{box-sizing:border-box}body{margin:0;background:${t.bg};color:${t.fg};font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif}
.top{border-bottom:1px solid ${t.border};padding:16px 24px;font-size:20px;color:${t.fg}}.top b{font-weight:600}
.wrap{max-width:1012px;margin:24px auto;padding:0 16px}.box{border:1px solid ${t.border};border-radius:6px}.box-h{padding:8px 16px;border-bottom:1px solid ${t.border};font-size:14px;font-weight:600}
.markdown-body{padding:32px;word-wrap:break-word}@media (max-width:600px){.wrap{margin:12px auto;padding:0 8px}.markdown-body{padding:16px}.top{padding:12px 16px}}
.markdown-body h1,.markdown-body h2{padding-bottom:.3em;border-bottom:1px solid ${t.border}}.markdown-body h1{font-size:2em;margin:.67em 0}.markdown-body h2{font-size:1.5em;margin:24px 0 16px}.markdown-body h3{font-size:1.25em;margin:24px 0 16px}
.markdown-body h1,.markdown-body h2,.markdown-body h3,.markdown-body h4{font-weight:600;line-height:1.25}
.markdown-body a{color:${t.link};text-decoration:none}.markdown-body p,.markdown-body ul,.markdown-body ol,.markdown-body table,.markdown-body pre,.markdown-body blockquote{margin:0 0 16px}
.markdown-body img{max-width:100%;box-sizing:content-box;background:${t.bg}}
.markdown-body code{font:85% ui-monospace,SFMono-Regular,Menlo,monospace;background:${t.code};padding:.2em .4em;border-radius:6px}
.markdown-body pre{background:${t.code};padding:16px;border-radius:6px;overflow:auto;font:85%/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}.markdown-body pre code{background:none;padding:0;font-size:100%}
.markdown-body table{display:block;width:max-content;max-width:100%;overflow:auto;border-spacing:0;border-collapse:collapse}.markdown-body td,.markdown-body th{padding:6px 13px;border:1px solid ${t.border}}.markdown-body th{font-weight:600}
.markdown-body blockquote{padding:0 1em;color:${t.muted};border-left:.25em solid ${t.border}}
.markdown-body hr{height:.25em;background:${t.border};border:0;margin:24px 0}
${theme === 'dark' ? '.markdown-body img[src$="#gh-light-mode-only"]{display:none}' : '.markdown-body img[src$="#gh-dark-mode-only"]{display:none}'}
</style></head><body><div class="top"><b>${repoName}</b></div><div class="wrap"><div class="box"><div class="box-h">README.md</div><article class="markdown-body">${body}</article></div></div>
<script>/* GitHub's <themed-picture> swaps the image itself (its renderer wraps <img> in a link, so the browser alone never
uses the <source>): pick the source whose media query matches, as github.com does. */
for (const p of document.querySelectorAll('picture')) { const img = p.querySelector('img'); if (!img) continue;
  for (const s of p.querySelectorAll('source')) if (!s.media || matchMedia(s.media).matches) { img.src = s.getAttribute('srcset').split(',')[0].trim().split(' ')[0]; break; } }
</script></body></html>`;
}

export async function check(target, { readme = null, out = 'look/readme', plain = false, offline = false } = {}) {
  const root = resolve(target);
  const rname = readme || (readdirSync(root).find((f) => /^readme\.md$/i.test(f)));
  if (!rname || !existsSync(join(root, rname))) throw new Error(`No README.md in ${root}`);
  const rfile = join(root, rname), rdir = dirname(rfile);
  const md = readFileSync(rfile, 'utf8');
  const issues = []; const add = (id, level, msg, fix, where) => issues.push({ id, level, msg, fix, ...(where ? { where } : {}) });
  const bytes = Buffer.byteLength(md);
  if (bytes > 500 * 1024) add('readme-truncated', 'error', `The README is ${Math.round(bytes / 1024)} KiB; GitHub truncates anything past 500 KiB.`, 'Move long sections into docs/ and link to them.');

  // Render: GitHub's own renderer, or markdown-it offline.
  let html, renderer;
  if (!offline) { try { html = await renderGithub(md); renderer = 'github-api'; } catch (e) { renderer = 'markdown-it (GitHub unreachable: ' + String(e.message).slice(0, 80) + ')'; } }
  if (!html) { html = renderLocal(md); renderer = renderer || 'markdown-it (offline)'; }

  // Source-level checks.
  const lines = md.split('\n'); let inFence = false, fenceN = 0, bare = 0; const heads = [];
  for (const [i, l] of lines.entries()) {
    const f = l.match(/^\s{0,3}(```+|~~~+)\s*([^\s`]*)/);
    if (f) { if (!inFence) { fenceN++; if (!f[2]) bare++; } inFence = !inFence; continue; }
    if (inFence) continue;
    const h = l.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/); if (h) heads.push({ level: h[1].length, text: h[2], line: i + 1 });
  }
  const htmlHeads = [...html.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/g)].map((m) => ({ level: +m[1], text: m[2].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim() }));
  const H = htmlHeads.length ? htmlHeads : heads;
  for (let i = 1; i < H.length; i++) if (H[i].level > H[i - 1].level + 1) add('heading-skip', 'warn', `Heading "${H[i].text.slice(0, 50)}" jumps from h${H[i - 1].level} to h${H[i].level}.`, 'Use the next level down (screen readers list headings by level).');
  if (bare) add('fence-no-language', 'warn', `${bare} of ${fenceN} code block${fenceN === 1 ? '' : 's'} ha${bare === 1 ? 's' : 've'} no language, so GitHub shows ${bare === 1 ? 'it' : 'them'} without highlighting.`, 'Add the language after the opening fence: ```bash, ```js, ```json.');
  const top = H.slice(0, 6).map((h) => h.text).join(' ');
  if (!/install|getting started|quick ?start|usage|setup|get started/i.test(top)) add('install-late', 'warn', 'No "Install", "Usage" or "Quick start" heading near the top.', 'Put how to install and a first command within the first screen or two (Palm\'s guidance).');
  const escaped = new Set(); for (const m of html.matchAll(/&lt;\/?([a-z]+)\b/gi)) if (ESCAPED.includes(m[1].toLowerCase()) && new RegExp(`<${m[1]}\\b`, 'i').test(md.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, ''))) escaped.add(m[1].toLowerCase());
  for (const t of escaped) add('html-escaped', 'error', `GitHub shows the <${t}> tag as text: it doesn't run ${t} in a README.`, t === 'style' ? 'Use Markdown or the attributes GitHub keeps (align, width, height).' : `Remove the <${t}>; link to it instead.`);

  // Links and images in the rendered HTML.
  const anchors = new Set(); { const seen = new Map(); for (const h of H) anchors.add(slug(h.text, seen)); }
  for (const m of html.matchAll(/\b(?:id|name)="(?:user-content-)?([^"]+)"/g)) anchors.add(m[1]);
  const imgs = [];
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) { const tag = m[0]; const src = (tag.match(/\bsrc="([^"]*)"/) || [])[1]; const alt = (tag.match(/\balt="([^"]*)"/) || [null, null])[1]; if (src) imgs.push({ src: src.replace(/&amp;/g, '&'), alt, kind: 'img' }); }
  for (const m of html.matchAll(/<source\b[^>]*\bsrcset="([^"]*)"[^>]*>/gi)) imgs.push({ src: m[1].split(',')[0].trim().split(/\s+/)[0].replace(/&amp;/g, '&'), alt: '(picture source)', kind: 'source' });
  const images = [];
  for (const im of imgs) {
    if (im.kind === 'img' && (im.alt === null || im.alt.trim() === '')) add('alt-missing', 'warn', `Image ${im.src.slice(0, 60)} has no alt text.`, 'Describe it in the [ ] of ![...](...) or alt="..." (WCAG 1.1.1). Badges can say what they show, e.g. alt="npm version".');
    if (isAbs(im.src)) { images.push({ src: im.src, remote: true }); continue; }
    if (im.src.startsWith('data:')) { images.push({ src: 'data:…', inline: true }); continue; }
    const r = resolveRel(root, rdir, im.src);
    if (!r) continue;
    if (r.outside) { add('image-outside', 'error', `Image ${im.src} points outside the repository.`, 'Put the image in the repo and use a path inside it.'); continue; }
    const e = existsExact(root, r.rel);
    if (!e.ok) { add('image-broken', 'error', e.caseOnly ? `Image ${im.src} only exists as ${e.caseOnly}: it shows on a Mac (which ignores case) but is broken on GitHub.` : `Image ${im.src} doesn't exist in the repository, so GitHub shows a broken image.`, e.caseOnly ? `Use the exact path ${e.caseOnly}.` : 'Fix the path (relative to README.md; a leading / is the repo root).'); images.push({ src: im.src, missing: true }); continue; }
    const st = statSync(e.file), buf = readFileSync(e.file);
    const info = { src: im.src, rel: r.rel, kb: Math.round(st.size / 1024), ...(pngSize(buf) || {}) };
    if (st.size > 1024 * 1024) add('image-heavy', 'warn', `${r.rel} is ${(st.size / 1048576).toFixed(1)} MB; it loads slowly on phones.`, "Resize it to the width it's shown at (README content is about 900 px wide) and compress it.");
    images.push(info);
  }
  const imgSrcs = new Set(imgs.map((i) => i.src));
  for (const m of html.matchAll(/<a\b[^>]*\bhref="([^"]*)"/gi)) {
    const href = m[1].replace(/&amp;/g, '&');
    if (!href || isAbs(href) || href.startsWith('mailto:') || imgSrcs.has(href)) continue; // GitHub links each image to itself
    if (href.startsWith('#')) { const a = decodeURIComponent(href.slice(1)).toLowerCase(); if (!anchors.has(a) && !anchors.has(a.replace(/^user-content-/, ''))) add('anchor-broken', 'warn', `Link ${href} doesn't match any heading.`, 'GitHub makes anchors from headings: lower case, spaces as -, punctuation dropped.'); continue; }
    const r = resolveRel(root, rdir, href); if (!r || r.outside) continue;
    const e = existsExact(root, r.rel);
    if (!e.ok) add('link-broken', 'error', e.caseOnly ? `Link ${href} only exists as ${e.caseOnly}: fine on a Mac, a 404 on GitHub.` : `Link ${href} goes to a file that isn't in the repository (a 404 on GitHub).`, e.caseOnly ? `Use ${e.caseOnly}.` : 'Fix the path or add the file.');
  }
  // Remote images (badges): do they load?
  if (!offline) await Promise.all(images.filter((i) => i.remote && /^https?:/.test(i.src)).slice(0, 15).map(async (i) => {
    try { const r = await fetch(i.src, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(8000) }); i.status = r.status; if (r.status >= 400) add('image-remote-broken', 'error', `Image ${i.src.slice(0, 80)} answers ${r.status}.`, 'Fix or remove it (badge URLs change when a service renames).'); } catch (e) { i.status = 'unreachable'; add('image-remote-unreachable', 'warn', `Couldn't load ${i.src.slice(0, 80)}.`, 'Check it loads in a browser.'); }
  }));

  // Render light/dark × desktop/phone; measure each shown image against its page; screenshot.
  const srv = http.createServer((q, res) => {
    const p = decodeURIComponent(q.url.split('?')[0]);
    if (p === '/__readme_light' || p === '/__readme_dark') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(pageHtml(bodyFor, p.endsWith('dark') ? 'dark' : 'light', repoName)); }
    // Serve repo files exactly as named (case-sensitive), relative to the README's folder like GitHub.
    const rel = p.replace(/^\/+/, ''); const e = existsExact(root, relative(root, resolve(rdir, rel)).split(sep).join('/'));
    if (!e.ok || e.dir) { if (process.env.PALM_DEBUG) console.error('404', p); res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[extname(e.file).toLowerCase()] || 'application/octet-stream' }); res.end(readFileSync(e.file));
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const repoName = root.split(sep).pop();
  // Root-relative paths (/x) are repo-root on GitHub: rewrite them relative to the README folder for the local server.
  const bodyFor = html.replace(/(\b(?:src|href|srcset)=")\/(?!\/)/g, (m, a) => a + (relative(rdir, root).split(sep).join('/') || '.') + '/');
  const outDir = dirname(resolve(out)); mkdirSync(outDir, { recursive: true });
  const shots = []; const seen = new Set();
  const browser = await launch();
  try {
    for (const theme of ['light', 'dark']) for (const [vk, v] of Object.entries(VIEWS)) {
      const page = await browser.newPage();
      await page.setViewport({ width: v.width, height: v.height, deviceScaleFactor: v.scale });
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
      await page.goto(`${base}/__readme_${theme}`, { waitUntil: 'networkidle0', timeout: 60000 }).catch(() => {});
      await page.evaluate(() => Promise.all([...document.images].map((i) => i.complete ? 0 : new Promise((r) => { i.onload = i.onerror = r; }))));
      const res = await page.evaluate(async (bg) => {
        const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
        const ratio = (a, b) => { const [x, y] = a > b ? [a, b] : [b, a]; return (x + 0.05) / (y + 0.05); };
        const L = lum(bg); const outI = [];
        for (const img of document.querySelectorAll('.markdown-body img')) {
          const r = img.getBoundingClientRect(); if (!r.width || getComputedStyle(img).display === 'none' || !img.currentSrc || !img.currentSrc.startsWith(location.origin)) continue;
          const item = { src: decodeURIComponent(new URL(img.currentSrc).pathname.slice(1)), shownW: Math.round(r.width), x: r.x + scrollX, y: r.y + scrollY, w: r.width, h: r.height, broken: img.naturalWidth === 0 };
          if (!item.broken) {
            const s = Math.min(1, 400 / Math.max(img.naturalWidth, img.naturalHeight)); const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(img.naturalWidth * s)); c.height = Math.max(1, Math.round(img.naturalHeight * s));
            const x = c.getContext('2d'); x.drawImage(img, 0, 0, c.width, c.height); let d; try { d = x.getImageData(0, 0, c.width, c.height).data; } catch { d = null; }
            if (d) { let vis = 0, clear = 0, good = 0; for (let i = 0; i < d.length; i += 4) { const a = d[i + 3]; if (a < 16) { clear++; continue; } if (a < 128) continue; vis++; if (ratio(lum([d[i], d[i + 1], d[i + 2]]), L) >= 3) good++; } item.transparentShare = clear / (d.length / 4); item.visible = vis; item.goodShare = vis ? good / vis : 1; }
          }
          if (/\.svg$/i.test(item.src)) {
            try {
              const t = await (await fetch(img.currentSrc)).text(); const d = new DOMParser().parseFromString(t, 'image/svg+xml'); const svg = d.documentElement;
              const vb = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number); const w0 = vb.length === 4 && vb[2] ? vb[2] : parseFloat(svg.getAttribute('width')) || 0;
              let min = Infinity; for (const el of d.querySelectorAll('text, tspan')) { const fs = parseFloat(el.getAttribute('font-size') || (el.getAttribute('style') || '').match(/font-size:\s*([\d.]+)/)?.[1] || ''); if (fs) min = Math.min(min, fs); }
              const cssFs = [...t.matchAll(/font-size:\s*([\d.]+)px/g)].map((m) => +m[1]); if (cssFs.length) min = Math.min(min, ...cssFs);
              if (w0 && min < Infinity) item.minTextPx = +(min * r.width / w0).toFixed(1);
            } catch { /* not readable */ }
          }
          outI.push(item);
        }
        const doc = document.documentElement; const wide = [...document.querySelectorAll('.markdown-body pre, .markdown-body table')].filter((e) => e.scrollWidth > e.clientWidth + 2).map((e) => e.tagName.toLowerCase());
        return { imgs: outI, pageOverflow: doc.scrollWidth > innerWidth + 1, wide, height: doc.scrollHeight };
      }, THEMES[theme].rgb);
      for (const it of res.imgs) {
        const k = `${theme}:${it.src}`; if (seen.has(k)) continue; seen.add(k);
        if (it.broken) { if (!issues.some((i) => i.id === 'image-broken' && i.msg.includes(it.src))) add('image-not-shown', 'error', `${it.src} didn't load in GitHub's ${theme} theme.`, 'Check the path and the <picture> sources.', { theme, image: it.src }); continue; }
        if (it.transparentShare > 0.05 && it.visible && it.goodShare < 0.3) add('image-vanishes', 'error', `${it.src} disappears on GitHub's ${theme} theme: only ${Math.round(it.goodShare * 100)}% of its visible pixels stand out from the ${THEMES[theme].bg} page (3:1).`, `Give it a ${theme} version: <picture><source media="(prefers-color-scheme: ${theme})" srcset="…-${theme}.png"><img src="…" alt="…"></picture>, or add a solid background.`, { theme, image: it.src });
        else if (it.transparentShare > 0.05 && it.visible && it.goodShare < 0.6) add('image-faint', 'warn', `${it.src} is faint on GitHub's ${theme} theme: ${Math.round(it.goodShare * 100)}% of its visible pixels reach 3:1 against the page.`, `Check it in ${theme}; consider a ${theme} version with <picture>.`, { theme, image: it.src });
      }
      if (vk === 'phone' && theme === 'light') for (const it of res.imgs) if (it.minTextPx != null && it.minTextPx < 9) add('image-text-small', it.minTextPx < 7 ? 'error' : 'warn', `On a 390 px phone ${it.src} is shown ${it.shownW} px wide, so its smallest text is ${it.minTextPx} px: too small to read.`, 'Draw it so it reads at phone width: stacked top to bottom, fewer boxes per row, bigger text (Palm\'s guidance: at least 9 px as shown). GitHub documents <picture> only for light/dark, so don\'t rely on a width-based <source> there.', { theme, image: it.src });
      if (vk === 'phone') { if (res.pageOverflow) add('phone-overflow', 'error', `On a 390 px phone (${theme}) the page scrolls sideways.`, 'A wide image with a fixed width, or HTML with a fixed width.'); if (res.wide.length && theme === 'light') add('phone-scroll', 'warn', `On a 390 px phone, ${res.wide.length} code block${res.wide.length === 1 ? '' : 's'}/table${res.wide.length === 1 ? '' : 's'} scroll sideways (${[...new Set(res.wide)].join(', ')}).`, 'Shorter lines in examples; fewer table columns, or a list on small screens (Palm\'s guidance).'); }
      // Box problems (not in the plain sheet the judge sees).
      if (!plain) {
        const bad = new Set(issues.filter((i) => i.where?.theme === theme && i.where.image).map((i) => i.where.image));
        await page.evaluate((bad) => { for (const img of document.querySelectorAll('.markdown-body img')) { const s = img.currentSrc && decodeURIComponent(new URL(img.currentSrc).pathname.slice(1)); if (bad.includes(s) || img.naturalWidth === 0) img.style.outline = '4px solid #ff2d55'; } }, [...bad]);
      }
      const f = join(outDir, `${resolve(out).split(sep).pop()}-${theme}-${vk}.png`);
      const clipH = Math.min(res.height, v.cap);
      await page.screenshot({ path: f, clip: { x: 0, y: 0, width: v.width, height: clipH } });
      shots.push({ theme, view: vk, file: f, width: v.width, height: clipH, cut: res.height > v.cap });
      await page.close();
    }
    // The sheet: desktop light | desktop dark, then phone light | phone dark.
    const sheet = resolve(out) + '-sheet.png';
    const p = await browser.newPage(); await p.setViewport({ width: 2640, height: 1000 });
    const cell = (s) => `<figure style="margin:0"><figcaption style="font:600 20px -apple-system,sans-serif;padding:10px 4px;color:#333">${s.view === 'phone' ? 'Phone 390 px' : 'Desktop'} · GitHub ${s.theme}${s.cut ? ' (top of the page)' : ''}</figcaption><img style="display:block;width:${s.view === 'phone' ? 390 : 1280}px;border:1px solid #bbb" src="data:image/png;base64,${readFileSync(s.file).toString('base64')}"></figure>`;
    const by = (v) => shots.filter((s) => s.view === v);
    await p.setContent(`<body style="margin:0;padding:20px;background:#e8e6e1;font-family:-apple-system,sans-serif"><div style="display:flex;gap:40px;align-items:flex-start">${by('desktop').map(cell).join('')}</div><div style="display:flex;gap:40px;align-items:flex-start;margin-top:30px">${by('phone').map(cell).join('')}</div></body>`);
    await p.evaluate(() => Promise.all([...document.images].map((i) => i.complete ? 0 : new Promise((r) => (i.onload = r)))));
    await p.screenshot({ path: sheet, fullPage: true });
    const errors = issues.filter((i) => i.level === 'error').length, warnings = issues.filter((i) => i.level === 'warn').length;
    return { ok: !errors, errors, warnings, renderer, readme: rname, kb: Math.round(bytes / 1024), images, issues, sheet, shots: shots.map((s) => s.file) };
  } finally { await browser.close(); srv.close(); }
}

// A logo drawn dark on a transparent PNG, made in Chrome (so the self-test needs no image library).
async function makeLogo(file, color) {
  const b = await launch();
  try { const p = await b.newPage(); await p.setViewport({ width: 240, height: 80 }); await p.setContent(`<body style="margin:0;background:transparent"><div style="font:700 48px Helvetica;color:${color};padding:8px 12px">tidy</div></body>`); await p.screenshot({ path: file, omitBackground: true }); } finally { await b.close(); }
}
async function selfTest() {
  const d = mkdtempSync(join(tmpdir(), 'readme-check-'));
  const bad = join(d, 'bad'), good = join(d, 'good');
  for (const r of [bad, good]) { mkdirSync(join(r, 'assets'), { recursive: true }); mkdirSync(join(r, 'docs'), { recursive: true }); }
  await makeLogo(join(bad, 'assets', 'logo.png'), '#111111');
  await makeLogo(join(good, 'assets', 'logo.png'), '#111111'); await makeLogo(join(good, 'assets', 'logo-dark.png'), '#f0f0f0');
  writeFileSync(join(good, 'docs', 'USAGE.md'), '# Usage\n');
  writeFileSync(join(bad, 'README.md'), '# tidy\n\n![](Assets/logo.png)\n\n<style>h1{color:red}</style>\n\n### Features\n\nSee [usage](docs/usage.md) and [install](#install-it).\n\n```\nnpm i tidy\n```\n');
  writeFileSync(join(good, 'README.md'), '<picture><source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.png"><img src="assets/logo.png" alt="tidy" width="200"></picture>\n\n# tidy\n\n## Install\n\n```bash\nnpm i tidy\n```\n\n## Usage\n\nSee [usage](docs/USAGE.md) and [install](#install).\n');
  const b = await check(bad, { out: join(d, 'b'), offline: true });
  const ids = new Set(b.issues.map((i) => i.id));
  for (const want of ['image-broken', 'html-escaped', 'heading-skip', 'fence-no-language', 'alt-missing', 'link-broken', 'anchor-broken', 'install-late']) if (!ids.has(want)) throw new Error('bad README: expected ' + want + ' in ' + [...ids].join(','));
  if (!b.issues.find((i) => i.id === 'image-broken')?.msg.includes('Mac')) throw new Error('case-only path not explained');
  // The broken image can't vanish; a correctly cased dark logo must vanish in dark only.
  writeFileSync(join(bad, 'README.md'), '# tidy\n\n## Install\n\n![tidy](assets/logo.png)\n');
  const v = await check(bad, { out: join(d, 'v'), offline: true });
  const van = v.issues.filter((i) => i.id === 'image-vanishes');
  if (van.length !== 1 || van[0].where.theme !== 'dark') throw new Error('dark logo should vanish in dark only: ' + JSON.stringify(v.issues));
  // A wide diagram whose 13 px text shrinks below 7 px on a phone.
  writeFileSync(join(bad, 'docs', 'arch.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="120" viewBox="0 0 900 120"><rect width="900" height="120" fill="#fff"/><text x="10" y="60" font-size="13">Scan → Read date → Plan → Move</text></svg>');
  writeFileSync(join(bad, 'README.md'), '# tidy\n\n## Install\n\n![How it works](docs/arch.svg)\n');
  const t = await check(bad, { out: join(d, 't'), offline: true });
  if (!t.issues.some((i) => i.id === 'image-text-small' && i.level === 'error')) throw new Error('wide diagram text on a phone not caught: ' + JSON.stringify(t.issues));
  const g = await check(good, { out: join(d, 'g'), offline: true });
  if (g.errors || g.warnings) throw new Error('clean README flagged: ' + JSON.stringify(g.issues));
  // GitHub's real renderer wraps <img> in a link inside <picture>; the clean README must still pass through it.
  const o = await check(good, { out: join(d, 'o') });
  if (o.renderer === 'github-api' && (o.errors || o.warnings)) throw new Error('clean README flagged with GitHub\'s renderer: ' + JSON.stringify(o.issues));
  if (slug('Install it!') !== 'install-it' || slug('API & CLI') !== 'api--cli') throw new Error('slug');
  console.log(`readme-check: all tests pass (sheet ${g.sheet})`);
}

if (typeof process !== 'undefined' && process.argv?.[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
  const pos = argv.filter((a, i) => !a.startsWith('--') && !['--readme', '--out'].includes(argv[i - 1]));
  const fail = (e) => { console.error(String(e.message || e)); process.exit(2); };
  if (argv.includes('--test')) selfTest().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
  else if (pos[0] === 'check' && pos[1]) check(pos[1], { readme: opt('readme', null), out: opt('out', 'look/readme'), offline: argv.includes('--offline') }).then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); }, fail);
  else fail('usage: readme-check.mjs check <repo folder> [--readme README.md] [--out look/readme] [--offline]\n       readme-check.mjs --test');
}
