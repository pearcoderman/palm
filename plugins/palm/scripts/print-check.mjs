#!/usr/bin/env node
// Palm tool: print-check — lets an agent see a print file the way the printer and the customer will: the page size
// against trim + bleed, whether the background really runs into the bleed (or a white sliver appears when the blade
// drifts), text too close to the cut, the effective resolution of every placed photo, the smallest text and thinnest
// line, and fonts that aren't embedded. It draws a sheet: each page with its bleed, trim and safe lines; the piece as
// cut with the blade 1 mm off either way; a real-size view (a business card beside a credit card); and a zoom into the
// lowest-resolution photo as it will print.
// adds: tool, fresh-data. Runs on the user's machine with their Chrome/Edge/Chromium; page renders need Ghostscript
// (`brew install ghostscript`), poppler's pdftoppm, mutool or Python's PyMuPDF — whichever is there. Nothing leaves it.
//
//   node print-check.mjs render <design.html> --trim 85x55mm --bleed 3mm --out print/card.pdf
//       → a PDF at exactly trim + bleed per page (each page of the HTML = one <section> of that size), with the PDF's
//         TrimBox and BleedBox set; then it checks the result. One PDF per piece; front and back = two pages.
//   node print-check.mjs check <file.pdf|.png|.jpg|folder> [--trim 85x55mm] [--bleed 3mm] [--safe 3mm] [--out look/print]
//       → JSON {ok, errors, warnings, files:[{pages:[…measures…]}], issues, sheet}. Then LOOK at the sheet.
//   Sizes: 85x55mm, 3.5x2in, a5, a4, letter… (portrait or landscape follows the file).
//
// Rules: Palm data pack design/print (checked 2026-11-23): Mixam (3 mm bleed, 5 mm quiet area, ≥300 dpi, never <100),
// Raksul (3 mm bleed, 3 mm text margin, ≥6 pt text, ≥0.3 pt lines, 350–400 ppi), MOO (≥8 pt text, ≥0.5 pt lines,
// fonts embedded, ≥96 dpi, 300 recommended). There's no single standard: the named printer's rules win.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve, basename, extname } from 'node:path';
import { inflateSync } from 'node:zlib';
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
const launch = () => loadPuppeteer().launch({ executablePath: findChrome(), headless: true, timeout: 90000, args: ['--no-sandbox', '--hide-scrollbars', '--allow-file-access-from-files'] });
const issue = (id, level, msg, fix) => ({ id, level, msg, ...(fix ? { fix } : {}) });
const PT = 25.4 / 72; // mm per point
const r1 = (x) => Math.round(x * 10) / 10;

// ---------- sizes ----------
const NAMED = { a0: [841, 1189], a1: [594, 841], a2: [420, 594], a3: [297, 420], a4: [210, 297], a5: [148, 210], a6: [105, 148], a7: [74, 105],
  letter: [215.9, 279.4], legal: [215.9, 355.6], tabloid: [279.4, 431.8], 'card-eu': [85, 55], 'card-us': [88.9, 50.8], 'card-jp': [91, 55] };
// Known finished sizes, to recognise a file's trim when none is given (Palm data pack design/print).
const KNOWN = [['business card 85×55 mm', 85, 55], ['US business card 3.5×2 in', 88.9, 50.8], ['Japanese business card 91×55 mm', 91, 55], ['Western card 89×51 mm', 89, 51],
  ['A7', 74, 105], ['A6', 105, 148], ['A5', 148, 210], ['A4', 210, 297], ['A3', 297, 420], ['A2', 420, 594], ['A1', 594, 841], ['US Letter', 215.9, 279.4], ['DL', 99, 210]];
export function parseSize(s) {
  if (!s) return null;
  const k = String(s).toLowerCase().trim();
  if (NAMED[k]) return { w: NAMED[k][0], h: NAMED[k][1] };
  const m = k.match(/^([\d.]+)\s*[x×]\s*([\d.]+)\s*(mm|in|cm|pt)?$/);
  if (!m) throw new Error(`Can't read size "${s}" (try 85x55mm, 3.5x2in or a5).`);
  const f = { mm: 1, cm: 10, in: 25.4, pt: PT }[m[3] || 'mm'];
  return { w: +m[1] * f, h: +m[2] * f };
}
export function parseLen(s, d) {
  if (s == null || s === '') return d;
  const m = String(s).toLowerCase().match(/^([\d.]+)\s*(mm|in|pt)?$/);
  if (!m) throw new Error(`Can't read length "${s}" (try 3mm or 0.125in).`);
  return +m[1] * { mm: 1, in: 25.4, pt: PT }[m[2] || 'mm'];
}
// Match a page size (mm) to a known finished size, with or without 2–3 mm bleed, either orientation.
export function guessTrim(w, h) {
  const tol = 0.6;
  for (const [name, a, b] of KNOWN) for (const [tw, th] of [[a, b], [b, a]]) {
    if (Math.abs(w - tw) < tol && Math.abs(h - th) < tol) return { name, w: tw, h: th, bleed: 0 };
    for (const bl of [3, 2, 3.175, 5]) if (Math.abs(w - tw - 2 * bl) < tol && Math.abs(h - th - 2 * bl) < tol) return { name, w: tw, h: th, bleed: bl };
  }
  return null;
}

