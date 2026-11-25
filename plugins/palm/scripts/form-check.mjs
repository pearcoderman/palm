#!/usr/bin/env node
// Palm tool: form-check — lets an agent see and use its web forms the way people on phones will: every form on a 390 px
// phone and a 1280 px desktop, filled in, then sent empty and with a wrong email, and tabbed through. Forms break in
// ways you can't see in the HTML: a field whose only label is its placeholder (it vanishes as you type), a label that
// isn't tied to its field, no autocomplete so autofill can't help, the wrong keyboard on a phone (text instead of email
// or number pad), text under 16 px that makes iPhone Safari zoom in when the field is tapped, a 16 px checkbox, errors
// that appear nowhere or aren't tied to their field, a submit button disabled with no reason, paste blocked.
// adds: tool. Runs on the user's machine with their Chrome/Edge/Chromium; nothing leaves it (form submissions are
// stopped before they leave the page).
//
//   node form-check.mjs check <site folder> [--pages index.html,book.html] [--out look/forms]
//       → JSON {ok, errors, warnings, forms, issues, sheet}. Then LOOK at the sheet.
//   node form-check.mjs --test
//
// Sources: WCAG 2.2 (https://www.w3.org/TR/WCAG22/): 1.3.1 Info and Relationships, 1.3.5 Identify Input Purpose
// (fields about the user carry the right autocomplete token), 2.4.3 Focus Order, 2.5.8 Target Size (Minimum) 24×24
// CSS px, 3.3.1 Error Identification, 3.3.2 Labels or Instructions, 4.1.2 Name, Role, Value, 4.1.3 Status Messages.
// Autofill tokens: WHATWG HTML, "Autofill" (https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#autofill).
// Palm's guidance, not a standard (warnings): which field means what (read from its name and label); a field under
// 16 px makes iPhone Safari zoom in on focus (Palm's observation of Safari); the type and keyboard for email and
// phone fields; a date typed as free text; required fields not marked; a submit disabled with no reason.

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
    if (q.method !== 'GET' && q.method !== 'HEAD') { r.writeHead(200, { 'content-type': 'text/html' }); return r.end('<!doctype html><title>Sent</title><p>Sent (stopped by form-check).'); }
    let p = decodeURIComponent(q.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html';
    const f = join(root, p);
    if (!f.startsWith(root) || !existsSync(f) || statSync(f).isDirectory()) { r.writeHead(404); return r.end(); }
    r.writeHead(200, { 'content-type': TYPES[extname(f).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' }); r.end(readFileSync(f));
  });
  return new Promise((ok) => s.listen(0, '127.0.0.1', () => ok(s)));
}

// WHATWG HTML autofill field names (the last token of autocomplete=""), plus on/off.
export const AUTOFILL = new Set(['name', 'honorific-prefix', 'given-name', 'additional-name', 'family-name', 'honorific-suffix', 'nickname', 'username', 'new-password', 'current-password', 'one-time-code', 'organization-title', 'organization', 'street-address', 'address-line1', 'address-line2', 'address-line3', 'address-level4', 'address-level3', 'address-level2', 'address-level1', 'country', 'country-name', 'postal-code', 'cc-name', 'cc-given-name', 'cc-additional-name', 'cc-family-name', 'cc-number', 'cc-exp', 'cc-exp-month', 'cc-exp-year', 'cc-csc', 'cc-type', 'transaction-currency', 'transaction-amount', 'language', 'bday', 'bday-day', 'bday-month', 'bday-year', 'sex', 'url', 'photo', 'tel', 'tel-country-code', 'tel-national', 'tel-area-code', 'tel-local', 'tel-local-prefix', 'tel-local-suffix', 'tel-extension', 'email', 'impp', 'webauthn', 'on', 'off']);

// What a field is for, read from its name, id, autocomplete and label (Palm's guess). Only fields about the person
// filling in the form are "user" fields (WCAG 1.3.5); a pet's or a company's name isn't.
export function purpose(f) {
  const t = `${f.name} ${f.id} ${f.label}`.toLowerCase().replace(/[_-]/g, ' ');
  const other = /\b(dog|pet|cat|puppy|child|kid|baby|company|business|team|event|project|message|note|subject|code|coupon|promo)\b/.test(t) && !/your\b/.test(t.replace(/your (dog|pet|cat|company|business|child)/g, ''));
  if (f.type === 'password') return { p: 'password', tokens: ['current-password', 'new-password'] };
  if (/e ?mail/.test(t)) return { p: 'email', tokens: ['email'], type: 'email' };
  if (/\b(phone|tel|telephone|mobile|cell)\b/.test(t)) return { p: 'tel', tokens: ['tel', 'tel-national'], type: 'tel' };
  if (/\b(post ?code|zip|postal)\b/.test(t)) return { p: 'postal-code', tokens: ['postal-code'] };
  if (/\b(first name|given name|forename)\b/.test(t) && !other) return { p: 'given-name', tokens: ['given-name'] };
  if (/\b(last name|surname|family name)\b/.test(t) && !other) return { p: 'family-name', tokens: ['family-name'] };
  if (/\b(name|full name|your name)\b/.test(t) && !other) return { p: 'name', tokens: ['name'] };
  if (other && /\bname\b/.test(t)) return { p: 'other-name', tokens: [], notUser: true };
  if (/\b(street|address)\b/.test(t)) return { p: 'address', tokens: ['street-address', 'address-line1', 'address-line2'] };
  if (/\b(town|city)\b/.test(t)) return { p: 'city', tokens: ['address-level2'] };
  if (/\b(date|day|when)\b/.test(t) || f.type === 'date') return { p: 'date', tokens: [] };
  return { p: '', tokens: [] };
}
const SAMPLE = { email: 'sam.jones@example.com', tel: '07700 900123', name: 'Sam Jones', 'given-name': 'Sam', 'family-name': 'Jones', 'postal-code': 'BS1 4DJ', address: '12 Quay Street', city: 'Bristol', 'other-name': 'Biscuit' };

// Runs in the page: every form-like group and its fields, with what Chrome computed.
const FIELDS = () => {
  const vis = (el) => { for (let e = el; e && e !== document.documentElement; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden') return false; } const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const shown = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return vis(el) && r.width > 2 && r.height > 2 && !(cs.position === 'absolute' && (cs.clip === 'rect(0px, 0px, 0px, 0px)' || cs.clipPath === 'inset(50%)')) && +cs.opacity > 0.05; };
  const txt = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
  const box = (r) => ({ x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height });
  let k = 0; for (const el of document.querySelectorAll('input,select,textarea')) el.setAttribute('data-fc-f', k++);
  const sel = (el) => `[data-fc-f="${el.getAttribute('data-fc-f')}"]`;
  const groups = [...document.querySelectorAll('form')];
  const loose = [...document.querySelectorAll('input,select,textarea')].filter((el) => !el.form);
  const out = [];
  const fieldsOf = (root, list) => list.filter((el) => /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) && !['hidden', 'submit', 'button', 'image', 'reset'].includes(el.type) && vis(el)).map((el) => {
    const labs = [...(el.labels || [])];
    const lby = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)).filter(Boolean);
    const named = labs.length || lby.length || (el.getAttribute('aria-label') || '').trim() || (el.getAttribute('title') || '').trim();
    const labelText = [...labs.map(txt), ...lby.map(txt), el.getAttribute('aria-label') || ''].filter(Boolean).join(' ').trim();
    const visibleLabel = labs.some(shown) || lby.some(shown);
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    const tgt = ['checkbox', 'radio'].includes(el.type) ? labs.filter(shown).map((l) => l.getBoundingClientRect()).concat([r]).reduce((a, b) => ({ w: Math.max(a.w, b.width), h: Math.max(a.h, b.height) }), { w: r.width, h: r.height }) : { w: r.width, h: r.height };
    return { sel: sel(el), tag: el.tagName.toLowerCase(), type: el.type, name: el.name || '', id: el.id || '', label: labelText || '', named: !!named, visibleLabel, placeholder: el.getAttribute('placeholder') || '',
      autocomplete: (el.getAttribute('autocomplete') || '').trim(), inputmode: el.getAttribute('inputmode') || '', required: el.required || el.getAttribute('aria-required') === 'true',
      labelMarksRequired: /\*|required|\(must\)/i.test(labelText) || /required/i.test(txt(el.closest('fieldset')?.querySelector('legend'))), fontPx: parseFloat(cs.fontSize),
      box: box(r), target: { w: Math.round(tgt.w), h: Math.round(tgt.h) }, tabIndex: el.tabIndex, disabled: el.disabled };
  });
  for (const f of groups) {
    const submits = [...f.querySelectorAll('button:not([type=button]):not([type=reset]), input[type=submit], input[type=image]')].filter(vis);
    f.setAttribute('data-fc-form', groups.indexOf(f));
    out.push({ kind: 'form', sel: `form[data-fc-form="${groups.indexOf(f)}"]`, name: f.id ? '#' + f.id : f.getAttribute('name') || f.className.split(/\s+/)[0] || `form ${groups.indexOf(f) + 1}`, novalidate: f.noValidate, box: box(f.getBoundingClientRect()),
      fields: fieldsOf(f, [...f.elements]), submit: submits.map((b) => ({ text: txt(b) || b.value || b.getAttribute('aria-label') || '', disabled: b.disabled, box: box(b.getBoundingClientRect()), h: b.getBoundingClientRect().height, w: b.getBoundingClientRect().width })) });
  }
  if (loose.length) out.push({ kind: 'loose', sel: 'fields outside any <form>', novalidate: true, box: null, fields: fieldsOf(document.body, loose), submit: [] });
  return out;
};

