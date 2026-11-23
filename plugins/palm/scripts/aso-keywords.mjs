#!/usr/bin/env node
// Palm tool: aso.check — checks App Store name, subtitle and keyword field, and returns an
// optimised keyword field. Deterministic, no network. adds: tool (agents miscount bytes, waste
// the 100 bytes on words already indexed from the name/subtitle, and add spaces after commas).
//
// In:  {"name": "...", "subtitle": "...", "keywords": "a,b,c", "promo": "...", "category": "Health & Fitness", "developer": "...", "candidates": ["extra", "words"]}
// Out: {"ok": bool, "issues": [...], "keywords_optimised": "...", "bytes": n, "spare_bytes": n, "dropped": [...]}

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const DATA = join(here, '../library/app-launch/data/app-store.json');

// Fallbacks; the data pack overrides them when it has a confirmed value.
const LIMITS = { name: 30, subtitle: 30, keywords: 100, promo: 170 };
if (existsSync(DATA)) {
  try {
    const pack = JSON.parse(readFileSync(DATA, 'utf8'));
    const KEYS = { 'asc.name.max': 'name', 'asc.subtitle.max': 'subtitle', 'asc.keywords.max': 'keywords', 'asc.promotional_text.max': 'promo' };
    for (const it of pack.items || []) {
      if (KEYS[it.key] && typeof it.value === 'number' && it.confidence !== 'unverified') LIMITS[KEYS[it.key]] = it.value;
    }
    LIMITS.checked = pack.checked;
  } catch { /* keep fallbacks */ }
}

// Words that waste keyword bytes: Apple already indexes the app's category, and "app"/"free"
// and filler words add nothing. (Kept short and conservative.)
const WASTE = new Set(['app', 'apps', 'free', 'the', 'a', 'an', 'and', 'or', 'for', 'of', 'with', 'to', 'in', 'on', 'my', 'your', 'best', 'iphone', 'ipad', 'ios']);

const bytes = (s) => Buffer.byteLength(s, 'utf8');
const words = (s) => (s || '').toLowerCase().normalize('NFC').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const stem = (w) => (w.length > 4 && w.endsWith('ies') ? w.slice(0, -3) + 'y'
  : w.length > 3 && w.endsWith('es') && /(s|x|z|ch|sh)es$/.test(w) ? w.slice(0, -2)
  : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);

export function check(input) {
  const { name = '', subtitle = '', keywords = '', promo = '', candidates = [], category = '', developer = '' } = input || {};
  const issues = [];
  const add = (field, severity, msg, fix) => issues.push({ field, severity, msg, fix });

  for (const [field, val] of [['name', name], ['subtitle', subtitle], ['promo', promo]]) {
    const n = [...val].length;
    if (n > LIMITS[field]) add(field, 'error', `${n} characters; the limit is ${LIMITS[field]}.`, `Cut ${n - LIMITS[field]} characters.`);
  }
  if (name && [...name].length < LIMITS.name - 8) add('name', 'tip', `Name uses ${[...name].length} of ${LIMITS.name} characters.`, 'Add a short keyword phrase after the brand, e.g. "Brand: Habit Tracker".');
  if (subtitle && [...subtitle].length < LIMITS.subtitle - 8) add('subtitle', 'tip', `Subtitle uses ${[...subtitle].length} of ${LIMITS.subtitle} characters.`, 'Fill it with words people search for, not a slogan.');

  if (/,\s/.test(keywords)) add('keywords', 'error', 'Spaces after commas waste bytes.', 'Use "a,b,c" with no spaces.');
  const kb = bytes(keywords);
  if (kb > LIMITS.keywords) add('keywords', 'error', `${kb} bytes; the limit is ${LIMITS.keywords} bytes (not characters).`, 'Use keywords_optimised.');

  // Apple also indexes the primary category and (per ASO practice) the developer name.
  const indexed = new Set([...words(name), ...words(subtitle), ...words(category), ...words(developer)].map(stem));
  const seen = new Set();
  const kept = [];
  const dropped = [];
  const pool = [...keywords.split(','), ...candidates];
  for (const raw of pool) {
    for (const w of words(raw)) {
      const s = stem(w);
      if (WASTE.has(w)) { dropped.push({ word: w, why: 'adds nothing (filler, "app", "free" or a platform name)' }); continue; }
      if (indexed.has(s)) { dropped.push({ word: w, why: 'already indexed (name, subtitle, category or developer name)' }); continue; }
      if (seen.has(s)) { dropped.push({ word: w, why: 'repeat (or plural/singular of a word already in)' }); continue; }
      seen.add(s);
      kept.push(w);
    }
  }
  for (const d of dropped) {
    if (keywords.toLowerCase().includes(d.word)) add('keywords', 'warn', `"${d.word}": ${d.why}.`, 'Removed in keywords_optimised.');
  }
  // Single words beat phrases: Apple combines words across the fields, so phrases waste commas/bytes.
  if (keywords.split(',').some((k) => k.trim().includes(' '))) add('keywords', 'tip', 'Multi-word phrases in the keyword field.', 'Split them into single words; Apple combines words across name, subtitle and keywords.');

  let out = '';
  const fitted = [];
  for (const w of kept) {
    const next = out ? `${out},${w}` : w;
    if (bytes(next) > LIMITS.keywords) { dropped.push({ word: w, why: 'did not fit in the byte limit' }); continue; }
    out = next; fitted.push(w);
  }
  const ok = !issues.some((i) => i.severity === 'error');
  return {
    ok, limits: LIMITS, issues, keywords_optimised: out, bytes: bytes(out), spare_bytes: LIMITS.keywords - bytes(out),
    dropped, next: (LIMITS.keywords - bytes(out)) > 10 ? 'Spare bytes left: pass more single-word candidates to fill them.' : null,
  };
}

function selfTest() {
  const r = check({ name: 'Streakly: Habit Tracker', subtitle: 'Daily goals & routine planner', keywords: 'habit, habits,tracker,streak,daily,app,goal tracker,routines,free,mood' });
  const assert = (c, m) => { if (!c) { console.error('FAIL', m, JSON.stringify(r, null, 2)); process.exit(1); } };
  assert(!r.ok, 'spaces after commas should be an error');
  assert(!r.keywords_optimised.includes(' '), 'no spaces');
  assert(!/(^|,)(habit|habits|tracker|daily|app|free|routines|goal)(,|$)/.test(r.keywords_optimised), 'drops indexed/waste/plurals: ' + r.keywords_optimised);
  assert(r.keywords_optimised.split(',').includes('streak') && r.keywords_optimised.split(',').includes('mood'), 'keeps new words');
  const long = check({ name: 'X', subtitle: '', keywords: Array.from({ length: 40 }, (_, i) => 'word' + String.fromCharCode(97 + (i % 26)) + i).join(',') });
  assert(long.bytes <= 100, 'fits 100 bytes');
  const jp = check({ name: '習慣', keywords: '習慣,日記,目標' });
  assert(jp.bytes === Buffer.byteLength(jp.keywords_optimised), 'counts UTF-8 bytes');
  console.log('aso-keywords: all tests pass', JSON.stringify(r.limits));
}

if (typeof process !== 'undefined' && process.argv?.[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--test')) selfTest();
  else {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    process.stdout.write(JSON.stringify(check(input), null, 2) + '\n');
  }
}