// ---------- a small PDF reader (enough for page boxes, fonts, images, text and line sizes) ----------
class Lexer {
  constructor(s, i = 0) { this.s = s; this.i = i; }
  ws() { const s = this.s; for (;;) { while (this.i < s.length && /[\x00\t\n\f\r ]/.test(s[this.i])) this.i++; if (s[this.i] === '%') { while (this.i < s.length && s[this.i] !== '\n' && s[this.i] !== '\r') this.i++; } else return; } }
  value() {
    this.ws(); const s = this.s, c = s[this.i];
    if (c === '<' && s[this.i + 1] === '<') { this.i += 2; const d = {}; for (;;) { this.ws(); if (s[this.i] === '>' && s[this.i + 1] === '>') { this.i += 2; return d; } if (this.i >= s.length) return d; const k = this.value(); const v = this.value(); if (typeof k === 'string' && k[0] === '/') d[k.slice(1)] = v; } }
    if (c === '[') { this.i++; const a = []; for (;;) { this.ws(); if (s[this.i] === ']') { this.i++; return a; } if (this.i >= s.length) return a; a.push(this.value()); } }
    if (c === '/') { let j = this.i + 1; while (j < s.length && !/[\x00\t\n\f\r ()<>[\]{}/%]/.test(s[j])) j++; const n = s.slice(this.i, j).replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))); this.i = j; return n; }
    if (c === '(') { let depth = 0, out = ''; this.i++; for (; this.i < s.length; this.i++) { const ch = s[this.i]; if (ch === '\\') { const n = s[++this.i]; const esc = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }[n]; if (esc) out += esc; else if (/[0-7]/.test(n)) { let o = n; while (o.length < 3 && /[0-7]/.test(s[this.i + 1])) o += s[++this.i]; out += String.fromCharCode(parseInt(o, 8) & 255); } else if (n === '\r' || n === '\n') { if (n === '\r' && s[this.i + 1] === '\n') this.i++; } else out += n; continue; } if (ch === '(') depth++; if (ch === ')') { if (depth === 0) { this.i++; break; } depth--; } out += ch; } return { str: out }; }
    if (c === '<') { const j = s.indexOf('>', this.i); const hex = s.slice(this.i + 1, j).replace(/\s/g, ''); this.i = j + 1; let out = ''; for (let k = 0; k < hex.length; k += 2) out += String.fromCharCode(parseInt((hex.slice(k, k + 2) + '0').slice(0, 2), 16)); return { str: out }; }
    let j = this.i; while (j < s.length && !/[\x00\t\n\f\r ()<>[\]{}/%]/.test(s[j])) j++;
    const tok = s.slice(this.i, j); this.i = j || this.i + 1;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) {
      if (/^\d+$/.test(tok)) { const save = this.i; const m = /^\s+(\d+)\s+R(?=[\s/<>[\]()%]|$)/.exec(s.slice(this.i, this.i + 24)); if (m) { this.i += m[0].length; return { ref: +tok }; } this.i = save; }
      return +tok;
    }
    if (tok === 'true') return true; if (tok === 'false') return false; if (tok === 'null') return null;
    return { op: tok };
  }
}
function decodeStream(dict, raw) {
  const f = [].concat(dict.Filter || []).map(String);
  if (!f.length) return raw;
  if (f.length === 1 && f[0] === '/FlateDecode') { try { return inflateSync(Buffer.from(raw, 'latin1')).toString('latin1'); } catch { return null; } }
  return null; // images (DCT etc.) aren't decoded; only their dictionaries matter here
}
export function readPdf(buf) {
  const s = buf.toString('latin1');
  if (!s.startsWith('%PDF')) throw new Error('Not a PDF.');
  const objs = new Map();
  const re = /(\d+)\s+(\d+)\s+obj\b/g; let m;
  while ((m = re.exec(s))) {
    const lx = new Lexer(s, m.index + m[0].length); let v; try { v = lx.value(); } catch { continue; }
    lx.ws(); let stream = null;
    if (s.startsWith('stream', lx.i)) {
      let st = lx.i + 6; if (s[st] === '\r') st++; if (s[st] === '\n') st++;
      let end = typeof v?.Length === 'number' && s.startsWith('endstream', s.indexOf('endstream', st + v.Length - 2)) && s.indexOf('endstream', st + v.Length - 2) - (st + v.Length) < 4 ? st + v.Length : s.indexOf('endstream', st);
      let raw = s.slice(st, end); raw = raw.replace(/\r?\n$/, '');
      stream = raw; re.lastIndex = end;
    }
    objs.set(+m[1], { v, stream });
  }
  // object streams (PDF 1.5+)
  for (const [, o] of [...objs]) {
    if (o.v?.Type !== '/ObjStm' || o.stream == null) continue;
    const d = decodeStream(o.v, o.stream); if (d == null) continue;
    const head = d.slice(0, o.v.First).trim().split(/\s+/).map(Number);
    for (let k = 0; k < head.length; k += 2) { const num = head[k], off = head[k + 1]; if (objs.has(num)) continue; try { objs.set(num, { v: new Lexer(d, o.v.First + off).value(), stream: null }); } catch {} }
  }
  const get = (x) => (x && typeof x === 'object' && 'ref' in x ? objs.get(x.ref)?.v : x);
  const streamOf = (x) => { const o = x && typeof x === 'object' && 'ref' in x ? objs.get(x.ref) : null; return o?.stream != null ? decodeStream(o.v, o.stream) : null; };
  let root = null;
  for (const [, o] of objs) if (o.v?.Type === '/Catalog') root = o.v;
  if (!root) throw new Error('No catalog in this PDF.');
  const pages = [];
  const walk = (node, inh) => {
    node = get(node); if (!node) return;
    const h = { MediaBox: node.MediaBox ?? inh.MediaBox, CropBox: node.CropBox ?? inh.CropBox, Resources: node.Resources ?? inh.Resources, Rotate: node.Rotate ?? inh.Rotate };
    if (node.Type === '/Pages' || node.Kids) for (const k of [].concat(get(node.Kids) || [])) walk(k, h);
    else pages.push({ node, ...h, TrimBox: node.TrimBox, BleedBox: node.BleedBox });
  };
  walk(root.Pages, {});
  return { s, objs, get, streamOf, pages, root };
}
const mul = (a, b) => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
const box = (pdf, b) => { const a = (pdf.get(b) || []).map((x) => pdf.get(x)); return a.length === 4 ? { x0: Math.min(a[0], a[2]), y0: Math.min(a[1], a[3]), x1: Math.max(a[0], a[2]), y1: Math.max(a[1], a[3]) } : null; };

function fontInfo(pdf, fref) {
  const f = pdf.get(fref) || {};
  const name = String(f.BaseFont || '/?').slice(1).replace(/^[A-Z]{6}\+/, '');
  if (f.Subtype === '/Type3') return { name: name || 'Type3', embedded: true, twoByte: false };
  let desc = f.FontDescriptor, twoByte = false;
  if (f.Subtype === '/Type0') { twoByte = true; const d0 = pdf.get((pdf.get(f.DescendantFonts) || [])[0]); desc = d0?.FontDescriptor; }
  const d = pdf.get(desc) || {};
  return { name, embedded: !!(d.FontFile || d.FontFile2 || d.FontFile3), twoByte };
}

