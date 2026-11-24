#!/usr/bin/env node
// Palm tool: chart-check — lets an agent see a chart or data graphic the way people will: at the size it's shown (a
// phone feed, a report page on a laptop, a slide in a video call), as colour-blind readers see it, in greyscale, and
// on a dark background when it's transparent. It measures what can be measured in the page (every label's size where
// it's shown, labels that collide or are cut off, bar charts whose value axis doesn't start at zero, how many colours
// the reader has to match, contrast) and draws a sheet to LOOK at.
// adds: tool. Runs on the user's machine with their Chrome/Edge/Chromium; nothing leaves it.
//
//   node chart-check.mjs check <chart.html|chart.svg|chart.png> [--use social|report|slide] [--out look/chart]
//       → JSON {ok, errors, warnings, size, shown_px, min_text_px, series, palette, issues, sheet}. Then LOOK at the sheet.
//   node chart-check.mjs --test
//
// --use (where the chart will be seen; it sets how wide it shows): social = a phone feed, 390 px wide (default);
// report = a page read on a laptop, the chart about 640 px wide; slide = a slide shared in a video call, about 960 px.
// HTML and SVG charts are measured in the page. Charts drawn on a <canvas> or given as PNG get the visual checks only
// (colours, colour vision, the sheet); their text sizes can't be measured, so look at the sheet.
//
// Sources and thresholds:
// - Contrast: WCAG 2.2 1.4.3 (text 4.5:1, large text 3:1) and 1.4.11 non-text contrast (parts of graphics needed to
//   understand them, 3:1 against what's next to them), https://www.w3.org/TR/WCAG22/.
// - Colour-vision simulation: Machado, Oliveira & Fernandes (2009), severity 1.0 (protanopia, deuteranopia, tritanopia);
//   colour difference: CIEDE2000.
// - Palm's guidance, not a published standard: text shown under 8 px is unreadable (error), under 11 px hard to read
//   (warning); two series closer than ΔE00 10 under a colour-vision type, or 5 for everyone, are easy to confuse;
//   more than 6 colours to match against a legend is a lot; a bar chart's value axis should start at zero (bars
//   compare lengths; a cut axis exaggerates differences).

import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve, extname } from 'node:path';
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
const launch = () => loadPuppeteer().launch({ executablePath: findChrome(), headless: true, timeout: 90000, protocolTimeout: 120000, args: ['--no-sandbox', '--hide-scrollbars', '--allow-file-access-from-files'] });
const go = async (page, url) => { try { await page.goto(url, { waitUntil: 'networkidle0', timeout: 45000 }); } catch (e) { if (!/timeout/i.test(String(e))) throw e; } await new Promise((r) => setTimeout(r, 400)); };

export const USES = { social: { shown: 390, label: 'in a phone feed (390 px wide)' }, report: { shown: 640, label: 'in a report read on a laptop (about 640 px wide)' }, slide: { shown: 960, label: 'on a slide shared in a video call (about 960 px wide)' } };
export const LIMITS = { errPx: 8, warnPx: 11, cvdDE: 10, allDE: 5, greyDL: 8, series: 6, nonText: 3, text: 4.5, textLarge: 3 };

// ---------- colour science ----------
const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const unlin = (c) => Math.round(255 * Math.min(1, Math.max(0, c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)));
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
export const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
export const CVD = {
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
  tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]],
};
export function simulate(rgb, type) {
  if (type === 'greyscale') { const y = unlin(lum(rgb)); return [y, y, y]; }
  const m = CVD[type]; const l = rgb.map(lin);
  return m.map((row) => unlin(row[0] * l[0] + row[1] * l[1] + row[2] * l[2]));
}
function lab(rgb) {
  const [r, g, b] = rgb.map(lin);
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047, y = r * 0.2126 + g * 0.7152 + b * 0.0722, z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}
export function deltaE(a, b) { // CIEDE2000
  const [L1, a1, b1] = lab(a), [L2, a2, b2] = lab(b);
  const rad = Math.PI / 180, C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cm = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)));
  const ap1 = (1 + G) * a1, ap2 = (1 + G) * a2, Cp1 = Math.hypot(ap1, b1), Cp2 = Math.hypot(ap2, b2);
  const h = (bb, ap) => { if (!bb && !ap) return 0; const d = Math.atan2(bb, ap) / rad; return d < 0 ? d + 360 : d; };
  const hp1 = h(b1, ap1), hp2 = h(b2, ap2);
  const dL = L2 - L1, dC = Cp2 - Cp1;
  let dh = 0; if (Cp1 * Cp2) { dh = hp2 - hp1; if (dh > 180) dh -= 360; else if (dh < -180) dh += 360; }
  const dH = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin((dh / 2) * rad);
  const Lm = (L1 + L2) / 2, Cpm = (Cp1 + Cp2) / 2;
  let hm = hp1 + hp2; if (Cp1 * Cp2) { hm = Math.abs(hp1 - hp2) > 180 ? (hp1 + hp2 + (hp1 + hp2 < 360 ? 360 : -360)) / 2 : (hp1 + hp2) / 2; }
  const T = 1 - 0.17 * Math.cos((hm - 30) * rad) + 0.24 * Math.cos(2 * hm * rad) + 0.32 * Math.cos((3 * hm + 6) * rad) - 0.2 * Math.cos((4 * hm - 63) * rad);
  const dTh = 30 * Math.exp(-(((hm - 275) / 25) ** 2)), Rc = 2 * Math.sqrt(Cpm ** 7 / (Cpm ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lm - 50) ** 2) / Math.sqrt(20 + (Lm - 50) ** 2), Sc = 1 + 0.045 * Cpm, Sh = 1 + 0.015 * Cpm * T, Rt = -Math.sin(2 * dTh * rad) * Rc;
  return Math.sqrt((dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2 + Rt * (dC / Sc) * (dH / Sh));
}
const chroma = (rgb) => { const [, a, b] = lab(rgb); return Math.hypot(a, b); };
const hex = (rgb) => '#' + rgb.map((c) => c.toString(16).padStart(2, '0')).join('');
const parseColor = (s) => { const m = String(s || '').match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); if (p.length > 3 && p[3] < 0.4) return null; return p.slice(0, 3).map(Math.round); };

