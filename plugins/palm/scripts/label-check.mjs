#!/usr/bin/env node
// Palm tool: label-check — lets an agent see a sheet of printable labels (Avery-style: round jar-lid labels, rectangle
// product labels, return-address labels) the way it comes out of a home printer and off the sheet. It lays the label
// sheet's die-cut outlines (from Avery's published specifications, below) over the PDF as printed and measures, label
// by label: whether the artwork sits on its label across the whole sheet (a grid that drifts by the last row: wrong pitch,
// wrong margins, page scaling), artwork crossing the die-cut or crowding it, a coloured background that stops at the cut
// (a white sliver when the sheet shifts) or that runs onto the next label on a sheet with no room for bleed, the smallest
// text in points (from the PDF's text layer; OCR when the text is only pixels), hairlines, the page size (US Letter vs
// A4) and the QR code: decoded from the printed label, its size and module size in mm, its quiet zone, and again as a
// phone camera sees it at 20 and 30 cm after ink spread. It draws a sheet: each page with the die-cuts over it, labels
// peeled off the sheet (top-left and bottom-right), the top-left one again with the sheet fed 1 mm off either way, one
// label at real size beside a US quarter, and the QR code at printed size and as the phone sees it.
// adds: tool, fresh-data. Runs on the user's machine with their Chrome/Edge/Chromium and a PDF renderer (Ghostscript,
// poppler's pdftoppm, mutool or PyMuPDF; print-check finds whichever is there). Needs print-check.mjs beside it and
// `npm i puppeteer-core jsqr` (Tesseract is optional, for text that is only pixels). Nothing leaves the machine.
//
//   node label-check.mjs templates                       → the label sheets Palm knows, with their geometry and source
//   node label-check.mjs grid 22807 --html lids.html     → each label's position (in and mm) and an HTML starter with
//                                                          one absolutely positioned box per label (bleed + safe area)
//   node label-check.mjs render lids.html --template 22807 --out print/lid-labels.pdf
//       → a PDF exactly the sheet's page size (no margins, no scaling, the PDF asks viewers to print at Actual size),
//         then checks it.
//   node label-check.mjs check <file.pdf|folder> [--template 22807 | --map lid=22807,jar=94207,address=5160] [--out look/labels]
//       → JSON {ok, errors, warnings, files:[…per page, per label…], issues, sheet}. Then LOOK at <out>-sheet.png.
//   node label-check.mjs --self-test
//
// Facts (read 26 Nov 2026 on avery.com, in headless Chrome): see TEMPLATES (each with its source) and AVERY below.
// Thresholds marked "Palm's" are Palm's own guidance for home inkjet/laser printing on paper labels, not a standard.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { inspectPdf, rasterize, readPdf, Lexer } from './print-check.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const BASES = [process.env.PALM_NODE_MODULES, here, join(here, '..'), process.cwd(), join(here, '../../yz-hd-tools')].filter(Boolean);
function loadPuppeteer() {
  for (const b of BASES) { try { return createRequire(join(b, 'x.js'))('puppeteer-core'); } catch { /* next */ } }
  throw new Error('puppeteer-core is not installed. Run: npm i puppeteer-core');
}
function jsqrSource() {
  const cands = [process.env.PALM_JSQR];
  for (const b of BASES) { try { cands.push(createRequire(join(b, 'x.js')).resolve('jsqr/dist/jsQR.js')); } catch { /* next */ } }
  cands.push(join(here, '../../src/authenticator/vendor/jsQR-1.4.0.js')); // Palm's own repo
  const f = cands.find((x) => x && existsSync(x));
  return f ? readFileSync(f, 'utf8') : null;
}
function findChrome() {
  const c = [process.env.PALM_CHROME, process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'];
  const p = c.find((x) => x && existsSync(x)); if (!p) throw new Error('No Chrome, Edge or Chromium found. Set PALM_CHROME to its path.'); return p;
}
const launch = () => loadPuppeteer().launch({ executablePath: findChrome(), headless: true, timeout: 90000, args: ['--no-sandbox', '--hide-scrollbars', '--allow-file-access-from-files'] });
const issue = (id, level, msg, fix) => ({ id, level, msg, ...(fix ? { fix } : {}) });
const IN = 25.4;
const r1 = (x) => Math.round(x * 10) / 10, r2 = (x) => Math.round(x * 100) / 100;

// ---------- the label sheets (Avery's published specifications) ----------
// Page, margins, label size and count are Avery's own figures (its "Product Specifications" on the avery.com product
// page of the Presta® blank sheet that Avery lists as template-compatible with the retail product). Pitch is derived:
// (page − 2 × margin − n × label) ÷ (n − 1) gaps, with the layout (across × down) from Avery's template line art.
// Corner radius isn't published: it's drawn from Avery's line art (approximate) and only used to draw the cut.
export const TEMPLATES = {
  '22807': {
    title: 'Avery 22807 Print-to-the-Edge Round Labels, 2" diameter, 12 per sheet',
    page: 'letter', pageIn: [8.5, 11], shape: 'round', wIn: 2, hIn: 2, across: 3, down: 4, topIn: 0.625, sideIn: 0.625, radiusIn: 1, printToEdge: true,
    aliases: ['94501', '22205', '22612', '22817', '22825', '22877', '22921', '22923', '22933', '40105', '41464', '41494', '5657', '5907', '64502', '80510', '92807', '97217'],
    source: [
      'https://www.avery.com/blank/labels/94501 (Presta 94501, read 2026-11-26): 12 labels per sheet; 2" diameter; print to the edge: yes; sheet 8-1/2" x 11"; margin (top and bottom) 0.625"; margin (left and right) 0.625"',
      'https://www.avery.com/templates/22807 (read 2026-11-26): "Print-to-the-Edge Round Labels, 2" diameter, 12 per sheet"; compatible templates include Presta 94501',
      'https://img.avery.com/.../line-art/22807: 3 across × 4 down',
    ],
  },
  '94207': {
    title: 'Avery Presta 94207 Rectangle Labels, 2" x 4", 10 per sheet',
    page: 'letter', pageIn: [8.5, 11], shape: 'rect', wIn: 4, hIn: 2, across: 2, down: 5, topIn: 0.5, sideIn: 0.156, radiusIn: 0.125, printToEdge: false,
    aliases: ['6431', '06431', '6468', '36465', '36466', '36467', '36468', '36469', '36564', '36565', '36566', '36567', '36568'],
    source: [
      'https://www.avery.com/blank/labels/94207 (read 2026-11-26): 10 labels per sheet; 2" x 4"; print to the edge: no; rectangle, rounded corners; sheet 8-1/2" x 11"; margin (top and bottom) 0.5"; margin (left and right) 0.156"',
      'https://www.avery.com/templates/presta-94207 (read 2026-11-26): compatible templates 06431, 6431, 6468, Presta 36465–36469, 36564–36568',
      'https://img.avery.com/.../line-art/94207: 2 across × 5 down, rows touching (no gap)',
    ],
  },
  '5160': {
    title: 'Avery 5160 Address Labels, 1" x 2-5/8", 30 per sheet',
    page: 'letter', pageIn: [8.5, 11], shape: 'rect', wIn: 2.625, hIn: 1, across: 3, down: 10, topIn: 0.5, sideIn: 0.1875, radiusIn: 0.0625, printToEdge: false,
    aliases: ['94200', '5260', '5520', '5620', '5630', '5660', '5810', '5960', '5970', '5971', '5972', '5979', '5980', '6240', '6241', '6460', '6461', '6476', '6478', '6479', '6498', '6521', '6525', '6526', '6560', '6585', '6970', '7660', '7666', '8160', '8215', '8250', '8460', '8620', '8660', '8810', '8860', '8920', '9160', '15160', '15510', '15660', '15700', '15960', '16460', '18160', '18260', '18660', '22837', '28660', '32660', '38260', '45160', '48160', '48260', '48360', '48460', '48860', '48960', '55160', '55260', '55360', '58160', '58260', '58660', '75160', '80509', '85560', '88560', '95915'],
    source: [
      'https://www.avery.com/blank/labels/94200 (Presta 94200, read 2026-11-26): 30 labels per sheet; 1" x 2-5/8"; print to the edge: no; rounded corners; sheet 8-1/2" x 11"; margin (top and bottom) 0.5"; margin (left and right) 0.1875"; compatible with 5160 and the others listed',
      'https://www.avery.com/templates/5160 (read 2026-11-26): "Address Labels, 1" x 2-5/8", 30 per sheet"',
      'https://img.avery.com/.../line-art/5160: 3 across × 10 down, rows touching (no gap)',
    ],
  },
};
// Avery's guidance (avery.com, read 2026-11-26).
export const AVERY = {
  bleed: 'Help, "What are the Bleed and the Safe Areas?": for full-bleed, print-to-edge products the background should extend to the bleed line or beyond; for downloaded templates "we recommend a bleed of 1/8" over the edge and to keep important items such as logos well inside the bounds of the label"; a round label\'s PDF turning into a square is the design properly bleeding past the label.',
  noBleedRoom: 'Article "How to Print Labels at Home": check the PDF proof; "if colors or images from one label extend onto the next, your label sheet doesn\'t have extra space for bleed. Pull the colors and images inside the safety area and leave white space around the design." Label sheets can shift slightly in the printer; keep text, logos, addresses, barcodes inside the safety area.',
  print: 'Same article: Paper size: match the label sheet (usually 8.5" × 11"); Scaling: always 100% (Actual Size), never "Fit to Page"; print a test on plain paper, lay it over the label sheet and hold both up to the light. Help, "Word Template Misalignment": check the PDF\'s Scale is 100% and test-print on plain paper.',
  weprint: 'Avery WePrint artwork guidelines (its own professional printing, for reference): fonts 3 pt or more, lines 0.5 pt or more, 300 dpi (800 preferred), 1/16" bleed and 1/16" safety line.',
};
// Palm's thresholds (Palm's guidance, for home printers on paper labels).
export const PALM = { safeMm: 3.2, cutMm: 1.6, minPt: 6, tinyPt: 5, minLinePt: 0.5, bleedMm: 1.6, driftMm: 1.0, qrSideMm: 15, qrMinSideMm: 10, qrModuleMm: 0.5, shiftMm: 1 };

export function findTemplate(code) {
  if (!code) return null;
  const k = String(code).toUpperCase().replace(/^AVERY\s*/, '').replace(/^PRESTA\s*/, '').trim();
  for (const [key, t] of Object.entries(TEMPLATES)) if (key === k || t.aliases.includes(k)) return { code: key, ...t };
  return null;
}
// Each label's rectangle in mm from the page's top-left.
export function labelRects(t) {
  const [pw, ph] = t.pageIn;
  const hgap = t.across > 1 ? (pw - 2 * t.sideIn - t.across * t.wIn) / (t.across - 1) : 0;
  const vgap = t.down > 1 ? (ph - 2 * t.topIn - t.down * t.hIn) / (t.down - 1) : 0;
  const out = [];
  for (let r = 0; r < t.down; r++) for (let c = 0; c < t.across; c++) {
    const x = t.sideIn + c * (t.wIn + hgap), y = t.topIn + r * (t.hIn + vgap);
    out.push({ i: out.length, row: r, col: c, x0: x * IN, y0: y * IN, w: t.wIn * IN, h: t.hIn * IN, xIn: x, yIn: y });
  }
  return { labels: out, hgapIn: hgap, vgapIn: vgap, hpitchIn: t.wIn + hgap, vpitchIn: t.hIn + vgap };
}

// ---------- grid: positions + an HTML starter ----------
export function grid(code, { html = null } = {}) {
  const t = findTemplate(code); if (!t) throw new Error(`Palm doesn't know the label sheet "${code}". Known: ${Object.keys(TEMPLATES).join(', ')} (and the codes Avery lists as compatible: node label-check.mjs templates).`);
  const g = labelRects(t);
  const bleedIn = t.printToEdge ? 0.125 : 0;
  const res = { template: t.code, title: t.title, page_in: t.pageIn, label_in: [t.wIn, t.hIn], shape: t.shape, across: t.across, down: t.down,
    top_margin_in: t.topIn, side_margin_in: t.sideIn, horizontal_pitch_in: r2(g.hpitchIn * 1000) / 1000, vertical_pitch_in: Math.round(g.vpitchIn * 10000) / 10000, gap_in: [Math.round(g.hgapIn * 10000) / 10000, Math.round(g.vgapIn * 10000) / 10000],
    print_to_edge: t.printToEdge, bleed_in: bleedIn, palm_safe_in: 0.125,
    labels: g.labels.map((l) => ({ i: l.i + 1, row: l.row + 1, col: l.col + 1, left_in: Math.round(l.xIn * 10000) / 10000, top_in: Math.round(l.yIn * 10000) / 10000, left_mm: r2(l.x0), top_mm: r2(l.y0) })), source: t.source };
  if (html) {
    const css = `@page{size:${t.pageIn[0]}in ${t.pageIn[1]}in;margin:0}
html,body{margin:0;padding:0}
.sheet{position:relative;width:${t.pageIn[0]}in;height:${t.pageIn[1]}in;overflow:hidden}
/* one .label per die-cut: exactly the label's size and place. Its .art may run ${bleedIn ? 'into the bleed (1/8 in past the cut; this sheet is print-to-the-edge)' : 'only inside the label (this sheet has no room for bleed: neighbours touch)'}. */
.label{position:absolute;width:${t.wIn}in;height:${t.hIn}in;box-sizing:border-box}
.art{position:absolute;inset:${-bleedIn}in;${t.shape === 'round' ? '' : ''}}
/* keep words, logos and the QR code inside .safe (Palm: 1/8 in inside the cut) */
.safe{position:absolute;${t.shape === 'round' ? `left:${(t.wIn * (1 - Math.SQRT1_2) / 2 + 0.06).toFixed(3)}in;right:${(t.wIn * (1 - Math.SQRT1_2) / 2 + 0.06).toFixed(3)}in;top:0.125in;bottom:0.125in` : 'inset:0.125in'};display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}`;
    const body = g.labels.map((l) => `  <div class="label" style="left:${l.xIn.toFixed(4)}in;top:${l.yIn.toFixed(4)}in"><div class="art"></div><div class="safe"><!-- label ${l.i + 1} --></div></div>`).join('\n');
    writeFileSync(html, `<!doctype html>\n<html><head><meta charset="utf-8"><title>${t.title}</title>\n<style>\n${css}\n</style></head>\n<body>\n<section class="sheet">\n${body}\n</section>\n</body></html>\n`);
    res.html = resolve(html);
    res.note = t.shape === 'round' ? 'For a round label, the .safe box is the square inside the circle; corners of the label are cut off.' : undefined;
  }
  return res;
}

// ---------- render: HTML → PDF at exactly the sheet's page size, Actual size ----------
const ser = (v) => v === null ? 'null' : typeof v === 'number' ? String(Math.round(v * 1000) / 1000) : typeof v === 'boolean' ? String(v) : typeof v === 'string' ? v
  : Array.isArray(v) ? '[' + v.map(ser).join(' ') + ']' : 'ref' in v ? `${v.ref} 0 R` : 'str' in v ? '<' + Buffer.from(v.str, 'latin1').toString('hex') + '>' : 'op' in v ? v.op : '<<' + Object.entries(v).map(([k, x]) => `/${k} ${ser(x)}`).join(' ') + '>>';
// Sets the page boxes to the exact page size and asks PDF viewers to print at 100% (/PrintScaling /None), by an
// incremental update (the original bytes stay as they are).
export function setActualSize(buf, wMm, hMm) {
  const pdf = readPdf(buf), s = pdf.s;
  const sx = s.lastIndexOf('startxref'); const prev = parseInt(s.slice(sx + 9).trim(), 10);
  const tr = s.lastIndexOf('trailer'); let trailer = {};
  if (tr > 0 && tr < sx) trailer = new Lexer(s, tr + 7).value(); else for (const [, o] of pdf.objs) if (o.v?.Type === '/XRef') trailer = o.v;
  const W = wMm / 25.4 * 72, H = hMm / 25.4 * 72;
  let body = ''; const offs = []; const pos = buf.length + 1;
  for (const p of pdf.pages) {
    const num = [...pdf.objs].find(([, o]) => o.v === p.node)?.[0]; if (num == null) continue;
    const mb = (pdf.get(p.MediaBox) || [0, 0, W, H]).map((x) => +pdf.get(x)); const x0 = Math.min(mb[0], mb[2]), y1 = Math.max(mb[1], mb[3]);
    const box = [x0, y1 - H, x0 + W, y1];
    const d = { ...p.node, MediaBox: box, CropBox: box, TrimBox: box };
    offs.push([num, pos + body.length]); body += `${num} 0 obj\n${ser(d)}\nendobj\n`;
  }
  const rootNum = [...pdf.objs].find(([, o]) => o.v === pdf.root)?.[0];
  if (rootNum != null) { const d = { ...pdf.root, ViewerPreferences: { PrintScaling: '/None' } }; offs.push([rootNum, pos + body.length]); body += `${rootNum} 0 obj\n${ser(d)}\nendobj\n`; }
  if (!offs.length) return buf;
  const xrefAt = pos + body.length;
  let xref = 'xref\n'; for (const [n, o] of offs.sort((a, c) => a[0] - c[0])) xref += `${n} 1\n${String(o).padStart(10, '0')} 00000 n \n`;
  const t = { Size: trailer.Size ?? Math.max(...pdf.objs.keys()) + 1, Root: trailer.Root, ...(trailer.Info ? { Info: trailer.Info } : {}), ...(trailer.ID ? { ID: trailer.ID } : {}), Prev: prev };
  return Buffer.concat([buf, Buffer.from('\n' + body + `${xref}trailer\n${ser(t)}\nstartxref\n${xrefAt}\n%%EOF\n`, 'latin1')]);
}
export async function render(html, { template, out = 'print/labels.pdf', look } = {}) {
  const t = findTemplate(template); if (!t) throw new Error('Say which label sheet: --template 22807 (node label-check.mjs templates lists them).');
  const [wIn, hIn] = t.pageIn;
  const o = resolve(out); mkdirSync(dirname(o), { recursive: true });
  const browser = await launch();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: Math.round(wIn * 96), height: Math.round(hIn * 96) });
    await page.goto(pathToFileURL(resolve(html)).href, { waitUntil: 'networkidle0', timeout: 60000 });
    await page.evaluate(() => document.fonts?.ready);
    const pdf = await page.pdf({ width: `${wIn}in`, height: `${hIn}in`, printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 }, preferCSSPageSize: false, scale: 1 });
    writeFileSync(o, setActualSize(Buffer.from(pdf), wIn * IN, hIn * IN));
  } finally { await browser.close(); }
  const r = await check(o, { template: t.code, out: look || o.replace(/\.pdf$/i, '') + '-look' });
  return { pdf: o, ...r };
}

