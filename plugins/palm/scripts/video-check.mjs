#!/usr/bin/env node
// Palm tool: video-check — lets an agent SEE a short vertical video it made (it can't watch one) the way Instagram
// Reels, TikTok and YouTube Shorts show it, and measures what a person would notice:
//   - the file: size, ratio, frame rate, length against each app's limits; an audio track, and whether it's silent
//   - every half second as a timeline strip, and key frames inside each app's own buttons, caption and top bar,
//     with each app's safe zone drawn
//   - the words on screen (read from the frames with macOS's built-in text recognition, when it's there): text that
//     sits under an app's buttons or caption, text too small to read on a phone, and words that aren't on screen
//     long enough to read
//   - the cover: in Instagram's 3:4 profile grid (centre crop), TikTok's grid and a Shorts shelf
// One sheet to LOOK at, plus measured problems. adds: tool, fresh-data. Runs on the user's machine (ffmpeg, Chrome,
// and on a Mac the system text recognizer, compiled once with swiftc); nothing leaves it.
//
//   node video-check.mjs check <video.mp4> [--cover cover.jpg] [--out vc] [--plain]
//       → JSON {ok, video, platforms, text, issues:[{severity, rule, msg, fix}]} and <out>-sheet.png. Then LOOK at it.
//       --plain draws the sheet without Palm's marks (for showing someone the video, not the problems).
//   node video-check.mjs --test
//
// Sizes and safe zones: Palm data pack design/platform-sizes (checked 2026-11-23). TikTok's and YouTube's organic
// safe zones, and Instagram's organic Reels margins, are community-measured (no app publishes them); Meta's ad safe
// zone (14% top, 35% bottom, 6% sides) is official. The reading speed (about 3 words a second, at least 1 s per
// caption) and the smallest comfortable text on a phone (about 14 px line height) are Palm's guidance, not a platform rule.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
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
const has = (bin) => spawnSync(bin, ['-version'], { stdio: 'ignore' }).status === 0;
const NEED_FF = 'ffmpeg/ffprobe not found. macOS: `brew install ffmpeg`; Linux: your package manager; Windows: `winget install ffmpeg`.';

// Each app's limits and organic safe zones on a 1080×1920 frame (scaled to the video's own size).
export const APPS = {
  reels: { name: 'Instagram Reels', minS: 3, maxS: 15 * 60, zone: { top: 210, bottom: 310, left: 0, right: 84 }, zoneSource: 'community-measured (organic); Meta ads: 14% top, 35% bottom, 6% sides' },
  tiktok: { name: 'TikTok', minS: 1, maxS: 10 * 60, fps: [23, 60], zone: { top: 108, bottom: 320, left: 60, right: 120 }, zoneSource: 'community-measured (TikTok publishes no organic pixels)' },
  shorts: { name: 'YouTube Shorts', minS: 1, maxS: 3 * 60, zone: { top: 120, bottom: 300, left: 0, right: 96 }, zoneSource: 'community-measured' },
};
const READ_WPS = 3, READ_MIN_S = 1.0, MIN_PHONE_PX = 14, PHONE_W = 390, STEP = 0.5;

