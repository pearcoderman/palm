#!/usr/bin/env node
// Palm tool: event-check — lets an agent see its event page the way attendees, calendars and Google will: the page on
// a phone, the event as Google might list it (Palm's mock), every calendar entry (.ics files and "Add to Google
// Calendar" links) converted to the times people in other time zones will see, and the link card. Event pages break
// in ways you can't see in the HTML: a time with no time zone (a "floating" calendar time shows 18:00 in New York and
// in Tokyo alike), a calendar file whose time disagrees with the page, a Google Calendar link that drops the zone, a
// .ics file other apps refuse, an online event whose page never says which time zone, and Event data Google can't use.
// adds: tool. Runs on the user's machine with their Chrome/Edge/Chromium; nothing leaves it.
//
//   node event-check.mjs check <site folder> [--pages index.html,events.html] [--zones Europe/Lisbon,America/New_York,Asia/Tokyo] [--out look/event]
//       → JSON {ok, errors, warnings, events, calendars, issues, sheet}. Then LOOK at the sheet.
//   node event-check.mjs --test
//
// Sources:
// - Google Search Central, "Event (Event, EventSeries) structured data" (developers.google.com/search/docs/appearance/
//   structured-data/event, last updated 2026-09-08, read 2026-11-25): required name, startDate (ISO 8601) and location
//   (Place with name and address); recommended description, endDate, eventStatus, image (1920 px wide recommended,
//   720 px minimum), offers, organizer, performer; give the UTC offset ("If no timezone is provided, Google uses the
//   timezone of the event's location"); "Virtual experiences that have no real-world component aren't supported.
//   Events must take place in a physical location."
// - RFC 5545 (iCalendar): content lines end in CRLF and SHOULD be folded at 75 octets (3.1); VCALENDAR needs PRODID and
//   VERSION (3.6); VEVENT needs UID and DTSTAMP, and DTSTART when there's no METHOD (3.6.1); a TZID parameter needs a
//   VTIMEZONE for it in the file (3.2.19); a DATE-TIME with neither Z nor TZID is a "floating" time, the same clock time
//   in every time zone (3.3.5).
// Palm's guidance, not a standard: the Google Calendar "Add to calendar" link format (action=TEMPLATE, dates=start/end
// as YYYYMMDDTHHMMSSZ, or local times with ctz=) is Google's undocumented-but-stable link format; whether the page text
// names a time zone for an online event; the Google result drawing is Palm's mock, not Google's layout.

import { readFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, extname, relative } from 'node:path';
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
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon', '.json': 'application/json', '.ics': 'text/calendar' };
function serve(root) {
  const s = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html';
    const f = join(root, p);
    if (!f.startsWith(root) || !existsSync(f) || statSync(f).isDirectory()) { r.writeHead(404); return r.end(); }
    r.writeHead(200, { 'content-type': TYPES[extname(f).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' }); r.end(readFileSync(f));
  });
  return new Promise((ok) => s.listen(0, '127.0.0.1', () => ok(s)));
}
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---- time zones (Intl only) ----
function offsetMs(t, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - t;
}
export function zonedToUtc(y, mo, d, h, mi, s, tz) {
  let t = Date.UTC(y, mo - 1, d, h, mi, s);
  for (let i = 0; i < 3; i++) t = Date.UTC(y, mo - 1, d, h, mi, s) - offsetMs(t, tz);
  return t;
}
export const fmtIn = (t, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' }).format(new Date(t));
const validZone = (tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } };

// ISO 8601 as schema.org uses it. Returns {t (UTC ms) | local (wall-clock parts), offset: bool, dateOnly}.
export function parseIso(v) {
  const m = String(v || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i);
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00', s = '00', z] = m;
  if (!m[4]) return { dateOnly: true, local: [+y, +mo, +d, 0, 0, 0], offset: false };
  if (!z) return { local: [+y, +mo, +d, +h, +mi, +s], offset: false };
  const off = z.toUpperCase() === 'Z' ? 0 : (z[0] === '-' ? -1 : 1) * (+z.slice(1, 3) * 60 + +z.replace(':', '').slice(3, 5)) * 60000;
  return { t: Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) - off, offset: true };
}