// ---------- OCR (only when the text is pixels) ----------
function hasTesseract() { try { execFileSync('tesseract', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } }
function ocrWords(png, dpi) {
  const tsv = execFileSync('tesseract', [png, 'stdout', '--psm', '11', 'tsv'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64e6 });
  const words = [];
  for (const line of tsv.split('\n').slice(1)) {
    const c = line.split('\t'); if (c.length < 12 || c[0] !== '5') continue;
    const t = c[11].trim(), conf = +c[10];
    if (conf < 60 || (t.match(/[\p{L}\p{N}]/gu) || []).length < 2) continue;
    const k = 25.4 / dpi;
    // Palm's estimate: a word's box height ÷ 0.75 ≈ its font size (in pt: mm ÷ 25.4 × 72)
    words.push({ t, x0: +c[6] * k, y0: +c[7] * k, x1: (+c[6] + +c[8]) * k, y1: (+c[7] + +c[9]) * k, size: (+c[9] * k / 0.75) / 25.4 * 72, ocr: true });
  }
  return words;
}

// ---------- pixels, measured in Chrome (one function injected into the page) ----------
function pixelLib() {
  window.__measure = async (src, geo) => {
    const img = new Image(); img.src = src; await img.decode();
    const W = img.naturalWidth, H = img.naturalHeight, k = W / geo.pageW; // px per mm
    const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0);
    const D = x.getImageData(0, 0, W, H).data;
    window.__page = { c, W, H, k };
    const sd = (L, X, Y) => { // signed distance (mm) to the cut; >0 outside
      const cx = L.x0 + L.w / 2, cy = L.y0 + L.h / 2;
      if (geo.shape === 'round') return Math.hypot(X - cx, Y - cy) - L.w / 2;
      const r = Math.min(geo.radius, L.w / 2, L.h / 2), qx = Math.abs(X - cx) - (L.w / 2 - r), qy = Math.abs(Y - cy) - (L.h / 2 - r);
      return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
    };
    const diff = (i, b) => Math.max(Math.abs(D[i] - b[0]), Math.abs(D[i + 1] - b[1]), Math.abs(D[i + 2] - b[2]));
    const white = (i) => D[i] > 235 && D[i + 1] > 235 && D[i + 2] > 235;
    // a pixel that is only the background fading into white paper (anti-aliasing at the edge of a background shape)
    const blend = (i, b) => { const v = [255 - b[0], 255 - b[1], 255 - b[2]], u = [D[i] - b[0], D[i + 1] - b[1], D[i + 2] - b[2]]; const vv = v[0] * v[0] + v[1] * v[1] + v[2] * v[2]; if (vv < 900) return false; const t = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / vv; if (t < 0 || t > 1.05) return false; return Math.hypot(u[0] - t * v[0], u[1] - t * v[1], u[2] - t * v[2]) < 28; };
    const out = [];
    for (const L of geo.labels) {
      const ex = Math.min(3.2, geo.hgap / 2), ey = Math.min(3.2, geo.vgap / 2);
      const X0 = Math.max(0, Math.floor((L.x0 - ex) * k)), X1 = Math.min(W - 1, Math.ceil((L.x0 + L.w + ex) * k)), Y0 = Math.max(0, Math.floor((L.y0 - ey) * k)), Y1 = Math.min(H - 1, Math.ceil((L.y0 + L.h + ey) * k));
      // pass 1: the background = the label's commonest colour
      const hist = new Map(); let ringN = 0, inN = 0;
      for (let py = Y0; py <= Y1; py += 2) for (let px = X0; px <= X1; px += 2) {
        const d = sd(L, (px + 0.5) / k, (py + 0.5) / k); if (d >= 0) continue;
        const i = (py * W + px) * 4; const key = (D[i] >> 4) * 256 + (D[i + 1] >> 4) * 16 + (D[i + 2] >> 4); hist.set(key, (hist.get(key) || 0) + 1); inN++;
      }
      let best = 0, bestN = 0; for (const [kk, n] of hist) if (n > bestN) { best = kk; bestN = n; }
      const bg = [((best >> 8) & 15) * 16 + 8, ((best >> 4) & 15) * 16 + 8, (best & 15) * 16 + 8];
      // its share of the label (near shades too), and of the ring just inside the cut (0.3–1.2 mm in)
      let near = 0, ringInk = 0, ringWhite = 0, inNear = 0;
      for (let py = Y0; py <= Y1; py += 1) for (let px = X0; px <= X1; px += 1) {
        const d = sd(L, (px + 0.5) / k, (py + 0.5) / k); if (d >= 0) continue;
        const i = (py * W + px) * 4;
        if (((px - X0) & 1) === 0 && ((py - Y0) & 1) === 0 && diff(i, bg) < 40) inNear++;
        if (d < -1.2 || d > -0.3) continue;
        ringN++; if (diff(i, bg) < 40) near++; if (!white(i)) ringInk++; else ringWhite++;
      }
      const bgShare = ringN ? near / ringN : 0, inShare = inN ? inNear / inN : 0, bgWhite = bg[0] > 232 && bg[1] > 232 && bg[2] > 232;
      const bgKind = bgWhite && inShare > 0.3 ? 'paper' : inShare > 0.3 ? 'colour' : 'picture';
      // pass 2: content (ink that isn't the background), distances, bleed, bbox
      const bins = new Float64Array(80); let content = 0, outside = 0, outsideMax = 0, bleedN = 0, bleedBg = 0, bleedInk = 0, ink = 0;
      let bx0 = 1e9, by0 = 1e9, bx1 = -1e9, by1 = -1e9;
      for (let py = Y0; py <= Y1; py++) for (let px = X0; px <= X1; px++) {
        const X = (px + 0.5) / k, Y = (py + 0.5) / k, d = sd(L, X, Y), i = (py * W + px) * 4;
        const isInk = !white(i);
        if (isInk) { ink++; if (X < bx0) bx0 = X; if (X > bx1) bx1 = X; if (Y < by0) by0 = Y; if (Y > by1) by1 = Y; }
        // inside: anything that isn't the background (white words on a coloured label count; so does bare paper
        // where a coloured background stops short of the cut); outside: ink that isn't the background's bleed
        const isContent = bgKind === 'picture' ? false : d < 0 ? diff(i, bg) > 60 : isInk && diff(i, bg) > 60 && !blend(i, bg);
        if (d < 0) { if (isContent) { content++; const b = Math.min(79, Math.floor(-d * 10)); bins[b]++; } }
        else {
          if (d >= 0.3 && d <= 1.2) { bleedN++; if (diff(i, bg) < 40) bleedBg++; if (isInk) bleedInk++; }
          if (isContent) { outside++; outsideMax = Math.max(outsideMax, d); }
        }
      }
      // closest the content comes to the cut: where 25 px (about 0.2 mm² at 300 dpi) of it have been met
      let acc = 0, edge = null; const need = Math.max(25, 0.18 * k * k / 140);
      for (let b = 0; b < 80; b++) { acc += bins[b]; if (acc >= need) { edge = b / 10; break; } }
      out.push({ i: L.i, bg: bgKind, bgColour: bg, bgShare: Math.round(bgShare * 100) / 100, inShare: Math.round(inShare * 100) / 100, ringWhite: ringN ? Math.round(ringWhite / ringN * 100) / 100 : 0, ringInk: ringN ? Math.round(ringInk / ringN * 100) / 100 : 0, content, contentMm2: Math.round(content / k / k * 10) / 10,
        edgeMm: edge, outsidePx: outside, outsideMm2: Math.round(outside / k / k * 100) / 100, outsideMax: Math.round(outsideMax * 10) / 10,
        bleedBgShare: bleedN ? Math.round(bleedBg / bleedN * 100) / 100 : null, bleedInkShare: bleedN ? Math.round(bleedInk / bleedN * 100) / 100 : null,
        inkPx: ink, bbox: ink ? { x0: bx0, y0: by0, x1: bx1, y1: by1 } : null });
    }
    return out;
  };
  // QR: decode inside a label's window; then as a phone camera sees the printed label
  window.__qr = (L, ex, ey) => {
    const { c, W, H, k } = window.__page;
    const X0 = Math.max(0, Math.floor((L.x0 - ex) * k)), Y0 = Math.max(0, Math.floor((L.y0 - ey) * k)), w = Math.min(W - X0, Math.ceil((L.w + 2 * ex) * k)), h = Math.min(H - Y0, Math.ceil((L.h + 2 * ey) * k));
    const read = (sw, sh, filter, pre) => { const cv = document.createElement('canvas'); cv.width = sw; cv.height = sh; const x = cv.getContext('2d', { willReadFrequently: true }); x.fillStyle = '#fff'; x.fillRect(0, 0, sw, sh); x.filter = filter || 'none'; x.drawImage(pre || c, pre ? 0 : X0, pre ? 0 : Y0, pre ? pre.width : w, pre ? pre.height : h, 0, 0, sw, sh); return { d: x.getImageData(0, 0, sw, sh), cv }; };
    const full = read(w, h);
    const r = jsQR(full.d.data, w, h, { inversionAttempts: 'attemptBoth' });
    if (!r) return { found: false };
    const Lc = r.location; const side = (Math.hypot(Lc.topRightCorner.x - Lc.topLeftCorner.x, Lc.topRightCorner.y - Lc.topLeftCorner.y) + Math.hypot(Lc.bottomLeftCorner.x - Lc.topLeftCorner.x, Lc.bottomLeftCorner.y - Lc.topLeftCorner.y)) / 2;
    // module size from the finder patterns' centres (they sit 3.5 modules in from the symbol's corners)
    const modules = 17 + 4 * r.version, TL = Lc.topLeftFinderPattern, TR = Lc.topRightFinderPattern, BL = Lc.bottomLeftFinderPattern;
    const modFinder = TL && TR && BL ? (Math.hypot(TR.x - TL.x, TR.y - TL.y) + Math.hypot(BL.x - TL.x, BL.y - TL.y)) / 2 / (modules - 7) : side / modules;
    const sidePx = modFinder * modules;
    const fx = TL && TR && BL ? [TL.x, TR.x, BL.x] : [Lc.topLeftCorner.x, Lc.topRightCorner.x, Lc.bottomLeftCorner.x], fy = TL && TR && BL ? [TL.y, TR.y, BL.y] : [Lc.topLeftCorner.y, Lc.topRightCorner.y, Lc.bottomLeftCorner.y];
    const pad = TL && TR && BL ? 3.5 * modFinder : 0;
    const box = { x0: Math.min(...fx) - pad, y0: Math.min(...fy) - pad, x1: Math.max(...fx) + pad + (TL ? 0 : 0), y1: Math.max(...fy) + pad };
    const D = full.d.data; const lum = (px, py) => { px = Math.max(0, Math.min(w - 1, Math.round(px))); py = Math.max(0, Math.min(h - 1, Math.round(py))); const i = (py * w + px) * 4; return (0.2126 * D[i] + 0.7152 * D[i + 1] + 0.0722 * D[i + 2]) / 255; };
    const vals = []; for (let i = 0; i < 400; i++) vals.push(lum(box.x0 + (box.x1 - box.x0) * ((i * 37) % 100) / 100, box.y0 + (box.y1 - box.y0) * ((i * 61) % 100) / 100));
    vals.sort((a, b) => a - b); const dark = vals.slice(0, 80).reduce((a, b) => a + b, 0) / 80, light = vals.slice(-80).reduce((a, b) => a + b, 0) / 80, mid = (dark + light) / 2;
    const inverted = lum(box.x0 + modFinder * 3.5, box.y0 + modFinder * 3.5) > mid;
    let quiet = 0;
    for (let q = 1; q <= 6; q++) {
      const o = (q - 0.5) * modFinder; let clean = true;
      for (let t = 0; t <= 24 && clean; t++) {
        const fx = box.x0 + (box.x1 - box.x0) * t / 24, fy = box.y0 + (box.y1 - box.y0) * t / 24;
        for (const [px, py] of [[fx, box.y0 - o], [fx, box.y1 + o], [box.x0 - o, fy], [box.x1 + o, fy]]) {
          if (px < 0 || py < 0 || px >= w || py >= h) { clean = false; break; }
          if (inverted ? lum(px, py) > mid : lum(px, py) < mid) { clean = false; break; }
        }
      }
      if (!clean) break; quiet = q;
    }
    // the phone test: ink spreads a little on a paper label (blur ≈ 0.08 mm), then a phone camera (≈3000 px across a
    // 65° view) at 20 and 30 cm, in ordinary room light
    const inked = read(w, h, `blur(${Math.max(0.5, 0.08 * k).toFixed(2)}px)`);
    const phone = {};
    for (const cm of [20, 30]) {
      const camPxPerMm = 3000 / (2 * cm * 10 * Math.tan(32.5 * Math.PI / 180)), s = camPxPerMm / k;
      const sw = Math.max(30, Math.round(w * s)), sh = Math.max(30, Math.round(h * s));
      const v = read(sw, sh, 'brightness(0.8) contrast(0.9) blur(0.5px)', inked.cv);
      const rr = jsQR(v.d.data, sw, sh, { inversionAttempts: 'attemptBoth' });
      phone[cm] = !!rr && rr.data === r.data;
      if (cm === 30) phone.view = v.cv.toDataURL('image/png');
    }
    return { found: true, data: r.data, version: r.version, modules, side_mm: Math.round(sidePx / k * 10) / 10, module_mm: Math.round(modFinder / k * 100) / 100, quiet, contrast: Math.round((light - dark) * 100) / 100, inverted, phone20: phone[20], phone30: phone[30], phoneView: phone.view,
      box_mm: { x0: (X0 + box.x0) / k, y0: (Y0 + box.y0) / k, x1: (X0 + box.x1) / k, y1: (Y0 + box.y1) / k } };
  };
}