function probe(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('ffprobe could not read ' + basename(file) + ': ' + (r.stderr || '').slice(0, 200));
  const j = JSON.parse(r.stdout), v = j.streams.find((s) => s.codec_type === 'video'), a = j.streams.find((s) => s.codec_type === 'audio');
  const rate = (x) => { const [n, d] = String(x || '0/1').split('/').map(Number); return d ? n / d : n; };
  let w = v?.width || 0, h = v?.height || 0;
  const rot = Math.abs(Number(v?.tags?.rotate || v?.side_data_list?.find((s) => s.rotation != null)?.rotation || 0));
  if (rot === 90 || rot === 270) [w, h] = [h, w];
  return { w, h, fps: Math.round(rate(v?.avg_frame_rate || v?.r_frame_rate) * 100) / 100, vfr: v && rate(v.avg_frame_rate) && rate(v.r_frame_rate) && Math.abs(rate(v.avg_frame_rate) - rate(v.r_frame_rate)) > 0.5,
    codec: v?.codec_name, pix: v?.pix_fmt, duration: Math.round(Number(j.format.duration || v?.duration || 0) * 100) / 100, bytes: Number(j.format.size || statSync(file).size),
    audio: a ? { codec: a.codec_name, channels: a.channels, rate: Number(a.sample_rate) } : null };
}
function maxVolume(file) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /max_volume:\s*(-?[\d.]+|-inf) dB/.exec(r.stderr || ''); return m ? (m[1] === '-inf' ? -Infinity : Number(m[1])) : null;
}
function frames(file, dir, dur) {
  mkdirSync(dir, { recursive: true });
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', `fps=${1 / STEP},scale='min(1080,iw)':-2`, '-q:v', '3', join(dir, 'f%03d.jpg')], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('ffmpeg could not read frames: ' + (r.stderr || '').slice(0, 200));
  return readdirSync(dir).filter((f) => /^f\d+\.jpg$/.test(f)).sort().map((f, i) => ({ file: join(dir, f), t: Math.min(i * STEP, Math.max(0, dur - 0.05)) }));
}

// macOS text recognition (Vision), compiled once. Returns null where it isn't available (not a Mac, no swiftc).
const OCR_SWIFT = `import Foundation
import Vision
import AppKit
var out: [[String: Any]] = []
for path in CommandLine.arguments.dropFirst() {
  guard let img = NSImage(contentsOfFile: path), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { out.append(["file": path, "text": []]); continue }
  let req = VNRecognizeTextRequest()
  req.recognitionLevel = .accurate
  req.usesLanguageCorrection = true
  try? VNImageRequestHandler(cgImage: cg, options: [:]).perform([req])
  var items: [[String: Any]] = []
  for o in (req.results ?? []) {
    guard let c = o.topCandidates(1).first else { continue }
    let b = o.boundingBox
    items.append(["s": c.string, "c": c.confidence, "x": b.minX, "y": 1 - b.maxY, "w": b.width, "h": b.height])
  }
  out.append(["file": path, "text": items])
}
FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: out))
`;
function ocrBin() {
  if (process.platform !== 'darwin') return null;
  const dir = join(tmpdir(), 'palm-video-check-ocr-v1'), bin = join(dir, 'ocr');
  if (existsSync(bin)) return bin;
  mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ocr.swift'), OCR_SWIFT);
  const r = spawnSync('swiftc', ['-O', join(dir, 'ocr.swift'), '-o', bin], { encoding: 'utf8' });
  return r.status === 0 && existsSync(bin) ? bin : null;
}
export function ocr(files) {
  const bin = ocrBin(); if (!bin || !files.length) return null;
  const out = [];
  for (let i = 0; i < files.length; i += 20) {
    const r = spawnSync(bin, files.slice(i, i + 20), { encoding: 'utf8', maxBuffer: 64 << 20 });
    if (r.status !== 0) return null;
    out.push(...JSON.parse(r.stdout));
  }
  return out.map((f) => (f.text || []).filter((t) => t.c >= 0.5 && /[\p{L}\p{N}]{2,}/u.test(t.s)));
}

const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const words = (s) => norm(s).split(' ').filter(Boolean).length;
const zoneOf = (app, W, H) => { const k = W / 1080, z = APPS[app].zone; return { x0: z.left * k, x1: W - z.right * k, y0: z.top * (H / 1920), y1: H - z.bottom * (H / 1920) }; };