// Runs in the page after a submit attempt: which fields show an error, and how.
const ERRSTATE = (sels) => sels.map((s) => {
  const el = document.querySelector(s); if (!el) return { sel: s, gone: true };
  const ids = (el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
  const desc = ids.map((id) => document.getElementById(id)).filter(Boolean).map((d) => (d.innerText || '').trim()).filter(Boolean).join(' ');
  const errmsg = (el.getAttribute('aria-errormessage') && document.getElementById(el.getAttribute('aria-errormessage'))?.innerText) || '';
  return { sel: s, nativeInvalid: !el.checkValidity(), ariaInvalid: el.getAttribute('aria-invalid') === 'true', described: desc || errmsg, validationMessage: el.validationMessage };
});

export async function check(target, { pages = null, out = 'look/forms', plain = false } = {}) {
  const root = resolve(target);
  const list = pages || readdirSync(root).filter((f) => /\.html?$/i.test(f)).sort((a, b) => (a === 'index.html' ? -1 : b === 'index.html' ? 1 : a.localeCompare(b)));
  mkdirSync(dirname(resolve(out)), { recursive: true });
  const server = await serve(root), base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await launch();
  const issues = [], forms = [], shots = [];
  const add = (level, id, page, form, msg, extra = {}) => issues.push({ level, id, page, form, msg, ...extra });
  try {
    for (const page of list) {
      const pg = await browser.newPage();
      await pg.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      await pg.goto(base + page, { waitUntil: 'networkidle0' });
      let groups = await pg.evaluate(FIELDS);
      if (!groups.length) { await pg.close(); continue; }
      for (let gi = 0; gi < groups.length; gi++) {
        const g = groups[gi]; const fname = g.kind === 'form' ? g.name : 'loose fields';
        const info = { page, form: fname, fields: g.fields.length, submit: g.submit.map((s) => s.text) };
        forms.push(info);
        if (g.kind === 'loose' && g.fields.length) add('warn', 'no-form', page, fname, `${g.fields.length} field(s) sit outside any <form>: Enter won't send them and the browser can't check them.`);
        for (const f of g.fields) {
          const nm = f.label || f.placeholder || f.name || f.sel;
          const pu = purpose(f);
          if (!f.named) add('error', f.placeholder ? 'placeholder-label' : 'no-label', page, fname, f.placeholder ? `"${f.placeholder}" is only a placeholder: it has no label, so it vanishes as soon as someone types and screen readers may not read it (WCAG 3.3.2, 1.3.1).` : `${f.sel} has no label at all (WCAG 1.3.1, 4.1.2).`, { field: f.sel, box: f.box });
          else if (!f.visibleLabel && f.placeholder && !['checkbox', 'radio'].includes(f.type)) add('warn', 'placeholder-label', page, fname, `"${nm}" has a hidden label and shows only a placeholder, which vanishes as someone types (WCAG 3.3.2).`, { field: f.sel, box: f.box });
          const toks = f.autocomplete.toLowerCase().split(/\s+/).filter(Boolean);
          const last = toks[toks.length - 1] || '';
          if (f.autocomplete && !AUTOFILL.has(last)) add('error', 'autocomplete-invalid', page, fname, `"${nm}": autocomplete="${f.autocomplete}" isn't an autofill name in the HTML spec, so browsers ignore it.`, { field: f.sel, box: f.box });
          else if (pu.tokens.length && !pu.notUser && pu.p !== 'password') {
            if (!last || last === 'on') add('error', 'autocomplete-missing', page, fname, `"${nm}" asks for the person's ${pu.p}, but has no autocomplete="${pu.tokens[0]}": autofill can't fill it (WCAG 1.3.5 Identify Input Purpose).`, { field: f.sel, box: f.box });
            else if (last === 'off') add('warn', 'autocomplete-off', page, fname, `"${nm}" turns autofill off (autocomplete="off"); people on phones will type their ${pu.p} by hand.`, { field: f.sel, box: f.box });
            else if (!pu.tokens.includes(last)) add('warn', 'autocomplete-mismatch', page, fname, `"${nm}" looks like ${pu.p} but has autocomplete="${last}" (expected ${pu.tokens.join(' or ')}; Palm read the purpose from the label).`, { field: f.sel, box: f.box });
          }
          if (pu.notUser && ['name', 'given-name', 'family-name'].includes(last)) add('warn', 'autocomplete-wrong-person', page, fname, `"${nm}" isn't the person's own name, but autocomplete="${last}" will fill it with theirs.`, { field: f.sel, box: f.box });
          if (pu.type && f.type !== pu.type && !(pu.type === 'tel' && f.inputmode === 'tel') && !(pu.type === 'email' && f.inputmode === 'email')) add('warn', 'keyboard', page, fname, `"${nm}" is type="${f.type}": phones show the plain keyboard instead of the ${pu.type === 'email' ? 'email (@ and .) keyboard' : 'phone number pad'}. Use type="${pu.type}".`, { field: f.sel, box: f.box });
          if (pu.p === 'date' && f.type === 'text' && !f.inputmode) add('warn', 'date-text', page, fname, `"${nm}" takes a date as free text: no date picker on phones and every format to parse. Use type="date" (or a clear format hint).`, { field: f.sel, box: f.box });
          if (f.fontPx < 16 && !['checkbox', 'radio', 'range', 'color', 'file'].includes(f.type)) add('warn', 'zoom-on-focus', page, fname, `"${nm}" uses ${f.fontPx}px text: iPhone Safari zooms the page in when a field under 16 px is tapped (Palm's observation of Safari).`, { field: f.sel, box: f.box });
          const min = 24;
          if ((f.target.w < min || f.target.h < min) && f.type !== 'hidden') add(['checkbox', 'radio'].includes(f.type) ? 'error' : 'warn', 'target-small', page, fname, `"${nm}" can be tapped only on ${f.target.w}×${f.target.h} CSS px (WCAG 2.2 2.5.8 asks for at least 24×24, counting its label when the label is tied to it).`, { field: f.sel, box: f.box });
          // marking the optional fields instead ("Notes (optional)") tells people the rest are required, so that counts too
          if (f.required && !f.labelMarksRequired && g.fields.some((x) => !x.required) && !g.fields.some((x) => !x.required && /optional/i.test(x.label))) add('warn', 'required-unmarked', page, fname, `"${nm}" is required, but its label doesn't say so (WCAG 3.3.2).`, { field: f.sel, box: f.box });
          if (f.tabIndex < 0 && !f.disabled) add('error', 'not-focusable', page, fname, `"${nm}" has tabindex="-1": keyboard users can't reach it (WCAG 2.1.1).`, { field: f.sel, box: f.box });
        }
        for (const s of g.submit) {
          if (s.disabled) add('warn', 'submit-disabled', page, fname, `The "${s.text}" button is disabled before anything is filled in, with no reason shown: people can't find out what's missing. Leave it enabled and show errors on submit.`);
          if (s.h < 24 || s.w < 24) add('error', 'target-small', page, fname, `The "${s.text}" button is ${Math.round(s.w)}×${Math.round(s.h)} CSS px (WCAG 2.2 2.5.8: at least 24×24).`, { box: s.box });
        }
        // paste: a cancelled paste event means paste is blocked
        const pasteBlocked = await pg.evaluate((sels) => sels.filter((s) => { const el = document.querySelector(s); if (!el) return false; const dt = new DataTransfer(); dt.setData('text/plain', 'x'); const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }); el.dispatchEvent(ev); return ev.defaultPrevented; }), g.fields.filter((f) => !['checkbox', 'radio', 'select-one', 'file'].includes(f.type)).map((f) => f.sel));
        const nameOf = (sl) => { const f = g.fields.find((x) => x.sel === sl); return f ? `"${f.label || f.placeholder || f.name}"` : sl; };
        for (const s of pasteBlocked) add('error', 'paste-blocked', page, fname, `Paste is blocked in ${nameOf(s)}: password managers and people copying their details can't fill it.`);
      }
      // focus order: tab from the top of the page; fields must come in reading order
      const order = [];
      await pg.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
      for (let i = 0; i < 80; i++) { await pg.keyboard.press('Tab'); const a = await pg.evaluate(() => { const e = document.activeElement; if (!e || e === document.body) return null; const r = e.getBoundingClientRect(); return { sel: e.id ? '#' + e.id : e.name ? `${e.tagName.toLowerCase()}[name="${e.name}"]` : e.tagName.toLowerCase(), y: r.top + scrollY, field: /^(INPUT|SELECT|TEXTAREA)$/.test(e.tagName) }; }); if (!a) break; if (order.length && order[0].sel === a.sel) break; order.push(a); }
      const fo = order.filter((o) => o.field);
      for (let i = 1; i < fo.length; i++) if (fo[i].y < fo[i - 1].y - 60) { add('warn', 'focus-order', page, 'page', `Tab goes from ${fo[i - 1].sel} back up to ${fo[i].sel}: the focus order doesn't follow the layout (WCAG 2.4.3).`); break; }

      // filled view (phone), then empty submit, then a wrong email
      const shoot = async (label) => shots.push({ page, label, b64: await pg.screenshot({ fullPage: true, encoding: 'base64', captureBeyondViewport: true }) });
      const fill = async () => { groups = await pg.evaluate(FIELDS); for (const g of groups) for (const f of g.fields) { const pu = purpose(f); try {
        if (f.type === 'checkbox') { await pg.$eval(f.sel, (e) => { if (!e.checked) e.click(); }); continue; }
        if (f.type === 'radio') continue;
        if (f.tag === 'select') { await pg.$eval(f.sel, (e) => { const o = [...e.options].find((x) => x.value && !x.disabled); if (o) { e.value = o.value; e.dispatchEvent(new Event('change', { bubbles: true })); } }); continue; }
        if (f.type === 'date') { await pg.$eval(f.sel, (e) => { e.value = '2026-12-12'; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }); continue; }
        const v = SAMPLE[pu.p] || (f.tag === 'textarea' ? 'Nervous with clippers; please be gentle.' : 'Medium');
        await pg.$eval(f.sel, (e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }, v);
      } catch { /* skip */ } } };
      await fill(); await shoot('Phone: filled in');
      await pg.reload({ waitUntil: 'networkidle0' });
      groups = await pg.evaluate(FIELDS);
      const tryErrors = async (mode) => {
        for (const g of groups.filter((x) => x.kind === 'form' && x.submit.length && x.fields.some((f) => f.required || /email/i.test(f.type + f.label)))) {
          const fname = g.name;
          if (mode === 'bad-email') { const em = g.fields.find((f) => purpose(f).p === 'email'); if (!em) continue; await fill(); await pg.$eval(em.sel, (e) => { e.value = 'sam.jones@'; e.dispatchEvent(new Event('input', { bubbles: true })); }); }
          const startUrl = pg.url();
          await pg.evaluate((s) => { const f = document.querySelector(s); const b = f && [...f.querySelectorAll('button:not([type=button]):not([type=reset]), input[type=submit]')][0]; if (b && !b.disabled) b.click(); else f?.requestSubmit?.(); }, g.sel).catch(() => {});
          await new Promise((r) => setTimeout(r, 700));
          const navigated = pg.url() !== startUrl || !(await pg.$(g.sel).catch(() => null));
          if (navigated) {
            add('error', mode === 'empty' ? 'sent-empty' : 'sent-bad-email', page, fname, mode === 'empty' ? 'The form sent with every field empty: nothing stopped it or said what was missing (WCAG 3.3.1).' : 'The form sent with "sam.jones@" as the email: nothing caught it (WCAG 3.3.1).');
            await pg.goto(base + page, { waitUntil: 'networkidle0' }); groups = await pg.evaluate(FIELDS); continue;
          }
          const want = mode === 'empty' ? g.fields.filter((f) => f.required).map((f) => f.sel) : g.fields.filter((f) => purpose(f).p === 'email').map((f) => f.sel);
          const st = await pg.evaluate(ERRSTATE, want);
          const live = await pg.evaluate(() => [...document.querySelectorAll('[role=alert],[aria-live=assertive],[aria-live=polite],[role=status]')].map((e) => (e.innerText || '').trim()).filter(Boolean).join(' | '));
          const focusOnField = await pg.evaluate((w) => w.some((s) => document.activeElement === document.querySelector(s)), want);
          const silent = st.filter((s) => !s.gone && !s.described && !(s.nativeInvalid && g.novalidate === false));
          if (silent.length && !live) add('error', 'error-not-shown', page, fname, `After ${mode === 'empty' ? 'sending it empty' : 'a wrong email'}, ${silent.map((s) => { const f = g.fields.find((x) => x.sel === s.sel); return f ? `"${f.label || f.placeholder || f.name}"` : s.sel; }).join(', ')} show no error tied to the field (no aria-describedby message, no announced alert) (WCAG 3.3.1, 4.1.3).`);
          else if (g.novalidate && st.some((s) => !s.gone && !s.ariaInvalid && !s.nativeInvalid)) add('warn', 'error-not-tied', page, fname, `Errors appear, but the invalid fields aren't marked aria-invalid="true" (screen readers won't say which field is wrong).`);
          if (!focusOnField && g.novalidate && !live) add('warn', 'error-focus', page, fname, `After the error, focus doesn't move to the first wrong field and nothing is announced: keyboard and screen reader users don't learn what happened.`);
          if (mode === 'empty') await shoot(`Phone: sent empty (${fname})`);
          if (mode === 'bad-email') await shoot(`Phone: wrong email (${fname})`);
          await pg.goto(base + page, { waitUntil: 'networkidle0' }); groups = await pg.evaluate(FIELDS);
        }
      };
      await tryErrors('empty'); await tryErrors('bad-email');
      // desktop view
      await pg.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 }); await pg.goto(base + page, { waitUntil: 'networkidle0' });
      shots.push({ page, label: 'Desktop 1280 px', b64: await pg.screenshot({ fullPage: true, encoding: 'base64', captureBeyondViewport: true }), desktop: true });
      await pg.close();
    }
    // the sheet: per page, phone filled, phone after errors, desktop; problems listed (plain: no list)
    const sheet = resolve(out + '-sheet.png');
    const byPage = list.filter((p) => shots.some((s) => s.page === p));
    const notes = (p) => plain ? '' : `<ul class="n">${issues.filter((i) => i.page === p).slice(0, 18).map((i) => `<li class="${i.level}">${i.msg.replace(/</g, '&lt;')}</li>`).join('')}</ul>`;
    const rows = byPage.map((p) => `<h2>${p}</h2><div class="row">${shots.filter((s) => s.page === p).map((s) => `<div class="v"><div class="lab">${s.label}</div><div class="frame" style="width:${s.desktop ? 560 : 300}px;max-height:${s.desktop ? 1100 : 2000}px"><img src="data:image/png;base64,${s.b64}" style="width:${s.desktop ? 560 : 300}px;display:block"></div></div>`).join('')}</div>${notes(p)}`).join('');
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:24px;background:#d9d8d4;font:14px/1.4 -apple-system,Helvetica,Arial,sans-serif;color:#222;width:1900px}h2{font:600 13px/1 -apple-system,Helvetica;letter-spacing:.08em;text-transform:uppercase;color:#444;margin:26px 0 10px}.row{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap}.lab{font-size:11px;color:#555;margin-bottom:4px}.frame{overflow:hidden;border:1px solid #999;background:#fff}.n{font-size:12px;max-width:1800px}.n .error{color:#b00020}.n .warn{color:#7a5200}</style></head><body>${rows || '<p>No forms found.</p>'}</body></html>`;
    const sp = await browser.newPage(); await sp.setViewport({ width: 1950, height: 1000, deviceScaleFactor: 1 });
    await sp.setContent(html, { waitUntil: 'load' }); await new Promise((r) => setTimeout(r, 300));
    await sp.screenshot({ path: sheet, fullPage: true });
    const errors = issues.filter((i) => i.level === 'error').length, warnings = issues.filter((i) => i.level === 'warn').length;
    return { ok: errors === 0 && forms.length > 0, errors, warnings, forms, issues: issues.map(({ box, ...i }) => i), sheet };
  } finally { await browser.close(); server.close(); }
}

