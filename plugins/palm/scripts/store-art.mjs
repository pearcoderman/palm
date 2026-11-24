#!/usr/bin/env node
// Palm tool: store-art — checks a folder of store graphics for Google Play, the Chrome Web Store, Steam, Apple Podcasts,
// Etsy or Shopify against the
// stores' current rules (exact sizes, formats, alpha, counts, the sizes Steam stopped accepting in Aug 2024, banned
// words in the HTML they were made from), and draws them the way each store shows them: the Play icon under its mask
// at list size, the feature graphic at phone width with its cutoff zones, the Chrome tile at half size on the grey
// page, Steam's small capsule at 120×45 and 184×69 in a search row, the library grid and the hero with its safe area,
// a podcast cover at 60 px in a list and on a lock screen, and a shop's first photo in the square, portrait and
// landscape crops a marketplace grid uses; and a social profile kit (avatar, YouTube banner, X header, LinkedIn
// banners, Facebook cover) on each site's desktop and phone layout with the avatar laid over it; and Meta ads (feed, Stories,
// Reels) in the Facebook and Instagram apps at phone size with their buttons over them, the copy cut where the apps cut
// it, and text measured against Meta's 9:16 safe zone from the HTML each creative was made from.
// (The ads check is kept for reference; its job sheet didn't ship: a blind tie, PALM-AGENTS-PLAN.md.)
// And Pinterest pins in the desktop home feed (~236 px columns) and the phone app (two columns), light and dark, with the
// hover buttons, titles cut at the 40 characters Pinterest says may show, too-tall pins cut at 2:3, text measured at feed
// size from each pin's HTML, and pins that look alike at feed size.
// And a Google Business Profile (gbp): logo, cover, photos and this week's post, drawn in Search on a desktop and a phone, in
// Maps, in the photo grid and as a post card, with Google's photo rules checked and any text added to photos flagged.
// (The event check is kept for reference; its job sheet didn't ship: blind 5 of 18, PALM-AGENTS-PLAN.md.)
// And an App Store In-App Event (event): the 16:9 card in search, Today and the product page, and the 9:16 details page on an
// iPhone, light and dark, with Apple's metadata rules checked and words in the media flagged where Apple's overlay or crop hits them.
// One sheet to LOOK at, plus measured problems. Also renders an HTML design to an image at an exact size.
// adds: tool, fresh-data. Runs on the user's machine with their Chrome/Edge/Chromium; nothing leaves it.
//
//   node store-art.mjs check <google-play|chrome-web-store|steam|apple-podcasts|etsy|shopify|profiles|ads|pinterest|gbp|event> <folder> [--out art]
//       → JSON {ok, store, found:[{key, file, w, h}], missing, issues} and <out>-sheet.png. Then LOOK at the sheet.
//   node store-art.mjs render <design.html> --size 1024x500 --out upload/feature.png [--jpeg] [--alpha]
//       → renders the HTML at exactly that size. PNGs are flattened (no alpha) unless --alpha (icons, Steam logo).
//
// Sizes and rules: Palm data pack app-launch/store-art (checked 2026-11-23, from the stores' own pages); social
// profiles from design/platform-sizes (YouTube and LinkedIn Pages rechecked on their help pages 2026-11-23); ads from
// marketing/ad-specs (Meta Ads Guide, 2026-11-23).

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve, extname, relative, basename } from 'node:path';

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
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return { format: 'webp' };
  if (b.toString('latin1', 0, 4) === 'GIF8') return { format: 'gif', w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  return { format: 'unknown' };
}

const issue = (id, level, msg, fix) => ({ id, level, msg, fix });

// ---------- the stores' rules (data pack app-launch/store-art, checked 2026-11-23) ----------
export const STORES = {
  'google-play': {
    name: 'Google Play',
    assets: [
      { key: 'icon', label: 'App icon', w: 512, h: 512, required: true, png: true, maxKB: 1024 },
      { key: 'feature', label: 'Feature graphic', w: 1024, h: 500, required: true, noAlpha: true },
      { key: 'tv-banner', label: 'TV banner', w: 1280, h: 720, hint: /tv|banner/i, noAlpha: true },
    ],
    shots: { label: 'Phone screenshots', min: 2, max: 8, good: 4, minSide: 320, maxSide: 3840, ratio: 2.3, recSide: 1080, maxMB: 8, noAlpha: true },
    words: [/\bbest\b/i, /#\s?1\b/, /\bnumber one\b/i, /\btop[- ]?(rated|ranked|\d+)?\b/i, /\bnew\b/i, /\bfree\b/i, /\bdiscount/i, /\bsale\b/i, /\b\d+\s?(k|m|million)\+? (downloads|users)/i, /\bdownload now\b/i, /\binstall now\b/i, /\bplay now\b/i, /\btry (it )?now\b/i, /\baward/i, /\beditor'?s choice\b/i, /★|\d(\.\d)? stars?/i, /\$\d|€\d|£\d/],
    wordsWhy: 'Google Play bans ranking, awards, price/promotion words (Best, #1, Top, New, Free, Sale…) and calls to action (Download now, Play now) in graphics.',
  },
  'chrome-web-store': {
    name: 'Chrome Web Store',
    assets: [
      { key: 'icon', label: 'Store icon', w: 128, h: 128, required: true, png: true, padding: 16 },
      { key: 'small-tile', label: 'Small promo tile', w: 440, h: 280, recommended: 'Listings without one are shown after those that have one.' },
      { key: 'marquee', label: 'Marquee promo tile', w: 1400, h: 560 },
    ],
    shots: { label: 'Screenshots', min: 1, max: 5, sizes: [[1280, 800], [640, 400]] },
    words: [/\beditor'?s choice\b/i, /\bnumber one\b/i, /#\s?1\b/, /\bbest\b/i, /\baward/i, /★/],
    wordsWhy: 'The Chrome Web Store says promo images should have little or no text and no claims like "Editor\'s Choice" or "Number One".',
  },
  steam: {
    name: 'Steam',
    assets: [
      { key: 'header', label: 'Header capsule', w: 920, h: 430, required: true, hint: /^(?!.*library).*$/i },
      { key: 'small', label: 'Small capsule', w: 462, h: 174, required: true },
      { key: 'main', label: 'Main capsule', w: 1232, h: 706, required: true },
      { key: 'vertical', label: 'Vertical capsule', w: 748, h: 896, required: true },
      { key: 'background', label: 'Page background', w: 1438, h: 810 },
      { key: 'library-capsule', label: 'Library capsule', w: 600, h: 900, required: true },
      { key: 'library-header', label: 'Library header', w: 920, h: 430, required: true, hint: /library/i, fallback: 'header' },
      { key: 'library-hero', label: 'Library hero', w: 3840, h: 1240, required: true, png: true, noText: true },
      { key: 'library-logo', label: 'Library logo', logo: true, required: true, png: true, alpha: true },
      { key: 'community-icon', label: 'Community icon', w: 184, h: 184, required: true, jpg: true },
    ],
    old: [[460, 215, 'header capsule (now 920×430)'], [231, 87, 'small capsule (now 462×174)'], [616, 353, 'main capsule (now 1232×706)'], [374, 448, 'vertical capsule (now 748×896)'], [1920, 620, 'library hero (now 3840×1240)'], [640, 360, 'logo/hero at an old size'], [300, 450, 'library capsule (now 600×900)']],
    shots: { label: 'Screenshots', min: 5, minW: 1920, minH: 1080, ratio169: true },
    words: [/\bwishlist/i, /\bpre-?(order|purchase)/i, /\bbuy now\b/i, /\bplay now\b/i, /\bavailable now\b/i, /\bout now\b/i, /\bcoming soon\b/i, /\b\d{1,3}\s?% (off|discount)/i, /\bsale\b/i, /\baward/i, /\bgame of the year\b/i, /\bgoty\b/i, /\boverwhelmingly positive\b/i, /\bvery positive\b/i, /\b\d+\/10\b/, /★/],
    wordsWhy: 'Steam capsules may show only game art, the game name and an official subtitle: no review scores, awards, sale text or calls to action (rule in force since 1 Sept 2022).',
  },
  // podcasters.apple.com/support/5514 (show cover) and 5516 (episode art)
  'apple-podcasts': {
    name: 'Apple Podcasts',
    square: { min: 1400, max: 3000, best: 3000, formats: ['png', 'jpeg'], noAlpha: true },
    words: [], wordsWhy: '',
  },
  // help.etsy.com/hc/en-us/articles/115015663347
  etsy: {
    name: 'Etsy',
    photos: { min: 1, firstMin: 635, rec: 2000, maxKBWarn: 1024, formats: ['jpeg', 'png', 'gif'], noAlpha: 'Etsy shows transparent parts of an image as black.', firstLandscapeOrSquare: true },
    words: [], wordsWhy: '',
  },
  // help.shopify.com/en/manual/products/product-media/product-media-types
  shopify: {
    name: 'Shopify',
    photos: { min: 1, maxSide: 5000, maxMP: 25, maxMB: 20, squareRec: 2048, sameRatio: true, formats: ['jpeg', 'png', 'gif', 'webp'] },
    words: [], wordsWhy: '',
  },
};

// Social profiles. Official: YouTube Help 10456525 (banner 16:9, min 2048×1152, 2560×1440 for TV, safe area 1235×338
// at 2048 wide, ≤6 MB; profile picture rendered at 98×98, ≤15 MB), LinkedIn Help a563309 (Page cover 1512×256 min and
// recommended, logo 400×400, min 268, PNG/JPEG ≤3 MB), X Help (header 1500×500, photo 400×400, photo ≤2 MB), Facebook
// Help 125379114252045 (cover 851×315, at least 400×150). LinkedIn's member banner 1584×396 / 8 MB is a community
// figure (LinkedIn's page wasn't found). Where each site lays the avatar over the banner, and how phones crop, is
// Palm's measurement of the current layouts, not published: the sheet says so.
STORES.profiles = {
  name: 'Social profiles',
  profiles: [
    { key: 'youtube', label: 'YouTube banner', ratio: 16 / 9, tol: 0.01, rec: [2560, 1440], min: [2048, 1152], maxMB: 6, hint: /you ?tube|yt|channel/i, skip: 'not on YouTube' },
    { key: 'x', label: 'X header', ratio: 3, tol: 0.01, rec: [1500, 500], min: [1500, 500], minLevel: 'warn', hint: /\bx\b|x[-_]|twitter|header/i, not: /bluesky|bsky/i, skip: 'not on X' },
    { key: 'linkedin', label: 'LinkedIn profile banner', ratio: 4, tol: 0.01, rec: [1584, 396], min: [1584, 396], minLevel: 'warn', maxMB: 8, maxLevel: 'warn', hint: /linked ?in|li[-_]|profile|personal|member/i, skip: 'no personal LinkedIn' },
    { key: 'linkedin-page', label: 'LinkedIn Page cover', ratio: 1512 / 256, tol: 0.02, rec: [1512, 256], min: [1512, 256], maxMB: 3, old: [1128, 191], hint: /page|company|cover|linked/i, skip: 'no LinkedIn Page' },
    { key: 'facebook', label: 'Facebook cover', ratio: 851 / 315, tol: 0.04, rec: [851, 315], min: [400, 150], hint: /face ?book|fb/i, skip: 'not on Facebook' },
  ],
  avatar: { min: 400, maxMB: 2, hint: /avatar|profile|pfp|logo|icon|photo|picture|mark/i },
  words: [], wordsWhy: '',
};

// Pinterest pins. Official, Pinterest's "Review ad specs" (help.pinterest.com/en/business/article/pinterest-product-specs,
// read 2026-11-24; it says the image specs apply to ads and organic Pins): 2:3 recommended (1000×1500); "Pins with an
// aspect ratio greater than 2:3 might get cut off in people's feeds"; PNG or JPEG, 20 MB (desktop) / 32 MB (app); title
// up to 100 characters, "the first 40 characters may show in people's feeds"; description up to 800, not shown in the
// home or search feed. Palm's estimates, not Pinterest's (the sheet says so): the web feed's ~236 px columns and the
// app's two ~183 px columns on a 390 px phone, the hover buttons' positions, where a too-tall pin gets cut (drawn at 2:3),
// and the legibility floor (8 px as shown on a phone; the headline at least 14 px).
STORES.pinterest = {
  name: 'Pinterest',
  pins: { ratio: 1.5, rec: [1000, 1500], maxMB: 20, titleMax: 100, titleShown: 40, descMax: 800, desktopCol: 236, phoneCol: 183, minShown: 8, headShown: 14 },
  words: [], wordsWhy: '',
};

// Google Business Profile. Official, read 2026-11-24:
// - "Manage your Business Profile photos & videos" (support.google.com/business/answer/6103862): JPG or PNG; between 10 KB
//   and 5 MB; recommended 720×720 px; minimum 250×250 px; in focus, well lit, "no significant alterations or excessive use
//   of filters"; video up to 30 s, 75 MB, 720p or higher; the logo is highlighted once phone/hours are filled in; a cover
//   photo isn't guaranteed to show first, and a low-quality one may be replaced by a customer's photo.
// - Maps "Tips for posting media" (support.google.com/contributionpolicy/answer/7411351, linked from the Business Profile
//   photos policy as the "additional criteria"): avoid screenshots, stock photos, collages, heavily edited images; "Avoid
//   adding elements such as borders, text, or collaged images".
// - Posts content policy (support.google.com/business/answer/7213077): posts with unverified contact info (phone numbers,
//   email addresses, social media handles) may be removed; use a "Call now" button instead. Hotels can't make offer posts.
// Palm's estimates, not Google's (Google publishes no display sizes; the sheet says so): the crops drawn (Search desktop
// photo block about 4:3, Maps place-sheet hero about 1.86:1 on a phone and 1.7:1 on a desktop, square grid thumbnails,
// the logo in a circle), the post card's 4:3 image and its three lines of text before "More" (about 115 characters).
STORES.gbp = {
  name: 'Google Business Profile',
  gbp: { formats: ['jpeg', 'png'], minKB: 10, maxMB: 5, min: 250, rec: 720,
    crops: [['Search on a desktop', 4 / 3], ['Maps on a phone', 390 / 210], ['Maps on a desktop', 408 / 240], ['the photo grid', 1]],
    card: { w: 260, ratio: 4 / 3, lines: 3, chars: 115 }, minShown: 8 },
  words: [], wordsWhy: '',
};

// App Store In-App Events. Official, developer.apple.com/app-store/in-app-events/ (read 2026-11-24): event card media 16:9,
// 1920×1080 to 3840×2160; event details media 9:16, 1080×1920 to 2160×3840; .jpg/.jpeg/.png (or video .mov/.m4v/.mp4,
// 30/60 fps); name up to 30 characters in title case, the event's actual name, not a call to action or tagline, avoiding
// generic terms or the type of event ("the event badge already displays this information"), no all capitals, no multiple
// punctuation; short description up to 50 (sentence case, on the card); long description up to 120 (sentence case, on the
// details page); "Including specific pricing will lead to rejection"; "avoid using text or logos in your media, especially if
// they include your event name or app name"; "Don't add borders or gradients ... Crops and gradients are automatically
// applied"; up to 31 days, promoted up to 14 days before; badges Challenge, Competition, Live Event, Major Update, New
// Season, Premiere, Special Event. Palm's estimates, not Apple's (the sheet says so): the card drawn 343 pt wide with
// Apple's gradient and text over its lower ~45%, and the details page filling a 390×844 iPhone screen, so the 9:16 media
// loses about 9% at each side and its lower ~45% sits under the name, description and buttons.
STORES.event = {
  name: 'App Store In-App Event',
  event: { formats: ['jpeg', 'png'], card: { ratio: 16 / 9, min: [1920, 1080], max: [3840, 2160] }, details: { ratio: 9 / 16, min: [1080, 1920], max: [2160, 3840] },
    name: 30, short: 50, long: 120, maxDays: 31,
    badges: ['Challenge', 'Competition', 'Live Event', 'Major Update', 'New Season', 'Premiere', 'Special Event'],
    overlay: 0.45, phone: [390, 844] },
  words: [], wordsWhy: '',
};

// Meta ads (Facebook and Instagram feed, Stories, Reels). Official, Meta Ads Guide read 2026-11-23: feed 4:5 at 1440×1800
// (FB min width 600, 3% tolerance; IG min width 500, 1% tolerance, widest 1.91:1); Stories/Reels 9:16 at 1440×2560 (min
// width 500, 1% tolerance); JPG or PNG up to 30 MB; text: IG feed primary 125 / headline 40, FB feed primary 50–150 /
// headline 27, Stories primary 125 / headline 40, Reels primary 44. Safe zone for 9:16: roughly 14% top, 35% bottom and
// 6% each side free of text, logos and key elements (Business Help 980593475366490). Where the apps cut the copy is
// drawn with line clamps at phone width: Palm's approximation of the layouts, and the sheet says so.
STORES.ads = {
  name: 'Meta ads',
  ads: {
    feed: { label: 'Feed (4:5)', ratios: [[4 / 5, 0.01], [1, 0.01], [1.91, 0.01]], rec: [1440, 1800], minW: 600, maxMB: 30 },
    vertical: { label: 'Stories and Reels (9:16)', ratios: [[9 / 16, 0.01]], rec: [1440, 2560], minW: 500, maxMB: 30, safe: { top: 0.14, bottom: 0.35, side: 0.06 } },
    text: { primary: 125, reelsPrimary: 44, headline: 40, fbHeadline: 27 },
  },
  words: [], wordsWhy: '',
};

// Reads the ad copy: copy.md / copy.txt / copy.json in the folder ("Primary text: …", "Headline: …", "Description: …";
// several variants allowed).
export function readCopy(files) {
  const f = files.find((x) => /(^|[\/\\])(ad[-_ ]?)?copy\.(md|txt|json)$/i.test(x)) || files.find((x) => /copy|text/i.test(basename(x)) && /\.(md|txt|json)$/i.test(x));
  if (!f) return null;
  const raw = readFileSync(f, 'utf8'), out = { file: f, primary: [], headline: [], description: [] };
  if (/\.json$/i.test(f)) { try { const j = JSON.parse(raw); for (const k of ['primary', 'headline', 'description']) { const v = j[k] ?? j[k + '_text'] ?? j[k + 'Text'] ?? j[k + 's']; if (v) out[k] = [].concat(v).map(String); } return out; } catch { /* fall through */ } }
  // Two layouts: "Primary text: …" lines, or a "## Primary text" heading (or a bold line) with the text below it,
  // where paragraphs belong to one text and list items are separate variants.
  const kindOf = (s) => { const m = String(s).trim().match(/^(primary(?:\s*text)?|headline|description)s?\b/i); return m ? (/primary/i.test(m[1]) ? 'primary' : m[1].toLowerCase()) : null; };
  const clean = (t) => t.trim().replace(/^["“]|["”]$/g, '');
  let cur = null, gap = false;
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:[-*]\s*)?\**\s*(primary(?:\s*text)?|headline|description)\s*(?:\d+|\(\w+\))?\s*\**\s*[:：]\s*\**\s*(.*)$/i);
    if (m) { cur = kindOf(m[1]); out[cur].push(clean(m[2])); gap = false; continue; }
    const h = line.match(/^\s*#{1,6}\s*(.+?)\s*#*\s*$/) || line.match(/^\s*\*\*([^*]+)\*\*\s*$/);
    if (h) { cur = kindOf(h[1].replace(/[\d().:]+\s*$/, '')); if (cur) out[cur].push(''); gap = false; continue; }
    if (/^\s*$/.test(line)) { gap = true; continue; }
    if (!cur) continue;
    const li = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
    const list = out[cur];
    if (li && list.length && list[list.length - 1] && !/^[✔✓✅]/.test(li[1])) { list.push(clean(li[1])); gap = false; continue; }
    const t = clean(li ? li[1] : line);
    if (!list.length) list.push('');
    list[list.length - 1] = list[list.length - 1] ? list[list.length - 1] + (gap ? '\n' : ' ') + t : t;
    gap = false;
  }
  for (const k of ['primary', 'headline', 'description']) out[k] = out[k].map((x) => x.trim()).filter(Boolean);
  return out;
}