// Groups the text read from each frame into "screens" (the same words staying up) and measures them.
export function analyseText(perFrame, times, W, H, duration) {
  const screens = []; let cur = null;
  const total = times.length;
  // Text that stays up most of the video (a logo, a handle) isn't a caption to read.
  const count = new Map();
  perFrame.forEach((items) => new Set(items.map((t) => norm(t.s))).forEach((k) => count.set(k, (count.get(k) || 0) + 1)));
  const sticky = new Set([...count].filter(([, n]) => n >= Math.max(3, total * 0.6)).map(([k]) => k));
  perFrame.forEach((items, i) => {
    const caps = items.filter((t) => !sticky.has(norm(t.s)));
    const sig = caps.map((t) => norm(t.s)).sort().join(' | ');
    if (cur && cur.sig === sig) { cur.end = times[i] + STEP; return; }
    if (cur && cur.sig) screens.push(cur);
    cur = { sig, start: times[i], end: times[i] + STEP, lines: caps.map((t) => t.s), items: caps, frame: i };
  });
  if (cur && cur.sig) screens.push(cur);
  // One caption can read as several screens: lines that animate in one by one, a fade, or a letter misread for a
  // frame. Consecutive screens sharing most of their words are one caption, timed from first sight to last.
  const wset = (s) => new Set(s.lines.flatMap((l) => norm(l).split(' ')).filter(Boolean));
  for (let i = screens.length - 1; i > 0; i--) {
    const a = screens[i - 1], b = screens[i], A = wset(a), B = wset(b);
    const shared = [...A].filter((w) => B.has(w)).length;
    if (Math.abs(a.end - b.start) < 0.01 && shared >= 0.5 * Math.min(A.size, B.size)) {
      const full = B.size >= A.size ? b : a, seen = new Map();
      for (const t of [...a.items, ...b.items]) seen.set(norm(t.s), seen.get(norm(t.s)) || t);
      screens.splice(i - 1, 2, { sig: full.sig, start: a.start, end: b.end, lines: full.lines, items: [...seen.values()], frame: full.frame });
    }
  }
  for (const s of screens) {
    s.end = Math.min(s.end, duration || s.end); s.secs = Math.round((s.end - s.start) * 10) / 10;
    s.words = s.lines.reduce((n, l) => n + words(l), 0);
    s.needs = Math.round(Math.max(READ_MIN_S, s.words / READ_WPS) * 10) / 10;
    s.minPhonePx = Math.round(Math.min(...s.items.map((t) => t.h * H)) * (PHONE_W / W) * 10) / 10;
    s.under = Object.fromEntries(Object.keys(APPS).map((a) => { const z = zoneOf(a, W, H); return [a, s.items.filter((t) => { const x0 = t.x * W, x1 = (t.x + t.w) * W, y0 = t.y * H, y1 = (t.y + t.h) * H; return x0 < z.x0 - 2 || x1 > z.x1 + 2 || y0 < z.y0 - 2 || y1 > z.y1 + 2; }).map((t) => t.s)]; }));
  }
  return { sticky: [...sticky], screens };
}

