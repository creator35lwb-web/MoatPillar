import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {assemble, buildCalendar, eventsFromFred, eventsFromNbs, fomcEvents, validateCalendar} from '../scripts/build-calendar.mjs';

const config = JSON.parse(readFileSync('scripts/calendar-sources.json', 'utf8'));
// The hand-sourced calendar as committed with PR #129. The tests never read docs/data/calendar.json: the
// workflow rewrites that file before running them, and the first keyed run (2026-10-15) failed on exactly that.
const existing = JSON.parse(readFileSync('tests/fixtures/calendar/calendar-hand-sourced.json', 'utf8'));
const fredFixture = JSON.parse(readFileSync('tests/fixtures/calendar/fred-releases-dates.json', 'utf8'));
const nbsFixture = readFileSync('tests/fixtures/calendar/nbs-calendar-2026.html', 'utf8');
const TODAY = '2026-10-14';
const fredConfig = {...config.fred, horizonDays: config.horizonDays};

test('FRED release dates become dated US events with reference months, quarters and estimates', () => {
  const events = eventsFromFred(fredFixture, fredConfig, TODAY);
  assert.deepEqual(events.map(e => e.id), ['us-gdp-2026-q3-advance', 'us-empsit-2026-10', 'us-cpi-2026-10', 'us-ppi-2026-10', 'us-gdp-2026-q3-second', 'us-cpi-2026-12']);
  assert.deepEqual(events.map(e => e.name), ['GDP, third quarter, advance estimate', 'Employment Situation, October', 'Consumer Price Index, October',
    'Producer Price Index, October', 'GDP, third quarter, second estimate', 'Consumer Price Index, December']);
  assert.equal(events[0].utc, '2026-10-29T12:30:00Z', 'Eastern daylight time before the clock change');
  assert.equal(events[2].utc, '2026-11-10T13:30:00Z', 'Eastern standard time after it');
  assert.ok(events.every(e => e.region === 'US' && e.kind === 'release' && e.source === 'fred-releases' && e.time === '08:30'));
  assert.deepEqual(eventsFromFred({release_dates: 'nope'}, fredConfig, TODAY), []);
});

test('the NBS calendar table becomes dated China events, with PPI folded into the CPI morning', () => {
  const {events, warnings} = eventsFromNbs(nbsFixture, config.nbs);
  // The February PMI moves to March 4 for the Spring Festival, so March's cell holds two dates; it is reported, never guessed.
  assert.deepEqual(warnings, ['Monthly Report on Purchasing Managers’ Index (PMI): unreadable cell "4/Wed Note5 31/Tue"']);
  const byId = Object.fromEntries(events.map(e => [e.id, e]));
  assert.deepEqual(byId['cn-cpi-ppi-2026-09'], {id: 'cn-cpi-ppi-2026-09', region: 'CN', kind: 'release', name: 'CPI and PPI, September', date: '2026-10-14', weekday: 'Wed', time: '09:30', zone: 'Asia/Shanghai', utc: '2026-10-14T01:30:00Z', source: 'nbs-calendar'});
  assert.equal(byId['cn-gdp-2026-q3'].date, '2026-10-19'); assert.equal(byId['cn-gdp-2026-q3'].time, '10:00'); assert.equal(byId['cn-gdp-2026-q3'].name, 'Q3 GDP and September activity data');
  assert.equal(byId['cn-gdp-2025-q4'].date, '2026-01-19'); assert.equal(byId['cn-gdp-2025-q4'].name, 'Q4 GDP and December activity data');
  assert.equal(byId['cn-activity-2026-10'].date, '2026-11-16'); assert.equal(byId['cn-activity-2026-10'].name, 'October activity data: output, investment, property, retail sales');
  assert.equal(byId['cn-pmi-2026-10'].date, '2026-10-31'); assert.equal(byId['cn-pmi-2026-10'].weekday, 'Sat');
  assert.ok(!events.some(e => e.id.startsWith('cn-ppi-')), 'PPI never stands alone when CPI is released the same morning');
  assert.ok(events.every(e => e.weekday && e.utc && e.source === 'nbs-calendar'));
  assert.deepEqual(eventsFromNbs('<html><body>nothing</body></html>', config.nbs), {events: [], warnings: []});
});