// ---------- self-test ----------
async function selfTest() {
  const d = mkdtempSync(join(tmpdir(), 'form-test-'));
  const page = (body, css = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Book</title><style>body{font:16px Helvetica;margin:16px}${css}</style></head><body>${body}</body></html>`;
  // bad: placeholder-only labels, no autocomplete, text type for email and phone, 13px fields, a 14px checkbox with no
  // label, a date as free text, novalidate with no error messages, paste blocked on email, submit disabled
  writeFileSync(join(d, 'index.html'), page(`<form id="book" novalidate action="/send" method="post">
<input name="name" placeholder="Your name" required><input name="email" type="text" placeholder="Email" required onpaste="return false">
<input name="phone" placeholder="Phone"><input name="dog" placeholder="Dog's name"><input name="date" placeholder="Preferred date (dd/mm)">
<input type="checkbox" name="consent" required style="width:14px;height:14px"><button type="submit">Book</button></form>`, 'input{font-size:13px;display:block;margin:6px 0}'));
  const r = await check(d, { out: join(d, 'look/bad') });
  const got = new Set(r.issues.map((i) => i.id));
  for (const want of ['placeholder-label', 'autocomplete-missing', 'keyboard', 'zoom-on-focus', 'target-small', 'date-text', 'paste-blocked', 'sent-empty']) if (!got.has(want)) throw new Error(`bad form: expected ${want}, got ${[...got].join(', ')}`);
  if (!existsSync(r.sheet)) throw new Error('no sheet');
  // good: visible labels tied to fields, autocomplete tokens, the right types, 16px, a 24px+ checkbox with its label,
  // a date input, the browser's own validation, required marked
  writeFileSync(join(d, 'index.html'), page(`<form id="book" action="/send" method="post">
<label for="n">Your name (required)</label><input id="n" name="name" autocomplete="name" required>
<label for="e">Email (required)</label><input id="e" name="email" type="email" autocomplete="email" required>
<label for="p">Phone</label><input id="p" name="phone" type="tel" autocomplete="tel">
<label for="dg">Dog's name</label><input id="dg" name="dog" autocomplete="off">
<label for="dt">Preferred date</label><input id="dt" name="date" type="date">
<label class="c"><input type="checkbox" name="consent" required> I agree to the booking terms (required)</label><button type="submit">Book</button></form>`, 'input{font-size:16px;display:block;margin:4px 0 12px;padding:10px}label{display:block}.c{padding:8px 0}button{padding:12px 20px;font-size:16px}'));
  const g = await check(d, { out: join(d, 'look/good') });
  if (g.errors) throw new Error('good form flagged: ' + g.issues.filter((i) => i.level === 'error').map((i) => `${i.id} ${i.msg}`).join(' | '));
  console.log(`form-check: all tests pass (bad: ${[...got].join(', ')}; good: ${g.warnings} warnings ${g.issues.map((i) => i.id).join(', ')})`);
}

if (typeof process !== 'undefined' && process.argv?.[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
  const VALUED = new Set(['--out', '--pages']);
  const pos = argv.filter((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1]));
  const done = (r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); };
  const fail = (e) => { console.error(String(e.message || e)); process.exit(2); };
  if (argv.includes('--test')) selfTest().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
  else if (pos[0] === 'check' && pos[1]) check(pos[1], { pages: opt('pages') ? opt('pages').split(',') : null, out: opt('out', 'look/forms') }).then(done, fail);
  else fail('usage: form-check.mjs check <site folder> [--pages index.html,book.html] [--out look/forms]\n       form-check.mjs --test');
}