export async function check(file, { cover = null, out = 'vc', plain = false } = {}) {
  if (!has('ffprobe') || !has('ffmpeg')) return { ok: false, issues: [{ severity: 'error', rule: 'tools', msg: NEED_FF }] };
  file = resolve(file);
  const v = probe(file), issues = [];
  const add = (severity, rule, msg, fix) => issues.push({ severity, rule, msg, ...(fix ? { fix } : {}) });
  const r916 = v.w && v.h ? v.w / v.h : 0;
  if (!v.w) add('error', 'no-video', 'No video stream found.');
  else {
    if (Math.abs(r916 - 9 / 16) > 0.01) add('error', 'ratio', `The video is ${v.w}×${v.h} (${(r916).toFixed(3)}), not 9:16; the apps letterbox or crop it.`, 'Render at 1080×1920.');
    else if (v.w < 1080) add('warn', 'resolution', `The video is ${v.w}×${v.h}; 1080×1920 is the usual upload and looks sharper.`, 'Render at 1080×1920.');
    if (v.fps > 60 || v.fps < 23) add('warn', 'fps', `${v.fps} fps; TikTok's posting API takes 23–60 fps.`, 'Use 30 fps.');
    if (v.vfr) add('warn', 'vfr', 'The frame rate varies; Meta asks for a fixed frame rate.', 'Re-encode with -r 30.');
    if (v.codec && !/h264|hevc/.test(v.codec)) add('warn', 'codec', `Video codec ${v.codec}; H.264 is the safe choice everywhere.`, 'Re-encode with libx264, -pix_fmt yuv420p.');
    if (v.pix && v.pix !== 'yuv420p' && v.codec === 'h264') add('warn', 'pixel-format', `Pixel format ${v.pix}; many players want yuv420p.`, 'Add -pix_fmt yuv420p.');
    for (const [k, a] of Object.entries(APPS)) {
      if (v.duration < a.minS) add('error', 'too-short-' + k, `${v.duration} s is shorter than ${a.name}'s ${a.minS} s minimum.`);
      if (v.duration > a.maxS) add('error', 'too-long-' + k, `${v.duration} s is longer than ${a.name}'s ${a.maxS / 60} min limit.`);
    }
  }
  let vol = null;
  if (!v.audio) add('info', 'no-audio', 'There is no audio track. That is fine if you add music in the app when posting (Reels and TikTok let you pick a sound); otherwise sound-on viewers get nothing.', 'Add music in the app, or your own licensed track (AAC, 44.1 or 48 kHz).');
  else { vol = maxVolume(file); if (vol != null && vol < -50) add('info', 'silent-audio', `The audio track is silent (peak ${vol === -Infinity ? '-inf' : vol} dB).`, 'Add real sound, or drop the silent track.'); }

  const work = mkdtempSync(join(tmpdir(), 'palm-vc-')), fr = frames(file, join(work, 'frames'), v.duration);
  const texts = ocr(fr.map((f) => f.file));
  let text = null;
  if (!texts) add('info', 'no-text-reading', 'Text recognition is only available on a Mac with Xcode command line tools (swiftc), so the words on screen were not measured: look at the sheet yourself.');
  else {
    text = analyseText(texts, fr.map((f) => f.t), v.w, v.h, v.duration);
    for (const s of text.screens) {
      const label = `"${s.lines.join(' / ').slice(0, 80)}" (${s.start.toFixed(1)}–${s.end.toFixed(1)} s)`;
      if (s.secs + 0.01 < s.needs) add('warn', 'too-fast', `${label}: ${s.words} words on screen for about ${s.secs} s; reading them takes about ${s.needs} s.`, 'Hold it longer or cut words.');
      if (s.minPhonePx < MIN_PHONE_PX) add('warn', 'text-small', `${label}: the smallest line is about ${s.minPhonePx} px tall on a phone (under ~${MIN_PHONE_PX} px is hard to read).`, 'Make the text bigger.');
      for (const [a, list] of Object.entries(s.under)) if (list.length) add('error', 'under-ui-' + a, `${label}: "${list.join(' / ').slice(0, 60)}" sits where ${APPS[a].name} puts its buttons, caption or top bar.`, 'Move it inside the dashed safe zone.');
    }
    for (const k of text.sticky) {
      const it = texts.flat().find((t) => norm(t.s) === k);
      if (it) for (const a of Object.keys(APPS)) { const z = zoneOf(a, v.w, v.h); const x0 = it.x * v.w, x1 = (it.x + it.w) * v.w, y0 = it.y * v.h, y1 = (it.y + it.h) * v.h; if (x0 < z.x0 - 2 || x1 > z.x1 + 2 || y0 < z.y0 - 2 || y1 > z.y1 + 2) add('warn', 'logo-under-ui-' + a, `"${it.s}" stays on screen in ${APPS[a].name}'s button or caption area.`, 'Move it inside the safe zone.'); }
    }
  }
  // The cover: Instagram's grid shows a 3:4 centre crop of it.
  let cov = cover ? resolve(cover) : fr[0]?.file, covText = null;
  if (cover && !existsSync(cov)) { add('error', 'cover-missing', `No cover at ${cover}.`); cov = fr[0]?.file; }
  if (cov && texts !== null) {
    const ct = ocr([cov])?.[0] || [];
    const ci = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', cov], { encoding: 'utf8' }).stdout.trim().split(',').map(Number);
    const [cw, ch] = ci.length === 2 && ci[0] ? ci : [v.w, v.h];
    const cropH = Math.min(ch, cw * 4 / 3), top = (ch - cropH) / 2;
    covText = ct.map((t) => t.s);
    const cut = ct.filter((t) => t.y * ch < top - 2 || (t.y + t.h) * ch > top + cropH + 2);
    if (cut.length) add('warn', 'cover-crop', `On the Instagram profile grid (a 3:4 centre crop of the cover) these words are cut off: "${cut.map((t) => t.s).join(' / ').slice(0, 80)}".`, 'Keep the cover title in the middle 3:4.');
    if (!ct.length) add('info', 'cover-no-text', 'The cover has no readable words; in a grid, a title helps people know what the video is.');
  }

  const sheet = resolve(out + '-sheet.png');
  await drawSheet({ v, fr, texts, text, cov, plain, sheet, vol });
  try { rmSync(work, { recursive: true, force: true }); } catch {}
  const errors = issues.filter((i) => i.severity === 'error').length;
  return { ok: errors === 0, video: { file: basename(file), ...v, audioPeakDb: vol }, cover: cov ? basename(cov) : null, coverText: covText,
    text: text ? { read: true, sticky: text.sticky, screens: text.screens.map(({ items, frame, sig, ...s }) => s) } : { read: false },
    errors, warnings: issues.filter((i) => i.severity === 'warn').length, issues, sheet };
}

