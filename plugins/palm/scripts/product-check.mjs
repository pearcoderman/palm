#!/usr/bin/env node
// Palm tool: product-check — lets an agent see a shop's product page the way shoppers and Google will: the first
// screen on a phone (is Add to cart there?), the variant picker used with a keyboard and read by a screen reader, the
// product as Google might show it in a merchant listing (Palm's mock), and the link card. Product pages break in ways
// you can't see in the HTML: Product data Google can't use for merchant listings (no Offer, a price of 0, a price or
// availability that disagrees with the page, shipping or returns marked up without the fields Google requires),
// variants as one Product instead of a ProductGroup, colour swatches with no name, product photos with no alt text or
// too small, Add to cart below the first screen, and a shared link with no picture.
// adds: tool, fresh-data. Runs on the user's machine with their Chrome/Edge/Chromium; nothing leaves it.
//
//   node product-check.mjs check <site folder> [--pages product.html] [--out look/product]
//       → JSON {ok, errors, warnings, products, issues, sheet}. Then LOOK at the sheet.
//   node product-check.mjs --test
//
// Sources (read 2026-11-25):
// - Google Search Central, "Merchant listing (Product, Offer) structured data" (developers.google.com/search/docs/
//   appearance/structured-data/merchant-listing, last updated 2026-09-08): Product requires name, image and offers (an
//   Offer, not AggregateOffer: "merchant listings require an Offer"); Offer requires price ("merchant listing
//   experiences require a price greater than zero") and priceCurrency (ISO 4217); recommended availability,
//   itemCondition, priceValidUntil ("may not display if … a past date"), url, shippingDetails, hasMerchantReturnPolicy;
//   Product recommends brand.name, description, gtin/mpn/sku, color, size; images: "minimum of 50K pixels when
//   multiplying width and height", 16x9, 4x3 and 1x1 recommended. OfferShippingDetails requires shippingDestination
//   (addressCountry), shippingRate (value or maxValue, currency) and deliveryTime (handlingTime, transitTime).
//   MerchantReturnPolicy requires applicableCountry and returnPolicyCategory. "Product structured data in the initial
//   HTML for best results."
// - Google, "Product variant structured data" (…/product-variants, last updated 2026-09-08): ProductGroup requires
//   name; variants via hasVariant (or isVariantOf); productGroupID (or inProductGroupWithID); variesBy
//   (https://schema.org/color, size, …); each variant's name more specific than the group's.
// - Google, "General structured data guidelines" (…/sd-policies, last updated 2026-07-10): "Don't mark up content that
//   is not visible to readers of the page."
// - WCAG 2.2: 1.1.1 (images need text alternatives), 4.1.2 (controls need an accessible name), 2.1.1 (keyboard).
// Palm's guidance, not a standard: Add to cart within the first 844 px of a 390 px phone screen; the merchant result
// and link card drawings are Palm's mocks, not Google's or any app's layout.

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
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon', '.json': 'application/json' };
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
const short = (v) => String(v ?? '').replace(/^https?:\/\/schema\.org\//, '');
const types = (x) => [].concat(x?.['@type'] || []).map(String);
const is = (x, t) => types(x).some((y) => y === t || y.endsWith('/' + t));

// Product / ProductGroup / Organization nodes anywhere in a JSON-LD blob.
function nodes(x, out = { products: [], groups: [], orgs: [], byId: {} }) {
  if (Array.isArray(x)) { x.forEach((y) => nodes(y, out)); return out; }
  if (!x || typeof x !== 'object') return out;
  if (x['@id']) out.byId[x['@id']] = x;
  if (is(x, 'ProductGroup')) { out.groups.push(x); [].concat(x.hasVariant || []).forEach((v) => nodes(v, out)); }
  else if (is(x, 'Product')) out.products.push(x);
  if (is(x, 'Organization') || is(x, 'OnlineStore') || is(x, 'Store')) out.orgs.push(x);
  for (const k of ['@graph', 'mainEntity', 'itemListElement', 'item']) if (x[k]) nodes(x[k], out);
  return out;
}
// A bare {"@id": …} points at a node defined elsewhere on the page (e.g. one shop-wide shipping policy in @graph).
const isRef = (x) => x && typeof x === 'object' && x['@id'] && Object.keys(x).filter((k) => !k.startsWith('@')).length === 0;
const deref = (x, byId) => [].concat(x || []).map((y) => isRef(y) && byId[y['@id']] ? byId[y['@id']] : y);
const num = (v) => { const n = Number(String(v ?? '').replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) && String(v ?? '').trim() !== '' ? n : null; };
const SYMBOL = { GBP: '£', USD: '$', EUR: '€', JPY: '¥', AUD: '$', CAD: '$', NZD: '$' };

// Shipping and returns checks (Offer-level or Organization-level policy objects).
function checkShipping(sd, where, add) {
  for (const s of [].concat(sd || [])) {
    if (!s || typeof s !== 'object') continue;
    if (isRef(s)) { add('warn', 'shipping-ref', where, `${where}: shippingDetails points to ${s['@id']}, which isn't defined on this page; make sure Google can read it there (or use hasShippingService).`); continue; }
    if (s.hasShippingService && Object.keys(s).filter((k) => !k.startsWith('@')).length === 1) continue; // reference to a global policy
    const miss = [];
    if (!s.shippingDestination || ![].concat(s.shippingDestination).some((d) => d?.addressCountry)) miss.push('shippingDestination.addressCountry');
    const rates = [].concat(s.shippingRate || []);
    if (!rates.length || !rates.some((r) => r && (r.value != null || r.maxValue != null))) miss.push('shippingRate.value');
    if (rates.length && !rates.some((r) => r?.currency)) miss.push('shippingRate.currency');
    if (!s.deliveryTime) miss.push('deliveryTime (handlingTime + transitTime)');
    else { const dt = s.deliveryTime; if (!dt.handlingTime || !dt.transitTime) miss.push('deliveryTime.handlingTime/transitTime'); }
    if (miss.length) add('error', 'shipping-fields', where, `${where}: shippingDetails is missing ${miss.join(', ')} (Google requires these in OfferShippingDetails, so the delivery cost won't show).`);
  }
}
function checkReturns(rp, where, add) {
  for (const r of [].concat(rp || [])) {
    if (!r || typeof r !== 'object') continue;
    if (r['@id'] && Object.keys(r).filter((k) => !k.startsWith('@')).length === 0) continue; // reference
    const miss = [];
    if (!r.applicableCountry) miss.push('applicableCountry');
    if (!r.returnPolicyCategory) miss.push('returnPolicyCategory');
    if (miss.length) add('error', 'returns-fields', where, `${where}: hasMerchantReturnPolicy is missing ${miss.join(', ')} (Google: required in MerchantReturnPolicy).`);
    if (short(r.returnPolicyCategory) === 'MerchantReturnFiniteReturnWindow' && r.merchantReturnDays == null) add('warn', 'returns-days', where, `${where}: a finite return window but no merchantReturnDays (Google: recommended), so the number of days won't show.`);
  }
}

export async function check(target, { pages = null, out = 'look/product', plain = false } = {}) {
  const root = resolve(target);
  const walk = (d, depth = 0) => readdirSync(d).flatMap((f) => { const p = join(d, f); if (/^(palm|look|node_modules|\.)/.test(f)) return []; const s = statSync(p); return s.isDirectory() ? (depth < 2 ? walk(p, depth + 1) : []) : [p]; });
  const files = walk(root);
  const htmls = (pages ? pages.map((p) => join(root, p)) : files.filter((f) => /\.html?$/i.test(f))).filter(existsSync);
  const issues = []; const add = (level, id, where, msg) => issues.push({ level, id, where, msg });
  const srv = await serve(root); const base = `http://127.0.0.1:${srv.address().port}`;
  const browser = await launch();
  const products = []; const shots = []; const cards = []; const pickers = [];
  try {
    for (const f of htmls) {
      const rel = relative(root, f).split('\\').join('/');
      const raw = readFileSync(f, 'utf8');
      const pg = await browser.newPage(); await pg.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
      await pg.goto(`${base}/${rel}`, { waitUntil: 'networkidle0', timeout: 60000 }).catch(() => {});
      const info = await pg.evaluate(() => {
        const name = (el) => {
          const by = el.getAttribute('aria-labelledby'); if (by) return by.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ').trim();
          if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
          if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) return l.textContent.trim(); }
          const wrap = el.closest('label'); if (wrap) return wrap.textContent.trim();
          if (el.tagName === 'SELECT') return '';
          if (el.tagName === 'INPUT') return (el.getAttribute('title') || el.value || '').trim();
          return (el.textContent || el.getAttribute('title') || el.querySelector('img')?.alt || '').trim();
        };
        const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
        const cartRe = /\b(add to (cart|basket|bag)|buy now|buy it now|add to order|in den warenkorb)\b/i;
        const cart = [...document.querySelectorAll('button, input[type=submit], input[type=button], a, [role=button]')].filter(vis).find((b) => cartRe.test(b.textContent || b.value || b.getAttribute('aria-label') || ''));
        const cr = cart?.getBoundingClientRect();
        // variant controls: radios, selects, swatch buttons inside something about colour/size/variant
        // the enclosing group's text ("Colour: Indigo"), plus a marker when the control sits in a swatch/variant wrapper;
        // not just the nearest wrapper, whose text is often only the option's own name ("Indigo")
        const ctx = (el) => ((el.closest('fieldset, [role=radiogroup], [role=group]') || el.closest('form'))?.textContent || '').slice(0, 300) + (el.closest('[data-variant], [class*=variant], [class*=swatch], [class*=colour], [class*=color], [class*=size]') ? ' swatch' : '');
        const controls = [...document.querySelectorAll('input[type=radio], select, [role=radio], button[aria-pressed], button[data-color], button[data-colour], button[data-variant], [class*=swatch] button, button[class*=swatch], [class*=swatch][tabindex]')]
          .filter((el) => /colou?r|size|variant|shade|style|option|swatch/i.test(ctx(el) + ' ' + (el.name || '') + ' ' + el.className))
          .map((el) => ({ tag: el.tagName.toLowerCase(), type: el.type || el.getAttribute('role') || '', name: name(el), focusable: el.tabIndex >= 0 && !el.disabled, visible: vis(el) || !!el.closest('label') }));
        const imgs = [...document.querySelectorAll('main img, [class*=product] img, [class*=gallery] img, article img')].filter((i, k, a) => a.indexOf(i) === k).map((i) => ({ src: i.currentSrc || i.src, alt: i.getAttribute('alt'), nw: i.naturalWidth, nh: i.naturalHeight, hasSize: i.hasAttribute('width') && i.hasAttribute('height') || !!getComputedStyle(i).aspectRatio && getComputedStyle(i).aspectRatio !== 'auto', w: i.getBoundingClientRect().width }));
        return {
          ld: [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent),
          text: document.body ? document.body.innerText : '',
          og: Object.fromEntries([...document.querySelectorAll('meta[property^="og:"], meta[name^="twitter:"], meta[property^="product:"]')].map((m) => [m.getAttribute('property') || m.getAttribute('name'), m.getAttribute('content')])),
          title: document.title,
          wide: document.documentElement.scrollWidth > window.innerWidth + 1,
          // visible on the first screen as loaded (a sticky or fixed bar counts), not just where it sits in the page
          cart: cart ? { text: (cart.textContent || cart.value || '').trim().slice(0, 40), top: cr.top + scrollY, bottom: cr.bottom + scrollY, onFirst: cr.top >= 0 && cr.bottom <= innerHeight, pinned: /sticky|fixed/.test(getComputedStyle(cart).position) || !!cart.closest('[style*=sticky],[style*=fixed]') } : null,
          controls, imgs,
        };
      });
      // keyboard: tab through the page and note which variant controls take focus
      const tabbed = [];
      try { await pg.focus('body'); } catch { /* fine */ }
      for (let i = 0; i < 60; i++) { await pg.keyboard.press('Tab'); const a = await pg.evaluate(() => { const e = document.activeElement; return e && e !== document.body ? `${e.tagName.toLowerCase()}|${e.type || e.getAttribute('role') || ''}|${(e.getAttribute('aria-label') || e.textContent || e.value || '').trim().slice(0, 30)}` : null; }); if (a) tabbed.push(a); }
      const dir = mkdtempSync(join(tmpdir(), 'product-check-'));
      const first = join(dir, 'first.png'), full = join(dir, 'full.png');
      // clear the focus the tab walk left behind, so no focus ring shows in the screenshots
      await pg.evaluate(() => { document.activeElement?.blur?.(); scrollTo(0, 0); });
      await pg.screenshot({ path: first }).catch(() => {});
      await pg.screenshot({ path: full, fullPage: true, captureBeyondViewport: true }).catch(() => {});
      await pg.close();

      // structured data
      const found = { products: [], groups: [], orgs: [], byId: {} };
      for (const blob of info.ld) {
        let j; try { j = JSON.parse(blob); } catch (e) { add('error', 'jsonld-invalid', rel, `${rel}: a JSON-LD block doesn't parse (${String(e.message).slice(0, 80)}), so Google ignores it.`); continue; }
        nodes(j, found);
      }
      const isProductPage = found.products.length || found.groups.length || info.cart;
      if (!isProductPage) continue;
      shots.push({ page: rel, first, full, cart: info.cart, wide: info.wide });
      cards.push({ page: rel, og: info.og, title: info.title });
      if (!found.products.length && !found.groups.length) { add('error', 'no-product-data', rel, `${rel}: an Add to cart page with no schema.org Product data, so Google can't show it as a merchant listing (price, stock, delivery, returns).`); }
      if (found.products.length || found.groups.length) {
        if (!/application\/ld\+json/i.test(raw)) add('warn', 'jsonld-not-in-html', rel, `${rel}: the Product data is added by JavaScript, not in the page's HTML. Google: "putting Product structured data in the initial HTML" gives the best results; shopping crawls of script-made markup are "less frequent and less reliable".`);
      }
      const orgShip = found.orgs.some((o) => o.hasShippingService || o.shippingDetails); const orgReturns = found.orgs.some((o) => o.hasMerchantReturnPolicy);
      for (const o of found.orgs) { checkReturns(o.hasMerchantReturnPolicy, `${rel}: Organization`, add); }
      const text = info.text.replace(/\s+/g, ' ');
      // groups
      for (const g of found.groups) {
        const where = `${rel}: ProductGroup "${g.name || '(no name)'}"`;
        if (!g.name) add('error', 'group-name', where, `${where}: no name (Google: required).`);
        if (!g.productGroupID && ![].concat(g.hasVariant || []).every((v) => v?.inProductGroupWithID)) add('warn', 'group-id', where, `${where}: no productGroupID (Google: give it on the group or as inProductGroupWithID on each variant).`);
        if (!g.variesBy) add('warn', 'group-varies', where, `${where}: no variesBy (Google: recommended, e.g. https://schema.org/color).`);
        if (![].concat(g.hasVariant || []).length) add('error', 'group-no-variants', where, `${where}: no hasVariant Products.`);
        const names = [].concat(g.hasVariant || []).map((v) => v?.name);
        if (names.some((n) => n && n === g.name)) add('warn', 'variant-name', where, `${where}: a variant has the same name as the group; Google wants each variant's name more specific ("Scarf - Indigo").`);
      }
      // products (standalone or variants)
      for (const p of found.products) {
        const where = `${rel}: Product "${p.name || '(no name)'}"`;
        if (!p.name) add('error', 'product-name', where, `${where}: no name (Google: required).`);
        const imgs = [].concat(p.image || []).map((x) => typeof x === 'string' ? x : x?.url || x?.contentUrl).filter(Boolean);
        const inGroup = found.groups.some((g) => [].concat(g.hasVariant || []).includes(p));
        const groupImg = found.groups.some((g) => g.image);
        if (!imgs.length && !(inGroup && groupImg)) add('error', 'product-image', where, `${where}: no image (Google: required for merchant listings).`);
        const offers = [].concat(p.offers || []);
        if (!offers.length) add('error', 'product-offers', where, `${where}: no offers (Google: required; merchant listings need an Offer with a price).`);
        for (const o0 of offers) {
          const o = o0 && o0['@id'] && found.byId[o0['@id']] ? { ...found.byId[o0['@id']], ...o0 } : o0;
          if (is(o, 'AggregateOffer')) { add('error', 'aggregate-offer', where, `${where}: AggregateOffer. Google: "merchant listings require an Offer", because the merchant must be the seller.`); continue; }
          const price = num(o?.price ?? o?.priceSpecification?.price); const cur = o?.priceCurrency || o?.priceSpecification?.priceCurrency;
          if (price == null) add('error', 'offer-price', where, `${where}: the offer has no price (Google: required).`);
          else if (price <= 0) add('error', 'offer-price-zero', where, `${where}: price ${o.price}. Google: "merchant listing experiences require a price greater than zero."`);
          if (!cur) add('error', 'offer-currency', where, `${where}: no priceCurrency (Google: required, ISO 4217 such as GBP).`);
          else if (!/^[A-Z]{3}$/.test(cur)) add('error', 'offer-currency', where, `${where}: priceCurrency "${cur}" isn't a three-letter ISO 4217 code.`);
          if (!o?.availability) add('warn', 'offer-availability', where, `${where}: no availability (Google: recommended, e.g. InStock).`);
          if (o?.priceValidUntil && Date.parse(o.priceValidUntil) < Date.now()) add('error', 'offer-price-expired', where, `${where}: priceValidUntil ${o.priceValidUntil} is in the past; Google: "Your listing may not display".`);
          if (!o?.itemCondition) add('warn', 'offer-condition', where, `${where}: no itemCondition (Google: recommended, NewCondition).`);
          const ship = deref(o?.shippingDetails, found.byId), rets = deref(o?.hasMerchantReturnPolicy, found.byId);
          if (o?.shippingDetails) checkShipping(ship, where, add); else if (!orgShip) add('warn', 'offer-shipping', where, `${where}: no shippingDetails (and no shop-wide shipping policy on the page), so Google can't show the delivery cost.`);
          if (o?.hasMerchantReturnPolicy) checkReturns(rets, where, add); else if (!orgReturns) add('warn', 'offer-returns', where, `${where}: no hasMerchantReturnPolicy (and no shop-wide policy on the page), so Google can't show the returns window.`);
          // the page must show what the data says (Google: don't mark up content that isn't visible)
          if (price != null && price > 0) {
            const forms = new Set([price.toFixed(2), String(price), price.toFixed(0)]);
            const sym = SYMBOL[cur] || '';
            const seen = [...forms].some((v) => new RegExp(`(${sym ? sym.replace(/[$]/g, '\\$') + '\\s?' : ''}|\\b${cur}\\s?)${v.replace('.', '[.,]')}(?![0-9])`).test(text) || (sym && text.includes(sym + v)));
            if (!seen) add('error', 'price-not-on-page', where, `${where}: the data says ${sym || cur + ' '}${price} but the page never shows that price. Google: "Don't mark up content that is not visible"; a mismatch can get the listing removed.`);
          }
          if (o?.availability && /OutOfStock|SoldOut/.test(String(o.availability)) && !/out of stock|sold out|unavailable/i.test(text)) add('warn', 'availability-not-on-page', where, `${where}: the data says ${short(o.availability)} but the page doesn't say so.`);
          products.push({ page: rel, name: p.name, price, currency: cur, availability: short(o?.availability), image: imgs[0] || '', brand: p.brand?.name || (typeof p.brand === 'string' ? p.brand : ''), shipping: ship[0]?.shippingRate, returns: (rets.length ? rets : deref(found.orgs.find((x) => x.hasMerchantReturnPolicy)?.hasMerchantReturnPolicy, found.byId))[0], color: p.color || '' });
        }
        if (!p.brand && !found.groups.some((g) => g.brand)) add('warn', 'product-brand', where, `${where}: no brand (Google: recommended).`);
        if (!p.description && !found.groups.some((g) => g.description)) add('warn', 'product-description', where, `${where}: no description (Google: recommended).`);
        if (!p.sku && !p.gtin && !p.gtin13 && !p.gtin12 && !p.gtin8 && !p.gtin14 && !p.mpn) add('warn', 'product-ids', where, `${where}: no sku, gtin or mpn (Google: recommended; a handmade item with no GTIN can use sku).`);
      }
      if (found.products.length > 1 && !found.groups.length && found.products.some((p) => p.color || p.size)) add('warn', 'variants-not-grouped', rel, `${rel}: several Products with colours or sizes but no ProductGroup. Google documents variants as a ProductGroup with hasVariant, variesBy and productGroupID.`);
      // what shoppers see
      if (info.wide) add('error', 'scrolls-sideways', rel, `${rel} scrolls sideways on a 390 px phone.`);
      if (!info.cart) add('warn', 'no-cart-button', rel, `${rel}: no "Add to cart"/"Buy" button found.`);
      else if (!info.cart.onFirst) add('warn', 'cart-below-fold', rel, `${rel}: "${info.cart.text}" starts ${Math.round(info.cart.top)} px down, below the first screen of a 390×844 phone (Palm's guidance: keep the price, the choice and the button on the first screen).`);
      const unnamed = info.controls.filter((c) => !c.name);
      if (unnamed.length) add('error', 'variant-unnamed', rel, `${rel}: ${unnamed.length} colour/size control${unnamed.length > 1 ? 's have' : ' has'} no accessible name (a swatch with no label), so a screen reader says only "button" or "radio" (WCAG 4.1.2).`);
      const notFocusable = info.controls.filter((c) => !c.focusable);
      if (notFocusable.length) add('error', 'variant-keyboard', rel, `${rel}: ${notFocusable.length} variant control${notFocusable.length > 1 ? 's' : ''} can't take keyboard focus (WCAG 2.1.1).`);
      if (info.controls.length && !tabbed.some((t) => /radio|select|button/.test(t))) add('warn', 'variant-tab', rel, `${rel}: tabbing through the page never reached a variant control.`);
      pickers.push({ page: rel, controls: info.controls, tabbed: tabbed.slice(0, 20) });
      const noAlt = info.imgs.filter((i) => i.alt == null);
      if (noAlt.length) add('error', 'image-alt', rel, `${rel}: ${noAlt.length} product image${noAlt.length > 1 ? 's have' : ' has'} no alt attribute (WCAG 1.1.1).`);
      const small = info.imgs.filter((i) => i.nw && i.nh && i.nw * i.nh < 50000);
      if (small.length) add('warn', 'image-small', rel, `${rel}: ${small.length} product image${small.length > 1 ? 's are' : ' is'} under 50K pixels (width × height), Google's minimum recommendation for product images.`);
      const noSize = info.imgs.filter((i) => !i.hasSize);
      if (noSize.length) add('warn', 'image-size-attrs', rel, `${rel}: ${noSize.length} product image${noSize.length > 1 ? 's have' : ' has'} no width/height (or aspect-ratio), so the page jumps as they load.`);
      if (!info.og['og:image']) add('warn', 'card-image', rel, `${rel}: no og:image, so a shared link shows no picture.`);
    }
    if (!products.length && !issues.some((i) => i.id === 'no-product-data')) add('error', 'no-products', '', 'No product page found (no Product data and no Add to cart button).');

    // the sheet
    const sheet = resolve(out + '-sheet.png'); mkdirSync(dirname(sheet), { recursive: true });
    const img = (p) => existsSync(p) ? `data:image/png;base64,${readFileSync(p).toString('base64')}` : '';
    const local = (u) => { if (!u) return ''; try { const x = new URL(u, base + '/'); const p = join(root, decodeURIComponent(x.pathname)); return existsSync(p) && statSync(p).isFile() ? `data:${TYPES[extname(p).toLowerCase()] || 'image/jpeg'};base64,${readFileSync(p).toString('base64')}` : ''; } catch { return ''; } };
    const money = (v, c) => v == null ? '' : `${SYMBOL[c] || (c ? c + ' ' : '')}${Number(v).toFixed(Number(v) % 1 ? 2 : 0)}`;
    const seenG = new Set();
    const gm = products.filter((p) => { const k = p.page + p.name; if (seenG.has(k)) return false; seenG.add(k); return true; }).slice(0, 6).map((p) => { const ship = p.shipping ? (Number(p.shipping.value) === 0 ? 'Free delivery' : `+${money(p.shipping.value ?? p.shipping.maxValue, p.shipping.currency)} delivery`) : ''; const ret = p.returns?.merchantReturnDays ? `${p.returns.merchantReturnDays}-day returns` : ''; return `<div class="g">${local(p.image) ? `<img src="${local(p.image)}">` : '<div class="gi">no image</div>'}<div><div class="gn">${esc(p.name)}</div><div class="gp">${esc(money(p.price, p.currency))}</div><div class="gs">${esc(p.brand || '')}${p.availability ? ' · ' + esc(p.availability === 'InStock' ? 'In stock' : p.availability) : ''}</div><div class="gs">${esc([ship, ret].filter(Boolean).join(' · ') || 'no delivery or returns info')}</div></div></div>`; }).join('') || '<i>No Product data</i>';
    const cardHtml = cards.map((c) => `<div class="card">${local(c.og['og:image']) ? `<img src="${local(c.og['og:image'])}">` : '<div class="noimg">no image</div>'}<div class="cb"><div class="cn">${esc(c.og['og:title'] || c.title)}</div><div class="cs">${esc(c.og['og:description'] || '')}</div></div></div>`).join('');
    const pick = pickers.map((p) => `<div class="pk"><div class="lab">${esc(p.page)}: what a screen reader hears for each colour/size control</div>${p.controls.length ? p.controls.map((c) => `<div class="${c.name ? 'ok' : 'bad'}">${esc(c.tag)}${c.type ? ' (' + esc(c.type) + ')' : ''}: <b>${esc(c.name || 'no name')}</b>${c.focusable ? '' : ' · not keyboard-reachable'}</div>`).join('') : '<i>No variant controls found</i>'}</div>`).join('');
    const notes = plain ? '' : `<h2>Problems</h2><ul class="n">${issues.slice(0, 30).map((i) => `<li class="${i.level}">${esc(i.msg)}</li>`).join('')}</ul>`;
    const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:24px;font:14px/1.4 -apple-system,system-ui,sans-serif;background:#f3f3f1;color:#111;width:1400px}h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#555;margin:22px 0 10px}.row{display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap}.ph{width:390px;background:#fff;box-shadow:0 1px 4px #0003;position:relative}.ph img{width:390px;display:block}.fold{position:absolute;left:0;right:0;top:844px;border-top:3px dashed #d33}.fl{position:absolute;right:4px;top:848px;background:#d33;color:#fff;font-size:11px;padding:1px 4px}.lab{font-size:12px;color:#555;margin:4px 0}.gwrap{background:#fff;border-radius:8px;padding:14px;width:600px}.g{display:flex;gap:12px;padding:10px 0;border-bottom:1px solid #eee}.g img{width:92px;height:92px;object-fit:cover;border-radius:8px}.gi{width:92px;height:92px;background:repeating-linear-gradient(45deg,#fdd,#fdd 8px,#fee 8px,#fee 16px);color:#a00;font-size:11px;display:flex;align-items:center;justify-content:center;border-radius:8px}.gn{color:#1a0dab;font-size:16px}.gp{font-weight:700;font-size:16px}.gs{color:#4d5156;font-size:13px}.card{width:320px;background:#fff;border:1px solid #ddd;border-radius:10px;overflow:hidden}.card img{width:320px;height:168px;object-fit:cover;display:block}.noimg{height:120px;background:repeating-linear-gradient(45deg,#fdd,#fdd 8px,#fee 8px,#fee 16px);display:flex;align-items:center;justify-content:center;color:#a00}.cb{padding:8px 10px}.cn{font-weight:600}.cs{color:#555;font-size:12px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.pk{background:#fff;border-radius:8px;padding:12px;width:420px}.pk .bad{color:#b3261e}.n li.error{color:#b3261e}.n li.warn{color:#8a5a00}</style>
<h2>The first screen on a phone (390×844), and the whole page with the fold marked</h2><div class="row">${shots.map((s) => `<div><div class="lab">${esc(s.page)}: first screen</div><div class="ph"><img src="${img(s.first)}"></div></div><div><div class="lab">${esc(s.page)}: whole page${s.cart ? (s.cart.onFirst ? ` (“${esc(s.cart.text)}” on the first screen${s.cart.pinned ? ', pinned' : ''})` : ` (“${esc(s.cart.text)}” at ${Math.round(s.cart.top)} px)`) : ''}</div><div class="ph"><img src="${img(s.full)}"><div class="fold"></div><div class="fl">end of first screen</div></div></div>`).join('')}</div>
<h2>As Google might show the product (Palm's mock, from the page's Product data)</h2><div class="gwrap">${gm}</div>
<h2>The colour/size picker, read out</h2><div class="row">${pick}</div>
<h2>The link card when the page is shared</h2><div class="row">${cardHtml}</div>${notes}`;
    const sp = await browser.newPage(); await sp.setViewport({ width: 1448, height: 900, deviceScaleFactor: 1 });
    await sp.setContent(html, { waitUntil: 'load' }); await sp.screenshot({ path: sheet, fullPage: true });
    const errors = issues.filter((i) => i.level === 'error').length, warnings = issues.length - errors;
    return { ok: errors === 0 && products.length > 0, errors, warnings, pickers: pickers.map((p) => ({ page: p.page, controls: p.controls.length, named: p.controls.filter((c) => c.name).length })), products: products.map(({ shipping, returns, ...p }) => ({ ...p, shipping: shipping ? money(shipping.value ?? shipping.maxValue, shipping.currency) : null, returnDays: returns?.merchantReturnDays ?? null })), issues, sheet };
  } finally { await browser.close(); srv.close(); }
}

async function selfTest() {
  const photo = '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200"><rect width="1200" height="1200" fill="#5a7"/></svg>';
  const tiny = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#5a7"/></svg>';
  const shell = (ld, body, head = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Scarf</title>${head}${ld ? `<script type="application/ld+json">${JSON.stringify(ld)}</script>` : ''}</head><body style="margin:0;font:16px system-ui">${body}</body></html>`;
  // bad: price 0 in data and £40 on page, no currency, AggregateOffer on a second product, unnamed swatches, image without alt, tiny image, button far down, no og:image
  const d = mkdtempSync(join(tmpdir(), 'product-check-bad-'));
  writeFileSync(join(d, 'tiny.svg'), tiny);
  writeFileSync(join(d, 'index.html'), shell({ '@context': 'https://schema.org', '@type': 'Product', name: 'Silk scarf', image: '/tiny.svg', offers: { '@type': 'Offer', price: 0 } },
    `<main><img src="/tiny.svg" width="390" height="390"><h1>Silk scarf</h1><p>£40</p><div style="height:900px">Long story about silk.</div><div class="swatches"><span class="swatch" tabindex="-1" style="display:inline-block;width:32px;height:32px;background:red"></span><button class="swatch" style="width:32px;height:32px;background:blue"></button></div><button>Add to cart</button></main>`));
  const r = await check(d, { out: join(d, 'look/bad') });
  const got = new Set(r.issues.map((i) => i.id));
  for (const want of ['offer-price-zero', 'offer-currency', 'variant-unnamed', 'image-alt', 'image-small', 'cart-below-fold', 'card-image', 'offer-shipping', 'offer-returns']) if (!got.has(want)) throw new Error(`bad page: expected ${want}, got ${[...got].join(', ')}`);
  if (!existsSync(r.sheet)) throw new Error('no sheet');
  // also: data price not on page
  const d2 = mkdtempSync(join(tmpdir(), 'product-check-mismatch-'));
  writeFileSync(join(d2, 'photo.svg'), photo);
  writeFileSync(join(d2, 'index.html'), shell({ '@context': 'https://schema.org', '@type': 'Product', name: 'Silk scarf', image: '/photo.svg', offers: { '@type': 'Offer', price: '38.00', priceCurrency: 'GBP', availability: 'https://schema.org/InStock' } }, '<main><img src="/photo.svg" alt="Silk scarf" width="390" height="390"><h1>Silk scarf</h1><p>£42.00</p><button>Add to cart</button></main>'));
  const m = await check(d2, { out: join(d2, 'look/m') });
  if (!m.issues.some((i) => i.id === 'price-not-on-page')) throw new Error('price mismatch not flagged: ' + m.issues.map((i) => i.id).join(','));
  // good: ProductGroup with variants, full Offer with shipping and returns, named radios, alt, og:image, button on first screen
  const g = mkdtempSync(join(tmpdir(), 'product-check-good-'));
  writeFileSync(join(g, 'photo.svg'), photo);
  const offer = (c) => ({ '@type': 'Offer', price: 38, priceCurrency: 'GBP', availability: 'https://schema.org/InStock', itemCondition: 'https://schema.org/NewCondition', url: `https://example.com/scarf?colour=${c}`,
    shippingDetails: { '@type': 'OfferShippingDetails', shippingRate: { '@type': 'MonetaryAmount', value: 3.5, currency: 'GBP' }, shippingDestination: { '@type': 'DefinedRegion', addressCountry: 'GB' }, deliveryTime: { '@type': 'ShippingDeliveryTime', handlingTime: { '@type': 'QuantitativeValue', minValue: 0, maxValue: 1, unitCode: 'DAY' }, transitTime: { '@type': 'QuantitativeValue', minValue: 1, maxValue: 3, unitCode: 'DAY' } } },
    hasMerchantReturnPolicy: { '@type': 'MerchantReturnPolicy', applicableCountry: 'GB', returnPolicyCategory: 'https://schema.org/MerchantReturnFiniteReturnWindow', merchantReturnDays: 30 } });
  const ld = { '@context': 'https://schema.org', '@type': 'ProductGroup', name: 'Hand-dyed silk scarf', productGroupID: 'scarf', variesBy: 'https://schema.org/color', brand: { '@type': 'Brand', name: 'Dyehouse' }, description: 'Hand-dyed silk.', image: 'https://example.com/photo.svg',
    hasVariant: ['Indigo', 'Madder'].map((c) => ({ '@type': 'Product', name: `Hand-dyed silk scarf - ${c}`, sku: `scarf-${c.toLowerCase()}`, color: c, image: '/photo.svg', offers: offer(c) })) };
  writeFileSync(join(g, 'index.html'), shell(ld, `<main><img src="/photo.svg" alt="Indigo silk scarf, folded" width="390" height="390"><h1>Hand-dyed silk scarf</h1><p>£38</p><fieldset><legend>Colour</legend><label><input type="radio" name="colour" value="indigo" checked> Indigo</label><label><input type="radio" name="colour" value="madder"> Madder</label></fieldset><button>Add to cart</button><p>Delivery £3.50, 30-day returns.</p></main>`, '<meta property="og:title" content="Hand-dyed silk scarf"><meta property="og:image" content="/photo.svg">'));
  const ok = await check(g, { out: join(g, 'look/good') });
  if (ok.errors) throw new Error('good page flagged: ' + ok.issues.filter((i) => i.level === 'error').map((i) => i.msg).join(' | '));
  // a shop-wide shipping/returns policy defined once in @graph and referenced by @id is fine
  const rf = mkdtempSync(join(tmpdir(), 'product-check-ref-'));
  writeFileSync(join(rf, 'photo.svg'), photo);
  const refLd = { '@context': 'https://schema.org', '@graph': [JSON.parse(JSON.stringify(ld)), { '@type': 'OfferShippingDetails', '@id': '#ship', ...offer('x').shippingDetails }, { '@type': 'MerchantReturnPolicy', '@id': '#ret', ...offer('x').hasMerchantReturnPolicy }] };
  for (const v of refLd['@graph'][0].hasVariant) { v.offers.shippingDetails = { '@id': '#ship' }; v.offers.hasMerchantReturnPolicy = { '@id': '#ret' }; }
  writeFileSync(join(rf, 'index.html'), readFileSync(join(g, 'index.html'), 'utf8').replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, `<script type="application/ld+json">${JSON.stringify(refLd)}</script>`));
  const rr = await check(rf, { out: join(rf, 'look/ref') });
  if (rr.errors || rr.products[0]?.shipping !== '£3.50') throw new Error('@id-referenced policies flagged: ' + rr.issues.map((i) => i.id).join(',') + ' shipping ' + rr.products[0]?.shipping);
  // radios wrapped in label.swatch inside a "Colour" fieldset are a picker (the wrapper's own text is only "Indigo")
  const sw = mkdtempSync(join(tmpdir(), 'product-check-swatch-'));
  writeFileSync(join(sw, 'photo.svg'), photo);
  writeFileSync(join(sw, 'index.html'), readFileSync(join(g, 'index.html'), 'utf8').replace(/<fieldset>[\s\S]*?<\/fieldset>/, '<fieldset><legend>Colour: Indigo</legend><label class="swatch"><input type="radio" name="sku" value="a" checked> Indigo <small>blue</small></label><label class="swatch"><input type="radio" name="sku" value="b"> Madder <small>red</small></label></fieldset>'));
  const swr = await check(sw, { out: join(sw, 'look/sw') });
  if (swr.pickers[0]?.controls !== 2 || swr.pickers[0]?.named !== 2) throw new Error('label.swatch radios not found as a picker: ' + JSON.stringify(swr.pickers));
  // a buy button pinned to the bottom of the screen (position: sticky) is on the first screen even on a long page
  const st = mkdtempSync(join(tmpdir(), 'product-check-sticky-'));
  writeFileSync(join(st, 'photo.svg'), photo);
  writeFileSync(join(st, 'index.html'), readFileSync(join(g, 'index.html'), 'utf8').replace('<button>Add to cart</button>', '<div style="height:1400px">Long description.</div><button style="position:sticky;bottom:12px">Add to cart</button>'));
  const str = await check(st, { out: join(st, 'look/st') });
  if (str.issues.some((i) => i.id === 'cart-below-fold')) throw new Error('a sticky buy button was flagged below the fold');
  console.log(`product-check: all tests pass (bad: ${[...got].join(', ')}; good: ${ok.warnings} warnings ${ok.issues.map((i) => i.id).join(', ')})`);
}

if (typeof process !== 'undefined' && process.argv?.[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
  const VALUED = new Set(['--out', '--pages']);
  const pos = argv.filter((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1]));
  const done = (r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); };
  const fail = (e) => { console.error(String(e.message || e)); process.exit(2); };
  if (argv.includes('--test')) selfTest().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
  else if (pos[0] === 'check' && pos[1]) check(pos[1], { pages: opt('pages') ? opt('pages').split(',') : null, out: opt('out', 'look/product') }).then(done, fail);
  else fail('usage: product-check.mjs check <site folder> [--pages product.html] [--out look/product]\n       product-check.mjs --test');
}
