// Rebuilds docs/data/calendar.json from the official release calendars (W31 step 6):
//   - FRED's release dates (the BLS and BEA schedules), through the keyed API, for the US releases;
//   - the NBS press release calendar page, a plain HTML table, for China;
//   - the Federal Reserve's FOMC dates, copied by hand into scripts/calendar-sources.json.
// A source that cannot be read keeps its existing entries: nothing is invented and nothing is dropped
// for a transient failure. The FRED key comes from the environment and is never printed.
//
//   node scripts/build-calendar.mjs            dry run: prints what would change
//   node scripts/build-calendar.mjs --write    writes docs/data/calendar.json
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {localToUtc} from '../docs/dashboard-state.mjs';

const ROOT = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, ROOT), 'utf8');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const QUARTERS = ['first', 'second', 'third', 'fourth'];
const pad = n => String(n).padStart(2, '0');
const isoDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
const weekdayOf = iso => WEEKDAYS[new Date(iso + 'T12:00:00Z').getUTCDay()];
const shiftDays = (iso, days) => new Date(Date.parse(iso + 'T12:00:00Z') + days * 86400000).toISOString().slice(0, 10);
const utcOf = (date, time, zone) => localToUtc(date, time, zone).toISOString().replace('.000Z', 'Z');
const previousMonth = (y, m) => (m === 1 ? {year: y - 1, month: 12} : {year: y, month: m - 1});
// Every message that could carry a request keeps the key out of it.
const safeMessage = error => String(error?.message || error).replaceAll(/api_key=[^&\s]*/g, 'api_key=…').slice(0, 120);

// Tags are removed by one scan, so a hostile page cannot slow the run.
export function stripTags(html) {
  let out = '', inTag = false;
  for (const ch of String(html)) {
    if (ch === '<') { inTag = true; out += ' '; }
    else if (ch === '>') inTag = false;
    else if (!inTag) out += ch;
  }
  return out.split(/\s+/).join(' ').trim();
}

// ---- FRED: {"release_dates":[{"release_id":10,"release_name":"Consumer Price Index","date":"2026-11-10"}]} ----
export function eventsFromFred(json, config, today) {
  const dates = Array.isArray(json?.release_dates) ? json.release_dates : [];
  const out = new Map();
  for (const entry of dates) {
    const rule = config.releases[entry?.release_name];
    if (!rule || !isoDate(entry.date) || entry.date < today) continue;
    const [y, m] = entry.date.split('-').map(Number);
    let id, name;
    if (rule.kind === 'monthly') {
      const ref = previousMonth(y, m);
      id = `us-${rule.slug}-${ref.year}-${pad(ref.month)}`;
      name = `${rule.name}, ${MONTHS[ref.month - 1]}`;
    } else {
      // GDP: the quarter before the release month; advance, second and third estimates by the month within the quarter.
      const index = Math.floor((m - 1) / 3);
      const quarter = index === 0 ? 4 : index, year = index === 0 ? y - 1 : y;
      const estimate = ['advance', 'second', 'third'][(m - 1) % 3];
      id = `us-gdp-${year}-q${quarter}-${estimate}`;
      name = `GDP, ${QUARTERS[quarter - 1]} quarter, ${estimate} estimate`;
    }
    if (out.has(id)) continue;
    out.set(id, {id, region: 'US', kind: 'release', name, date: entry.date, time: config.time, zone: config.zone,
      utc: utcOf(entry.date, config.time, config.zone), source: config.source.id});
  }
  return [...out.values()];
}

// ---- NBS: one table, a row of dates per indicator ("19/Mon", "……" for none) followed by a row of times ----
const CN_ZONE = 'Asia/Shanghai';
const cnEvent = (id, name, date, weekday, time, source, extra = {}) =>
  ({id, region: 'CN', kind: 'release', name, date, weekday, time, zone: CN_ZONE, utc: utcOf(date, time, CN_ZONE), source, ...extra});
