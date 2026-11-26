#!/usr/bin/env node
// Palm tool: episode-check — lets an agent see a month of podcast episode titles, descriptions and chapter titles where
// listeners choose what to play, and measures what each view cuts. An episode is chosen from a list: a show page or
// search result on a phone (two lines of title, a line or two of description, less with larger text), one line in a
// search result, on the Now Playing screen, the lock screen, CarPlay and the watch, and a chapter's name squeezed beside
// the time on a scrubber.
//
//   node episode-check.mjs check <episodes.json | .csv | folder> [--show "Show name"] [--out look/episodes] [--plain]
//       [--rss feed-items.xml]
//       → JSON {ok, errors, warnings, episodes:[…per view: title shown, cut_at, key_ok…], set:{similar…}, issues, sheet}.
//       Then LOOK at <out>-sheet.png. --rss also writes RSS <item> snippets (title, itunes:title, itunes:episode,
//       itunes:season, description) and a Podcasting 2.0 chapters JSON per episode beside it.
//       Input: a JSON array of {episode?, season?, date?, title, description, chapters?, guest?, key?} (or
//       {show, episodes:[…]}), or a CSV with those columns (chapters as "00:00 Intro; 05:10 …"). Chapters: an array of
//       {start, title} ("mm:ss", "hh:mm:ss" or seconds) or of "(00:00) Title" lines. `key` is what must be seen at a
//       glance (the topic, the guest's name; "a|b" = either); without it Palm guesses one (the title's first two
//       content words after any number or show name) and labels it "guessed".
//   node episode-check.mjs --self-test
//
// Facts (read 2026-11-26):
//   Apple "A Podcaster's Guide to RSS" (help.apple.com/itc/podcasts_connect/en.lproj/itcb54353390.html): episode <title>
//     and <itunes:title> are "a clear concise name for your episode"; "Don't specify the episode number or season
//     number in this tag. Instead, specify those details in the appropriate tags (<itunes:episode>, <itunes:season>).
//     Also, don't repeat the title of your show within your episode title." Episode <description> up to 10,000
//     characters, some HTML (<p>, <ol>, <ul>, <li>, <a>) inside CDATA. <podcast:chapters>: "We recommend that titles
//     should not exceed 45 characters in length." Other tag values are limited to 255 characters.
//   Apple Podcasts for Creators "Marketing and Promotion" (podcasters.apple.com/support/867-featured-present-your-podcast):
//     "The title of your episode is your first chance to convince potential listeners to press play. Don't worry about
//     including your show's name and upload date in your title… episode numbers should be added through the appropriate
//     tags in your RSS feed. Lead with your most eye-catching, important information…"; "every episode's title should be
//     unique, stick to a consistent layout".
//   Spotify for Creators "Episode chapters" (support.spotify.com/us/creators/article/creating-and-managing-chapters/):
//     chapters in the description as "(00:00) Intro", one per line, the first at 00:00, at least 3, in order, at least
//     30 seconds apart, plain text without emoji or HTML; "Aim for chapter titles under 40 characters"; indexes such as
//     "1 - Introduction" are removed.
//   Spotify for Creators "How to write episode descriptions" (creators.spotify.com/resources/podcast-episode-descriptions,
//     Feb 2022): three sentences max; don't repeat the title; avoid generic filler ("In this episode…"), "This gives you
//     room to make those first 90 characters really count"; don't open with "This episode is sponsored by…".
//   Spotify for Creators "Podcast SEO" (creators.spotify.com/resources/podcast-seo): for show and episode descriptions,
//     "The first 250 characters are what's visible before a listener has to expand"; long titles "get truncated in search
//     results and on mobile screens".
//   YouTube Help "Podcast discovery tips" (support.google.com/youtube/answer/12950577): a podcast is a playlist of
//     full-length episodes; "each video is titled with the episode name and, optionally, the show name".
//   YouTube Help "Video Chapters" (support.google.com/youtube/answer/9884579): timestamps and titles in the description,
//     the first at 00:00, at least three in ascending order, each at least 10 seconds.
// Palm's approximation of the apps (Nov 2026; no app publishes its layout as numbers, and these are stand-ins, not the
//   apps' own designs): a show-page list like Apple Podcasts' on an iPhone (375 pt light, 430 pt dark: title up to 2 lines
//   at 17 pt semibold, description 2–3 lines at 15 pt; larger text ×1.3); a list like Spotify's (360 pt dark, 56 pt art,
//   title 2 lines, description 2 lines) and its search result (title 1 line); a list like Pocket Casts'/Overcast's
//   (390 pt, title 2 lines, description 2 lines); a YouTube playlist row (360 px, 120 px thumbnail, title 2 lines); a
//   desktop list (Apple Podcasts/Spotify on a Mac, 760 px column, title 1 line, description 2 lines); Now Playing (375 pt,
//   the title on 1 line before it starts to scroll), the Lock Screen's media controls (title 1 line), a CarPlay-like list
//   (800×480, title 1 line), the watch (41 mm: list title 3 lines; Now Playing 1 line); the chapter name on a Now Playing
//   scrubber (375 pt, 1 line) and on a YouTube-style player beside "12:04 / 48:30" (360 px, 1 line). Fonts: the system
//   stack (-apple-system; Roboto/Arial for YouTube); SF Pro, Circular and Roboto aren't bundled, so cut points are exact
//   for these mock-ups and a few characters out on real phones.
// Palm's thresholds (guidance, not a platform rule): the key phrase whole in the default-size lists, search result and
//   CarPlay; a "lead" = an episode/season number, the show's name, "with <guest>" or a label ("Interview:", "Part 1")
//   before the topic; a description preview that opens with "In this episode", a welcome, a sponsor, a link or the show
//   name = boilerplate; titles "too alike" = half or more of their content words shared, or the same first two content
//   words (distinguishability = share of titles whose first two content words no other title starts with).
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
const pick = (o, ks) => { for (const k of ks) for (const kk of Object.keys(o)) if (kk.toLowerCase().replace(/[\s-]/g, '_') === k && o[kk] != null && typeof o[kk] !== 'object') return String(o[kk]); return ''; };
const pickAny = (o, ks) => { for (const k of ks) for (const kk of Object.keys(o)) if (kk.toLowerCase().replace(/[\s-]/g, '_') === k && o[kk] != null) return o[kk]; return null; };
export function toSecs(t) {
  if (typeof t === 'number') return t;
  const s = String(t || '').trim().replace(/^\(|\)$/g, '');
  if (/^\d+(\.\d+)?$/.test(s)) return +s;
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/);
  if (!m) return NaN;
  return m[3] != null ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2];
}
const TS_LINE = /^\s*\(?\s*((?:\d{1,2}:)?\d{1,2}:\d{2})\s*\)?\s*[-–—:|.]?\s*(.+?)\s*$/;
export function parseChapters(x) {
  if (x == null || x === '') return [];
  let arr = x;
  if (typeof x === 'string') arr = x.split(/\n|;|\s\|\s/).map((l) => l.trim()).filter(Boolean);
  if (x && typeof x === 'object' && !Array.isArray(x)) arr = Array.isArray(x.chapters) ? x.chapters : Object.entries(x).map(([start, title]) => ({ start, title }));
  return (Array.isArray(arr) ? arr : []).map((c) => {
    if (typeof c === 'string') { const m = c.match(TS_LINE); return m ? { start: m[1], secs: toSecs(m[1]), title: m[2] } : { start: '', secs: NaN, title: c }; }
    const st = pickAny(c, ['start', 'time', 'timestamp', 'starttime', 'start_time', 'at', 'ts']);
    return { start: st == null ? '' : String(st), secs: toSecs(st), title: pick(c, ['title', 'name', 'label', 'chapter']) };
  }).filter((c) => c.title);
}
// Chapters written inside the description as "(00:00) Intro" lines (Spotify/YouTube style).
export function chaptersFromText(s) {
  const lines = String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|div)>/gi, '\n').replace(/<[^>]+>/g, '').split('\n');
  const out = lines.map((l) => l.match(TS_LINE)).filter(Boolean).map((m) => ({ start: m[1], secs: toSecs(m[1]), title: m[2] }));
  return out.length >= 2 ? out : [];
}
function norm(o, i) {
  const desc = pickAny(o, ['description', 'show_notes', 'shownotes', 'notes', 'summary', 'desc', 'content', 'body']);
  const d = Array.isArray(desc) ? desc.join('\n') : desc && typeof desc === 'object' ? Object.values(desc).join('\n') : String(desc ?? '');
  const chRaw = pickAny(o, ['chapters', 'chapter_titles', 'timestamps', 'chapter_list']);
  const num = (k) => { const v = pick(o, k); const m = v.match(/\d+/); return m ? +m[0] : null; };
  const ch = parseChapters(chRaw);
  return {
    i, episode: num(['episode', 'episode_number', 'number', 'itunes_episode', 'ep', 'episode_no']), season: num(['season', 'season_number', 'itunes_season']),
    date: pick(o, ['date', 'pubdate', 'pub_date', 'release_date', 'published', 'air_date']), duration: pick(o, ['duration', 'length', 'runtime', 'itunes_duration', 'minutes']),
    title: pick(o, ['itunes_title', 'title', 'episode_title', 'name', 'headline']).trim(),
    description: d.trim(), guest: pick(o, ['guest', 'guests', 'guest_name']), key: pick(o, ['key', 'key_phrase', 'keyphrase', 'keyword']),
    chapters: ch.length ? ch : chaptersFromText(d), chapters_in: ch.length ? 'field' : 'description',
  };
}
function flatten(x) {
  if (Array.isArray(x)) return x.filter((o) => o && typeof o === 'object').map((o, i) => norm(o, i));
  if (x && typeof x === 'object') {
    for (const k of ['episodes', 'items', 'shows', 'list', 'data']) if (Array.isArray(x[k])) return flatten(x[k]);
    const vals = Object.entries(x).filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v));
    if (vals.length && vals.every(([, v]) => pick(v, ['title', 'itunes_title']))) return flatten(vals.map(([k, v]) => ({ episode: k, ...v })));
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
    if (!files.length) throw new Error(`No .json or .csv file of episodes in ${target}.`);
  }
  const out = []; let show = '';
  for (const f of files) {
    const txt = readFileSync(f, 'utf8');
    let items = [];
    if (/\.csv$/i.test(f)) items = flatten(parseCsv(txt));
    else { let j; try { j = JSON.parse(txt); } catch (e) { throw new Error(`${basename(f)} isn't valid JSON: ${e.message}`); } if (j && !Array.isArray(j) && typeof j.show === 'string') show = j.show; else if (j?.show?.title) show = j.show.title; items = flatten(j); }
    out.push(...items.filter((n) => n.title || n.description));
  }
  out.forEach((n, i) => (n.i = i));
  out.show = show;
  return out;
}