// ---------- in the page ----------
// The graphic's box: everything visible (the root <svg> for an SVG file).
const BOX = () => {
  const root = document.documentElement;
  if (root.tagName.toLowerCase() === 'svg') { const r = root.getBoundingClientRect(); return { x: 0, y: 0, w: Math.ceil(r.width), h: Math.ceil(r.height), svgRoot: true }; }
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, n = 0;
  for (const e of document.body.querySelectorAll('*')) {
    const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const tag = e.tagName.toLowerCase(); const r = e.getBoundingClientRect(); if (r.width < 1 || r.height < 1) continue;
    const painted = ['svg', 'canvas', 'img'].includes(tag) || (parseFloat((cs.backgroundColor.match(/[\d.]+/g) || [0, 0, 0, 0])[3] ?? 1) > 0 && cs.backgroundColor !== 'rgba(0, 0, 0, 0)') || [...e.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim());
    if (!painted) continue;
    if (e.closest('svg') && tag !== 'svg') continue;
    x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top); x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom); n++;
  }
  if (!n) return { x: 0, y: 0, w: innerWidth, h: innerHeight };
  const bodyBg = getComputedStyle(document.body).backgroundColor;
  return { x: Math.max(0, Math.floor(x0)), y: Math.max(0, Math.floor(y0)), w: Math.ceil(x1 - Math.max(0, x0)), h: Math.ceil(y1 - Math.max(0, y0)), bodyBg };
};
const MEASURE = (box) => {
  const texts = [];
  const w = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = w.nextNode())) {
    const t = node.textContent.replace(/\s+/g, ' ').trim(); if (!t) continue;
    const p = node.parentElement; if (!p || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TITLE', 'DESC'].includes(p.tagName.toUpperCase())) continue;
    const cs = getComputedStyle(p); if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    let op = 1; for (let a = p; a && a.nodeType === 1; a = a.parentElement) op *= +getComputedStyle(a).opacity || 1; if (op < 0.1) continue;
    let r; const inSvg = !!p.closest('svg');
    if (inSvg) r = p.getBoundingClientRect(); else { const rg = document.createRange(); rg.selectNodeContents(node); const rs = [...rg.getClientRects()].filter((x) => x.width > 0.5); if (!rs.length) continue; r = rs.reduce((a, x) => ({ left: Math.min(a.left, x.left), top: Math.min(a.top, x.top), right: Math.max(a.right, x.right), bottom: Math.max(a.bottom, x.bottom) }), { left: 1e9, top: 1e9, right: -1e9, bottom: -1e9 }); }
    if (r.right - r.left < 0.5) continue;
    let px = parseFloat(cs.fontSize);
    if (inSvg) { const ctm = p.getScreenCTM?.(); if (ctm) px *= Math.hypot(ctm.a, ctm.b); }
    else { let s = 1; for (let a = p; a && a !== document.documentElement; a = a.parentElement) { const tf = getComputedStyle(a).transform; if (tf && tf !== 'none') { const m = tf.match(/matrix\(([^)]+)\)/); if (m) { const v = m[1].split(',').map(Number); s *= Math.hypot(v[0], v[1]); } } } px *= s; }
    const fill = inSvg ? (cs.fill && cs.fill !== 'none' ? cs.fill : cs.color) : cs.color;
    texts.push({ t: t.slice(0, 50), px: Math.round(px * 10) / 10, weight: +cs.fontWeight || 400, color: fill, x0: r.left - box.x, y0: r.top - box.y, x1: r.right - box.x, y1: r.bottom - box.y, rot: /matrix|rotate/.test(p.getAttribute?.('transform') || '') || (cs.transform && cs.transform !== 'none') });
  }
  // shapes that carry data: fills and strokes, weighted by area or length
  const shapes = [];
  for (const e of document.querySelectorAll('svg rect, svg path, svg circle, svg ellipse, svg polygon, svg polyline, svg line')) {
    const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = e.getBoundingClientRect(); if (r.width < 0.5 && r.height < 0.5) continue;
    const op = (+cs.opacity || 1) * 1;
    const fillOp = +cs.fillOpacity, strokeOp = +cs.strokeOpacity;
    const tag = e.tagName.toLowerCase();
    if (cs.fill && cs.fill !== 'none' && !['line', 'polyline'].includes(tag) && fillOp * op > 0.35) shapes.push({ tag, kind: 'fill', color: cs.fill, w: r.width, h: r.height, x0: r.left - box.x, y0: r.top - box.y, x1: r.right - box.x, y1: r.bottom - box.y, weight: r.width * r.height });
    const sw = parseFloat(cs.strokeWidth) || 0;
    if (cs.stroke && cs.stroke !== 'none' && sw >= 1 && strokeOp * op > 0.35) { let len = 0; try { len = e.getTotalLength?.() || Math.hypot(r.width, r.height); } catch { len = Math.hypot(r.width, r.height); } shapes.push({ tag, kind: 'stroke', color: cs.stroke, sw, w: r.width, h: r.height, x0: r.left - box.x, y0: r.top - box.y, x1: r.right - box.x, y1: r.bottom - box.y, weight: len * sw }); }
  }
  // HTML bars (divs with a background colour), as some charts are made
  for (const e of document.body?.querySelectorAll('div, span, li, i, b') || []) {
    if (e.closest('svg')) continue;
    const cs = getComputedStyle(e); const c = cs.backgroundColor; if (!c || c === 'rgba(0, 0, 0, 0)' || c === 'transparent') continue;
    const r = e.getBoundingClientRect(); if (r.width < 2 || r.height < 2 || (r.width > box.w * 0.9 && r.height > box.h * 0.5)) continue;
    if ([...e.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim().length > 3)) continue;
    shapes.push({ tag: 'div', kind: 'fill', color: c, w: r.width, h: r.height, x0: r.left - box.x, y0: r.top - box.y, x1: r.right - box.x, y1: r.bottom - box.y, weight: r.width * r.height });
  }
  const canvases = [...document.querySelectorAll('canvas')].filter((c) => c.getBoundingClientRect().width > 50).length;
  return { texts, shapes, canvases };
};