// ---- the sheet ----
function chrome(app, w, h) {
  // Each app's own interface over the video, drawn at phone size (w×h px), plus the safe zone (dashed).
  const s = w / 300, ic = (d) => `<div style="width:${30 * s}px;height:${30 * s}px;border-radius:50%;background:rgba(255,255,255,.92);margin:${7 * s}px auto ${2 * s}px;box-shadow:0 1px 3px rgba(0,0,0,.4)"></div><div style="font-size:${9 * s}px;text-align:center;color:#fff;text-shadow:0 1px 2px #000">${d}</div>`;
  const z = APPS[app].zone, zx = (n) => n * w / 1080, zy = (n) => n * h / 1920;
  const zone = `<div class="sz" style="left:${zx(z.left)}px;right:${zx(z.right)}px;top:${zy(z.top)}px;bottom:${zy(z.bottom)}px"></div>`;
  const txt = (t, size, extra = '') => `<div style="color:#fff;font:${extra.includes('bold') ? 600 : 400} ${size * s}px -apple-system,system-ui,sans-serif;text-shadow:0 1px 2px rgba(0,0,0,.7);${extra.replace('bold', '')}">${t}</div>`;
  if (app === 'reels') return `${zone}<div class="ui" style="top:${10 * s}px;left:${12 * s}px">${txt('Reels', 15, 'bold')}</div>
    <div class="ui" style="right:${6 * s}px;bottom:${70 * s}px;width:${38 * s}px">${ic('8.1K') + ic('214') + ic('') + ic('')}</div>
    <div class="ui" style="left:${12 * s}px;right:${56 * s}px;bottom:${18 * s}px">${txt('<span style="display:inline-block;width:' + 22 * s + 'px;height:' + 22 * s + 'px;border-radius:50%;background:#ccc;vertical-align:middle"></span> yourbrand · <b>Follow</b>', 11)}${txt('Your caption starts here and gets cut… more', 10.5, 'margin-top:' + 6 * s + 'px')}${txt('♫ Original audio', 9.5, 'margin-top:' + 4 * s + 'px')}</div>`;
  if (app === 'tiktok') return `${zone}<div class="ui" style="top:${12 * s}px;left:0;right:0;text-align:center">${txt('Following &nbsp; <b style="border-bottom:2px solid #fff">For You</b>', 12.5)}</div>
    <div class="ui" style="right:${6 * s}px;bottom:${60 * s}px;width:${40 * s}px">${ic('') + ic('12.4K') + ic('310') + ic('1.2K') + ic('Share')}</div>
    <div class="ui" style="left:${10 * s}px;right:${60 * s}px;bottom:${14 * s}px">${txt('@yourbrand', 12, 'bold')}${txt('Your caption shows here on two lines and then gets cut off … more', 10.5, 'margin-top:' + 4 * s + 'px')}${txt('♫ original sound', 9.5, 'margin-top:' + 4 * s + 'px')}</div>`;
  return `${zone}<div class="ui" style="top:${10 * s}px;right:${12 * s}px">${txt('⌕ &nbsp; ⋮', 15)}</div>
    <div class="ui" style="right:${6 * s}px;bottom:${50 * s}px;width:${40 * s}px">${ic('3.2K') + ic('Dislike') + ic('88') + ic('Share') + ic('Remix')}</div>
    <div class="ui" style="left:${12 * s}px;right:${60 * s}px;bottom:${14 * s}px">${txt('<span style="display:inline-block;width:' + 22 * s + 'px;height:' + 22 * s + 'px;border-radius:50%;background:#ccc;vertical-align:middle"></span> @yourbrand <span style="background:#fff;color:#000;border-radius:12px;padding:1px 8px">Subscribe</span>', 11)}${txt('Your Short title shows here', 11, 'margin-top:' + 6 * s + 'px')}</div>`;
}
async function drawSheet({ v, fr, texts, text, cov, plain, sheet, vol = null }) {
  const url = (f) => pathToFileURL(f).href;
  const PW = 270, PH = Math.round(PW * (v.h && v.w ? v.h / v.w : 16 / 9));
  const box = (items, w, h) => plain || !items ? '' : items.map((t) => `<div class="tb" style="left:${t.x * w}px;top:${t.y * h}px;width:${t.w * w}px;height:${t.h * h}px"></div>`).join('');
  // Key frames: the middle of each text screen (up to 4), else three evenly spaced frames.
  let keys = text?.screens?.length ? text.screens.slice(0, 4).map((s) => Math.min(fr.length - 1, Math.round((s.start + s.end) / 2 / STEP))) : [];
  if (!keys.length) keys = [0.2, 0.5, 0.8].map((p) => Math.min(fr.length - 1, Math.round(p * (fr.length - 1))));
  keys = [...new Set(keys)];
  const phone = (i, app) => `<div class="ph" style="width:${PW}px;height:${PH}px"><img src="${url(fr[i].file)}" style="width:${PW}px;height:${PH}px">${box(texts?.[i], PW, PH)}${chrome(app, PW, PH)}</div>`;
  const strip = fr.map((f, i) => `<figure class="tl"><div style="position:relative"><img src="${url(f.file)}" style="width:72px;height:${Math.round(72 * PH / PW)}px">${box(texts?.[i], 72, Math.round(72 * PH / PW))}</div><figcaption>${f.t.toFixed(1)} s</figcaption></figure>`).join('');
  const grid = (crop, label) => {
    const W = 120, Hc = crop === '3:4' ? 160 : Math.round(W * 16 / 9);
    const cell = (mine, k) => mine ? `<div style="width:${W}px;height:${Hc}px;overflow:hidden;position:relative"><img src="${url(cov)}" style="position:absolute;left:0;top:50%;width:${W}px;transform:translateY(-50%)"></div>` : `<div style="width:${W}px;height:${Hc}px;background:hsl(${k * 47 + 20},14%,${70 - (k % 3) * 8}%)"></div>`;
    return `<figure><figcaption>${label}</figcaption><div style="display:grid;grid-template-columns:repeat(3,${W}px);gap:2px;background:#fff;padding:2px">${[0, 1, 2, 3, 4, 5].map((k) => cell(k === 1, k)).join('')}</div></figure>`;
  };
  const rows = keys.map((i) => `<div class="row"><div class="lab">${fr[i].t.toFixed(1)} s</div>${['reels', 'tiktok', 'shorts'].map((a) => `<figure><figcaption>${APPS[a].name}</figcaption>${phone(i, a)}</figure>`).join('')}</div>`).join('');
  const head = `${v.w}×${v.h} · ${v.fps} fps · ${v.duration} s · ${v.codec || '?'} · ${!v.audio ? 'no audio track' : vol != null && vol < -50 ? 'silent audio track' : 'audio ' + v.audio.codec} · ${(v.bytes / 1048576).toFixed(1)} MB`;
  const html = `<!doctype html><meta charset="utf-8"><style>
  body{margin:0;padding:20px;background:#ecebe8;font:13px -apple-system,system-ui,sans-serif;color:#222;width:${Math.max(3 * (PW + 24) + 90, 1000)}px}
  h2{font:600 12px ui-monospace,monospace;letter-spacing:.06em;text-transform:uppercase;color:#555;margin:22px 0 10px}
  .row{display:flex;gap:22px;align-items:flex-start;margin-bottom:18px}.lab{width:60px;font:600 13px ui-monospace,monospace;padding-top:22px}
  figure{margin:0}figcaption{font:600 11px ui-monospace,monospace;color:#555;margin-bottom:5px}
  .ph{position:relative;overflow:hidden;border-radius:16px;background:#000}.ph img{display:block;object-fit:cover}
  .ui{position:absolute}.sz{position:absolute;border:2px dashed ${plain ? 'transparent' : 'rgba(255,45,85,.95)'};pointer-events:none}
  .tb{position:absolute;outline:1.5px solid ${plain ? 'transparent' : '#ffd60a'}}
  .strip{display:flex;flex-wrap:wrap;gap:6px}.tl img{display:block;border-radius:4px}.tl figcaption{font-size:10px;margin:3px 0 0}
  .grids{display:flex;gap:28px;align-items:flex-start}
  </style>
  <div style="font:600 15px -apple-system,system-ui">${head}</div>
  <h2>Every ${STEP} s${plain ? '' : ' (yellow: words Palm read on screen)'}</h2><div class="strip">${strip}</div>
  <h2>On a phone in each app${plain ? '' : ' (dashed: safe zone; outside it the app\'s buttons, caption or bar cover the video)'}</h2>${rows}
  ${cov ? `<h2>The cover where people pick what to watch</h2><div class="grids">${grid('3:4', 'Instagram profile grid (3:4 centre crop)')}${grid('9:16', 'TikTok profile / Shorts shelf (9:16)')}<figure><figcaption>Cover, full</figcaption><img src="${url(cov)}" style="width:150px;display:block"></figure></div>` : ''}`;
  const b = await loadPuppeteer().launch({ executablePath: findChrome(), headless: true, timeout: 90000, args: ['--no-sandbox', '--hide-scrollbars', '--allow-file-access-from-files'] });
  try {
    const p = await b.newPage(); await p.setViewport({ width: 1100, height: 900 });
    const tmp = join(dirname(fr[0]?.file || tmpdir()), 'sheet.html'); writeFileSync(tmp, html);
    await p.goto(pathToFileURL(tmp).href, { waitUntil: 'load' });
    await p.evaluate(() => Promise.all([...document.images].map((i) => i.complete ? 0 : new Promise((r) => { i.onload = i.onerror = r; }))));
    mkdirSync(dirname(sheet), { recursive: true });
    await p.screenshot({ path: sheet, fullPage: true });
  } finally { await b.close(); }
}

