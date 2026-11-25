#!/usr/bin/env node
// Palm tool: consent-check — lets an agent see what its cookie banner really does, in a fresh browser each time: which
// other sites the page contacts and which cookies it stores BEFORE anyone chooses, whether Reject is on the first layer
// and as easy as Accept, whether Reject is remembered after a reload with nothing loading, whether Accept turns the
// analytics on, whether people can reopen their choice later, and how much of a phone screen the banner covers.
// None of this shows in the HTML or in a screenshot. Not legal advice: regulators assess banners case by case.
// adds: tool. Runs on the user's machine with their Chrome/Edge/Chromium. Requests to other sites are intercepted and
// answered with empty stubs, so nothing leaves the machine and results don't depend on the network.
//
//   node consent-check.mjs check <site folder> [--pages index.html,about.html] [--out look/consent]
//       → JSON {ok, errors, warnings, banner, before, reject, accept, issues, sheet}. Then LOOK at the sheet.
//   node consent-check.mjs --test
//
// Sources (Palm data pack sites/consent, read 2026-11-25): ePrivacy Directive 2002/58/EC art. 5(3) as amended by
// 2009/136/EC (consent before storing or reading anything not strictly necessary); EDPB cookie banner taskforce
// report, adopted 17 January 2023 (no consent cookies before a positive action; a reject option on the layer with the
// accept button; no pre-ticked boxes; no manifestly misleading contrast; an easy way to withdraw at any time);
// CNIL guidelines of 19 July 2019. Palm's own measures (warnings unless the report is explicit): Reject at least 0.6×
// Accept's area and 4.5:1 text contrast (WCAG 1.4.3); the banner covering over half a phone screen; the banner not
// reached in the first 10 Tab presses; which hosts count as tracking (a list, not a rule).

import { readFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, extname } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';

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
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon', '.json': 'application/json' };
function serve(root) {
  const s = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html';
    const f = join(root, p);
    if (q.method !== 'GET' && q.method !== 'HEAD') { r.writeHead(200, { 'content-type': 'text/html' }); return r.end('<!doctype html><p>ok'); }
    if (!f.startsWith(root) || !existsSync(f) || statSync(f).isDirectory()) { r.writeHead(404); return r.end(); }
    r.writeHead(200, { 'content-type': TYPES[extname(f).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' }); r.end(readFileSync(f));
  });
  return new Promise((ok) => s.listen(0, '127.0.0.1', () => ok(s)));
}

// Hosts Palm treats as needing consent (a list, not a rule). youtube-nocookie still contacts Google: a warning.
const TRACK = [/(^|\.)google-analytics\.com$/, /(^|\.)googletagmanager\.com$/, /(^|\.)doubleclick\.net$/, /(^|\.)facebook\.(net|com)$/, /(^|\.)hotjar\.com$/, /(^|\.)clarity\.ms$/, /(^|\.)plausible\.io$/, /(^|\.)stats\.g\.doubleclick\.net$/, /(^|\.)analytics\.tiktok\.com$/];
const EMBED = [/(^|\.)youtube\.com$/, /(^|\.)ytimg\.com$/, /(^|\.)vimeo\.com$/, /(^|\.)maps\.googleapis\.com$/, /(^|\.)maps\.gstatic\.com$/, /(^|\.)google\.[a-z.]+$/, /(^|\.)gstatic\.com$/];
const SOFT = [/(^|\.)youtube-nocookie\.com$/, /(^|\.)fonts\.googleapis\.com$/, /(^|\.)fonts\.gstatic\.com$/];
export function kindOf(host) {
  if (SOFT.some((r) => r.test(host))) return 'other';
  if (TRACK.some((r) => r.test(host))) return 'tracking';
  if (EMBED.some((r) => r.test(host))) return 'embed';
  return 'other';
}
const ESSENTIAL_COOKIE = /consent|cookie[_-]?(pref|choice|ok)|cc_|cmp|euconsent|choice|session|csrf/i;

// a fresh profile, other sites stubbed, every request to another site logged
async function freshPage(browser, base, { phone = true } = {}) {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  await p.setViewport(phone ? { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { width: 1280, height: 800, deviceScaleFactor: 1 });
  const log = [];
  await p.setRequestInterception(true);
  p.on('request', (q) => {
    const u = new URL(q.url());
    if (u.hostname === '127.0.0.1' || u.protocol === 'data:' || u.protocol === 'blob:') return q.continue();
    log.push({ host: u.hostname, kind: kindOf(u.hostname), type: q.resourceType(), t: Date.now() });
    const type = q.resourceType();
    q.respond({ status: 200, contentType: type === 'script' ? 'text/javascript' : type === 'stylesheet' ? 'text/css' : type === 'image' ? 'image/gif' : 'text/html', body: type === 'image' ? Buffer.from('R0lGODlhAQABAAAAACw=', 'base64') : '' });
  });
  return { ctx, p, log, open: async (path = '') => { await p.goto(base + path, { waitUntil: 'networkidle0', timeout: 30000 }).catch(() => {}); await new Promise((r) => setTimeout(r, 900)); } };
}

// find the banner and its buttons on the current page (visible elements only)
async function findBanner(p) {
  return p.evaluate(() => {
    const vis = (e) => { const s = getComputedStyle(e), r = e.getBoundingClientRect(); return s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0.05 && r.width > 2 && r.height > 2; };
    const txt = (e) => (e.innerText || e.value || e.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    const clickables = [...document.querySelectorAll('button, a, [role=button], input[type=button], input[type=submit]')].filter(vis);
    const ACC = /^(accept|allow|agree|i agree|ok|okay|got it|yes|accept all|allow all|accept cookies|allow cookies|accept and close|agree and close)\b|accept all|allow all/i;
    const REJ = /reject|decline|refuse|deny|necessary only|only necessary|essential only|only essential|no,? thanks|don.?t allow|do not accept|strictly necessary only/i;
    const SET = /settings|preferences|manage|customi[sz]e|choose|options|more choices/i;
    const accept = clickables.find((e) => ACC.test(txt(e)) && !REJ.test(txt(e)) && txt(e).length < 40);
    if (!accept) return null;
    let box = accept.parentElement;
    for (let i = 0; box && i < 8; i++) {
      const s = getComputedStyle(box);
      if (['fixed', 'sticky'].includes(s.position) || box.tagName === 'DIALOG' || box.getAttribute('role') === 'dialog' || box.getAttribute('aria-modal') === 'true') break;
      if (!box.parentElement || box.parentElement === document.body) break;
      box = box.parentElement;
    }
    const inside = clickables.filter((e) => box.contains(e));
    const reject = inside.find((e) => REJ.test(txt(e)) && txt(e).length < 50);
    const settings = inside.find((e) => SET.test(txt(e)) && e !== accept && e !== reject);
    const bgOf = (e) => { for (let x = e; x; x = x.parentElement) { const c = getComputedStyle(x).backgroundColor; if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return c; } return 'rgb(255, 255, 255)'; };
    const info = (e) => e && (() => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return { text: txt(e).slice(0, 40), w: Math.round(r.width), h: Math.round(r.height), color: s.color, bg: bgOf(e), tag: e.tagName.toLowerCase() }; })();
    for (const [e, k] of [[accept, 'accept'], [reject, 'reject'], [settings, 'settings']]) if (e) e.setAttribute('data-palm-consent', k);
    box.setAttribute('data-palm-consent', 'banner');
    const r = box.getBoundingClientRect();
    const checked = [...box.querySelectorAll('input[type=checkbox]')].filter((c) => c.checked && !c.disabled).length;
    return { accept: info(accept), reject: info(reject), settings: info(settings), rect: { x: r.x, y: r.y, w: r.width, h: r.height }, preticked: checked, text: txt(box).slice(0, 300) };
  });
}
const lum = (c) => { const m = c.match(/[\d.]+/g).map(Number); const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]); };
export const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const click = async (p, k) => { try { await p.click(`[data-palm-consent="${k}"]`); } catch { await p.evaluate((k) => document.querySelector(`[data-palm-consent="${k}"]`)?.click(), k); } await new Promise((r) => setTimeout(r, 1200)); };
const shot = async (p) => (await p.screenshot({ encoding: 'base64' }));
const summarise = (log) => { const o = {}; for (const l of log) { const k = `${l.kind}:${l.host}`; o[k] = (o[k] || 0) + 1; } return o; };