// Pixel work in the page: the most common colour (the background), colour clusters, and simulated images.
const PIXELS = async ({ src, sims }) => {
  const img = new Image(); img.src = src; await img.decode();
  const mk = () => document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas'); // an SVG document's createElement makes SVG elements
  const c = mk(); c.width = img.width; c.height = img.height;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  const bins = new Map(); let transparent = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) { transparent++; continue; }
    const k = ((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3);
    bins.set(k, (bins.get(k) || 0) + 1);
  }
  const total = d.length / 4;
  const top = [...bins.entries()].sort((a, b) => b[1] - a[1]).slice(0, 400).map(([k, n]) => ({ rgb: [((k >> 10) & 31) * 8 + 4, ((k >> 5) & 31) * 8 + 4, (k & 31) * 8 + 4], n }));
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const unlin = (v) => Math.round(255 * Math.min(1, Math.max(0, v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)));
  const out = {};
  for (const [name, m] of Object.entries(sims)) {
    const o = g.createImageData(c.width, c.height); const od = o.data;
    for (let i = 0; i < d.length; i += 4) {
      const r = lin(d[i]), gg = lin(d[i + 1]), b = lin(d[i + 2]);
      if (m === 'grey') { const y = unlin(0.2126 * r + 0.7152 * gg + 0.0722 * b); od[i] = od[i + 1] = od[i + 2] = y; }
      else { od[i] = unlin(m[0][0] * r + m[0][1] * gg + m[0][2] * b); od[i + 1] = unlin(m[1][0] * r + m[1][1] * gg + m[1][2] * b); od[i + 2] = unlin(m[2][0] * r + m[2][1] * gg + m[2][2] * b); }
      od[i + 3] = d[i + 3];
    }
    const cc = mk(); cc.width = c.width; cc.height = c.height; cc.getContext('2d').putImageData(o, 0, 0);
    out[name] = cc.toDataURL('image/png');
  }
  return { w: c.width, h: c.height, total, transparent, top, sims: out };
};

// ---------- analysis in Node ----------
function clusterColors(list, minDE = 3) {
  const out = [];
  for (const x of list.sort((a, b) => b.weight - a.weight)) {
    const hit = out.find((o) => deltaE(o.rgb, x.rgb) < minDE);
    if (hit) hit.weight += x.weight; else out.push({ rgb: x.rgb, weight: x.weight });
  }
  return out;
}
const numVal = (t) => { const s = t.replace(/[\u2212–]/g, '-').replace(/[£$€¥,\s]/g, ''); const m = s.match(/^(-?\d+(?:\.\d+)?)([kKmM%]?)$/); if (!m) return null; return +m[1] * (m[2] === 'k' || m[2] === 'K' ? 1e3 : m[2] === 'm' || m[2] === 'M' ? 1e6 : 1); };