// ---- self-test: synthetic videos made with ffmpeg ----
async function selfTest() {
  if (!has('ffmpeg')) throw new Error(NEED_FF);
  const d = mkdtempSync(join(tmpdir(), 'vc-test-'));
  const ff = (args) => { const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); };
  // Text frames rendered with Chrome (ffmpeg's drawtext isn't in every build), then cut together with ffmpeg.
  const br = await loadPuppeteer().launch({ executablePath: findChrome(), headless: true, timeout: 90000, args: ['--no-sandbox'] });
  const still = async (name, blocks) => { const pg = await br.newPage(); await pg.setViewport({ width: 1080, height: 1920 }); await pg.setContent(`<body style="margin:0;width:1080px;height:1920px;background:#224466;position:relative;font-family:Arial,Helvetica,sans-serif">${blocks.map(([t, x, y, size]) => `<div style="position:absolute;left:${x}px;top:${y}px;color:#fff;font-weight:700;font-size:${size}px;white-space:nowrap">${t}</div>`).join('')}</body>`); await pg.screenshot({ path: join(d, name + '.png') }); await pg.close(); };
  const cut = (out, parts, audio) => { const list = parts.map(([n, sec]) => `file '${join(d, n + '.png')}'\nduration ${sec}`).join('\n') + `\nfile '${join(d, parts.at(-1)[0] + '.png')}'`; writeFileSync(join(d, out + '.txt'), list); const total = parts.reduce((n, [, s]) => n + s, 0);
    ff(['-f', 'concat', '-safe', '0', '-i', join(d, out + '.txt'), '-f', 'lavfi', '-i', audio, '-t', String(total), '-r', '30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(d, out + '.mp4')]); };
  // Text problems: a caption under the bottom UI the whole time, a long caption flashed for 1 s, tiny text; silent audio.
  await still('t1', [['SALE ENDS FRIDAY', 140, 1760, 72]]);
  await still('t2', [['SALE ENDS FRIDAY', 140, 1760, 72], ['Handmade in Bristol from local clay every single week', 120, 800, 44]]);
  await still('t3', [['SALE ENDS FRIDAY', 140, 1760, 72], ['tiny small print here', 300, 1100, 20]]);
  cut('text', [['t1', 1], ['t2', 1], ['t1', 1], ['t3', 3]], 'anullsrc=r=48000:cl=stereo');
  const tx = await check(join(d, 'text.mp4'), { out: join(d, 'text') });
  if (!tx.issues.some((i) => i.rule === 'silent-audio')) throw new Error('silent audio not flagged: ' + tx.issues.map((i) => i.rule).join(','));
  if (tx.text.read) {
    for (const want of ['too-fast', 'text-small']) if (!tx.issues.some((i) => i.rule === want)) throw new Error('text: expected ' + want + ' in ' + tx.issues.map((i) => i.rule).join(','));
    if (!tx.issues.some((i) => /under-ui|logo-under-ui/.test(i.rule))) throw new Error('caption under the UI not flagged: ' + tx.issues.map((i) => i.rule).join(','));
  }
  // Clean: 1080×1920, 30 fps, 8 s, a real tone, big captions inside the safe zone held long enough.
  await still('c1', [['New mugs', 200, 700, 110]]);
  await still('c2', [['Friday 10am', 200, 900, 110]]);
  cut('ok', [['c1', 4], ['c2', 4]], 'sine=frequency=440:sample_rate=48000');
  await br.close();
  const ok = await check(join(d, 'ok.mp4'), { out: join(d, 'ok') });
  const bads = ok.issues.filter((i) => i.severity !== 'info');
  if (bads.length) throw new Error('clean video flagged: ' + bads.map((i) => i.rule + ': ' + i.msg).join(' | '));
  console.log(`video-check: all tests pass (text reading ${tx.text.read ? 'on' : 'off: not a Mac with swiftc'}; sheet ${tx.sheet})`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (k) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : undefined; };
  const VALUED = new Set(['--cover', '--out']);
  const pos = argv.filter((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1]));
  if (argv.includes('--test')) selfTest().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
  else if (pos[0] === 'check' && pos[1]) check(pos[1], { cover: opt('cover'), out: opt('out') || 'vc', plain: argv.includes('--plain') }).then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); }, (e) => { console.error(String(e.message || e)); process.exit(2); });
  else { console.error('usage: video-check.mjs check <video.mp4> [--cover cover.jpg] [--out vc] [--plain]\n       video-check.mjs --test'); process.exit(2); }
}