// Meta ads: feed creatives (4:5, 1:1 or 1.91:1) and Stories/Reels creatives (9:16), matched by shape.
function adArt(S, imgs, files, issues, found, used) {
  const A = S.ads;
  const pool = imgs.filter((im) => !/sheet|look|context|preview|mock/i.test(basename(im.file)));
  const fits = (im, rs) => rs.some(([r, tol]) => Math.abs(im.w / im.h - r) / r <= tol);
  for (const im of pool) {
    const kind = fits(im, A.vertical.ratios) ? 'vertical' : fits(im, A.feed.ratios) ? 'feed' : null;
    if (!kind) { used.add(im.file); issues.push(issue('ratio', 'error', `${im.rel} is ${im.w}×${im.h} (${(im.w / im.h).toFixed(2)}:1): not 4:5, 1:1, 1.91:1 or 9:16, so Meta crops or refuses it.`, 'Render it at 1440×1800 (feed) or 1440×2560 (Stories and Reels).')); continue; }
    const P = A[kind]; used.add(im.file);
    found.push({ key: kind, label: P.label, file: im.rel, w: im.w, h: im.h, format: im.format, alpha: im.alpha, kb: im.kb, abs: im.file });
    if (!['png', 'jpeg'].includes(im.format)) issues.push(issue('format', 'error', `${im.rel} is ${im.format.toUpperCase()}; Meta takes JPG or PNG.`, 'Save it as JPG or PNG.'));
    if (im.w < P.minW) issues.push(issue('size-' + kind, 'error', `${im.rel} is ${im.w} px wide; Meta's minimum is ${P.minW}.`, `Render it at ${P.rec.join('×')}.`));
    else if (im.w < 1080) issues.push(issue('size-' + kind, 'warn', `${im.rel} is ${im.w}×${im.h}; Meta recommends ${P.rec.join('×')}, and it will look soft on large phones.`, `Render it at ${P.rec.join('×')}.`));
    if (im.kb > P.maxMB * 1024) issues.push(issue('mb', 'error', `${im.rel} is over ${P.maxMB} MB.`, 'Save it as JPG at quality ~85.'));
    if (im.alpha) issues.push(issue('alpha', 'warn', `${im.rel} has transparency; Meta fills it, often with black or white.`, 'Flatten it onto a background.'));
  }
  const n = (k) => found.filter((f) => f.key === k).length;
  if (!n('feed')) issues.push(issue('missing-feed', 'error', 'No feed creative (4:5, 1440×1800 recommended; 1:1 also works). Feed is where most of the budget goes.', 'Render one at 1440×1800.'));
  if (!n('vertical')) issues.push(issue('missing-vertical', 'error', 'No 9:16 creative for Stories and Reels. Meta would fit the feed image into a 9:16 frame with bars or a blurred fill.', 'Render one at 1440×2560 with text inside the safe zone.'));
  const copy = readCopy(files);
  S._copy = copy;
  if (!copy || !copy.primary.length) issues.push(issue('missing-copy', 'warn', 'No ad copy found (copy.md with "Primary text:", "Headline:" and "Description:" lines). The sheet can\'t show where the apps cut it.', 'Write upload/copy.md.'));
  else {
    const T = A.text;
    copy.primary.forEach((t, i) => {
      if (t.length > T.primary) issues.push(issue('primary-long', 'warn', `Primary text ${i + 1} is ${t.length} characters; Meta recommends ${T.primary} for Instagram feed and Stories (the rest hides behind "… more"). Is the point and the offer in the first line?`, 'Lead with the offer; cut it to 125 or fewer.'));
      if (t.length > T.reelsPrimary) issues.push(issue('primary-reels', 'warn', `Primary text ${i + 1} is ${t.length} characters; on Reels Meta recommends ${T.reelsPrimary}, so only about the first line shows there.`, 'Make sure the first ~40 characters stand alone.'));
    });
    copy.headline.forEach((t, i) => {
      if (t.length > T.headline) issues.push(issue('headline-long', 'warn', `Headline ${i + 1} is ${t.length} characters; Meta recommends ${T.headline} (Instagram, Stories) and ${T.fbHeadline} for the Facebook feed.`, `Cut it to ${T.fbHeadline} or fewer.`));
      else if (t.length > T.fbHeadline) issues.push(issue('headline-fb', 'warn', `Headline ${i + 1} is ${t.length} characters; the Facebook feed recommends ${T.fbHeadline} (it's cut beside the button).`, `Cut it to ${T.fbHeadline} or fewer.`));
    });
    if (!copy.headline.length) issues.push(issue('missing-headline', 'warn', 'No headline in the copy; the feed shows one beside the button.', 'Add a headline of 27 characters or fewer.'));
  }
}

// Measured from the HTML each creative was made from (same base name): text and logos inside Meta's 9:16 safe zone,
// and the smallest text as it appears on a phone (the creative shown about 375 px wide). Palm's legibility floor of
// 11 px shown (about 42 px on a 1440-wide creative) is its own rule of thumb, not Meta's.
async function adSafeZone(S, page, files, found, issues) {
  const Z = S.ads.vertical.safe, PHONE = 375, MIN_SHOWN = 11;
  for (const f of found.filter((x) => x.key === 'vertical' || x.key === 'feed')) {
    const stem = basename(f.abs).replace(/\.\w+$/, '');
    const html = files.find((x) => /\.html?$/i.test(x) && basename(x).replace(/\.\w+$/, '') === stem) || files.find((x) => /\.html?$/i.test(x) && basename(x).replace(/\.\w+$/, '').startsWith(stem));
    if (!html && f.key === 'feed') continue;
    if (!html) { issues.push(issue('no-source', 'warn', `${f.file}: no HTML of the same name beside it, so Palm can't measure where its text sits. Check the sheet's dashed safe zone by eye.`, `Keep ${stem}.html next to it.`)); continue; }
    await page.setViewport({ width: f.w, height: f.h, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(html).href, { waitUntil: 'load', timeout: 30000 });
    await page.evaluate(() => document.fonts?.ready);
    const boxes = await page.evaluate(() => {
      const out = [];
      const vis = (e) => { const s = getComputedStyle(e); return s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0.05; };
      for (const e of document.querySelectorAll('body *')) {
        if (!vis(e)) continue;
        const own = [...e.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim());
        const isLogo = (e.tagName === 'IMG' || e.tagName === 'svg') && /logo|brand|mark/i.test((e.getAttribute('class') || '') + (e.id || '') + (e.getAttribute('alt') || '') + (e.getAttribute('src') || ''));
        if (!own.length && !isLogo) continue;
        let r;
        if (own.length) { const rg = document.createRange(); rg.selectNodeContents(e); r = rg.getBoundingClientRect(); } else r = e.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        out.push({ t: own.length ? own.map((n) => n.textContent.trim()).join(' ').slice(0, 40) : '[logo]', x: r.left, y: r.top, w: r.width, h: r.height, fs: own.length ? parseFloat(getComputedStyle(e).fontSize) : 0 });
      }
      return out;
    });
    const W = f.w, H = f.h, top = H * Z.top, bottom = H * (1 - Z.bottom), l = W * Z.side, rr = W * (1 - Z.side);
    const scale = PHONE / W, small = boxes.filter((b) => b.fs && b.fs * scale < MIN_SHOWN).sort((a, b) => a.fs - b.fs);
    if (small.length) issues.push(issue('text-small', 'error', `${f.file}: ${small.length} line${small.length > 1 ? 's' : ''} of text too small to read on a phone (the creative is shown about ${PHONE} px wide): ${small.slice(0, 4).map((b) => `"${b.t}" ${Math.round(b.fs)} px → ${(b.fs * scale).toFixed(1)} px on screen`).join('; ')}.`, `Make every line at least ${Math.ceil(MIN_SHOWN / scale)} px on this ${W}-wide creative, or cut it (fewer words, bigger type).`));
    if (f.key !== 'vertical') continue;
    const bad = boxes.filter((b) => b.y < top - 1 || b.y + b.h > bottom + 1 || b.x < l - 1 || b.x + b.w > rr + 1);
    f.safeZone = { measured: boxes.length, outside: bad.length };
    if (bad.length) issues.push(issue('safe-zone', 'error', `${f.file}: ${bad.length} text or logo element${bad.length > 1 ? 's' : ''} outside Meta's safe zone (keep about 14% top, 35% bottom, 6% sides clear in Stories and Reels): ${bad.slice(0, 4).map((b) => `"${b.t}" at y ${Math.round(b.y)}–${Math.round(b.y + b.h)}`).join('; ')}. The profile row, the caption and the call-to-action button cover these.`, `Move text and logos between y ${Math.round(top)} and ${Math.round(bottom)} and x ${Math.round(l)}–${Math.round(rr)}.`));
  }
}

// Pinterest: the pin images (any portrait images) and pins.md with each pin's title and description
// ("## Pin 1" sections with "Title:" and "Description:" lines, or just Title:/Description: lines in order).
export function readPinCopy(files) {
  const f = files.find((x) => /(^|[\/\\])pins?\.(md|txt)$/i.test(x)) || files.find((x) => /pin|copy|title/i.test(basename(x)) && /\.(md|txt)$/i.test(x) && !/readme|brief|post/i.test(basename(x)));
  if (!f) return null;
  const out = { file: f, title: [], description: [] };
  let cur = null;
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:[-*]\s*)?\**\s*(?:pin\s*\d+\s*)?(title|description)\s*\**\s*[:：]\s*\**\s*(.*?)\s*\**\s*$/i);
    if (m) { cur = m[1].toLowerCase(); out[cur].push(m[2].replace(/^["“]|["”]$/g, '')); continue; }
    if (/^\s*#{1,6}\s/.test(line) || /^\s*(---|\*\*\*)\s*$/.test(line)) { cur = null; continue; }
    if (cur && line.trim() && out[cur].length) { const L = out[cur]; L[L.length - 1] = (L[L.length - 1] ? L[L.length - 1] + ' ' : '') + line.trim(); }
    else if (!line.trim()) cur = cur === 'description' ? 'description' : null;
  }
  for (const k of ['title', 'description']) out[k] = out[k].map((x) => x.trim()).filter(Boolean);
  return out;
}

function pinArt(S, imgs, files, issues, found, used) {
  const P = S.pins;
  const pool = imgs.filter((im) => !/sheet|look|context|preview|mock|photo|raw|source|logo/i.test(basename(im.file)) && im.h > im.w * 1.05);
  for (const im of pool.sort((a, b) => a.rel.localeCompare(b.rel))) {
    used.add(im.file);
    found.push({ key: 'pin', label: 'Pin', file: im.rel, w: im.w, h: im.h, format: im.format, alpha: im.alpha, kb: im.kb, abs: im.file });
    const r = im.h / im.w;
    if (!['png', 'jpeg'].includes(im.format)) issues.push(issue('format', 'error', `${im.rel} is ${im.format.toUpperCase()}; Pinterest takes PNG or JPEG.`, 'Save it as PNG or JPEG.'));
    if (r > P.ratio * 1.02) issues.push(issue('pin-tall', 'warn', `${im.rel} is ${im.w}×${im.h} (1:${r.toFixed(2)}), taller than 2:3. Pinterest says pins taller than 2:3 might get cut off in people's feeds; the sheet draws where (at 2:3, Palm's assumption).`, 'Make it 1000×1500, or keep everything important in the top 2:3.'));
    else if (r < P.ratio * 0.92) issues.push(issue('pin-short', 'warn', `${im.rel} is ${im.w}×${im.h} (1:${r.toFixed(2)}); Pinterest recommends 2:3, and a shorter pin takes less of the feed.`, 'Make it 1000×1500.'));
    if (im.w < P.rec[0]) issues.push(issue('pin-small', 'warn', `${im.rel} is ${im.w} px wide; Pinterest recommends ${P.rec.join('×')}.`, `Render it at ${P.rec.join('×')}.`));
    if (im.kb > P.maxMB * 1024) issues.push(issue('mb', 'error', `${im.rel} is over ${P.maxMB} MB.`, 'Save it as JPEG at quality ~85.'));
    if (im.alpha) issues.push(issue('alpha', 'warn', `${im.rel} has transparency; Pinterest converts uploads to JPEG, so it gets a background.`, 'Flatten it.'));
  }
  if (!found.some((f) => f.key === 'pin')) issues.push(issue('missing-pin', 'error', 'No pin images (portrait PNG or JPEG; 1000×1500 recommended).', 'Render each pin with: render pin1.html --size 1000x1500 --out pins/pin1.png'));
  const copy = readPinCopy(files); S._pins = copy;
  const n = found.filter((f) => f.key === 'pin').length;
  if (!copy || !copy.title.length) issues.push(issue('missing-title', 'warn', 'No pin titles found (pins.md with a "Title:" and "Description:" line per pin). Titles show under pins in the feed and in search.', 'Write pins.md next to the images.'));
  else {
    if (copy.title.length < n) issues.push(issue('missing-title', 'warn', `${n} pins but ${copy.title.length} title${copy.title.length === 1 ? '' : 's'} in pins.md.`, 'Give every pin its own title.'));
    copy.title.forEach((t, i) => {
      if ([...t].length > P.titleMax) issues.push(issue('title-long', 'error', `Title ${i + 1} is ${[...t].length} characters; Pinterest takes up to ${P.titleMax}.`, `Cut it to ${P.titleMax}.`));
      else if ([...t].length > P.titleShown) issues.push(issue('title-cut', 'tip', `Title ${i + 1}: only about the first ${P.titleShown} characters may show in feeds: "${[...t].slice(0, P.titleShown).join('')}…". Are the words people search for in that part?`, 'Lead with the search words.'));
    });
    if (new Set(copy.title.map((t) => t.toLowerCase())).size < copy.title.length) issues.push(issue('title-same', 'warn', 'Two pins have the same title.', 'Give each pin its own angle and title.'));
    copy.description.forEach((t, i) => { if ([...t].length > P.descMax) issues.push(issue('desc-long', 'error', `Description ${i + 1} is ${[...t].length} characters; Pinterest takes up to ${P.descMax}.`, `Cut it to ${P.descMax}.`)); });
  }
}