// ---- iCalendar (RFC 5545 essentials) ----
export function parseIcs(raw) {
  const problems = [];
  const lfOnly = /\n/.test(raw) && !/\r\n/.test(raw);
  const mixed = /\r\n/.test(raw) && /[^\r]\n/.test(raw);
  if (lfOnly) problems.push({ level: 'warn', id: 'ics-lf', msg: 'Lines end in LF, not CRLF (RFC 5545 3.1). Most apps cope; strict ones (some Outlook versions) refuse the file.' });
  else if (mixed) problems.push({ level: 'warn', id: 'ics-lf', msg: 'Some lines end in LF instead of CRLF (RFC 5545 3.1).' });
  const physical = raw.split(/\r?\n/);
  const long = physical.filter((l) => Buffer.byteLength(l, 'utf8') > 75).length;
  if (long) problems.push({ level: 'warn', id: 'ics-long-lines', msg: `${long} line${long > 1 ? 's are' : ' is'} longer than 75 octets and not folded (RFC 5545 3.1 says SHOULD fold); some apps cut or reject them.` });
  const lines = [];
  for (const l of physical) { if (/^[ \t]/.test(l) && lines.length) lines[lines.length - 1] += l.slice(1); else if (l.length) lines.push(l); }
  const parsed = lines.map((l) => { const i = l.search(/[:]/); const head = l.slice(0, i), value = l.slice(i + 1); const [name, ...ps] = head.split(';'); return { name: name.toUpperCase(), params: Object.fromEntries(ps.map((p) => { const [k, ...v] = p.split('='); return [k.toUpperCase(), v.join('=').replace(/^"|"$/g, '')]; })), value }; });
  const stack = []; const events = []; const tzids = new Set(); let cal = null; let cur = null;
  for (const p of parsed) {
    if (p.name === 'BEGIN') { stack.push(p.value.toUpperCase()); if (p.value.toUpperCase() === 'VCALENDAR') cal = { props: {} }; if (p.value.toUpperCase() === 'VEVENT') cur = { props: {}, raw: {} }; continue; }
    if (p.name === 'END') { const v = stack.pop(); if (v === 'VEVENT' && cur) { events.push(cur); cur = null; } continue; }
    const top = stack[stack.length - 1];
    if (top === 'VTIMEZONE' && p.name === 'TZID') tzids.add(p.value);
    if (top === 'VEVENT' && cur) { cur.props[p.name] = p.value; cur.raw[p.name] = p; }
    else if (top === 'VCALENDAR' && cal) cal.props[p.name] = p.value;
  }
  if (!cal) return { events: [], problems: [...problems, { level: 'error', id: 'ics-invalid', msg: 'Not an iCalendar file: no BEGIN:VCALENDAR.' }] };
  if (!cal.props.VERSION) problems.push({ level: 'error', id: 'ics-version', msg: 'No VERSION:2.0 in VCALENDAR (RFC 5545 3.6: required).' });
  if (!cal.props.PRODID) problems.push({ level: 'error', id: 'ics-prodid', msg: 'No PRODID in VCALENDAR (RFC 5545 3.6: required).' });
  if (!events.length) problems.push({ level: 'error', id: 'ics-no-event', msg: 'No VEVENT in the file.' });
  const time = (p) => {
    if (!p) return null;
    const m = p.value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
    if (!m) return { bad: true };
    const [, y, mo, d, h, mi, s, z] = m;
    if (!h) return { dateOnly: true, local: [+y, +mo, +d, 0, 0, 0] };
    if (z) return { t: Date.UTC(+y, +mo - 1, +d, +h, +mi, +s), how: 'UTC' };
    if (p.params.TZID) { const tz = p.params.TZID.replace(/^\//, ''); return validZone(tz) ? { t: zonedToUtc(+y, +mo, +d, +h, +mi, +s, tz), how: tz, tzid: p.params.TZID } : { local: [+y, +mo, +d, +h, +mi, +s], how: 'unknown zone ' + tz, tzid: p.params.TZID, unknownZone: true }; }
    return { local: [+y, +mo, +d, +h, +mi, +s], floating: true };
  };
  const out = events.map((e, i) => {
    const name = (e.props.SUMMARY || `event ${i + 1}`).replace(/\\([,;\\])/g, '$1').replace(/\\n/gi, ' ');
    const pr = [];
    if (!e.props.UID) pr.push({ level: 'error', id: 'ics-uid', msg: `"${name}": no UID (RFC 5545 3.6.1: required; calendars can't tell updates from new events).` });
    if (!e.props.DTSTAMP) pr.push({ level: 'error', id: 'ics-dtstamp', msg: `"${name}": no DTSTAMP (RFC 5545 3.6.1: required).` });
    const start = time(e.raw.DTSTART), end = time(e.raw.DTEND);
    if (!start) pr.push({ level: 'error', id: 'ics-no-start', msg: `"${name}": no DTSTART.` });
    else if (start.bad) pr.push({ level: 'error', id: 'ics-bad-time', msg: `"${name}": DTSTART "${e.raw.DTSTART.value}" isn't an iCalendar date-time.` });
    else if (start.floating) pr.push({ level: 'error', id: 'ics-floating', msg: `"${name}": DTSTART has no time zone (no Z, no TZID): a "floating" time (RFC 5545 3.3.5). Every calendar shows the same clock time wherever the attendee is, so someone in New York or Tokyo sees the wrong time.` });
    if (start?.tzid && !tzids.has(start.tzid)) pr.push({ level: 'warn', id: 'ics-vtimezone', msg: `"${name}": TZID=${start.tzid} but the file has no VTIMEZONE for it (RFC 5545 3.2.19: MUST). Apple and Google Calendar read the zone name anyway; some Outlook versions don't.` });
    if (start?.unknownZone) pr.push({ level: 'error', id: 'ics-zone', msg: `"${name}": TZID=${start.tzid} isn't a time zone calendars know (use an IANA name such as Europe/Lisbon).` });
    if (start?.t && end?.t && end.t <= start.t) pr.push({ level: 'error', id: 'ics-end-before-start', msg: `"${name}": DTEND is at or before DTSTART.` });
    return { name, start, end, uid: e.props.UID, location: (e.props.LOCATION || '').replace(/\\([,;\\])/g, '$1'), problems: pr };
  });
  return { events: out, problems };
}

// Google Calendar "Add to calendar" link: dates=START/END as YYYYMMDDTHHMMSSZ (UTC) or local times with ctz=Zone.
export function parseGcal(href) {
  let u; try { u = new URL(href, 'https://x/'); } catch { return null; }
  if (!/calendar\.google\.com$/.test(u.hostname)) return null;
  const dates = u.searchParams.get('dates') || '', ctz = u.searchParams.get('ctz') || '';
  const text = u.searchParams.get('text') || '';
  const [a, b] = dates.split('/');
  const one = (v) => {
    const m = (v || '').match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
    if (!m) return null;
    const [, y, mo, d, h, mi, s, z] = m;
    if (!h) return { dateOnly: true };
    if (z) return { t: Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) };
    if (ctz && validZone(ctz)) return { t: zonedToUtc(+y, +mo, +d, +h, +mi, +s, ctz), ctz };
    return { local: [+y, +mo, +d, +h, +mi, +s], floating: true };
  };
  return { text, action: u.searchParams.get('action'), start: one(a), end: one(b), raw: dates, ctz };
}

// Event nodes in a JSON-LD blob (arrays, @graph, subtypes such as EducationEvent).
function eventNodes(x, out = []) {
  if (Array.isArray(x)) { x.forEach((y) => eventNodes(y, out)); return out; }
  if (!x || typeof x !== 'object') return out;
  const t = [].concat(x['@type'] || []).map(String);
  if (t.some((y) => /Event$/.test(y) && y !== 'EventSeries')) out.push(x);
  if (x['@graph']) eventNodes(x['@graph'], out);
  if (x.subEvent) eventNodes(x.subEvent, out);
  return out;
}
const enumOk = (v, allowed) => allowed.some((a) => String(v || '').replace(/^https?:\/\/schema\.org\//, '') === a);

export async function check(target, { pages = null, zones = null, out = 'look/event', plain = false } = {}) {
  const root = resolve(target);
  const walk = (d, depth = 0) => readdirSync(d).flatMap((f) => { const p = join(d, f); if (/^(palm|look|node_modules|\.)/.test(f)) return []; const s = statSync(p); return s.isDirectory() ? (depth < 2 ? walk(p, depth + 1) : []) : [p]; });
  const files = walk(root);
  const htmls = (pages ? pages.map((p) => join(root, p)) : files.filter((f) => /\.html?$/i.test(f))).filter(existsSync);
  const icsFiles = files.filter((f) => /\.ics$/i.test(f));
  const issues = []; const add = (level, id, where, msg) => issues.push({ level, id, where, msg });
  const srv = await serve(root); const base = `http://127.0.0.1:${srv.address().port}`;
  const browser = await launch();
  const events = []; const gcals = []; const shots = []; const cards = [];
  try {
    for (const f of htmls) {
      const rel = relative(root, f).split('\\').join('/');
      const pg = await browser.newPage(); await pg.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
      await pg.goto(`${base}/${rel}`, { waitUntil: 'networkidle0', timeout: 60000 }).catch(() => {});
      const info = await pg.evaluate(() => ({
        ld: [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent),
        gcal: [...document.querySelectorAll('a[href*="calendar.google.com"]')].map((a) => a.href),
        icsLinks: [...document.querySelectorAll('a[href$=".ics" i], a[href*=".ics?" i]')].map((a) => a.getAttribute('href')),
        text: document.body ? document.body.innerText : '',
        og: Object.fromEntries([...document.querySelectorAll('meta[property^="og:"], meta[name^="twitter:"]')].map((m) => [m.getAttribute('property') || m.getAttribute('name'), m.getAttribute('content')])),
        title: document.title,
        wide: document.documentElement.scrollWidth > window.innerWidth + 1,
      }));
      const shot = join(mkdtempSync(join(tmpdir(), 'event-check-')), 'phone.png');
      await pg.screenshot({ path: shot, fullPage: true, captureBeyondViewport: true }).catch(() => {});
      shots.push({ page: rel, phone: shot });
      if (info.wide) add('warn', 'scrolls-sideways', rel, `${rel} scrolls sideways on a 390 px phone.`);
      const pageEvents = [];
      for (const raw of info.ld) {
        let j; try { j = JSON.parse(raw); } catch (e) { add('error', 'jsonld-invalid', rel, `${rel}: a JSON-LD block doesn't parse (${String(e.message).slice(0, 80)}), so Google ignores it.`); continue; }
        for (const ev of eventNodes(j)) pageEvents.push(ev);
      }
      if (!pageEvents.length && (info.gcal.length || info.icsLinks.length || /\b(workshop|event|webinar|class)\b/i.test(info.title))) add('warn', 'no-event-data', rel, `${rel}: no schema.org Event data, so Google can't list the event in its event results.`);
      for (const ev of pageEvents) {
        const name = String(ev.name || '(no name)');
        const where = `${rel}: "${name}"`;
        const loc = [].concat(ev.location || []);
        const place = loc.find((l) => /Place/.test([].concat(l?.['@type'] || []).join(' ')) && !/Virtual/.test([].concat(l?.['@type'] || []).join(' ')));
        const virtual = loc.find((l) => /VirtualLocation/.test([].concat(l?.['@type'] || []).join(' ')));
        const mode = String(ev.eventAttendanceMode || '').replace(/^https?:\/\/schema\.org\//, '');
        if (!ev.name) add('error', 'event-name', where, `${where}: no name (Google: required).`);
        const s = parseIso(ev.startDate), e2 = parseIso(ev.endDate);
        if (!ev.startDate) add('error', 'event-start', where, `${where}: no startDate (Google: required).`);
        else if (!s) add('error', 'event-start', where, `${where}: startDate "${ev.startDate}" isn't ISO 8601.`);
        // the venue's zone, for times written without an offset (Google uses the location's zone)
        const venueTz = zones?.[0] || null;
        let st = s?.t ?? (s?.local && venueTz ? zonedToUtc(...s.local, venueTz) : null);
        let en = e2?.t ?? (e2?.local && venueTz ? zonedToUtc(...e2.local, venueTz) : null);
        if (s && !s.offset && !s.dateOnly) {
          if (place) add('warn', 'event-offset', where, `${where}: startDate "${ev.startDate}" has no UTC offset. Google falls back to the venue's time zone, but other readers (calendar apps, aggregators) treat it as local to whoever reads it. Google: "Specify the timezone by including the UTC or GMT time offset."`);
          else add('error', 'event-offset', where, `${where}: startDate "${ev.startDate}" has no UTC offset and no venue to take a time zone from, so nobody can tell when it starts.`);
        }
        if (!ev.endDate) add('warn', 'event-end', where, `${where}: no endDate (Google: recommended).`);
        else if (st != null && en != null && en <= st) add('error', 'event-end-before-start', where, `${where}: endDate is at or before startDate.`);
        if (!place && !virtual) add('error', 'event-location', where, `${where}: no location (Google: required, a Place with a name and an address).`);
        if (place) {
          if (!place.name) add('error', 'event-place-name', where, `${where}: location has no name (Google: required).`);
          if (!place.address) add('error', 'event-address', where, `${where}: location has no address (Google: required).`);
        }
        if (virtual && !place) add('warn', 'event-online-only', where, `${where}: an online-only event. Google: "Virtual experiences that have no real-world component aren't supported. Events must take place in a physical location", so this one won't appear in Google's event results however it's marked up. Make sure the page itself is clear (time zone, how to join).`);
        if (ev.eventStatus && !enumOk(ev.eventStatus, ['EventScheduled', 'EventCancelled', 'EventPostponed', 'EventRescheduled', 'EventMovedOnline'])) add('error', 'event-status', where, `${where}: eventStatus "${ev.eventStatus}" isn't a schema.org EventStatusType.`);
        if (!ev.eventStatus) add('warn', 'event-status', where, `${where}: no eventStatus (Google: recommended; EventScheduled is assumed).`);
        if (ev.eventAttendanceMode && !enumOk(ev.eventAttendanceMode, ['OfflineEventAttendanceMode', 'OnlineEventAttendanceMode', 'MixedEventAttendanceMode'])) add('error', 'event-mode', where, `${where}: eventAttendanceMode "${ev.eventAttendanceMode}" isn't a schema.org value.`);
        if (virtual && mode === 'OfflineEventAttendanceMode') add('error', 'event-mode', where, `${where}: an online location but eventAttendanceMode is Offline.`);
        if (!ev.image) add('warn', 'event-image', where, `${where}: no image (Google: recommended, 1920 px wide, at least 720).`);
        if (!ev.description) add('warn', 'event-description', where, `${where}: no description (Google: recommended).`);
        const offers = [].concat(ev.offers || []);
        if (!offers.length) add('warn', 'event-offers', where, `${where}: no offers (Google: recommended: price, priceCurrency, availability, url).`);
        for (const o of offers) { const miss = ['price', 'priceCurrency', 'availability', 'url'].filter((k) => o?.[k] == null || o?.[k] === ''); if (miss.length) add('warn', 'event-offer-fields', where, `${where}: offer is missing ${miss.join(', ')} (Google: recommended).`); }
        if (!ev.organizer) add('warn', 'event-organizer', where, `${where}: no organizer (Google: recommended).`);
        if ((virtual || mode === 'OnlineEventAttendanceMode' || mode === 'MixedEventAttendanceMode') && !/\b(UTC|GMT|WET|WEST|CET|CEST|BST|EST|EDT|PST|PDT|JST|time zone|timezone|Lisbon time|London time|your time|local time)\b/i.test(info.text)) add('warn', 'page-timezone', where, `${where}: an online event, but the page text never names a time zone (UTC, Lisbon time, "your local time"…), so people abroad can't tell when it starts.`);
        const imgs = [].concat(ev.image || []).map((x) => typeof x === 'string' ? x : x?.url).filter(Boolean);
        pageEvents.length && events.push({ page: rel, name, start: st, end: en, startRaw: ev.startDate, place: place ? { name: place.name, address: typeof place.address === 'string' ? place.address : [place.address?.streetAddress, place.address?.addressLocality, place.address?.addressCountry].filter(Boolean).join(', ') } : null, online: !!virtual || /Online|Mixed/.test(mode), price: offers[0] ? `${offers[0].price ?? ''} ${offers[0].priceCurrency ?? ''}`.trim() : '', image: imgs[0] || '', status: String(ev.eventStatus || '').replace(/^https?:\/\/schema\.org\//, '') });
      }
      for (const h of info.gcal) { const g = parseGcal(h); if (g) gcals.push({ page: rel, ...g }); }
      for (const l of info.icsLinks) { const p = join(dirname(f), l.split('?')[0]); if (!/^https?:/.test(l) && !existsSync(p) && !existsSync(join(root, l.split('?')[0]))) add('error', 'ics-link-broken', rel, `${rel}: "Add to calendar" links to ${l}, which isn't in the site.`); }
      cards.push({ page: rel, og: info.og, title: info.title });
      if (pageEvents.length && !info.og['og:image']) add('warn', 'card-image', rel, `${rel}: no og:image, so a shared link shows no picture.`);
      await pg.close();
    }
    // calendar files
    const calendars = [];
    for (const f of icsFiles) {
      const rel = relative(root, f).split('\\').join('/');
      const r = parseIcs(readFileSync(f, 'utf8'));
      for (const p of r.problems) add(p.level, p.id, rel, `${rel}: ${p.msg}`);
      for (const e of r.events) { for (const p of e.problems) add(p.level, p.id, rel, `${rel}: ${p.msg}`); calendars.push({ file: rel, ...e }); }
    }
    for (const g of gcals) {
      const n = `${g.page}: Google Calendar link "${g.text || '(no title)'}"`;
      if (g.action !== 'TEMPLATE') add('error', 'gcal-action', g.page, `${n}: action isn't TEMPLATE, so Google Calendar doesn't open an event.`);
      if (!g.start || !g.end) add('error', 'gcal-dates', g.page, `${n}: dates "${g.raw}" isn't start/end as YYYYMMDDTHHMMSSZ.`);
      else if (g.start.floating) add('error', 'gcal-floating', g.page, `${n}: dates have no Z and no ctz=, so Google Calendar puts the event at that clock time in each person's own zone (wrong for anyone outside the venue's zone).`);
      else if (g.start.t != null && g.end.t != null && g.end.t <= g.start.t) add('error', 'gcal-end-before-start', g.page, `${n}: end is at or before start.`);
    }
    // everything agrees: each calendar entry starts when some Event on the page says, and vice versa
    const near = (a, b) => a != null && b != null && Math.abs(a - b) < 60000;
    const pageStarts = events.map((e) => e.start).filter((x) => x != null);
    for (const c of calendars) if (c.start?.t != null && pageStarts.length && !pageStarts.some((t) => near(t, c.start.t))) add('error', 'ics-time-mismatch', c.file, `${c.file}: "${c.name}" starts ${fmtIn(c.start.t, 'UTC')} UTC, but no Event on the page starts then (${events.map((e) => e.start != null ? fmtIn(e.start, 'UTC') : e.startRaw).join('; ')}). Attendees would get the wrong time.`);
    for (const g of gcals) if (g.start?.t != null && pageStarts.length && !pageStarts.some((t) => near(t, g.start.t))) add('error', 'gcal-time-mismatch', g.page, `${g.page}: Google Calendar link "${g.text}" starts ${fmtIn(g.start.t, 'UTC')} UTC, but no Event on the page starts then.`);
    for (const e of events) if (e.start != null && !calendars.some((c) => near(c.start?.t, e.start)) && !gcals.some((g) => near(g.start?.t, e.start))) add('warn', 'no-calendar', e.page, `${e.page}: "${e.name}" has no calendar file or Google Calendar link at its start time, so people can't add it in one tap.`);
    if (!events.length) add('error', 'no-events', '', 'No schema.org Event found on any page.');

    // the sheet: phone pages, Google mock, calendars in zones, link cards
    const Z = zones?.length ? zones : ['Europe/Lisbon', 'Europe/London', 'America/New_York', 'Asia/Tokyo'];
    const sheet = resolve(out + '-sheet.png'); mkdirSync(dirname(sheet), { recursive: true });
    const img = (p) => existsSync(p) ? `data:image/png;base64,${readFileSync(p).toString('base64')}` : '';
    const local = (u) => { if (!u) return ''; try { const x = new URL(u, base + '/'); const p = join(root, decodeURIComponent(x.pathname)); return existsSync(p) && statSync(p).isFile() ? `data:${TYPES[extname(p).toLowerCase()] || 'image/jpeg'};base64,${readFileSync(p).toString('base64')}` : ''; } catch { return ''; } };
    const when = (t) => t == null ? '<i>no usable time</i>' : Z.map((z) => `<div>${esc(z.split('/').pop().replace('_', ' '))}: <b>${esc(fmtIn(t, z))}</b></div>`).join('');
    const calRow = (label, start) => `<div class="cal"><div class="ct">${esc(label)}</div>${start?.floating ? `<div class="warnbox">No time zone in the file: every calendar shows ${String(start.local[3]).padStart(2, '0')}:${String(start.local[4]).padStart(2, '0')} wherever you are</div>` + Z.map((z) => `<div>${esc(z.split('/').pop().replace('_', ' '))}: <b>${String(start.local[3]).padStart(2, '0')}:${String(start.local[4]).padStart(2, '0')}</b></div>`).join('') : start?.t != null ? when(start.t) : '<i>no usable start</i>'}</div>`;
    const googleMock = events.map((e) => `<div class="g"><div class="gd">${e.start != null ? esc(new Intl.DateTimeFormat('en-GB', { timeZone: Z[0], day: 'numeric', month: 'short' }).format(new Date(e.start))) : '?'}</div><div><div class="gn">${esc(e.name)}</div><div class="gs">${e.start != null ? esc(new Intl.DateTimeFormat('en-GB', { timeZone: Z[0], weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(e.start))) : esc(e.startRaw || '')}${e.place ? ' · ' + esc(e.place.name || '') : e.online ? ' · Online' : ''}</div><div class="gs">${esc(e.place?.address || '')}${e.price ? ' · ' + esc(e.price) : ''}</div>${e.online && !e.place ? '<div class="note">Online only: not eligible for Google\'s event results</div>' : ''}</div></div>`).join('') || '<i>No Event data</i>';
    const cardHtml = cards.filter((c) => c.og['og:title'] || c.og['og:image']).map((c) => `<div class="card">${local(c.og['og:image']) ? `<img src="${local(c.og['og:image'])}">` : '<div class="noimg">no image</div>'}<div class="cb"><div class="cn">${esc(c.og['og:title'] || c.title)}</div><div class="cs">${esc(c.og['og:description'] || '')}</div></div></div>`).join('') || '<i>No link card tags</i>';
    const notes = plain ? '' : `<h2>Problems</h2><ul class="n">${issues.slice(0, 30).map((i) => `<li class="${i.level}">${esc(i.msg)}</li>`).join('')}</ul>`;
    const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:24px;font:14px/1.4 -apple-system,system-ui,sans-serif;background:#f3f3f1;color:#111;width:1400px}h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#555;margin:22px 0 10px}.row{display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap}.ph{width:390px;background:#fff;box-shadow:0 1px 4px #0003}.ph img{width:390px;display:block}.lab{font-size:12px;color:#555;margin:4px 0}.gwrap{background:#fff;border-radius:8px;padding:14px;width:600px}.g{display:flex;gap:12px;padding:10px 0;border-bottom:1px solid #eee}.gd{width:54px;text-align:center;font-weight:600;color:#1a73e8}.gn{color:#1a0dab;font-size:16px}.gs{color:#4d5156;font-size:13px}.note{color:#b3261e;font-size:12px}.cal{background:#fff;border-radius:8px;padding:12px;width:300px}.ct{font-weight:600;margin-bottom:6px}.warnbox{background:#fde8e6;color:#8a1c12;padding:6px;border-radius:4px;margin-bottom:6px;font-size:12px}.card{width:320px;background:#fff;border:1px solid #ddd;border-radius:10px;overflow:hidden}.card img{width:320px;height:168px;object-fit:cover;display:block}.noimg{height:120px;background:repeating-linear-gradient(45deg,#fdd,#fdd 8px,#fee 8px,#fee 16px);display:flex;align-items:center;justify-content:center;color:#a00}.cb{padding:8px 10px}.cn{font-weight:600}.cs{color:#555;font-size:12px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.n li.error{color:#b3261e}.n li.warn{color:#8a5a00}</style>
<h2>Each page on a phone (390 px)</h2><div class="row">${shots.map((s) => `<div><div class="lab">${esc(s.page)}</div><div class="ph"><img src="${img(s.phone)}"></div></div>`).join('')}</div>
<h2>As Google might list the events (Palm's mock, ${esc(Z[0])} time)</h2><div class="gwrap">${googleMock}</div>
<h2>What attendees' calendars show (each "Add to calendar" entry, in four time zones)</h2><div class="row">${calendars.map((c) => calRow(`${c.file}: ${c.name}`, c.start)).join('')}${gcals.map((g) => calRow(`Google Calendar link: ${g.text || '(no title)'}`, g.start)).join('') || ''}${!calendars.length && !gcals.length ? '<i>No calendar file or Google Calendar link</i>' : ''}</div>
<h2>The link card when the page is shared</h2><div class="row">${cardHtml}</div>${notes}`;
    const sp = await browser.newPage(); await sp.setViewport({ width: 1448, height: 900, deviceScaleFactor: 1 });
    await sp.setContent(html, { waitUntil: 'load' }); await sp.screenshot({ path: sheet, fullPage: true });
    const errors = issues.filter((i) => i.level === 'error').length, warnings = issues.length - errors;
    return { ok: errors === 0 && events.length > 0, errors, warnings, events: events.map((e) => ({ ...e, startUtc: e.start != null ? new Date(e.start).toISOString() : null })), calendars: calendars.map((c) => ({ file: c.file, name: c.name, startUtc: c.start?.t != null ? new Date(c.start.t).toISOString() : null, floating: !!c.start?.floating })), googleLinks: gcals.map((g) => ({ page: g.page, text: g.text, startUtc: g.start?.t != null ? new Date(g.start.t).toISOString() : null, floating: !!g.start?.floating })), issues, sheet };
  } finally { await browser.close(); srv.close(); }
}

async function selfTest() {
  // pure parts first
  const t = zonedToUtc(2026, 12, 12, 10, 0, 0, 'Europe/Lisbon');
  if (new Date(t).toISOString() !== '2026-12-12T10:00:00.000Z') throw new Error('Lisbon in December is UTC+0: ' + new Date(t).toISOString());
  if (new Date(zonedToUtc(2026, 7, 1, 10, 0, 0, 'Europe/Lisbon')).toISOString() !== '2026-07-01T09:00:00.000Z') throw new Error('Lisbon summer is UTC+1');
  const iso = parseIso('2026-12-12T10:00:00+00:00'); if (!iso.offset || new Date(iso.t).toISOString() !== '2026-12-12T10:00:00.000Z') throw new Error('parseIso');
  const d = mkdtempSync(join(tmpdir(), 'event-check-test-'));
  const page = (ld, extra = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Workshop</title><meta property="og:title" content="Throwing workshop"><meta property="og:image" content="/photo.svg"><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body><h1>Throwing workshop</h1>${extra}</body></html>`;
  writeFileSync(join(d, 'photo.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><rect width="1200" height="630" fill="#c96"/></svg>');
  // bad: online event with a floating time, no zone on the page, a broken .ics (LF, no UID/DTSTAMP, floating), a gcal link without Z/ctz, a wrong time
  writeFileSync(join(d, 'index.html'), page({ '@context': 'https://schema.org', '@type': 'Event', name: 'Online throwing class', startDate: '2026-12-13T18:00', location: { '@type': 'VirtualLocation', url: 'https://example.com/live' }, eventAttendanceMode: 'OnlineEventAttendanceMode' },
    '<p>Sunday 13 December, 18:00</p><a href="https://calendar.google.com/calendar/render?action=TEMPLATE&text=Online+class&dates=20261213T180000/20261213T200000">Add to Google Calendar</a><a href="class.ics">Add to calendar</a>'));
  writeFileSync(join(d, 'class.ics'), 'BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//x//x//EN\nBEGIN:VEVENT\nSUMMARY:Online throwing class\nDTSTART:20261213T180000\nDTEND:20261213T200000\nDESCRIPTION:A very long description line that goes on and on well past the seventy five octet limit of the RFC\nEND:VEVENT\nEND:VCALENDAR\n');
  const r = await check(d, { out: join(d, 'look/bad'), zones: ['Europe/Lisbon', 'America/New_York', 'Asia/Tokyo'] });
  const got = new Set(r.issues.map((i) => i.id));
  for (const want of ['event-offset', 'event-online-only', 'page-timezone', 'ics-lf', 'ics-long-lines', 'ics-uid', 'ics-dtstamp', 'ics-floating', 'gcal-floating']) if (!got.has(want)) throw new Error(`bad page: expected ${want}, got ${[...got].join(', ')}`);
  if (!existsSync(r.sheet)) throw new Error('no sheet');
  // good: in-person event with offset, full Place, offers; a valid CRLF .ics with TZID + VTIMEZONE; a gcal link in UTC; page names the zone
  const g = mkdtempSync(join(tmpdir(), 'event-check-good-'));
  writeFileSync(join(g, 'photo.svg'), readFileSync(join(d, 'photo.svg')));
  writeFileSync(join(g, 'index.html'), page({ '@context': 'https://schema.org', '@type': 'Event', name: 'Wheel throwing for beginners', startDate: '2026-12-12T10:00:00+00:00', endDate: '2026-12-12T13:00:00+00:00', eventStatus: 'https://schema.org/EventScheduled', eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode', location: { '@type': 'Place', name: 'Barro Studio', address: { '@type': 'PostalAddress', streetAddress: 'Rua da Rosa 12', addressLocality: 'Lisbon', addressCountry: 'PT' } }, image: ['https://example.com/photo.jpg'], description: 'Three hours at the wheel.', offers: { '@type': 'Offer', price: 65, priceCurrency: 'EUR', availability: 'https://schema.org/InStock', url: 'https://example.com/book' }, organizer: { '@type': 'Organization', name: 'Barro Studio', url: 'https://example.com' } },
    '<p>Saturday 12 December, 10:00–13:00 Lisbon time (UTC)</p><a href="https://calendar.google.com/calendar/render?action=TEMPLATE&text=Wheel+throwing&dates=20261212T100000Z/20261212T130000Z">Add to Google Calendar</a><a href="wheel.ics">Add to calendar</a>'));
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Barro Studio//Workshops//EN', 'BEGIN:VTIMEZONE', 'TZID:Europe/Lisbon', 'BEGIN:STANDARD', 'DTSTART:19701025T020000', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0000', 'END:STANDARD', 'END:VTIMEZONE', 'BEGIN:VEVENT', 'UID:wheel-20261212@barro.example', 'DTSTAMP:20261125T090000Z', 'DTSTART;TZID=Europe/Lisbon:20261212T100000', 'DTEND;TZID=Europe/Lisbon:20261212T130000', 'SUMMARY:Wheel throwing for beginners', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n') + '\r\n';
  writeFileSync(join(g, 'wheel.ics'), ics);
  const ok = await check(g, { out: join(g, 'look/good'), zones: ['Europe/Lisbon', 'America/New_York', 'Asia/Tokyo'] });
  if (ok.errors) throw new Error('good page flagged: ' + ok.issues.filter((i) => i.level === 'error').map((i) => i.msg).join(' | '));
  console.log(`event-check: all tests pass (bad: ${[...got].join(', ')}; good: ${ok.warnings} warnings ${ok.issues.map((i) => i.id).join(', ')})`);
}

if (typeof process !== 'undefined' && process.argv?.[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
  const VALUED = new Set(['--out', '--pages', '--zones']);
  const pos = argv.filter((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1]));
  const done = (r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); };
  const fail = (e) => { console.error(String(e.message || e)); process.exit(2); };
  if (argv.includes('--test')) selfTest().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
  else if (pos[0] === 'check' && pos[1]) check(pos[1], { pages: opt('pages') ? opt('pages').split(',') : null, zones: opt('zones') ? opt('zones').split(',') : null, out: opt('out', 'look/event') }).then(done, fail);
  else fail('usage: event-check.mjs check <site folder> [--pages index.html] [--zones Europe/Lisbon,America/New_York,Asia/Tokyo] [--out look/event]\n       event-check.mjs --test');
}