// Walks a content stream: placed images (with effective ppi), text runs (size in pt, position), stroked lines.
function runContent(pdf, data, resources, ctm0, out, depth = 0) {
  if (data == null || depth > 8) return;
  const res = pdf.get(resources) || {};
  const fonts = pdf.get(res.Font) || {}, xobj = pdf.get(res.XObject) || {};
  const lx = new Lexer(data); const st = [];
  let ctm = ctm0.slice(), lw = 1, stack = [], Tm = [1, 0, 0, 1, 0, 0], Tlm = Tm.slice(), font = null, fsize = 0, TL = 0, Th = 1, fCache = {};
  const key = (n) => String(n || '').replace(/^\//, '');
  const fi = (n) => (fCache[n] ??= fonts[key(n)] ? fontInfo(pdf, fonts[key(n)]) : { name: n, embedded: true, twoByte: false });
  const show = (str, adj = 0) => {
    const f = font ? fi(font) : { twoByte: false };
    const n = Math.max(0, Math.round(str.length / (f.twoByte ? 2 : 1)));
    const M = mul(Tm, ctm), size = fsize * Math.hypot(M[2], M[3]);
    const wText = (n * fsize * 0.5 * Th - adj / 1000 * fsize) ;
    const p0 = [M[4], M[5]], adv = mul([1, 0, 0, 1, wText, 0], M);
    if (n > 0 && size > 0) out.text.push({ size, x0: Math.min(p0[0], adv[4]), x1: Math.max(p0[0], adv[4]), y0: p0[1] - size * 0.2, y1: p0[1] + size * 0.75, font: f.name, n });
    Tm = mul([1, 0, 0, 1, wText, 0], Tm);
  };
  for (let guard = 0; guard < 2e6; guard++) {
    lx.ws(); if (lx.i >= data.length) break;
    const v = lx.value();
    if (!v || typeof v !== 'object' || !('op' in v)) { stack.push(v); continue; }
    const op = v.op, a = stack; stack = [];
    switch (op) {
      case 'q': st.push({ ctm: ctm.slice(), lw }); break;
      case 'Q': { const p = st.pop(); if (p) { ctm = p.ctm; lw = p.lw; } break; }
      case 'cm': if (a.length >= 6) ctm = mul(a.slice(-6).map(Number), ctm); break;
      case 'w': lw = +a[a.length - 1] || 0; break;
      case 'S': case 's': case 'B': case 'B*': case 'b': case 'b*': out.lines.push({ w: lw * Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2])), zero: lw === 0 }); break;
      case 'BT': Tm = [1, 0, 0, 1, 0, 0]; Tlm = Tm.slice(); break;
      case 'Tf': font = a[a.length - 2]; fsize = +a[a.length - 1] || 0; break;
      case 'Tz': Th = (+a[0] || 100) / 100; break;
      case 'TL': TL = +a[0] || 0; break;
      case 'Td': Tlm = mul([1, 0, 0, 1, +a[0] || 0, +a[1] || 0], Tlm); Tm = Tlm.slice(); break;
      case 'TD': TL = -(+a[1] || 0); Tlm = mul([1, 0, 0, 1, +a[0] || 0, +a[1] || 0], Tlm); Tm = Tlm.slice(); break;
      case 'Tm': if (a.length >= 6) { Tlm = a.slice(-6).map(Number); Tm = Tlm.slice(); } break;
      case 'T*': Tlm = mul([1, 0, 0, 1, 0, -TL], Tlm); Tm = Tlm.slice(); break;
      case "'": Tlm = mul([1, 0, 0, 1, 0, -TL], Tlm); Tm = Tlm.slice(); show(a[a.length - 1]?.str || ''); break;
      case '"': Tlm = mul([1, 0, 0, 1, 0, -TL], Tlm); Tm = Tlm.slice(); show(a[a.length - 1]?.str || ''); break;
      case 'Tj': show(a[a.length - 1]?.str || ''); break;
      case 'TJ': for (const e of [].concat(a[a.length - 1] || [])) { if (typeof e === 'number') Tm = mul([1, 0, 0, 1, -e / 1000 * fsize * Th, 0], Tm); else if (e?.str != null) show(e.str); } break;
      case 'BI': { // inline image: dictionary until ID, data until EI
        const d = {}; for (let k = 0; k + 1 < a.length; k += 2) d[String(a[k]).slice(1)] = a[k + 1];
        let dict = {}; for (;;) { lx.ws(); const t = lx.value(); if (t?.op === 'ID') break; const val = lx.value(); if (typeof t === 'string') dict[t.slice(1)] = val; if (lx.i >= data.length) break; }
        const e = data.indexOf('EI', lx.i); lx.i = e < 0 ? data.length : e + 2;
        const W = +(dict.W ?? dict.Width), H = +(dict.H ?? dict.Height);
        if (W && H) placeImage(out, ctm, W, H, 'inline image');
        break;
      }
      case 'Do': {
        const name = String(a[a.length - 1] || ''); const ref = xobj[key(name)]; const x = pdf.get(ref);
        if (!x) break;
        if (x.Subtype === '/Image') { if (!x.ImageMask) placeImage(out, ctm, +pdf.get(x.Width), +pdf.get(x.Height), name.slice(1)); }
        else if (x.Subtype === '/Form') { const fm = (pdf.get(x.Matrix) || [1, 0, 0, 1, 0, 0]).map(Number); runContent(pdf, pdf.streamOf(ref), x.Resources || resources, mul(fm, ctm), out, depth + 1); }
        break;
      }
      default: break;
    }
  }
}
function placeImage(out, ctm, W, H, name) {
  const wPt = Math.hypot(ctm[0], ctm[1]), hPt = Math.hypot(ctm[2], ctm[3]);
  if (wPt < 2 || hPt < 2) return;
  const xs = [ctm[4], ctm[4] + ctm[0], ctm[4] + ctm[2], ctm[4] + ctm[0] + ctm[2]], ys = [ctm[5], ctm[5] + ctm[1], ctm[5] + ctm[3], ctm[5] + ctm[1] + ctm[3]];
  out.images.push({ name, px: [W, H], ppi: Math.round(Math.min(W / (wPt / 72), H / (hPt / 72))), x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) });
}

// Everything the checks need from one PDF, page by page (all lengths in mm, origin at the page's top-left).
export function inspectPdf(buf) {
  const pdf = readPdf(buf);
  const fonts = new Map();
  const pages = pdf.pages.map((p) => {
    const mb = box(pdf, p.MediaBox) || { x0: 0, y0: 0, x1: 612, y1: 792 };
    const tb = box(pdf, p.TrimBox), bb = box(pdf, p.BleedBox);
    const out = { images: [], text: [], lines: [] };
    const res = p.Resources;
    const contents = [].concat(pdf.get(p.node.Contents) ?? []);
    const data = (Array.isArray(pdf.get(p.node.Contents)) ? pdf.get(p.node.Contents) : [p.node.Contents]).map((c) => pdf.streamOf(c) ?? '').join('\n');
    runContent(pdf, data, res, [1, 0, 0, 1, 0, 0], out);
    for (const [, f] of Object.entries(pdf.get(pdf.get(res)?.Font) || {})) { const i = fontInfo(pdf, f); if (!fonts.has(i.name)) fonts.set(i.name, i.embedded); else if (!i.embedded) fonts.set(i.name, false); }
    // also fonts used inside forms
    const toMm = (r) => ({ x0: (r.x0 - mb.x0) * PT, x1: (r.x1 - mb.x0) * PT, y0: (mb.y1 - r.y1) * PT, y1: (mb.y1 - r.y0) * PT });
    void contents;
    return {
      w: (mb.x1 - mb.x0) * PT, h: (mb.y1 - mb.y0) * PT, rotate: +pdf.get(p.Rotate) || 0,
      trimBox: tb ? toMm(tb) : null, bleedBox: bb ? toMm(bb) : null,
      images: out.images.map((im) => ({ ...im, ...toMm(im) })),
      text: out.text.map((t) => ({ ...t, ...toMm(t) })),
      lines: out.lines,
    };
  });
  // fonts used in form XObjects aren't in the page's own resources: scan every font dictionary once
  for (const [, o] of pdf.objs) if (o.v?.Type === '/Font' && o.v.Subtype !== '/CIDFontType0' && o.v.Subtype !== '/CIDFontType2') { const i = fontInfo(pdf, o.v); if (!fonts.has(i.name)) fonts.set(i.name, i.embedded); else if (!i.embedded) fonts.set(i.name, false); }
  const colour = /\/DeviceCMYK|\/ICCBased[\s\S]{0,40}\/N 4|\bk\b/.test(pdf.s.slice(0, 2e6)) && !/\/DeviceRGB/.test(pdf.s.slice(0, 2e6)) ? 'CMYK' : /\/DeviceCMYK/.test(pdf.s) ? 'mixed RGB and CMYK' : 'RGB';
  return { pages, fonts: [...fonts].map(([name, embedded]) => ({ name, embedded })), colour, version: pdf.s.slice(5, 8) };
}

