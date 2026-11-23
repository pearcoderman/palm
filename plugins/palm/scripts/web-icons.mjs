#!/usr/bin/env node
// Palm tool: web-icons — checks a site's icons the way browsers and phones use them, and draws them there: the
// favicon in light and dark browser tabs (at 2× and at the real 16 px), a Google result and the bookmarks bar; the
// Apple touch icon on an iPhone home screen (transparent parts turn black); the manifest's maskable icon under
// Android's circle, squircle and rounded-square masks with its safe zone; and the install prompt and splash screen.
// Measures: the tags and the manifest, sizes and formats, transparency on the touch icon, maskable content outside
// the 40% safe circle, and how the favicon holds up on light and dark tabs.
// adds: tool, fresh-data. Runs on the user's machine with their Chrome/Edge/Chromium; nothing leaves it.
//
//   node web-icons.mjs check <site folder> [--html index.html] [--out look/icons]
//       → JSON {ok, errors, warnings, found, issues, sheet}. Then LOOK at the sheet.
//   node web-icons.mjs render <design.html|icon.svg> --size 512 --out icons/icon-512.png [--alpha]
//       → renders HTML or SVG at exactly that size; opaque unless --alpha.
//   node web-icons.mjs ico <16.png> <32.png> [48.png] --out favicon.ico
//       → packs PNGs into one favicon.ico (no ImageMagick needed).
//
// Rules: Palm data pack sites/web-icons (checked 2026-11-23: MDN, web.dev, W3C manifest spec, Google Search
// Central, Apple's Safari Web Content Guide). Marked there where a number is Palm's observation, not a rule.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve, relative, extname } from 'node:path';

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
const issue = (id, level, msg, fix) => ({ id, level, msg, fix });

// ---------- file formats ----------
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
  if (b.readUInt16LE(0) === 0 && b.readUInt16LE(2) === 1 && b.readUInt16LE(4) > 0) {
    const n = b.readUInt16LE(4), sizes = [];
    for (let k = 0; k < n && 6 + 16 * k + 16 <= b.length; k++) { const o = 6 + 16 * k; sizes.push([b[o] || 256, b[o + 1] || 256]); }
    const big = sizes.reduce((a, s) => (s[0] > a[0] ? s : a), [0, 0]);
    return { format: 'ico', w: big[0], h: big[1], sizes, alpha: true };
  }
  const head = b.toString('utf8', 0, Math.min(b.length, 2000));
  if (/<svg[\s>]/i.test(head)) {
    const vb = head.match(/viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
    return { format: 'svg', w: vb ? +vb[1] : 0, h: vb ? +vb[2] : 0, alpha: true, dark: /prefers-color-scheme\s*:\s*dark/i.test(b.toString('utf8')) };
  }
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return { format: 'webp' };
  if (b.toString('latin1', 0, 4) === 'GIF8') return { format: 'gif', w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  return { format: 'unknown' };
}
const MIME = { png: 'image/png', jpeg: 'image/jpeg', ico: 'image/x-icon', svg: 'image/svg+xml', webp: 'image/webp', gif: 'image/gif' };
const dataUrl = (file) => { const b = readFileSync(file); return `data:${MIME[imageInfo(b).format] || 'image/png'};base64,${b.toString('base64')}`; };

// ---------- the page's tags ----------
const attrs = (tag) => Object.fromEntries([...tag.matchAll(/([a-zA-Z:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g)].map((m) => [m[1].toLowerCase(), m[3] ?? m[4] ?? m[5]]));
function readTags(html) {
  const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => attrs(m[0]));
  const metas = [...html.matchAll(/<meta\b[^>]*>/gi)].map((m) => attrs(m[0]));
  const rel = (r) => links.filter((l) => (l.rel || '').toLowerCase().split(/\s+/).includes(r));
  return {
    icons: [...rel('icon'), ...links.filter((l) => /^shortcut icon$/i.test(l.rel || '') && !rel('icon').includes(l))],
    touch: [...rel('apple-touch-icon'), ...rel('apple-touch-icon-precomposed')],
    manifest: rel('manifest')[0],
    theme: metas.filter((m) => (m.name || '').toLowerCase() === 'theme-color'),
    appTitle: metas.find((m) => (m.name || '').toLowerCase() === 'apple-mobile-web-app-title')?.content,
    title: (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1]?.trim() || '',
  };
}

// ---------- pixels (in the browser) ----------
async function probe(page, url, size, { dark = false } = {}) {
  return page.evaluate(async (u, S, dark) => {
    const img = new Image(); img.src = u; await img.decode();
    const c = document.createElement('canvas'); c.width = S; c.height = S;
    const x = c.getContext('2d'); x.drawImage(img, 0, 0, S, S);
    const d = x.getImageData(0, 0, S, S).data, px = (i, j) => { const k = (j * S + i) * 4; return [d[k], d[k + 1], d[k + 2], d[k + 3]]; };
    // Transparency: corners and overall.
    let transparent = 0; for (let k = 3; k < d.length; k += 4) if (d[k] < 250) transparent++;
    const corners = [px(0, 0), px(S - 1, 0), px(0, S - 1), px(S - 1, S - 1)].map((p) => p[3]);
    // Background = the most common opaque colour on the border (quantised).
    const counts = {}; for (let i = 0; i < S; i++) for (const [a, b] of [[i, 0], [i, S - 1], [0, i], [S - 1, i]]) { const p = px(a, b); if (p[3] > 200) { const q = p.slice(0, 3).map((v) => v >> 4).join(','); counts[q] = (counts[q] || 0) + 1; } }
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    const bg = top ? top[0].split(',').map((v) => (+v << 4) + 8) : null;
    // Content outside the maskable safe circle (radius 40% of the size): pixels that differ from the background.
    let out = 0, outN = 0; const r = 0.4 * S, cx = S / 2;
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
      const dx = i + 0.5 - cx, dy = j + 0.5 - cx; if (dx * dx + dy * dy <= r * r) continue;
      outN++; const p = px(i, j);
      if (p[3] < 200 || !bg || Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2]) > 72) out++;
    }
    // Legibility on a tab: share of the icon's ink that stands out (contrast ≥ 2:1) on a light and a dark tab.
    const lum = (r, g, b) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const onTab = (tab) => { const L2 = lum(...tab); let ink = 0, good = 0; for (let k = 0; k < d.length; k += 4) { const a = d[k + 3] / 255; if (a < 0.15) continue; const rgb = [0, 1, 2].map((m) => d[k + m] * a + tab[m] * (1 - a)); const L1 = lum(...rgb); const cr = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05); ink += a; if (cr >= 2) good += a; } return ink ? good / ink : 0; };
    return { size: S, transparent: transparent / (S * S), corners, bg, outside: outN ? out / outN : 0, light: onTab([255, 255, 255]), dark: onTab([53, 54, 58]) };
  }, url, size, dark);
}
// Rasterise an icon at a size (an SVG with a dark-mode media query is drawn as the dark browser sees it).
async function raster(browser, url, size, dark) {
  const page = await browser.newPage();
  try {
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }]);
    await page.setContent(`<html><body style="margin:0;background:transparent"><img id="i" src="${url}" style="width:${size}px;height:${size}px;display:block"></body></html>`);
    await page.evaluate(() => document.getElementById('i').decode().catch(() => {}));
    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    const b = await page.screenshot({ type: 'png', omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    return 'data:image/png;base64,' + Buffer.from(b).toString('base64');
  } finally { await page.close(); }
}