// ---------- check ----------
const SKIP = /(^|\/)(look|palm|node_modules|\.git)\//;
export function guessTemplate(file, map) {
  const name = basename(file).toLowerCase();
  if (map) for (const [k, v] of Object.entries(map)) if (name.includes(k.toLowerCase())) return findTemplate(v);
  for (const m of name.match(/\d{4,5}/g) || []) { const t = findTemplate(m); if (t) return t; }
  return null;
}
const parseMap = (s) => s ? Object.fromEntries(String(s).split(',').map((x) => x.split('=').map((y) => y.trim())).filter((x) => x.length === 2)) : null;

export async function check(target, { template = null, map = null, out = 'look/labels', plain = false, ocr = 'auto' } = {}) {
  const root = resolve(target);
  const isDir = statSync(root).isDirectory();
  const files = isDir ? readdirSync(root, { recursive: true }).map(String).filter((f) => /\.pdf$/i.test(f) && !SKIP.test(f)).sort().map((f) => join(root, f)) : [root];
  if (!files.length) throw new Error('No PDF found. Label sheets go to the printer as PDFs (one page per sheet).');
  if (typeof map === 'string') map = parseMap(map);
  const issues = [], report = [], shots = [];
  const jsqr = jsqrSource();
  const tmp = mkdtempSync(join(tmpdir(), 'palm-labels-'));
  const browser = await launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<body></body>');
    if (jsqr) await page.addScriptTag({ content: jsqr });
    await page.evaluate(pixelLib);
    for (const [fi, file] of files.entries()) {
      const rel = isDir ? file.slice(root.length + 1) : basename(file);
      const add = (id, level, msg, fix) => issues.push(issue(id, level, `${rel}: ${msg}`, fix));
      const t = (template && !isDir ? findTemplate(template) : null) || guessTemplate(file, map) || (template ? findTemplate(template) : null);
      const rec = { file: rel, template: t?.code || null, pages: [] };
      if (!t) { add('no-template', 'error', `which label sheet is this for? Name the file with its Avery code (e.g. lid-labels-22807.pdf) or pass --template 22807 / --map lid=22807,jar=94207,address=5160. Known: ${Object.keys(TEMPLATES).join(', ')}.`); report.push(rec); continue; }
      rec.title = t.title;
      let info; try { info = inspectPdf(readFileSync(file)); } catch (e) { add('pdf-unreadable', 'error', `Palm couldn't read this PDF (${e.message}).`); report.push(rec); continue; }
      const pdfS = readFileSync(file).toString('latin1');
      rec.print_scaling_none = /\/PrintScaling\s*\/None/.test(pdfS);
      const ras = rasterize(file, 300, join(tmp, 'f' + fi));
      if (!ras.files.length) { add('no-renderer', 'error', 'no PDF renderer found, so the sheet can\'t be drawn or measured. Install Ghostscript (brew install ghostscript), poppler (pdftoppm) or PyMuPDF.'); report.push(rec); continue; }
      if (info.pages.length > 1) add('pages', 'warn', `${info.pages.length} pages: is that ${info.pages.length} sheets on purpose? A stray blank page wastes a label sheet.`);
      const pageW = t.pageIn[0] * IN, pageH = t.pageIn[1] * IN;
      const g = labelRects(t);
      for (const [pi, p] of info.pages.entries()) {
        const pr = { page: pi + 1, size_mm: `${r1(p.w)}×${r1(p.h)}` };
        const pAdd = (id, level, msg, fix) => add(id, level, `page ${pi + 1}: ${msg}`, fix);
        const rot = ((p.rotate % 360) + 360) % 360;
        const landscape = (rot === 90 || rot === 270) ? p.h > p.w : p.w > p.h;
        const ok = Math.abs(p.w - pageW) < 1 && Math.abs(p.h - pageH) < 1 && !rot;
        pr.page_ok = ok;
        if (!ok) {
          const name = Math.abs(p.w - 210) < 1.5 && Math.abs(p.h - 297) < 1.5 ? 'A4' : landscape ? 'landscape' : `${r1(p.w)}×${r1(p.h)} mm`;
          pAdd('page-size', 'error', `the page is ${name}${rot ? ` (rotated ${rot}°)` : ''}, but Avery ${t.code} is a US Letter sheet (8.5 × 11 in = 215.9 × 279.4 mm, portrait). Printed at 100% the grid lands in the wrong place; with "fit to page" the printer shrinks it and it drifts off the labels.`, `Make the PDF exactly 8.5 × 11 in, portrait, no margins (node label-check.mjs render <sheet.html> --template ${t.code} --out <file>.pdf).`);
        }
        // the page as printed: the PDF page drawn onto the sheet at 100% from the top-left corner (what Actual size does
        // when the sizes match). When they don't, it's drawn at 100% too (that's the instruction), so the cuts show where it lands.
        const png = ras.files[pi]; if (!png) continue;
        const geo = { pageW: p.w, shape: t.shape, radius: t.radiusIn * IN, hgap: g.hgapIn * IN, vgap: g.vgapIn * IN, labels: g.labels };
        const m = await page.evaluate((src, geo) => window.__measure(src, geo), 'data:image/png;base64,' + readFileSync(png).toString('base64'), geo);
        // text: from the PDF's text layer; OCR when there is none
        let text = p.text.filter((x) => x.size > 0.5).map((x) => ({ ...x, cx: x.x0 + Math.min(x.x1 - x.x0, 4) / 2, cy: (x.y0 + x.y1) / 2 }));
        pr.text_method = text.length ? 'pdf' : 'none';
        const inkTotal = m.reduce((s, x) => s + x.content, 0);
        if ((!text.length && inkTotal > 0 && ocr !== 'never') || ocr === 'always') {
          if (hasTesseract()) {
            const hi = rasterize(file, 600, join(tmp, `o${fi}-${pi}`));
            const words = hi.files[pi] ? ocrWords(hi.files[pi], 600) : [];
            if (!text.length) { text = words.map((w) => ({ ...w, cx: (w.x0 + w.x1) / 2, cy: (w.y0 + w.y1) / 2 })); pr.text_method = words.length ? 'ocr' : 'none'; }
            else pr.ocr_min_pt = words.length ? r1(Math.min(...words.map((w) => w.size))) : null;
          }
          if (!text.length) pAdd('text-as-pixels', 'warn', 'the PDF has no text layer (the words are pixels) and Palm couldn\'t read them, so their size isn\'t measured. Text drawn as an image prints softer; make the PDF from HTML or with real fonts.');
        }
        const inLabel = (x, y) => g.labels.find((L) => x >= L.x0 - 1 && x <= L.x0 + L.w + 1 && y >= L.y0 - 1 && y <= L.y0 + L.h + 1);
        const labels = g.labels.map((L, k) => ({ ...m[k], i: k + 1, row: L.row + 1, col: L.col + 1, text: [] }));
        const offLabel = [];
        for (const tx of text) { const L = inLabel(tx.cx, tx.cy); if (L) labels[L.i].text.push(tx); else if (tx.size >= 2) offLabel.push(tx); }
        // per label
        const filled = labels.filter((l) => l.content > 50 || l.bg !== 'paper' || l.text.length);
        pr.labels_filled = filled.length; pr.labels = labels.length;
        if (!filled.length) { pAdd('empty', 'error', 'no artwork on any label.'); }
        else if (filled.length < labels.length) pAdd('labels-empty', 'warn', `${labels.length - filled.length} of the ${labels.length} labels are blank (${labels.filter((l) => !filled.includes(l)).slice(0, 6).map((l) => `row ${l.row} col ${l.col}`).join(', ')}${labels.length - filled.length > 6 ? '…' : ''}); is that on purpose?`);
        if (offLabel.length) pAdd('text-off-labels', 'error', `${offLabel.length} piece(s) of text sit between or outside the labels (e.g. "${(offLabel[0].t || '').slice(0, 30) || 'at ' + r1(offLabel[0].cx) + ',' + r1(offLabel[0].cy) + ' mm'}"), on the sheet's waste, not on a label.`);
        const cutClose = [], near = [], crossing = [], noBleed = [], colourEdge = [], whiteEdge = [];
        for (const l of filled) {
          const where = `row ${l.row} col ${l.col}`;
          if (l.outsideMm2 >= 0.4) crossing.push({ where, mm2: l.outsideMm2, max: l.outsideMax });
          if (l.edgeMm != null && l.edgeMm < PALM.cutMm) cutClose.push({ where, mm: l.edgeMm });
          else if (l.edgeMm != null && l.edgeMm < PALM.safeMm) near.push({ where, mm: l.edgeMm });
          if (l.bg === 'colour' && l.ringWhite > 0.08) whiteEdge.push({ where, share: l.ringWhite });
          if (l.bg === 'colour' || l.bg === 'picture') {
            if (t.printToEdge && l.bleedBgShare != null && (l.bg === 'colour' ? l.bleedBgShare < 0.6 : l.bleedInkShare < Math.max(0.3, l.ringInk * 0.5))) noBleed.push({ where });
            if (!t.printToEdge) colourEdge.push({ where });
          }
        }
        const list = (a, f) => a.slice(0, 5).map(f).join('; ') + (a.length > 5 ? ` (+${a.length - 5} more)` : '');
        if (crossing.length) pAdd('art-past-cut', 'error', `artwork crosses the die-cut on ${crossing.length} label(s) (${list(crossing, (c) => `${c.where}: ${c.mm2} mm² up to ${c.max} mm past the cut`)}); that part is cut off or prints on the sheet's waste.`, 'Move it inside the label; keep words, logos and the QR code inside the safe area (Palm: 1/8 in = 3.2 mm inside the cut).');
        if (cutClose.length) pAdd('art-at-cut', 'error', `on ${cutClose.length} label(s) words or artwork come within ${PALM.cutMm} mm of the cut (${list(cutClose, (c) => `${c.where}: ${c.mm} mm`)}). A sheet shifts about a millimetre in a home printer (Avery: keep important items well inside the label), so they get clipped or touch the edge.`, 'Pull them in to at least 3.2 mm (1/8 in) inside the cut.');
        if (near.length) pAdd('art-near-cut', 'warn', `on ${near.length} label(s) words or artwork come within ${PALM.safeMm} mm (1/8 in) of the cut (${list(near, (c) => `${c.where}: ${c.mm} mm`)}); Palm's safe area for home printing is 1/8 in inside the cut.`);
        if (whiteEdge.length) pAdd('white-edge', 'error', `on ${whiteEdge.length} label(s) the coloured background doesn't reach the die-cut all the way round (${list(whiteEdge, (c) => `${c.where}: ${Math.round(c.share * 100)}% of the edge is bare paper`)}): the artwork is off its label or smaller than it, so the label comes out with an uneven white rim.`, 'Centre each label\'s artwork on its die-cut (node label-check.mjs grid <code>) and run the background past the cut.');
        if (noBleed.length) pAdd('no-bleed', 'error', `${noBleed.length} label(s) have a coloured background that stops at the die-cut (${list(noBleed, (c) => c.where)}). If the sheet shifts even slightly, a white sliver shows round the edge. Avery ${t.code} is print-to-the-edge: Avery recommends running the background 1/8 in past the cut.`, 'Draw each label\'s background 1/8 in (3.2 mm) bigger than the label on every side (a round label becomes a 2.25 in circle or square).');
        if (colourEdge.length) pAdd('colour-to-edge', 'warn', `${colourEdge.length} label(s) have colour right to the die-cut (${list(colourEdge, (c) => c.where)}), but Avery ${t.code} isn't print-to-the-edge and its labels touch: there is no room for bleed, so a small shift shows a white edge on one side and this label's colour on the next. Avery: pull colours inside the safety area and leave white space round the design.`);
        // drift: where each label's artwork sits against its label, across the sheet
        const pts = filled.filter((l) => l.bbox).map((l) => ({ l, dx: (l.bbox.x0 + l.bbox.x1) / 2 - (g.labels[l.i - 1].x0 + g.labels[l.i - 1].w / 2), dy: (l.bbox.y0 + l.bbox.y1) / 2 - (g.labels[l.i - 1].y0 + g.labels[l.i - 1].h / 2) }));
        const fit = (xs, ys) => { const n = xs.length; if (n < 2) return { a: ys[0] || 0, b: 0 }; const mx = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n; let sxy = 0, sxx = 0; for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; } const b = sxx ? sxy / sxx : 0; return { a: my - b * mx, b }; };
        if (pts.length >= 2) {
          const fx = fit(pts.map((q) => q.l.col - 1), pts.map((q) => q.dx)), fy = fit(pts.map((q) => q.l.row - 1), pts.map((q) => q.dy));
          const driftX = fx.b * (t.across - 1), driftY = fy.b * (t.down - 1);
          pr.drift_mm = { across: r1(driftX), down: r1(driftY) };
          pr.offset_first_mm = { x: r1(fx.a), y: r1(fy.a) };
          pr.offset_last_mm = { x: r1(fx.a + driftX), y: r1(fy.a + driftY) };
          const spread = Math.max(...pts.map((q) => Math.abs(q.dx - (fx.a + fx.b * (q.l.col - 1))))) ;
          if (Math.abs(driftX) > PALM.driftMm || Math.abs(driftY) > PALM.driftMm) pAdd('grid-drift', 'error', `the artwork drifts across the sheet: from the first column to the last it moves ${r1(driftX)} mm sideways, and from the top row to the bottom ${r1(driftY)} mm up/down against the die-cuts (first label off by ${r1(fx.a)}, ${r1(fy.a)} mm; last by ${r1(fx.a + driftX)}, ${r1(fy.a + driftY)} mm). The label pitch, margins or page scaling don't match Avery ${t.code}.`, `Place each label from the sheet's own numbers: node label-check.mjs grid ${t.code} (top margin ${t.topIn} in, side margin ${t.sideIn} in, pitch ${r2(g.hpitchIn * 1000) / 1000} × ${Math.round(g.vpitchIn * 10000) / 10000} in).`);
          pr.label_to_label_spread_mm = r1(spread);
        }
        // text sizes
        const sizes = text.map((x) => x.size).filter((x) => x > 0.5);
        if (sizes.length) {
          pr.min_text_pt = r1(Math.min(...sizes));
          const small = text.filter((x) => x.size < PALM.minPt);
          const ex = small.sort((a, b) => a.size - b.size).slice(0, 3).map((x) => `${r1(x.size)} pt${x.t ? ` "${x.t.slice(0, 24)}"` : ''}`).join(', ');
          if (Math.min(...sizes) < PALM.tinyPt) pAdd('text-tiny', 'error', `the smallest text is ${pr.min_text_pt} pt (${ex}${pr.text_method === 'ocr' ? ', estimated from the pixels' : ''}). On a paper label from a home inkjet, under ${PALM.tinyPt} pt fills in and can't be read at arm's length (Palm's guidance: ${PALM.minPt} pt or more for ingredients, warnings and addresses; Avery's own printing service won't go under 3 pt).`, 'Say less, or give it more room (a 2 × 4 in label has room for 6–7 pt body text and a 15 mm QR code if the name isn\'t huge).');
          else if (Math.min(...sizes) < PALM.minPt) pAdd('text-small', 'warn', `the smallest text is ${pr.min_text_pt} pt (${ex}); Palm's guidance for paper labels from a home printer is ${PALM.minPt} pt or more.`);
          const per = labels.filter((l) => l.text.length).map((l) => Math.min(...l.text.map((x) => x.size)));
          pr.min_text_pt_by_label = per.length ? r1(Math.min(...per)) : null;
        }
        const thin = p.lines.filter((l) => !l.zero && l.w > 0 && l.w < PALM.minLinePt);
        if (p.lines.some((l) => l.zero)) pAdd('hairline', 'warn', 'a line has width 0 (a "hairline": the thinnest line the printer can make), which can vanish.', 'Give it at least 0.5 pt.');
        else if (thin.length) pAdd('line-thin', 'info', `the thinnest stroked line is ${r2(Math.min(...thin.map((l) => l.w)))} pt (it may be an invisible stroke; look at the sheet); Avery's printing service asks for 0.5 pt or more.`);
        // QR codes: decode on the top-left label and every label that might carry one (all of them; they're small)
        pr.qr = [];
        if (jsqr) {
          const ex = Math.min(2, g.hgapIn * IN / 2 || 2), ey = Math.min(2, g.vgapIn * IN / 2 || 2);
          for (const l of filled) {
            const q = await page.evaluate((L, ex, ey) => window.__qr(L, ex, ey), g.labels[l.i - 1], ex, ey);
            if (q.found) pr.qr.push({ label: `row ${l.row} col ${l.col}`, i: l.i, ...q });
          }
          const qrs = pr.qr;
          if (qrs.length) {
            const worst = qrs.slice().sort((a, b) => a.side_mm - b.side_mm)[0];
            pr.qr_summary = { labels: qrs.length, data: [...new Set(qrs.map((q) => q.data))], side_mm: worst.side_mm, module_mm: worst.module_mm, quiet: Math.min(...qrs.map((q) => q.quiet)), phone20: qrs.every((q) => q.phone20), phone30: qrs.every((q) => q.phone30), contrast: Math.min(...qrs.map((q) => q.contrast)) };
            const s = pr.qr_summary;
            if (!s.phone20) pAdd('qr-phone', 'error', `the QR code (${s.side_mm} mm, modules ${s.module_mm} mm) didn't scan in Palm's phone test at 20 cm (a phone camera after the ink spreads a little on a paper label).`, `Make it bigger (Palm: at least ${PALM.qrSideMm} mm, modules ${PALM.qrModuleMm} mm or more), dark on light, with a clear margin; shorten the URL so the code has fewer modules.`);
            else if (!s.phone30) pAdd('qr-phone-far', 'warn', `the QR code (${s.side_mm} mm) scans at 20 cm but not at 30 cm in Palm's phone test; people scan a jar on a shelf or a market table from further away.`);
            if (s.side_mm < PALM.qrMinSideMm) pAdd('qr-small', 'error', `the printed QR code is ${s.side_mm} mm across (modules ${s.module_mm} mm); under ${PALM.qrMinSideMm} mm phones struggle, especially on a curved jar (Palm's guidance: ${PALM.qrSideMm} mm or more).`);
            else if (s.side_mm < PALM.qrSideMm || s.module_mm < PALM.qrModuleMm) pAdd('qr-small', 'warn', `the printed QR code is ${s.side_mm} mm across with ${s.module_mm} mm modules; Palm's guidance for a home-printed paper label is ${PALM.qrSideMm} mm or more with modules of ${PALM.qrModuleMm} mm or more (a shorter URL gives bigger modules at the same size).`);
            if (s.quiet < 2) pAdd('qr-quiet-zone', 'warn', `only ${s.quiet} module(s) of clear margin round the QR code; the QR standard (ISO/IEC 18004) asks for 4, and artwork tight against it can stop it scanning.`);
            if (s.contrast < 0.5) pAdd('qr-contrast', 'warn', `the QR code's dark and light modules differ by only ${s.contrast} of 1; dark on white (or cream) scans best.`);
            if (qrs.some((q) => q.inverted)) pAdd('qr-inverted', 'warn', 'the QR code is light on dark; some phone cameras won\'t read inverted codes.');
          }
        }
        const pdfQr = pr.qr; pr.qr = pdfQr.map(({ phoneView, ...q }) => q);
        rec.pages.push(pr);
        shots.push({ file: rel, page: pi + 1, png, t, g, labels, pr, pageW: p.w, pageH: p.h, qrView: pdfQr[0]?.phoneView || null, qr: pdfQr[0] || null });
      }
      if (!rec.print_scaling_none) add('print-scaling', 'info', `when printing, choose Actual size / Scale 100%, never "Fit to page" (Avery). Palm's render also writes /PrintScaling /None into the PDF so Acrobat defaults to Actual size.`);
      report.push(rec);
    }
    let sheet = null;
    if (shots.length) { const o = resolve(out); mkdirSync(dirname(o), { recursive: true }); sheet = o + '-sheet.png'; await drawSheet(browser, shots, sheet, { plain }); }
    const errors = issues.filter((i) => i.level === 'error').length, warnings = issues.filter((i) => i.level === 'warn').length;
    return { ok: errors === 0, errors, warnings, files: report, issues, sheet, rules: { avery: AVERY, palm: PALM } };
  } finally { await browser.close(); try { rmSync(tmp, { recursive: true, force: true }); } catch {} }
}

