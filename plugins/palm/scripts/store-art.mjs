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
// One sheet to LOOK at, plus measured problems. Also renders an HTML design to an image at an exact size.
// adds: tool, fresh-data. Runs on the user's machine with their Chrome/Edge/Chromium; nothing leaves it.
//
//   node store-art.mjs check <google-play|chrome-web-store|steam|apple-podcasts|etsy|shopify|profiles|ads|pinterest> <folder> [--out art]
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
  else fail('usage: store-art.mjs check <google-play|chrome-web-store|steam|apple-podcasts|etsy|shopify|profiles|ads|pinterest> <folder> [--out art]\n       store-art.mjs render <design.html> --size 1024x500 --out upload/feature.png [--jpeg] [--alpha]');
}