const NBS_RULES = [
  {test: /^National Economic Performance$/, event: (y, m, date, weekday, time, source) => {
    const ref = previousMonth(y, m);
    const quarter = {1: 4, 4: 1, 7: 2, 10: 3}[m];
    if (quarter) return cnEvent(`cn-gdp-${ref.year}-q${quarter}`, `Q${quarter} GDP and ${MONTHS[ref.month - 1]} activity data`, date, weekday, time, source);
    return cnEvent(`cn-activity-${ref.year}-${pad(ref.month)}`, `${MONTHS[ref.month - 1]} activity data: output, investment, property, retail sales`, date, weekday, time, source);
  }},
  {test: /Consumer Price Index/, event: (y, m, date, weekday, time, source) => {
    const ref = previousMonth(y, m);
    return cnEvent(`cn-cpi-ppi-${ref.year}-${pad(ref.month)}`, `CPI and PPI, ${MONTHS[ref.month - 1]}`, date, weekday, time, source);
  }},
  {test: /Industrial Producer Price Index/, event: (y, m, date, weekday, time, source) => {
    const ref = previousMonth(y, m);
    return cnEvent(`cn-ppi-${ref.year}-${pad(ref.month)}`, `PPI, ${MONTHS[ref.month - 1]}`, date, weekday, time, source, {mergeInto: `cn-cpi-ppi-${ref.year}-${pad(ref.month)}`});
  }},
  {test: /Purchasing Managers/, event: (y, m, date, weekday, time, source) =>
    cnEvent(`cn-pmi-${y}-${pad(m)}`, `Purchasing Managers’ Index, ${MONTHS[m - 1]}`, date, weekday, time, source)},
];
export function eventsFromNbs(html, config) {
  const rows = String(html).split('</tr>').map(row => row.split(/<\/t[dh]>/).slice(0, -1).map(stripTags));
  const events = [], warnings = [];
  rows.forEach((cells, i) => {
    if (cells.length < 14) return;
    const rule = NBS_RULES.find(r => r.test.test(cells[1]));
    if (!rule) return;
    const times = (rows[i + 1] || []).filter(cell => /^\d{1,2}:\d{2}$/.test(cell));
    let t = 0;
    cells.slice(2, 14).forEach((cell, index) => {
      if (cell === '……' || cell === '') return;
      const m = /^(\d{1,2})\/(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/.exec(cell);
      const time = times[t++];
      if (!m) { warnings.push(`${cells[1]}: unreadable cell "${cell}"`); return; }
      const month = index + 1, date = `${config.year}-${pad(month)}-${pad(Number(m[1]))}`;
      if (weekdayOf(date) !== m[2]) { warnings.push(`${cells[1]}: ${cell} is not a ${m[2]} in ${config.year}`); return; }
      if (!/^\d{1,2}:\d{2}$/.test(time || '')) { warnings.push(`${cells[1]}: no time for ${cell}`); return; }
      events.push(rule.event(config.year, month, date, m[2], time.length === 4 ? '0' + time : time, config.source.id));
    });
  });
  // PPI shares the CPI release on the same morning; it stands alone only when it does not.
  const byId = new Map(events.map(e => [e.id, e]));
  const merged = events.filter(e => !(e.mergeInto && byId.get(e.mergeInto)?.date === e.date)).map(({mergeInto, ...e}) => e);
  return {events: merged, warnings};
}

// ---- FOMC: the meeting days as published, all-day, with the publisher's own dates ----
export function fomcEvents(config) {
  return (config.meetings || []).filter(m => isoDate(m.date) && isoDate(m.endDate)).map(m => ({
    id: `us-fomc-${m.date.slice(0, 7)}`, region: 'US', kind: 'meeting',
    name: m.projections ? 'FOMC meeting, with economic projections' : 'FOMC meeting',
    date: m.date, endDate: m.endDate, allDay: true, zone: 'America/New_York', source: config.source.id,
  }));
}

// ---- Assembly: fresh events replace a group; a group that could not be read keeps its existing entries ----
const GROUPS = {
  us: new Set(['fred-releases', 'fred-calendar', 'bls-cpi', 'bls-ppi', 'bls-empsit', 'bea-schedule']),
  nbs: new Set(['nbs-calendar']),
  fomc: new Set(['fed-fomc']),
};
const startOf = e => e.allDay ? localToUtc(e.date, '00:00', e.zone).toISOString() : (e.utc || utcOf(e.date, e.time, e.zone));
export function assemble({existing, fred, nbs, fomc, today, config, now = new Date()}) {
  const previous = Array.isArray(existing?.events) ? existing.events : [];
  const fresh = {us: fred, nbs, fomc};
  const events = [];
  for (const [group, ids] of Object.entries(GROUPS)) events.push(...(fresh[group] ?? previous.filter(e => ids.has(e.source))));
  events.push(...previous.filter(e => !Object.values(GROUPS).some(ids => ids.has(e.source))));
  const floor = shiftDays(today, -7), horizon = shiftDays(today, config.horizonDays);
  const unique = new Map();
  for (const e of events) if (e.date >= floor && e.date <= horizon && !unique.has(e.id)) unique.set(e.id, e);
  const sorted = [...unique.values()].sort((a, b) => startOf(a).localeCompare(startOf(b)));
  const sources = {...(existing?.sources || {})};
  for (const [group, cfg] of [['us', config.fred], ['nbs', config.nbs], ['fomc', config.fomc]]) {
    if (fresh[group]) sources[cfg.source.id] = {name: cfg.source.name, url: cfg.source.url, retrievedAt: cfg.source.retrievedAt || today};
  }
  const used = new Set(sorted.map(e => e.source));
  for (const id of Object.keys(sources)) if (!used.has(id)) delete sources[id];
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    note: 'Rebuilt by scripts/build-calendar.mjs from the official calendars listed under sources: FRED’s release dates for the BLS and BEA '
      + 'releases, the NBS press release calendar, and the Federal Reserve’s FOMC dates. date and time are the publisher’s local wall clock; '
      + 'utc is derived. A source that could not be read keeps its earlier entries. Nothing here predicts a figure.',
    sources,
    events: sorted,
  };
}