test('the FOMC list becomes all-day meetings with the publisher\'s own dates', () => {
  const meetings = fomcEvents(config.fomc);
  assert.equal(meetings[0].id, 'us-fomc-2026-10'); assert.equal(meetings[0].name, 'FOMC meeting'); assert.equal(meetings[0].allDay, true);
  assert.equal(meetings[1].name, 'FOMC meeting, with economic projections');
  assert.ok(meetings.every(m => m.time === undefined && m.utc === undefined && m.endDate >= m.date));
});

test('assembly replaces a group that was read and keeps a group that was not, then validates', () => {
  const nbs = eventsFromNbs(nbsFixture, config.nbs).events;
  const doc = assemble({existing, fred: null, nbs, fomc: fomcEvents(config.fomc), today: TODAY, config, now: new Date('2026-10-14T12:00:00Z')});
  assert.equal(validateCalendar(doc), true);
  const ids = doc.events.map(e => e.id);
  assert.ok(ids.includes('us-cpi-2026-09'), 'the hand-sourced US entries stay when FRED is not read');
  assert.ok(ids.includes('cn-cpi-ppi-2026-09') && ids.includes('cn-gdp-2026-q3') && ids.includes('us-fomc-2026-10'));
  assert.ok(!ids.includes('cn-gdp-2025-q4'), 'past entries beyond a week fall out of the window');
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(doc.generatedAt, '2026-10-14T12:00:00Z');
  assert.ok(doc.sources['nbs-calendar'] && doc.sources['fed-fomc'] && doc.sources['bls-cpi']);
  const withFred = assemble({existing, fred: eventsFromFred(fredFixture, fredConfig, TODAY), nbs, fomc: fomcEvents(config.fomc), today: TODAY, config});
  assert.equal(validateCalendar(withFred), true);
  assert.ok(withFred.events.some(e => e.source === 'fred-releases') && !withFred.events.some(e => e.source === 'bls-cpi'), 'fresh FRED entries replace the hand-sourced US entries');
  assert.equal(withFred.sources['bls-cpi'], undefined);
});