// ---------- the sheet ----------
async function drawSheet(browser, shots, outFile, { plain = false } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 1000, deviceScaleFactor: 1 });
  const data = shots.map((s) => ({ file: s.file, page: s.page, src: 'data:image/png;base64,' + readFileSync(s.png).toString('base64'), title: s.t.title, code: s.t.code, shape: s.t.shape, radius: s.t.radiusIn * IN,
    pageW: s.pageW, pageH: s.pageH, sheetW: s.t.pageIn[0] * IN, sheetH: s.t.pageIn[1] * IN, labels: s.g.labels, across: s.t.across, down: s.t.down,
    bad: plain ? [] : s.labels.filter((l) => (l.edgeMm != null && l.edgeMm < PALM.safeMm) || l.outsideMm2 >= 0.4).map((l) => l.i - 1),
    qr: s.qr ? { box: s.qr.box_mm, view: s.qrView, side: s.qr.side_mm } : null, notes: plain ? '' : [s.pr.min_text_pt != null ? `smallest text ${s.pr.min_text_pt} pt` : '', s.pr.drift_mm ? `drift ${s.pr.drift_mm.across} / ${s.pr.drift_mm.down} mm` : '', s.pr.qr_summary ? `QR ${s.pr.qr_summary.side_mm} mm` : ''].filter(Boolean).join(' · ') }));
  await page.setContent(`<!doctype html><html><head><style>
    body{margin:0;font:14px/1.35 -apple-system,system-ui,sans-serif;background:#ecebe8;color:#111}
    .sec{padding:20px 26px;background:#fff;margin-bottom:10px}
    h2{font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:#555;margin:0 0 12px}
    .row{display:flex;gap:22px;align-items:flex-start;flex-wrap:wrap}.lab{font-size:12px;color:#555;margin-top:6px;max-width:440px}
    .wrap{position:relative;display:inline-block;box-shadow:0 1px 5px rgba(0,0,0,.3);background:#fff}
    .wrap img{display:block}.ov{position:absolute;left:0;top:0;pointer-events:none}
    .mat{background:#8d877d;padding:14px;border-radius:6px;display:flex;gap:16px;flex-wrap:wrap;align-items:flex-end}.mat .lab{color:#f3f0ea}
    .peel{overflow:hidden;position:relative;background:#fff;box-shadow:0 2px 7px rgba(0,0,0,.4)}
    .peel img{position:absolute;display:block}
    .desk{background:#c9b79c;padding:20px;border-radius:6px;display:flex;gap:18px;align-items:center}
    .coin{width:24.26mm;height:24.26mm;border-radius:50%;background:radial-gradient(circle at 35% 35%,#e6e6e6,#9c9c9c);box-shadow:0 1px 3px rgba(0,0,0,.4)}
    .qrv{image-rendering:pixelated;border:1px solid #999;background:#fff}
  </style></head><body><div id="root"></div></body></html>`);
  await page.evaluate(async (data, plain) => {
    const root = document.getElementById('root');
    for (const d of data) {
      const sec = document.createElement('div'); sec.className = 'sec';
      const S = 620 / d.sheetH; // px per mm, overview
      const rad = (w, h) => d.shape === 'round' ? '50%' : `${d.radius / w * 100}% / ${d.radius / h * 100}%`;
      const cutPath = d.labels.map((L, k) => d.shape === 'round' ? `<circle cx="${L.x0 + L.w / 2}" cy="${L.y0 + L.h / 2}" r="${L.w / 2}" fill="none" stroke="${d.bad.includes(k) ? '#e00' : '#d0007a'}" stroke-width="${d.bad.includes(k) ? 0.7 : 0.35}"/>` : `<rect x="${L.x0}" y="${L.y0}" width="${L.w}" height="${L.h}" rx="${d.radius}" fill="none" stroke="${d.bad.includes(k) ? '#e00' : '#d0007a'}" stroke-width="${d.bad.includes(k) ? 0.7 : 0.35}"/>`).join('');
      // the PDF page is printed at 100% from the sheet's top-left (Actual size)
      let html = `<h2>${d.file} · page ${d.page} · printed on ${d.title}</h2><div class="row">
        <div><div class="wrap" style="width:${d.sheetW * S}px;height:${d.sheetH * S}px;overflow:hidden"><img src="${d.src}" style="width:${d.pageW * S}px;height:${d.pageH * S}px">
        <svg class="ov" viewBox="0 0 ${d.sheetW} ${d.sheetH}" width="${d.sheetW * S}" height="${d.sheetH * S}">${cutPath}</svg></div>
        <div class="lab">The PDF as printed on the label sheet at 100% (Actual size). Pink: the die-cut of every label.${d.notes ? '<br><b>' + d.notes + '</b>' : ''}</div></div>`;
      // peeled labels: top-left and bottom-right, cut exactly on the die-line; the top-left again with the sheet 1 mm off
      const Z = Math.min(8, 300 / Math.max(d.labels[0].w, d.labels[0].h));
      const peel = (L, dx, dy, cap) => `<div><div class="peel" style="width:${L.w * Z}px;height:${L.h * Z}px;border-radius:${rad(L.w, L.h)}"><img src="${d.src}" style="width:${d.pageW * Z}px;height:${d.pageH * Z}px;left:${-(L.x0 + dx) * Z}px;top:${-(L.y0 + dy) * Z}px"></div><div class="lab">${cap}</div></div>`;
      const L0 = d.labels[0], Ln = d.labels[d.labels.length - 1];
      html += `<div><div class="mat">${peel(L0, 0, 0, 'top-left label, peeled off')}${peel(Ln, 0, 0, 'bottom-right label, peeled off')}${peel(L0, -1, -1, 'top-left, sheet fed 1 mm up-left')}${peel(L0, 1, 1, 'top-left, sheet fed 1 mm down-right')}</div>
        <div class="lab" style="max-width:640px">Enlarged. Each label as it comes off the sheet, cut on its die-line. A home printer can place the sheet about a millimetre off either way.</div></div></div>`;
      // real size + QR
      html += `<div class="row" style="margin-top:16px"><div><div class="desk">${peel(L0, 0, 0, '').replace('<div class="lab"></div>', '').replace(/width:([\d.]+)px;height:([\d.]+)px;border-radius/, `width:${L0.w}mm;height:${L0.h}mm;border-radius`).replace(/width:[\d.]+px;height:[\d.]+px;left:[-\d.]+px;top:[-\d.]+px/, `width:${d.pageW}mm;height:${d.pageH}mm;left:${-L0.x0}mm;top:${-L0.y0}mm`)}<div class="coin"></div></div>
        <div class="lab">At real size on a normal screen, beside a US quarter (24.3 mm): can you read the smallest line?</div></div>`;
      if (d.qr) {
        const b = d.qr.box, pad = 2, Q = 12; // 12 px per mm
        html += `<div><div class="peel" style="width:${(b.x1 - b.x0 + 2 * pad) * Q}px;height:${(b.y1 - b.y0 + 2 * pad) * Q}px;border-radius:0"><img src="${d.src}" style="width:${d.pageW * Q}px;height:${d.pageH * Q}px;left:${-(b.x0 - pad) * Q}px;top:${-(b.y0 - pad) * Q}px"></div><div class="lab">The QR code as printed, enlarged (${d.qr.side} mm across).</div></div>
          <div><img class="qrv" src="${d.qr.view}" style="width:${(b.x1 - b.x0 + 2 * pad) * Q}px"><div class="lab">The same label as a phone camera sees it from 30 cm (after the ink spreads a little), enlarged.</div></div>`;
      }
      html += `</div>`;
      sec.innerHTML = html; root.appendChild(sec);
    }
    await Promise.all([...document.images].map((i) => i.complete ? 0 : new Promise((r) => { i.onload = i.onerror = r; })));
  }, data, plain);
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewport({ width: 1500, height: Math.min(h, 15000), deviceScaleFactor: 1 });
  await page.screenshot({ path: outFile, fullPage: true });
  await page.close();
}