export async function check(target, { pages = null, out = 'look/consent', plain = false } = {}) {
  const root = resolve(target);
  const list = pages || readdirSync(root).filter((f) => /\.html?$/i.test(f)).sort((a, b) => (a === 'index.html' ? -1 : b === 'index.html' ? 1 : a.localeCompare(b)));
  mkdirSync(dirname(resolve(out)), { recursive: true });
  const server = await serve(root), base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await launch();
  const issues = [], shots = [], before = {};
  const add = (level, id, msg, extra = {}) => issues.push({ level, id, msg, ...extra });
  const NOTE = 'Not legal advice; regulators assess banners case by case.';
  let banner = null, reject = {}, accept = {};
  try {
    // 1. before any choice, every page, fresh profile each time
    for (const page of list) {
      const f = await freshPage(browser, base); await f.open(page === 'index.html' ? '' : page);
      const cookies = (await f.p.cookies()).map((c) => c.name);
      before[page] = { requests: summarise(f.log), cookies };
      const hosts = (k) => [...new Set(f.log.filter((l) => l.kind === k).map((l) => l.host))];
      if (hosts('tracking').length) add('error', 'tracking-before-consent', `${page}: before anyone chooses, the page contacts ${hosts('tracking').join(', ')} (analytics/ads). ePrivacy art. 5(3); EDPB taskforce para. 7. ${NOTE}`, { page });
      if (hosts('embed').length) add('error', 'embed-before-consent', `${page}: before anyone chooses, embedded content contacts ${hosts('embed').join(', ')}, which can set cookies. Load embeds after consent, or show a click-to-load placeholder. ${NOTE}`, { page });
      const soft = [...new Set(f.log.filter((l) => /youtube-nocookie/.test(l.host)).map((l) => l.host))];
      if (soft.length) add('warn', 'nocookie-embed', `${page}: youtube-nocookie.com still loads before anyone chooses; it sets fewer cookies but still contacts Google (Palm's note).`, { page });
      const nonEss = cookies.filter((c) => !ESSENTIAL_COOKIE.test(c));
      if (nonEss.length) add('error', 'cookies-before-consent', `${page}: cookies stored before anyone chooses: ${nonEss.join(', ')}. ${NOTE}`, { page });
      await f.ctx.close();
    }
    // 2. the banner on a phone: layers, buttons, coverage, keyboard
    const a = await freshPage(browser, base); await a.open();
    banner = await findBanner(a.p);
    shots.push({ label: 'Phone, first visit', b64: await shot(a.p) });
    if (!banner) add('error', 'no-banner', `No consent banner with an Accept button was found on the first visit. ${Object.keys(before['index.html']?.requests || {}).some((k) => !k.startsWith('other')) ? 'The site loads tracking or embeds, so it needs consent first. ' : ''}${NOTE}`);
    else {
      const ac = banner.accept, rj = banner.reject;
      if (!rj) add('error', 'reject-missing', `The banner has no Reject (or "necessary only") button on its first layer${banner.settings ? `; refusing takes "${banner.settings.text}" first` : ''}. EDPB taskforce, type A. ${NOTE}`);
      else {
        const ratio = (rj.w * rj.h) / Math.max(1, ac.w * ac.h);
        if (ratio < 0.6) add('warn', 'reject-smaller', `Reject ("${rj.text}") is ${Math.round(ratio * 100)}% the size of Accept ("${ac.text}"). Palm's measure: at least 60%.`);
        const cr = contrast(rj.color, rj.bg);
        if (cr < 3) add('error', 'reject-unreadable', `Reject's text has ${cr.toFixed(2)}:1 contrast with its background, hard to read. EDPB taskforce types D/E; WCAG 1.4.3 asks 4.5:1.`);
        else if (cr < 4.5) add('warn', 'reject-low-contrast', `Reject's text has ${cr.toFixed(2)}:1 contrast; WCAG 1.4.3 asks 4.5:1.`);
        if (rj.tag === 'a' && ac.tag === 'button' && contrast(rj.bg, ac.bg) > 1.5 && ratio < 0.8) add('warn', 'reject-as-link', 'Reject is a plain link next to an Accept button; make them look like equal choices (Palm\'s reading of the taskforce report).');
      }
      if (banner.preticked) add('error', 'preticked', `${banner.preticked} optional box(es) in the banner are ticked before anyone chooses. EDPB taskforce, type B; GDPR recital 32. ${NOTE}`);
      const share = (banner.rect.w * banner.rect.h) / (390 * 844);
      if (share > 0.5) add('warn', 'covers-phone', `On a 390 px phone the banner covers ${Math.round(share * 100)}% of the screen (Palm's measure: keep it under half, so people can see the page they came for).`);
      // keyboard: does Tab reach a banner button within 10 presses?
      await a.p.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
      let reached = 0;
      for (let i = 1; i <= 20 && !reached; i++) { await a.p.keyboard.press('Tab'); if (await a.p.evaluate(() => !!document.activeElement?.closest('[data-palm-consent="banner"]'))) reached = i; }
      if (!reached) add('error', 'banner-no-keyboard', 'Pressing Tab never reaches the banner\'s buttons (tried 20 times), so keyboard users can\'t choose. WCAG 2.1.1.');
      else if (reached > 10) add('warn', 'banner-late-keyboard', `The banner's buttons are only reached after ${reached} Tab presses; put the banner first in the page or focus it on load (Palm's measure).`);
    }
    await a.ctx.close();
    // desktop first visit
    const dsk = await freshPage(browser, base, { phone: false }); await dsk.open(); shots.push({ label: 'Desktop, first visit', b64: await shot(dsk.p), desktop: true }); await dsk.ctx.close();
    // 3. Reject, then reload: remembered, nothing loads, a way back
    if (banner?.reject) {
      const r = await freshPage(browser, base); await r.open(); await findBanner(r.p);
      const mark = r.log.length; await click(r.p, 'reject');
      const afterClick = r.log.slice(mark);
      const m2 = r.log.length; await r.open();
      const again = await findBanner(r.p);
      const afterReload = r.log.slice(m2);
      const cookies = (await r.p.cookies()).map((c) => c.name).filter((c) => !ESSENTIAL_COOKIE.test(c));
      reject = { afterClick: summarise(afterClick), afterReload: summarise(afterReload), cookies, remembered: !again };
      shots.push({ label: 'Phone, after Reject and a reload', b64: await shot(r.p) });
      const bad = [...new Set([...afterClick, ...afterReload].filter((l) => l.kind !== 'other').map((l) => l.host))];
      if (bad.length) add('error', 'tracking-after-reject', `After Reject (and a reload) the page still contacts ${bad.join(', ')}. ${NOTE}`);
      if (cookies.length) add('error', 'cookies-after-reject', `After Reject, cookies stored: ${cookies.join(', ')}. ${NOTE}`);
      if (again) add('error', 'reject-not-remembered', 'After Reject and a reload the banner asks again: the choice isn\'t remembered (storing it is strictly necessary and allowed).');
      // a way to reopen the choice
      const reopen = await r.p.evaluate(() => {
        const vis = (e) => { const s = getComputedStyle(e), b = e.getBoundingClientRect(); return s.visibility !== 'hidden' && s.display !== 'none' && b.width > 1 && b.height > 1; };
        // prefer a control that says it changes the choice ("Cookie settings", "Manage cookies"); a plain "About cookies"
        // or policy link only as a last resort
        const cands = [...document.querySelectorAll('a, button, [role=button]')].filter(vis).map((e) => [e, (e.innerText || e.getAttribute('aria-label') || '').trim()]).filter(([, t]) => /cookie|consent|privacy (settings|choices|preferences)/i.test(t));
        const el = (cands.find(([, t]) => /settings|preferences|manage|change|choices|withdraw|options/i.test(t)) || cands.find(([, t]) => !/policy|about|more about|learn more|information/i.test(t)) || [])[0];
        if (el) el.setAttribute('data-palm-consent', 'reopen'); return el ? (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 40) : null;
      });
      reject.reopen = reopen;
      if (!reopen) add('error', 'no-withdraw', 'After choosing, there\'s no visible "Cookie settings" link or button to change or withdraw the choice. EDPB taskforce paras. 32–34: withdrawing must be as easy as consenting, at any time.');
      else {
        await click(r.p, 'reopen');
        const back = await findBanner(r.p) || await r.p.evaluate(() => [...document.querySelectorAll('[role=dialog], dialog[open], [aria-modal=true]')].some((e) => e.getBoundingClientRect().height > 20));
        reject.reopens = !!back;
        if (!back) add('warn', 'withdraw-does-nothing', `"${reopen}" didn't bring the choice back when clicked.`);
      }
      await r.ctx.close();
    }
    // 4. Accept in a fresh profile: analytics should start
    if (banner?.accept) {
      const c = await freshPage(browser, base); await c.open(); await findBanner(c.p);
      const mark = c.log.length; await click(c.p, 'accept'); await c.open();
      accept = { after: summarise(c.log.slice(mark)), cookies: (await c.p.cookies()).map((x) => x.name) };
      shots.push({ label: 'Phone, after Accept and a reload', b64: await shot(c.p) });
      const hadTracking = Object.values(before).some((b) => Object.keys(b.requests).some((k) => k.startsWith('tracking'))) || existsSync(join(root, 'index.html')) && /googletagmanager|gtag\(|google-analytics|plausible/.test(readFileSync(join(root, 'index.html'), 'utf8'));
      if (hadTracking && !Object.keys(accept.after).some((k) => k.startsWith('tracking'))) add('warn', 'accept-no-analytics', 'After Accept (and a reload), no analytics request was made: the analytics may never start (Palm\'s check).');
      await c.ctx.close();
    }
    // the sheet: screenshots, plus a neutral log of what each state contacted (facts, not verdicts)
    const sheet = resolve(out + '-sheet.png');
    const fmt = (o) => Object.keys(o || {}).length ? Object.entries(o).map(([k, n]) => `${k.split(':')[1]} (${n})`).join(', ') : 'nothing';
    const logRows = [
      ...Object.entries(before).map(([pg, b]) => [`Before any choice — ${pg}`, fmt(b.requests), b.cookies.join(', ') || 'none']),
      ...(banner?.reject ? [['After Reject — the click', fmt(reject.afterClick), ''], ['After Reject — reload', fmt(reject.afterReload), reject.cookies.join(', ') || 'none'], ['After Reject — banner shown again on reload', reject.remembered ? 'no' : 'yes', ''], ['Link to change the choice later', reject.reopen ? `"${reject.reopen}"` : 'none found', '']] : [['Reject button on the first layer', 'none found', '']]),
      ...(banner?.accept ? [['After Accept — reload', fmt(accept.after), accept.cookies.join(', ') || 'none']] : []),
    ];
    const notes = plain ? '' : `<ul class="n">${issues.map((i) => `<li class="${i.level}">${i.msg.replace(/</g, '&lt;')}</li>`).join('')}</ul>`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:24px;background:#d9d8d4;font:14px/1.4 -apple-system,Helvetica,Arial,sans-serif;color:#222;width:1900px}h2{font:600 13px/1 -apple-system,Helvetica;letter-spacing:.08em;text-transform:uppercase;color:#444;margin:22px 0 10px}.row{display:flex;gap:16px;align-items:flex-start}.lab{font-size:11px;color:#555;margin-bottom:4px}img{display:block;border:1px solid #999;background:#fff}table{border-collapse:collapse;background:#fff;font-size:13px}td,th{border:1px solid #bbb;padding:6px 10px;text-align:left;vertical-align:top;max-width:900px}.n{font-size:12px}.n .error{color:#b00020}.n .warn{color:#7a5200}</style></head><body>
<h2>The banner</h2><div class="row">${shots.map((s) => `<div><div class="lab">${s.label}</div><img src="data:image/png;base64,${s.b64}" style="width:${s.desktop ? 640 : 300}px"></div>`).join('')}</div>
<h2>What the page contacted (other sites, requests) and the cookies it stored — a fresh browser each time</h2><table><tr><th>When</th><th>Other sites contacted</th><th>Cookies stored</th></tr>${logRows.map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td></tr>`).join('')}</table>${notes}</body></html>`;
    const sp = await browser.newPage(); await sp.setViewport({ width: 1950, height: 1000, deviceScaleFactor: 1 });
    await sp.setContent(html, { waitUntil: 'load' }); await new Promise((r) => setTimeout(r, 300));
    await sp.screenshot({ path: sheet, fullPage: true });
    const errors = issues.filter((i) => i.level === 'error').length, warnings = issues.filter((i) => i.level === 'warn').length;
    return { ok: errors === 0 && !!banner, errors, warnings, banner, before, reject, accept, issues, sheet, note: NOTE };
  } finally { await browser.close(); server.close(); }
}

// ---------- self-test ----------
async function selfTest() {
  const d = mkdtempSync(join(tmpdir(), 'consent-test-'));
  const page = (head, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Café</title>${head}<style>body{font:16px Helvetica;margin:0}main{padding:16px}.cb{position:fixed;left:0;right:0;bottom:0;background:#fff;border-top:1px solid #ccc;padding:16px}.cb button{font-size:16px;padding:12px 18px;margin:4px}.cb .accept{background:#0a5;color:#fff;border:0}.cb .reject{background:#fff;color:#111;border:1px solid #111}</style></head><body>${body}</body></html>`;
  // bad: GA in the head, a YouTube iframe, Accept + "settings" only, a pale "no" link, a pre-ticked box, nothing remembered
  writeFileSync(join(d, 'index.html'), page(`<script async src="https://www.googletagmanager.com/gtag/js?id=G-TEST"></script><script>document.cookie='_ga=GA1.1.1;path=/'</script>`,
    `<main><h1>Café</h1><iframe src="https://www.youtube.com/embed/abc" width="300" height="170"></iframe><p>Menu…</p></main>
<div class="cb" style="height:600px"><p>We use cookies.</p><label><input type="checkbox" checked> Analytics</label><button class="accept" onclick="this.parentElement.remove()">Accept all</button><a href="#" style="color:#ddd;font-size:11px">Cookie settings</a></div>`));
  const r = await check(d, { out: join(d, 'look/bad') });
  const got = new Set(r.issues.map((i) => i.id));
  for (const want of ['tracking-before-consent', 'embed-before-consent', 'cookies-before-consent', 'reject-missing', 'preticked', 'covers-phone']) if (!got.has(want)) throw new Error(`bad: expected ${want}, got ${[...got].join(', ')}`);
  if (!existsSync(r.sheet)) throw new Error('no sheet');
  // good: nothing before consent, Accept and Reject side by side, remembered, a cookie-settings link that reopens it,
  // analytics and the video load only after Accept
  writeFileSync(join(d, 'index.html'), page('', `<main><h1>Café</h1><div id="v"><button id="play">Load the video (YouTube)</button></div><p>Menu…</p>
<footer><button id="reopen">Cookie settings</button></footer></main>
<div class="cb" id="cb" role="dialog" aria-label="Cookies" hidden><p>Can we use analytics cookies?</p><button class="reject" id="no">Reject</button><button class="accept" id="yes">Accept</button></div>
<script>
const KEY='consent';const s=localStorage.getItem(KEY);const cb=document.getElementById('cb');
function analytics(){const x=document.createElement('script');x.src='https://www.googletagmanager.com/gtag/js?id=G-TEST';document.head.append(x);}
function show(){cb.hidden=false;document.getElementById('no').focus();}
if(!s)show();else if(s==='yes')analytics();
document.getElementById('yes').onclick=()=>{localStorage.setItem(KEY,'yes');cb.hidden=true;analytics();};
document.getElementById('no').onclick=()=>{localStorage.setItem(KEY,'no');cb.hidden=true;};
document.getElementById('reopen').onclick=show;
document.getElementById('play').onclick=()=>{document.getElementById('v').innerHTML='<iframe src="https://www.youtube.com/embed/abc"></iframe>';};
</script>`));
  const g = await check(d, { out: join(d, 'look/good') });
  if (g.errors) throw new Error('good flagged: ' + g.issues.filter((i) => i.level === 'error').map((i) => `${i.id}: ${i.msg}`).join(' | '));
  if (!g.reject.remembered || !g.reject.reopens) throw new Error('good: reject not remembered or reopen failed ' + JSON.stringify(g.reject));
  console.log(`consent-check: all tests pass (bad: ${[...got].join(', ')}; good: ${g.warnings} warnings ${g.issues.map((i) => i.id).join(', ')})`);
}

if (typeof process !== 'undefined' && process.argv?.[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
  const VALUED = new Set(['--out', '--pages']);
  const pos = argv.filter((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1]));
  const done = (r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); };
  const fail = (e) => { console.error(String(e.message || e)); process.exit(2); };
  if (argv.includes('--test')) selfTest().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
  else if (pos[0] === 'check' && pos[1]) check(pos[1], { pages: opt('pages') ? opt('pages').split(',') : null, out: opt('out', 'look/consent') }).then(done, fail);
  else fail('usage: consent-check.mjs check <site folder> [--pages index.html,about.html] [--out look/consent]\n       consent-check.mjs --test');
}