// ---- The same checks the dashboard test applies to the committed file ----
export function validateCalendar(doc) {
  const problems = [];
  const check = (ok, message) => { if (!ok) problems.push(message); };
  check(doc?.schemaVersion === 1, 'schemaVersion must be 1');
  check(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(doc?.generatedAt || ''), 'generatedAt must be an ISO instant');
  for (const [id, source] of Object.entries(doc?.sources || {})) {
    check(/^[a-z0-9-]+$/.test(id) && typeof source?.name === 'string' && source.name.trim() && /^https:\/\//.test(source.url || ''), `source ${id} is incomplete`);
  }
  const ids = new Set();
  let previous = '';
  for (const e of doc?.events || []) {
    check(!ids.has(e.id), `duplicate id ${e.id}`); ids.add(e.id);
    check(['US', 'CN'].includes(e.region) && ['release', 'meeting'].includes(e.kind) && typeof e.name === 'string' && e.name.trim(), `${e.id}: region, kind or name`);
    check(isoDate(e.date) && ['America/New_York', 'Asia/Shanghai'].includes(e.zone) && doc.sources?.[e.source], `${e.id}: date, zone or source`);
    if (e.weekday) check(weekdayOf(e.date) === e.weekday, `${e.id}: weekday`);
    if (e.allDay) check(e.time === undefined && e.utc === undefined && isoDate(e.endDate) && e.endDate >= e.date, `${e.id}: all-day shape`);
    else check(/^\d{2}:\d{2}$/.test(e.time || '') && e.utc === utcOf(e.date, e.time, e.zone), `${e.id}: time or utc`);
    const start = startOf(e);
    check(start >= previous, `${e.id}: out of order`); previous = start;
  }
  if (problems.length) throw new Error('calendar invalid: ' + problems.join('; '));
  return true;
}

// ---- Fetching, with the key kept out of every message ----
async function fetchText(url, timeoutMs, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {signal: controller.signal, headers: {'User-Agent': 'MoatPillar calendar refresh (+https://github.com/creator35lwb-web/MoatPillar)'}});
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return await response.text();
  } finally { clearTimeout(timer); }
}
export async function fetchFred(config, today, log, {fetchImpl = globalThis.fetch, key = process.env.FRED_API_KEY} = {}) {
  if (!key) { log('FRED: no key in the environment; the existing US entries are kept'); return null; }
  const end = shiftDays(today, config.horizonDays);
  const url = 'https://api.stlouisfed.org/fred/releases/dates?file_type=json&include_release_dates_with_no_data=true'
    + '&realtime_start=' + today + '&realtime_end=' + end + '&sort_order=asc&limit=1000&api_key=' + encodeURIComponent(key);
  try {
    const json = JSON.parse(await fetchText(url, 30000, fetchImpl));
    const events = eventsFromFred(json, config, today);
    const names = new Set((json.release_dates || []).map(r => r.release_name));
    log(`FRED: ${(json.release_dates || []).length} release dates from ${names.size} releases; ${events.length} mapped to events`);
    return events;
  } catch (error) {
    log('FRED: request failed (' + safeMessage(error) + '); the existing US entries are kept');
    return null;
  }
}
export async function fetchNbs(config, log, {fetchImpl = globalThis.fetch} = {}) {
  try {
    const {events, warnings} = eventsFromNbs(await fetchText(config.source.url, 60000, fetchImpl), config);
    for (const warning of warnings) log('NBS: ' + warning);
    if (!events.length) throw new Error('no release rows found');
    log(`NBS: ${events.length} events for ${config.year}`);
    return events;
  } catch (error) {
    log('NBS: request failed (' + safeMessage(error) + '); the existing China entries are kept');
    return null;
  }
}