// ---------- self-test ----------
async function selfTest() {
  const d = mkdtempSync(join(tmpdir(), 'label-test-'));
  // good: from the grid starter, background bleeding 1/8 in, text ≥ 7 pt inside the safe area
  const gr = grid('22807', { html: join(d, 'good.html') });
  if (gr.labels.length !== 12 || Math.abs(gr.horizontal_pitch_in - 2.625) > 0.001 || Math.abs(gr.vertical_pitch_in - 2.5833) > 0.001) throw new Error('22807 grid wrong: ' + JSON.stringify(gr).slice(0, 300));
  let h = readFileSync(join(d, 'good.html'), 'utf8');
  h = h.replace('</style>', '.art{background:#c8811a;border-radius:50%}.safe{color:#3b2a1e;font:7pt Helvetica}.safe b{font-size:13pt}</style>').replace(/<!-- label \d+ -->/g, '<b>Hollow</b><span>Raw honey · 12 oz</span><span>Batch 2611</span>');
  writeFileSync(join(d, 'good.html'), h);
  const good = await render(join(d, 'good.html'), { template: '22807', out: join(d, 'good-22807.pdf') });
  if (good.errors) throw new Error('good sheet flagged: ' + good.issues.filter((i) => i.level === 'error').map((i) => i.id + ' ' + i.msg).join(' | '));
  if (!good.files[0].print_scaling_none) throw new Error('render did not set PrintScaling None');
  // bad: A4 page, a 5163-ish pitch on the round sheet (drift), no bleed, 4 pt text near the edge
  const bad = ['<html><head><style>@page{size:A4;margin:0}body{margin:0}.l{position:absolute;width:2in;height:2in;border-radius:50%;background:#c8811a;color:#fff;font:4pt Helvetica;display:flex;align-items:flex-start;justify-content:center}</style></head><body>'];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) bad.push(`<div class="l" style="left:${0.6 + c * 2.7}in;top:${0.6 + r * 2.65}in"><span style="margin-top:1mm">tiny ingredients text right at the top edge</span></div>`);
  writeFileSync(join(d, 'bad.html'), bad.join('') + '</body></html>');
  const b = await launch(); try { const p = await b.newPage(); await p.goto(pathToFileURL(join(d, 'bad.html')).href); writeFileSync(join(d, 'bad-22807.pdf'), await p.pdf({ format: 'A4', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } })); } finally { await b.close(); }
  const br = await check(join(d, 'bad-22807.pdf'), { out: join(d, 'look/bad') });
  const ids = br.issues.map((i) => i.id);
  for (const want of ['page-size', 'grid-drift', 'no-bleed', 'text-tiny', 'art-at-cut']) if (!ids.includes(want)) throw new Error(`bad sheet: expected ${want}, got ${ids.join(',')}`);
  // address labels with a QR: one scannable 16 mm code, one 7 mm
  const qrLib = [join(here, '../../src/authenticator/vendor/qrcode-generator-1.4.4.js'), ...BASES.map((x) => join(x, 'node_modules/qrcode-generator/qrcode.js'))].find((f) => existsSync(f));
  if (qrLib && jsqrSource()) {
    const qsrc = readFileSync(qrLib, 'utf8');
    const mk = (sizeMm, name) => {
      const g2 = grid('94207', { html: join(d, name + '.html') });
      void g2;
      let x = readFileSync(join(d, name + '.html'), 'utf8');
      x = x.replace('</style>', () => `.safe{flex-direction:row;gap:4mm;font:8pt Helvetica;color:#222}.q{width:${sizeMm}mm;height:${sizeMm}mm}</style><script>${qsrc}</script>`)
        .replace(/<!-- label \d+ -->/g, '<div class="q"></div><div>Raw Wildflower Honey<br>Net wt 12 oz</div>')
        .replace('</body>', `<script>for(const e of document.querySelectorAll('.q')){const q=qrcode(0,'M');q.addData('https://example.com/b/2611');q.make();e.innerHTML=q.createSvgTag({cellSize:4,margin:4,scalable:true});e.firstChild.setAttribute('width','100%');e.firstChild.setAttribute('height','100%');}</script></body>`);
      writeFileSync(join(d, name + '.html'), x);
    };
    mk(20, 'qr-good'); mk(7, 'qr-small');
    const qg = await render(join(d, 'qr-good.html'), { template: '94207', out: join(d, 'qr-good.pdf') });
    const qs = await render(join(d, 'qr-small.html'), { template: '94207', out: join(d, 'qr-small.pdf') });
    const sg = qg.files[0].pages[0].qr_summary, ss = qs.files[0].pages[0].qr_summary;
    if (!sg || sg.labels !== 10 || !sg.phone30 || qg.issues.some((i) => /^qr/.test(i.id))) throw new Error('good QR: ' + JSON.stringify(sg) + ' ' + qg.issues.map((i) => i.id).join(','));
    if (!qs.issues.some((i) => i.id === 'qr-small')) throw new Error('small QR not flagged: ' + JSON.stringify(ss));
    console.log(`label-check: QR good ${sg.side_mm} mm (modules ${sg.module_mm} mm, phone 30 cm ${sg.phone30}); small ${ss?.side_mm} mm → ${qs.issues.filter((i) => /^qr/.test(i.id)).map((i) => i.id).join(',')}`);
  }
  console.log(`label-check: all tests pass (good: ${good.files[0].pages[0].labels_filled}/12 labels, min ${good.files[0].pages[0].min_text_pt} pt, drift ${JSON.stringify(good.files[0].pages[0].drift_mm)}; bad: ${[...new Set(ids)].join(',')}; sheet ${good.sheet})`);
}

