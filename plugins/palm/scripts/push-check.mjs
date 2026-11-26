#!/usr/bin/env node
// Palm tool: push-check — lets an agent see a set of push notifications where people read them, and measures what each
// view cuts. A notification is read mostly in its smallest form: one line of title and one line of text in Android's
// collapsed shade, heads-up banner and lock screen; a few lines on an iPhone's Lock Screen and in Notification Centre
// (fewer words per line on a small phone or with larger text); only the title on an Apple Watch's short look.
//
//   node push-check.mjs check <notifications.json | .csv | folder> [--app "App name"] [--out look/push] [--plain]
//       → JSON {ok, errors, warnings, notifications:[…per view: shown, cut, cut_at, key_ok…], issues, sheet}.
//       Then LOOK at <out>-sheet.png.
//       Input: a JSON array of {id, lang, title, subtitle?, body, key?} (or {app, notifications:[…]}, or
//       {"en":[…],"de":[…]}), or a CSV with those columns. `key` is the phrase that must be seen at a glance (the
//       offer, the number, the habit's name); without it Palm guesses one (a number/price/percent phrase, else the
//       title's first two words) and labels it "guessed".
//   node push-check.mjs --self-test
//
// Facts (read 2026-11-26):
//   Apple HIG "Notifications" (developer.apple.com/design/human-interface-guidelines/notifications): "Create a short
//     title if it provides context… Prefer brief titles that people can read at a glance, especially on Apple Watch";
//     titles in title-style capitalization with no ending punctuation; body in sentence case, complete sentences,
//     "don't truncate your message — the system does this automatically"; "Avoid including your app name or icon";
//     don't send several notifications for the same thing; avoid sensitive information; Apple Watch's short look shows
//     "just enough time to see what the notification is about and which app sent it".
//   Apple HIG "Managing notifications": marketing notifications only with explicit opt-in and an in-app setting to
//     change it; "Never use the Time Sensitive interruption level to send a marketing notification".
//   App Review Guidelines 4.5.4: push notifications must not be used for promotions or direct marketing unless people
//     explicitly opted in via consent language in the app's UI, with a way to opt out in the app.
//   Apple "Generating a remote notification": alert keys title, subtitle, body (and -loc-key versions); payload max 4 KB.
//   Android "Notifications" design guide (developer.android.com/design/ui/mobile/guides/home-screen/notifications):
//     "Android truncates content titles to a single line (even when expanded)"; a good title "Doesn't exceed 30
//     characters", "Contains the most important information", "Excludes the app's name"; content text "Avoids
//     exceeding the 40-character limit" and "Avoids repeating what's in the content title"; don't notify to bring
//     people back with no direct value ("Haven't seen you in a while!"), for cross-promotion, or for holiday greetings;
//     promotional content belongs in a low-importance (MIN) channel. Notifications can vary by device maker.
//   Android "Create a notification" (…/develop/ui/views/notifications/build-notification): "By default, the
//     notification's text content is truncated to fit one line"; more shows only in an expandable style (BigTextStyle).
// Palm's approximation of the system UIs (Nov 2026; neither Apple nor Google publishes these layouts as numbers):
//   iPhone Lock Screen / Notification Centre card: screen widths 375 (small), 393 (regular), 430 (Max) pt; card 8 pt in
//   from each side, 14 pt padding, 38 pt app icon + 10 pt gap; title and subtitle one line each (the time beside the
//   title), body up to 4 lines; text 15 pt (title semibold), larger text ×1.25. Grouped stack: only the newest card is
//   readable. Apple Watch short look (41 mm, 176 pt wide): app icon, app name, the title up to 3 lines at 17 pt.
//   Android shade, lock screen and heads-up (collapsed): screen widths 360 and 412 dp, card 8 dp in, 16 dp padding, a
//   40 dp icon + 12 dp gap, 32 dp for the expand chevron; the app name and time on a header line, the title one line
//   (15 sp medium), the text one line (14 sp); font scale 1.0 and 1.3. Expanded (BigTextStyle): title one line, text up
//   to 7 lines. Fonts: the system stack (-apple-system for iPhone, Roboto if installed for Android); SF Pro and Roboto
//   aren't bundled, so widths are Palm's approximation and real phones differ by a few characters.
// Palm's thresholds (guidance, not a platform rule): the key phrase whole in every collapsed view; title and body
//   sharing at least 2 content words and half the title's = repetition; more than 2 emoji in one notification; 2+ words
//   in capitals (or a title in capitals) = shouting.
// adds: tool. Runs on the user's machine with their Chrome/Edge/Chromium; nothing leaves it.

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, basename } from 'node:path';
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
const launch = () => loadPuppeteer().launch({ executablePath: findChrome(), headless: true, timeout: 90000, protocolTimeout: 180000, args: ['--no-sandbox', '--hide-scrollbars'] });