// ---------- text helpers ----------
const STOP = new Set(('a an the and or but of to in on at for with from by your you you\'re youre our we it its this that these those is are was were be been has have had do does did not no yes can will just now new get got all any more most so up out as into than then there here what when how who why which why vs versus about ' +
  'episode ep part special bonus interview chat talk talks').split(/\s+/));
const words = (s) => (s.toLowerCase().match(/[\p{L}\p{N}']+/gu) || []).map((w) => w.replace(/'s$/, '').replace(/'/g, ''));
const stem = (w) => w.replace(/(ing|ers|es|s)$/, '').slice(0, 6);
export function contentWords(s) { return [...new Set(words(s).filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)).map(stem))]; }
export const plain = (s) => String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|div|h\d)>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/[ \t]+/g, ' ').trim();
// What a list shows of a description: its text from the start, lines joined (apps collapse line breaks in previews).
export const preview = (s) => plain(s).replace(/\s*\n+\s*/g, ' ').trim();
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The part of a title before the topic that a listener has to read past.
export function leadOf(title, show = '', ep = null) {
  let t = title, parts = [];
  const take = (re, kind) => { const m = t.match(re); if (m && m[0].trim()) { parts.push({ kind, text: m[0].trim() }); t = t.slice(m[0].length); return true; } return false; };
  for (let k = 0; k < 4; k++) {
    if (take(/^\s*(?:(?:episode|ep|eps|no)\.?\s*#?\s*\d+|#\s?\d+|s\s?\d+\s*[:.,]?\s*e(?:p)?\s?\d+|season\s*\d+\s*[,:]?\s*(?:episode|ep)\.?\s*\d+|\d{1,4}(?=\s*[:.|–—-]\s))\s*[:|–—\-.,]?\s*/i, 'number')) continue;
    if (show && take(new RegExp(`^\\s*(?:the\\s+)?${reEsc(show.replace(/^the\s+/i, ''))}(?:\\s+podcast)?\\s*[:|–—\\-.,]?\\s*`, 'i'), 'show')) continue;
    if (take(/^\s*(?:with|w\/|feat\.?|featuring|ft\.)\s+[\p{Lu}][\p{L}'’-]+(?:\s+[\p{Lu}][\p{L}'’-]+){0,2}\s*[:|–—\-,]\s*/u, 'guest')) continue;
    if (take(/^\s*(?:interview|bonus|special|part\s*\d+|pt\.?\s*\d+|q\s?&\s?a|replay|rerun|encore|trailer|minisode|solo|re-?release)\s*[:|–—\-]\s*/i, 'label')) continue;
    break;
  }
  const words = parts.reduce((s, p) => s + p.text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length, 0);
  return { parts, rest: t.trim(), words, chars: title.length - t.length };
}
export function hasNumber(title, ep, season) {
  const res = [/\b(?:episode|ep|eps|no)\.?\s*#?\s*\d+/i, /(?:^|\s)#\s?\d+\b/, /\bs\s?\d+\s*[:.,]?\s*e(?:p)?\s?\d+\b/i, /\bseason\s*\d+/i];
  if (res.some((r) => r.test(title))) return true;
  if (ep != null && new RegExp(`^\\s*${ep}\\s*[:.|–—-]`).test(title)) return true;
  return false;
}
const BOILER = [
  [/^(?:in|on)\s+(?:this|today'?s|this\s+week'?s|the\s+latest|our\s+latest)\s+(?:episode|ep|show|instal+ment)\b/i, 'opens with "In this episode"'],
  [/^(?:this|today'?s)\s+(?:week|episode|ep)\b/i, 'opens with "This episode/week"'],
  [/^(?:today|this\s+week),?\s+(?:on|we|i|hannah|our)\b/i, 'opens with "Today on/we"'],
  [/^(?:hello\s+and\s+)?welcome\s+(?:back\s+)?(?:to|everyone)\b|^(?:hi|hey|hello)\s+(?:everyone|all|there|friends|folks)\b/i, 'opens with a welcome'],
  [/^(?:this\s+episode\s+is\s+)?(?:sponsored|brought\s+to\s+you|supported|presented)\s+by\b|^(?:thanks?\s+to\s+(?:our\s+)?sponsors?|our\s+sponsor)\b|^sponsor\b/i, 'opens with the sponsor'],
  [/^(?:episode|ep)\.?\s*#?\s*\d+|^#\d+|^s\d+\s*e\d+/i, 'opens with the episode number'],
  [/^(?:https?:\/\/|www\.|[\w-]+\.(?:com|co\.uk|org|net|fm|io)\b|@\w)/i, 'opens with a link'],
  [/^(?:listen|subscribe|follow|support\s+(?:us|the\s+show)|join\s+(?:us|our)|get\s+\d+%)/i, 'opens with a call to action'],
];
export function boilerplate(desc, show = '', title = '') {
  const p = preview(desc);
  for (const [re, why] of BOILER) if (re.test(p)) return why;
  if (show && new RegExp(`^(?:the\\s+)?${reEsc(show.replace(/^the\s+/i, ''))}\\b`, 'i').test(p)) return 'opens with the show name';
  if (title && p.toLowerCase().startsWith(title.toLowerCase().slice(0, Math.max(12, Math.min(40, title.length))))) return 'opens by repeating the title';
  return '';
}
export const emojiCount = (s) => (s.match(/\p{Extended_Pictographic}/gu) || []).length;
export function capsWords(s) { return (s.match(/\b\p{Lu}{3,}\b/gu) || []).filter((w) => !/^(BBC|NHS|USA|UK|EU|DIY|FAQ|AI|NASA|UFO|RHS|TV|PDF|CEO|NBA|NFL|FBI|CIA|LGBTQ|ADHD)$/.test(w)); }
export function guessKey(n, show) {
  const rest = leadOf(n.title, show, n.episode).rest || n.title;
  const t = rest.split(/\s+/).filter((w) => !STOP.has(w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')) && /[\p{L}\p{N}]/u.test(w));
  return t.slice(0, 2).join(' ').replace(/[.,:;!?…'"“”‘’()]+/g, '');
}
const normW = (w) => w.toLowerCase().replace(/’/g, "'").replace(/'s$/, '').replace(/[^\p{L}\p{N}%€$£]/gu, '');
// key "a b|c" → any alternative whose words are all seen (words compared loosely: "sprouts" matches "sprout").
export function keySeen(key, shownText) {
  const seen = new Set(shownText.split(/\s+/).map(normW).filter(Boolean).map(stem));
  return key.split('|').map((alt) => alt.split(/\s+/).map(normW).filter(Boolean).map(stem)).filter((a) => a.length).some((a) => a.every((w) => seen.has(w)));
}
const fmtT = (s) => !isFinite(s) ? '?' : s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

// ---------- the views (Palm's approximation, Nov 2026) ----------
export const VIEWS = [
  { key: 'apple-375', app: 'apple', label: 'Like Apple Podcasts: show page, iPhone 375 pt, light', w: 375, scale: 1, dark: false, titleLines: 2, descLines: 2, def: true },
  { key: 'apple-375-large', app: 'apple', label: 'Like Apple Podcasts: show page, 375 pt, larger text (×1.3), dark', w: 375, scale: 1.3, dark: true, titleLines: 2, descLines: 2, large: true },
  { key: 'apple-430-dark', app: 'apple', label: 'Like Apple Podcasts: show page, iPhone 430 pt (Max), dark', w: 430, scale: 1, dark: true, titleLines: 2, descLines: 3, def: true },
  { key: 'spotify-360', app: 'spotify', label: 'Like Spotify: show page, phone 360 pt, dark', w: 360, scale: 1, dark: true, titleLines: 2, descLines: 2, def: true },
  { key: 'spotify-search-360', app: 'search', label: 'Like Spotify: search results, phone 360 pt, dark (title on one line)', w: 360, scale: 1, dark: true, titleLines: 1, descLines: 0, def: true, oneLine: true },
  { key: 'pocket-390', app: 'pocket', label: 'Like Pocket Casts / Overcast: episode list, phone 390 pt, light', w: 390, scale: 1, dark: false, titleLines: 2, descLines: 2, def: true },
  { key: 'youtube-360', app: 'youtube', label: 'Like YouTube: the podcast playlist, phone 360 px, light', w: 360, scale: 1, dark: false, titleLines: 2, descLines: 0, def: true },
  { key: 'watch-list', app: 'watch', label: 'Watch 41 mm: episode list', w: 176, scale: 1, dark: true, titleLines: 3, descLines: 0 },
  { key: 'nowplaying-375', app: 'np', label: 'Now Playing, iPhone 375 pt (the title on one line before it scrolls), one per episode', w: 375, scale: 1, dark: true, titleLines: 1, descLines: 0, oneLine: true },
  { key: 'lock-375', app: 'lock', label: 'Lock Screen media controls, iPhone 375 pt, one per episode', w: 375, scale: 1, dark: true, titleLines: 1, descLines: 0, oneLine: true },
  { key: 'carplay-800', app: 'carplay', label: 'Like CarPlay: the show\'s episodes, 800 × 480 screen (one line each)', w: 800, scale: 1, dark: true, titleLines: 1, descLines: 0, def: true, oneLine: true },
  { key: 'watch-np', app: 'watchnp', label: 'Watch 41 mm: Now Playing (one line)', w: 176, scale: 1, dark: true, titleLines: 1, descLines: 0, oneLine: true },
  { key: 'desktop-1280', app: 'desktop', label: 'Desktop app (Mac/PC window 1280 px): episode list, dark', w: 1000, scale: 1, dark: true, titleLines: 1, descLines: 2, def: true, oneLine: true },
];
const KEY_ERR = ['apple-375', 'spotify-360', 'spotify-search-360', 'carplay-800'];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const spans = (s, field) => String(s).split(/(\s+)/).map((t) => /^\s+$/.test(t) || !t ? esc(t) : `<span class="w" data-f="${field}">${esc(t)}</span>`).join('');
const SYS = "-apple-system, 'SF Pro Text', system-ui, 'Helvetica Neue', Arial, sans-serif";
const YT = "Roboto, Arial, sans-serif";
const ART = (n, size, r = 8) => `<div style="width:${size}px;height:${size}px;border-radius:${r}px;flex:none;background:linear-gradient(135deg,#5b7f3a,#2f4d2a);color:#f3ead2;font:700 ${Math.round(size * 0.28)}px/${size}px ${SYS};text-align:center;letter-spacing:-.02em">SP</div>`;
const clampCss = (lines) => lines === 1 ? 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis' : `display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:${lines};overflow:hidden;overflow-wrap:break-word`;
const box = (field, text, lines, style) => `<div class="box" data-f="${field}" style="${style};${clampCss(lines)}">${spans(text, field)}</div>`;
const dateLabel = (n) => { const d = n.date ? new Date(n.date) : null; return d && !isNaN(d) ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).toUpperCase() : ''; };
// The running time, only when given (a number of minutes, "51 min" or hh:mm:ss); else none is drawn.
const durMin = (n) => { const d = String(n.duration || '').trim(); if (!d) return null; if (/:/.test(d)) { const x = toSecs(d); return isFinite(x) ? Math.round(x / 60) : null; } const m = d.match(/\d+/); return m ? +m[0] : null; };
const durLabel = (n) => { const m = durMin(n); return m ? `${m} min` : ''; };
const durClock = (n) => { const m = durMin(n); return m ? `${m}:00` : ''; };

function row(n, v, show) {
  const s = v.scale, d = v.dark;
  const fg = d ? '#f2f2f7' : '#111', mute = d ? 'rgba(235,235,245,.6)' : 'rgba(60,60,67,.62)', line = d ? 'rgba(255,255,255,.12)' : 'rgba(0,0,0,.1)';
  const desc = preview(n.description);
  const T = n.title || '(no title)';
  const at = `class="n" data-n="${n.i}"`;
  if (v.app === 'apple') return `<div ${at} style="padding:${12 * s}px 20px;border-bottom:1px solid ${line};font-family:${SYS};color:${fg}">
    <div style="font:600 ${12 * s}px/${16 * s}px ${SYS};color:${mute};letter-spacing:.02em">${esc(dateLabel(n))}</div>
    ${box('title', T, v.titleLines, `font-weight:600;font-size:${17 * s}px;line-height:${22 * s}px;margin:${2 * s}px 0`)}
    ${desc ? box('desc', desc, v.descLines, `font-size:${15 * s}px;line-height:${20 * s}px;color:${mute}`) : ''}
    <div style="margin-top:${8 * s}px;display:flex;gap:10px;align-items:center;font:600 ${13 * s}px ${SYS};color:#a35cf0"><span style="display:inline-block;width:${26 * s}px;height:${26 * s}px;border-radius:50%;background:${d ? '#2c2c2e' : '#eee'};text-align:center;line-height:${26 * s}px">▶</span>${esc(durLabel(n))}</div></div>`;
  if (v.app === 'spotify') return `<div ${at} style="padding:12px 16px;border-bottom:1px solid ${line};font-family:${SYS};color:#fff">
    <div style="display:flex;gap:12px;align-items:flex-start">${ART(n, 56, 6)}<div style="flex:1;min-width:0">${box('title', T, v.titleLines, 'font-weight:700;font-size:16px;line-height:21px')}<div style="font-size:13px;color:#b3b3b3;margin-top:2px">${esc(show || 'Show')}</div></div></div>
    ${desc ? box('desc', desc, v.descLines, 'font-size:14px;line-height:19px;color:#b3b3b3;margin-top:8px') : ''}
    <div style="font-size:13px;color:#b3b3b3;margin-top:8px">${esc([dateLabel(n).toLowerCase().replace(/^\w|\s\w/g, (c) => c.toUpperCase()), durLabel(n)].filter(Boolean).join(' · '))}</div></div>`;
  if (v.app === 'search') return `<div ${at} style="padding:8px 16px;display:flex;gap:12px;align-items:center;font-family:${SYS};color:#fff">${ART(n, 48, 4)}<div style="flex:1;min-width:0">${box('title', T, 1, 'font-weight:500;font-size:16px;line-height:21px')}<div style="font-size:13px;color:#b3b3b3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Episode · ${esc(show || 'Show')}</div></div></div>`;
  if (v.app === 'pocket') return `<div ${at} style="padding:12px 16px;border-bottom:1px solid ${line};display:flex;gap:12px;align-items:flex-start;font-family:${SYS};color:${fg}">${ART(n, 56, 6)}<div style="flex:1;min-width:0">
    <div style="font:500 12px/16px ${SYS};color:${mute}">${esc(dateLabel(n))}</div>${box('title', T, v.titleLines, 'font-weight:600;font-size:16px;line-height:21px')}
    ${desc ? box('desc', desc, v.descLines, `font-size:13px;line-height:18px;color:${mute};margin-top:2px`) : ''}<div style="font:500 12px ${SYS};color:${mute};margin-top:4px">${esc(durLabel(n))}</div></div></div>`;
  if (v.app === 'youtube') return `<div ${at} style="padding:8px 12px;display:flex;gap:10px;align-items:flex-start;font-family:${YT};color:#0f0f0f"><div style="width:120px;height:68px;border-radius:8px;flex:none;background:linear-gradient(135deg,#5b7f3a,#2f4d2a);position:relative;color:#f3ead2;font:700 20px/68px ${SYS};text-align:center">SP${durClock(n) ? `<span style="position:absolute;right:4px;bottom:4px;background:rgba(0,0,0,.8);color:#fff;font:500 11px/14px ${YT};padding:0 3px;border-radius:3px">${esc(durClock(n))}</span>` : ''}</div><div style="flex:1;min-width:0">${box('title', T, 2, 'font-weight:500;font-size:14px;line-height:20px')}<div style="font-size:12px;color:#606060;margin-top:2px">${esc(show || 'Channel')}</div></div><div style="color:#606060;font-size:16px">⋮</div></div>`;
  if (v.app === 'watch') return `<div ${at} style="margin:0 6px 6px;background:#222;border-radius:14px;padding:8px 10px;font-family:${SYS};color:#fff"><div style="font:500 12px/15px ${SYS};color:#a35cf0">${esc(dateLabel(n))}</div>${box('title', T, 3, 'font-weight:600;font-size:15px;line-height:19px')}</div>`;
  if (v.app === 'carplay') return `<div ${at} style="padding:10px 18px;border-bottom:1px solid rgba(255,255,255,.12);display:flex;gap:14px;align-items:center;font-family:${SYS};color:#fff">${ART(n, 44, 6)}<div style="flex:1;min-width:0">${box('title', T, 1, 'font-weight:500;font-size:19px;line-height:24px')}<div style="font-size:14px;color:rgba(235,235,245,.6)">${esc([dateLabel(n), durLabel(n)].filter(Boolean).join(' · '))}</div></div></div>`;
  if (v.app === 'desktop') return `<div ${at} style="padding:14px 24px;border-bottom:1px solid ${line};display:flex;gap:16px;align-items:flex-start;font-family:${SYS};color:${fg}">${ART(n, 64, 6)}<div style="flex:1;min-width:0"><div style="font:600 11px/15px ${SYS};color:${mute}">${esc(dateLabel(n))}</div>${box('title', T, 1, 'font-weight:600;font-size:16px;line-height:22px')}${desc ? box('desc', desc, 2, `font-size:14px;line-height:19px;color:${mute};margin-top:2px`) : ''}</div><div style="flex:none;width:120px;text-align:right;font:500 13px ${SYS};color:${mute}">${esc(durLabel(n))}</div></div>`;
  if (v.app === 'np') return `<div ${at} style="margin:0 0 10px;padding:14px 24px 16px;background:linear-gradient(180deg,#3b4a2d,#1d2417);border-radius:22px;font-family:${SYS};color:#fff"><div style="display:flex;gap:14px;align-items:center">${ART(n, 64, 8)}<div style="flex:1;min-width:0">${box('title', T, 1, 'font-weight:600;font-size:17px;line-height:22px')}<div style="font-size:17px;line-height:22px;color:rgba(255,255,255,.6);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(show || 'Show')}</div></div><div style="font-size:20px;color:rgba(255,255,255,.7)">⋯</div></div>
    <div style="height:6px;border-radius:3px;background:rgba(255,255,255,.25);margin-top:14px"><div style="width:30%;height:6px;border-radius:3px;background:rgba(255,255,255,.85)"></div></div></div>`;
  if (v.app === 'lock') return `<div ${at} style="margin:0 8px 10px;padding:14px;background:rgba(40,40,40,.72);border-radius:22px;font-family:${SYS};color:#fff"><div style="display:flex;gap:12px;align-items:center">${ART(n, 48, 8)}<div style="flex:1;min-width:0">${box('title', T, 1, 'font-weight:600;font-size:15px;line-height:20px')}<div style="font-size:15px;line-height:20px;color:rgba(255,255,255,.6);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(show || 'Show')}</div></div><div style="flex:none;font-size:13px;color:rgba(255,255,255,.7)">◉))</div></div>
    <div style="display:flex;justify-content:center;gap:42px;font-size:22px;margin-top:10px">⏮ ⏸ ⏭</div></div>`;
  if (v.app === 'watchnp') return `<div ${at} style="width:176px;height:200px;flex:none;background:#000;border-radius:34px;padding:22px 12px 0;box-sizing:border-box;font-family:${SYS};color:#fff;text-align:center"><div style="font-size:13px;color:#a35cf0;margin-bottom:6px">Podcasts</div>${box('title', T, 1, 'font-weight:600;font-size:16px;line-height:20px')}<div style="font-size:14px;color:rgba(255,255,255,.6);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(show || 'Show')}</div><div style="font-size:28px;margin-top:22px">⏪ ⏸ ⏩</div></div>`;
  return '';
}
function panel(v, list, show) {
  const bg = { apple: v.dark ? '#000' : '#fff', spotify: '#121212', search: '#121212', pocket: '#fff', youtube: '#fff', watch: '#000', carplay: '#111', desktop: '#1e1e1e', np: '#0b0f09', lock: 'linear-gradient(160deg,#2b3d4f,#4a3046 60%,#15171c)', watchnp: 'transparent' }[v.app];
  let head = '';
  if (v.app === 'apple') head = `<div style="padding:14px 20px 6px;font:700 ${22 * v.scale}px ${SYS};color:${v.dark ? '#fff' : '#111'}">Episodes</div>`;
  if (v.app === 'spotify') head = `<div style="padding:14px 16px 4px;font:700 20px ${SYS};color:#fff">All episodes</div>`;
  if (v.app === 'search') head = `<div style="padding:12px 16px"><div style="background:#fff;border-radius:6px;padding:9px 12px;font:500 15px ${SYS};color:#121212">${esc((show || 'podcast').toLowerCase())}</div><div style="display:flex;gap:8px;margin-top:10px">${['Top', 'Podcasts & Shows', 'Episodes'].map((t, i) => `<span style="font:500 13px ${SYS};padding:6px 12px;border-radius:16px;background:${i === 2 ? '#1ed760' : '#2a2a2a'};color:${i === 2 ? '#000' : '#fff'}">${t}</span>`).join('')}</div></div>`;
  if (v.app === 'carplay') head = `<div style="display:flex;align-items:center;padding:10px 18px;font:600 20px ${SYS};color:#fff;border-bottom:1px solid rgba(255,255,255,.12)"><span style="color:#0a84ff;font-size:18px;margin-right:14px">‹ Shows</span>${esc(show || 'Show')}</div>`;
  if (v.app === 'desktop') head = `<div style="padding:16px 24px 8px;font:700 22px ${SYS};color:#fff">Episodes</div>`;
  if (v.app === 'youtube') head = `<div style="padding:12px;font:700 18px ${YT};color:#0f0f0f">${esc(show || 'Podcast')}<div style="font:400 12px ${YT};color:#606060">Podcast · ${list.length} episodes</div></div>`;
  if (v.app === 'pocket') head = `<div style="padding:14px 16px 6px;font:700 20px ${SYS};color:#111">${esc(show || 'Show')}</div>`;
  if (v.app === 'lock') head = `<div style="text-align:center;color:#fff;font:600 13px ${SYS};padding:10px 0 0;opacity:.9">Thursday 31 December</div><div style="text-align:center;color:#fff;font:700 60px/1 ${SYS};padding:0 0 12px">7:42</div>`;
  let inner = list.map((n) => row(n, v, show)).join('');
  if (v.app === 'carplay') inner = `<div style="display:flex"><div style="width:70px;flex:none;background:#1c1c1e;display:flex;flex-direction:column;align-items:center;gap:22px;padding-top:20px;color:#fff;font-size:22px">◉<br>♫<br>⌂</div><div style="flex:1;min-width:0">${head}${inner}</div></div>`;
  const wrapW = v.app === 'watchnp' ? Math.min(list.length, 6) * 188 : v.w;
  const inside = v.app === 'watchnp' ? `<div style="display:flex;flex-wrap:wrap;gap:12px">${inner}</div>` : `<div style="background:${bg};border-radius:${v.app === 'carplay' ? 14 : v.app === 'watch' ? 34 : 24}px;padding:${v.app === 'watch' ? '14px 0 8px' : v.app === 'np' || v.app === 'lock' ? '10px' : '0 0 8px'};overflow:hidden">${v.app === 'carplay' ? '' : head}${inner}</div>`;
  return `<figure class="p" data-v="${v.key}" style="width:${wrapW}px"><figcaption>${esc(v.label)}</figcaption>${inside}</figure>`;
}
// Chapters: the name beside the scrubber on Now Playing (375 pt) and beside the time on a YouTube-style player (360 px).
function chapterPanels(list) {
  const ios = list.map((n) => `<div style="margin:0 0 8px;padding:8px 12px;background:#1d2417;border-radius:14px"><div style="font:600 12px ${SYS};color:rgba(255,255,255,.55);margin-bottom:4px">${esc(n.episode != null ? `Episode ${n.episode}` : `#${n.i + 1}`)}: ${n.chapters.length} chapters</div>${n.chapters.map((c, k) => `<div class="n ch" data-n="${n.i}" data-c="${k}" style="display:flex;gap:10px;align-items:baseline;margin:2px 0"><span style="flex:none;width:52px;font:500 12px ${SYS};color:rgba(255,255,255,.5);text-align:right">${esc(fmtT(c.secs))}</span><div style="width:327px;flex:none">${box('chap', c.title, 1, `font-weight:600;font-size:15px;line-height:20px;color:#fff`)}</div></div>`).join('') || `<div style="font:13px ${SYS};color:rgba(255,255,255,.5)">(no chapters)</div>`}</div>`).join('');
  const yt = list.map((n) => `<div style="margin:0 0 8px;padding:8px 12px;background:#0f0f0f;border-radius:14px"><div style="font:500 12px ${YT};color:#aaa;margin-bottom:4px">${esc(n.episode != null ? `Episode ${n.episode}` : `#${n.i + 1}`)}</div>${n.chapters.map((c, k) => `<div class="n ch" data-n="${n.i}" data-c="${k}" style="width:336px;display:flex;gap:6px;align-items:center;margin:3px 0;font:400 12px/18px ${YT};color:#fff"><span style="flex:none">▶ ⏭ 🔊 ${esc(fmtT(c.secs))}${durClock(n) ? ` / ${esc(durClock(n))}` : ''} ·</span><div style="flex:1;min-width:0">${box('chap', c.title, 1, 'font-size:12px;line-height:18px')}</div><span style="flex:none">›</span></div>`).join('') || `<div style="font:12px ${YT};color:#aaa">(no chapters)</div>`}</div>`).join('');
  return `<figure class="p" data-v="chap-ios-375" style="width:420px"><figcaption>Chapter names on a Now Playing scrubber, iPhone 375 pt (one line)</figcaption><div style="background:#0b0f09;border-radius:20px;padding:10px">${ios}</div></figure>
  <figure class="p" data-v="chap-yt-360" style="width:380px"><figcaption>Chapter names on a YouTube-style player, phone 360 px (beside the time)</figcaption><div style="background:#000;border-radius:20px;padding:10px">${yt}</div></figure>`;
}

function sheetHtml(list, show, plainMode) {
  const css = `body{margin:0;background:#ecebe8;font:13px -apple-system,Helvetica,Arial,sans-serif;color:#222;width:1880px}
  h1{font:600 22px -apple-system,Helvetica;margin:18px 24px 4px} h2{font:600 18px -apple-system,Helvetica;margin:22px 24px 8px}
  .row{display:flex;gap:22px;align-items:flex-start;padding:0 24px 12px;flex-wrap:wrap} figure{margin:0} figcaption{font:500 12px -apple-system,Helvetica;color:#555;height:32px;line-height:15px}
  .note{margin:2px 24px 0;color:#666;font-size:12px} table{border-collapse:collapse;margin:4px 24px 20px;background:#fff;font-size:13px;width:1830px} td,th{border:1px solid #ddd;padding:5px 8px;text-align:left;vertical-align:top} th{background:#f4f3f1}
  .w.cut{background:rgba(255,0,0,.28)} .w.key{text-decoration:underline 2px #e0a000}`;
  const V = (k) => VIEWS.find((v) => v.key === k);
  const newest = [...list].sort((a, b) => (b.episode ?? b.i) - (a.episode ?? a.i) || b.i - a.i);
  const rows = [['apple-375', 'apple-375-large', 'apple-430-dark', 'spotify-360'], ['spotify-search-360', 'pocket-390', 'youtube-360', 'watch-list'], ['nowplaying-375', 'lock-375', 'carplay-800'], ['desktop-1280', 'watch-np']];
  const tbl = `<table><tr><th style="width:40px">Ep.</th><th style="width:330px">Title</th><th>Description (as written)</th><th style="width:380px">Chapters</th></tr>${list.map((n) => `<tr><td>${esc(n.episode ?? '')}${n.season != null ? `<br><span style="color:#888">S${esc(n.season)}</span>` : ''}</td><td>${esc(n.title)}</td><td style="white-space:pre-wrap">${esc(plain(n.description))}</td><td>${n.chapters.map((c) => `${esc(fmtT(c.secs))} ${esc(c.title)}`).join('<br>')}</td></tr>`).join('')}</table>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>
  <h1>Episodes of ${esc(show || 'the show')}: where listeners choose them</h1>
  <div class="note">Stand-in mock-ups of podcast apps' lists and players (Palm's approximation, Nov 2026; not the apps' own designs; real apps vary by version, device and settings). Newest episode at the top.${plainMode ? '' : ' Red = words a view cuts off; gold underline = the key phrase.'}</div>
  ${rows.map((r) => `<div class="row">${r.map((k) => panel(V(k), newest, show)).join('')}</div>`).join('')}
  <div class="row">${chapterPanels(list)}</div>
  <h2 style="font-size:15px">Each episode as written</h2>${tbl}</body></html>`;
}

// ---------- check ----------
export async function check(target, { show = '', out = 'look/episodes', plain: plainMode = false, rss = '' } = {}) {
  const list = load(resolve(target));
  if (!list.length) throw new Error('No episodes found (each needs a title or a description).');
  show = show || list.show || '';
  const issues = []; const add = (level, id, msg, fix, at) => issues.push({ level, id, msg, fix, ...(at ? { at } : {}) });
  for (const n of list) { n.key_given = !!n.key; if (!n.key) n.key = guessKey(n, show); }
  // A series label repeated before the colon ("Winter Jobs: …" on two or more titles) is a lead too.
  const prefixOf = (t) => (t.match(/^\s*([^:|–—]{2,32}?)\s*[:|–—]\s+/) || [])[1]?.toLowerCase().trim() || '';
  const pc = {}; for (const n of list) { const p = prefixOf(leadOf(n.title, show, n.episode).rest); if (p) pc[p] = (pc[p] || 0) + 1; }
  const series = new Set(Object.keys(pc).filter((p) => pc[p] >= 2));
  const html = sheetHtml(list, show, plainMode);
  const browser = await launch();
  let measured; const sheet = resolve(out + '-sheet.png');
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1880, height: 1200, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts?.ready);
    measured = await page.evaluate(() => {
      const ell = (el) => { const c = document.createElement('canvas').getContext('2d'); const cs = getComputedStyle(el); c.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`; return c.measureText('…').width; };
      const res = [];
      for (const fig of document.querySelectorAll('figure.p')) for (const card of fig.querySelectorAll('.n')) {
        const rec = { view: fig.dataset.v, i: +card.dataset.n, c: card.dataset.c != null ? +card.dataset.c : null, fields: {} };
        for (const b0 of card.querySelectorAll('.box')) {
          const b = b0.getBoundingClientRect(); const ws = [...b0.querySelectorAll('.w')];
          const rects = ws.map((w) => [...w.getClientRects()]);
          const fitsV = (r) => r.bottom <= b.bottom + 1, fitsH = (r, allow) => r.right <= b.right - allow + 0.5;
          const anyHidden = rects.some((rs) => rs.some((r) => !fitsV(r) || !fitsH(r, 0)));
          const visTops = [...new Set(rects.flat().filter(fitsV).map((r) => Math.round(r.top)))].sort((a, z) => a - z);
          const lastTop = visTops[visTops.length - 1];
          const E = anyHidden ? ell(b0) : 0;
          const vis = rects.map((rs) => rs.length > 0 && rs.every((r) => fitsV(r) && fitsH(r, Math.round(r.top) === lastTop ? E : 0)));
          let k = vis.indexOf(false); if (k < 0) k = ws.length;
          rec.fields[b0.dataset.f] = { shown: ws.slice(0, k).map((w) => w.textContent).join(' '), cut: k < ws.length, cut_at: k < ws.length ? ws[k].textContent : null, lines: visTops.length, words: ws.length, shown_words: k };
          if (k < ws.length) ws.slice(k).forEach((w) => w.classList.add('cut'));
        }
        res.push(rec);
      }
      return res;
    });
    if (plainMode) await page.evaluate(() => document.querySelectorAll('.w.cut').forEach((w) => w.classList.remove('cut')));
    else await page.evaluate((K) => { for (const card of document.querySelectorAll('.n:not(.ch)')) { const alts = (K[+card.dataset.n] || '').toLowerCase().split('|').flatMap((a) => a.split(/\s+/)).map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean); for (const w of card.querySelectorAll('.w[data-f="title"]')) if (alts.includes(w.textContent.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''))) w.classList.add('key'); } }, list.map((n) => n.key));
    mkdirSync(dirname(sheet), { recursive: true });
    await page.screenshot({ path: sheet, fullPage: true });
    writeFileSync(resolve(out + '-sheet.html'), html);
  } finally { await browser.close(); }

  // ---------- per episode ----------
  const episodes = list.map((n) => {
    const where = n.episode != null ? `episode ${n.episode}` : `#${n.i + 1} "${n.title.slice(0, 30)}"`;
    const views = {};
    for (const v of VIEWS) {
      const rec = measured.find((r) => r.view === v.key && r.i === n.i && r.c == null);
      if (!rec) continue; const f = rec.fields;
      views[v.key] = { title: f.title ? (f.title.cut ? `${f.title.shown}…` : 'whole') : '-', title_cut_at: f.title?.cut_at || null, title_lines: f.title?.lines || 0,
        ...(f.desc ? { desc: f.desc.cut ? `${f.desc.shown}…` : 'whole', desc_chars_seen: f.desc.shown.length } : {}),
        key_ok: keySeen(n.key, f.title?.shown || '') };
    }
    const chapters = n.chapters.map((c, k) => {
      const a = measured.find((r) => r.view === 'chap-ios-375' && r.i === n.i && r.c === k)?.fields.chap, y = measured.find((r) => r.view === 'chap-yt-360' && r.i === n.i && r.c === k)?.fields.chap;
      return { start: fmtT(c.secs), title: c.title, chars: c.title.length, now_playing: a?.cut ? `${a.shown}…` : 'whole', youtube: y?.cut ? `${y.shown}…` : 'whole' };
    });
    const lead = leadOf(n.title, show, n.episode);
    { const p = prefixOf(lead.rest); if (p && series.has(p)) { const m = lead.rest.match(/^\s*[^:|–—]{2,32}?\s*[:|–—]\s+/)[0]; lead.parts.push({ kind: 'series', text: m.trim() }); lead.words += m.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length; lead.chars += m.length; lead.rest = lead.rest.slice(m.length).trim(); } }
    const pv = preview(n.description);
    const r = { episode: n.episode, season: n.season, date: n.date, title: n.title, key: n.key, key_given: n.key_given, chars: { title: n.title.length, description: plain(n.description).length },
      lead: lead.parts.map((p) => `${p.kind}: "${p.text}"`), lead_words: lead.words, preview: pv.slice(0, 120), views, chapters };
    // issues: title
    const lostDef = KEY_ERR.filter((k) => views[k] && !views[k].key_ok);
    const lostOther = VIEWS.filter((v) => !KEY_ERR.includes(v.key) && views[v.key] && !views[v.key].key_ok).map((v) => v.key);
    if (lostDef.length) add('error', 'key-cut', `${where}: the key phrase "${n.key}"${n.key_given ? '' : ' (guessed)'} is cut off in ${lostDef.join(', ')} — people see "${views[lostDef[0]].title}".`, 'Lead with the topic or guest: move the key words to the start of the title and drop anything before them.', where);
    else if (lostOther.length) add('warn', 'key-cut-other', `${where}: the key phrase "${n.key}"${n.key_given ? '' : ' (guessed)'} is cut off in ${lostOther.join(', ')} (larger text, Now Playing, lock screen or watch).`, 'Put it earlier or shorten what comes before it.', where);
    if (lead.parts.some((p) => p.kind === 'number')) add('error', 'number-in-title', `${where}: the title starts with the episode number ("${lead.parts.find((p) => p.kind === 'number').text}"), which the apps already show from itunes:episode — it costs ${lead.chars} characters before the topic.`, 'Apple: don\'t put episode or season numbers in the title; put them in the episode/season fields (itunes:episode, itunes:season).', where);
    else if (hasNumber(n.title, n.episode, n.season)) add('warn', 'number-in-title', `${where}: the title carries an episode or season number.`, 'Apple: use the itunes:episode / itunes:season tags instead.', where);
    if (show && new RegExp(`\\b${reEsc(show.replace(/^the\s+/i, ''))}\\b`, 'i').test(n.title)) add('error', 'show-in-title', `${where}: the title repeats the show's name, which every app shows next to it.`, 'Apple: "don\'t repeat the title of your show within your episode title."', where);
    if (lead.parts.some((p) => p.kind === 'guest' || p.kind === 'label' || p.kind === 'series')) add('warn', 'lead', `${where}: the title opens with ${lead.parts.filter((p) => p.kind === 'guest' || p.kind === 'label' || p.kind === 'series').map((p) => `"${p.text}"`).join(' and ')} before the topic.`, 'Lead with the most eye-catching information (Apple): a series name belongs in the description or artwork; a guest\'s name leads only if people would search for it.', where);
    const tcut = VIEWS.filter((v) => v.def && !v.oneLine && views[v.key]?.title_cut_at).map((v) => v.key);
    if (tcut.length) add('warn', 'title-cut', `${where}: the title "${n.title}" is cut in the phone lists at default text size (${tcut.join(', ')}; first lost word "${views[tcut[0]].title_cut_at}").`, 'Shorter: two lines on a 360-pt phone is about 45–50 characters in these mock-ups.', where);
    if (emojiCount(n.title) > 1) add('warn', 'emoji', `${where}: ${emojiCount(n.title)} emoji in the title.`, 'Words carry in search; one emoji at most.', where);
    const caps = capsWords(n.title); if (caps.length >= 2 || (n.title.length > 8 && n.title === n.title.toUpperCase() && /\p{Lu}/u.test(n.title))) add('warn', 'caps', `${where}: words in capitals (${caps.slice(0, 4).join(', ')}).`, 'Capitals read as shouting and take more room.', where);
    if (n.title.length > 255) add('error', 'title-long', `${where}: the title is ${n.title.length} characters; Apple limits RSS tag values to 255.`, 'Much shorter.', where);
    // description
    if (!pv) add('error', 'no-description', `${where}: no description.`, 'Every episode needs one: the apps show its start under the title.', where);
    else {
      const bp = boilerplate(n.description, show, n.title);
      if (bp) add('error', 'desc-boilerplate', `${where}: the description ${bp} ("${pv.slice(0, 60)}…"), so the preview under the title says nothing new.`, 'Spotify: avoid generic filler ("In this episode…") and don\'t open with a sponsor; make the first 90 characters count. Start with what the listener gets; put links, sponsor and credits after.', where);
      const first = pv.slice(0, 250);
      if (/(?:https?:\/\/|www\.|\b[\w-]+\.(?:com|co\.uk|org|net|fm|io)\b|patreon|use code|promo code|discount code|\bcode\s+[A-Z0-9]{3,}|sponsor(?:ed)?\b)/i.test(first.slice(0, 120)) && !bp) add('warn', 'desc-admin-early', `${where}: a link, code or sponsor appears in the description's first 120 characters ("${first.slice(0, 120)}").`, 'Spotify: the first 250 characters are what shows before "more"; keep them for the episode, and put the sponsor and links further down.', where);
      const tw = contentWords(lead.rest || n.title), dw = contentWords(pv.slice(0, 120)), shared = tw.filter((w) => dw.includes(w));
      if (!bp && tw.length >= 2 && shared.length >= Math.max(2, Math.ceil(tw.length * 0.6))) add('warn', 'desc-repeat', `${where}: the description's first line repeats the title (${shared.length} of its ${tw.length} words).`, 'Spotify: don\'t repeat the title; pick up where it leaves off.', where);
      const d360 = views['spotify-360']; if (d360?.desc && d360.desc !== 'whole' && d360.desc_chars_seen < 40) add('tip', 'desc-preview-short', `${where}: Spotify's list shows only "${d360.desc}" of the description.`, 'Fine if those words carry the point.', where);
    }
    // chapters
    const ch = n.chapters;
    if (ch.length) {
      if (ch.length < 3) add('warn', 'chapters-few', `${where}: ${ch.length} chapters; Spotify and YouTube need at least 3.`, 'Three or more, or none.', where);
      if (!(ch[0].secs === 0)) add('error', 'chapters-start', `${where}: the first chapter starts at ${ch[0].start || '?'}, not 00:00.`, 'Spotify and YouTube: the first chapter starts at 00:00.', where);
      const bad = ch.filter((c) => !isFinite(c.secs)); if (bad.length) add('error', 'chapters-time', `${where}: ${bad.length} chapter(s) without a readable start time ("${bad[0].start}").`, 'Use mm:ss or hh:mm:ss.', where);
      const order = ch.findIndex((c, k) => k > 0 && c.secs <= ch[k - 1].secs); if (order > 0) add('error', 'chapters-order', `${where}: chapter ${order + 1} (${ch[order].start}) isn't after the one before.`, 'In ascending order.', where);
      const short = ch.findIndex((c, k) => k > 0 && c.secs - ch[k - 1].secs < 30 && c.secs > ch[k - 1].secs); if (short > 0) add('warn', 'chapters-short', `${where}: chapter ${short} is under 30 seconds long.`, 'Spotify: at least 30 seconds between chapter starts (YouTube: 10 s).', where);
      const long = ch.filter((c) => c.title.length > 40); if (long.length) add('warn', 'chapter-long', `${where}: ${long.length} chapter title(s) over 40 characters (longest ${Math.max(...long.map((c) => c.title.length))}: "${long.sort((a, b) => b.title.length - a.title.length)[0].title}").`, 'Spotify: aim for under 40 characters; Apple: no more than 45.', where);
      const idx = ch.filter((c) => /^\s*(?:\d+\s*[-.):]|chapter\s*\d+\s*[:.-]?|part\s*\d+\s*[:.-])\s*/i.test(c.title)); if (idx.length) add('warn', 'chapter-index', `${where}: chapter titles start with an index ("${idx[0].title}").`, 'Spotify removes indexes like "1 - Introduction"; drop them.', where);
      const emo = ch.filter((c) => emojiCount(c.title)); if (emo.length) add('warn', 'chapter-emoji', `${where}: emoji in chapter titles.`, 'Spotify: plain text, no emoji.', where);
      const cutNp = chapters.filter((c) => c.now_playing !== 'whole'); if (cutNp.length) add('warn', 'chapter-cut', `${where}: ${cutNp.length} chapter name(s) cut on the Now Playing scrubber (e.g. "${cutNp[0].now_playing}").`, 'Shorter chapter names: the point in the first three or four words.', where);
      const cutYt = chapters.filter((c) => c.youtube !== 'whole'); if (cutYt.length) add('tip', 'chapter-cut-player', `${where}: ${cutYt.length} chapter name(s) cut beside the time on a YouTube-style player (e.g. "${cutYt[0].youtube}").`, 'The first two or three words carry it there.', where);
      const filler = ch.filter((c, k) => k > 0 && /^(?:intro(?:duction)?|welcome|outro|goodbye|wrap[- ]?up|ads?|sponsor|break)$/i.test(c.title.trim())); if (filler.length >= 3) add('tip', 'chapter-filler', `${where}: several chapters are only "Intro"/"Sponsor"-type labels.`, 'Name chapters by what is in them.', where);
    }
    return r;
  });

  // ---------- across the set (Palm's metric) ----------
  const T = list.map((n) => ({ ep: n.episode != null ? `ep ${n.episode}` : `#${n.i + 1}`, cw: contentWords(leadOf(n.title, show, n.episode).rest || n.title), rest: leadOf(n.title, show, n.episode).rest || n.title }));
  const firstTwo = (t) => contentWords(t.rest).slice(0, 2).join(' ');
  // "first two content words" in reading order
  const ordered = (s) => words(s).filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)).map(stem);
  const f2 = T.map((t) => ordered(t.rest).slice(0, 2).join(' '));
  const similar = [];
  for (let a = 0; a < T.length; a++) for (let b = a + 1; b < T.length; b++) {
    const A = T[a].cw, B = T[b].cw; const inter = A.filter((w) => B.includes(w)).length; const uni = new Set([...A, ...B]).size || 1;
    const j = inter / uni;
    if ((j >= 0.5 && inter >= 2) || (f2[a] && f2[a] === f2[b])) similar.push({ a: T[a].ep, b: T[b].ep, shared: A.filter((w) => B.includes(w)), jaccard: +j.toFixed(2), same_start: f2[a] === f2[b] });
  }
  for (const s of similar) add('warn', 'similar', `${s.a} and ${s.b} have titles that are too alike (${s.same_start ? 'same first words' : `share ${s.shared.length} of their content words: ${s.shared.join(', ')}`}), so they're hard to tell apart in a list.`, 'Apple: every episode\'s title should be unique. Lead each with what only that episode has.');
  const firstWord = T.map((t) => ordered(t.rest)[0] || '');
  const fwCount = firstWord.reduce((m, w) => (w && (m[w] = (m[w] || 0) + 1), m), {});
  for (const [w, c] of Object.entries(fwCount)) if (c >= 3 && c >= list.length / 2) add('warn', 'same-start', `${c} of ${list.length} titles start with the same word ("${w}…"), so the one-line views (search, CarPlay, Now Playing) begin alike.`, 'A series name belongs in the description or the artwork; start each title with its own topic.');
  const distinct = +(f2.filter((x, i) => x && f2.filter((y) => y === x).length === 1 && fwCount[firstWord[i]] < 3).length / Math.max(1, list.length)).toFixed(2);
  const st = list.map((n) => n.title.toLowerCase()); if (new Set(st).size < st.length) add('error', 'same-title', 'Two episodes have the same title.', 'Every title unique.');
  const eps = list.map((n) => n.episode).filter((x) => x != null); if (eps.length && new Set(eps).size < eps.length) add('warn', 'same-number', 'Two episodes share an episode number.', 'Each its own itunes:episode.');
  if (eps.length && eps.length < list.length) add('tip', 'missing-number', 'Some episodes have no episode number.', 'Give every episode its number in the episode field (itunes:episode) if you number them.');

  if (rss) writeRss(list, rss);
  const errors = issues.filter((i) => i.level === 'error').length, warnings = issues.filter((i) => i.level === 'warn').length;
  return { ok: errors === 0, errors, warnings, show, count: list.length, set: { similar, distinguishability: distinct, mean_title_chars: Math.round(list.reduce((s, n) => s + n.title.length, 0) / list.length) }, episodes, issues, sheet,
    ...(rss ? { rss: resolve(rss) } : {}),
    note: 'Views and thresholds are Palm\'s approximation (Nov 2026), drawn with the system fonts on this machine; no podcast app publishes its layout as numbers. Look at the sheet.' };
}

// RSS <item> snippets and Podcasting 2.0 chapters JSON (to paste into a host that takes them, or to compare).
function writeRss(list, file) {
  const x = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  const cdata = (s) => `<![CDATA[${String(s).replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
  const items = list.map((n) => {
    const body = /<(p|a|ul|ol|li|br)\b/i.test(n.description) ? n.description : plain(n.description).split(/\n{2,}/).map((p) => `<p>${x(p).replace(/\n/g, '<br>')}</p>`).join('');
    const slug = n.episode != null ? `episode-${n.episode}` : `item-${n.i + 1}`;
    return `<item>\n  <title>${x(n.title)}</title>\n  <itunes:title>${x(n.title)}</itunes:title>\n${n.episode != null ? `  <itunes:episode>${n.episode}</itunes:episode>\n` : ''}${n.season != null ? `  <itunes:season>${n.season}</itunes:season>\n` : ''}  <itunes:episodeType>full</itunes:episodeType>\n  <description>${cdata(body)}</description>\n${n.chapters.length ? `  <podcast:chapters url="https://example.com/chapters/${slug}.json" type="application/json+chapters"/>\n` : ''}  <!-- guid, enclosure and pubDate come from your host -->\n</item>`;
  });
  mkdirSync(dirname(resolve(file)), { recursive: true });
  writeFileSync(resolve(file), `<!-- RSS <item> snippets written by Palm's episode-check (xmlns:itunes and xmlns:podcast on the <rss> element). -->\n${items.join('\n')}\n`);
  for (const n of list) if (n.chapters.length) writeFileSync(resolve(dirname(resolve(file)), `chapters-${n.episode != null ? `episode-${n.episode}` : `item-${n.i + 1}`}.json`), JSON.stringify({ version: '1.2.0', chapters: n.chapters.map((c) => ({ startTime: c.secs, title: c.title })) }, null, 2));
}

// ---------- self-test ----------
async function selfTest() {
  const d = mkdtempSync(join(tmpdir(), 'episode-check-'));
  const ch = (a) => a.map(([s, t]) => ({ start: s, title: t }));
  const good = { show: 'Small Plot', episodes: [
    { episode: 47, season: 4, date: '2026-12-03', duration: 51, title: 'Pruning apple trees in winter, with Ruth Pennock', description: 'The three Ds, opening the middle and why plums wait for summer. Ruth Pennock runs a community orchard in Hebden Bridge and has pruned hundreds of old trees.\n\nSponsored by Greenleaf Seeds.', chapters: ch([['00:00', 'Hello'], ['01:45', 'Ruth\'s community orchard'], ['14:20', 'Dead, diseased, damaged']]), key: 'apple|pruning' },
    { episode: 48, season: 4, date: '2026-12-10', title: 'Seed catalogues: what\'s worth growing next year', description: 'Dev Malhotra\'s rule: grow what\'s expensive to buy. F1 or open-pollinated, and how long seeds keep.', chapters: ch([['00:00', 'Hello'], ['07:45', 'Reading a catalogue'], ['23:10', 'F1 or open-pollinated']]), key: 'seed' },
  ] };
  writeFileSync(join(d, 'good.json'), JSON.stringify(good));
  const g = await check(join(d, 'good.json'), { out: join(d, 'good'), rss: join(d, 'rss', 'items.xml') });
  const gw = g.issues.filter((i) => i.level !== 'tip'); if (gw.length) throw new Error('good: ' + JSON.stringify(gw, null, 1));
  if (g.show !== 'Small Plot' || !existsSync(g.sheet) || !existsSync(join(d, 'rss', 'chapters-episode-47.json')) || !readFileSync(join(d, 'rss', 'items.xml'), 'utf8').includes('<itunes:episode>47</itunes:episode>')) throw new Error('good: sheet/rss');
  const bad = [
    { episode: 47, title: 'Ep 47 | Small Plot | Winter Jobs: Pruning Apple and Pear Trees the Right Way with Ruth Pennock', description: 'In this episode of Small Plot, Hannah chats with Ruth Pennock about pruning. Sponsored by Greenleaf Seeds.', chapters: '00:30 Intro and welcome to the show; 01:45 Ruth introduces herself and the community orchard in Hebden Bridge', key: 'apple|pruning' },
    { episode: 48, title: 'Ep 48 | Small Plot | Winter Jobs: Choosing Seeds From the Catalogue with Dev Malhotra', description: 'Sponsored by Greenleaf Seeds — use code PLOT15. This week Dev…', chapters: [], key: 'seed|seeds' },
    { episode: 49, title: 'Winter Jobs: Winter Compost Heaps', description: 'https://patreon.com/smallplot — compost heaps in winter.', chapters: ['(00:00) Intro', '(05:20) 1 - Why heaps stall 🍂', '(05:30) Hot heaps'] },
    { episode: 50, title: 'Winter Jobs: Winter Compost Heaps and Leaf Mould', description: 'Winter compost heaps and leaf mould, the long version.' },
  ];
  writeFileSync(join(d, 'bad.json'), JSON.stringify(bad));
  const b = await check(join(d, 'bad.json'), { show: 'Small Plot', out: join(d, 'bad') });
  const ids = b.issues.map((i) => i.id);
  for (const want of ['lead', 'key-cut', 'number-in-title', 'show-in-title', 'desc-boilerplate', 'chapters-start', 'chapter-long', 'chapter-index', 'chapter-emoji', 'chapters-short', 'chapters-few', 'similar', 'same-start', 'title-cut']) if (!ids.includes(want)) throw new Error('bad: expected ' + want + ' in ' + ids.join(','));
  if (b.ok) throw new Error('bad: should fail');
  const e47 = b.episodes.find((e) => e.episode === 47);
  if (!e47.views['spotify-search-360'].title_cut_at || e47.lead_words < 4) throw new Error('views/lead: ' + JSON.stringify(e47));
  // leads, boilerplate, chapters parsing
  const L = leadOf('Episode 12: The Garden Hour - with Sam Lee: Slugs', 'The Garden Hour');
  if (L.rest !== 'Slugs' || L.parts.length !== 3) throw new Error('leadOf: ' + JSON.stringify(L));
  if (leadOf('S4E47 Pruning', '').rest !== 'Pruning' || leadOf('#47 - Pruning', '').rest !== 'Pruning' || leadOf('Pruning apples', 'Small Plot').parts.length) throw new Error('leadOf 2');
  if (!boilerplate('Welcome back to the show!') || !boilerplate('<p>In today\'s episode we…</p>') || boilerplate('Ruth Pennock on pruning.')) throw new Error('boilerplate');
  const pc = parseChapters('(00:00) Intro\n(1:02:03) Late one'); if (pc.length !== 2 || pc[1].secs !== 3723) throw new Error('chapters: ' + JSON.stringify(pc));
  if (chaptersFromText('Notes.\n00:00 Hello\n02:10 Next\n05:00 Last').length !== 3) throw new Error('chaptersFromText');
  if (!keySeen('brussels sprouts|sprout', 'Why sprouts blow') || keySeen('apple', 'Winter Jobs: Pruning')) throw new Error('keySeen');
  writeFileSync(join(d, 'e.csv'), 'episode,title,description,chapters\n47,"Pruning apples, the easy way",Ruth on the three Ds,"00:00 Hello; 02:00 Ruth; 10:00 Three Ds"\n');
  const c = load(join(d, 'e.csv')); if (c.length !== 1 || c[0].episode !== 47 || c[0].chapters.length !== 3) throw new Error('csv: ' + JSON.stringify(c));
  console.log(`episode-check: all tests pass (good: no warnings; bad: ${[...new Set(ids)].join(', ')}; sheets in ${d})`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (k, dflt) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : dflt; };
  const VALUED = new Set(['--out', '--show', '--rss']);
  const pos = argv.filter((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1]));
  const done = (r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); };
  const fail = (e) => { console.error(String(e.message || e)); process.exit(2); };
  if (argv.includes('--self-test') || argv.includes('--test')) selfTest().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
  else if (pos[0] === 'check' && pos[1]) check(pos[1], { show: opt('show', ''), out: opt('out', 'look/episodes'), plain: argv.includes('--plain'), rss: opt('rss', '') }).then(done, fail);
  else fail('usage: episode-check.mjs check <episodes.json | .csv | folder> [--show "Show name"] [--out look/episodes] [--plain] [--rss feed-items.xml]\n       episode-check.mjs --self-test');
}