export async function buildCalendar({config, existing, today, log = () => {}, fetchImpl = globalThis.fetch, key, now} = {}) {
  const sourcesConfig = {...config, fred: {...config.fred, horizonDays: config.horizonDays}};
  const fred = await fetchFred(sourcesConfig.fred, today, log, {fetchImpl, key});
  const nbs = await fetchNbs(config.nbs, log, {fetchImpl});
  const doc = assemble({existing, fred, nbs, fomc: fomcEvents(config.fomc), today, config, now});
  validateCalendar(doc);
  const before = new Set((existing?.events || []).map(e => e.id)), after = new Set(doc.events.map(e => e.id));
  log(`added: ${[...after].filter(id => !before.has(id)).join(', ') || 'none'}`);
  log(`removed: ${[...before].filter(id => !after.has(id)).join(', ') || 'none'}`);
  return doc;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const config = JSON.parse(read('scripts/calendar-sources.json'));
  const existing = JSON.parse(read('docs/data/calendar.json'));
  const today = new Date().toISOString().slice(0, 10);
  const doc = await buildCalendar({config, existing, today, log: line => console.log(line)});
  const changed = JSON.stringify(doc.events) !== JSON.stringify(existing.events) || JSON.stringify(doc.sources) !== JSON.stringify(existing.sources);
  if (!changed) { console.log('calendar unchanged'); return; }
  if (args.has('--write')) {
    writeFileSync(new URL('docs/data/calendar.json', ROOT), JSON.stringify(doc, null, 2) + '\n');
    console.log('docs/data/calendar.json written: ' + doc.events.length + ' events');
  } else console.log('dry run: ' + doc.events.length + ' events would be written (pass --write)');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(safeMessage(error)); process.exitCode = 1; });
}