// ---------- input ----------
const pick = (o, ks) => { for (const k of ks) for (const kk of Object.keys(o)) if (kk.toLowerCase() === k && o[kk] != null && typeof o[kk] !== 'object') return String(o[kk]); return ''; };
const LANG_RE = /^[a-z]{2}([-_][a-z]{2,4})?$/i;
function norm(o, lang, i) {
  return {
    id: pick(o, ['id', 'name', 'type', 'kind', 'slug', 'trigger']) || `#${i + 1}`,
    lang: (pick(o, ['lang', 'language', 'locale']) || lang || 'en').toLowerCase().replace('_', '-'),
    title: pick(o, ['title', 'heading', 'headline', 'content_title']),
    subtitle: pick(o, ['subtitle', 'sub_title']),
    body: pick(o, ['body', 'message', 'text', 'content', 'content_text', 'alert']),
    key: pick(o, ['key', 'key_phrase', 'keyphrase', 'keyword']),
  };
}
function flatten(x, lang) {
  if (Array.isArray(x)) return x.flatMap((o, i) => {
    if (!o || typeof o !== 'object') return [];
    const nested = Object.keys(o).filter((k) => LANG_RE.test(k) && o[k] && typeof o[k] === 'object' && !Array.isArray(o[k]));
    if (nested.length && !pick(o, ['title', 'body', 'message', 'text'])) return nested.map((l) => ({ ...norm(o[l], l, i), id: pick(o, ['id', 'name', 'type', 'kind', 'slug', 'trigger']) || `#${i + 1}` }));
    return [norm(o, lang, i)];
  });
  if (x && typeof x === 'object') {
    for (const k of ['notifications', 'pushes', 'messages', 'items']) if (Array.isArray(x[k])) return flatten(x[k], lang);
    const langs = Object.keys(x).filter((k) => LANG_RE.test(k));
    if (langs.length) return langs.flatMap((l) => Array.isArray(x[l]) ? flatten(x[l], l) : x[l] && typeof x[l] === 'object' ? flatten(Object.values(x[l]).some((v) => v && typeof v === 'object') ? Object.entries(x[l]).map(([id, v]) => ({ id, ...v })) : [x[l]], l) : []);
    // {id: {title, body}} maps
    const vals = Object.entries(x).filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v));
    if (vals.length) return flatten(vals.map(([id, v]) => ({ id, ...v })), lang);
  }
  return [];
}
function parseCsv(t) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) { if (ch === '"' && t[i + 1] === '"') { f += '"'; i++; } else if (ch === '"') q = false; else f += ch; continue; }
    if (ch === '"') q = true; else if (ch === ',') { row.push(f); f = ''; } else if (ch === '\n' || ch === '\r') { if (ch === '\r' && t[i + 1] === '\n') i++; row.push(f); f = ''; if (row.some((c) => c !== '')) rows.push(row); row = []; } else f += ch;
  }
  row.push(f); if (row.some((c) => c !== '')) rows.push(row);
  const head = (rows.shift() || []).map((h) => h.trim().toLowerCase());
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}
export function load(target) {
  let files = [target];
  if (statSync(target).isDirectory()) {
    files = readdirSync(target).filter((f) => /\.(json|csv)$/i.test(f)).sort().map((f) => join(target, f));
    if (!files.length) throw new Error(`No .json or .csv file of notifications in ${target}.`);
  }
  const out = [];
  for (const f of files) {
    const txt = readFileSync(f, 'utf8');
    let items = [];
    if (/\.csv$/i.test(f)) items = flatten(parseCsv(txt));
    else { try { items = flatten(JSON.parse(txt)); } catch (e) { throw new Error(`${basename(f)} isn't valid JSON: ${e.message}`); } }
    out.push(...items.filter((n) => n.title || n.body));
  }
  return out;
}

// ---------- text helpers ----------
const STOP = new Set(('a an the and or but of to in on at for with from by your you you\'re youre our we it its this that these those is are was were be been be has have had do does did not no yes can will just now new get got all any more most so up out as into than then there here what when how who why which ' +
  'der die das den dem des ein eine einen einem einer und oder aber von zu im in am an auf für mit aus bei ist sind war waren sein hat haben dein deine deinen deinem deiner du dich dir ihr ihre sie es wir uns unser jetzt noch schon nur mehr nicht kein keine so wie was wer wann hier da dann auch sich zum zur vom').split(/\s+/));
const words = (s) => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
const stem = (w) => w.slice(0, 5);
export function contentWords(s) { return [...new Set(words(s).filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)).map(stem))]; }
export function emojiCount(s) { return (s.match(/\p{Extended_Pictographic}/gu) || []).length; }
export function capsWords(s) { return (s.match(/\b\p{Lu}{3,}\b/gu) || []).filter((w) => !/^(PDF|USB|GPS|SMS|FAQ|APP|URL|VIP|DIY|BBC|NHS|USA|EU|UK)$/.test(w)); }
export function guessKey(n) {
  const all = `${n.title} ${n.subtitle} ${n.body}`;
  const m = all.match(/(?:[€$£¥]\s?\d[\d.,]*|\d[\d.,]*\s?(?:%|€|\$|£|¥)|\d+(?:[.,]\d+)?\s?(?:of|von|\/)\s?\d+)(?:\s+[\p{L}]+)?/u);
  if (m) return m[0].trim();
  const t = (n.title || n.body).split(/\s+/).filter((w) => !STOP.has(w.toLowerCase().replace(/[^\p{L}]/gu, '')) && /[\p{L}\p{N}]/u.test(w));
  return t.slice(0, 2).join(' ').replace(/[.,:;!?…]+$/, '');
}

