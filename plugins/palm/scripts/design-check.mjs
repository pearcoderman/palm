#!/usr/bin/env node
// Palm tool: design.check — checks a Quick Design JSON (src/quick-design/design-format.schema.json)
// for things an agent can't see while writing coordinates: unreadable contrast, text running off
// the page, no type hierarchy, crowded edges, and the "AI slop" tells (house taste rules v1).
// Deterministic, no network. adds: tool + taste.
//
// In:  a design JSON (or {"design": {...}, "platform": "instagram-feed"})
// Out: {"ok": bool, "score": 0-100, "issues": [{rule, severity, page, el, msg, fix}], "summary": "..."}

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SIZES = { ig: [1080, 1080], carousel: [1080, 1350], story: [1080, 1920], poster: [1800, 2400], flyer: [1275, 1650], yt: [1280, 720], slides: [1920, 1080], card: [1050, 600], a4: [1240, 1754], logo: [500, 500] };

// Average glyph width as a share of font size (rough; used only to estimate wrapping).
const WIDTH = { 'Bebas Neue': 0.4, Anton: 0.45, Oswald: 0.47, 'Archivo Black': 0.66, Unbounded: 0.7, Syne: 0.6, Bungee: 0.72, Shrikhand: 0.62, 'Abril Fatface': 0.55, 'Playfair Display': 0.52, 'DM Serif Display': 0.5, Fraunces: 0.53, 'Great Vibes': 0.42, 'Dancing Script': 0.45, Pacifico: 0.6, Caveat: 0.42, 'Permanent Marker': 0.6 };
const glyphW = (ff, fw = 400, up = false) => (WIDTH[ff] ?? 0.54) * (fw >= 800 ? 1.13 : fw >= 600 ? 1.06 : 1) * (up ? 1.12 : 1);

const NAMED = { white: '#ffffff', black: '#000000', red: '#ff0000', blue: '#0000ff', green: '#008000', yellow: '#ffff00', gray: '#808080', grey: '#808080', orange: '#ffa500', purple: '#800080', pink: '#ffc0cb', navy: '#000080', transparent: '#00000000' };
function rgb(c) {
  if (!c || typeof c !== 'string') return null;
  c = c.trim().toLowerCase();
  if (NAMED[c]) c = NAMED[c];
  let m = c.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map((x) => x + x).join('');
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
  }
  m = c.match(/^rgba?\(([^)]+)\)$/);
  if (m) { const p = m[1].split(/[ ,/]+/).filter(Boolean).map(parseFloat); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; }
  m = c.match(/^hsla?\(([^)]+)\)$/);
  if (m) {
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(parseFloat); const [h, s, l] = [p[0], p[1] / 100, p[2] / 100];
    const k = (n) => (n + h / 30) % 12; const a = s * Math.min(l, 1 - l);
    const f = (n) => 255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))));
    return { r: f(0), g: f(8), b: f(4), a: p[3] ?? 1 };
  }
  return null;
}
const lum = ({ r, g, b }) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
function hsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (!d) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = mx === r ? 60 * (((g - b) / d) % 6) : mx === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  return { h: (h + 360) % 360, s, l };
}
// Composite colour a (with its alpha × opacity) over b.
function over(a, b, opacity = 1) {
  const al = (a.a ?? 1) * opacity;
  return { r: a.r * al + b.r * (1 - al), g: a.g * al + b.g * (1 - al), b: a.b * al + b.b * (1 - al), a: 1 };
}
// Colour of a fill at point (px,py) inside box (x,y,w,h); gradients follow the format's angle
// (0 = bottom to top, 90 = left to right), like CSS linear-gradient.
function sampleFill(f, px, py, x, y, w, h) {
  if (!f) return null;
  if (typeof f === 'string') return rgb(f);
  if (!Array.isArray(f.g) || f.g.length < 2) return null;
  const [c0, c1] = f.g.map(rgb);
  if (!c0 || !c1) return c0 || c1;
  const a = ((f.a ?? 135) * Math.PI) / 180, sx = Math.sin(a), sy = -Math.cos(a);
  const len = Math.abs(w * sx) + Math.abs(h * sy) || 1;
  const t = Math.min(1, Math.max(0, ((px - (x + w / 2)) * sx + (py - (y + h / 2)) * sy) / len + 0.5));
  const mix = (k) => c0[k] + (c1[k] - c0[k]) * t;
  return { r: mix('r'), g: mix('g'), b: mix('b'), a: (c0.a ?? 1) + ((c1.a ?? 1) - (c0.a ?? 1)) * t };
}
const fillColours = (f) => (typeof f === 'string' ? [rgb(f)] : f && Array.isArray(f.g) ? f.g.map(rgb) : []).filter(Boolean);