export function analyse({ box, texts, shapes, canvases, pixels, use = 'social', bg }) {
  const issues = []; const add = (id, level, msg, extra = {}) => issues.push({ id, level, msg, ...extra });
  const shown = USES[use]?.shown || 390, k = shown / box.w;
  // text sizes where it's shown
  const tx = texts.map((t) => ({ ...t, shown_px: Math.round(t.px * k * 10) / 10 }));
  const minText = tx.length ? Math.min(...tx.map((t) => t.shown_px)) : null;
  const tiny = tx.filter((t) => t.shown_px < LIMITS.errPx), small = tx.filter((t) => t.shown_px >= LIMITS.errPx && t.shown_px < LIMITS.warnPx);
  if (tiny.length) add('text-tiny', 'error', `${tiny.length} label${tiny.length > 1 ? 's' : ''} show under ${LIMITS.errPx} px ${USES[use].label} (smallest ${Math.min(...tiny.map((t) => t.shown_px))} px: "${tiny.sort((a, b) => a.shown_px - b.shown_px)[0].t}"). Nobody can read that.`, { where: tiny.slice(0, 8).map((t) => t.t) });
  if (small.length) add('text-small', 'warn', `${small.length} label${small.length > 1 ? 's' : ''} show at ${LIMITS.errPx}–${LIMITS.warnPx} px ${USES[use].label}: hard to read (Palm's guidance).`, { where: small.slice(0, 8).map((t) => t.t) });
  // collisions and clipping
  const coll = [];
  for (let i = 0; i < tx.length; i++) for (let j = i + 1; j < tx.length; j++) {
    const a = tx[i], b = tx[j];
    const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    if (ox <= 0 || oy <= 0) continue;
    const small = Math.min((a.x1 - a.x0) * (a.y1 - a.y0), (b.x1 - b.x0) * (b.y1 - b.y0));
    if (small > 0 && (ox * oy) / small > 0.2) coll.push(`"${a.t}" / "${b.t}"`);
  }
  if (coll.length) add('text-collide', 'error', `${coll.length} pair${coll.length > 1 ? 's' : ''} of labels overlap: ${coll.slice(0, 4).join('; ')}.`, { where: coll.slice(0, 8) });
  const cut = tx.filter((t) => t.x0 < -2 || t.y0 < -2 || t.x1 > box.w + 2 || t.y1 > box.h + 2);
  if (cut.length) add('text-cut', 'error', `${cut.length} label${cut.length > 1 ? 's are' : ' is'} cut off at the edge: ${cut.slice(0, 4).map((t) => `"${t.t}"`).join(', ')}.`);
  // series colours: from the shapes when there are any, else from the pixels
  // A shape spanning most of the chart is a background or plot panel, not data; it also gives the exact background.
  const panel = (s) => s.kind === 'fill' && s.w >= box.w * 0.8 && s.h >= box.h * 0.5;
  const bigPanel = shapes.filter(panel).sort((a, b) => b.w * b.h - a.w * a.h)[0];
  const bgRgb = (bigPanel && bigPanel.w >= box.w * 0.95 && parseColor(bigPanel.color)) || bg;
  let cands = [];
  for (const s of shapes) {
    if (panel(s)) continue;
    const rgb = parseColor(s.color); if (!rgb) continue;
    if (bgRgb && deltaE(rgb, bgRgb) < 4) continue;
    const longLine = s.kind === 'stroke' && (s.w > box.w * 0.7 && s.h < 3 || s.h > box.h * 0.7 && s.w < 3);
    if (longLine && chroma(rgb) < 12) continue; // gridlines and axes
    cands.push({ rgb, weight: s.weight });
  }
  const fromDom = cands.length > 0;
  if (!fromDom && pixels) {
    const nonBg = pixels.total - pixels.transparent;
    cands = pixels.top.filter((p) => (!bgRgb || deltaE(p.rgb, bgRgb) > 6) && chroma(p.rgb) >= 15 && p.n / nonBg > 0.002).map((p) => ({ rgb: p.rgb, weight: p.n }));
  }
  let palette = clusterColors(cands, fromDom ? 3 : 8);
  const totalW = palette.reduce((a, p) => a + p.weight, 0) || 1;
  // In the page every colour drawn as a real shape counts (a legend swatch is small but is a series); from pixels, only
  // colours with a real share (anti-aliasing makes many tiny ones).
  palette = palette.filter((p) => (fromDom ? p.weight >= 60 : p.weight / totalW > 0.02)).slice(0, 12);
  const series = palette.length;
  if (series > LIMITS.series) add('many-colours', 'warn', `${series} different data colours: readers have to match that many against a legend (Palm's guidance: 6 at most; label lines and bars directly, or group the small ones as "Other").`);
  const pairs = (sim) => { const cols = palette.map((p) => (sim === 'normal' ? p.rgb : simulate(p.rgb, sim))); const out = []; for (let i = 0; i < cols.length; i++) for (let j = i + 1; j < cols.length; j++) out.push({ a: hex(palette[i].rgb), b: hex(palette[j].rgb), de: sim === 'greyscale' ? Math.abs(lab(cols[i])[0] - lab(cols[j])[0]) : deltaE(cols[i], cols[j]) }); return out; };
  const confusions = {};
  for (const sim of ['normal', 'protanopia', 'deuteranopia', 'tritanopia', 'greyscale']) {
    const lim = sim === 'normal' ? LIMITS.allDE : sim === 'greyscale' ? LIMITS.greyDL : LIMITS.cvdDE;
    const bad = pairs(sim).filter((p) => p.de < lim);
    if (bad.length) confusions[sim] = bad.map((p) => `${p.a}~${p.b} (${p.de.toFixed(1)})`);
  }
  if (confusions.normal) add('colours-alike', 'error', `Series colours anyone can confuse: ${confusions.normal.join(', ')} (CIEDE2000 under ${LIMITS.allDE}).`);
  const cvdHits = ['protanopia', 'deuteranopia', 'tritanopia'].filter((s) => confusions[s]);
  if (cvdHits.length) add('colour-blind', cvdHits.some((s) => s !== 'tritanopia') ? 'error' : 'warn', `Colour-blind readers can't tell series apart: ${cvdHits.map((s) => `${s} ${confusions[s].slice(0, 3).join(', ')}`).join('; ')} (CIEDE2000 under ${LIMITS.cvdDE}; about 1 in 12 men has red-green colour blindness). Change one of each pair's lightness, not just its hue, or label the series directly.`);
  if (confusions.greyscale) add('greyscale', 'warn', `In greyscale (printed in black and white, or a grey-only screen) these series look the same: ${confusions.greyscale.slice(0, 3).join(', ')} (lightness difference under ${LIMITS.greyDL}).`);
  if (bgRgb) {
    const faint = palette.filter((p) => contrast(p.rgb, bgRgb) < LIMITS.nonText);
    if (faint.length) add('series-faint', 'warn', `${faint.length} data colour${faint.length > 1 ? 's are' : ' is'} under 3:1 against the background (${faint.map((p) => `${hex(p.rgb)} ${contrast(p.rgb, bgRgb).toFixed(1)}:1`).join(', ')}); WCAG 1.4.11 asks 3:1 for parts of a graphic needed to understand it.`);
  }
  // text contrast against the background
  if (bgRgb) {
    const low = tx.filter((t) => { const c = parseColor(t.color); if (!c) return false; const large = t.px * k >= 24 || (t.px * k >= 18.66 && t.weight >= 700); return contrast(c, bgRgb) < (large ? LIMITS.textLarge : LIMITS.text); });
    if (low.length) add('text-contrast', 'warn', `${low.length} label${low.length > 1 ? 's' : ''} under WCAG 1.4.3's contrast against the background (4.5:1, large text 3:1): ${low.slice(0, 3).map((t) => `"${t.t}"`).join(', ')}.`);
  }
  // bar charts whose value axis doesn't start at zero
  const bars = shapes.filter((s) => s.kind === 'fill' && ['rect', 'div', 'path'].includes(s.tag) && s.w >= 3 && s.h >= 3 && s.w < box.w * 0.6 && s.h < box.h * 0.95);
  const nums = tx.map((t) => ({ ...t, v: numVal(t.t), xc: (t.x0 + t.x1) / 2, yc: (t.y0 + t.y1) / 2 })).filter((t) => t.v != null);
  let axis = null;
  // Bars share a baseline and differ in length (legend swatches share a line too, but are all the same size).
  const group = (key, len) => { const m = new Map(); for (const b of bars) { const v = Math.round(key(b) / 2) * 2; m.set(v, [...(m.get(v) || []), b]); } return [...m.entries()].filter(([, g]) => g.length >= 3 && new Set(g.map((b) => Math.round(len(b) / 2))).size >= 2).sort((a, b) => b[1].length - a[1].length)[0]; };
  const vert = group((b) => b.y1, (b) => b.h), horiz = group((b) => b.x0, (b) => b.w);
  if (vert && (!horiz || vert[1].length >= horiz[1].length)) {
    const base = vert[0], left = Math.min(...vert[1].map((b) => b.x0));
    const ticks = nums.filter((t) => t.x1 <= left + 4 && !t.rot).sort((a, b) => b.yc - a.yc);
    if (ticks.length >= 2) { axis = { kind: 'vertical bars', lowest: ticks[0].v }; if (Math.abs(ticks[0].yc - base) < box.h * 0.06 && ticks[0].v !== 0) add('axis-not-zero', 'error', `The bars start at ${ticks[0].t}, not 0: bar lengths then exaggerate the differences (Palm's guidance: a bar chart's value axis starts at zero; use a line or dot chart to zoom in).`); }
  } else if (horiz) {
    const base = horiz[0], bottom = Math.max(...horiz[1].map((b) => b.y1));
    const ticks = nums.filter((t) => t.y0 >= bottom - 4).sort((a, b) => a.xc - b.xc);
    if (ticks.length >= 2) { axis = { kind: 'horizontal bars', lowest: ticks[0].v }; if (Math.abs(ticks[0].xc - base) < box.w * 0.06 && ticks[0].v !== 0) add('axis-not-zero', 'error', `The bars start at ${ticks[0].t}, not 0: bar lengths then exaggerate the differences (Palm's guidance: a bar chart's value axis starts at zero).`); }
  }
  // Text drawn as outlines (matplotlib's default SVG, or text converted to paths) can't be measured: say so, as for canvas.
  if (!canvases && !texts.length && shapes.length > 3) add('text-outlines', 'warn', `No text found in the chart: its labels are drawn as outlines (paths), so their sizes can't be measured here. Look at the sheet for small or overlapping labels, or keep text as text (matplotlib: plt.rcParams['svg.fonttype'] = 'none').`);
  if (canvases && !texts.length) add('canvas', 'warn', `The chart is drawn on a <canvas>, so its labels can't be measured here: look at the sheet for small or overlapping text (or draw it as SVG to have it measured).`);
  return { background: bgRgb ? hex(bgRgb) : null, shown_px: shown, min_text_px: minText, texts: tx.length, series, palette: palette.map((p) => ({ hex: hex(p.rgb), share: Math.round((p.weight / totalW) * 1000) / 10 })), confusions, axis, issues };
}