test('the builder keeps the key out of its messages and tolerates every failure', async () => {
  const KEY = 'secret-key-value-1234567890';
  const seen = [], log = [];
  // FRED answers one release at a time: first the release itself (its name), then its dates by release_id, without release_name.
  const FRED_NAMES = {10: 'Consumer Price Index', 46: 'Producer Price Index', 50: 'Employment Situation', 53: 'Gross Domestic Product'};
  const fredAnswer = url => {
    const id = Number(new URL(url).searchParams.get('release_id'));
    if (url.includes('/fred/release?')) return {releases: [{id, name: FRED_NAMES[id]}]};
    return {release_dates: fredFixture.release_dates.filter(r => r.release_id === id).map(({release_name, ...r}) => r)};
  };
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url.includes('stlouisfed.org')) return {ok: true, status: 200, text: async () => JSON.stringify(fredAnswer(url))};
    return {ok: false, status: 503, text: async () => ''};
  };
  const doc = await buildCalendar({config, existing, today: TODAY, log: line => log.push(line), fetchImpl, key: KEY, now: new Date('2026-10-14T12:00:00Z')});
  const aboutRequests = seen.filter(url => url.includes('api.stlouisfed.org/fred/release?'));
  const fredRequests = seen.filter(url => url.includes('api.stlouisfed.org/fred/release/dates?'));
  assert.equal(aboutRequests.length, 4, 'each release is named before its dates are trusted');
  assert.equal(fredRequests.length, 4, 'one dates request per configured release');
  assert.deepEqual(fredRequests.map(url => new URL(url).searchParams.get('release_id')).sort(), ['10', '46', '50', '53']);
  assert.ok([...aboutRequests, ...fredRequests].every(url => url.includes('api_key=' + KEY)), 'every request carries the key');
  assert.ok(fredRequests.every(url => url.includes('realtime_start=2026-10-07') && url.includes('realtime_end=2027-03-13')), 'from a week back to the horizon');
  assert.ok(log.every(line => !line.includes(KEY)), 'no message carries the key');
  assert.ok(log.some(line => line === 'FRED: 7 release dates from 4 releases; 6 mapped to events') && log.some(line => line.startsWith('NBS: request failed')), log.join(' | '));
  assert.deepEqual(doc.events.filter(e => e.source === 'fred-releases').map(e => e.id),
    ['us-gdp-2026-q3-advance', 'us-empsit-2026-10', 'us-cpi-2026-10', 'us-ppi-2026-10', 'us-gdp-2026-q3-second', 'us-cpi-2026-12']);
  assert.ok(doc.events.some(e => e.source === 'fred-releases') && doc.events.some(e => e.source === 'nbs-calendar'), 'FRED read, NBS kept from the file');
  const failing = async () => { throw new Error('ENETUNREACH to https://api.stlouisfed.org/?api_key=' + KEY); };
  const kept = await buildCalendar({config, existing, today: TODAY, log: line => log.push(line), fetchImpl: failing, key: KEY});
  assert.ok(log.every(line => !line.includes(KEY)));
  assert.deepEqual(kept.events.map(e => e.id).filter(id => id.startsWith('us-cpi')), existing.events.map(e => e.id).filter(id => id.startsWith('us-cpi')));
  const noKey = await buildCalendar({config, existing, today: TODAY, log: line => log.push(line), fetchImpl: failing, key: ''});
  assert.ok(log.some(line => line.startsWith('FRED: no key')) && noKey.events.length > 0);
  // One release failing keeps every hand-sourced US entry: a partial answer never replaces the group.
  const oneDown = async (url) => {
    if (url.includes('release_id=46')) return {ok: false, status: 500, text: async () => ''};
    return fetchImpl(url);
  };
  const partialLog = [];
  const partial = await buildCalendar({config, existing, today: TODAY, log: line => partialLog.push(line), fetchImpl: oneDown, key: KEY});
  assert.ok(partialLog.some(line => line.startsWith('FRED: request failed (HTTP 500)')), partialLog.join(' | '));
  assert.ok(!partial.events.some(e => e.source === 'fred-releases'));
  assert.deepEqual(partial.events.filter(e => e.region === 'US').map(e => e.id), existing.events.filter(e => e.region === 'US').map(e => e.id));
  // An id that names a different release is refused, and the group is kept.
  const misnamed = async (url) => {
    if (url.includes('/fred/release?release_id=50')) return {ok: true, status: 200, text: async () => JSON.stringify({releases: [{id: 50, name: 'Some Other Release'}]})};
    return fetchImpl(url);
  };
  const misnamedLog = [];
  const refused = await buildCalendar({config, existing, today: TODAY, log: line => misnamedLog.push(line), fetchImpl: misnamed, key: KEY});
  assert.ok(misnamedLog.some(line => line.startsWith('FRED: request failed (release 50 is "Some Other Release", not "Employment Situation")')), misnamedLog.join(' | '));
  assert.ok(!refused.events.some(e => e.source === 'fred-releases'));
});

test('a malformed document is refused', () => {
  const doc = assemble({existing, fred: null, nbs: null, fomc: fomcEvents(config.fomc), today: TODAY, config});
  const broken = structuredClone(doc); broken.events[0].utc = '2000-01-01T00:00:00Z';
  assert.throws(() => validateCalendar(broken), /time or utc/);
  const twice = structuredClone(doc); twice.events.push({...twice.events[twice.events.length - 1]});
  assert.throws(() => validateCalendar(twice), /duplicate id/);
});