// ---------- check ----------
export async function check(folder, { html = 'index.html', out = 'look/icons' } = {}) {
  const root = resolve(folder), htmlFile = join(root, html);
  if (!existsSync(htmlFile)) throw new Error(`No ${html} in ${root}.`);
  const page = readFileSync(htmlFile, 'utf8'), T = readTags(page), issues = [], found = [];
  const local = (href) => { if (!href || /^(https?:)?\/\//i.test(href) || /^data:/i.test(href)) return null; const p = href.split(/[?#]/)[0]; return p.startsWith('/') ? join(root, p) : join(dirname(htmlFile), p); };
  const load = (href, what) => {
    if (/^(https?:)?\/\//i.test(href || '')) { issues.push(issue('external-' + what, 'warn', `${what} ${href} is on another site; Palm can't check it.`, 'Serve icons from your own site.')); return null; }
    const f = local(href); if (!f) return null;
    if (!existsSync(f)) { issues.push(issue('missing-file', 'error', `${what} points to ${href}, which doesn't exist.`, 'Fix the path or add the file.')); return null; }
    const b = readFileSync(f); return { file: f, rel: relative(root, f), kb: Math.round(b.length / 1024), ...imageInfo(b) };
  };

  // Favicon(s)
  const favs = T.icons.map((l) => ({ link: l, ...load(l.href, 'Favicon') })).filter((x) => x.file);
  const rootIco = existsSync(join(root, 'favicon.ico')) ? { file: join(root, 'favicon.ico'), rel: 'favicon.ico', ...imageInfo(readFileSync(join(root, 'favicon.ico'))) } : null;
  if (!T.icons.length && !rootIco) issues.push(issue('no-favicon', 'error', 'No <link rel="icon"> and no /favicon.ico: browsers show a blank page icon and Google Search shows a generic globe.', 'Add a favicon and link it in <head>.'));
  else if (!T.icons.length) issues.push(issue('favicon-unlinked', 'warn', 'Only /favicon.ico, with no <link rel="icon">: Google Search wants the favicon named in the home page\'s head.', 'Add <link rel="icon" href="/favicon.ico" sizes="32x32">.'));
  if (!rootIco && !favs.some((f) => f.format === 'ico')) issues.push(issue('no-ico', 'warn', 'No favicon.ico at the site root. Older browsers, feed readers and other tools ask for /favicon.ico when they find no tag (Palm\'s advice).', 'Pack 16, 32 and 48 px PNGs: node web-icons.mjs ico 16.png 32.png 48.png --out favicon.ico'));
  for (const f of [...favs, ...(rootIco && !favs.some((x) => x.file === rootIco.file) ? [rootIco] : [])]) {
    found.push({ key: 'favicon', file: f.rel, format: f.format, w: f.w, h: f.h, sizes: f.sizes, abs: f.file, dark: f.dark });
    if (f.format === 'unknown') issues.push(issue('favicon-format', 'error', `${f.rel} isn't an image Palm recognises.`, 'Use SVG, PNG or ICO.'));
    if (f.w && f.h && f.w !== f.h) issues.push(issue('favicon-square', 'error', `${f.rel} is ${f.w}×${f.h}; a favicon must be square (Google Search requires 1:1).`, 'Make it square.'));
    if (f.format === 'ico' && !f.sizes.some(([w]) => w === 16 || w === 32)) issues.push(issue('ico-sizes', 'warn', `${f.rel} holds ${f.sizes.map((s) => s.join('×')).join(', ')}; tabs use 16 and 32 px.`, 'Include 16×16 and 32×32.'));
  }
  const svgFav = favs.find((f) => f.format === 'svg');
  const bestRaster = [...favs, ...(rootIco ? [rootIco] : [])].filter((f) => f.format !== 'svg' && f.w).sort((a, b) => b.w - a.w)[0];
  if (!svgFav && bestRaster && bestRaster.w < 48) issues.push(issue('favicon-small', 'warn', `The largest favicon is ${bestRaster.w}×${bestRaster.h}; Google recommends larger than 48×48 so it looks good in search results.`, 'Add a 48×48 or larger PNG (or an SVG).'));

  // Apple touch icon
  let touch = T.touch.map((l) => ({ link: l, ...load(l.href, 'Apple touch icon') })).filter((x) => x.file).sort((a, b) => (b.w || 0) - (a.w || 0))[0];
  if (!touch && !T.touch.length && existsSync(join(root, 'apple-touch-icon.png'))) touch = { file: join(root, 'apple-touch-icon.png'), rel: 'apple-touch-icon.png', ...imageInfo(readFileSync(join(root, 'apple-touch-icon.png'))) };
  if (!touch) issues.push(issue('no-touch-icon', 'error', 'No Apple touch icon (<link rel="apple-touch-icon"> or /apple-touch-icon.png): on an iPhone home screen or in Safari favourites the site gets a made-up icon.', 'Add a 180×180 opaque PNG and link it.'));
  else {
    found.push({ key: 'touch', file: touch.rel, format: touch.format, w: touch.w, h: touch.h, abs: touch.file });
    if (touch.format !== 'png') issues.push(issue('touch-format', 'error', `The touch icon ${touch.rel} is ${touch.format.toUpperCase()}; Apple's guide asks for PNG.`, 'Save it as PNG.'));
    else if (touch.w < 180) issues.push(issue('touch-small', 'error', `The touch icon is ${touch.w}×${touch.h}; iPhones use 180×180 and blow up anything smaller.`, 'Render it at 180×180.'));
    else if (touch.w !== 180) issues.push(issue('touch-size', 'warn', `The touch icon is ${touch.w}×${touch.h}; 180×180 is the iPhone size in Apple's guide.`, 'Render it at 180×180.'));
    if (touch.w && touch.w !== touch.h) issues.push(issue('touch-square', 'error', `The touch icon is ${touch.w}×${touch.h}; it must be square.`, 'Make it square.'));
  }

  // Manifest
  let man = null, manFile = null;
  if (!T.manifest) issues.push(issue('no-manifest', 'warn', 'No <link rel="manifest">: Android and desktop Chrome can\'t install the site, and "Add to Home screen" on Android uses a shrunken favicon on a white background.', 'Add site.webmanifest with name, short_name, icons (192, 512, and a maskable one), start_url, display, theme_color and background_color.'));
  else {
    manFile = local(T.manifest.href);
    if (!manFile || !existsSync(manFile)) issues.push(issue('missing-file', 'error', `The manifest link points to ${T.manifest.href}, which doesn't exist.`, 'Fix the path or add the file.'));
    else { try { man = JSON.parse(readFileSync(manFile, 'utf8')); } catch (e) { issues.push(issue('manifest-json', 'error', `${relative(root, manFile)} isn't valid JSON: ${String(e.message).slice(0, 80)}.`, 'Fix the JSON.')); } }
  }
  const manIcons = [];
  if (man) {
    for (const k of ['name', 'short_name', 'start_url', 'display', 'theme_color', 'background_color']) if (!man[k] && !(k === 'name' && man.short_name) && !(k === 'short_name' && man.name)) issues.push(issue('manifest-' + k.replace('_', '-'), k === 'display' || k === 'start_url' ? 'error' : 'warn', `The manifest has no ${k}${k === 'background_color' ? ' (the splash screen colour)' : k === 'theme_color' ? ' (the title bar colour)' : ''}.`, `Add "${k}".`));
    if (man.display && !['fullscreen', 'standalone', 'minimal-ui', 'window-controls-overlay'].includes(man.display)) issues.push(issue('manifest-display', 'error', `display is "${man.display}"; Chrome installs only fullscreen, standalone, minimal-ui or window-controls-overlay.`, 'Use "standalone".'));
    if ((man.short_name || man.name || '').length > 12 && !man.short_name) issues.push(issue('short-name', 'warn', `No short_name, and the name "${man.name}" is long for a home-screen label.`, 'Add a short_name of about 12 characters or fewer.'));
    const base = dirname(manFile);
    for (const ic of Array.isArray(man.icons) ? man.icons : []) {
      const src = String(ic.src || ''); const f = /^(https?:)?\/\//.test(src) ? null : src.startsWith('/') ? join(root, src.split(/[?#]/)[0]) : join(base, src.split(/[?#]/)[0]);
      if (!f || !existsSync(f)) { issues.push(issue('missing-file', 'error', `Manifest icon ${src} doesn't exist.`, 'Fix the path or add the file.')); continue; }
      const info = imageInfo(readFileSync(f)), purposes = String(ic.purpose || 'any').split(/\s+/);
      const declared = String(ic.sizes || '').split(/\s+/).filter(Boolean);
      const rec = { file: f, rel: relative(root, f), ...info, purposes, declared };
      manIcons.push(rec);
      if (info.format !== 'svg' && declared.length && info.w && !declared.includes(`${info.w}x${info.h}`) && !declared.includes('any')) issues.push(issue('manifest-sizes', 'error', `Manifest says ${rec.rel} is ${declared.join(' ')}, but it is ${info.w}×${info.h}.`, 'Make "sizes" match the file.'));
      found.push({ key: purposes.includes('maskable') ? 'maskable' : 'manifest-icon', file: rec.rel, format: info.format, w: info.w, h: info.h, purpose: purposes.join(' '), abs: f });
    }
    const has = (n, p = 'any') => manIcons.some((i) => i.purposes.includes(p) && (i.format === 'svg' || i.w >= n) && (i.w === n || i.declared.includes(`${n}x${n}`) || i.format === 'svg'));
    if (!manIcons.length) issues.push(issue('manifest-icons', 'error', 'The manifest has no icons.', 'Add 192×192 and 512×512 PNGs, plus a maskable one.'));
    else {
      if (!has(192) && !manIcons.some((i) => i.w === 192)) issues.push(issue('manifest-192', 'error', 'No 192×192 icon in the manifest; Chrome\'s install criteria need a 192px and a 512px icon.', 'Add a 192×192 PNG.'));
      if (!has(512) && !manIcons.some((i) => i.w === 512)) issues.push(issue('manifest-512', 'error', 'No 512×512 icon in the manifest; Chrome\'s install criteria need a 192px and a 512px icon (the splash screen uses the large one).', 'Add a 512×512 PNG.'));
      if (!manIcons.some((i) => i.purposes.includes('maskable'))) issues.push(issue('no-maskable', 'warn', 'No maskable icon: Android shrinks the icon onto a white background inside its own shape.', 'Add a full-bleed 512×512 PNG with the mark inside the centre 80% circle, "purpose": "maskable".'));
      if (manIcons.some((i) => i.purposes.includes('any') && i.purposes.includes('maskable'))) issues.push(issue('any-maskable', 'warn', 'One icon is both "any" and "maskable": the padding a maskable icon needs makes it look small where it\'s shown whole (desktop, install prompt).', 'Use separate files: a tight "any" icon and a padded "maskable" one.'));
    }
  }

  // theme-color
  if (!T.theme.length && !man?.theme_color) issues.push(issue('no-theme-color', 'warn', 'No <meta name="theme-color">: the browser bar and the installed app\'s title bar use default grey.', 'Add <meta name="theme-color" content="#…"> (and one with media="(prefers-color-scheme: dark)").'));

  // Pixels
  const browser = await launch();
  let sheet = null, measures = {};
  try {
    const page = await browser.newPage();
    const tabIcon = svgFav || bestRaster;
    if (tabIcon) {
      const url = dataUrl(tabIcon.file);
      const lightUrl = await raster(browser, url, 32, false), darkUrl = await raster(browser, url, 32, true);
      const L = await probe(page, lightUrl, 32), D = await probe(page, darkUrl, 32);
      measures.tab = { file: tabIcon.rel, light: +L.light.toFixed(2), dark: +D.dark.toFixed(2) };
      if (L.light < 0.35) issues.push(issue('tab-light', 'warn', `On a white tab only ${Math.round(L.light * 100)}% of the favicon stands out (contrast 2:1 or more); it fades away.`, 'Give it a solid background or darker ink.'));
      if (D.dark < 0.35) issues.push(issue('tab-dark', 'warn', `On a dark tab only ${Math.round(D.dark * 100)}% of the favicon stands out; it disappears in dark mode.`, svgFav ? 'Add a @media (prefers-color-scheme: dark) rule inside the SVG, or give it a solid background.' : 'Give it a solid background, or add an SVG favicon that adapts to dark mode.'));
    }
    if (touch && touch.format === 'png') {
      const t = await probe(page, dataUrl(touch.file), Math.min(touch.w || 180, 360));
      measures.touch = { transparent: +t.transparent.toFixed(3) };
      if (t.transparent > 0.002) issues.push(issue('touch-alpha', 'error', `The touch icon is ${Math.round(t.transparent * 100)}% transparent; iOS shows transparent parts as black (see the home screen on the sheet).`, 'Make it a full-bleed opaque square; iOS rounds the corners itself.'));
    }
    for (const m of manIcons.filter((i) => i.purposes.includes('maskable'))) {
      const p = await probe(page, dataUrl(m.file), 256);
      measures.maskable = { file: m.rel, outside: +p.outside.toFixed(3), transparent: +p.transparent.toFixed(3) };
      if (p.transparent > 0.002) issues.push(issue('maskable-alpha', 'error', `The maskable icon ${m.rel} is ${Math.round(p.transparent * 100)}% transparent; masks need an opaque, full-bleed image (the transparent parts show as a white or black rim).`, 'Fill the whole square with the background colour.'));
      if (p.outside > 0.04) issues.push(issue('maskable-safe-zone', 'error', `${Math.round(p.outside * 100)}% of the area outside the safe circle (radius 40%) differs from the background in ${m.rel}: the circle mask cuts it off.`, 'Shrink the mark to fit inside the centre circle (about 80% of the width), background to the edges.'));
    }

    sheet = resolve(out + '-sheet.png'); mkdirSync(dirname(sheet), { recursive: true });
    const sheetHtml = await drawSheet(browser, { T, man, root, svgFav, bestRaster, touch, manIcons, host: 'yoursite.com' });
    writeFileSync(sheet.replace(/\.png$/, '.html'), sheetHtml);
    const sp = await browser.newPage();
    await sp.setViewport({ width: 1240, height: 900, deviceScaleFactor: 2 });
    await sp.goto(pathToFileURL(sheet.replace(/\.png$/, '.html')).href, { waitUntil: 'load' });
    await new Promise((ok) => setTimeout(ok, 300));
    await sp.screenshot({ path: sheet, fullPage: true });
  } finally { await browser.close(); }

  const errors = issues.filter((i) => i.level === 'error').length;
  return { ok: !errors, errors, warnings: issues.length - errors, found: found.map(({ abs, ...x }) => x), measures, issues, sheet,
    look: `LOOK at ${sheet}: can you tell the site apart from the others in a 16 px tab, light and dark? Is the home-screen icon full, with no black corners? Does the Android circle cut anything? Does the splash screen look intended?` };
}

// ---------- the sheet ----------
async function drawSheet(browser, { T, man, svgFav, bestRaster, touch, manIcons }) {
  const tab = svgFav || bestRaster;
  const tabUrl = tab ? dataUrl(tab.file) : null;
  const light32 = tabUrl ? await raster(browser, tabUrl, 64, false) : null, dark32 = tabUrl ? await raster(browser, tabUrl, 64, true) : null;
  const light16 = tabUrl ? await raster(browser, tabUrl, 16, false) : null, dark16 = tabUrl ? await raster(browser, tabUrl, 16, true) : null;
  const touchUrl = touch?.format === 'png' ? dataUrl(touch.file) : null;
  const mask = manIcons.filter((i) => i.purposes.includes('maskable')).sort((a, b) => (b.w || 0) - (a.w || 0))[0];
  const anyIc = manIcons.filter((i) => i.purposes.includes('any')).sort((a, b) => (b.w || 0) - (a.w || 0))[0];
  const maskUrl = mask ? dataUrl(mask.file) : null, anyUrl = anyIc ? dataUrl(anyIc.file) : tabUrl;
  const name = man?.short_name || man?.name || T.appTitle || T.title.split(/[|–—-]/)[0].trim() || 'Your site';
  const longName = man?.name || T.title || name;
  const blank = (bg) => `<div style="width:16px;height:16px;border-radius:3px;background:${bg}"></div>`;
  const fav = (u, s = 16) => u ? `<img src="${u}" style="width:${s}px;height:${s}px;display:block">` : `<div style="width:${s}px;height:${s}px;border:1.5px dashed #c00;box-sizing:border-box"></div>`;
  const chromeTabs = (dark) => { const strip = dark ? '#202124' : '#dee1e6', act = dark ? '#35363a' : '#fff', fg = dark ? '#e8eaed' : '#202124', other = dark ? '#5f6368' : '#9aa0a6';
    const t = (active, icon, label) => `<div style="display:flex;gap:8px;align-items:center;padding:8px 12px;width:180px;border-radius:8px 8px 0 0;background:${active ? act : 'transparent'};color:${fg};font:12px system-ui">${icon}<span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${label}</span></div>`;
    return `<div style="background:${strip};padding:8px 8px 0;display:flex;gap:2px;width:600px">${t(false, blank(other), 'Inbox (3)')}${t(true, fav(dark ? dark32 : light32), longName)}${t(false, blank('#4285f4'), 'Docs')}</div>`; };
  const safariTabs = (dark) => { const bar = dark ? '#2b2b2d' : '#f2f2f4', act = dark ? '#3c3c3e' : '#fff', fg = dark ? '#f5f5f7' : '#1d1d1f';
    const t = (active, icon, label) => `<div style="flex:1;display:flex;gap:6px;justify-content:center;align-items:center;padding:6px;border-radius:7px;background:${active ? act : 'transparent'};color:${fg};font:12px -apple-system,system-ui">${icon}<span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:120px">${label}</span></div>`;
    return `<div style="background:${bar};padding:6px;display:flex;gap:4px;width:600px;border-radius:10px">${t(false, blank('#8e8e93'), 'News')}${t(true, fav(dark ? dark32 : light32), longName)}${t(false, blank('#34c759'), 'Maps')}</div>`; };
  const pix = (u, bg) => `<div style="background:${bg};padding:8px;display:inline-block">${u ? `<img src="${u}" style="width:64px;height:64px;image-rendering:pixelated;display:block">` : fav(null, 64)}</div>`;
  const google = (dark) => `<div style="background:${dark ? '#202124' : '#fff'};padding:14px;width:520px;font:14px arial"><div style="display:flex;gap:10px;align-items:center"><div style="width:28px;height:28px;border-radius:50%;background:${dark ? '#303134' : '#f1f3f4'};display:flex;align-items:center;justify-content:center">${fav(dark ? dark32 : light32, 18)}</div><div><div style="color:${dark ? '#dadce0' : '#202124'}">${name}</div><div style="color:${dark ? '#bdc1c6' : '#4d5156'};font-size:12px">https://yoursite.com</div></div></div><div style="color:${dark ? '#8ab4f8' : '#1a0dab'};font-size:20px;margin-top:6px">${longName}</div></div>`;
  const bookmarks = (dark) => `<div style="background:${dark ? '#35363a' : '#fff'};padding:6px 10px;display:flex;gap:16px;width:580px;font:12px system-ui;color:${dark ? '#e8eaed' : '#202124'};border-bottom:1px solid ${dark ? '#000' : '#ddd'}">${[['#ea4335', 'Mail'], [null, name], ['#fbbc04', 'Recipes'], ['#34a853', 'Bank']].map(([c, l]) => `<div style="display:flex;gap:6px;align-items:center">${c ? blank(c) : fav(dark ? dark32 : light32)}${l}</div>`).join('')}</div>`;
  const ios = () => { const cell = (u, label, color) => `<div style="width:76px;text-align:center;color:#fff;font:11px -apple-system,system-ui;text-shadow:0 1px 2px rgba(0,0,0,.4)"><div style="width:60px;height:60px;margin:0 auto 5px;border-radius:13.4px;overflow:hidden;background:${u ? '#000' : color}">${u ? `<img src="${u}" style="width:60px;height:60px;display:block">` : ''}</div>${label}</div>`;
    const mine = touchUrl ? cell(touchUrl, name) : `<div style="width:76px;text-align:center;color:#fff;font:11px -apple-system,system-ui"><div style="width:60px;height:60px;margin:0 auto 5px;border-radius:13.4px;background:#ddd;color:#888;display:flex;align-items:center;justify-content:center;font-size:24px">${name[0] || '?'}</div>${name}<div style="color:#ffb3b3">no touch icon</div></div>`;
    return `<div style="width:340px;padding:24px 14px;border-radius:30px;background:linear-gradient(160deg,#4a6fa5,#c86b85 60%,#f0b27a);display:grid;grid-template-columns:repeat(4,76px);gap:18px 6px">${cell(null, 'Photos', '#f6c344')}${mine}${cell(null, 'Notes', '#fdd835')}${cell(null, 'Maps', '#5ac26a')}${cell(null, 'Mail', '#3a8ef6')}${cell(null, 'Clock', '#222')}${cell(null, 'Music', '#fa3c55')}${cell(null, 'Files', '#4aa3f5')}</div>`; };
  const androidIcon = (shape, s) => { const r = shape === 'circle' ? '50%' : shape === 'squircle' ? '32%' : '18%';
    return maskUrl ? `<div style="width:${s}px;height:${s}px;border-radius:${r};overflow:hidden"><img src="${maskUrl}" style="width:${s}px;height:${s}px;display:block"></div>`
      : `<div style="width:${s}px;height:${s}px;border-radius:${r};background:#fff;display:flex;align-items:center;justify-content:center">${anyUrl ? `<img src="${anyUrl}" style="width:${Math.round(s * 0.62)}px;height:${Math.round(s * 0.62)}px">` : ''}</div>`; };
  const android = (shape) => `<div style="width:300px;padding:18px 10px;border-radius:24px;background:linear-gradient(200deg,#1f3b4d,#3f6b5a);display:grid;grid-template-columns:repeat(4,70px);gap:14px 4px">${['#ea4335', null, '#4285f4', '#34a853'].map((c) => `<div style="text-align:center;color:#fff;font:11px Roboto,system-ui"><div style="width:52px;height:52px;margin:0 auto 4px">${c ? `<div style="width:52px;height:52px;border-radius:${shape === 'circle' ? '50%' : shape === 'squircle' ? '32%' : '18%'};background:${c}"></div>` : androidIcon(shape, 52)}</div>${c ? 'App' : name}</div>`).join('')}</div><div class="lab">${shape}</div>`;
  const safe = maskUrl ? `<div style="position:relative;width:192px;height:192px"><img src="${maskUrl}" style="width:192px;height:192px;display:block"><div style="position:absolute;inset:0;background:radial-gradient(circle at center,transparent 76.8px,rgba(255,0,60,.35) 77px)"></div><div style="position:absolute;left:19.2px;top:19.2px;width:153.6px;height:153.6px;border:2px dashed #ff2d55;border-radius:50%;box-sizing:border-box"></div></div><div class="lab">maskable, red: outside the safe circle (may be cut)</div>` : `<div class="miss" style="width:192px;height:192px">no maskable icon</div>`;
  const bgc = man?.background_color || '#fff', big = manIcons.filter((i) => i.purposes.includes('any')).sort((a, b) => (b.w || 0) - (a.w || 0))[0];
  const splash = `<div style="width:180px;height:360px;border-radius:24px;border:6px solid #111;background:${bgc};display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px">${big ? `<img src="${dataUrl(big.file)}" style="width:96px;height:96px">` : fav(anyUrl, 96)}<div style="font:14px Roboto,system-ui;color:${/^#(0|1|2|3)/i.test(bgc) ? '#fff' : '#333'}">${longName}</div></div><div class="lab">splash: background_color ${man?.background_color || '(none)'}</div>`;
  const install = `<div style="width:320px;padding:18px;border-radius:16px;background:#fff;box-shadow:0 4px 18px rgba(0,0,0,.25);font:13px system-ui;color:#202124"><div style="display:flex;gap:12px;align-items:center">${anyUrl ? `<img src="${anyUrl}" style="width:48px;height:48px;border-radius:8px">` : fav(null, 48)}<div><b>Install ${longName}?</b><div style="color:#5f6368">yoursite.com</div></div></div><div style="text-align:right;margin-top:14px;color:#1a73e8"><span style="margin-right:18px">Cancel</span><b>Install</b></div></div><div class="lab">desktop install prompt (uses an "any" icon)</div>`;
  const tc = T.theme[0]?.content || man?.theme_color;
  const css = `body{margin:0;font:14px/1.4 -apple-system,system-ui,sans-serif;background:#fff;color:#111}.sec{padding:20px 26px;border-bottom:1px solid #ddd}.sec h2{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:#666;margin:0 0 12px}.row{display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap}.col{display:flex;flex-direction:column;gap:10px}.lab{font-size:12px;color:#666;margin-top:6px}.miss{background:repeating-linear-gradient(45deg,#fdd,#fdd 8px,#fee 8px,#fee 16px);color:#a00;display:flex;align-items:center;justify-content:center;font-size:12px}`;
  let body = '';
  body += `<div class="sec"><h2>Browser tabs at 16 px (drawn 2× like a retina screen): Chrome and Safari, light and dark</h2><div class="row"><div class="col">${chromeTabs(false)}${chromeTabs(true)}</div><div class="col">${safariTabs(false)}${safariTabs(true)}</div></div></div>`;
  body += `<div class="sec"><h2>The real 16 pixels on a 1× screen, enlarged 4×, light and dark tab · a Google result · the bookmarks bar</h2><div class="row"><div>${pix(light16, '#fff')}${pix(dark16, '#35363a')}<div class="lab">${tab ? tab.rel : 'no favicon'}</div></div><div class="col">${google(false)}${google(true)}</div><div class="col">${bookmarks(false)}${bookmarks(true)}</div></div></div>`;
  body += `<div class="sec"><h2>iPhone home screen (touch icon at 60 pt; transparent parts turn black) · theme colour ${tc ? `<span style="display:inline-block;width:14px;height:14px;background:${tc};border:1px solid #999;vertical-align:middle"></span> ${tc}` : '(none)'}</h2><div class="row">${ios()}<div>${touchUrl ? `<img src="${touchUrl}" style="width:180px;height:180px;display:block;border:1px solid #ddd;background:repeating-conic-gradient(#eee 0 25%,#fff 0 50%) 0 0/16px 16px">` : '<div class="miss" style="width:180px;height:180px">no touch icon</div>'}<div class="lab">touch icon at 180 px (checkerboard = transparent)</div></div></div></div>`;
  body += `<div class="sec"><h2>Android home screen: circle, squircle and rounded-square masks${maskUrl ? '' : ' (no maskable icon: shrunk onto white)'}; and the maskable icon's safe zone</h2><div class="row"><div>${android('circle')}</div><div>${android('squircle')}</div><div>${android('rounded square')}</div><div>${safe}</div></div></div>`;
  body += `<div class="sec"><h2>Installed app: install prompt and splash screen</h2><div class="row"><div>${install}</div><div>${splash}</div></div></div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`;
}

// ---------- render HTML or SVG to a PNG at an exact square size ----------
export async function render(file, { out, size, alpha = false } = {}) {
  const [w, h] = String(size).includes('x') ? String(size).split('x').map(Number) : [Number(size), Number(size)];
  if (!w || !h) throw new Error('--size is required, e.g. --size 512 or --size 180x180');
  const browser = await launch();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
    const src = resolve(file);
    if (extname(src).toLowerCase() === '.svg') {
      // An SVG is drawn through a small page (file:// to file:// is allowed; about:blank to file:// isn't).
      const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os');
      const wrap = join(mkdtempSync(join(tmpdir(), 'web-icons-r-')), 'wrap.html');
      writeFileSync(wrap, `<html><body style="margin:0;background:transparent"><img src="${pathToFileURL(src).href}" style="width:${w}px;height:${h}px;display:block"></body></html>`);
      await page.goto(pathToFileURL(wrap).href, { waitUntil: 'load', timeout: 30000 });
      const okImg = await page.evaluate(() => { const i = document.images[0]; return i.complete && i.naturalWidth > 0; });
      if (!okImg) throw new Error(`${file} didn't load as an SVG image.`);
    } else await page.goto(pathToFileURL(src).href, { waitUntil: 'load', timeout: 30000 });
    await page.evaluate(() => document.fonts?.ready);
    await new Promise((ok) => setTimeout(ok, 150));
    if (!alpha) await page.evaluate(() => { const t = (e) => getComputedStyle(e).backgroundColor === 'rgba(0, 0, 0, 0)'; if (t(document.body) && t(document.documentElement)) document.documentElement.style.background = '#fff'; });
    mkdirSync(dirname(resolve(out)), { recursive: true });
    await page.screenshot({ path: out, type: 'png', omitBackground: alpha, clip: { x: 0, y: 0, width: w, height: h } });
    const info = imageInfo(readFileSync(out));
    return { ok: true, out, w: info.w, h: info.h, alpha: !!alpha };
  } finally { await browser.close(); }
}

// ---------- pack PNGs into a .ico ----------
export function packIco(pngs, out) {
  const imgs = pngs.map((p) => { const b = readFileSync(p), i = imageInfo(b); if (i.format !== 'png') throw new Error(`${p} isn't a PNG.`); if (i.w !== i.h || i.w > 256) throw new Error(`${p} is ${i.w}×${i.h}; ICO images must be square, 256 px or smaller.`); return { b, w: i.w }; }).sort((a, b) => a.w - b.w);
  const head = Buffer.alloc(6 + 16 * imgs.length); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(imgs.length, 4);
  let off = head.length;
  imgs.forEach((im, k) => { const o = 6 + 16 * k; head[o] = im.w >= 256 ? 0 : im.w; head[o + 1] = im.w >= 256 ? 0 : im.w; head[o + 2] = 0; head[o + 3] = 0; head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6); head.writeUInt32LE(im.b.length, o + 8); head.writeUInt32LE(off, o + 12); off += im.b.length; });
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(out, Buffer.concat([head, ...imgs.map((i) => i.b)]));
  return { ok: true, out, sizes: imgs.map((i) => `${i.w}x${i.w}`) };
}

// ---------- self-test ----------
async function selfTest() {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const d = mkdtempSync(join(tmpdir(), 'web-icons-'));
  const svg = (bg, fg, r) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${bg ? `<rect width="100" height="100" fill="${bg}"/>` : ''}<circle cx="50" cy="50" r="${r}" fill="${fg}"/></svg>`;
  // Broken: logo to the edge on a transparent background everywhere, no touch icon, manifest without 512 and display.
  const b = join(d, 'broken'); mkdirSync(join(b, 'icons'), { recursive: true });
  writeFileSync(join(b, 'mark.svg'), svg(null, '#222', 49));
  await render(join(b, 'mark.svg'), { out: join(b, 'icons/192.png'), size: 192, alpha: true });
  await render(join(b, 'mark.svg'), { out: join(b, 'icons/mask.png'), size: 384, alpha: true });
  writeFileSync(join(b, 'site.webmanifest'), JSON.stringify({ name: 'Broken Example Bakery', icons: [{ src: 'icons/192.png', sizes: '192x192', type: 'image/png' }, { src: 'icons/mask.png', sizes: '384x384', purpose: 'maskable' }] }));
  writeFileSync(join(b, 'index.html'), '<html><head><title>Broken</title><link rel="icon" href="mark.svg"><link rel="manifest" href="site.webmanifest"></head><body>hi</body></html>');
  const r1 = await check(b, { out: join(d, 'broken-look') });
  const ids = r1.issues.map((i) => i.id);
  for (const want of ['no-touch-icon', 'manifest-512', 'manifest-display', 'maskable-alpha', 'maskable-safe-zone', 'tab-dark', 'no-ico']) if (!ids.includes(want)) throw new Error('broken set: expected ' + want + ' in ' + ids.join(','));
  // Clean: dark-aware SVG + ico, opaque touch icon, 192/512 any + padded maskable, theme colour.
  const c = join(d, 'clean'); mkdirSync(join(c, 'icons'), { recursive: true });
  writeFileSync(join(c, 'icon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><style>.b{fill:#1a5d3a}@media (prefers-color-scheme:dark){.b{fill:#7fd8a3}}</style><rect class="b" width="100" height="100" rx="22"/><circle cx="50" cy="50" r="26" fill="#fff"/></svg>`);
  writeFileSync(join(c, 'full.svg'), svg('#1a5d3a', '#fff', 30));
  writeFileSync(join(c, 'mask.svg'), svg('#1a5d3a', '#fff', 24));
  for (const s of [16, 32, 48]) await render(join(c, 'full.svg'), { out: join(c, `icons/f${s}.png`), size: s });
  packIco([16, 32, 48].map((s) => join(c, `icons/f${s}.png`)), join(c, 'favicon.ico'));
  await render(join(c, 'full.svg'), { out: join(c, 'apple-touch-icon.png'), size: 180 });
  await render(join(c, 'full.svg'), { out: join(c, 'icons/192.png'), size: 192 });
  await render(join(c, 'full.svg'), { out: join(c, 'icons/512.png'), size: 512 });
  await render(join(c, 'mask.svg'), { out: join(c, 'icons/maskable-512.png'), size: 512 });
  writeFileSync(join(c, 'site.webmanifest'), JSON.stringify({ name: 'Clean Example', short_name: 'Clean', start_url: '/', display: 'standalone', theme_color: '#1a5d3a', background_color: '#ffffff', icons: [{ src: 'icons/192.png', sizes: '192x192', type: 'image/png' }, { src: 'icons/512.png', sizes: '512x512', type: 'image/png' }, { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }] }));
  writeFileSync(join(c, 'index.html'), '<html><head><title>Clean Example</title><link rel="icon" href="/favicon.ico" sizes="32x32"><link rel="icon" href="/icon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="manifest" href="/site.webmanifest"><meta name="theme-color" content="#1a5d3a"></head><body>hi</body></html>');
  const r2 = await check(c, { out: join(d, 'clean-look') });
  if (r2.issues.length) throw new Error('clean set flagged: ' + r2.issues.map((i) => i.id + ' ' + i.msg).join(' | '));
  const ico = imageInfo(readFileSync(join(c, 'favicon.ico')));
  if (ico.format !== 'ico' || ico.sizes.length !== 3) throw new Error('ico pack: ' + JSON.stringify(ico));
  console.log(`web-icons: all tests pass (broken: ${r1.errors} errors, ${r1.warnings} warnings; sheets ${r1.sheet} and ${r2.sheet})`);
}

if (typeof process !== 'undefined' && process.argv?.[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
  const VALUED = new Set(['--out', '--size', '--html']);
  const pos = argv.filter((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1]));
  const done = (r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); };
  const fail = (e) => { console.error(String(e.message || e)); process.exit(2); };
  if (argv.includes('--test')) selfTest().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
  else if (pos[0] === 'check' && pos[1]) check(pos[1], { html: opt('html', 'index.html'), out: opt('out', 'look/icons') }).then(done, fail);
  else if (pos[0] === 'render' && pos[1]) render(pos[1], { out: opt('out', 'icon.png'), size: opt('size'), alpha: argv.includes('--alpha') }).then(done, fail);
  else if (pos[0] === 'ico' && pos.length > 1) { try { done(packIco(pos.slice(1), opt('out', 'favicon.ico'))); } catch (e) { fail(e); } }
  else fail('usage: web-icons.mjs check <site folder> [--html index.html] [--out look/icons]\n       web-icons.mjs render <design.html|icon.svg> --size 512 --out icons/icon-512.png [--alpha]\n       web-icons.mjs ico 16.png 32.png 48.png --out favicon.ico');
}