// ---------- check ----------
export async function check(target, { use = 'social', out = 'look/chart', plain = false } = {}) {
  const file = resolve(target);
  if (!existsSync(file)) throw new Error('No such file: ' + target);
  if (!USES[use]) throw new Error('--use must be social, report or slide');
  const ext = extname(file).toLowerCase();
  mkdirSync(resolve(out, '..'), { recursive: true });
  const browser = await launch();
  try {
    const page = await browser.newPage();
    let url = pathToFileURL(file).href, isImg = /\.(png|jpe?g|webp)$/.test(ext);
    if (isImg) { const tmp = mkdtempSync(join(tmpdir(), 'chart-')); writeFileSync(join(tmp, 'i.html'), `<html><body style="margin:0"><img src="${url}" style="display:block"></body></html>`); url = pathToFileURL(join(tmp, 'i.html')).href; }
    let vw = 1600, vh = 1200;
    if (ext === '.svg') {
      // width/height may carry units (matplotlib writes "777.6pt"): convert to CSS px as the browser does.
      const s = readFileSync(file, 'utf8'), UNIT = { px: 1, pt: 4 / 3, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, '': 1 };
      const dim = (k) => { const m = s.match(new RegExp(`<svg[^>]*\\s${k}="([\\d.]+)(px|pt|pc|in|cm|mm)?"`)); return m ? +m[1] * UNIT[m[2] || ''] : 0; };
      const vb = (s.match(/viewBox="([^"]+)"/) || [])[1]?.split(/[ ,]+/).map(Number);
      vw = Math.ceil(dim('width') || vb?.[2] || 1200); vh = Math.ceil(dim('height') || vb?.[3] || 800);
    }
    await page.setViewport({ width: vw, height: vh, deviceScaleFactor: 1 });
    await go(page, url);
    if (ext !== '.svg') { const sz = await page.evaluate(() => ({ w: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0), h: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0) })); if (sz.w > vw || sz.h > vh) { await page.setViewport({ width: Math.min(4000, Math.max(vw, sz.w)), height: Math.min(6000, Math.max(vh, sz.h)), deviceScaleFactor: 1 }); await new Promise((r) => setTimeout(r, 300)); } }
    const box = await page.evaluate(BOX);
    if (box.w < 20 || box.h < 20) throw new Error('Nothing visible to check in ' + target);
    const m = isImg ? { texts: [], shapes: [], canvases: 0 } : await page.evaluate(MEASURE, box);
    const clip = { x: box.x, y: box.y, width: box.w, height: box.h };
    const shot = Buffer.from(await page.screenshot({ clip, omitBackground: true })).toString('base64');
    const pix = await page.evaluate(PIXELS, { src: 'data:image/png;base64,' + shot, sims: { protanopia: CVD.protanopia, deuteranopia: CVD.deuteranopia, tritanopia: CVD.tritanopia, greyscale: 'grey' } });
    const mostCommon = pix.top[0]?.rgb || [255, 255, 255];
    const transparent = pix.transparent / pix.total > 0.3;
    const bg = transparent ? null : mostCommon;
    const r = analyse({ box, texts: m.texts, shapes: m.shapes, canvases: m.canvases, pixels: pix, use, bg: bg || [255, 255, 255] });
    let darkIssues = [];
    if (transparent) {
      const darkBg = [28, 28, 30];
      const unseen = m.texts.filter((t) => { const c = parseColor(t.color); return c && contrast(c, darkBg) < 3; });
      if (unseen.length) darkIssues.push({ id: 'dark-mode', level: 'warn', msg: `The chart has a transparent background: on a dark page or in dark mode ${unseen.length} label${unseen.length > 1 ? 's' : ''} (${unseen.slice(0, 3).map((t) => `"${t.t}"`).join(', ')}) all but vanish. Give it a solid background.` });
    }
    const issues = [...r.issues, ...darkIssues];
    // the sheet
    const sheet = resolve(out + '-sheet.png');
    const shotUrl = 'data:image/png;base64,' + shot;
    const shownW = USES[use].shown;
    const marks = plain ? '' : issues.filter((i) => i.id === 'text-tiny' || i.id === 'text-collide' || i.id === 'text-cut').length ? m.texts.filter((t) => t.px * (shownW / box.w) < LIMITS.errPx || t.x0 < -2 || t.x1 > box.w + 2).map((t) => `<div style="position:absolute;left:${(t.x0 / box.w) * 100}%;top:${(t.y0 / box.h) * 100}%;width:${((t.x1 - t.x0) / box.w) * 100}%;height:${((t.y1 - t.y0) / box.h) * 100}%;outline:2px solid #e0103a"></div>`).join('') : '';
    const big = Math.min(900, box.w);
    const ctx = use === 'social'
      ? `<div class="phone"><div class="ph-top"><b>yourbrand</b><span>· 2h</span></div><img src="${shotUrl}" style="width:390px;display:block"><div class="ph-cap"><b>yourbrand</b> Here's how this year went…</div></div>`
      : use === 'report'
        ? `<div class="laptop"><div class="pg"><div class="ln" style="width:70%"></div><div class="ln"></div><div class="ln" style="width:85%"></div><img src="${shotUrl}" style="width:640px;display:block;margin:16px 0"><div class="ln"></div><div class="ln" style="width:60%"></div></div></div>`
        : `<div class="call"><div class="faces"><i></i><i></i><i></i></div><div class="slide"><img src="${shotUrl}" style="max-width:960px;max-height:540px;display:block;margin:auto"></div></div>`;
    const sim = (k, label) => `<figure><img src="${pix.sims[k]}" style="width:300px;display:block;${transparent ? 'background:#fff' : ''}"><figcaption>${label}</figcaption></figure>`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:28px;background:#ecebe8;font:14px/1.4 -apple-system,Helvetica,Arial,sans-serif;color:#222;width:${Math.max(1100, big + 80)}px}h2{font:600 12px/1 -apple-system,Helvetica;letter-spacing:.08em;text-transform:uppercase;color:#666;margin:28px 0 10px}figure{margin:0 16px 0 0;display:inline-block;vertical-align:top}figcaption{font-size:12px;color:#666;margin-top:4px}.full{position:relative;display:inline-block;background:${transparent ? 'repeating-conic-gradient(#ddd 0 25%,#fff 0 50%) 0 0/16px 16px' : 'transparent'}}.phone{width:390px;background:#fff;border-radius:28px;padding:14px 0 18px;border:8px solid #111}.ph-top{padding:0 12px 10px;font-size:13px}.ph-top span{color:#888}.ph-cap{padding:10px 12px 0;font-size:13px}.laptop{background:#2b2b2e;padding:22px;border-radius:12px;display:inline-block}.pg{background:#fff;width:720px;padding:36px 40px}.ln{height:8px;background:#ddd;border-radius:4px;margin:8px 0;width:100%}.call{background:#1f1f22;padding:14px;border-radius:12px;display:inline-flex;gap:12px;align-items:center}.faces{display:flex;flex-direction:column;gap:10px}.faces i{width:150px;height:96px;border-radius:8px;background:#3a3a40;display:block}.slide{width:960px;height:540px;background:#fff;display:flex;align-items:center}.dark{background:#1c1c1e;padding:20px;display:inline-block;border-radius:8px}</style></head><body>