// Measured on the pins themselves: text size as the feed shows it (from each pin's HTML of the same name), text under
// the desktop hover buttons, and pins that look alike at feed size (a small image hash).
async function pinMeasure(S, page, files, found, issues) {
  const P = S.pins, pins = found.filter((f) => f.key === 'pin');
  for (const f of pins) {
    const stem = basename(f.abs).replace(/\.\w+$/, '');
    const html = files.find((x) => /\.html?$/i.test(x) && basename(x).replace(/\.\w+$/, '') === stem);
    if (!html) { issues.push(issue('no-source', 'tip', `${f.file}: no HTML of the same name beside it, so Palm can't measure its text. Judge it on the sheet.`, `Keep ${stem}.html next to it.`)); continue; }
    await page.setViewport({ width: f.w, height: f.h, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(html).href, { waitUntil: 'load', timeout: 30000 });
    await page.evaluate(() => document.fonts?.ready);
    const boxes = await page.evaluate(() => {
      const out = [];
      for (const e of document.querySelectorAll('body *')) {
        const s = getComputedStyle(e); if (s.visibility === 'hidden' || s.display === 'none' || +s.opacity <= 0.05) continue;
        const own = [...e.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()); if (!own.length) continue;
        const rg = document.createRange(); rg.selectNodeContents(e); const r = rg.getBoundingClientRect(); if (r.width < 2 || r.height < 2) continue;
        out.push({ t: own.map((n) => n.textContent.trim()).join(' ').slice(0, 40), x: r.left, y: r.top, w: r.width, h: r.height, fs: parseFloat(s.fontSize) });
      }
      return out;
    });
    if (!boxes.length) continue;
    const k = P.phoneCol / f.w, cut = Math.min(f.h, f.w * P.ratio);
    const small = boxes.filter((b) => b.fs * k < P.minShown).sort((a, b) => a.fs - b.fs);
    if (small.length) issues.push(issue('text-small', 'warn', `${f.file}: ${small.length} line${small.length > 1 ? 's' : ''} of text too small to read in the phone feed (a pin is shown about ${P.phoneCol} px wide): ${small.slice(0, 3).map((b) => `"${b.t}" ${Math.round(b.fs)} px → ${(b.fs * k).toFixed(1)} px`).join('; ')}.`, `Make text at least ${Math.ceil(P.minShown / k)} px on this ${f.w}-wide pin, or cut it.`));
    const big = Math.max(...boxes.map((b) => b.fs));
    if (big * k < P.headShown) issues.push(issue('headline-small', 'warn', `${f.file}: the biggest text is ${Math.round(big)} px, about ${(big * k).toFixed(1)} px in the phone feed; a pin's headline has to read at a glance while scrolling.`, `Make the headline at least ${Math.ceil(P.headShown / k)} px.`));
    const hover = boxes.filter((b) => (b.x + b.w > f.w * 0.55 && b.y < f.h * 0.13) || b.y + b.h > Math.min(cut, f.h) * 0.88);
    if (hover.length) issues.push(issue('under-buttons', 'tip', `${f.file}: text in the top-right corner or along the bottom ("${hover[0].t}"), where Pinterest's Save button and link/share buttons sit on hover (desktop).`, 'Keep key words out of the top-right corner and the bottom strip.'));
    if (f.h > f.w * P.ratio * 1.02) { const lost = boxes.filter((b) => b.y + b.h > cut); if (lost.length) issues.push(issue('text-cut', 'warn', `${f.file}: "${lost[0].t}" is below the 2:3 line, where a too-tall pin may be cut off in the feed.`, 'Move it up, or make the pin 2:3.')); }
  }
  // Pins that look alike at feed size: a 9×8 difference hash (layout) plus a 3×3 colour grid, compared in pairs.
  if (pins.length > 1) {
    const hashes = [];
    for (const f of pins) {
      const data = `data:image/${f.format === 'png' ? 'png' : 'jpeg'};base64,${readFileSync(f.abs).toString('base64')}`;
      await page.setContent('<html><body></body></html>');
      hashes.push(await page.evaluate(async (src) => { const im = new Image(); im.src = src; await im.decode(); const c = document.createElement('canvas'); c.width = 9; c.height = 8; const x = c.getContext('2d'); x.drawImage(im, 0, 0, 9, 8); const d = x.getImageData(0, 0, 9, 8).data; let bits = ''; for (let y = 0; y < 8; y++) for (let i = 0; i < 8; i++) { const a = (y * 9 + i) * 4, b = a + 4; bits += (d[a] + d[a + 1] + d[a + 2]) > (d[b] + d[b + 1] + d[b + 2]) ? '1' : '0'; } c.width = 3; c.height = 3; x.drawImage(im, 0, 0, 3, 3); const g = [...x.getImageData(0, 0, 3, 3).data].filter((_, n) => n % 4 !== 3); return { bits, g }; }, data));
    }
    const close = [];
    for (let i = 0; i < pins.length; i++) for (let j = i + 1; j < pins.length; j++) { let dd = 0; for (let b = 0; b < 64; b++) if (hashes[i].bits[b] !== hashes[j].bits[b]) dd++; const cd = hashes[i].g.reduce((t, v, n) => t + Math.abs(v - hashes[j].g[n]), 0) / hashes[i].g.length; if (dd <= 10 && cd < 24) close.push(`${pins[i].file} and ${pins[j].file}`); }
    if (close.length) issues.push(issue('look-alike', 'warn', `Pins that look almost the same at feed size: ${close.join('; ')}. Variations work when each gives a different reason to click (another photo, layout or angle), not the same layout recoloured.`, 'Change the photo or the layout, not just the colours.'));
  }
}

// Google Business Profile: the logo, the cover, the post image (by file name) and every other image as a profile photo.
function gbpArt(S, imgs, files, issues, found, used) {
  const G = S.gbp;
  const pool = imgs.filter((im) => !/sheet|look|context|preview|mock/i.test(basename(im.file)) && !/(^|\/)(raw|source|originals?|input)\//i.test(im.rel));
  const pick = (re) => pool.filter((im) => re.test(basename(im.file))).sort((a, b) => a.rel.localeCompare(b.rel));
  const logo = pick(/logo/i)[0], cover = pick(/cover/i).find((im) => im !== logo), post = pick(/post|update|offer/i).find((im) => im !== logo && im !== cover);
  const add = (im, key, label) => { used.add(im.file); found.push({ key, label, file: im.rel, w: im.w, h: im.h, format: im.format, alpha: im.alpha, kb: im.kb, abs: im.file }); };
  if (logo) add(logo, 'logo', 'Logo'); else issues.push(issue('missing-logo', 'warn', 'No logo (a file with "logo" in its name). Google highlights the logo on the profile once its phone number and hours are filled in.', 'Add a square logo, e.g. 720×720.'));
  if (cover) add(cover, 'cover', 'Cover photo'); else issues.push(issue('missing-cover', 'warn', 'No cover photo (a file with "cover" in its name). It\'s set at the top of the profile, though Google says it isn\'t guaranteed to show first.', 'Choose the photo that best shows the place.'));
  if (post) add(post, 'post', 'Post image'); else issues.push(issue('missing-post-image', 'tip', 'No post image (a file with "post" in its name). Posts can have a photo; without one the update is text only.', 'Add one for this week\'s post.'));
  const photos = pool.filter((im) => !used.has(im.file));
  photos.forEach((im, i) => add(im, 'photo', `Photo ${i + 1}`));
  if (photos.length < 3) issues.push(issue('photos-few', 'tip', `${photos.length} profile photo${photos.length === 1 ? '' : 's'} besides the logo and cover. Google suggests photos of your storefront, products and services; an exterior photo helps customers recognise the place when they visit.`, 'Add a few real photos: outside, inside, the work.'));
  else if (!photos.some((im) => /exterior|outside|front|storefront|street/i.test(basename(im.file)))) issues.push(issue('no-exterior', 'tip', 'No photo named as the outside of the place. Google says an exterior photo helps customers recognise your business when they visit.', 'Include one of the shopfront, named e.g. exterior.jpg.'));
  for (const f of found) {
    if (!G.formats.includes(f.format)) issues.push(issue('format', 'error', `${f.file} is ${f.format.toUpperCase()}; Google takes JPG or PNG.`, 'Save it as JPG or PNG.'));
    if (f.kb < G.minKB) issues.push(issue('kb-small', 'error', `${f.file} is ${f.kb} KB; Google wants between ${G.minKB} KB and ${G.maxMB} MB.`, 'Export it at a higher quality.'));
    if (f.kb > G.maxMB * 1024) issues.push(issue('mb', 'error', `${f.file} is ${(f.kb / 1024).toFixed(1)} MB; Google takes up to ${G.maxMB} MB.`, 'Save it as JPG at quality ~85.'));
    if (f.w < G.min || f.h < G.min) issues.push(issue('too-small', 'error', `${f.file} is ${f.w}×${f.h}; Google's minimum is ${G.min}×${G.min}.`, `Use at least ${G.rec}×${G.rec}.`));
    else if (f.w < G.rec || f.h < G.rec) issues.push(issue('small', 'warn', `${f.file} is ${f.w}×${f.h}; Google recommends ${G.rec}×${G.rec}.`, `Make it at least ${G.rec} px on each side.`));
    if (f.key === 'logo' && Math.abs(f.w / f.h - 1) > 0.02) issues.push(issue('logo-shape', 'warn', `The logo is ${f.w}×${f.h}; it's shown small and round (see the sheet), so a non-square logo gets cropped.`, 'Make it square, with the mark centred and room around it.'));
    if (f.key === 'logo' && f.alpha) issues.push(issue('logo-alpha', 'tip', 'The logo has transparency; it sits on white in light mode and on dark grey in dark mode, so check both on the sheet.', 'Give it a solid background if either looks wrong.'));
  }
  // The post's text (post.md / post.txt): contact details in the text may get the post removed.
  const pf = files.find((x) => /(^|\/)(post|update|offer)[^/]*\.(md|txt)$/i.test(x));
  if (!pf) { S._post = null; issues.push(issue('missing-post-text', 'warn', 'No post text (post.md or post.txt).', 'Write this week\'s post in post.md (and a "Button:" line if it has one).')); }
  else {
    const raw = readFileSync(pf, 'utf8');
    const field = (k) => (raw.match(new RegExp(`^\\s*(?:\\*\\*)?${k}(?:\\*\\*)?\\s*:\\s*(.+)$`, 'im')) || [])[1]?.trim() || '';
    const btn = field('button'), title = field('title');
    const text = raw.split('\n').filter((l) => !/^\s*#/.test(l) && !/^\s*(\*\*)?(button|title|type|dates?|link|url|image|photo|coupon|terms)(\*\*)?\s*:/i.test(l)).join('\n').replace(/^\s*(\*\*)?(text|description|post)(\*\*)?\s*:\s*/im, '').trim();
    S._post = { text, btn, title };
    if (/(\+?\d[\d ()-]{7,}\d)/.test(text) || /[\w.+-]+@[\w-]+\.[\w.]+/.test(text) || /(^|\s)@[A-Za-z0-9_.]{2,}/.test(text)) issues.push(issue('post-contact', 'warn', 'The post text has a phone number, email address or social handle. Google may remove posts with unverified contact information.', 'Take it out and use a "Call now" button, which uses the profile\'s verified number.'));
    if (!text) issues.push(issue('missing-post-text', 'warn', `${basename(pf)} has no post text.`, 'Write the post.'));
    else if ([...text].length > G.card.chars) issues.push(issue('post-cut', 'tip', `The post is ${[...text].length} characters; a post card shows only its first lines before "More" (about ${G.card.chars} characters on the card drawn; Palm's estimate): "${[...text].slice(0, G.card.chars).join('').trim()}…". Is the offer and its date in that part?`, 'Lead with the offer and the date.'));
  }
}

// Measured from the HTML each image was made from (same name beside it): text added to profile photos (Google's photo
// criteria say to avoid it), text cut in the crops drawn, and post-image text too small on the card. On a Mac the words in
// the other photos are also read (signs in real photos count too, so that's only a tip).
async function gbpMeasure(S, page, files, found, issues) {
  const G = S.gbp;
  for (const f of found) {
    const stem = basename(f.abs).replace(/\.\w+$/, '');
    const html = files.find((x) => /\.html?$/i.test(x) && basename(x).replace(/\.\w+$/, '') === stem);
    if (!html) continue;
    await page.setViewport({ width: f.w, height: f.h, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(html).href, { waitUntil: 'load', timeout: 30000 });
    await page.evaluate(() => document.fonts?.ready);
    const boxes = await page.evaluate(() => {
      const out = [];
      for (const e of document.querySelectorAll('body *')) {
        const s = getComputedStyle(e); if (s.visibility === 'hidden' || s.display === 'none' || +s.opacity <= 0.05) continue;
        const own = [...e.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()); if (!own.length) continue;
        const rg = document.createRange(); rg.selectNodeContents(e); const r = rg.getBoundingClientRect(); if (r.width < 2 || r.height < 2) continue;
        out.push({ t: own.map((n) => n.textContent.trim()).join(' ').slice(0, 40), x: r.left, y: r.top, w: r.width, h: r.height, fs: parseFloat(s.fontSize) });
      }
      return out;
    });
    f._fromHtml = true;
    if (!boxes.length) continue;
    if (f.key === 'cover' || f.key === 'photo') issues.push(issue('photo-text', 'warn', `${f.file} has text added to it ("${boxes[0].t}"). Google's photo criteria say to avoid adding borders, text or collages to photos, and the cover may be swapped for a customer's photo anyway.`, 'Use the plain photo; put the offer in a post instead.'));
    if (f.key === 'logo') {
      const rad = Math.min(f.w, f.h) / 2, cx = f.w / 2, cy = f.h / 2;
      const out = boxes.filter((b) => [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]].some(([px, py]) => Math.hypot(px - cx, py - cy) > rad));
      if (out.length) issues.push(issue('logo-cut', 'warn', `Logo: "${out[0].t}" reaches outside the circle the logo is shown in.`, 'Keep the mark and any words inside the central circle.'));
      continue;
    }
    const crops = f.key === 'post' ? [['the post card', G.card.ratio]] : G.crops;
    for (const [where, r] of crops) {
      const ir = f.w / f.h; let x0 = 0, y0 = 0, x1 = f.w, y1 = f.h;
      if (ir > r) { const cw = f.h * r; x0 = (f.w - cw) / 2; x1 = x0 + cw; } else { const ch = f.w / r; y0 = (f.h - ch) / 2; y1 = y0 + ch; }
      const cut = boxes.filter((b) => b.x < x0 - 2 || b.x + b.w > x1 + 2 || b.y < y0 - 2 || b.y + b.h > y1 + 2);
      if (cut.length) issues.push(issue('text-cropped', 'warn', `${f.file}: "${cut[0].t}" is cut off in ${where} (a centred ${r === 1 ? 'square' : r.toFixed(2) + ':1'} crop; Palm's estimate of the layout).`, 'Keep words near the middle, or leave them off the photo.'));
    }
    if (f.key === 'post') {
      const k = G.card.w / f.w, small = boxes.filter((b) => b.fs * k < G.minShown);
      if (small.length) issues.push(issue('post-text-small', 'warn', `${f.file}: ${small.length} line${small.length > 1 ? 's' : ''} too small to read on the post card (about ${G.card.w} px wide): ${small.slice(0, 3).map((b) => `"${b.t}" ${Math.round(b.fs)} px → ${(b.fs * k).toFixed(1)} px`).join('; ')}.`, `Make text at least ${Math.ceil(G.minShown / k)} px on this ${f.w}-wide image, or cut it.`));
    }
  }
  const others = found.filter((f) => !f._fromHtml && (f.key === 'cover' || f.key === 'photo'));
  const read = readText(others.map((f) => f.abs));
  if (read) read.forEach(({ file, text }) => { if (text.length) issues.push(issue('photo-text-read', 'tip', `${others.find((f) => f.abs === file)?.file || basename(file)} shows words ("${text.slice(0, 3).join(' ').slice(0, 40)}"). Signs and labels in a real photo are fine; text added on top isn't (Google's photo criteria).`, 'If you added it, use the plain photo.')); });
}

// App Store In-App Event: the card (16:9) and details (9:16) media, matched by shape (file names break ties), and the
// metadata in event.md ("Name:", "Short description:", "Long description:", "Badge:", optional "App:", "Start:", "End:").
export function readEvent(files) {
  const f = files.find((x) => /(^|[\/\\])event[^/\\]*\.(md|txt)$/i.test(x)) || files.find((x) => /meta|copy/i.test(basename(x)) && /\.(md|txt)$/i.test(x) && !/readme|brief/i.test(basename(x)));
  if (!f) return null;
  const raw = readFileSync(f, 'utf8');
  const field = (re) => { const m = raw.match(new RegExp(`^\\s*(?:[-*]\\s*)?\\**\\s*(?:${re})\\s*\\**\\s*[:：]\\s*\\**\\s*(.+?)\\s*\\**\\s*$`, 'im')); return m ? m[1].replace(/^["“'`]|["”'`]$/g, '').trim() : ''; };
  return { file: f, name: field('event name|name|title'), short: field('short description|short'), long: field('long description|long'), badge: field('badge'), app: field('app name|app'), start: field('start(?: date)?'), end: field('end(?: date)?') };
}

function eventArt(S, imgs, files, issues, found, used) {
  const E = S.event;
  const pool = imgs.filter((im) => !/sheet|look|context|preview|mock|icon|screenshot|shot\d|raw|source/i.test(basename(im.file)));
  const near = (im, r) => Math.abs(im.w / im.h - r) / r < 0.01;
  const pick = (r, re) => { const c = pool.filter((im) => near(im, r) && !used.has(im.file)); return c.find((im) => re.test(basename(im.file))) || c[0]; };
  const card = pick(E.card.ratio, /card/i), details = pick(E.details.ratio, /detail/i);
  for (const [im, key, label, spec] of [[card, 'card', 'Event card', E.card], [details, 'details', 'Event details page', E.details]]) {
    if (!im) {
      const wrong = pool.find((x) => !used.has(x.file) && new RegExp(key === 'card' ? 'card' : 'detail', 'i').test(basename(x.file)));
      issues.push(issue('missing-' + key, 'error', `No ${label.toLowerCase()} image at ${key === 'card' ? '16:9' : '9:16'}${wrong ? ` (${wrong.rel} is ${wrong.w}×${wrong.h}, not ${key === 'card' ? '16:9' : '9:16'})` : ''}. Apple needs both: the card (16:9, ${spec.min.join('×')} to ${spec.max.join('×')}) and the details page (9:16, ${E.details.min.join('×')} to ${E.details.max.join('×')}).`, `Render it with: render ${key}.html --size ${spec.min.join('x')} --out ${key}.png`));
      continue;
    }
    used.add(im.file); found.push({ key, label, file: im.rel, w: im.w, h: im.h, format: im.format, alpha: im.alpha, kb: im.kb, abs: im.file });
    if (!E.formats.includes(im.format)) issues.push(issue('format', 'error', `${im.rel} is ${im.format.toUpperCase()}; Apple takes .jpg, .jpeg or .png for event images.`, 'Save it as PNG or JPEG.'));
    if (im.w < spec.min[0] || im.h < spec.min[1]) issues.push(issue('too-small', 'error', `${label} ${im.rel} is ${im.w}×${im.h}; Apple's minimum is ${spec.min.join('×')}.`, `Render it at ${spec.min.join('×')} or larger.`));
    if (im.w > spec.max[0] || im.h > spec.max[1]) issues.push(issue('too-big', 'error', `${label} ${im.rel} is ${im.w}×${im.h}; Apple's maximum is ${spec.max.join('×')}.`, `Render it at ${spec.max.join('×')} or smaller.`));
  }
  // The metadata.
  const m = readEvent(files); S._event = m;
  if (!m) { issues.push(issue('missing-metadata', 'error', 'No event metadata (event.md with "Name:", "Short description:", "Long description:" and "Badge:").', 'Write event.md next to the images.')); return; }
  const len = (t) => [...t].length;
  const price = /[$£€¥]\s?\d|\d+\s?%\s?off|\b\d+(?:[.,]\d\d)?\s?(?:usd|eur|gbp|jpy)\b|\bhalf[- ]price\b|\bfree trial\b/i;
  const types = /\b(challenge|competition|contest|live event|event|premiere|new season|season|major update|update)\b/i;
  const small = new Set(['a', 'an', 'the', 'and', 'but', 'or', 'for', 'nor', 'on', 'at', 'to', 'by', 'of', 'in', 'up', 'as', 'vs', 'with', 'from', 'into']);
  if (!m.name) issues.push(issue('missing-name', 'error', `${basename(m.file)} has no "Name:".`, 'Add the event name (up to 30 characters).'));
  else {
    if (len(m.name) > E.name) issues.push(issue('name-long', 'error', `The name "${m.name}" is ${len(m.name)} characters; Apple allows ${E.name}.`, `Cut it to ${E.name}.`));
    const letters = m.name.replace(/[^\p{L}]/gu, '');
    if (letters.length >= 4 && letters === letters.toUpperCase()) issues.push(issue('name-caps', 'warn', `The name "${m.name}" is in capitals; Apple says to avoid all capitals and use title case.`, 'Write it in title case.'));
    else { const low = m.name.split(/\s+/).filter((w, i) => /^\p{Ll}/u.test(w) && (i === 0 || !small.has(w.toLowerCase()))); if (low.length) issues.push(issue('name-case', 'warn', `The name "${m.name}" isn't in title case (${low.map((w) => `"${w}"`).join(', ')}); Apple asks for title case.`, 'Capitalise each main word.')); }
    if (/[!?.]{2,}|!.*!/.test(m.name)) issues.push(issue('name-punct', 'warn', `The name "${m.name}" has more than one punctuation mark; Apple says not to use multiple punctuation points.`, 'Keep the name plain.'));
    if (/^(join|get|download|watch|play|try|start|sign up|don'?t miss|tap|grab|claim|unlock|win|enter|come)\b/i.test(m.name)) issues.push(issue('name-cta', 'warn', `The name "${m.name}" reads as a call to action; Apple wants the event's actual name ("June Leaderboard Climb"), not a call to action or tagline.`, 'Name the event itself.'));
    const ty = m.name.match(types); if (ty) issues.push(issue('name-type', 'warn', `The name "${m.name}" says "${ty[0]}". Apple: avoid generic terms or describing the type of event, since the badge${m.badge ? ` (${m.badge})` : ''} already shows it above the name.`, 'Name what makes this event itself, and let the badge say what kind it is.'));
    if (m.app && m.name.toLowerCase().includes(m.app.toLowerCase())) issues.push(issue('name-app', 'tip', `The name repeats the app's name ("${m.app}"); the card already shows your app beside the event.`, 'Spend the 30 characters on the event.'));
  }
  if (!m.short) issues.push(issue('missing-short', 'error', `${basename(m.file)} has no "Short description:" (shown on the card).`, 'Add one, up to 50 characters.'));
  else if (len(m.short) > E.short) issues.push(issue('short-long', 'error', `The short description is ${len(m.short)} characters; Apple allows ${E.short}: "${m.short}".`, `Cut it to ${E.short}.`));
  if (!m.long) issues.push(issue('missing-long', 'error', `${basename(m.file)} has no "Long description:" (shown on the details page).`, 'Add one, up to 120 characters.'));
  else if (len(m.long) > E.long) issues.push(issue('long-long', 'error', `The long description is ${len(m.long)} characters; Apple allows ${E.long}.`, `Cut it to ${E.long}.`));
  for (const [k, t] of [['short', m.short], ['long', m.long]]) {
    if (!t) continue;
    const words = t.split(/\s+/).filter((w) => /^\p{L}/u.test(w)); const caps = words.slice(1).filter((w) => /^\p{Lu}\p{Ll}/u.test(w) && !small.has(w.toLowerCase()));
    if (words.length >= 4 && caps.length / Math.max(1, words.length - 1) > 0.6) issues.push(issue(k + '-case', 'tip', `The ${k} description looks like title case; Apple asks for sentence case.`, 'Capitalise only the first word and names.'));
  }
  for (const [where, t] of [['name', m.name], ['short description', m.short], ['long description', m.long]]) if (t && price.test(t)) issues.push(issue('price', 'error', `The ${where} mentions a price or discount ("${t.match(price)[0]}"). Apple: including specific pricing in event metadata leads to rejection.`, 'Take the price out; describe the event.'));
  if (!m.badge) issues.push(issue('missing-badge', 'warn', 'No "Badge:" chosen. The badge shows above the name on the card and details page.', `Pick one of: ${E.badges.join(', ')}.`));
  else if (!E.badges.some((b) => b.toLowerCase() === m.badge.toLowerCase())) issues.push(issue('badge', 'error', `"${m.badge}" isn't an App Store event badge.`, `Pick one of: ${E.badges.join(', ')}.`));
  const d0 = Date.parse(m.start), d1 = Date.parse(m.end);
  if (!isNaN(d0) && !isNaN(d1) && (d1 - d0) / 86400000 > E.maxDays + 0.01) issues.push(issue('too-long', 'error', `The event runs ${Math.round((d1 - d0) / 86400000)} days; Apple allows up to ${E.maxDays}.`, 'Shorten it, or split it into two events.'));
}

// Measured from the HTML each image was made from (same name beside it): any text in the media (Apple: avoid it, above all
// the event or app name), text under the gradient and words Apple lays over the lower part, and on the details page text
// in the sides an iPhone cuts off. Images without HTML are read with macOS Vision as a tip.
async function eventMeasure(S, page, files, found, issues) {
  const E = S.event, m = S._event || {};
  const [pw, ph] = E.phone, keep = (pw / ph) / E.details.ratio, side = (1 - keep) / 2;
  for (const f of found.filter((x) => x.key === 'card' || x.key === 'details')) {
    const stem = basename(f.abs).replace(/\.\w+$/, '');
    const html = files.find((x) => /\.html?$/i.test(x) && basename(x).replace(/\.\w+$/, '') === stem);
    if (!html) {
      const read = readText([f.abs]);
      const t = read?.[0]?.text || [];
      if (t.length) issues.push(issue('media-text-read', 'tip', `${f.file} seems to show words ("${t.slice(0, 3).join(' ').slice(0, 40)}"). Apple: avoid text or logos in event media, especially the event or app name; the App Store lays the name and description over it.`, 'Use art without words.'));
      continue;
    }
    await page.setViewport({ width: f.w, height: f.h, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(html).href, { waitUntil: 'load', timeout: 30000 });
    await page.evaluate(() => document.fonts?.ready);
    const boxes = await page.evaluate(() => {
      const out = [];
      for (const e of document.querySelectorAll('body *')) {
        const s = getComputedStyle(e); if (s.visibility === 'hidden' || s.display === 'none' || +s.opacity <= 0.05) continue;
        const own = [...e.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()); if (!own.length) continue;
        const rg = document.createRange(); rg.selectNodeContents(e); const r = rg.getBoundingClientRect(); if (r.width < 2 || r.height < 2) continue;
        out.push({ t: own.map((n) => n.textContent.trim()).join(' ').slice(0, 50), x: r.left, y: r.top, w: r.width, h: r.height });
      }
      return out;
    });
    if (!boxes.length) continue;
    const all = boxes.map((b) => b.t).join(' ').toLowerCase();
    const named = [m.name, m.app].filter(Boolean).find((n) => all.includes(n.toLowerCase()));
    issues.push(issue('media-text', named ? 'warn' : 'tip', `${f.file} has words in the image ("${boxes[0].t}"${boxes.length > 1 ? ` and ${boxes.length - 1} more` : ''})${named ? `, including "${named}"` : ''}. Apple: avoid text or logos in event media, especially the event or app name; the App Store shows the badge, name and description over it.`, 'Let the art carry the event; put the words in the metadata.'));
    const under = boxes.filter((b) => b.y + b.h > f.h * (1 - E.overlay));
    if (under.length) issues.push(issue(f.key + '-overlay', 'warn', `${f.file}: "${under[0].t}" sits in the lower ${Math.round(E.overlay * 100)}% where the App Store lays its gradient, the badge, the event name and the ${f.key === 'card' ? 'short description' : 'long description and buttons'} (Palm's estimate of the layout; see the sheet).`, 'Keep the lower part of the art calm, with nothing that has to be read.'));
    if (f.key === 'details') {
      const cut = boxes.filter((b) => b.x < f.w * side - 2 || b.x + b.w > f.w * (1 - side) + 2);
      if (cut.length) issues.push(issue('details-cut', 'warn', `${f.file}: "${cut[0].t}" is in the outer ${Math.round(side * 100)}% at the side, which a modern iPhone (${pw}×${ph}) cuts off when the 9:16 image fills the screen (Palm's estimate).`, 'Keep anything important in the middle of the details image.'));
    }
  }
}

// macOS Vision text reading for image files, compiled once (null where unavailable): the same approach as video-check's.
function readText(paths) {
  if (process.platform !== 'darwin' || !paths.length) return null;
  try {
    const req = createRequire(import.meta.url);
    const { spawnSync } = req('node:child_process'), { tmpdir } = req('node:os');
    const dir = join(tmpdir(), 'palm-store-art-ocr-v1'), bin = join(dir, 'ocr');
    if (!existsSync(bin)) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'ocr.swift'), [
        'import Foundation', 'import Vision', 'import AppKit', 'var out: [[String: Any]] = []',
        'for path in CommandLine.arguments.dropFirst() {',
        '  guard let img = NSImage(contentsOfFile: path), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { out.append(["file": path, "text": [String]()]); continue }',
        '  let r = VNRecognizeTextRequest()', '  r.recognitionLevel = .accurate',
        '  try? VNImageRequestHandler(cgImage: cg, options: [:]).perform([r])',
        '  var items: [String] = []',
        '  for o in (r.results ?? []) { if let c = o.topCandidates(1).first, c.confidence >= 0.5 { items.append(c.string) } }',
        '  out.append(["file": path, "text": items])', '}',
        'FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: out))', ''].join('\n'));
      const c = spawnSync('swiftc', ['-O', join(dir, 'ocr.swift'), '-o', bin], { encoding: 'utf8' });
      if (c.status !== 0) return null;
    }
    const r = spawnSync(bin, paths, { encoding: 'utf8', maxBuffer: 32 << 20 });
    if (r.status !== 0) return null;
    return JSON.parse(r.stdout).map((x) => ({ file: x.file, text: (x.text || []).filter((t) => /[\p{L}\p{N}]{3,}/u.test(t)) }));
  } catch { return null; }
}

// Social profiles: one avatar (square) and a banner per site, matched by shape (file names break ties).
function profileArt(S, imgs, issues, found, used) {
  const pool = imgs.filter((im) => !/sheet|look|context|preview/i.test(basename(im.file)));
  const ok = (im) => ['png', 'jpeg'].includes(im.format);
  const squares = pool.filter((im) => im.w === im.h).sort((a, b) => (S.avatar.hint.test(basename(b.file)) ? 1 : 0) - (S.avatar.hint.test(basename(a.file)) ? 1 : 0));
  const av = squares[0];
  if (!av) issues.push(issue('missing-avatar', 'error', 'No profile picture (a square image; 400×400 or larger works everywhere: X shows 400×400, YouTube renders 98×98, LinkedIn wants 400×400 for a Page logo).', 'Render one square avatar, e.g. --size 800x800.'));
  else {
    used.add(av.file); found.push({ key: 'avatar', label: 'Profile picture', file: av.rel, w: av.w, h: av.h, format: av.format, alpha: av.alpha, kb: av.kb, abs: av.file });
    if (av.w < S.avatar.min) issues.push(issue('avatar-small', 'warn', `The profile picture is ${av.w}×${av.h}; X and LinkedIn want 400×400.`, 'Render it at 800×800.'));
    if (av.kb > S.avatar.maxMB * 1024) issues.push(issue('avatar-mb', 'error', `The profile picture is ${(av.kb / 1024).toFixed(1)} MB; X takes up to ${S.avatar.maxMB} MB.`, 'Save it as JPG, or smaller.'));
    if (!ok(av)) issues.push(issue('avatar-format', 'error', `The profile picture is ${av.format.toUpperCase()}; use PNG or JPG (LinkedIn takes only those).`, 'Save it as PNG or JPG.'));
    if (av.alpha) issues.push(issue('avatar-alpha', 'warn', 'The profile picture has transparency. LinkedIn shows it on white and X/YouTube on light or dark, so the edges change from site to site.', 'Give it a solid background.'));
    for (const im of squares.slice(1)) if (!used.has(im.file)) { used.add(im.file); issues.push(issue('extra', 'warn', `${im.rel}: another square image; only one profile picture is used (name it "avatar" to choose).`, 'Remove it.')); }
  }
  for (const p of S.profiles) {
    let cand = pool.filter((im) => !used.has(im.file) && Math.abs(im.w / im.h - p.ratio) / p.ratio <= p.tol && !(p.not && p.not.test(basename(im.file))));
    cand.sort((a, b) => (p.hint.test(basename(b.file)) ? 1 : 0) - (p.hint.test(basename(a.file)) ? 1 : 0) || b.w - a.w);
    const im = cand[0];
    if (!im) { issues.push(issue('missing-' + p.key, 'warn', `No ${p.label} (${p.rec.join('×')}). Skip this if ${p.skip}.`, `Render it with --size ${p.rec.join('x')}.`)); continue; }
    used.add(im.file); found.push({ key: p.key, label: p.label, file: im.rel, w: im.w, h: im.h, format: im.format, alpha: im.alpha, kb: im.kb, abs: im.file });
    for (const x of cand.slice(1)) if (p.hint.test(basename(x.file)) === p.hint.test(basename(im.file)) && x.w === im.w) { used.add(x.file); issues.push(issue('extra', 'warn', `${x.rel}: a second ${p.label}; only one is used.`, 'Remove it.')); }
    if (p.old && im.w === p.old[0] && im.h === p.old[1]) issues.push(issue('old-size', 'error', `${p.label} ${im.rel} is ${im.w}×${im.h}, LinkedIn's old size. Pages now take ${p.rec.join('×')} (both minimum and recommended, 2026).`, `Render it at ${p.rec.join('×')}.`));
    else if (im.w < p.min[0] || im.h < p.min[1]) issues.push(issue('size-' + p.key, p.minLevel || 'error', `${p.label} ${im.rel} is ${im.w}×${im.h}; it needs at least ${p.min.join('×')}${p.rec[0] !== p.min[0] ? ` (${p.rec.join('×')} recommended)` : ''}.`, `Render it at ${p.rec.join('×')}.`));
    else if (p.key === 'youtube' && im.w < p.rec[0]) issues.push(issue('size-youtube', 'warn', `The YouTube banner is ${im.w}×${im.h}; YouTube recommends 2560×1440 so it's sharp on TVs.`, 'Render it at 2560×1440.'));
    if (p.maxMB && im.kb > p.maxMB * 1024) issues.push(issue('mb-' + p.key, p.maxLevel || 'error', `${p.label} is ${(im.kb / 1024).toFixed(1)} MB; the limit is ${p.maxMB} MB.`, 'Save it as JPG at quality ~85.'));
    if (!ok(im)) issues.push(issue('format-' + p.key, 'error', `${p.label} ${im.rel} is ${im.format.toUpperCase()}; use JPG or PNG.`, 'Save it as JPG or PNG.'));
    if (im.alpha) issues.push(issue('alpha-' + p.key, 'warn', `${p.label} ${im.rel} has transparency; sites fill it with their own background colour.`, 'Flatten it (render without --alpha).'));
  }
}

function walk(dir, out = []) {
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    if (f.name.startsWith('.') || f.name === 'node_modules') continue;
    const p = join(dir, f.name);
    if (f.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

// Opaque-ness of corners and edges, for icon rules (rounded corners on Play, padding on Chrome).
async function alphaProbe(page, file) {
  const url = 'data:image/png;base64,' + readFileSync(file).toString('base64');
  return page.evaluate(async (u) => {
    const img = new Image(); img.src = u; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const x = c.getContext('2d'); x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data, W = c.width, H = c.height;
    const a = (i, j) => d[(j * W + i) * 4 + 3];
    const corner = Math.min(a(0, 0), a(W - 1, 0), a(0, H - 1), a(W - 1, H - 1));
    let edge = 0, n = 0; const band = Math.max(1, Math.round(W / 8));
    for (let j = 0; j < H; j += 2) for (let i = 0; i < W; i += 2) if (i < band || j < band || i >= W - band || j >= H - band) { edge += a(i, j) > 20 ? 1 : 0; n++; }
    return { corner, center: a(W >> 1, H >> 1), edgeOpaque: edge / n };
  }, url);
}

async function htmlText(file) {
  const s = readFileSync(file, 'utf8').replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  return s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

// Apple Podcasts: one show cover (required) and episode art (optional, file names with "episode"), square 1400–3000.
function squareArt(S, imgs, files, issues, found, used, root) {
  const q = S.square;
  const isEp = (f) => /episode|(^|[^a-z])ep[\s_-]?\d/i.test(basename(f));
  const ep = imgs.filter((im) => isEp(im.file)), covers = imgs.filter((im) => !isEp(im.file) && !/sheet|look|context/i.test(basename(im.file))).sort((a, b) => (/cover|show/i.test(basename(b.file)) ? 1 : 0) - (/cover|show/i.test(basename(a.file)) ? 1 : 0));
  const one = (im, key, label) => {
    used.add(im.file); found.push({ key, label, file: im.rel, w: im.w, h: im.h, format: im.format, alpha: im.alpha, kb: im.kb, abs: im.file });
    if (im.w !== im.h) issues.push(issue('square-' + key, 'error', `${label} ${im.rel} is ${im.w}×${im.h}; it must be square.`, `Make it ${q.best}×${q.best}.`));
    else if (im.w < q.min || im.w > q.max) issues.push(issue('size-' + key, 'error', `${label} ${im.rel} is ${im.w}×${im.h}; Apple Podcasts accepts ${q.min}×${q.min} to ${q.max}×${q.max}.`, `Make it ${q.best}×${q.best}.`));
    else if (im.w < q.best) issues.push(issue('size-' + key, 'warn', `${label} is ${im.w}×${im.h}; Apple prefers the largest, ${q.best}×${q.best}.`, `Render it at ${q.best}×${q.best}.`));
    if (!q.formats.includes(im.format)) issues.push(issue('format-' + key, 'error', `${label} ${im.rel} is ${im.format.toUpperCase()}; it must be PNG or JPG.`, 'Save it as PNG or JPG.'));
    if (q.noAlpha && im.alpha) issues.push(issue('alpha-' + key, 'error', `${label} ${im.rel} has an alpha channel; Apple says artwork can't contain transparency and shouldn't have an alpha channel.`, 'Render it without --alpha (store-art flattens PNGs), or save as JPG.'));
  };
  if (!covers.length) issues.push(issue('missing-cover', 'error', `No show cover (square, ${q.min}–${q.max} px; ${q.best}×${q.best} preferred).`, `Render it with --size ${q.best}x${q.best}.`));
  else { one(covers[0], 'cover', 'Show cover'); for (const im of covers.slice(1)) issues.push(issue('extra', 'warn', `${im.rel}: only one show cover is used; name episode art with "episode" or "ep1" in the file name.`, 'Remove or rename it.')); }
  for (const im of ep) one(im, 'episode', 'Episode art');
  S._episodeHtml = files.filter((f) => isEp(f) && /\.html?$/i.test(f));
}

// Etsy / Shopify: every image is a listing photo, in file-name order (the first is the main photo).
function shopPhotos(S, imgs, issues, found, used) {
  const p = S.photos;
  const photos = imgs.filter((im) => !/sheet|look|context/i.test(basename(im.file))).sort((a, b) => a.rel.localeCompare(b.rel));
  if (photos.length < p.min) issues.push(issue('photos-count', 'error', `No listing photos found.`, 'Add them.'));
  photos.forEach((im, i) => {
    used.add(im.file); found.push({ key: i ? 'photo' : 'main', label: i ? `Photo ${i + 1}` : 'Main photo', file: im.rel, w: im.w, h: im.h, format: im.format, alpha: im.alpha, kb: im.kb, abs: im.file });
    if (!p.formats.includes(im.format)) issues.push(issue('format', 'error', `${im.rel} is ${im.format.toUpperCase()}; ${S.name} takes ${p.formats.map((f) => f.toUpperCase()).join(', ')}.`, 'Save it as JPG or PNG.'));
    if (p.noAlpha && im.alpha) issues.push(issue('alpha', 'error', `${im.rel} has transparency. ${p.noAlpha}`, 'Flatten it onto a background (render without --alpha, or save as JPG).'));
    if (p.firstMin && i === 0 && Math.min(im.w, im.h) < p.firstMin) issues.push(issue('main-small', 'error', `The first photo is ${im.w}×${im.h}; Etsy wants at least ${p.firstMin} px on each side or the listing shows lower in search.`, `Make it at least ${p.rec}×${p.rec}.`));
    else if (p.rec && Math.min(im.w, im.h) < p.rec) issues.push(issue('photo-small', 'warn', `${im.rel} is ${im.w}×${im.h}; Etsy recommends at least ${p.rec} px on each side.`, `Render it at ${p.rec} px or more.`));
    if (p.firstLandscapeOrSquare && i === 0 && im.h > im.w) issues.push(issue('main-portrait', 'error', `The first photo is portrait (${im.w}×${im.h}); Etsy says the first photo should be landscape or square so its thumbnails crop well.`, 'Make the first photo landscape or square, with a border the crops can lose.'));
    if (p.maxKBWarn && im.kb > p.maxKBWarn) issues.push(issue('photo-kb', 'warn', `${im.rel} is ${im.kb} KB; Etsy says images over 1 MB may not finish uploading on a slow connection.`, 'Save as JPG at quality ~85.'));
    if (p.maxSide && (im.w > p.maxSide || im.h > p.maxSide || im.w * im.h > p.maxMP * 1e6)) issues.push(issue('photo-big', 'error', `${im.rel} is ${im.w}×${im.h}; Shopify takes up to ${p.maxSide}×${p.maxSide} px or ${p.maxMP} megapixels.`, 'Make it smaller (2048×2048 for square photos).'));
    if (p.maxMB && im.kb > p.maxMB * 1024) issues.push(issue('photo-mb', 'error', `${im.rel} is over ${p.maxMB} MB.`, 'Compress it.'));
    if (p.squareRec && im.w === im.h && im.w < p.squareRec) issues.push(issue('photo-small', 'warn', `${im.rel} is ${im.w}×${im.h}; for square product photos Shopify says ${p.squareRec}×${p.squareRec} usually displays best.`, `Render it at ${p.squareRec}×${p.squareRec}.`));
  });
  if (p.sameRatio && photos.length > 1) {
    const r = (im) => (im.w / im.h).toFixed(2), first = r(photos[0]), odd = photos.filter((im) => r(im) !== first);
    if (odd.length) issues.push(issue('ratio-mixed', 'warn', `Not all photos share the main photo's aspect ratio (${photos[0].w}×${photos[0].h}): ${odd.map((x) => `${x.rel} ${x.w}×${x.h}`).join(', ')}. Shopify themes show images at the same size only with a consistent aspect ratio.`, 'Use one aspect ratio for the main photos.'));
  }
}

export async function check(store, folder, { out = 'art' } = {}) {
  const S = STORES[store];
  if (!S) throw new Error(`store must be one of: ${Object.keys(STORES).join(', ')}`);
  const root = resolve(folder);
  const files = walk(root);
  const imgs = files.filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f)).map((f) => {
    const b = readFileSync(f), info = imageInfo(b);
    return { file: f, rel: relative(root, f), kb: Math.round(b.length / 1024), ...info };
  }).filter((x) => x.w && x.h);
  const issues = [], found = [], used = new Set();

  // Steam: sizes it stopped accepting in Aug 2024.
  for (const [w, h, what] of S.old || []) for (const im of imgs) if (im.w === w && im.h === h) { issues.push(issue('old-size', 'error', `${im.rel} is ${w}×${h}, the old ${what}. Steam no longer accepts the old sizes (since Aug 2024).`, 'Make it at the current size.')); used.add(im.file); }

  if (S.square) squareArt(S, imgs, files, issues, found, used, root);
  if (S.photos) shopPhotos(S, imgs, issues, found, used);
  if (S.profiles) profileArt(S, imgs, issues, found, used);
  if (S.ads) adArt(S, imgs, files, issues, found, used);
  if (S.pins) pinArt(S, imgs, files, issues, found, used);
  if (S.gbp) gbpArt(S, imgs, files, issues, found, used);
  if (S.event) eventArt(S, imgs, files, issues, found, used);
  for (const a of S.assets || []) {
    let cand = imgs.filter((im) => !used.has(im.file) && (a.logo ? im.format === 'png' && ((im.w === 1280 && im.h <= 720) || (im.h === 720 && im.w <= 1280)) : im.w === a.w && im.h === a.h));
    if (a.hint && cand.length > 1) cand = cand.filter((im) => a.hint.test(im.rel)).concat(cand.filter((im) => !a.hint.test(im.rel)));
    else if (a.hint && cand.length === 1 && !a.hint.test(cand[0].rel) && S.assets.some((b) => b !== a && b.w === a.w && b.h === a.h)) cand = a.fallback ? [] : cand;
    const im = cand[0];
    if (!im) {
      if (a.required && a.fallback && found.some((f) => f.key === a.fallback)) issues.push(issue('missing-' + a.key, 'warn', `No ${a.label} (${a.w}×${a.h}); Steam falls back to the ${a.fallback} capsule.`, `Add one named with "library" in the file name if it should differ.`));
      else if (a.required) issues.push(issue('missing-' + a.key, 'error', `No ${a.label}${a.logo ? ' (PNG with transparency, 1280 wide and/or 720 tall)' : ` at exactly ${a.w}×${a.h}`}.`, 'Make it at that exact size (render <design.html> --size WxH).'));
      else if (a.recommended) issues.push(issue('missing-' + a.key, 'warn', `No ${a.label} (${a.w}×${a.h}). ${a.recommended}`, 'Add it.'));
      continue;
    }
    used.add(im.file); found.push({ key: a.key, label: a.label, file: im.rel, w: im.w, h: im.h, format: im.format, alpha: im.alpha, kb: im.kb, abs: im.file });
    if (a.png && im.format !== 'png') issues.push(issue('format-' + a.key, 'error', `${a.label} ${im.rel} is ${im.format.toUpperCase()}; it must be PNG.`, 'Save it as PNG.'));
    if (a.jpg && im.format !== 'jpeg') issues.push(issue('format-' + a.key, 'warn', `${a.label} ${im.rel} is ${im.format.toUpperCase()}; Steam asks for JPG.`, 'Save it as .jpg.'));
    if (a.noAlpha && im.alpha) issues.push(issue('alpha-' + a.key, 'error', `${a.label} ${im.rel} has an alpha channel; the store rejects it.`, 'Flatten it (render without --alpha, or save as JPEG).'));
    if (a.alpha && !im.alpha) issues.push(issue('alpha-' + a.key, 'error', `${a.label} ${im.rel} has no transparency; it's laid over the hero art.`, 'Render it with --alpha on a transparent background.'));
    if (a.maxKB && im.kb > a.maxKB) issues.push(issue('kb-' + a.key, 'error', `${a.label} is ${im.kb} KB (max ${a.maxKB} KB).`, 'Compress it.'));
  }

  // Screenshots: everything else that isn't one of the named assets.
  const sh = S.shots || { min: 0, label: 'Screenshots' }, shots = !S.shots ? [] : imgs.filter((im) => !used.has(im.file) && !/sheet|look|preview-|context/i.test(basename(im.file)));
  const good = [], bad = [];
  for (const im of shots) {
    const long = Math.max(im.w, im.h), short = Math.min(im.w, im.h); let why = null;
    if (sh.sizes && !sh.sizes.some(([w, h]) => im.w === w && im.h === h)) why = `${im.w}×${im.h}, not ${sh.sizes.map((s) => s.join('×')).join(' or ')}`;
    if (sh.minSide && (short < sh.minSide || long > sh.maxSide)) why = `${im.w}×${im.h}, outside ${sh.minSide}–${sh.maxSide} px`;
    else if (sh.ratio && long / short > sh.ratio + 1e-6) why = `${im.w}×${im.h}: the long side is ${(long / short).toFixed(2)}× the short side (max ${sh.ratio}×)`;
    if (sh.minW && (im.w < sh.minW || im.h < sh.minH)) why = `${im.w}×${im.h}, under ${sh.minW}×${sh.minH}`;
    else if (sh.ratio169 && Math.abs(im.w / im.h - 16 / 9) > 0.01) why = `${im.w}×${im.h} isn't 16:9`;
    if (why) { bad.push(im); issues.push(issue('shot-size', 'error', `${im.rel}: ${why}. It won't be accepted as a ${sh.label.toLowerCase().replace(/s$/, '')}.`, 'Remove it from the upload folder or remake it at an accepted size.')); continue; }
    if (sh.noAlpha && im.alpha) issues.push(issue('shot-alpha', 'error', `${im.rel} has an alpha channel; Play rejects it.`, 'Flatten it or save as JPEG.'));
    if (sh.maxMB && im.kb > sh.maxMB * 1024) issues.push(issue('shot-mb', 'error', `${im.rel} is over ${sh.maxMB} MB.`, 'Compress it.'));
    if (sh.recSide && short < sh.recSide) issues.push(issue('shot-small', 'warn', `${im.rel} is ${im.w}×${im.h}; Play wants at least 1080 px (e.g. 1080×1920) for its recommendations.`, 'Render at 1080×1920.'));
    good.push(im);
  }
  good.sort((a, b) => a.rel.localeCompare(b.rel));
  if (good.length < sh.min) issues.push(issue('shots-count', 'error', `${good.length} usable ${sh.label.toLowerCase()}; ${S.name} needs at least ${sh.min}.`, 'Add more.'));
  if (sh.max && good.length > sh.max) issues.push(issue('shots-count', 'error', `${good.length} ${sh.label.toLowerCase()}; ${S.name} takes at most ${sh.max}.`, 'Keep the best ones.'));
  if (sh.good && good.length >= sh.min && good.length < sh.good) issues.push(issue('shots-few', 'warn', `${good.length} screenshots; Play needs at least ${sh.good} (3 for games) for an app to be eligible for its recommendations.`, 'Add more.'));
  for (const im of good) found.push({ key: 'screenshot', label: sh.label, file: im.rel, w: im.w, h: im.h, format: im.format, kb: im.kb, abs: im.file });

  // Banned words in the HTML the graphics were made from.
  for (const f of S._episodeHtml || []) { const t = await htmlText(f); if (t.length) issues.push(issue('episode-text', 'error', `Episode art (${relative(root, f)}) has text ("${t.slice(0, 40)}"); Apple says to avoid any text or the podcast logo in episode art.`, 'Remove the text; let the image carry the episode.')); }
  for (const f of files.filter((x) => /\.html?$/i.test(x))) {
    const t = await htmlText(f), hits = [...new Set(S.words.map((r) => (t.match(r) || [])[0]).filter(Boolean))];
    if (hits.length) issues.push(issue('words', 'error', `${relative(root, f)} says ${hits.map((h) => `"${h}"`).join(', ')}. ${S.wordsWhy}`, 'Take those words out of the graphic.'));
    const a = found.find((x) => x.key === 'library-hero' && basename(x.file).replace(/\.\w+$/, '') === basename(f).replace(/\.\w+$/, ''));
    if (a && t.length > 0) issues.push(issue('hero-text', 'error', `The library hero (${relative(root, f)}) has text ("${t.slice(0, 40)}"); Steam wants no text at all on it (the logo is a separate file laid over it).`, 'Remove the text from the hero.'));
  }

  // Icon pixel rules and the sheet.
  const browser = await launch();
  let sheet = null;
  try {
    const page = await browser.newPage();
    const icon = found.find((x) => x.key === 'icon');
    if (icon && icon.format === 'png') {
      const p = await alphaProbe(page, icon.abs);
      if (store === 'google-play' && p.corner < 128 && p.center > 200) issues.push(issue('icon-rounded', 'warn', 'The icon\'s corners are transparent: it looks pre-rounded. Play applies its own mask (30% radius) and shadow, so a rounded icon ends up with a double edge or a halo.', 'Make the icon a full square; let Play round it.'));
      if (store === 'chrome-web-store' && p.edgeOpaque > 0.35) issues.push(issue('icon-padding', 'warn', `The icon's art reaches the edges (${Math.round(p.edgeOpaque * 100)}% of the outer 16 px is opaque). Chrome's spec is 96×96 art with 16 px of transparent padding each side.`, 'Shrink the art to 96×96 centred on a transparent 128×128.'));
    }
    if (S.ads) await adSafeZone(S, page, files, found, issues);
    if (S.pins) await pinMeasure(S, page, files, found, issues);
    if (S.gbp) await gbpMeasure(S, page, files, found, issues);
    if (S.event) await eventMeasure(S, page, files, found, issues);
    sheet = resolve(out + '-sheet.png');
    mkdirSync(dirname(sheet), { recursive: true });
    const html = drawSheet(store, found, S);
    const tmp = resolve(out + '-sheet.html');
    writeFileSync(tmp, html);
    await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(tmp).href, { waitUntil: 'load', timeout: 60000 });
    await page.evaluate(() => document.fonts?.ready);
    await new Promise((ok) => setTimeout(ok, 300));
    await page.screenshot({ path: sheet, fullPage: true });
  } finally { await browser.close(); }

  const errors = issues.filter((i) => i.level === 'error').length;
  return { ok: !errors, store, errors, warnings: issues.length - errors, found: found.map(({ abs, ...x }) => x), issues, sheet,
    look: `LOOK at ${sheet}: is the name readable at the smallest sizes? Does each piece make sense on its own? Is anything important in a cutoff zone or outside the safe area?` };
}

// ---------- the sheet: each asset where and how the store shows it ----------
function drawSheet(store, found, S) {
  const u = (k) => { const f = found.find((x) => x.key === k); return f ? pathToFileURL(f.abs).href : null; };
  const shots = found.filter((x) => x.key === 'screenshot').map((x) => pathToFileURL(x.abs).href);
  const img = (src, w, h, extra = '') => src ? `<img src="${src}" style="width:${w}px;height:${h}px;object-fit:cover;display:block;${extra}">` : `<div class="miss" style="width:${w}px;height:${h}px">missing</div>`;
  const css = `body{margin:0;font:14px/1.4 -apple-system,system-ui,sans-serif;background:#fff;color:#111}.sec{padding:22px 28px;border-bottom:1px solid #ddd}.sec h2{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:#666;margin:0 0 14px}
  .row{display:flex;gap:22px;align-items:flex-start;flex-wrap:wrap}.lab{font-size:12px;color:#666;margin-top:6px}.miss{background:repeating-linear-gradient(45deg,#fdd,#fdd 8px,#fee 8px,#fee 16px);color:#a00;display:flex;align-items:center;justify-content:center;font-size:12px}
  .dark{background:#111;color:#eee}.dark .lab{color:#aaa}.box{position:relative}.zone{position:absolute;border:2px dashed #ff2d55;pointer-events:none}`;
  let body = '';
  if (store === 'google-play') {
    const ic = u('icon'), fg = u('feature');
    const listRow = (bg, fgc) => `<div style="background:${bg};color:${fgc};padding:14px;border-radius:12px;width:330px">${[0, 1, 2].map((i) => `<div style="display:flex;gap:12px;align-items:center;margin:8px 0">${i === 1 ? img(ic, 48, 48, 'border-radius:14px;box-shadow:0 1px 3px rgba(0,0,0,.35)') : `<div style="width:48px;height:48px;border-radius:14px;background:${fgc === '#fff' ? '#333' : '#ddd'}"></div>`}<div><div style="font-weight:600">${i === 1 ? 'Your app' : 'Other app'}</div><div style="font-size:12px;opacity:.7">4.5 ★</div></div></div>`).join('')}</div>`;
    body += `<div class="sec"><h2>Icon, masked by Play (30% radius) in a list at 48 px, light and dark; and full size</h2><div class="row">${listRow('#fff', '#111')}${listRow('#1f1f1f', '#fff')}<div>${img(ic, 192, 192, 'border-radius:58px;box-shadow:0 2px 6px rgba(0,0,0,.3)')}<div class="lab">192 px, masked</div></div></div></div>`;
    body += `<div class="sec"><h2>Feature graphic: full size with the cutoff zones (keep logo, name and key UI inside the dashed box), and at phone width</h2><div class="row"><div class="box">${img(fg, 1024, 500)}<div class="zone" style="left:12%;right:12%;top:14%;bottom:14%"></div><div class="lab">1024×500. The dashed box is Palm's estimate of the safe centre; Google doesn't publish exact cutoff sizes.</div></div><div>${img(fg, 360, 176)}<div class="lab">360 px wide, as on a phone</div></div></div></div>`;
    body += `<div class="sec"><h2>Screenshots as the listing shows them (about 300 px tall), in order</h2><div class="row" style="flex-wrap:nowrap;overflow:hidden">${shots.slice(0, 8).map((s, i) => `<div>${`<img src="${s}" style="height:300px;display:block;border-radius:8px">`}<div class="lab">${i + 1}</div></div>`).join('') || '<div class="miss" style="width:300px;height:300px">no screenshots</div>'}</div></div>`;
  } else if (store === 'chrome-web-store') {
    const ic = u('icon'), st = u('small-tile'), mq = u('marquee');
    body += `<div class="sec"><h2>Icon on light and dark, at 128 and toolbar sizes (32, 16)</h2><div class="row">${['#fff', '#202124'].map((bg) => `<div style="background:${bg};padding:16px;display:flex;gap:18px;align-items:center;border-radius:8px">${img(ic, 128, 128)}${img(ic, 32, 32)}${img(ic, 16, 16)}</div>`).join('')}</div></div>`;
    body += `<div class="sec" style="background:#f1f3f4"><h2>Small promo tile on the store's grey page: at half size (220×140, the store says it must read there) among others, and full size</h2><div class="row">${[0, 1, 2].map((i) => `<div style="background:#fff;border-radius:8px;overflow:hidden;width:220px">${i === 1 ? img(st, 220, 140) : '<div style="width:220px;height:140px;background:#c9d3dc"></div>'}<div style="padding:8px;font-size:12px">${i === 1 ? '<b>Your extension</b>' : 'Other extension'}</div></div>`).join('')}<div>${img(st, 440, 280)}<div class="lab">440×280</div></div></div></div>`;
    body += `<div class="sec"><h2>Marquee tile (home page carousel), at 700×280</h2>${img(mq, 700, 280)}</div>`;
    body += `<div class="sec"><h2>Screenshots as shown (640×400)</h2><div class="row">${shots.slice(0, 5).map((s) => `<img src="${s}" style="width:640px;height:400px;object-fit:fill;display:block;border:1px solid #ddd">`).join('') || '<div class="miss" style="width:640px;height:400px">no screenshots</div>'}</div></div>`;
  } else if (store === 'apple-podcasts') {
    const cv = u('cover'), eps = found.filter((x) => x.key === 'episode').map((x) => pathToFileURL(x.abs).href);
    const list = (bg, fg, sz) => `<div style="background:${bg};color:${fg};padding:14px;border-radius:12px;width:360px">${[0, 1, 2, 3].map((i) => `<div style="display:flex;gap:12px;align-items:center;margin:8px 0">${i === 1 ? img(cv, sz, sz, 'border-radius:6px') : `<div style="width:${sz}px;height:${sz}px;border-radius:6px;background:hsl(${i * 80 + 20},45%,${fg === '#fff' ? 35 : 70}%)"></div>`}<div><div style="font-weight:600;font-size:13px">${i === 1 ? 'Your show' : 'Another show'}</div><div style="font-size:11px;opacity:.6">Episode · 42 min</div></div></div>`).join('')}</div>`;
    body += `<div class="sec"><h2>Show cover in a list at 60 px and in search at 44 px, light and dark: can you read the name? Would you know it again?</h2><div class="row">${list('#fff', '#111', 60)}${list('#1c1c1e', '#fff', 60)}${list('#fff', '#111', 44)}</div></div>`;
    body += `<div class="sec dark" style="background:linear-gradient(#3a3a5a,#121218)"><h2 style="color:#bbb">Lock screen / Now Playing (about 300 px), and full cover at 600 px</h2><div class="row"><div style="width:340px;padding:20px;border-radius:24px;background:rgba(255,255,255,.12)">${img(cv, 300, 300, 'border-radius:12px')}<div style="margin-top:10px;font-weight:600">Episode title</div><div style="font-size:12px;opacity:.7">Your show</div></div>${img(cv, 600, 600)}</div></div>`;
    if (eps.length) body += `<div class="sec"><h2>Episode art (${eps.length}): no text, no logo; shown on Now Playing and episode pages</h2><div class="row">${eps.slice(0, 6).map((e) => img(e, 240, 240, 'border-radius:8px')).join('')}</div></div>`;
  } else if (store === 'ads') {
    const copy = S?._copy || { primary: [], headline: [], description: [] };
    const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const P = esc(copy.primary[0] || ''), Hd = esc(copy.headline[0] || ''), D = esc(copy.description[0] || '');
    const feeds = found.filter((x) => x.key === 'feed').slice(0, 3), verts = found.filter((x) => x.key === 'vertical').slice(0, 3);
    const src = (f) => pathToFileURL(f.abs).href;
    const W = 375, Hs = 667; // phone width in CSS px; 9:16 screen
    const ava = (bg) => `<div style="width:32px;height:32px;border-radius:50%;background:${bg};flex:none"></div>`;
    // "clamp" boxes get "… more" when they overflow (script at the end of the sheet).
    const clamp = (txt, lines, more, style = '', bg = '#fff') => `<div class="clamp" data-more="${more}" data-bg="${bg}" style="display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:${lines};overflow:hidden;position:relative;white-space:pre-line;${style}">${txt || '<i style="opacity:.5">(no primary text)</i>'}</div>`;
    const fb = (f) => `<div style="width:${W}px;background:#fff;color:#050505;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.2);font:15px/1.34 -apple-system,system-ui,sans-serif">
      <div style="display:flex;gap:8px;align-items:center;padding:12px 12px 6px">${ava('#c9ccd1')}<div><div style="font-weight:600">Your brand</div><div style="font-size:12px;color:#65676b">Ad · 🌐</div></div></div>
      <div style="padding:0 12px 8px">${clamp(P, 3, 'See more')}</div>
      <img src="${src(f)}" style="width:${W}px;height:${Math.round(W * f.h / f.w)}px;object-fit:cover;display:block">
      <div style="display:flex;gap:10px;align-items:center;background:#f0f2f5;padding:10px 12px"><div style="flex:1;min-width:0"><div style="font-size:12px;color:#65676b;text-transform:uppercase">yourshop.com</div>${clamp(Hd ? `<b>${Hd}</b>` : '<i style="opacity:.5">(no headline)</i>', 1, '', 'font-size:16px')}${D ? clamp(D, 1, '', 'font-size:13px;color:#65676b') : ''}</div><div style="background:#e4e6eb;border-radius:6px;padding:8px 12px;font-weight:600;white-space:nowrap">Shop now</div></div></div>`;
    const ig = (f) => `<div style="width:${W}px;background:#000;color:#f5f5f5;font:14px/1.35 -apple-system,system-ui,sans-serif">
      <div style="display:flex;gap:8px;align-items:center;padding:10px 12px">${ava('#444')}<div><div style="font-weight:600">yourbrand</div><div style="font-size:11px;opacity:.7">Ad</div></div><div style="margin-left:auto">•••</div></div>
      <img src="${src(f)}" style="width:${W}px;height:${Math.round(W * f.h / f.w)}px;object-fit:cover;display:block">
      <div style="display:flex;justify-content:space-between;padding:11px 12px;border-bottom:1px solid #262626;font-weight:600">Shop now<span>›</span></div>
      <div style="padding:8px 12px 2px;font-size:20px;letter-spacing:6px">♡ ◯ ➤</div>
      <div style="padding:2px 12px 12px">${clamp(`<b>yourbrand</b> ${P}`, 2, 'more', '', '#000')}</div></div>`;
    const story = (f, zone) => `<div class="box" style="width:${W}px;height:${Hs}px;background:#111;overflow:hidden;border-radius:14px;color:#fff;font:14px/1.3 -apple-system,system-ui,sans-serif">
      <img src="${src(f)}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover">
      <div style="position:absolute;left:8px;right:8px;top:8px;display:flex;gap:3px">${[0, 1, 2].map((i) => `<div style="flex:1;height:2px;background:rgba(255,255,255,${i ? 0.4 : 0.95})"></div>`).join('')}</div>
      <div style="position:absolute;left:12px;right:12px;top:20px;display:flex;gap:8px;align-items:center;text-shadow:0 1px 2px rgba(0,0,0,.5)">${ava('rgba(255,255,255,.55)')}<b>yourbrand</b><span style="opacity:.85">Ad</span><span style="margin-left:auto;font-size:20px">✕</span></div>
      <div style="position:absolute;left:0;right:0;bottom:0;height:200px;background:linear-gradient(transparent,rgba(0,0,0,.55))"></div>
      <div style="position:absolute;left:16px;right:16px;bottom:96px;text-shadow:0 1px 2px rgba(0,0,0,.6)">${clamp(P, 2, 'more', '', 'rgba(30,30,30,.92)')}</div>
      <div style="position:absolute;left:50%;transform:translateX(-50%);bottom:40px;background:#fff;color:#000;border-radius:22px;padding:10px 22px;font-weight:600;white-space:nowrap">⌃ Shop now</div>
      ${zone ? `<div class="zone" style="left:${W * 0.06}px;right:${W * 0.06}px;top:${Hs * 0.14}px;bottom:${Hs * 0.35}px"></div>` : ''}</div>`;
    const reel = (f) => `<div class="box" style="width:${W}px;height:${Hs}px;background:#111;overflow:hidden;border-radius:14px;color:#fff;font:14px/1.3 -apple-system,system-ui,sans-serif">
      <img src="${src(f)}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover">
      <div style="position:absolute;left:14px;top:16px;font-size:20px;font-weight:700;text-shadow:0 1px 2px rgba(0,0,0,.5)">Reels</div>
      <div style="position:absolute;left:0;right:0;bottom:0;height:260px;background:linear-gradient(transparent,rgba(0,0,0,.6))"></div>
      <div style="position:absolute;right:12px;bottom:120px;display:flex;flex-direction:column;gap:20px;align-items:center;font-size:24px;text-shadow:0 1px 2px rgba(0,0,0,.6)"><span>♡</span><span>◯</span><span>➤</span><span>•••</span><div style="width:28px;height:28px;border-radius:6px;border:2px solid #fff;background:#555"></div></div>
      <div style="position:absolute;left:12px;right:64px;bottom:150px;display:flex;gap:8px;align-items:center;text-shadow:0 1px 2px rgba(0,0,0,.6)">${ava('rgba(255,255,255,.55)')}<b>yourbrand</b><span style="border:1px solid #fff;border-radius:6px;padding:1px 8px;font-size:12px">Follow</span></div>
      <div style="position:absolute;left:12px;right:64px;bottom:118px;text-shadow:0 1px 2px rgba(0,0,0,.6)">${clamp(P, 1, 'more', '', 'rgba(30,30,30,.92)')}</div>
      <div style="position:absolute;left:12px;right:64px;bottom:96px;font-size:12px;opacity:.85">Ad · ♫ Original audio</div>
      <div style="position:absolute;left:12px;right:12px;bottom:56px;background:rgba(255,255,255,.18);border-radius:8px;padding:9px 12px;font-weight:600;display:flex;justify-content:space-between">Shop now<span>›</span></div>
      <div style="position:absolute;left:0;right:0;bottom:0;height:46px;background:#000;display:flex;justify-content:space-around;align-items:center;font-size:18px;opacity:.95"><span>⌂</span><span>⌕</span><span>⊕</span><span>▶</span><span>◯</span></div></div>`;
    const lens = `${copy.primary.length} primary text${copy.primary.length === 1 ? '' : 's'} (first: ${copy.primary[0]?.length ?? 0} characters), ${copy.headline.length} headline${copy.headline.length === 1 ? '' : 's'} (first: ${copy.headline[0]?.length ?? 0})`;
    body += `<div class="sec" style="background:#f0f2f5"><h2>Feed at phone width: Facebook (light) and Instagram (dark), with the copy cut where the apps cut it (${lens}; line cuts are Palm's approximation of the apps)</h2><div class="row">${feeds.length ? feeds.map((f) => `<div>${fb(f)}<div class="lab">${esc(f.file)} · ${f.w}×${f.h}</div></div><div>${ig(f)}</div>`).join('') : `<div class="miss" style="width:${W}px;height:${W * 1.25}px">no feed creative (4:5)</div>`}</div></div>`;
    body += `<div class="sec dark" style="background:#1c1c1e"><h2 style="color:#aaa">Stories and Reels at phone size with the app's buttons over the creative; then Meta's safe zone (dashed: keep text and logos inside; about 14% top, 35% bottom, 6% sides)</h2>${verts.length ? verts.map((f) => `<div class="row" style="margin-bottom:18px"><div>${story(f, false)}<div class="lab">Stories · ${esc(f.file)} · ${f.w}×${f.h}</div></div><div>${reel(f)}<div class="lab">Reels</div></div><div>${story(f, true)}<div class="lab">Meta's safe zone</div></div></div>`).join('') : `<div class="miss" style="width:${W}px;height:${Hs}px">no 9:16 creative for Stories and Reels</div>`}</div>`;
    body += `<script>for (const e of document.querySelectorAll('.clamp')) { if (e.scrollHeight > e.clientHeight + 1 && e.dataset.more) { const m = document.createElement('span'); m.textContent = '… ' + e.dataset.more; m.style.cssText = 'position:absolute;right:0;bottom:0;padding:0 0 0 6px;font-weight:600;background:' + e.dataset.bg + ';color:inherit'; e.appendChild(m); } }</script>`;
  } else if (store === 'pinterest') {
    const P = S.pins, copy = S?._pins || { title: [], description: [] };
    const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const pins = found.filter((x) => x.key === 'pin').map((f, i) => ({ ...f, src: pathToFileURL(f.abs).href, title: copy.title[i] || '' }));
    const shown = (t) => { const c = [...t]; return c.length > P.titleShown ? esc(c.slice(0, P.titleShown).join('').trimEnd()) + '…' : esc(t); };
    // Other people's pins around yours: soft blocks at varied heights, so the feed looks like a feed.
    const others = [1.5, 1.25, 1, 1.78, 1.33, 1.5, 1.2, 1.6, 1.0, 1.4, 1.5, 1.3, 1.75, 1.1, 1.5, 1.25, 1.45, 1.0];
    const feed = (cols, colW, gap, dark, n) => {
      const items = []; let oi = 0, pi = 0;
      for (let k = 0; k < n; k++) { const mine = pins.length && (k === 1 || k === 6 || k === 8 || k === 12 || k === 15) && pi < pins.length; items.push(mine ? { pin: pins[pi++] } : { r: others[oi++ % others.length], hue: (k * 47) % 360 }); }
      while (pi < pins.length) items.splice(Math.min(items.length, 3 + pi * 4), 0, { pin: pins[pi++] });
      const col = Array.from({ length: cols }, () => ({ h: 0, html: '' }));
      for (const it of items) {
        const c = col.reduce((a, b) => (b.h < a.h ? b : a));
        const r = it.pin ? it.pin.h / it.pin.w : it.r, hh = Math.round(colW * Math.min(r, P.ratio));
        const cutLine = it.pin && r > P.ratio * 1.02 ? `<div style="position:absolute;left:0;right:0;bottom:0;border-bottom:3px dashed #e60023"></div><div style="position:absolute;right:4px;bottom:6px;background:#e60023;color:#fff;font-size:10px;padding:1px 4px;border-radius:3px">cut at 2:3</div>` : '';
        const cap = it.pin ? `<div style="font-weight:600;font-size:${colW > 200 ? 14 : 12}px;line-height:1.25;margin:6px 2px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${it.pin.title ? shown(it.pin.title) : '<i style="opacity:.5">(no title)</i>'}</div>` : `<div style="height:8px;margin:8px 2px 0;width:${40 + (it.hue % 50)}%;background:${dark ? '#333' : '#e9e9e9'};border-radius:4px"></div>`;
        c.html += `<div style="margin-bottom:${gap}px"><div style="position:relative;width:${colW}px;height:${hh}px;border-radius:${colW > 200 ? 16 : 12}px;overflow:hidden;${it.pin ? '' : `background:hsl(${it.hue},14%,${dark ? 26 : 84}%)`}">${it.pin ? `<img src="${it.pin.src}" style="width:100%;height:100%;object-fit:cover;object-position:top;display:block">${cutLine}` : ''}</div>${cap}</div>`;
        c.h += hh + gap + 26;
      }
      return `<div style="display:flex;gap:${gap}px;align-items:flex-start;background:${dark ? '#111' : '#fff'};color:${dark ? '#eee' : '#111'};padding:${gap}px;border-radius:10px">${col.map((c) => `<div style="width:${colW}px">${c.html}</div>`).join('')}</div>`;
    };
    const hover = (f) => { const colW = P.desktopCol, hh = Math.round(colW * Math.min(f.h / f.w, P.ratio)); return `<div><div style="position:relative;width:${colW}px;height:${hh}px;border-radius:16px;overflow:hidden"><img src="${f.src}" style="width:100%;height:100%;object-fit:cover;object-position:top;display:block"><div style="position:absolute;inset:0;background:rgba(0,0,0,.32)"></div><div style="position:absolute;top:10px;left:10px;color:#fff;font-weight:600;font-size:14px">Profile ⌄</div><div style="position:absolute;top:8px;right:8px;background:#e60023;color:#fff;font-weight:700;border-radius:20px;padding:10px 14px">Save</div><div style="position:absolute;left:8px;bottom:8px;background:rgba(255,255,255,.92);border-radius:16px;padding:6px 10px;font-size:12px;font-weight:600;max-width:55%;white-space:nowrap;overflow:hidden">↗ yoursite.com</div><div style="position:absolute;right:8px;bottom:8px;display:flex;gap:6px">${['⤴', '•••'].map((t) => `<div style="width:32px;height:32px;border-radius:50%;background:rgba(255,255,255,.92);display:grid;place-items:center;font-size:12px">${t}</div>`).join('')}</div></div><div class="lab">${esc(f.file)} · hover on desktop</div></div>`; };
    const phone = (dark) => `<div style="width:390px;border-radius:24px;overflow:hidden;border:1px solid ${dark ? '#333' : '#ddd'}">${feed(2, P.phoneCol, 8, dark, 9)}</div>`;
    const list = pins.map((f, i) => `<div style="width:300px"><img src="${f.src}" style="width:300px;display:block;border-radius:12px"><div class="lab">${esc(f.file)} · ${f.w}×${f.h} · title ${[...(f.title || '')].length} characters${copy.description[i] ? ` · description ${[...copy.description[i]].length}` : ''}</div><div style="font-size:12px;margin-top:4px;overflow-wrap:anywhere"><b>${esc(f.title) || '<i>(no title)</i>'}</b></div></div>`).join('');
    body += `<div class="sec"><h2>Home feed on a desktop (about ${P.desktopCol} px columns; Palm's estimate of the layout): titles cut at the ${P.titleShown} characters Pinterest says may show; anything taller than 2:3 drawn cut</h2>${pins.length ? feed(5, P.desktopCol, 16, false, 18) : '<div class="miss" style="width:236px;height:354px">no pins</div>'}</div>`;
    body += `<div class="sec" style="background:#f3f3f3"><h2>In the app on a phone, two columns about ${P.phoneCol} px wide, light and dark</h2><div class="row">${phone(false)}${phone(true)}</div></div>`;
    body += `<div class="sec"><h2>On hover (desktop): the Save button and link and share buttons sit over these corners</h2><div class="row">${pins.map(hover).join('')}</div></div>`;
    body += `<div class="sec"><h2>Each pin larger, with its title</h2><div class="row">${list}</div></div>`;
  } else if (store === 'gbp') {
    const G = S.gbp, post = S?._post || null;
    const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const F = (k) => found.find((x) => x.key === k), src = (f) => f ? pathToFileURL(f.abs).href : null;
    const cv = F('cover'), lg = F('logo'), pi = F('post'), photos = found.filter((x) => x.key === 'photo');
    const pic = (f, w, h, extra = '') => f ? `<img src="${src(f)}" style="width:${w}px;height:${h}px;object-fit:cover;display:block;${extra}">` : `<div class="miss" style="width:${w}px;height:${h}px">no ${extra.includes('round') ? 'logo' : 'photo'}</div>`;
    const logo = (sz, ring) => lg ? `<img src="${src(lg)}" style="width:${sz}px;height:${sz}px;object-fit:cover;border-radius:50%;display:block;flex:none;box-shadow:0 0 0 1px ${ring}">` : `<div class="miss" style="width:${sz}px;height:${sz}px;border-radius:50%;flex:none">logo</div>`;
    const th = (dark) => dark ? { bg: '#202124', fg: '#e8eaed', mute: '#9aa0a6', line: '#3c4043', chip: '#303134', link: '#8ab4f8' } : { bg: '#fff', fg: '#202124', mute: '#70757a', line: '#dadce0', chip: '#f1f3f4', link: '#1a0dab' };
    const head = (t, sz = 40) => `<div style="display:flex;gap:12px;align-items:center;margin:12px 0 6px">${logo(sz, t.line)}<div><div style="font-size:20px;color:${t.fg}">Your business</div><div style="font-size:13px;color:${t.mute}">4.8 <span style="color:#fbbc04">★★★★★</span> (126) · Local business</div></div></div>`;
    const chips = (t) => `<div style="display:flex;gap:8px;margin:8px 0">${['Website', 'Directions', 'Save', 'Call'].map((c) => `<div style="border:1px solid ${t.line};border-radius:16px;padding:5px 12px;font-size:13px;color:${t.link}">${c}</div>`).join('')}</div>`;
    const card = (t, w = G.card.w) => `<div style="width:${w}px;border:1px solid ${t.line};border-radius:12px;overflow:hidden;background:${t.bg};color:${t.fg};font-size:13px;line-height:1.4">${pi ? pic(pi, w, Math.round(w / G.card.ratio)) : ''}<div style="padding:10px 12px"><div style="font-size:12px;color:${t.mute};margin-bottom:4px">Your business · 2 days ago</div>${post?.title ? `<div style="font-weight:600;margin-bottom:2px">${esc(post.title)}</div>` : ''}<div class="clamp" data-more="More" data-bg="${t.bg}" style="display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:${G.card.lines};overflow:hidden;position:relative;white-space:pre-line">${post?.text ? esc(post.text) : '<i style="opacity:.5">(no post text)</i>'}</div>${post?.btn ? `<div style="margin-top:8px;color:${t.link};font-weight:600">${esc(post.btn)}</div>` : ''}</div></div>`;
    const deskPanel = (dark) => { const t = th(dark); const ph = (i, w, h) => photos[i] ? pic(photos[i], w, h) : `<div style="width:${w}px;height:${h}px;background:${t.chip}"></div>`;
      return `<div style="width:370px;background:${t.bg};color:${t.fg};border:1px solid ${t.line};border-radius:12px;padding:0 0 14px;overflow:hidden;font:14px/1.4 Arial,sans-serif"><div style="display:flex;gap:2px;height:178px">${pic(cv, 237, 178)}<div style="display:flex;flex-direction:column;gap:2px">${ph(0, 131, 88)}${ph(1, 131, 88)}</div></div><div style="padding:0 16px">${head(t)}${chips(t)}<div style="font-size:13px;color:${t.mute};margin:10px 0 8px">Updates from the business</div>${card(t)}</div></div>`; };
    const phoneSearch = (dark) => { const t = th(dark); const strip = [cv, ...photos].filter(Boolean).slice(0, 4);
      return `<div style="width:390px;background:${t.bg};color:${t.fg};border:1px solid ${t.line};border-radius:24px;padding:14px 0;overflow:hidden;font:14px/1.4 Arial,sans-serif"><div style="padding:0 16px">${head(t, 36)}${chips(t)}</div><div style="display:flex;gap:4px;padding:6px 16px;overflow:hidden">${strip.length ? strip.map((f, i) => pic(f, i === 0 ? 213 : 160, 160, `border-radius:${i === 0 ? '12px 0 0 12px' : '0'}`)).join('') : '<div class="miss" style="width:213px;height:160px">no photos</div>'}</div><div style="padding:10px 16px 0">${card(t, 300)}</div></div>`; };
    const mapsPhone = (dark) => { const t = th(dark);
      return `<div style="width:390px;background:${t.bg};color:${t.fg};border-radius:24px;overflow:hidden;border:1px solid ${t.line};font:14px/1.4 Arial,sans-serif">${pic(cv, 390, 210)}<div style="padding:4px 16px 16px">${head(t, 40)}<div style="display:flex;gap:8px;margin-top:8px">${['Directions', 'Start', 'Call', 'Save', 'Share'].map((c, i) => `<div style="border-radius:18px;padding:7px 12px;font-size:13px;${i === 0 ? 'background:#1a73e8;color:#fff' : `background:${t.chip};color:${t.link}`}">${c}</div>`).join('')}</div></div></div>`; };
    const mapsDesk = (dark) => { const t = th(dark);
      return `<div style="width:408px;background:${t.bg};color:${t.fg};border:1px solid ${t.line};overflow:hidden;font:14px/1.4 Arial,sans-serif">${pic(cv, 408, 240)}<div style="padding:6px 20px 16px">${head(t, 40)}</div></div>`; };
    const cropBox = (f) => { if (!f) return ''; const W = 520, H = Math.round(W * f.h / f.w); const ir = f.w / f.h;
      const boxes = G.crops.map(([where, r], i) => { let x0 = 0, y0 = 0, w = W, h = H; if (ir > r) { w = H * r; x0 = (W - w) / 2; } else { h = W / r; y0 = (H - h) / 2; } return `<div class="zone" style="left:${x0}px;top:${y0}px;width:${w}px;height:${h}px;border-color:${['#ff2d55', '#1a73e8', '#f29900', '#188038'][i]}"></div>`; }).join('');
      return `<div><div class="box" style="width:${W}px;height:${H}px">${pic(f, W, H)}${boxes}</div><div class="lab">${esc(f.file)} · ${f.w}×${f.h} · crops: <span style="color:#ff2d55">Search desktop 4:3</span>, <span style="color:#1a73e8">Maps phone</span>, <span style="color:#f29900">Maps desktop</span>, <span style="color:#188038">grid square</span> (Palm's estimates)</div></div>`; };
    body += `<div class="sec"><h2>Google Search on a desktop: the profile panel, light and dark (the photo block, logo and post card are Palm's estimate of Google's layout; Google publishes no display sizes)</h2><div class="row">${deskPanel(false)}${deskPanel(true)}</div></div>`;
    body += `<div class="sec" style="background:#f1f3f4"><h2>Google Search on a phone, light and dark: the photo strip and this week's post</h2><div class="row">${phoneSearch(false)}${phoneSearch(true)}</div></div>`;
    body += `<div class="sec"><h2>Google Maps: the place sheet on a phone (light and dark) and the side panel on a desktop, with the cover across the top</h2><div class="row">${mapsPhone(false)}${mapsPhone(true)}${mapsDesk(false)}</div></div>`;
    body += `<div class="sec"><h2>Photos tab: every profile photo as a square thumbnail (${photos.length + (cv ? 1 : 0)}), and the logo at 40 px on light and dark and at 96 px</h2><div class="row" style="align-items:flex-end">${[cv, ...photos].filter(Boolean).map((f) => `<div>${pic(f, 120, 120)}<div class="lab">${esc(f.file)}</div></div>`).join('') || '<div class="miss" style="width:120px;height:120px">no photos</div>'}<div style="display:flex;gap:14px;align-items:center;background:#fff;padding:12px;border:1px solid #dadce0;border-radius:10px">${logo(40, '#dadce0')}${logo(96, '#dadce0')}</div><div style="display:flex;gap:14px;align-items:center;background:#202124;padding:12px;border-radius:10px">${logo(40, '#3c4043')}${logo(96, '#3c4043')}</div></div></div>`;
    body += `<div class="sec"><h2>The cover (and the post image) larger, with where each view crops it</h2><div class="row">${cropBox(cv)}${pi ? `<div><div class="box" style="width:400px;height:${Math.round(400 * pi.h / pi.w)}px">${pic(pi, 400, Math.round(400 * pi.h / pi.w))}${(() => { const ir = pi.w / pi.h, r = G.card.ratio, W = 400, H = Math.round(400 * pi.h / pi.w); let x0 = 0, y0 = 0, w = W, h = H; if (ir > r) { w = H * r; x0 = (W - w) / 2; } else { h = W / r; y0 = (H - h) / 2; } return `<div class="zone" style="left:${x0}px;top:${y0}px;width:${w}px;height:${h}px"></div>`; })()}</div><div class="lab">${esc(pi.file)} · ${pi.w}×${pi.h} · dashed: the post card's 4:3 crop (Palm's estimate)</div></div>` : ''}</div></div>`;
    body += `<script>for (const e of document.querySelectorAll('.clamp')) { if (e.scrollHeight > e.clientHeight + 1 && e.dataset.more) { const m = document.createElement('span'); m.textContent = '… ' + e.dataset.more; m.style.cssText = 'position:absolute;right:0;bottom:0;padding:0 0 0 6px;font-weight:600;background:' + e.dataset.bg + ';color:inherit'; e.appendChild(m); } }</script>`;
  } else if (store === 'event') {
    const E = S.event, m = S._event || {};
    const esc = (t) => String(t || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const F = (k) => found.find((x) => x.key === k), src = (f) => f ? pathToFileURL(f.abs).href : null;
    const cd = F('card'), dt = F('details');
    const badge = esc((m.badge || 'Badge').toUpperCase()), name = esc(m.name || '(no name)'), short = esc(m.short || '(no short description)'), long = esc(m.long || '(no long description)'), app = esc(m.app || 'Your app');
    const th = (dark) => dark ? { bg: '#000', card: '#1c1c1e', fg: '#fff', mute: '#98989d', btn: '#2c2c2e', link: '#0a84ff' } : { bg: '#f2f2f7', card: '#fff', fg: '#000', mute: '#6e6e73', btn: '#eeeef0', link: '#007aff' };
    const icon = (sz) => `<div style="width:${sz}px;height:${sz}px;border-radius:${Math.round(sz * 0.22)}px;background:linear-gradient(135deg,#8e8e93,#48484a);flex:none"></div>`;
    const get = (t) => `<div style="background:${t.btn};color:${t.link};font-weight:700;font-size:15px;border-radius:14px;padding:4px 16px">Get</div>`;
    // The card: the 16:9 media with Apple's gradient and words over its lower part (Palm's estimate of the layout).
    const card = (t, w = 343, label = 'HAPPENING NOW') => { const h = Math.round(w * 9 / 16);
      return `<div style="width:${w}px"><div style="font-size:11px;font-weight:600;color:${t.mute};margin:0 0 6px 2px;letter-spacing:.02em">${label}</div><div style="position:relative;width:${w}px;height:${h}px;border-radius:12px;overflow:hidden;background:#333">${cd ? `<img src="${src(cd)}" style="width:100%;height:100%;object-fit:cover;display:block">` : '<div class="miss" style="width:100%;height:100%">no card image</div>'}<div style="position:absolute;inset:auto 0 0 0;height:${Math.round(E.overlay * 100)}%;background:linear-gradient(transparent,rgba(0,0,0,.72))"></div><div style="position:absolute;left:14px;right:14px;bottom:12px;color:#fff"><div style="font-size:11px;font-weight:700;opacity:.85;letter-spacing:.04em">${badge}</div><div style="font-size:19px;font-weight:700;line-height:1.15">${name}</div><div style="font-size:13px;opacity:.9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${short}</div></div></div><div style="display:flex;gap:10px;align-items:center;margin-top:8px">${icon(34)}<div style="flex:1;font-size:13px;color:${t.fg}">${app}<div style="font-size:12px;color:${t.mute}">In-app event</div></div>${get(t)}</div></div>`; };
    const phone = (t, inner) => `<div style="width:390px;background:${t.bg};color:${t.fg};border-radius:28px;padding:18px 0;overflow:hidden;font:15px/1.35 -apple-system,system-ui,sans-serif;border:1px solid #c7c7cc">${inner}</div>`;
    const search = (t) => phone(t, `<div style="padding:0 16px"><div style="background:${t.btn};border-radius:10px;padding:8px 12px;color:${t.mute};margin-bottom:14px">Q  habit tracker</div><div style="display:flex;gap:10px;align-items:center;margin-bottom:12px">${icon(56)}<div style="flex:1"><div style="font-weight:600">${app}</div><div style="font-size:12px;color:${t.mute}">Health &amp; Fitness · ★ 4.8</div></div>${get(t)}</div>${card(t)}</div>`);
    const today = (t) => phone(t, `<div style="padding:0 16px"><div style="font-size:12px;font-weight:600;color:${t.mute}">TUESDAY 1 DECEMBER</div><div style="font-size:30px;font-weight:800;margin-bottom:12px">Today</div>${card(t, 358, 'HAPPENING NOW')}</div>`);
    const product = (t) => phone(t, `<div style="padding:0 16px"><div style="display:flex;gap:12px;align-items:center;margin-bottom:14px">${icon(88)}<div><div style="font-size:20px;font-weight:700">${app}</div><div style="font-size:13px;color:${t.mute}">Build habits that stick</div><div style="margin-top:8px">${get(t)}</div></div></div><div style="font-size:20px;font-weight:700;margin:6px 0 8px">Events</div>${card(t, 300, 'NOW AVAILABLE')}</div>`);
    // The details page: the 9:16 media filling a 390×844 screen (cover), the gradient and words over the lower part.
    const [pw, ph] = E.phone;
    const details = (t) => `<div style="position:relative;width:${pw}px;height:${ph}px;border-radius:28px;overflow:hidden;background:#222;font:15px/1.35 -apple-system,system-ui,sans-serif;border:1px solid #c7c7cc">${dt ? `<img src="${src(dt)}" style="width:100%;height:100%;object-fit:cover;display:block">` : '<div class="miss" style="width:100%;height:100%">no details image</div>'}<div style="position:absolute;top:54px;right:16px;width:30px;height:30px;border-radius:15px;background:rgba(0,0,0,.45);color:#fff;display:grid;place-items:center;font-size:16px">×</div><div style="position:absolute;inset:auto 0 0 0;height:${Math.round(E.overlay * 100)}%;background:linear-gradient(transparent,${t.bg === '#000' ? 'rgba(0,0,0,.92)' : 'rgba(0,0,0,.78)'})"></div><div style="position:absolute;left:20px;right:20px;bottom:30px;color:#fff"><div style="font-size:12px;font-weight:700;opacity:.85;letter-spacing:.04em">${badge}</div><div style="font-size:28px;font-weight:800;line-height:1.1;margin:2px 0 6px">${name}</div><div style="font-size:15px;opacity:.92">${long}</div><div style="font-size:12px;opacity:.75;margin-top:8px">Starts 1 Dec · ends 31 Dec</div><div style="display:flex;gap:10px;align-items:center;margin-top:14px">${icon(40)}<div style="flex:1;font-size:14px">${app}</div><div style="background:rgba(255,255,255,.22);font-weight:700;border-radius:14px;padding:5px 14px">Notify Me</div><div style="background:#fff;color:#007aff;font-weight:700;border-radius:14px;padding:5px 16px">Get</div></div></div></div>`;
    const cutBox = () => { if (!dt) return ''; const W = 300, H = Math.round(W * dt.h / dt.w), keep = (pw / ph) / E.details.ratio, x0 = W * (1 - keep) / 2;
      return `<div><div class="box" style="width:${W}px;height:${H}px"><img src="${src(dt)}" style="width:${W}px;height:${H}px;display:block"><div class="zone" style="left:${x0}px;top:0;width:${W - 2 * x0}px;height:${H}px"></div><div class="zone" style="left:0;top:${H * (1 - E.overlay)}px;width:${W}px;height:${H * E.overlay}px;border-color:#f29900"></div></div><div class="lab">${esc(dt.file)} · ${dt.w}×${dt.h}<br>red: what a ${pw}×${ph} iPhone shows; amber: under the gradient and words (Palm's estimates)</div></div>`; };
    const cardBox = () => { if (!cd) return ''; const W = 480, H = Math.round(W * cd.h / cd.w);
      return `<div><div class="box" style="width:${W}px;height:${H}px"><img src="${src(cd)}" style="width:${W}px;height:${H}px;display:block"><div class="zone" style="left:0;top:${H * (1 - E.overlay)}px;width:${W}px;height:${H * E.overlay}px;border-color:#f29900"></div></div><div class="lab">${esc(cd.file)} · ${cd.w}×${cd.h} · amber: under Apple's gradient, badge, name and short description (Palm's estimate)</div></div>`; };
    const meta = `<div style="font-size:13px;line-height:1.6;max-width:520px"><b>Name</b> (${[...(m.name || '')].length}/${E.name}): ${name}<br><b>Short description</b> (${[...(m.short || '')].length}/${E.short}): ${short}<br><b>Long description</b> (${[...(m.long || '')].length}/${E.long}): ${long}<br><b>Badge</b>: ${esc(m.badge || '—')}</div>`;
    body += `<div class="sec" style="background:#f2f2f7"><h2>The event card in App Store search, on the Today tab and on the product page (light). Apple lays the gradient, badge, name and short description over the media; the layout drawn is Palm's estimate</h2><div class="row">${search(th(false))}${today(th(false))}${product(th(false))}</div></div>`;
    body += `<div class="sec dark" style="background:#000"><h2 style="color:#aaa">The same, in dark mode</h2><div class="row">${search(th(true))}${today(th(true))}</div></div>`;
    body += `<div class="sec" style="background:#e5e5ea"><h2>The event details page on an iPhone (${pw}×${ph}): the 9:16 image fills the screen, so its sides are cut, and the long description and buttons sit over its lower part</h2><div class="row">${details(th(false))}${details(th(true))}${cutBox()}</div></div>`;
    body += `<div class="sec"><h2>Both images, with what the App Store covers or cuts, and the metadata</h2><div class="row">${cardBox()}${meta}</div></div>`;
  } else if (store === 'profiles') {
    const F = (k) => found.find((x) => x.key === k);
    const av = F('avatar'), avu = av ? pathToFileURL(av.abs).href : null;
    // A banner shown in a box of bw×bh, scaled to `scale`× the box width (1 = fits the width), aligned centre or left.
    const ban = (k, bw, bh, { scale = 1, pos = 'center', label = '' } = {}) => { const f = F(k); if (!f) return `<div class="miss" style="width:${bw}px;height:${bh}px">no ${label || k}</div>`; const sc = Math.max(scale, (bh * f.w / f.h) / bw); return `<div style="width:${bw}px;height:${bh}px;background:#888 url('${pathToFileURL(f.abs).href}') ${pos} / ${Math.round(bw * sc)}px auto no-repeat"></div>`; };
    const face = (sz, round = true, ring = '#fff') => avu ? `<img src="${avu}" style="width:${sz}px;height:${sz}px;object-fit:cover;display:block;border-radius:${round ? '50%' : Math.round(sz * 0.08) + 'px'};box-shadow:0 0 0 ${Math.max(2, Math.round(sz / 30))}px ${ring}">` : `<div class="miss" style="width:${sz}px;height:${sz}px;border-radius:${round ? '50%' : '6px'}">avatar</div>`;
    const over = (banner, w, h, sz, left, top, { round = true, ring = '#fff', bg = '#fff', fg = '#111', name = 'Your name', sub = '', zone = '' } = {}) => `<div style="background:${bg};color:${fg};width:${w}px;border-radius:10px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.25)"><div class="box" style="height:${h}px">${banner}${zone}</div><div style="position:relative;height:${Math.max(0, top - h + sz) + 52}px"><div style="position:absolute;left:${left}px;top:${top - h}px">${face(sz, round, ring)}</div><div style="position:absolute;left:${left}px;top:${Math.max(0, top - h + sz) + 8}px;font-weight:700">${name}</div>${sub ? `<div style="position:absolute;left:${left}px;top:${Math.max(0, top - h + sz) + 26}px;font-size:12px;opacity:.65">${sub}</div>` : ''}</div></div>`;
    // Avatar at the sizes it's actually seen.
    const avRow = (bg, fg) => `<div style="background:${bg};color:${fg};padding:14px;border-radius:10px;width:300px">${[0, 1, 2].map((i) => `<div style="display:flex;gap:10px;align-items:center;margin:8px 0">${i === 1 ? face(40, true, 'transparent') : `<div style="width:40px;height:40px;border-radius:50%;background:${fg === '#fff' ? '#333' : '#ddd'}"></div>`}<div><div style="font-weight:600;font-size:13px">${i === 1 ? 'You' : 'Someone else'}</div><div style="font-size:12px;opacity:.6">replied · 2h</div></div></div>`).join('')}</div>`;
    body += `<div class="sec"><h2>Profile picture where it's seen: in replies and comments at 40 px and as small as 24 px, light and dark; YouTube's 98 px; a LinkedIn Page's square logo</h2><div class="row">${avRow('#fff', '#111')}${avRow('#000', '#fff')}<div style="display:flex;gap:14px;align-items:flex-end">${face(24, true, 'transparent')}${face(32, true, 'transparent')}${face(98, true, 'transparent')}${face(98, false, 'transparent')}</div></div></div>`;
    // YouTube: TV shows the whole 16:9; desktop shows a centre band (~2560×423 of 2560×1440); phones a narrower centre (~1546×423). Safe area 1235×338 at 2048 wide (official).
    const yt = F('youtube');
    const safe = (bw, scaleW) => `<div class="zone" style="left:${(bw - scaleW * 1235 / 2048) / 2}px;width:${scaleW * 1235 / 2048}px;top:50%;height:${scaleW * 338 / 2048}px;transform:translateY(-50%)"></div>`;
    body += `<div class="sec dark" style="background:#0f0f0f"><h2 style="color:#aaa">YouTube banner: on a TV (all of it), on desktop (a centre band) and on a phone (a narrower centre). Dashed box: YouTube's safe area for text and logos (official); the band crops are Palm's measurement</h2><div class="row"><div><div class="box">${ban('youtube', 480, 270, { label: 'YouTube banner' })}${yt ? safe(480, 480) : ''}</div><div class="lab">TV, 16:9</div></div><div><div class="box">${ban('youtube', 820, 136, { label: 'YouTube banner' })}${yt ? safe(820, 820) : ''}</div><div style="display:flex;gap:14px;align-items:center;margin-top:14px">${face(72, true, 'transparent')}<div style="color:#fff"><div style="font-size:20px;font-weight:700">Your channel</div><div style="font-size:12px;color:#aaa">@yourchannel · 1.2K subscribers</div></div></div><div class="lab">desktop</div></div><div style="width:390px"><div class="box" style="overflow:hidden">${ban('youtube', 390, 107, { scale: 2560 / 1546, label: 'YouTube banner' })}${yt ? safe(390, 390 * 2560 / 1546) : ''}</div><div style="display:flex;gap:10px;align-items:center;margin-top:10px">${face(56, true, 'transparent')}<div style="color:#fff;font-weight:700">Your channel</div></div><div class="lab">phone</div></div></div></div>`;
    // X: 3:1 header, avatar circle over its lower left. Phones can trim the top and bottom (community: ~60 of 500 px each).
    const xTrim = (bw, bh) => `<div class="zone" style="left:0;width:${bw}px;top:${bh * 0.12}px;height:${bh * 0.76}px"></div>`;
    body += `<div class="sec"><h2>X header with the profile picture over its lower left: desktop (dark) and phone (light). Dashed lines: phones may trim about 12% top and bottom (community measurement)</h2><div class="row">${over(ban('x', 600, 200, { label: 'X header' }), 600, 200, 134, 16, 133, { bg: '#000', fg: '#e7e9ea', ring: '#000', name: 'Your name', sub: '@yourhandle' })}${over(ban('x', 390, 130, { label: 'X header' }), 390, 130, 80, 16, 100, { ring: '#fff', name: 'Your name', sub: '@yourhandle', zone: F('x') ? xTrim(390, 130) : '' })}</div></div>`;
    // LinkedIn member: 4:1 banner, round photo over the lower left. Company Page: ~5.9:1 cover, square logo over the lower left.
    body += `<div class="sec" style="background:#f4f2ee"><h2>LinkedIn: profile banner with the round photo over its lower left, desktop and phone; Page cover with the square logo over it, desktop and phone (overlap positions: Palm's measurement)</h2><div class="row">${over(ban('linkedin', 804, 201, { label: 'LinkedIn banner' }), 804, 201, 152, 24, 125, { name: 'Your Name', sub: 'Founder at Your Studio' })}${over(ban('linkedin', 390, 98, { label: 'LinkedIn banner' }), 390, 98, 88, 16, 54, { name: 'Your Name', sub: 'Founder at Your Studio' })}</div><div class="row" style="margin-top:18px">${over(ban('linkedin-page', 804, 136, { label: 'LinkedIn Page cover' }), 804, 136, 104, 24, 84, { round: false, name: 'Your Studio', sub: 'Design services · 120 followers' })}${over(ban('linkedin-page', 390, 66, { label: 'LinkedIn Page cover' }), 390, 66, 64, 16, 34, { round: false, name: 'Your Studio', sub: '120 followers' })}</div></div>`;
    // Facebook: cover shown wide on desktop; phones show a taller, narrower centre (Facebook: 820×312 desktop, 640×360 phone).
    body += `<div class="sec" style="background:#f0f2f5"><h2>Facebook Page cover: desktop (about 820×312) and phone (about 640×360, so the sides are cut), with the profile picture over the lower left</h2><div class="row">${over(ban('facebook', 820, 312, { scale: 820 / 820, label: 'Facebook cover' }), 820, 312, 168, 24, 250, { name: 'Your Page', sub: '1.2K likes' })}${over(ban('facebook', 390, 219, { scale: (219 * 851 / 315) / 390, label: 'Facebook cover' }), 390, 219, 96, 16, 180, { name: 'Your Page', sub: '1.2K likes' })}</div></div>`;
  } else if (store === 'etsy' || store === 'shopify') {
    const main = u('main'), all = found.filter((x) => x.key === 'main' || x.key === 'photo').map((x) => pathToFileURL(x.abs).href);
    const ph = (i) => `<div style="width:100%;height:100%;background:hsl(${i * 47 + 30},18%,${80 - (i % 3) * 6}%)"></div>`;
    const card = (w, h, i, mine) => `<div style="width:${w}px"><div style="width:${w}px;height:${h}px;overflow:hidden;border-radius:${store === 'etsy' ? 8 : 4}px">${mine ? img(main, w, h, 'object-position:center') : ph(i)}</div><div style="font-size:12px;margin-top:6px">${mine ? '<b>Your product</b>' : 'Another product'}</div><div style="font-size:12px;opacity:.7">$24.00</div></div>`;
    body += `<div class="sec"><h2>${store === 'etsy' ? 'Etsy crops the first photo to square, portrait and landscape thumbnails, centred: is the product whole in each?' : 'Collection grid (square, as most themes crop): does the product read among others?'}</h2><div class="row">${store === 'etsy'
      ? `<div>${img(main, 240, 240)}<div class="lab">square</div></div><div>${img(main, 200, 250)}<div class="lab">portrait 4:5</div></div><div>${img(main, 300, 225)}<div class="lab">landscape 4:3</div></div>`
      : ''}</div><div class="row" style="margin-top:16px">${[0, 1, 2, 3, 4].map((i) => card(store === 'etsy' ? 210 : 190, store === 'etsy' ? 168 : 190, i, i === 1)).join('')}</div></div>`;
    body += `<div class="sec"><h2>Listing page: main photo large with the others as thumbnails, in order (${all.length})</h2><div class="row"><div>${img(main, 520, 520, 'object-fit:contain;background:#f5f5f5')}</div><div style="display:grid;grid-template-columns:repeat(4,110px);gap:8px">${all.map((s) => `<img src="${s}" style="width:110px;height:110px;object-fit:cover;display:block;border:1px solid #ddd">`).join('')}</div></div></div>`;
    body += `<div class="sec"><h2>On a phone (390 px wide)</h2>${img(main, 390, 390, 'object-fit:contain;background:#f5f5f5')}</div>`;
  } else {
    const g = (k) => u(k);
    const searchRow = (w, h, title) => `<div style="display:flex;gap:10px;align-items:center;background:#16202d;padding:6px;margin:4px 0;width:620px">${img(g('small'), w, h)}<div style="color:#c7d5e0;font-size:13px">${title}</div></div>`;
    body += `<div class="sec dark" style="background:#1b2838"><h2 style="color:#8f98a0">Small capsule in search and lists at 120×45 and 184×69: is the name readable?</h2>${searchRow(120, 45, 'Your game')}${searchRow(184, 69, 'Your game')}<div class="row" style="margin-top:12px"><div>${img(g('small'), 462, 174)}<div class="lab">462×174</div></div></div></div>`;
    body += `<div class="sec dark" style="background:#1b2838"><h2 style="color:#8f98a0">Header (460×215, as on the store page) · Main capsule (616×353, home carousel) · Vertical (374×448, sales)</h2><div class="row">${img(g('header'), 460, 215)}${img(g('main'), 616, 353)}${img(g('vertical'), 374, 448)}</div></div>`;
    body += `<div class="sec dark" style="background:#23262e"><h2 style="color:#8f98a0">Library grid (capsules at 150×225) and the library hero with the logo over it; dashed box: the safe area that's never cropped</h2><div class="row">${[0, 1, 2, 3, 4].map((i) => i === 2 ? img(g('library-capsule'), 150, 225) : '<div style="width:150px;height:225px;background:#3a3f4a"></div>').join('')}</div>
      <div class="box" style="margin-top:18px;width:1240px;height:400px;overflow:hidden">${img(g('library-hero'), 1240, 400)}<div class="zone" style="left:${(1240 - 1240 * 860 / 1920) / 2}px;width:${1240 * 860 / 1920}px;top:${(400 - 400 * 380 / 620) / 2}px;height:${400 * 380 / 620}px"></div>${g('library-logo') ? `<img src="${g('library-logo')}" style="position:absolute;left:40px;bottom:30px;max-width:420px;max-height:150px">` : ''}</div>
      <div class="row" style="margin-top:14px"><div>${img(g('community-icon'), 32, 32)}<div class="lab">community icon, 32 px</div></div><div>${img(g('library-header'), 230, 107)}<div class="lab">library header, recent games</div></div></div></div>`;
    body += `<div class="sec"><h2>Screenshots (${shots.length}): gameplay only</h2><div class="row">${shots.slice(0, 8).map((s) => `<img src="${s}" style="width:300px;height:169px;object-fit:cover;display:block">`).join('') || '<div class="miss" style="width:300px;height:169px">no screenshots</div>'}</div></div>`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`;
}

// ---------- render an HTML design at an exact size ----------
export async function render(file, { out, size, jpeg = false, alpha = false, quality = 90 } = {}) {
  const [w, h] = String(size).split('x').map(Number);
  if (!w || !h) throw new Error('--size WxH is required, e.g. --size 1024x500');
  const browser = await launch();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(resolve(file)).href, { waitUntil: 'load', timeout: 30000 });
    await page.evaluate(() => document.fonts?.ready);
    await new Promise((ok) => setTimeout(ok, 200));
    const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight,
      small: [...document.querySelectorAll('body *')].filter((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())).map((e) => parseFloat(getComputedStyle(e).fontSize)) }));
    mkdirSync(dirname(resolve(out)), { recursive: true });
    const asJpeg = jpeg || /\.jpe?g$/i.test(out);
    if (!asJpeg && !alpha) await page.evaluate(() => { if (getComputedStyle(document.body).backgroundColor === 'rgba(0, 0, 0, 0)' && getComputedStyle(document.documentElement).backgroundColor === 'rgba(0, 0, 0, 0)') document.documentElement.style.background = '#fff'; });
    await page.screenshot({ path: out, type: asJpeg ? 'jpeg' : 'png', ...(asJpeg ? { quality } : {}), omitBackground: !asJpeg && alpha, clip: { x: 0, y: 0, width: w, height: h } });
    let buf = readFileSync(out), info = imageInfo(buf);
    if (!asJpeg && !alpha && info.alpha) {
      // Puppeteer writes RGBA PNGs: re-encode through a canvas as JPEG-like opaque PNG isn't possible, so draw onto an opaque canvas and save RGB.
      const page2 = await browser.newPage();
      const data = await page2.evaluate(async (u, W, H) => { const i = new Image(); i.src = u; await i.decode(); const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d', { alpha: false }); x.fillStyle = '#fff'; x.fillRect(0, 0, W, H); x.drawImage(i, 0, 0); return c.toDataURL('image/png'); }, 'data:image/png;base64,' + buf.toString('base64'), w, h);
      buf = stripAlpha(Buffer.from(data.split(',')[1], 'base64'));
      writeFileSync(out, buf); info = imageInfo(buf);
    }
    const issues = [];
    if (m.sw > w + 1 || m.sh > h + 1) issues.push(issue('overflow', 'warn', `The HTML is ${m.sw}×${m.sh}, bigger than ${w}×${h}: part of it is cut off.`, `Fit everything inside: html,body{width:${w}px;height:${h}px;overflow:hidden}.`));
    const minFont = m.small.length ? Math.min(...m.small) : null;
    return { ok: !issues.length, out, w, h, format: info.format, alpha: !!info.alpha, kb: Math.round(buf.length / 1024), smallestText: minFont, issues };
  } finally { await browser.close(); }
}

// Re-encodes an RGBA PNG (opaque pixels) as RGB, so stores that refuse alpha accept it. Pure JS (zlib).
import zlib from 'node:zlib';
function stripAlpha(png) {
  const info = imageInfo(png); if (!info.alpha || png[25] !== 6 || png[24] !== 8) return png;
  const W = info.w, H = info.h; const idat = []; let i = 8;
  while (i < png.length) { const len = png.readUInt32BE(i), type = png.toString('latin1', i + 4, i + 8); if (type === 'IDAT') idat.push(png.subarray(i + 8, i + 8 + len)); i += 12 + len; }
  const raw = zlib.inflateSync(Buffer.concat(idat)), bpp = 4, stride = W * bpp, out = Buffer.alloc(H * (W * 3 + 1));
  const prev = Buffer.alloc(stride), cur = Buffer.alloc(stride);
  for (let y = 0; y < H; y++) {
    const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0; let v = row[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1; else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[x] = v & 255;
    }
    out[y * (W * 3 + 1)] = 0;
    for (let x = 0; x < W; x++) { out[y * (W * 3 + 1) + 1 + x * 3] = cur[x * 4]; out[y * (W * 3 + 1) + 2 + x * 3] = cur[x * 4 + 1]; out[y * (W * 3 + 1) + 3 + x * 3] = cur[x * 4 + 2]; }
    cur.copy(prev);
  }
  const chunk = (type, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td) >>> 0); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([png.subarray(0, 8), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(out, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
let CRC; function crc32(b) { if (!CRC) { CRC = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c; } } let c = -1; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return c ^ -1; }

// ---------- self-test ----------
async function selfTest() {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const d = mkdtempSync(join(tmpdir(), 'store-art-'));
  const mk = (name, w, h, body, opts = {}) => { const f = join(d, name + '.html'); writeFileSync(f, `<html><body style="margin:0;width:${w}px;height:${h}px;${opts.bg === false ? 'background:transparent' : 'background:#2a6'};font:bold ${Math.round(h / 4)}px sans-serif;color:#fff;display:flex;align-items:center;justify-content:center">${body}</body></html>`); return render(f, { out: join(d, 'up', (opts.dir || '') + name + (opts.jpg ? '.jpg' : '.png')), size: `${w}x${h}`, alpha: !!opts.alpha }); };
  const f = await mk('feature', 1024, 500, 'Best app');
  if (f.alpha) throw new Error('render should flatten alpha');
  await mk('icon', 512, 512, 'A');
  await mk('s1', 1080, 1920, 'one'); await mk('s2', 1080, 1920, 'two'); await mk('bad', 1080, 3000, 'tall');
  const r = await check('google-play', join(d, 'up'), { out: join(d, 'gp') });
  const ids = r.issues.map((i) => i.id);
  for (const want of ['shot-size', 'shots-few']) if (!ids.includes(want)) throw new Error('play: expected ' + want + ' in ' + ids.join(','));
  // Steam: old size flagged, missing assets flagged.
  const sd = join(d, 'steam'); mkdirSync(sd);
  await render(join(d, 'feature.html'), { out: join(sd, 'old-header.png'), size: '460x215' });
  const s = await check('steam', sd, { out: join(d, 'st') });
  if (!s.issues.some((i) => i.id === 'old-size') || !s.issues.some((i) => i.id === 'missing-small')) throw new Error('steam checks: ' + s.issues.map((i) => i.id).join(','));
  // Words in the HTML source.
  writeFileSync(join(d, 'up', 'feature.html'), '<p>Best app, download now</p>');
  const w = await check('google-play', join(d, 'up'), { out: join(d, 'gp2') });
  if (!w.issues.some((i) => i.id === 'words')) throw new Error('words not flagged');
  // Podcasts: wrong size and alpha; episode text.
  const pd = join(d, 'pod'); mkdirSync(pd);
  await render(join(d, 'feature.html'), { out: join(pd, 'cover.png'), size: '1200x1200', alpha: true });
  writeFileSync(join(pd, 'episode-1.html'), '<p>Episode 1</p>');
  const pc = await check('apple-podcasts', pd, { out: join(d, 'pod') });
  for (const want of ['size-cover', 'episode-text']) if (!pc.issues.some((i) => i.id === want)) throw new Error('podcasts: expected ' + want + ' in ' + pc.issues.map((i) => i.id).join(','));
  // Etsy: portrait first photo, too small.
  const ed = join(d, 'etsy'); mkdirSync(ed);
  await render(join(d, 'feature.html'), { out: join(ed, '01.png'), size: '500x700' });
  const et = await check('etsy', ed, { out: join(d, 'etsy') });
  for (const want of ['main-small', 'main-portrait']) if (!et.issues.some((i) => i.id === want)) throw new Error('etsy: expected ' + want + ' in ' + et.issues.map((i) => i.id).join(','));
  // Shopify: a square photo under 2048 (warn), one side over 5000 px (error), and mixed aspect ratios (warn).
  const shd = join(d, 'shopify'); mkdirSync(shd);
  await render(join(d, 'feature.html'), { out: join(shd, '01-main.png'), size: '1200x1200' });
  await render(join(d, 'feature.html'), { out: join(shd, '02-wide.jpg'), size: '5200x400', jpeg: true });
  const sh = await check('shopify', shd, { out: join(d, 'shop') });
  for (const want of ['photo-small', 'photo-big', 'ratio-mixed']) if (!sh.issues.some((i) => i.id === want)) throw new Error('shopify: expected ' + want + ' in ' + sh.issues.map((i) => i.id).join(','));
  // and a clean Shopify set raises no errors or warnings
  const shok = join(d, 'shopify-ok'); mkdirSync(shok);
  for (const n of ['01', '02']) await render(join(d, 'feature.html'), { out: join(shok, n + '.jpg'), size: '2048x2048', jpeg: true });
  const sk = await check('shopify', shok, { out: join(d, 'shopok') });
  if (sk.issues.length) throw new Error('shopify clean set flagged: ' + sk.issues.map((i) => i.id).join(','));
  // Social profiles: no avatar, a YouTube banner under 2048 wide, LinkedIn's old Page size; then a clean kit.
  const pr = join(d, 'profiles'); mkdirSync(pr);
  await render(join(d, 'feature.html'), { out: join(pr, 'youtube.jpg'), size: '1920x1080', jpeg: true });
  await render(join(d, 'feature.html'), { out: join(pr, 'linkedin-page.jpg'), size: '1128x191', jpeg: true });
  const pf = await check('profiles', pr, { out: join(d, 'prof') });
  for (const want of ['missing-avatar', 'size-youtube', 'old-size', 'missing-x']) if (!pf.issues.some((i) => i.id === want)) throw new Error('profiles: expected ' + want + ' in ' + pf.issues.map((i) => i.id).join(','));
  const pk = join(d, 'profiles-ok'); mkdirSync(pk);
  await render(join(d, 'feature.html'), { out: join(pk, 'avatar.png'), size: '800x800' });
  for (const [n, sz] of [['youtube', '2560x1440'], ['x-header', '1500x500'], ['linkedin', '1584x396'], ['linkedin-page', '1512x256'], ['facebook', '851x315']]) await render(join(d, 'feature.html'), { out: join(pk, n + '.jpg'), size: sz, jpeg: true });
  const pg = await check('profiles', pk, { out: join(d, 'profok') });
  if (pg.issues.length || pg.found.length !== 6) throw new Error('profiles clean kit: ' + pg.issues.map((i) => i.id).join(',') + ' found ' + pg.found.map((f) => f.key).join(','));
  // Meta ads: a wrong-ratio image, a 9:16 story with its offer in the bottom 35%, no feed creative and a long headline;
  // then a clean set (4:5 feed, 9:16 with centred text, short copy) with no issues.
  const ad = join(d, 'ads'); mkdirSync(ad);
  writeFileSync(join(ad, 'story.html'), '<html><body style="margin:0;width:1440px;height:2560px;background:#2a6;position:relative;font:bold 120px sans-serif;color:#fff"><div style="position:absolute;left:120px;top:2200px">20% off</div><div style="position:absolute;left:300px;top:1200px">Spring</div><div style="position:absolute;left:300px;top:1400px;font-size:28px">only 60 made</div></body></html>');
  await render(join(ad, 'story.html'), { out: join(ad, 'story.jpg'), size: '1440x2560', jpeg: true });
  await render(join(d, 'feature.html'), { out: join(ad, 'wide.jpg'), size: '1200x1000', jpeg: true });
  writeFileSync(join(ad, 'copy.md'), '# Ad copy\nPrimary text: Spring is here.\nHeadline: Our whole spring range of hand-thrown stoneware, now 20% off\n');
  const ab = await check('ads', ad, { out: join(d, 'adbad') });
  for (const want of ['ratio', 'safe-zone', 'missing-feed', 'headline-long', 'text-small']) if (!ab.issues.some((i) => i.id === want)) throw new Error('ads: expected ' + want + ' in ' + ab.issues.map((i) => i.id).join(','));
  if (ab.issues.find((i) => i.id === 'safe-zone').msg.includes('Spring')) throw new Error('ads: centred text wrongly flagged');
  const ak = join(d, 'ads-ok'); mkdirSync(ak);
  writeFileSync(join(ak, 'story.html'), '<html><body style="margin:0;width:1440px;height:2560px;background:#2a6;display:flex;align-items:center;justify-content:center;font:bold 140px sans-serif;color:#fff">20% off</body></html>');
  await render(join(ak, 'story.html'), { out: join(ak, 'story.jpg'), size: '1440x2560', jpeg: true });
  await render(join(d, 'feature.html'), { out: join(ak, 'feed.jpg'), size: '1440x1800', jpeg: true });
  writeFileSync(join(ak, 'copy.md'), 'Primary text: Spring sale: 20% off mugs.\nHeadline: 20% off all mugs\nDescription: Ends Sunday\n');
  const ag = await check('ads', ak, { out: join(d, 'adok') });
  if (ag.issues.length || ag.found.length !== 2) throw new Error('ads clean set: ' + ag.issues.map((i) => i.id + ' ' + i.msg).join(' | ') + ' found ' + ag.found.map((f) => f.key).join(','));
  // Pinterest: a too-tall pin with tiny text below the 2:3 line, a square image, two look-alike pins, a 120-character
  // title; then a clean set of three different 2:3 pins.
  const pn = join(d, 'pins'); mkdirSync(pn);
  writeFileSync(join(pn, 'tall.html'), '<html><body style="margin:0;width:1000px;height:2400px;background:#c63;position:relative;font:bold 120px sans-serif;color:#fff"><div style="position:absolute;left:60px;top:200px">Soup</div><div style="position:absolute;left:60px;top:2000px;font-size:30px">tiny note at the bottom</div></body></html>');
  await render(join(pn, 'tall.html'), { out: join(pn, 'tall.png'), size: '1000x2400' });
  writeFileSync(join(pn, 'a.html'), '<html><body style="margin:0;width:1000px;height:1500px;background:#2a6;display:grid;place-items:center;font:bold 150px sans-serif;color:#fff">Same</body></html>');
  await render(join(pn, 'a.html'), { out: join(pn, 'a.png'), size: '1000x1500' });
  writeFileSync(join(pn, 'b.html'), '<html><body style="margin:0;width:1000px;height:1500px;background:#2a6;display:grid;place-items:center;font:bold 150px sans-serif;color:#fff">Same</body></html>');
  await render(join(pn, 'b.html'), { out: join(pn, 'b.png'), size: '1000x1500' });
  writeFileSync(join(pn, 'pins.md'), `## Pin 1\nTitle: ${'x'.repeat(120)}\nDescription: hi\n\n## Pin 2\nTitle: Same\n\n## Pin 3\nTitle: Same\n`);
  const pb = await check('pinterest', pn, { out: join(d, 'pinbad') });
  for (const want of ['pin-tall', 'text-small', 'text-cut', 'look-alike', 'title-long', 'title-same']) if (!pb.issues.some((i) => i.id === want)) throw new Error('pinterest: expected ' + want + ' in ' + pb.issues.map((i) => i.id).join(','));
  const pk2 = join(d, 'pins-ok'); mkdirSync(pk2);
  const looks = [['#183a2e', 'center', 'Soup in 20 minutes'], ['#f3e2c4', 'flex-start', 'Weeknight lentil soup'], ['#7a2e1d', 'flex-end', 'One pot, six bowls']];
  for (const [i, [bg, at, t]] of looks.entries()) {
    writeFileSync(join(pk2, `pin${i + 1}.html`), `<html><body style="margin:0;width:1000px;height:1500px;background:${bg};display:flex;flex-direction:column;justify-content:${at};padding:260px 70px;box-sizing:border-box;font:bold 120px sans-serif;color:${i === 1 ? '#222' : '#fff'}"><div>${t}</div><div style="font-size:56px;font-weight:400;margin-top:30px">Recipe on the blog</div>${i === 1 ? '<div style="width:600px;height:500px;background:#c63;margin-top:60px;border-radius:300px"></div>' : ''}</body></html>`);
    await render(join(pk2, `pin${i + 1}.html`), { out: join(pk2, `pin${i + 1}.png`), size: '1000x1500' });
  }
  writeFileSync(join(pk2, 'pins.md'), '## Pin 1\nTitle: Lentil soup in 20 minutes\nDescription: A weeknight soup.\n\n## Pin 2\nTitle: Easy weeknight lentil soup\nDescription: One pot.\n\n## Pin 3\nTitle: One-pot lentil soup for six\nDescription: Feeds six.\n');
  const pg2 = await check('pinterest', pk2, { out: join(d, 'pinok') });
  if (pg2.issues.length || pg2.found.length !== 3) throw new Error('pinterest clean set: ' + pg2.issues.map((i) => i.id + ' ' + i.msg).join(' | ') + ' found ' + pg2.found.length);
  // Google Business Profile: text on the cover, a photo under 250 px, a WebP, a non-square logo, contact details in the
  // post; then a clean profile (square logo, plain photos at 720+, a post image without small text, a clean post).
  const gb = join(d, 'gbp'); mkdirSync(gb);
  writeFileSync(join(gb, 'cover.html'), '<html><body style="margin:0;width:1600px;height:900px;background:#357;position:relative;font:bold 90px sans-serif;color:#fff"><div style="position:absolute;left:30px;top:30px">20% off tune-ups</div></body></html>');
  await render(join(gb, 'cover.html'), { out: join(gb, 'cover.jpg'), size: '1600x900', jpeg: true });
  await render(join(d, 'feature.html'), { out: join(gb, 'logo.png'), size: '900x500' });
  await render(join(d, 'feature.html'), { out: join(gb, 'tiny.jpg'), size: '200x200', jpeg: true });
  writeFileSync(join(gb, 'post.md'), 'Title: Winter service\nBook a winter service this week and get 20% off. Call us on 0117 496 0123 or email hello@spoke.example.\nButton: Book\n');
  const gx = await check('gbp', gb, { out: join(d, 'gbpbad') });
  for (const want of ['photo-text', 'text-cropped', 'too-small', 'logo-shape', 'post-contact', 'missing-post-image']) if (!gx.issues.some((i) => i.id === want)) throw new Error('gbp: expected ' + want + ' in ' + gx.issues.map((i) => i.id).join(','));
  const gk = join(d, 'gbp-ok'); mkdirSync(gk);
  writeFileSync(join(gk, 'plain.html'), '<html><body style="margin:0;width:1200px;height:900px;background:linear-gradient(#467,#bcd)"></body></html>');
  for (const n of ['cover', 'exterior', 'workshop', 'wheels']) await render(join(gk, 'plain.html'), { out: join(gk, n + '.jpg'), size: '1200x900', jpeg: true, quality: 95 });
  writeFileSync(join(gk, 'logo.html'), '<html><body style="margin:0;width:720px;height:720px;background:radial-gradient(#4a7fa0,#183048);display:grid;place-items:center;font:bold 200px sans-serif;color:#fff">S</body></html>');
  await render(join(gk, 'logo.html'), { out: join(gk, 'logo.png'), size: '720x720' });
  writeFileSync(join(gk, 'post.html'), '<html><body style="margin:0;width:1200px;height:900px;background:#357;display:grid;place-items:center;font:bold 110px sans-serif;color:#fff">Winter service</body></html>');
  await render(join(gk, 'post.html'), { out: join(gk, 'post.jpg'), size: '1200x900', jpeg: true, quality: 95 });
  writeFileSync(join(gk, 'post.md'), 'Winter service: 20% off this week.\nButton: Book\n');
  const gg = await check('gbp', gk, { out: join(d, 'gbpok') });
  const gIssues = gg.issues.filter((i) => i.id !== 'photo-text-read');
  if (gIssues.length || gg.found.length !== 6) throw new Error('gbp clean set: ' + gIssues.map((i) => i.id + ' ' + i.msg).join(' | ') + ' found ' + gg.found.map((f) => f.key).join(','));
  // App Store In-App Event: words in the card under Apple's overlay, words at the side of the details image, and metadata
  // breaking Apple's rules; then a clean event (plain art, a real name, sentence-case descriptions, a real badge).
  const ev = join(d, 'event'); mkdirSync(ev);
  writeFileSync(join(ev, 'card.html'), '<html><body style="margin:0;width:1920px;height:1080px;background:#2a6;position:relative;font:bold 110px sans-serif;color:#fff"><div style="position:absolute;left:80px;bottom:80px">Streak Challenge</div></body></html>');
  await render(join(ev, 'card.html'), { out: join(ev, 'card.png'), size: '1920x1080' });
  writeFileSync(join(ev, 'details.html'), '<html><body style="margin:0;width:1080px;height:1920px;background:#263;position:relative;font:bold 90px sans-serif;color:#fff"><div style="position:absolute;left:10px;top:300px">30 days</div></body></html>');
  await render(join(ev, 'details.html'), { out: join(ev, 'details.png'), size: '1080x1920' });
  writeFileSync(join(ev, 'event.md'), 'Name: JOIN THE 30-DAY STREAK CHALLENGE!!\nShort description: Get Premium For $4.99 And Keep Your Streak Going\nLong description: Thirty days.\nBadge: Contest\n');
  const ex = await check('event', ev, { out: join(d, 'eventbad') });
  for (const want of ['name-long', 'name-caps', 'name-cta', 'name-type', 'name-punct', 'price', 'badge', 'card-overlay', 'details-cut', 'media-text']) if (!ex.issues.some((i) => i.id === want)) throw new Error('event: expected ' + want + ' in ' + ex.issues.map((i) => i.id).join(','));
  const ek = join(d, 'event-ok'); mkdirSync(ek);
  writeFileSync(join(ek, 'card.html'), '<html><body style="margin:0;width:1920px;height:1080px;background:radial-gradient(circle at 50% 35%,#7c6,#163)"></body></html>');
  await render(join(ek, 'card.html'), { out: join(ek, 'card.png'), size: '1920x1080' });
  writeFileSync(join(ek, 'details.html'), '<html><body style="margin:0;width:1080px;height:1920px;background:radial-gradient(circle at 50% 30%,#7c6,#163)"></body></html>');
  await render(join(ek, 'details.html'), { out: join(ek, 'details.png'), size: '1080x1920' });
  writeFileSync(join(ek, 'event.md'), 'Name: December Streak Climb\nShort description: Log one habit every day until New Year.\nLong description: Keep a habit going all December and earn a winter badge for every week you complete.\nBadge: Challenge\nStart: 2026-12-01\nEnd: 2026-12-31\n');
  const eg = await check('event', ek, { out: join(d, 'eventok') });
  if (eg.issues.length || eg.found.length !== 2) throw new Error('event clean set: ' + eg.issues.map((i) => i.id + ' ' + i.msg).join(' | ') + ' found ' + eg.found.map((f) => f.key).join(','));
  console.log(`store-art: all tests pass (play ${r.errors} errors, steam ${s.errors} errors; sheet ${r.sheet})`);
}

if (typeof process !== 'undefined' && process.argv?.[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
  const VALUED = new Set(['--out', '--size', '--quality']);
  const pos = argv.filter((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1]));
  const done = (r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); };
  const fail = (e) => { console.error(String(e.message || e)); process.exit(2); };
  if (argv.includes('--test')) selfTest().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
  else if (pos[0] === 'render' && pos[1]) render(pos[1], { out: opt('out', 'out.png'), size: opt('size'), jpeg: argv.includes('--jpeg'), alpha: argv.includes('--alpha'), quality: +opt('quality', 90) }).then(done, fail);
  else if (pos[0] === 'check' && pos[1] && pos[2]) check(pos[1], pos[2], { out: opt('out', 'art') }).then(done, fail);
  else fail('usage: store-art.mjs check <google-play|chrome-web-store|steam|apple-podcasts|etsy|shopify|profiles|ads|pinterest|gbp|event> <folder> [--out art]\n       store-art.mjs render <design.html> --size 1024x500 --out upload/feature.png [--jpeg] [--alpha]');
}
