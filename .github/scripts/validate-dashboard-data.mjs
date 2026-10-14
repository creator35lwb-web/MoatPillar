#!/usr/bin/env node
/** Schema v2 gates every new publication. The optional frozen legacy allowlist
 * preserves reviewed archived data without asserting that its analysis is approved.
 * This verifies shape/attribution, not upstream source truth or semantic entailment. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import policy from '../../src/n8n/analysis-policy.js';

const FILES = ['docs/data/latest-us.json', 'docs/data/latest-cn.json'];
const KEY = /^[A-Za-z][A-Za-z0-9_]{0,99}$/;
const HEADLINE = /^headline_([1-9]\d*)$/;
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const nonempty = (value, max = 2000) => typeof value === 'string' && !!value.trim() && value.length <= max;
const validKey = value => typeof value === 'string' && KEY.test(value) && !FORBIDDEN.has(value);
const isoDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value + 'T00:00:00Z'));

// Raw-byte hashes at b2997c45c123a09920b406b81e2ce4bfea9e9827, explicitly listing
// Git's LF bytes and Windows autocrlf checkouts. No other content/whitespace is exempt.
export const HISTORICAL_SNAPSHOTS = Object.freeze({
  'latest-us.json': Object.freeze({ edition: 'US', sha256: Object.freeze(['6936fae913c77903b92d21c806919b45b70375a98dfaea29075797481e410e8f', '2a654d0021c238301c274e79a25ab7e7d83696b6ea0ca4707ddaf68e77b5176b']) }),
  'latest-cn.json': Object.freeze({ edition: 'CN', sha256: Object.freeze(['68fd1e7a11b16047c9ef6429ea037d067d992ac37ba28427435234f1493f1566', '4e8221e52a91b3e24bbc71f3e7672fd3b27ba3200ad558637bccb2020d070943']) }),
});

function httpUrl(value) {
  if (!nonempty(value, 4096) || /[\s<>"']/.test(value)) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password;
  } catch { return false; }
}

export function validateDashboardData(data, { edition, now = Date.now() } = {}) {
  const errors = [], warnings = [];
  const fail = (path, message) => errors.push(`${path}: ${message}`);
  const object = (value, path) => record(value) || (fail(path, 'must be an object'), false);
  const text = (value, path, max) => nonempty(value, max) || (fail(path, 'must be a nonempty bounded string'), false);
  const keys = (value, allowed, path) => {
    for (const key of allowed) if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, 'required');
    for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${path}.${key}`, 'unexpected field');
  };
  const strings = (value, path, min = 0, max = 100) => {
    if (!Array.isArray(value)) { fail(path, 'must be an array'); return false; }
    if (value.length < min || value.length > max) fail(path, `must have ${min}..${max} entries`);
    value.forEach((entry, i) => text(entry, `${path}[${i}]`, 500));
    if (new Set(value).size !== value.length) fail(path, 'duplicates are not allowed');
    return true;
  };
  const finish = () => ({ ok: errors.length === 0, errors, warnings, mode: 'schema-v2' });
  if (!object(data, 'payload')) return finish();
  if (data.schemaVersion !== 2) fail('schemaVersion', 'must be 2 for a new publication');
  if (!['US', 'CN'].includes(data.edition)) fail('edition', 'must be US or CN');
  if (edition !== undefined && data.edition !== edition) fail('edition', 'does not match the expected filename edition');
  const timestamp = typeof data.generatedAt === 'string' ? Date.parse(data.generatedAt) : NaN;
  if (!Number.isFinite(timestamp) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(data.generatedAt)
      || new Date(timestamp).toISOString().slice(0, 19) !== data.generatedAt.slice(0, 19)) fail('generatedAt', 'must be a real ISO UTC timestamp');
  else if (timestamp < Date.UTC(2020, 0, 1) || timestamp > Number(now) + 300_000) fail('generatedAt', 'outside supported range or more than five minutes in the future');
  text(data.dateLabel, 'dateLabel', 200);

  if (object(data.health, 'health')) {
    if (!['OK', 'DEGRADED', 'OUTAGE'].includes(data.health.status)) fail('health.status', 'must be OK, DEGRADED or OUTAGE');
    strings(data.health.missing, 'health.missing');
    if (!Array.isArray(data.health.suspect)) fail('health.suspect', 'must be an array');
    else data.health.suspect.forEach((flag, i) => {
      if (!object(flag, `health.suspect[${i}]`)) return;
      text(flag.field, `health.suspect[${i}].field`, 100);
      if (!policy.isUsableFact(flag.value, flag.field)) fail(`health.suspect[${i}].value`, 'must be finite');
      if (typeof flag.bound !== 'number' || !Number.isFinite(flag.bound) || flag.bound < 0) fail(`health.suspect[${i}].bound`, 'must be finite and nonnegative');
    });
    if (data.health.suspect?.length) warnings.push('Source quality flags are present; review the underlying values.');
  }

  const facts = Object.create(null);
  if (object(data.facts, 'facts')) {
    for (const [key, value] of Object.entries(data.facts)) {
      if (!validKey(key) || HEADLINE.test(key)) fail(`facts.${key}`, 'invalid fact key');
      else if (!policy.isUsableFact(value, key)) fail(`facts.${key}`, 'must be an available finite primitive value');
      else facts[key] = value;
    }
    if (!Object.keys(facts).length) fail('facts', 'must contain available facts');
  }
  if (object(data.dashboard, 'dashboard')) {
    for (const [key, card] of Object.entries(data.dashboard)) {
      if (!object(card, `dashboard.${key}`)) continue;
      text(card.title, `dashboard.${key}.title`, 200);
      for (const name of ['status', 'emoji']) {
        if (typeof card[name] !== 'string' || card[name].length > 200) fail(`dashboard.${key}.${name}`, 'must be a bounded string');
      }
      if (!Object.hasOwn(facts, key) || facts[key] !== card.value) fail(`dashboard.${key}.value`, 'must equal its available published fact');
    }
  }
  for (const name of ['screener', 'economic']) {
    if (!Array.isArray(data[name])) { fail(name, 'must be an array'); continue; }
    if (name === 'screener' && data[name].length === 0) fail(name, 'new publication must contain an available market row');
    data[name].forEach((row, i) => {
      const path = `${name}[${i}]`;
      if (!object(row, path)) return;
      text(row.label, `${path}.label`, 200);
      if (!validKey(row.factKey) || !Object.hasOwn(facts, row.factKey)) fail(`${path}.factKey`, 'must resolve to an available fact');
      if (!policy.isUsableFact(row.value, row.factKey)) fail(`${path}.value`, 'must be available and finite');
      const value = name === 'screener' ? row.change : row.value;
      if (!Object.hasOwn(facts, row.factKey) || facts[row.factKey] !== value) fail(path, 'displayed value must agree with facts');
      if (name === 'screener') {
        const valueKey = typeof row.factKey === 'string' && row.factKey.endsWith('Change') ? row.factKey.slice(0, -6) : null;
        if (!valueKey || !Object.hasOwn(facts, valueKey) || facts[valueKey] !== row.value) fail(`${path}.value`, 'market level must equal its available base fact');
      }
      if (row.period !== undefined && (typeof row.period !== 'string' || row.period.length > 100)) fail(`${path}.period`, 'must be a bounded string');
    });
  }

  // Construct a sparse index from explicit stable keys, never from filtered array order.
  const headlines = [], seen = new Set();
  if (!Array.isArray(data.news)) fail('news', 'must be an array');
  else {
    if (data.news.length > 100) fail('news', 'at most 100 entries are supported');
    data.news.forEach((item, i) => {
      const path = `news[${i}]`;
      if (!object(item, path)) return;
      const titleValid = text(item.title, `${path}.title`, 2000);
      const urlValid = item.url === null || httpUrl(item.url);
      if (!urlValid) fail(`${path}.url`, 'must be null or an HTTP(S) URL without credentials');
      const match = typeof item.factKey === 'string' && HEADLINE.exec(item.factKey);
      const index = match ? Number(match[1]) - 1 : NaN;
      if (!Number.isSafeInteger(index) || index < 0 || index >= 100) fail(`${path}.factKey`, 'must be a stable headline_1..headline_100 key');
      else if (seen.has(item.factKey)) fail(`${path}.factKey`, 'duplicate key');
      else { seen.add(item.factKey); if (titleValid && urlValid) headlines[index] = item.title; }
    });
  }
  strings(data.sources, 'sources', 1);

  const hasVerification = object(data.verification, 'verification');
  if (hasVerification) {
    const v = data.verification;
    keys(v, ['version', 'status', 'checkedClaims', 'reasonCodes'], 'verification');
    if (v.version !== 1) fail('verification.version', 'must be 1');
    if (!['approved', 'withheld'].includes(v.status)) fail('verification.status', 'must be approved or withheld');
    if (!Number.isInteger(v.checkedClaims) || v.checkedClaims < 0 || v.checkedClaims > 6) fail('verification.checkedClaims', 'must be an integer in 0..6');
    if (strings(v.reasonCodes, 'verification.reasonCodes')) v.reasonCodes.forEach((code, i) => {
      if (typeof code !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(code)) fail(`verification.reasonCodes[${i}]`, 'must be an uppercase code');
    });
  }
  if (object(data.analysis, 'analysis')) {
    const a = data.analysis, v = hasVerification ? data.verification : {};
    keys(a, ['sentiment', 'confidence', 'claims', 'interpretation', 'wisdom'], 'analysis');
    if (v.status === 'withheld') {
      if (a.sentiment !== 'Unavailable' || a.confidence !== '' || a.interpretation !== '' || a.wisdom !== ''
          || !Array.isArray(a.claims) || a.claims.length) fail('analysis', 'withheld analysis must be the empty Unavailable sentinel');
      if (v.checkedClaims !== 0 || !Array.isArray(v.reasonCodes) || !v.reasonCodes.length) fail('verification', 'withheld requires zero checked claims and a reason');
    } else if (v.status === 'approved') {
      if (!Array.isArray(v.reasonCodes) || v.reasonCodes.length) fail('verification.reasonCodes', 'approved requires no rejection reasons');
      if (!Array.isArray(a.claims)) fail('analysis.claims', 'must be an array');
      else {
        if (v.checkedClaims !== a.claims.length) fail('verification.checkedClaims', 'must equal the entire published claim count');
        const claims = a.claims.map((claim, i) => {
          if (!object(claim, `analysis.claims[${i}]`)) return claim;
          keys(claim, ['text', 'basedOn', 'direction'], `analysis.claims[${i}]`);
          return { claim: claim.text, basedOn: claim.basedOn, direction: claim.direction };
        });
        const checked = policy.validateAnalysis({ sentiment: a.sentiment, confidence: a.confidence, claims,
          interpretation: a.interpretation, wisdom: a.wisdom }, { facts, headlines });
        for (const reason of checked.reasonCodes) fail('analysis', reason);
        for (const claim of claims) if (record(claim) && Array.isArray(claim.basedOn)) {
          if (claim.basedOn.some(key => !validKey(key))) fail('analysis.claims.basedOn', 'invalid citation key');
        }
      }
      if (data.health?.status === 'OUTAGE') fail('verification', 'an outage cannot approve analysis');
    }
  }

  // Historical ledger fields are typed but not reclassified by this publication gate.
  if (data.watchlist !== undefined && typeof data.watchlist !== 'string') fail('watchlist', 'must be a string');
  for (const name of ['analysisModel', 'analysisProvider']) {
    if (data[name] !== undefined && data[name] !== null && !nonempty(data[name], 200)) fail(name, 'must be a bounded string or null');
    if (data.verification?.status === 'withheld' && data[name] !== undefined && data[name] !== null) fail(name, 'withheld analysis must not credit a model');
  }
  if (data.trackRecord !== undefined && object(data.trackRecord, 'trackRecord')) {
    if (typeof data.trackRecord.accuracy !== 'string' || typeof data.trackRecord.last !== 'string') fail('trackRecord', 'accuracy and last must be strings');
    // Optional since W4: the base rate on the same judged days, as plain text.
    if (data.trackRecord.baseline !== undefined && (typeof data.trackRecord.baseline !== 'string' || data.trackRecord.baseline.length > 200)) {
      fail('trackRecord.baseline', 'must be a string of at most 200 characters');
    }
    // Optional since W25: the record's phase, and the call date the shown record starts from.
    if (data.trackRecord.phase !== undefined && data.trackRecord.phase !== 'beta') fail('trackRecord.phase', 'must be "beta" when present');
    if (data.trackRecord.since !== undefined && !(data.trackRecord.since === '' || isoDate(data.trackRecord.since))) {
      fail('trackRecord.since', 'must be an empty string or an ISO date');
    }
  }
  if (data.history !== undefined) {
    if (!Array.isArray(data.history)) fail('history', 'must be an array');
    else data.history.forEach((entry, i) => {
      if (!object(entry, `history[${i}]`)) return;
      if (typeof entry.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) fail(`history[${i}].date`, 'must be a date');
      if (typeof entry.sentiment !== 'string' && entry.sentiment !== null) fail(`history[${i}].sentiment`, 'must be a string or null');
      if (!['hit', 'miss', 'flat', null].includes(entry.result)) fail(`history[${i}].result`, 'must be hit, miss, flat or null');
      if (entry.actualChange !== null && !policy.isUsableFact(entry.actualChange)) fail(`history[${i}].actualChange`, 'must be finite or null');
    });
  }
  // Optional since the long-term reading (rules ltr.v1). Code-computed; checked for shape,
  // for bounded text, and for agreement with the published facts it quotes.
  if (data.asOf !== undefined && object(data.asOf, 'asOf')) {
    keys(data.asOf, ['label', 'session', 'closed', 'intraday'], 'asOf');
    text(data.asOf.label, 'asOf.label', 200);
    if (data.asOf.session !== null && !(typeof data.asOf.session === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.asOf.session))) fail('asOf.session', 'must be a date or null');
    for (const name of ['closed', 'intraday']) if (typeof data.asOf[name] !== 'boolean') fail(`asOf.${name}`, 'must be a boolean');
  }
  if (data.longTermReading !== undefined && data.longTermReading !== null && object(data.longTermReading, 'longTermReading')) {
    const r = data.longTermReading, path = 'longTermReading';
    const LABELS = ['Cheap', 'Fair', 'Slightly expensive', 'Expensive', 'Very expensive'];
    const expectedVersion = data.edition === 'US' ? 'ltr.v1' : data.edition === 'CN' ? 'ltr.cn.v1' : null;
    if (!expectedVersion) fail(path, 'is published for the US and China editions only');
    else if (r.version !== expectedVersion) fail(`${path}.version`, `must be ${expectedVersion}`);
    if (!['first', 'steady', 'pending', 'changed', 'held', 'unavailable'].includes(r.status)) fail(`${path}.status`, 'unknown status');
    if (!['ok', 'disagree', 'unavailable'].includes(r.today)) fail(`${path}.today`, 'unknown value');
    const level = v => Number.isInteger(v) && v >= 1 && v <= 5;
    if (r.valuation !== null) {
      if (!object(r.valuation, `${path}.valuation`)) {/* reported */}
      else {
        if (!level(r.valuation.lo) || !level(r.valuation.hi) || r.valuation.lo > r.valuation.hi || r.valuation.hi - r.valuation.lo > 1) fail(`${path}.valuation`, 'levels must be 1..5 and at most one apart');
        text(r.valuation.label, `${path}.valuation.label`, 100);
      }
      if (!['Wide', 'Moderate', 'Narrow', 'Thin'].includes(r.marginOfSafety)) fail(`${path}.marginOfSafety`, 'unknown value');
      if (typeof r.since !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.since)) fail(`${path}.since`, 'must be a date');
    } else if (r.marginOfSafety !== null) fail(`${path}.marginOfSafety`, 'must be null without a valuation');
    if (object(r.measures, `${path}.measures`)) {
      for (const key of data.edition === 'CN' ? ['csi300PE'] : ['buffettIndicator', 'shillerPE']) {
        const m = r.measures[key];
        if (m === null || m === undefined) continue;
        if (!object(m, `${path}.measures.${key}`)) continue;
        if (!Object.hasOwn(facts, key) || facts[key] !== m.value) fail(`${path}.measures.${key}.value`, 'must equal its available published fact');
        if (!level(m.level) || m.levelLabel !== LABELS[m.level - 1]) fail(`${path}.measures.${key}.level`, 'must be a level 1..5 with its label');
      }
    }
    if (r.stocksVsBonds !== null && object(r.stocksVsBonds, `${path}.stocksVsBonds`)) {
      // The US gap is real (against the 10-year yield less CPI); the China gap is nominal (against the 10-year government yield).
      const nominal = r.stocksVsBonds.basis === 'nominal';
      if (nominal !== (data.edition === 'CN')) fail(`${path}.stocksVsBonds.basis`, data.edition === 'CN' ? 'must be nominal' : 'must be absent');
      for (const name of ['earningsYield', nominal ? 'bondYield10Y' : 'realYield10Y', 'gap']) if (typeof r.stocksVsBonds[name] !== 'number' || !Number.isFinite(r.stocksVsBonds[name])) fail(`${path}.stocksVsBonds.${name}`, 'must be finite');
      if (!['Bonds pay more', 'Thin', 'Moderate', 'Wide'].includes(r.stocksVsBonds.label)) fail(`${path}.stocksVsBonds.label`, 'unknown value');
    }
    if (r.mood !== null && object(r.mood, `${path}.mood`)) {
      if (!Object.hasOwn(facts, 'fearGreedValue') || Number(facts.fearGreedValue) !== r.mood.score) fail(`${path}.mood.score`, 'must agree with its available fact');
      text(r.mood.label, `${path}.mood.label`, 50);
    }
    if (!Array.isArray(r.changes) || r.changes.length > 6) fail(`${path}.changes`, 'must be an array of at most six entries');
    else r.changes.forEach((c, i) => { if (!object(c, `${path}.changes[${i}]`) || !['valuation', 'rates', 'bonds', 'mood'].includes(c.kind)) fail(`${path}.changes[${i}].kind`, 'unknown kind'); });
  }
  if (data.fearGreed !== undefined && data.fearGreed !== null && object(data.fearGreed, 'fearGreed')) {
    if (typeof data.fearGreed.score !== 'number' || !Number.isFinite(data.fearGreed.score) || data.fearGreed.score < 0 || data.fearGreed.score > 100) fail('fearGreed.score', 'must be a number in 0..100');
    if (!Object.hasOwn(facts, 'fearGreedValue') || Number(facts.fearGreedValue) !== data.fearGreed.score) fail('fearGreed.score', 'must agree with its available fact');
    text(data.fearGreed.classification, 'fearGreed.classification', 200);
  }
  return finish();
}
export const validateDashboardPayload = validateDashboardData;