// ---------- page images (for the sheet and the bleed check) ----------
function which(cmd) { try { execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' }); return true; } catch { return false; } }
export function rasterize(pdfFile, dpi, dir) {
  mkdirSync(dir, { recursive: true });
  const list = () => readdirSync(dir).filter((f) => /^p-\d+\.png$/.test(f)).sort().map((f) => join(dir, f));
  const tries = [
    ['gs', () => execFileSync('gs', ['-q', '-dNOPAUSE', '-dBATCH', '-dSAFER', '-sDEVICE=png16m', `-r${dpi}`, '-dTextAlphaBits=4', '-dGraphicsAlphaBits=4', `-sOutputFile=${join(dir, 'p-%02d.png')}`, pdfFile], { stdio: 'ignore', timeout: 120000 })],
    ['pdftoppm', () => { execFileSync('pdftoppm', ['-r', String(dpi), '-png', pdfFile, join(dir, 'q')], { stdio: 'ignore', timeout: 120000 }); readdirSync(dir).filter((f) => /^q-\d+\.png$/.test(f)).sort().forEach((f, i) => execFileSync('mv', [join(dir, f), join(dir, `p-${String(i + 1).padStart(2, '0')}.png`)])); }],
    ['mutool', () => execFileSync('mutool', ['draw', '-q', '-r', String(dpi), '-o', join(dir, 'p-%02d.png'), pdfFile], { stdio: 'ignore', timeout: 120000 })],
    ['python3', () => execFileSync('python3', ['-c', `import fitz,sys\nd=fitz.open(sys.argv[1])\nfor i,p in enumerate(d): p.get_pixmap(dpi=${dpi}).save(sys.argv[2]+'/p-%02d.png'%(i+1))`, pdfFile, dir], { stdio: 'ignore', timeout: 120000 })],
  ];
  for (const [cmd, run] of tries) { if (!which(cmd)) continue; try { run(); if (list().length) return { files: list(), via: cmd }; } catch { /* next */ } }
  return { files: [], via: null };
}
const png = (b) => (b.readUInt32BE(0) === 0x89504e47 ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } : null);
function jpg(b) { if (b[0] !== 0xff || b[1] !== 0xd8) return null; for (let i = 2; i < b.length - 9;) { if (b[i] !== 0xff) { i++; continue; } const mk = b[i + 1]; if (mk === 0xd8 || mk === 0x01 || (mk >= 0xd0 && mk <= 0xd7)) { i += 2; continue; } const len = b.readUInt16BE(i + 2); if (mk >= 0xc0 && mk <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(mk)) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) }; i += 2 + len; } return null; }