<h2>As made (${box.w}×${box.h})</h2><div class="full" style="width:${big}px"><img src="${shotUrl}" style="width:${big}px;display:block">${marks}</div>
<h2>Where it's seen: ${USES[use].label}</h2>${ctx}
<h2>As colour-blind readers and greyscale see it</h2>${sim('protanopia', 'Protanopia (red-blind)')}${sim('deuteranopia', 'Deuteranopia (green-blind)')}${sim('tritanopia', 'Tritanopia (blue-blind)')}${sim('greyscale', 'Greyscale (black-and-white print)')}
${transparent ? `<h2>On a dark background (transparent chart)</h2><div class="dark"><img src="${shotUrl}" style="width:${Math.min(600, box.w)}px;display:block"></div>` : ''}
</body></html>`;
    const sp = await browser.newPage(); await sp.setViewport({ width: Math.max(1160, big + 140), height: 1000, deviceScaleFactor: 1 });
    await sp.setContent(html, { waitUntil: 'load' }); await new Promise((res) => setTimeout(res, 200));
    await sp.screenshot({ path: sheet, fullPage: true });
    const errors = issues.filter((i) => i.level === 'error').length, warnings = issues.filter((i) => i.level === 'warn').length;
    return { ok: errors === 0, errors, warnings, file: target, use, size: `${box.w}x${box.h}`, measured: !isImg && m.texts.length > 0, transparent, ...r, issues, sheet };
  } finally { await browser.close(); }
}

// ---------- self-test ----------
async function selfTest() {
  // colour science sanity
  if (Math.abs(deltaE([255, 0, 0], [255, 0, 0])) > 1e-9) throw new Error('deltaE same colour not 0');
  const de = deltaE([50, 2.6772 * 0 + 128, 128], [50, 128, 128]); if (de > 0.5) throw new Error('deltaE near-identical ' + de);
  const rg = deltaE(simulate([213, 94, 0], 'deuteranopia'), simulate([0, 158, 115], 'deuteranopia')); // vermillion vs bluish green stay apart
  const bad = deltaE(simulate([220, 50, 47], 'deuteranopia'), simulate([60, 160, 60], 'deuteranopia'));
  if (!(bad < rg)) throw new Error(`deuteranopia: red/green ${bad.toFixed(1)} should be closer than Okabe-Ito pair ${rg.toFixed(1)}`);
  const d = mkdtempSync(join(tmpdir(), 'chart-test-'));
  // a bad chart: tiny labels, red vs green, a bar axis from 40, 8 series in a legend, a label off the edge, overlap
  const cols = ['#d62728', '#2ca02c', '#1f77b4', '#ff7f0e', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f'];
  const bars = [62, 58, 71, 49, 66, 44].map((v, i) => `<rect x="${80 + i * 140}" y="${600 - (v - 40) * 20}" width="100" height="${(v - 40) * 20}" fill="${cols[i % 2]}"/>`).join('');
  const ticks = [40, 50, 60, 70, 80].map((v) => `<text x="60" y="${600 - (v - 40) * 13.3 + 4}" font-size="11" text-anchor="end">${v}</text>`).join('');
  const legend = cols.map((c, i) => `<rect x="${60 + i * 120}" y="640" width="14" height="14" fill="${c}"/><text x="${80 + i * 120}" y="652" font-size="11">Series ${i + 1}</text>`).join('');
  writeFileSync(join(d, 'bad.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="700" viewBox="0 0 1080 700"><rect width="1080" height="700" fill="#fff"/>${bars}${ticks}${legend}<text x="1040" y="40" font-size="30">Sales by month, far right</text><text x="100" y="660" font-size="12">Overlap A</text><text x="104" y="662" font-size="12">Overlap B</text></svg>`);
  const b = await check(join(d, 'bad.svg'), { use: 'social', out: join(d, 'look/bad') });
  const ids = new Set(b.issues.map((i) => i.id));
  for (const want of ['text-tiny', 'colour-blind', 'axis-not-zero', 'many-colours', 'text-cut', 'text-collide']) if (!ids.has(want)) throw new Error(`bad chart: expected ${want}, got ${[...ids].join(',')} (series ${b.series}, axis ${JSON.stringify(b.axis)})`);
  // a good chart: big labels, Okabe-Ito colours with different lightness, axis from 0, 3 series labelled directly
  const ok = ['#0072B2', '#E69F00', '#009E73'];
  const gbars = [30, 45, 60].map((v, i) => `<rect x="${200 + i * 260}" y="${900 - v * 12}" width="180" height="${v * 12}" fill="${ok[i]}"/><text x="${290 + i * 260}" y="${880 - v * 12}" font-size="44" text-anchor="middle" fill="#111">${v}k</text><text x="${290 + i * 260}" y="960" font-size="40" text-anchor="middle" fill="#111">${['Coffee', 'Cakes', 'Lunch'][i]}</text>`).join('');
  const gticks = [0, 20, 40, 60].map((v) => `<text x="170" y="${900 - v * 12 + 14}" font-size="36" text-anchor="end" fill="#333">${v}</text>`).join('');
  writeFileSync(join(d, 'good.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080"><rect width="1080" height="1080" fill="#FAF7F2"/><text x="60" y="110" font-size="64" font-weight="700" fill="#111">Lunch grew fastest</text>${gbars}${gticks}</svg>`);
  const g = await check(join(d, 'good.svg'), { use: 'social', out: join(d, 'look/good') });
  if (g.errors) throw new Error('good chart flagged: ' + g.issues.map((i) => i.id + ' ' + i.msg).join(' | '));
  if (g.series !== 3 || !existsSync(g.sheet)) throw new Error(`good chart: series ${g.series}, sheet ${g.sheet}`);
  // an HTML chart with a transparent background and light text: dark-mode warning; PNG input: visual checks only
  writeFileSync(join(d, 'trans.html'), `<html><body style="margin:0;background:transparent"><div style="width:800px;padding:20px;font:28px Helvetica;color:#fff">White title on nothing</div><svg width="800" height="300"><rect x="20" y="100" width="200" height="200" fill="#0072B2"/><rect x="260" y="50" width="200" height="250" fill="#E69F00"/></svg></body></html>`);
  const t = await check(join(d, 'trans.html'), { use: 'report', out: join(d, 'look/trans') });
  if (!t.transparent) throw new Error('transparent chart not detected');
  console.log(`chart-check: all tests pass (bad: ${[...ids].join(',')}; good: ${g.series} series, smallest ${g.min_text_px} px; transparent: ${t.issues.map((i) => i.id).join(',') || 'none'})`);
}

if (typeof process !== 'undefined' && process.argv?.[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
  const VALUED = new Set(['--out', '--use']);
  const pos = argv.filter((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1]));
  const done = (r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); };
  const fail = (e) => { console.error(String(e.message || e)); process.exit(2); };
  if (argv.includes('--test')) selfTest().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
  else if (pos[0] === 'check' && pos[1]) check(pos[1], { use: opt('use', 'social'), out: opt('out', 'look/chart') }).then(done, fail);
  else fail('usage: chart-check.mjs check <chart.html|chart.svg|chart.png> [--use social|report|slide] [--out look/chart]\n       chart-check.mjs --test');
}