if (typeof process !== 'undefined' && process.argv?.[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (k, dflt) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : dflt; };
  const VALUED = new Set(['--out', '--template', '--map', '--html', '--ocr']);
  const pos = argv.filter((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1]));
  const done = (r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok === false ? 1 : 0); };
  const fail = (e) => { console.error(String(e.message || e)); process.exit(2); };
  if (argv.includes('--self-test') || argv.includes('--test')) selfTest().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
  else if (pos[0] === 'templates') done({ templates: Object.fromEntries(Object.entries(TEMPLATES).map(([k, t]) => { const g = labelRects(t); return [k, { ...t, horizontal_pitch_in: r2(g.hpitchIn * 1000) / 1000, vertical_pitch_in: Math.round(g.vpitchIn * 10000) / 10000 }]; })), avery: AVERY, palm: PALM });
  else if (pos[0] === 'grid' && pos[1]) { try { done(grid(pos[1], { html: opt('html') })); } catch (e) { fail(e); } }
  else if (pos[0] === 'render' && pos[1]) render(pos[1], { template: opt('template'), out: opt('out', 'print/labels.pdf') }).then(done, fail);
  else if (pos[0] === 'check' && pos[1]) check(pos[1], { template: opt('template'), map: opt('map'), out: opt('out', 'look/labels'), ocr: opt('ocr', 'auto') }).then(done, fail);
  else fail('usage: label-check.mjs templates | grid <code> [--html starter.html] | render <sheet.html> --template <code> --out print/x.pdf | check <file.pdf|folder> [--template <code> | --map lid=22807,jar=94207] [--out look/labels] | --self-test');
}