// ---------- the views (Palm's approximation, Nov 2026) ----------
export const VIEWS = [
  { key: 'ios-375', os: 'ios', label: 'iPhone, 375 pt (small), default text, Lock Screen, light', w: 375, scale: 1, dark: false, bodyLines: 4, glance: true },
  { key: 'ios-430-dark', os: 'ios', label: 'iPhone, 430 pt (Max), default text, Notification Centre, dark', w: 430, scale: 1, dark: true, bodyLines: 4, glance: true },
  { key: 'ios-375-large', os: 'ios', label: 'iPhone, 375 pt, larger text (Dynamic Type, ≈+25%), dark', w: 375, scale: 1.25, dark: true, bodyLines: 4, glance: true },
  { key: 'ios-stack', os: 'ios', label: 'iPhone, 393 pt, a grouped stack (only the newest is readable), light', w: 393, scale: 1, dark: false, bodyLines: 4, stack: true },
  { key: 'watch-41', os: 'watch', label: 'Apple Watch 41 mm, short look (raise the wrist)', w: 176, scale: 1, dark: true, glance: true },
  { key: 'and-360', os: 'android', label: 'Android, 360 dp, notification shade, collapsed, light', w: 360, scale: 1, dark: false, bodyLines: 1, glance: true },
  { key: 'and-412-lock-13', os: 'android', label: 'Android, 412 dp, lock screen, font scale 1.3, dark', w: 412, scale: 1.3, dark: true, bodyLines: 1, glance: true },
  { key: 'and-412-exp', os: 'android', label: 'Android, 412 dp, expanded (BigTextStyle), light', w: 412, scale: 1, dark: false, bodyLines: 7 },
  { key: 'and-360-headsup', os: 'android', label: 'Android, 360 dp, heads-up banner over an app, dark', w: 360, scale: 1, dark: true, bodyLines: 1, glance: true, headsup: true },
];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Each word is its own span, so the page can say which words a view shows.
const spans = (s, field) => String(s).split(/(\s+)/).map((t) => /^\s+$/.test(t) || !t ? esc(t) : `<span class="w" data-f="${field}">${esc(t)}</span>`).join('');
const IOS_FONT = "-apple-system, 'SF Pro Text', system-ui, 'Helvetica Neue', Arial, sans-serif";
const AND_FONT = "Roboto, 'Google Sans Text', 'Noto Sans', Arial, sans-serif";