// ---------- check ----------
export async function check(target, { trim, bleed, safe, out = 'look/print', dpi, plain = false } = {}) {
  const root = resolve(target);
  const files = statSync(root).isDirectory() ? readdirSync(root, { recursive: true }).map(String).filter((f) => /\.(pdf|png|jpe?g)$/i.test(f) && !/(^|\/)(look|palm|node_modules)\//.test(f) && !/-sheet\.png$/.test(f)).map((f) => join(root, f)) : [root];
  if (!files.length) throw new Error('No PDF, PNG or JPEG print files found.');
  const want = trim ? parseSize(trim) : null, wantBleed = parseLen(bleed, null), wantSafe = parseLen(safe, null);
  const issues = [], report = [];
  const tmp = mkdtempSync(join(tmpdir(), 'palm-print-'));
  const shots = [];
  try {
    for (const [fi, file] of files.entries()) {
      const rel = statSync(root).isDirectory() ? file.slice(root.length + 1) : basename(file);
      const buf = readFileSync(file), ext = extname(file).toLowerCase();
      const rec = { file: rel, type: ext.slice(1), pages: [] };
      const add = (id, level, msg, fix) => issues.push(issue(id, level, `${rel}: ${msg}`, fix));
      if (ext === '.pdf') {
        let info; try { info = inspectPdf(buf); } catch (e) { add('pdf-unreadable', 'error', `Palm couldn't read this PDF (${e.message}).`); report.push(rec); continue; }
        rec.colour = info.colour; rec.fonts = info.fonts;
        for (const f of info.fonts.filter((x) => !x.embedded)) add('font-not-embedded', 'error', `the font ${f.name} isn't embedded, so the printer substitutes another (MOO: embed or outline every font).`, 'Export with fonts embedded (a browser-made PDF embeds them), or convert text to outlines.');
        if (info.colour !== 'CMYK') add('colour-rgb', 'info', `colours are ${info.colour}; the printer converts to CMYK and bright RGB greens, blues and oranges can print duller (Mixam asks for CMYK).`);
        const pageDpi = dpi || (Math.max(...info.pages.map((p) => p.w * p.h)) > 300 * 420 ? 150 : 300);
        const ras = rasterize(file, pageDpi, join(tmp, `f${fi}`));
        if (!ras.files.length) add('no-renderer', 'warn', `no PDF renderer found, so the pages aren't drawn and the bleed isn't measured. Install Ghostscript (brew install ghostscript), poppler (pdftoppm) or PyMuPDF.`);
        info.pages.forEach((p, i) => {
          const pr = measurePage(p, { want, wantBleed, wantSafe }, (id, level, msg, fix) => add(id, level, `page ${i + 1}: ${msg}`, fix));
          rec.pages.push(pr);
          if (ras.files[i]) shots.push({ file: rel, page: i + 1, png: ras.files[i], dpi: pageDpi, geo: pr.geo, images: p.images, text: p.text, measures: pr });
        });
      } else {
        const d = png(buf) || jpg(buf);
        if (!d) { add('image-unreadable', 'error', `not a PNG or JPEG Palm can read.`); report.push(rec); continue; }
        // An image file is the whole page: its size in mm depends on its ppi. Find the ppi that makes it a known size.
        const t = want || null; const b = wantBleed ?? 3;
        let geo, ppi;
        if (t) {
          const tw = d.w > d.h === t.w > t.h ? t : { w: t.h, h: t.w };
          ppi = Math.min(d.w / ((tw.w + 2 * b) / 25.4), d.h / ((tw.h + 2 * b) / 25.4));
          const ratioOk = Math.abs(d.w / d.h - (tw.w + 2 * b) / (tw.h + 2 * b)) < 0.01;
          if (!ratioOk) add('image-ratio', 'error', `${d.w}×${d.h} px isn't the shape of ${r1(tw.w)}×${r1(tw.h)} mm plus ${b} mm bleed (${r1(tw.w + 2 * b)}×${r1(tw.h + 2 * b)} mm). Mixam: image files must be supplied at the bleed size.`);
          geo = { w: tw.w + 2 * b, h: tw.h + 2 * b, bleed: b, safe: wantSafe ?? defaultSafe(tw), trimW: tw.w, trimH: tw.h };
        } else {
          add('image-no-trim', 'warn', `an image file carries no page size; say the finished size with --trim (e.g. --trim 85x55mm) so Palm can check its resolution and bleed.`);
          ppi = 300; geo = { w: d.w / ppi * 25.4, h: d.h / ppi * 25.4, bleed: 0, safe: 3, trimW: d.w / ppi * 25.4, trimH: d.h / ppi * 25.4 };
        }
        if (ppi < 100) add('low-ppi', 'error', `${d.w}×${d.h} px prints at ${Math.round(ppi)} ppi at that size; Mixam won't print under 100 dpi.`, 'Render it larger (at 300 ppi: width = mm ÷ 25.4 × 300).');
        else if (ppi < 290) add('low-ppi', 'warn', `${d.w}×${d.h} px prints at ${Math.round(ppi)} ppi; Mixam and MOO recommend 300.`);
        add('raster-text', 'info', `an image file turns text into pixels; MOO and Mixam prefer a vector PDF for text and graphics (crisper type).`);
        const pr = { size: `${r1(geo.w)}×${r1(geo.h)} mm at ${Math.round(ppi)} ppi`, ppi: Math.round(ppi), geo };
        rec.pages.push(pr);
        shots.push({ file: rel, page: 1, png: file, dpi: ppi, geo, images: [], text: [], measures: pr });
      }
      report.push(rec);
    }
    let sheet = null;
    if (shots.length) {
      const o = resolve(out); mkdirSync(dirname(o), { recursive: true });
      const m = await drawSheet(shots, o + '-sheet.png', { plain });
      sheet = o + '-sheet.png';
      for (const [k, s] of shots.entries()) {
        const mm = m[k]; if (!mm) continue;
        const pr = s.measures; pr.edges = mm.edges;
        for (const e of mm.edges.filter((x) => x.whiteSliver)) issues.push(issue('no-bleed-edge', 'error', `${s.file}: page ${s.page}: the ${e.side} edge's background stops at the trim line (inside ${Math.round(e.inside * 100)}% ink, bleed ${Math.round(e.bleed * 100)}%): if the blade drifts, a white sliver shows.`, 'Extend every background, photo and colour block to the outer edge of the bleed.'));
      }
    }
    const errors = issues.filter((i) => i.level === 'error').length, warnings = issues.filter((i) => i.level === 'warn').length;
    return { ok: errors === 0, errors, warnings, files: report, issues, sheet };
  } finally { try { rmSync(tmp, { recursive: true, force: true }); } catch {} }
}
const defaultSafe = (t) => (Math.min(t.w, t.h) <= 100 ? 3 : 5); // Raksul 3 mm for cards; Mixam's 5 mm quiet area for bigger items

function measurePage(p, { want, wantBleed, wantSafe }, add) {
  const pr = { size: `${r1(p.w)}×${r1(p.h)} mm` };
  // the trim: TrimBox, else what the user said, else a known size inside the page
  let trimW, trimH, bleed;
  if (p.trimBox) { trimW = p.trimBox.x1 - p.trimBox.x0; trimH = p.trimBox.y1 - p.trimBox.y0; bleed = Math.min(p.trimBox.x0, p.trimBox.y0, p.w - p.trimBox.x1, p.h - p.trimBox.y1); pr.trimBox = true; }
  else if (want) { const tw = p.w > p.h === want.w > want.h ? want : { w: want.h, h: want.w }; trimW = tw.w; trimH = tw.h; bleed = Math.min((p.w - trimW) / 2, (p.h - trimH) / 2); }
  else { const g = guessTrim(p.w, p.h); if (g) { trimW = g.w; trimH = g.h; bleed = g.bleed; pr.guessed = g.name; } else { trimW = p.w; trimH = p.h; bleed = 0; pr.guessed = 'unknown size'; } }
  const needBleed = wantBleed ?? 3;
  if (want) { const tw = p.w > p.h === want.w > want.h ? want : { w: want.h, h: want.w }; if (Math.abs(trimW - tw.w) > 0.6 || Math.abs(trimH - tw.h) > 0.6) add('trim-size', 'error', `the finished size is ${r1(trimW)}×${r1(trimH)} mm, not the ${r1(tw.w)}×${r1(tw.h)} mm asked for.`); }
  if (bleed < -0.3) add('page-small', 'error', `the page (${pr.size}) is smaller than the finished size.`);
  else if (bleed < 0.5) add('no-bleed', 'error', `the page is exactly the finished size (${r1(trimW)}×${r1(trimH)} mm) with no bleed; printers want ${needBleed} mm more on every side: ${r1(trimW + 2 * needBleed)}×${r1(trimH + 2 * needBleed)} mm (Mixam, Raksul).`, `Make each page ${r1(trimW + 2 * needBleed)}×${r1(trimH + 2 * needBleed)} mm and run the background to its edges (node print-check.mjs render … --trim ${r1(trimW)}x${r1(trimH)}mm --bleed ${needBleed}mm).`);
  else if (Math.abs(bleed - needBleed) > 0.4) add('bleed-size', 'warn', `the bleed is ${r1(bleed)} mm a side; the printer asked for ${needBleed} mm (page should be ${r1(trimW + 2 * needBleed)}×${r1(trimH + 2 * needBleed)} mm).`);
  if (!p.trimBox && bleed >= 0.5) add('no-trimbox', 'info', `no TrimBox in the PDF; Mixam asks for the trim box set to the finished size (Palm's render sets it).`);
  const safe = wantSafe ?? defaultSafe({ w: trimW, h: trimH });
  const geo = { w: p.w, h: p.h, bleed: Math.max(0, (p.w - trimW) / 2), bleedY: Math.max(0, (p.h - trimH) / 2), trimW, trimH, safe };
  pr.geo = geo; pr.trim = `${r1(trimW)}×${r1(trimH)} mm`; pr.bleed = r1(Math.max(0, bleed));
  // text outside the safe area (estimated from the PDF's text positions)
  const sx0 = geo.bleed + safe, sy0 = geo.bleedY + safe, sx1 = p.w - geo.bleed - safe, sy1 = p.h - geo.bleedY - safe;
  const near = p.text.filter((t) => t.size >= 3 && (t.x0 < sx0 - 0.3 || t.y0 < sy0 - 0.3 || t.y1 > sy1 + 0.3 || Math.min(t.x1, p.w) > sx1 + 0.8));
  const cut = p.text.filter((t) => t.x0 < geo.bleed - 0.2 || t.y0 < geo.bleedY - 0.2 || t.y1 > p.h - geo.bleedY + 0.2);
  if (cut.length) add('text-in-bleed', 'error', `${cut.length} line(s) of text start in the bleed or past the trim; they'll be cut off.`);
  else if (near.length) add('text-near-edge', 'warn', `${near.length} line(s) of text come within ${safe} mm of the cut (Raksul: keep text ≥3 mm inside; Mixam: 5 mm quiet area). Text positions are estimated from the PDF; check the sheet.`);
  pr.text_near_edge = near.length;
  // smallest text, thinnest line
  const sizes = p.text.map((t) => t.size).filter((x) => x > 0.5);
  if (sizes.length) {
    const min = Math.min(...sizes); pr.min_text_pt = r1(min);
    if (min < 6) add('text-tiny', 'error', `the smallest text is ${r1(min)} pt; Raksul: under 6 pt may blur or fill in; MOO: at least 8 pt.`);
    else if (min < 7.9) add('text-small', 'warn', `the smallest text is ${r1(min)} pt; MOO asks for at least 8 pt.`);
  }
  const lines = p.lines.filter((l) => l.zero || l.w > 0);
  if (lines.some((l) => l.zero)) add('hairline', 'error', `a line has width 0 (a "hairline": the thinnest line the device can draw), which can vanish in print.`, 'Give it at least 0.5 pt.');
  const thin = lines.filter((l) => !l.zero).map((l) => l.w);
  if (thin.length) { const mn = Math.min(...thin); pr.min_line_pt = Math.round(mn * 100) / 100; if (mn < 0.3) add('line-thin', 'error', `the thinnest line is ${pr.min_line_pt} pt; Raksul: at least 0.3 pt; MOO: 0.5 pt (1 pt in light colours).`); else if (mn < 0.5) add('line-thin', 'warn', `the thinnest line is ${pr.min_line_pt} pt; MOO asks for 0.5 pt (1 pt in light colours).`); }
  // placed photos
  const imgs = p.images.filter((i) => i.x1 - i.x0 > 3 && i.y1 - i.y0 > 3);
  pr.images = imgs.map((i) => ({ name: i.name, px: i.px.join('×'), placed_mm: `${r1(i.x1 - i.x0)}×${r1(i.y1 - i.y0)}`, ppi: i.ppi }));
  for (const i of imgs) {
    if (i.ppi < 100) add('low-ppi', 'error', `a photo (${i.px.join('×')} px) is placed at ${r1(i.x1 - i.x0)}×${r1(i.y1 - i.y0)} mm, so it prints at ${i.ppi} ppi; Mixam won't print under 100 and it will look soft or blocky.`, 'Place it smaller, crop less, or use a bigger original; 300 ppi = mm ÷ 25.4 × 300 px.');
    else if (i.ppi < 290) add('low-ppi', 'warn', `a photo (${i.px.join('×')} px) prints at ${i.ppi} ppi at ${r1(i.x1 - i.x0)}×${r1(i.y1 - i.y0)} mm; Mixam and MOO recommend 300 (Raksul 350).`);
  }
  if (imgs.length) pr.min_ppi = Math.min(...imgs.map((i) => i.ppi));
  return pr;
}

// ---------- the sheet ----------
async function drawSheet(shots, outFile, { plain = false } = {}) {
  const browser = await launch();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1500, height: 1000, deviceScaleFactor: 1 });
    const data = shots.map((s) => ({ file: s.file, page: s.page, src: 'data:image/png;base64,' + readFileSync(s.png).toString('base64'), geo: s.geo, dpi: s.dpi,
      low: (s.images || []).slice().sort((a, b) => a.ppi - b.ppi)[0] || null, label: s.measures.size }));
    await page.setContent(`<!doctype html><html><head><style>
      body{margin:0;font:14px/1.35 -apple-system,system-ui,sans-serif;background:#ecebe8;color:#111}
      .sec{padding:22px 28px;border-bottom:1px solid #ccc;background:#fff;margin-bottom:10px}
      h2{font-size:13px;letter-spacing:.05em;text-transform:uppercase;color:#555;margin:0 0 12px}
      .row{display:flex;gap:26px;align-items:flex-start;flex-wrap:wrap}.lab{font-size:12px;color:#555;margin-top:6px;max-width:420px}
      .wrap{position:relative;display:inline-block;box-shadow:0 1px 4px rgba(0,0,0,.25)}
      .wrap img{display:block}.ov{position:absolute;inset:0;pointer-events:none}
      .cut{overflow:hidden;position:relative;box-shadow:0 2px 8px rgba(0,0,0,.3);background:#fff}
      .cut img{position:absolute;display:block}.mat{background:#6f747a;padding:14px;border-radius:6px}.mat .lab{color:#eee}
      .desk{background:#b9a58a;padding:24px;border-radius:6px;display:flex;gap:22px;align-items:center}
      .cc{width:85.6mm;height:53.98mm;border-radius:3.2mm;background:linear-gradient(135deg,#2b4f7a,#1b2f4a);position:relative;box-shadow:0 2px 6px rgba(0,0,0,.35)}
      .cc i{position:absolute;left:7mm;top:16mm;width:11mm;height:8.5mm;border-radius:1.5mm;background:#d8c27a}
      .zoom{width:300px;height:300px;overflow:hidden;position:relative;border:1px solid #999;background:#fff}
      .zoom img{position:absolute;image-rendering:pixelated}
    </style></head><body><div id="root"></div></body></html>`);
    const measures = await page.evaluate(async (data, plain) => {
      const root = document.getElementById('root'), out = [];
      const load = (src) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => ok(null); i.src = src; });
      for (const d of data) {
        const img = await load(d.src); if (!img) { out.push(null); continue; }
        const g = d.geo, pxmm = img.naturalWidth / g.w, by = g.bleedY ?? g.bleed;
        // bleed measurement: ink in the bleed strip vs just inside the trim, per edge
        const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; const x = c.getContext('2d'); x.drawImage(img, 0, 0);
        const ink = (x0, y0, w, h) => { w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h)); const p = x.getImageData(Math.max(0, Math.round(x0)), Math.max(0, Math.round(y0)), w, h).data; let n = 0, t = 0; for (let k = 0; k < p.length; k += 16) { t++; if (p[k] < 238 || p[k + 1] < 238 || p[k + 2] < 238) n++; } return t ? n / t : 0; };
        const edges = [];
        if (g.bleed >= 0.5 || by >= 0.5) {
          const W = img.naturalWidth, H = img.naturalHeight, b = g.bleed * pxmm, bY = by * pxmm, s1 = 0.3 * pxmm, s2 = 1.5 * pxmm;
          const sides = { left: [ink(0.15 * b, bY, 0.7 * b, H - 2 * bY), ink(b + s1, bY, s2 - s1, H - 2 * bY)], right: [ink(W - 0.85 * b, bY, 0.7 * b, H - 2 * bY), ink(W - b - s2, bY, s2 - s1, H - 2 * bY)],
            top: [ink(b, 0.15 * bY, W - 2 * b, 0.7 * bY), ink(b, bY + s1, W - 2 * b, s2 - s1)], bottom: [ink(b, H - 0.85 * bY, W - 2 * b, 0.7 * bY), ink(b, H - bY - s2, W - 2 * b, s2 - s1)] };
          for (const [side, [bl, ins]] of Object.entries(sides)) edges.push({ side, bleed: Math.round(bl * 100) / 100, inside: Math.round(ins * 100) / 100, whiteSliver: ins > 0.3 && bl < ins * 0.5 });
        }
        out.push({ edges });
        // section
        const sec = document.createElement('div'); sec.className = 'sec';
        const S = Math.min(640 / g.w, 520 / g.h); // px per mm in the overview
        const ov = (w, h) => `<svg class="ov" viewBox="0 0 ${g.w} ${g.h}" width="${w}" height="${h}" preserveAspectRatio="none">
          <path d="M0 0H${g.w}V${g.h}H0Z M${g.bleed} ${by}V${g.h - by}H${g.w - g.bleed}V${by}Z" fill="rgba(255,40,80,.22)" fill-rule="evenodd"/>
          <rect x="${g.bleed}" y="${by}" width="${g.trimW}" height="${g.trimH}" fill="none" stroke="#0a7" stroke-width="${0.35}"/>
          <rect x="${g.bleed + g.safe}" y="${by + g.safe}" width="${g.trimW - 2 * g.safe}" height="${g.trimH - 2 * g.safe}" fill="none" stroke="#06f" stroke-width="${0.3}" stroke-dasharray="1.2 0.8"/></svg>`;
        let html = `<h2>${d.file} · page ${d.page} · ${d.label} · finished ${Math.round(g.trimW * 10) / 10}×${Math.round(g.trimH * 10) / 10} mm</h2><div class="row">
          <div><div class="wrap"><img src="${d.src}" style="width:${g.w * S}px;height:${g.h * S}px">${ov(g.w * S, g.h * S)}</div>
          <div class="lab">Red: bleed (cut off). Green: trim (the cut). Blue dashes: safe line (${g.safe} mm in). ${!plain && edges.filter((e) => e.whiteSliver).length ? '<b style="color:#c00">Background stops at the trim on: ' + edges.filter((e) => e.whiteSliver).map((e) => e.side).join(', ') + '</b>' : ''}</div></div>`;
        // as cut, with the blade 1 mm off
        const T = Math.min(300 / g.trimW, 260 / g.trimH);
        html += `<div><div class="row mat" style="gap:14px">` + [[-1, -1, 'blade 1 mm up-left'], [0, 0, 'cut on the line'], [1, 1, 'blade 1 mm down-right']].map(([dx, dy, t]) =>
          `<div><div class="cut" style="width:${g.trimW * T}px;height:${g.trimH * T}px"><img src="${d.src}" style="width:${g.w * T}px;height:${g.h * T}px;left:${-(g.bleed + dx) * T}px;top:${-(by + dy) * T}px"></div><div class="lab">${t}</div></div>`).join('') + `</div>
          <div class="lab" style="margin-top:4px">Each copy is cut from a stack; the blade lands within about a millimetre. Nothing important should be lost, and no white edge should appear.</div></div></div>`;
        // real size
        const small = g.trimW <= 100 && g.trimH <= 100;
        html += `<div class="row" style="margin-top:18px"><div><div class="desk"><div class="cut" style="width:${g.trimW}mm;height:${g.trimH}mm"><img src="${d.src}" style="width:${g.w}mm;height:${g.h}mm;left:${-g.bleed}mm;top:${-by}mm"></div>${small ? '<div class="cc"><i></i></div>' : ''}</div>
          <div class="lab">At real size on a normal screen (CSS millimetres)${small ? ', beside a credit card (85.6 × 54 mm)' : ''}: can you read the smallest line?</div></div>`;
        if (d.low && (plain || d.low.ppi < 300)) {
          const cx = (d.low.x0 + d.low.x1) / 2, cy = (d.low.y0 + d.low.y1) / 2, Z = 300 / 20; // 20 mm square at 15 px/mm
          html += `<div><div class="zoom"><img src="${d.src}" style="width:${g.w * Z}px;height:${g.h * Z}px;left:${-(cx - 10) * Z}px;top:${-(cy - 10) * Z}px"></div>
            <div class="lab">${plain ? 'A 20 mm square of the photo as it will print, enlarged.' : `The lowest-resolution photo (${d.low.px.join('×')} px, ${d.low.ppi} ppi as placed), a 20 mm square as it will print, enlarged. Soft or blocky here is soft or blocky on paper.`}</div></div>`;
        }
        html += `</div>`;
        sec.innerHTML = html; root.appendChild(sec);
      }
      await Promise.all([...document.images].map((i) => i.complete ? 0 : new Promise((r) => { i.onload = i.onerror = r; })));
      return out;
    }, data, plain);
    const h = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewport({ width: 1500, height: Math.min(h, 14000), deviceScaleFactor: 1 });
    await page.screenshot({ path: outFile, fullPage: true });
    return measures;
  } finally { await browser.close(); }
}