export function validateDashboardFile(raw, filename, { allowHistorical = false, now } = {}) {
  const basename = filename.replaceAll('\\', '/').split('/').at(-1);
  const expected = HISTORICAL_SNAPSHOTS[basename];
  if (!expected) return { ok: false, errors: ['filename must be latest-us.json or latest-cn.json'], warnings: [], mode: 'rejected' };
  let data;
  try { data = JSON.parse(raw.toString()); }
  catch { return { ok: false, errors: ['invalid JSON'], warnings: [], mode: 'rejected' }; }
  if (allowHistorical && record(data) && data.schemaVersion === undefined && data.edition === expected.edition
      && expected.sha256.includes(createHash('sha256').update(raw).digest('hex'))) {
    return { ok: true, errors: [], warnings: ['Exact reviewed historical snapshot: archived/unverified; no schema-v2 approval is claimed.'], mode: 'historical' };
  }
  return validateDashboardData(data, { edition: expected.edition, now });
}

function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--allow-historical')) {
    console.error('Usage: node .github/scripts/validate-dashboard-data.mjs [--allow-historical]'); return 1;
  }
  let failures = 0;
  for (const file of FILES) {
    let result;
    try { result = validateDashboardFile(readFileSync(file), file, { allowHistorical: args.includes('--allow-historical') }); }
    catch { result = { ok: false, errors: ['required dashboard file missing, unreadable or invalid'], warnings: [] }; }
    for (const warning of result.warnings) console.warn(`${file}: ${warning}`);
    for (const error of result.errors) console.error(`${file}: ${error}`);
    if (!result.ok) failures++;
    else if (result.mode === 'schema-v2') console.log(`${file}: schema-v2 publication contract accepted.`);
  }
  return failures ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main();