function iosCard(n, v, app, i) {
  const s = v.scale, d = v.dark;
  const fg = d ? '#f2f2f7' : '#111', mute = d ? 'rgba(235,235,245,.6)' : 'rgba(60,60,67,.6)', bg = d ? 'rgba(44,44,46,.82)' : 'rgba(246,246,248,.86)';
  const T = n.title || app; // iOS shows the app name when there is no title
  return `<div class="n" data-i="${i}" data-n="${n._idx}" style="margin:0 8px 8px;background:${bg};border-radius:${20}px;padding:14px;display:flex;gap:10px;align-items:flex-start;-webkit-backdrop-filter:blur(20px)">
  <div style="width:38px;height:38px;border-radius:9px;background:#3b7d6e;flex:none;color:#fff;font:600 19px/38px ${IOS_FONT};text-align:center">${esc(app[0] || 'A')}</div>
  <div style="flex:1;min-width:0;color:${fg};font-family:${IOS_FONT}">
    <div style="display:flex;gap:8px;align-items:baseline"><div class="box" data-f="title" style="flex:1;min-width:0;font-weight:600;font-size:${15 * s}px;line-height:${20 * s}px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${spans(T, 'title')}</div><div style="flex:none;font-size:${13 * s}px;color:${mute}">${i === 0 || v.stack ? 'now' : `${i * 2}m ago`}</div></div>
    ${n.subtitle ? `<div class="box" data-f="subtitle" style="font-weight:600;font-size:${15 * s}px;line-height:${20 * s}px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${spans(n.subtitle, 'subtitle')}</div>` : ''}
    ${n.body ? `<div class="box" data-f="body" style="font-size:${15 * s}px;line-height:${20 * s}px;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:${v.bodyLines};overflow:hidden;overflow-wrap:break-word">${spans(n.body, 'body')}</div>` : ''}
  </div></div>`;
}
function watchCard(n, v, app, i) {
  return `<div class="n" data-i="${i}" data-n="${n._idx}" style="width:176px;height:215px;background:#000;border-radius:34px;color:#fff;font-family:${IOS_FONT};text-align:center;padding:18px 8px 0;box-sizing:border-box;flex:none">
  <div style="width:62px;height:62px;border-radius:50%;background:#3b7d6e;margin:0 auto 8px;font:600 28px/62px ${IOS_FONT}">${esc(app[0] || 'A')}</div>
  <div style="font-size:13px;color:rgba(255,255,255,.6);margin-bottom:4px;text-transform:uppercase;letter-spacing:.02em">${esc(app)}</div>
  <div class="box" data-f="title" style="font-weight:600;font-size:17px;line-height:21px;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;overflow-wrap:break-word">${spans(n.title || app, 'title')}</div></div>`;
}
function andCard(n, v, app, i) {
  const s = v.scale, d = v.dark;
  const fg = d ? '#e6e1e5' : '#1c1b1f', mute = d ? '#b0abb3' : '#5f5b63', bg = d ? '#2b2930' : '#ffffff';
  // A subtitle has no slot on Android (Firebase sends title + body); Palm shows it as the start of the text.
  const body = [n.subtitle, n.body].filter(Boolean).join(' · ');
  return `<div class="n" data-i="${i}" data-n="${n._idx}" style="margin:0 8px ${v.headsup ? 14 : 3}px;background:${bg};border-radius:${v.headsup ? 24 : i === 0 ? '22px 22px 6px 6px' : '6px'};padding:16px;display:flex;gap:12px;align-items:flex-start;${v.headsup ? 'box-shadow:0 6px 20px rgba(0,0,0,.45)' : ''}">
  <div style="width:40px;height:40px;border-radius:50%;background:#3b7d6e;flex:none;color:#fff;font:500 18px/40px ${AND_FONT};text-align:center">${esc(app[0] || 'A')}</div>
  <div style="flex:1;min-width:0;color:${fg};font-family:${AND_FONT}">
    <div style="font-size:${12 * s}px;line-height:${16 * s}px;color:${mute};white-space:nowrap;overflow:hidden">${esc(app)} • ${i === 0 ? 'now' : `${i * 2}m`}</div>
    <div class="box" data-f="title" style="font-weight:500;font-size:${15 * s}px;line-height:${20 * s}px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${spans(n.title || app, 'title')}</div>
    ${body ? `<div class="box" data-f="body" style="font-size:${14 * s}px;line-height:${20 * s}px;color:${d ? '#cac4d0' : '#49454f'};${v.bodyLines === 1 ? 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis' : `display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:${v.bodyLines};overflow:hidden;overflow-wrap:break-word`}">${spans(body, 'body')}</div>` : ''}
  </div>
  <div style="width:20px;height:20px;border-radius:50%;background:${d ? '#3d3a42' : '#ece6f0'};flex:none;color:${mute};font:12px/20px ${AND_FONT};text-align:center">${v.bodyLines > 1 ? '⌃' : '⌄'}</div></div>`;
}

function panel(v, list, app) {
  const W = v.w;
  if (v.os === 'watch') return `<figure class="p" data-v="${v.key}" style="width:${Math.min(list.length, 8) * 188}px"><figcaption>${esc(v.label)}</figcaption><div style="display:flex;flex-wrap:wrap;gap:12px">${list.map((n, i) => watchCard(n, v, app, i)).join('')}</div></figure>`;
  if (v.os === 'ios') {
    const bg = v.dark ? 'linear-gradient(160deg,#1d2b3a,#3a2442 60%,#14161c)' : 'linear-gradient(160deg,#9ec5e8,#e7c3d6 55%,#f4e3c4)';
    const head = v.stack ? '' : `<div style="text-align:center;color:#fff;font:600 ${v.dark ? 13 : 13}px ${IOS_FONT};padding:10px 0 0;opacity:.9">Friday 27 November</div><div style="text-align:center;color:#fff;font:700 64px/1 ${IOS_FONT};padding:0 0 14px;text-shadow:0 1px 8px rgba(0,0,0,.15)">9:41</div>`;
    let inner;
    if (v.stack) {
      const top = list[list.length - 1], k = list.length - 1;
      inner = `<div style="position:relative;padding-bottom:${list.length > 2 ? 16 : list.length > 1 ? 8 : 0}px">${list.length > 2 ? `<div style="position:absolute;left:24px;right:24px;bottom:0;height:40px;border-radius:16px;background:rgba(246,246,248,.5)"></div>` : ''}${list.length > 1 ? `<div style="position:absolute;left:16px;right:16px;bottom:8px;height:40px;border-radius:18px;background:rgba(246,246,248,.7)"></div>` : ''}<div style="position:relative">${iosCard(top, v, app, k).replace('margin:0 8px 8px', 'margin:0 8px 0')}</div></div><div style="text-align:center;font:500 12px ${IOS_FONT};color:#333;padding:6px 0 10px">${list.length > 1 ? `${list.length - 1} more notification${list.length > 2 ? 's' : ''} from ${esc(app)}` : ''}</div>`;
    } else inner = list.map((n, i) => iosCard(n, v, app, i)).join('');
    return `<figure class="p" data-v="${v.key}" style="width:${W}px"><figcaption>${esc(v.label)}</figcaption><div style="background:${bg};border-radius:28px;padding:${v.stack ? 16 : 4}px 0 10px;overflow:hidden">${head}${inner}</div></figure>`;
  }
  const bg = v.dark ? '#141218' : '#e9e7ee';
  const top = v.headsup ? `<div style="height:0"></div>` : `<div style="display:flex;justify-content:space-between;padding:8px 22px 12px;font:500 ${13}px ${AND_FONT};color:${v.dark ? '#e6e1e5' : '#1c1b1f'}"><span>9:41</span><span>Fri, 27 Nov</span></div>`;
  const app_ui = v.headsup ? `<div style="position:absolute;inset:0;background:#f7f2fa;padding:110px 18px 0;font:14px ${AND_FONT};color:#999">${'<div style="height:14px;background:#e6e0e9;border-radius:7px;margin:0 0 14px"></div>'.repeat(14)}</div>` : '';
  const cards = v.headsup ? list.map((n, i) => `<div style="position:relative;padding-top:8px">${andCard(n, v, app, i)}</div>`).join('') : list.map((n, i) => andCard(n, v, app, i)).join('');
  return `<figure class="p" data-v="${v.key}" style="width:${W}px"><figcaption>${esc(v.label)}${v.headsup ? ' (each one as it arrives, shown together)' : ''}</figcaption><div style="background:${bg};border-radius:28px;padding:4px 0 10px;overflow:hidden;position:relative">${app_ui}<div style="position:relative">${top}${cards}</div></div></figure>`;
}

function sheetHtml(groups, app, plain) {
  const css = `body{margin:0;background:#ecebe8;font:13px -apple-system,Helvetica,Arial,sans-serif;color:#222;width:1880px}
  h1{font:600 22px -apple-system,Helvetica;margin:18px 24px 4px} h2{font:600 18px -apple-system,Helvetica;margin:22px 24px 8px}
  .row{display:flex;gap:22px;align-items:flex-start;padding:0 24px 10px;flex-wrap:wrap} figure{margin:0} figcaption{font:500 12px -apple-system,Helvetica;color:#555;height:32px;line-height:15px}
  .note{margin:2px 24px 0;color:#666;font-size:12px} table{border-collapse:collapse;margin:4px 24px 20px;background:#fff;font-size:13px} td,th{border:1px solid #ddd;padding:5px 8px;text-align:left;vertical-align:top} th{background:#f4f3f1}
  .w.cut{background:rgba(255,0,0,.25)} .w.key{text-decoration:underline 2px #e0a000}`;
  const sections = groups.map(({ lang, list }) => {
    const V = (k) => VIEWS.find((v) => v.key === k);
    const rows = [['ios-375', 'ios-430-dark', 'ios-375-large', 'ios-stack'], ['and-360', 'and-412-lock-13', 'and-412-exp', 'and-360-headsup'], ['watch-41']];
    return `<section data-lang="${esc(lang)}"><h2>${esc(langName(lang))} (${list.length} notification${list.length === 1 ? '' : 's'}, in the order given; newest at the top)</h2>
    ${rows.map((r) => `<div class="row">${r.map((k) => panel(V(k), V(k).stack ? list : [...list].reverse().map((n) => n), app)).join('')}</div>`).join('')}
    <h2 style="font-size:15px">${esc(langName(lang))}: each notification as written</h2>
    <table><tr><th>#</th><th>Title</th>${list.some((n) => n.subtitle) ? '<th>Subtitle</th>' : ''}<th>Body</th></tr>${list.map((n, i) => `<tr><td>${i + 1}</td><td>${esc(n.title)}</td>${list.some((x) => x.subtitle) ? `<td>${esc(n.subtitle)}</td>` : ''}<td>${esc(n.body)}</td></tr>`).join('')}</table></section>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>
  <h1>Push notifications for ${esc(app)}: where people see them</h1>
  <div class="note">Stand-in mock-ups of the system notification views (Palm's approximation, Nov 2026; real phones vary by model, settings and maker).${plain ? '' : ' Red = words a view cuts off; gold underline = the key phrase.'}</div>
  ${sections}</body></html>`;
}
const langName = (l) => ({ en: 'English', 'en-gb': 'English (UK)', 'en-us': 'English (US)', de: 'German', 'de-de': 'German', 'de-at': 'German (Austria)', fr: 'French', es: 'Spanish', it: 'Italian', nl: 'Dutch', pt: 'Portuguese', 'pt-br': 'Portuguese (Brazil)', ja: 'Japanese', pl: 'Polish', sv: 'Swedish' }[l] || l);

// ---------- check ----------
export async function check(target, { app = 'App', out = 'look/push', plain = false } = {}) {
  const items = load(resolve(target));
  if (!items.length) throw new Error('No notifications found (each needs a title or a body).');
  const issues = []; const add = (level, id, msg, fix, at) => issues.push({ level, id, msg, fix, ...(at ? { at } : {}) });
  for (const n of items) { n.key_given = !!n.key; if (!n.key) n.key = guessKey(n); }
  const langs = [...new Set(items.map((n) => n.lang))];
  const groups = langs.map((lang) => ({ lang, list: items.filter((n) => n.lang === lang) }));
  for (const g of groups) g.list.forEach((n, i) => { n._idx = i; });
  const html = sheetHtml(groups, app, plain);
  const browser = await launch();
  let measured;
  const sheet = resolve(out + '-sheet.png');
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1880, height: 1200, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts?.ready);
    measured = await page.evaluate((keys) => {
      const ell = (el) => { const c = document.createElement('canvas').getContext('2d'); const cs = getComputedStyle(el); c.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`; return c.measureText('…').width; };
      const res = [];
      for (const sec of document.querySelectorAll('section')) {
        const lang = sec.dataset.lang;
        for (const fig of sec.querySelectorAll('figure.p')) {
          for (const card of fig.querySelectorAll('.n')) {
            const i = +card.dataset.n; const rec = { lang, view: fig.dataset.v, i, fields: {} };
            for (const box of card.querySelectorAll('.box')) {
              const b = box.getBoundingClientRect(); const ws = [...box.querySelectorAll('.w')];
              const rects = ws.map((w) => [...w.getClientRects()]);
              const fitsV = (r) => r.bottom <= b.bottom + 1, fitsH = (r, allow) => r.right <= b.right - allow + 0.5;
              const anyHidden = rects.some((rs) => rs.some((r) => !fitsV(r) || !fitsH(r, 0)));
              const visTops = [...new Set(rects.flat().filter(fitsV).map((r) => Math.round(r.top)))].sort((a, z) => a - z);
              const lastTop = visTops[visTops.length - 1];
              const E = anyHidden ? ell(box) : 0;
              const vis = rects.map((rs) => rs.length > 0 && rs.every((r) => fitsV(r) && fitsH(r, Math.round(r.top) === lastTop ? E : 0)));
              let k = vis.indexOf(false); if (k < 0) k = ws.length;
              rec.fields[box.dataset.f] = { shown: ws.slice(0, k).map((w) => w.textContent).join(' '), cut: k < ws.length, cut_at: k < ws.length ? ws[k].textContent : null, lines: visTops.length, words: ws.length, shown_words: k };
              if (k < ws.length) ws.slice(k).forEach((w) => w.classList.add('cut'));
            }
            res.push(rec);
          }
        }
      }
      return res;
    }, VIEWS.map((v) => v.key));
    // marks: the key phrase (unless plain)
    if (plain) await page.evaluate(() => document.querySelectorAll('.w.cut').forEach((w) => w.classList.remove('cut')));
    else await page.evaluate((G) => {
      for (const sec of document.querySelectorAll('section')) {
        const list = G.find((g) => g.lang === sec.dataset.lang).list;
        for (const card of sec.querySelectorAll('.n')) {
          const kw = (list[+card.dataset.n]?.key || '').toLowerCase().split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}%€$£]/gu, '')).filter(Boolean);
          for (const w of card.querySelectorAll('.w')) if (kw.includes(w.textContent.toLowerCase().replace(/[^\p{L}\p{N}%€$£]/gu, ''))) w.classList.add('key');
        }
      }
    }, groups.map((g) => ({ lang: g.lang, list: g.list.map((n) => ({ key: n.key })) })));
    mkdirSync(dirname(sheet), { recursive: true });
    await page.screenshot({ path: sheet, fullPage: true });
    writeFileSync(resolve(out + '-sheet.html'), html);
  } finally { await browser.close(); }

  // ---------- per notification ----------
  const normW = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}%€$£]/gu, '');
  const notifications = groups.flatMap(({ lang, list }) => list.map((n, i) => {
    const where = `${n.id} (${lang})`;
    const views = {};
    for (const v of VIEWS) {
      const m = measured.filter((r) => r.lang === lang && r.view === v.key);
      const rec = m.find((r) => r.i === i);
      if (!rec) continue;
      const f = rec.fields;
      const seen = ['title', 'subtitle', 'body'].map((k) => f[k]?.shown || '').join(' ');
      const kw = n.key.split(/\s+/).map(normW).filter(Boolean);
      const seenW = new Set(seen.split(/\s+/).map(normW));
      views[v.key] = {
        title: f.title ? (f.title.cut ? `${f.title.shown}…` : 'whole') : '-', title_cut_at: f.title?.cut_at || null,
        ...(f.subtitle ? { subtitle: f.subtitle.cut ? `${f.subtitle.shown}…` : 'whole' } : {}),
        body: f.body ? (f.body.cut ? `${f.body.shown}…` : 'whole') : (v.os === 'watch' ? 'not shown' : '-'), body_cut_at: f.body?.cut_at || null, body_lines: f.body?.lines ?? 0,
        chars_seen: seen.trim().length, key_ok: kw.every((w) => seenW.has(w)),
      };
    }
    const r = { id: n.id, lang, title: n.title, subtitle: n.subtitle, body: n.body, key: n.key, key_given: n.key_given,
      chars: { title: n.title.length, body: n.body.length }, emoji: emojiCount(`${n.title} ${n.subtitle} ${n.body}`), views };
    // issues
    const glance = VIEWS.filter((v) => v.glance && v.os !== 'watch');
    const lost = glance.filter((v) => views[v.key] && !views[v.key].key_ok).map((v) => v.key);
    const lostDefault = lost.filter((k) => ['ios-375', 'and-360', 'and-360-headsup'].includes(k));
    if (lostDefault.length) add('error', 'key-cut', `${where}: the key phrase "${n.key}"${n.key_given ? '' : ' (guessed)'} is cut off in ${lostDefault.join(', ')} at default text size — people see "${shownIn(views[lostDefault[0]])}".`, 'Move the key words to the start of the title, or the first ~30 characters of the body; shorten the title.', where);
    else if (lost.length) add('warn', 'key-cut-large', `${where}: the key phrase "${n.key}"${n.key_given ? '' : ' (guessed)'} is cut off in ${lost.join(', ')} (larger text / wider fonts).`, 'Put it earlier or shorten what comes before it.', where);
    const tcut = VIEWS.filter((v) => v.os !== 'watch' && views[v.key]?.title_cut_at && !v.stack).map((v) => v.key);
    if (tcut.some((k) => ['ios-375', 'ios-430-dark', 'and-360'].includes(k))) add('warn', 'title-cut', `${where}: the title "${n.title}" is cut at default text size (${tcut.join(', ')}; first lost word "${views[tcut[0]].title_cut_at}").`, 'Shorter title: Android cuts titles to one line even when expanded and suggests ≤30 characters.', where);
    else if (tcut.length) add('warn', 'title-cut-large', `${where}: the title is cut with larger text (${tcut.join(', ')}; first lost word "${views[tcut[0]].title_cut_at}").`, 'A shorter title survives larger text sizes.', where);
    if (views['watch-41']?.title_cut_at) add('warn', 'watch-title', `${where}: Apple Watch's short look cuts the title after "${views['watch-41'].title.replace(/…$/, '')}".`, 'Apple: brief titles people can read at a glance, especially on Apple Watch.', where);
    if (n.body && views['and-360']?.body_cut_at && views['and-412-lock-13']?.body_cut_at) add('tip', 'android-body-cut', `${where}: Android's collapsed view shows only "${views['and-360'].body}" of the text.`, 'Fine if the title and the first words carry the point; the rest is for the iPhone and the expanded view.', where);
    const tw = contentWords(n.title), bw = contentWords(n.body), shared = tw.filter((w) => bw.includes(w));
    if (n.title && n.body && shared.length >= 2 && shared.length >= tw.length / 2) add('warn', 'repeat', `${where}: the body repeats the title (${shared.length} of the title's ${tw.length} words), so the second line adds little.`, 'Android: content text "avoids repeating what\'s in the content title". Make the body say the next thing.', where);
    if (r.emoji > 2) add('warn', 'emoji', `${where}: ${r.emoji} emoji; each takes the room of about two letters and reads as noise.`, 'One at most, where it carries meaning.', where);
    const caps = capsWords(`${n.title} ${n.body}`);
    if (caps.length >= 2 || (n.title.length > 6 && n.title === n.title.toUpperCase() && /\p{Lu}/u.test(n.title))) add('warn', 'caps', `${where}: words in capitals (${caps.slice(0, 4).join(', ')}) read as shouting.`, 'Apple: titles in title-style capitalization, bodies in sentence case.', where);
    if (/[.!…]$/.test(n.title.trim())) add('tip', 'title-punct', `${where}: the title ends with "${n.title.trim().slice(-1)}".`, 'Apple HIG: title-style capitalization and no ending punctuation.', where);
    if (app && app !== 'App' && new RegExp(`\\b${app.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b(?!\\s+(Pro|Plus|Premium|Gold|Max)\\b)`, 'i').test(n.title)) add('warn', 'app-name', `${where}: the title names the app, which both systems already show.`, 'Apple and Android: leave the app name out of the title.', where);
    if (n.title.length > 30 || n.body.length > 40) add('tip', 'android-length', `${where}: title ${n.title.length} characters, text ${n.body.length} (Android's guidance: title ≤30, text about 40 in the collapsed view).`, 'Shorter is seen whole in more places.', where);
    return r;
  }));
  // across the set
  for (const { lang, list } of groups) {
    const t = list.map((n) => n.title.toLowerCase()).filter(Boolean);
    if (new Set(t).size < t.length) add('warn', 'same-title', `${langName(lang)}: two notifications share a title, so they look the same in a stack.`, 'Give each its own title.');
  }
  const ids = [...new Set(items.map((n) => n.id))];
  const per = langs.map((l) => items.filter((n) => n.lang === l).length);
  if (langs.length > 1 && new Set(per).size > 1) add('warn', 'lang-count', `Languages have different numbers of notifications (${langs.map((l, i) => `${l}: ${per[i]}`).join(', ')}).`, 'Give every notification a version in each language.');
  const errors = issues.filter((i) => i.level === 'error').length, warnings = issues.filter((i) => i.level === 'warn').length;
  return { ok: errors === 0, errors, warnings, app, languages: langs, count: ids.length, notifications, issues, sheet,
    note: 'Views and thresholds are Palm\'s approximation (Nov 2026), drawn with the system fonts on this machine; Apple and Google publish no pixel layouts. Look at the sheet.' };
}
function shownIn(v) { return [v.title === 'whole' ? '(title whole)' : v.title, v.body === 'whole' ? '(text whole)' : v.body].join(' / '); }

// ---------- self-test ----------
async function selfTest() {
  const d = mkdtempSync(join(tmpdir(), 'push-check-'));
  const good = [
    { id: 'sale', lang: 'en', title: '40% off Pro to Monday', body: 'The yearly plan is £17.99 instead of £29.99.', key: '40% off' },
    { id: 'digest', lang: 'en', title: 'Your week: 5 of 7 days', body: 'Reading streak at 12 days.', key: '5 of 7' },
    { id: 'sale', lang: 'de', title: '40 % Rabatt auf Pro', body: 'Pro im Jahresabo für 17,99 € bis Montag.', key: '40 % Rabatt' },
    { id: 'digest', lang: 'de', title: 'Deine Woche: 5 von 7', body: 'Lesen: 12 Tage am Stück.', key: '5 von 7' },
  ];
  writeFileSync(join(d, 'good.json'), JSON.stringify(good));
  const g = await check(join(d, 'good.json'), { app: 'Morrow', out: join(d, 'good') });
  const gw = g.issues.filter((i) => i.level !== 'tip');
  if (gw.length) throw new Error('good: ' + JSON.stringify(gw));
  if (!existsSync(g.sheet)) throw new Error('no sheet');
  const bad = [
    { id: 'sale', lang: 'en', title: 'Morrow Black Friday Mega Sale Is Finally Here!', body: 'Don\'t miss out on our biggest sale of the year: get 40% off Morrow Pro yearly until Monday 🔥🔥🔥', key: '40% off' },
    { id: 'digest', lang: 'en', title: 'Your weekly habit summary', body: 'Here is your weekly habit summary for this week.', key: '' },
    { id: 'caps', lang: 'en', title: 'LAST CHANCE', body: 'HUGE SAVINGS today only' },
    { id: 'sale', lang: 'de', title: 'Der große Black-Friday-Sonderverkauf von Morrow ist endlich da', body: 'Verpasse nicht unseren größten Sale des Jahres: Jetzt 40 % Rabatt auf Morrow Pro im Jahresabo bis Montag sichern', key: '40 % Rabatt' },
  ];
  writeFileSync(join(d, 'bad.json'), JSON.stringify(bad));
  const b = await check(join(d, 'bad.json'), { app: 'Morrow', out: join(d, 'bad') });
  const ids = b.issues.map((i) => i.id);
  for (const want of ['key-cut', 'title-cut', 'repeat', 'emoji', 'caps', 'app-name', 'title-punct', 'watch-title', 'lang-count']) if (!ids.includes(want)) throw new Error('bad: expected ' + want + ' in ' + ids.join(','));
  if (b.ok) throw new Error('bad: a cut key phrase should be an error');
  const sale = b.notifications.find((n) => n.id === 'sale' && n.lang === 'en');
  if (!sale.views['and-360'].title_cut_at || sale.views['ios-430-dark'].body !== 'whole') throw new Error('views: ' + JSON.stringify(sale.views));
  // CSV and nested shapes
  writeFileSync(join(d, 'n.csv'), 'id,lang,title,body\nr1,en,"Time to read, Sam",10 pages today keeps the streak\nr1,de,"Zeit zum Lesen, Sam",10 Seiten heute halten die Serie\n');
  const c = load(join(d, 'n.csv')); if (c.length !== 2 || c[0].title !== 'Time to read, Sam' || c[1].lang !== 'de') throw new Error('csv: ' + JSON.stringify(c));
  writeFileSync(join(d, 'nested.json'), JSON.stringify({ app: 'X', notifications: [{ id: 'a', en: { title: 'A', body: 'b' }, de: { title: 'A2', body: 'b2' } }] }));
  const ne = load(join(d, 'nested.json')); if (ne.length !== 2 || ne[1].lang !== 'de' || ne[1].id !== 'a') throw new Error('nested: ' + JSON.stringify(ne));
  writeFileSync(join(d, 'bylang.json'), JSON.stringify({ en: [{ title: 'A', body: 'b' }], de: { a: { title: 'A2', body: 'b2' } } }));
  const bl = load(join(d, 'bylang.json')); if (bl.length !== 2 || bl[1].id !== 'a') throw new Error('bylang: ' + JSON.stringify(bl));
  if (guessKey({ title: 'Big news', subtitle: '', body: 'Get 40% off today' }) !== '40% off') throw new Error('guessKey: ' + guessKey({ title: 'Big news', subtitle: '', body: 'Get 40% off today' }));
  console.log(`push-check: all tests pass (good: no warnings; bad: ${[...new Set(ids)].join(', ')}; sheets in ${d})`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (k, dflt) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : dflt; };
  const VALUED = new Set(['--out', '--app']);
  const pos = argv.filter((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1]));
  const done = (r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); };
  const fail = (e) => { console.error(String(e.message || e)); process.exit(2); };
  if (argv.includes('--self-test') || argv.includes('--test')) selfTest().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
  else if (pos[0] === 'check' && pos[1]) check(pos[1], { app: opt('app', 'App'), out: opt('out', 'look/push'), plain: argv.includes('--plain') }).then(done, fail);
  else fail('usage: push-check.mjs check <notifications.json | .csv | folder> [--app "App name"] [--out look/push] [--plain]\n       push-check.mjs --self-test');
}