// Headline words that read as machine-written marketing.
const BUZZ = ['unlock', 'elevate', 'revolutioni', 'seamless', 'supercharge', 'transform your', 'unleash', 'empower', 'game-chang', 'next-level', 'next level', 'cutting-edge', 'skyrocket', 'level up', 'dive into', 'embark', 'journey', 'synergy', 'redefin', 'reimagin', 'effortless', 'harness', 'the future of', 'like never before', 'in today\'s'];
const EMOJI = /\p{Extended_Pictographic}/u;

function estTextHeight(el) {
  const fs = el.fs || 48, lh = el.lh || 1.2, w = el.w || 600;
  const perLine = Math.max(1, Math.floor(w / (fs * glyphW(el.ff, el.fw, el.up))));
  const lines = String(el.txt || '').split('\n').reduce((n, para) => n + Math.max(1, Math.ceil([...para].length / perLine)), 0);
  return { h: lines * fs * lh, lines, perLine };
}

export function check(input) {
  const design = input?.design || input;
  const measured = !!input?.measured; // text heights come from a real render (design-render.mjs)
  const issues = [];
  const add = (rule, severity, page, el, msg, fix) => issues.push({ rule, severity, page, el, msg, fix });
  const [W, H] = [design.w || SIZES[design.size]?.[0] || 1080, design.h || SIZES[design.size]?.[1] || 1080];
  const pages = design.pages || [];
  if (!pages.length) return { ok: false, score: 0, issues: [{ rule: 'format', severity: 'error', msg: 'No pages.' }] };
  const fonts = new Set();
  // Phone-reading rules only apply to screen formats, not print (poster, flyer, card, a4).
  const screen = !['poster', 'flyer', 'card', 'a4'].includes(design.size) && !(W >= 1200 && H > W * 1.25);

  pages.forEach((pg, pi) => {
    const els = pg.els || [];
    const texts = els.map((e, i) => ({ e, i })).filter(({ e }) => e.t === 'text' && !e.hid && String(e.txt || '').trim());
    const bg = fillColours(pg.bg);
    if (!bg.length) bg.push({ r: 255, g: 255, b: 255, a: 1 });

    // AI-slop: purple/indigo/violet gradient background.
    if (pg.bg && typeof pg.bg === 'object' && bg.length >= 2 && bg.every((c) => { const h = hsl(c); return h.h >= 225 && h.h <= 300 && h.s > 0.45; }))
      add('slop.purple-gradient', 'warn', pi, null, 'Indigo-to-violet gradient background: the most common tell of an AI-made graphic.', 'Use a flat colour from the brand, or a photo; if a gradient, keep it within one hue and low contrast.');

    texts.forEach(({ e, i }) => {
      if (e.ff) fonts.add(e.ff);
      const c = rgb(e.c || '#000');
      const { h: th, lines } = estTextHeight(e);
      const decorative = (e.o ?? 1) < 0.5 || ['hollow', 'outline'].includes(e.ef);
      // Sample what's behind the text at three points along its middle line: page background
      // (gradients sampled at that spot), then every visible shape under it, alpha-composited.
      const ty = (e.y || 0) + (e.h || th) / 2;
      const pts = [0.15, 0.5, 0.85].map((f) => [(e.x || 0) + (e.w || 0) * f, ty]);
      let onPhoto = false;
      const backs = pts.map(([px, py]) => {
        let col = sampleFill(pg.bg, px, py, 0, 0, W, H) || { r: 255, g: 255, b: 255, a: 1 };
        for (let j = 0; j < i; j++) {
          const s = els[j];
          if (s.hid || !['shape', 'img'].includes(s.t)) continue;
          if (!(px >= s.x && px <= s.x + s.w && py >= s.y && py <= s.y + s.h)) continue;
          if (s.t === 'img') { onPhoto = true; continue; }
          const f = sampleFill(s.fill, px, py, s.x, s.y, s.w, s.h);
          if (f) col = over(f, col, (s.o ?? 1));
        }
        return col;
      });
      if (c && !decorative && !onPhoto) {
        const worst = Math.min(...backs.map((u) => contrast(over(c, u, e.o ?? 1), u)));
        const fs = e.fs || 48;
        const big = fs >= Math.max(24, H * 0.03) || ((e.fw || 400) >= 700 && fs >= H * 0.022);
        const need = big ? 3 : 4.5;
        const display = fs >= H * 0.12; // giant display type: designers trade contrast for impact
        if (worst < need) add('contrast', !display && worst < (big ? 2 : 3) ? 'error' : 'warn', pi, i, `Text "${String(e.txt).slice(0, 30)}" has contrast ${worst.toFixed(2)}:1 (needs ${need}:1).`, 'Darken or lighten the text, or put a solid panel behind it.');
      } else if (c && onPhoto && !decorative && !(e.ef && e.ef !== 'none')) {
        add('contrast.photo', 'tip', pi, i, `Text "${String(e.txt).slice(0, 30)}" sits on a photo.`, 'Check it by eye, or add a dark/light panel or shadow behind it.');
      }
      // A single word wider than its box breaks mid-word (e.g. "Sourdoug" + "h" on the next line).
      const longest = String(e.txt || '').split(/\s+/).reduce((a, b) => ([...b].length > [...a].length ? b : a), '');
      const wordW = [...longest].length * (e.fs || 48) * glyphW(e.ff, e.fw, e.up);
      if (!measured && wordW > (e.w || 600) * 1.0) add('word-break', 'warn', pi, i, `"${longest}" is ~${Math.round(wordW)}px wide in a ${Math.round(e.w || 600)}px box: it may break mid-word (estimate from average letter widths; confirm in a render).`, `Widen the box to ≥ ${Math.ceil(wordW * 1.08)}px or cut fs by ${Math.ceil(100 - 100 * (e.w || 600) / (wordW * 1.08))}%.`);
      // Two text blocks on top of each other.
      for (const { e: o, i: oi } of texts) {
        if (oi >= i) break;
        const ob = (o.y || 0) + (o.h || estTextHeight(o).h), eb = (e.y || 0) + (e.h || th);
        // With a measured render, use where the letters actually are (alignment + widest line), not the box.
        const span = (t) => { const bw = t.w || 0, tw = Math.min(bw, t._tw ?? bw), x = t.x || 0; return t.al === 'center' ? [x + (bw - tw) / 2, x + (bw + tw) / 2] : t.al === 'right' ? [x + bw - tw, x + bw] : [x, x + tw]; };
        const [ea, eb2] = span(e), [oa, ob2] = span(o);
        const ix = Math.min(eb2, ob2) - Math.max(ea, oa);
        const iy = Math.min(eb, ob) - Math.max(e.y || 0, o.y || 0);
        if (ix > 0 && iy > Math.min(e.fs || 48, o.fs || 48) * 0.35 && !e.r && !o.r) add('overlap', 'warn', pi, i, `Text "${String(e.txt).slice(0, 24)}" overlaps "${String(o.txt).slice(0, 24)}" by ~${Math.round(iy)}px${measured ? '' : ' (estimate)'}; fine only if deliberate, e.g. a decorative quote mark.`, 'Move one down, or shorten/shrink the upper one (check how many lines it wraps to).');
      }
      // Overflow and edges.
      const bottom = (e.y || 0) + (e.h || th);
      if ((e.x || 0) < 0 || (e.x || 0) + (e.w || 0) > W || (e.y || 0) < 0 || bottom > H)
        add('overflow', 'error', pi, i, `Text "${String(e.txt).slice(0, 30)}" runs off the page (estimated ${lines} lines, bottom at ~${Math.round(bottom)} of ${H}px).`, 'Shorten it, shrink fs, or widen/move the box.');
      const m = Math.min(W, H) * 0.045;
      if (!e.r && ((e.x || 0) < m || W - ((e.x || 0) + (e.w || 0)) < m || (e.y || 0) < m || H - bottom < m) && bottom <= H)
        add('edge', 'warn', pi, i, `Text "${String(e.txt).slice(0, 30)}" is within ${Math.round(m)}px of the edge.`, 'Keep a clear margin (≥4.5% of the short side); apps crop edges.');
      // Readability on a phone: the design is seen at ~360px wide.
      const shown = (e.fs || 48) * (360 / W);
      if (screen && shown < 6) add('tiny-text', 'tip', pi, i, `Text "${String(e.txt).slice(0, 30)}" shows at ~${shown.toFixed(1)}px on a phone.`, `Fine for labels and texture; anything people must read needs fs ≥ ${Math.ceil(7.5 * W / 360)} on a ${W}px-wide page.`);
      if (EMOJI.test(String(e.txt))) add('slop.emoji', 'warn', pi, i, 'Emoji inside the text.', 'Drop them; use one real icon or photo instead.');
      if (e.ef && ['neon', 'glitch', 'echo', 'splice'].includes(e.ef)) add('slop.effect', 'tip', pi, i, `"${e.ef}" text effect.`, 'Loud effects date a design fast; use only when the brand is loud.');
    });

    if (texts.length) {
      const byFs = [...texts].sort((a, b) => (b.e.fs || 48) - (a.e.fs || 48));
      const head = byFs[0].e;
      const htxt = String(head.txt).toLowerCase();
      const hit = BUZZ.find((b) => htxt.includes(b));
      if (hit) add('slop.buzzword', 'warn', pi, byFs[0].i, `Headline uses "${hit}…": reads as machine-written.`, 'Say the concrete thing: what it is, for whom, or a number.');
      const nWords = htxt.split(/\s+/).filter(Boolean).length;
      if (nWords > 9) add('headline.long', 'warn', pi, byFs[0].i, `Headline has ${nWords} words.`, 'Keep it to 2–8 words; move the rest to a subline.');
      if (byFs.length > 1) {
        const ratio = (head.fs || 48) / (byFs[byFs.length - 1].e.fs || 48);
        if (ratio < 1.8) add('hierarchy', 'warn', pi, null, `Biggest text is only ${ratio.toFixed(1)}× the smallest.`, 'Make the headline at least 2–3× the body size; one clear first read.');
      }
      if (texts.length >= 3 && texts.filter(({ e }) => e.al === 'center').length / texts.length >= 0.8)
        add('slop.all-centred', 'tip', pi, null, 'Nearly every text block is centred.', 'Left-align body text or build on a grid; centre only the hero line, if anything.');
      if (texts.some(({ e }) => e.ef === 'shadow') && pg.bg && typeof pg.bg === 'object') add('slop.shadow-on-gradient', 'tip', pi, null, 'Drop-shadow text on a gradient.', 'Pick one: flat background with crisp text, or a photo with a panel.');
    }
    const clichés = els.filter((e) => (e.t === 'icon' && ['sparkle', 'rocket', 'bulb'].includes(e.ic)) || (e.t === 'emoji' && /🚀|✨|💡|🔥/u.test(e.e || '')));
    if (clichés.length) add('slop.cliche-icon', 'warn', pi, null, `${clichés.length} cliché icon(s) (rocket/sparkle/bulb).`, 'Use an icon that shows the actual product, or none.');
  });

  if (fonts.size > 2) add('fonts', 'warn', null, null, `${fonts.size} font families (${[...fonts].join(', ')}).`, 'Use one family, or two that contrast (a display face + a plain sans).');

  const w = { error: 25, warn: 8, tip: 1 };
  const score = Math.max(0, 100 - issues.reduce((s, i) => s + (w[i.severity] || 0), 0));
  const ok = !issues.some((i) => i.severity === 'error');
  return { ok, score, page: { w: W, h: H }, issues, summary: `${issues.length} issue(s): ${['error', 'warn', 'tip'].map((s) => `${issues.filter((i) => i.severity === s).length} ${s}`).join(', ')}. Fix errors and warnings, then re-check.` };
}