// ---------- render: HTML → print PDF at trim + bleed, with TrimBox and BleedBox ----------
export async function render(html, { trim, bleed = '3mm', out = 'print/out.pdf' } = {}) {
  if (!trim) throw new Error('Say the finished size: --trim 85x55mm (or a5, 3.5x2in…).');
  const t = parseSize(trim), b = parseLen(bleed, 3);
  const W = t.w + 2 * b, H = t.h + 2 * b;
  const browser = await launch();
  const o = resolve(out); mkdirSync(dirname(o), { recursive: true });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: Math.round(W / 25.4 * 96), height: Math.round(H / 25.4 * 96) });
    await page.goto(pathToFileURL(resolve(html)).href, { waitUntil: 'networkidle0', timeout: 60000 });
    await page.evaluate(() => document.fonts?.ready);
    const pdf = await page.pdf({ width: `${W}mm`, height: `${H}mm`, printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 }, preferCSSPageSize: false });
    writeFileSync(o, setBoxes(Buffer.from(pdf), b, { w: W, h: H }));
  } finally { await browser.close(); }
  const r = await check(o, { trim, bleed, out: o.replace(/\.pdf$/i, '') + '-look' });
  return { pdf: o, ...r };
}
// Adds TrimBox and BleedBox to every page with an incremental update (the original bytes are untouched).
const ser = (v) => v === null ? 'null' : typeof v === 'number' ? String(Math.round(v * 1000) / 1000) : typeof v === 'boolean' ? String(v) : typeof v === 'string' ? v
  : Array.isArray(v) ? '[' + v.map(ser).join(' ') + ']' : 'ref' in v ? `${v.ref} 0 R` : 'str' in v ? '<' + Buffer.from(v.str, 'latin1').toString('hex') + '>' : 'op' in v ? v.op : '<<' + Object.entries(v).map(([k, x]) => `/${k} ${ser(x)}`).join(' ') + '>>';