function selfTest() {
  const assert = (c, m, r) => { if (!c) { console.error('FAIL', m, JSON.stringify(r, null, 2)); process.exit(1); } };
  const slop = check({ v: 1, size: 'ig', pages: [{ bg: { g: ['#6366f1', '#8b5cf6'], a: 135 }, els: [
    { t: 'text', x: 20, y: 300, w: 1040, txt: 'Unlock Your Potential and Elevate Your Morning Coffee Ritual Today ✨', fs: 90, ff: 'Poppins', c: '#ffffff', al: 'center', ef: 'shadow' },
    { t: 'text', x: 140, y: 700, w: 800, txt: 'Fresh beans', fs: 70, ff: 'Montserrat', c: '#e0e0ff', al: 'center' },
    { t: 'text', x: 140, y: 900, w: 800, txt: 'Order now', fs: 60, ff: 'Inter', c: '#8b8bf0', al: 'center' },
    { t: 'icon', x: 500, y: 100, w: 80, h: 80, ic: 'rocket', c: '#fff' }] }] });
  const rules = new Set(slop.issues.map((i) => i.rule));
  for (const r of ['slop.purple-gradient', 'slop.buzzword', 'slop.emoji', 'slop.all-centred', 'slop.cliche-icon', 'fonts', 'hierarchy', 'headline.long', 'contrast', 'edge']) assert(rules.has(r), 'expected ' + r, slop);
  const good = check({ v: 1, size: 'ig', pages: [{ bg: '#f4efe6', els: [
    { t: 'text', x: 80, y: 120, w: 900, txt: 'Sourdough, out at 7.', fs: 120, ff: 'Fraunces', c: '#1d1a16', al: 'left' },
    { t: 'text', x: 80, y: 900, w: 700, txt: 'Clocktower Bakes · 14 Mill Lane', fs: 40, ff: 'Inter', c: '#4a443c', al: 'left' }] }] });
  assert(good.ok && good.score >= 90, 'clean design passes', good);
  const off = check({ v: 1, size: 'story', pages: [{ bg: '#fff', els: [{ t: 'text', x: 60, y: 1700, w: 960, txt: 'A very long line of text that will wrap several times and run off the bottom of the page for sure', fs: 90, c: '#000' }] }] });
  assert(off.issues.some((i) => i.rule === 'overflow'), 'overflow found', off);
  console.log('design-check: all tests pass (slop sample score', slop.score + ', clean sample', good.score + ')');
}

if (typeof process !== 'undefined' && process.argv?.[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--test')) selfTest();
  else process.stdout.write(JSON.stringify(check(JSON.parse(readFileSync(0, 'utf8'))), null, 2) + '\n');
}