// Chrome rounds a page up to whole CSS pixels (154 mm → 154.25 mm), so the MediaBox is also set to the exact size,
// keeping the top-left corner where it is (the rounding only ever adds a sliver of bleed on the right and bottom).
export function setBoxes(buf, bleedMm, exact = null) {
  const pdf = readPdf(buf), s = pdf.s;
  const sx = s.lastIndexOf('startxref'); const prev = parseInt(s.slice(sx + 9).trim(), 10);
  const tr = s.lastIndexOf('trailer'); let trailer = {};
  if (tr > 0 && tr < sx) trailer = new Lexer(s, tr + 7).value();
  else for (const [, o] of pdf.objs) if (o.v?.Type === '/XRef') trailer = o.v;
  const b = bleedMm / PT; let body = '', offs = [];
  let pos = buf.length + 1;
  for (const p of pdf.pages) {
    const num = [...pdf.objs].find(([, o]) => o.v === p.node)?.[0]; if (num == null) continue;
    const mb = box(pdf, p.MediaBox); if (!mb) continue;
    const W = exact ? exact.w / PT : mb.x1 - mb.x0, H = exact ? exact.h / PT : mb.y1 - mb.y0;
    const m = { x0: mb.x0, y1: mb.y1, x1: mb.x0 + W, y0: mb.y1 - H };
    const d = { ...p.node, MediaBox: [m.x0, m.y0, m.x1, m.y1], CropBox: [m.x0, m.y0, m.x1, m.y1], TrimBox: [m.x0 + b, m.y0 + b, m.x1 - b, m.y1 - b], BleedBox: [m.x0, m.y0, m.x1, m.y1] };
    const chunk = `${num} 0 obj\n${ser(d)}\nendobj\n`;
    offs.push([num, pos + body.length]); body += chunk;
  }
  if (!offs.length) return buf;
  const xrefAt = pos + body.length;
  let xref = 'xref\n'; for (const [n, o] of offs.sort((a, c) => a[0] - c[0])) xref += `${n} 1\n${String(o).padStart(10, '0')} 00000 n \n`;
  const t = { Size: trailer.Size ?? Math.max(...pdf.objs.keys()) + 1, Root: trailer.Root, ...(trailer.Info ? { Info: trailer.Info } : {}), ...(trailer.ID ? { ID: trailer.ID } : {}), Prev: prev };
  const tail = `${xref}trailer\n${ser(t)}\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.concat([buf, Buffer.from('\n' + body + tail, 'latin1')]);
}

// ---------- self-test ----------
async function selfTest() {
  const d = mkdtempSync(join(tmpdir(), 'print-test-'));
  const photo = join(d, 'small.png');
  // a deliberately small photo: 120×80 px
  const b = await launch(); try { const p = await b.newPage(); await p.setViewport({ width: 120, height: 80 }); await p.setContent('<body style="margin:0;background:linear-gradient(90deg,#c84,#48c)"></body>'); await p.screenshot({ path: photo }); } finally { await b.close(); }
  // bad: no bleed, background to the edge, 5 pt text near the edge, a big placed low-res photo, a hairline
  writeFileSync(join(d, 'bad.html'), `<html><head><style>@page{size:85mm 55mm;margin:0}body{margin:0}section{width:85mm;height:55mm;background:#1d3b2a;color:#fff;position:relative;overflow:hidden;font-family:Helvetica}</style></head><body><section>
    <p style="position:absolute;left:1mm;top:1mm;margin:0;font-size:5pt">tiny text at the edge</p><img src="small.png" style="position:absolute;right:4mm;bottom:4mm;width:40mm;height:26.7mm"><div style="position:absolute;left:10mm;top:30mm;width:30mm;border-top:0.1pt solid #fff"></div></section></body></html>`);
  const badPdf = join(d, 'bad.pdf');
  const br = await launch(); try { const p = await br.newPage(); await p.goto(pathToFileURL(join(d, 'bad.html')).href, { waitUntil: 'networkidle0' }); writeFileSync(badPdf, await p.pdf({ width: '85mm', height: '55mm', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } })); } finally { await br.close(); }
  const bad = await check(badPdf, { trim: '85x55mm', out: join(d, 'look/bad') });
  const ids = bad.issues.map((i) => i.id);
  for (const want of ['no-bleed', 'text-tiny', 'low-ppi']) if (!ids.includes(want)) throw new Error(`bad file: expected ${want}, got ${ids.join(',')}`);
  // bad 2: right page size but the background stops at the trim
  writeFileSync(join(d, 'sliver.html'), `<html><head><style>body{margin:0}section{width:91mm;height:61mm;position:relative;background:#fff}div{position:absolute;left:3mm;top:3mm;width:85mm;height:55mm;background:#1d3b2a}</style></head><body><section><div></div></section></body></html>`);
  const sl = await render(join(d, 'sliver.html'), { trim: '85x55mm', bleed: '3mm', out: join(d, 'sliver.pdf') });
  if (!sl.issues.some((i) => i.id === 'no-bleed-edge')) throw new Error('sliver: expected no-bleed-edge, got ' + sl.issues.map((i) => i.id).join(','));
  // good: background into the bleed, text inside 3 mm, 9 pt, photo at ≥300 ppi
  const big = join(d, 'big.png');
  const b2 = await launch(); try { const p = await b2.newPage(); await p.setViewport({ width: 600, height: 400 }); await p.setContent('<body style="margin:0;background:linear-gradient(90deg,#c84,#48c)"></body>'); await p.screenshot({ path: big }); } finally { await b2.close(); }
  writeFileSync(join(d, 'good.html'), `<html><head><style>body{margin:0}section{width:91mm;height:61mm;background:#1d3b2a;color:#fff;position:relative;overflow:hidden;font-family:Helvetica;break-after:page}</style></head><body>
    <section><p style="position:absolute;left:9mm;top:9mm;margin:0;font-size:11pt">Fern &amp; Kiln</p><p style="position:absolute;left:9mm;top:16mm;margin:0;font-size:8.5pt">Opening 6 June</p><img src="big.png" style="position:absolute;right:9mm;bottom:9mm;width:40mm;height:26.7mm"></section>
    <section style="background:#f2ead8;color:#1d3b2a"><p style="position:absolute;left:9mm;top:9mm;margin:0;font-size:9pt">hello@fernandkiln.example</p></section></body></html>`);
  const good = await render(join(d, 'good.html'), { trim: '85x55mm', bleed: '3mm', out: join(d, 'good.pdf') });
  if (good.errors) throw new Error('good file flagged: ' + good.issues.filter((i) => i.level === 'error').map((i) => i.id + ' ' + i.msg).join(' | '));
  const gp = good.files[0].pages;
  if (gp.length !== 2 || !gp[0].trimBox || Math.abs(gp[0].geo.w - 91) > 0.2) throw new Error('good file: expected 2 pages of 91×61 with a TrimBox, got ' + JSON.stringify(gp.map((p) => p.size)));
  if (!(gp[0].min_ppi >= 300)) throw new Error('good file ppi: ' + gp[0].min_ppi);
  // A5: Chrome rounds 154 mm up to 154.25 mm; the PDF must still be exactly 154 × 216 mm with the trim exactly A5
  writeFileSync(join(d, 'a5.html'), `<html><head><style>body{margin:0}section{width:154mm;height:216mm;background:#24433f;color:#fff;position:relative;overflow:hidden;font:12pt Georgia}</style></head><body><section><p style="position:absolute;left:12mm;top:12mm;margin:0">Opening day</p></section></body></html>`);
  const a5 = await render(join(d, 'a5.html'), { trim: 'a5', bleed: '3mm', out: join(d, 'a5.pdf') });
  const ap = a5.files[0].pages[0];
  if (Math.abs(ap.geo.w - 154) > 0.05 || Math.abs(ap.geo.h - 216) > 0.05 || ap.trim !== '148×210 mm' || a5.errors) throw new Error('a5 not exact: ' + ap.size + ' trim ' + ap.trim + ' ' + a5.issues.map((i) => i.id).join(','));
  if (!existsSync(good.sheet)) throw new Error('no sheet');
  // an image file at bleed size and 300 ppi passes; a small one doesn't
  console.log(`print-check: all tests pass (bad: ${ids.join(',')}; good: ${gp.map((p) => p.size).join(' + ')}, min ${gp[0].min_text_pt} pt, ${gp[0].min_ppi} ppi; sheet ${good.sheet})`);
}

if (typeof process !== 'undefined' && process.argv?.[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
  const VALUED = new Set(['--out', '--trim', '--bleed', '--safe', '--dpi']);
  const pos = argv.filter((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1]));
  const done = (r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); };
  const fail = (e) => { console.error(String(e.message || e)); process.exit(2); };
  if (argv.includes('--test')) selfTest().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
  else if (pos[0] === 'render' && pos[1]) render(pos[1], { trim: opt('trim'), bleed: opt('bleed', '3mm'), out: opt('out', 'print/out.pdf') }).then(done, fail);
  else if (pos[0] === 'check' && pos[1]) check(pos[1], { trim: opt('trim'), bleed: opt('bleed'), safe: opt('safe'), out: opt('out', 'look/print'), dpi: opt('dpi') ? +opt('dpi') : undefined }).then(done, fail);
  else fail('usage: print-check.mjs render <design.html> --trim 85x55mm --bleed 3mm --out print/card.pdf\n       print-check.mjs check <file.pdf|png|jpg|folder> [--trim 85x55mm] [--bleed 3mm] [--safe 3mm] [--out look/print]');
}
