import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {calendarPresentation, localToUtc, zoneOffsetMinutes} from '../docs/dashboard-state.mjs';

const calendar = JSON.parse(readFileSync('docs/data/calendar.json', 'utf8'));
const ZONES = ['America/New_York', 'Asia/Shanghai'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_MS = 24 * 60 * 60 * 1000;

test("time-zone arithmetic follows the publishers' clocks, across the US clock change", () => {
  assert.equal(zoneOffsetMinutes('America/New_York', new Date('2026-10-29T12:30:00Z')), -240);
  assert.equal(zoneOffsetMinutes('America/New_York', new Date('2026-11-06T13:30:00Z')), -300);
  assert.equal(zoneOffsetMinutes('Asia/Shanghai', new Date('2026-10-14T01:30:00Z')), 480);
  assert.equal(localToUtc('2026-10-29', '08:30', 'America/New_York').toISOString(), '2026-10-29T12:30:00.000Z');
  assert.equal(localToUtc('2026-11-06', '08:30', 'America/New_York').toISOString(), '2026-11-06T13:30:00.000Z');
  assert.equal(localToUtc('2026-10-19', '10:00', 'Asia/Shanghai').toISOString(), '2026-10-19T02:00:00.000Z');
});

test('the published calendar is well-formed, sourced and internally consistent', () => {
  assert.equal(calendar.schemaVersion, 1);
  assert.match(calendar.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  const generated = Date.parse(calendar.generatedAt);
  for (const [id, source] of Object.entries(calendar.sources)) {
    assert.match(id, /^[a-z0-9-]+$/);
    assert.ok(source.name.trim(), id);
    assert.match(source.url, /^https:\/\//, id);
    assert.match(source.retrievedAt, /^\d{4}-\d{2}-\d{2}$/, id);
  }
  assert.ok(calendar.events.length >= 10);
  const ids = new Set();
  let previous = -Infinity;
  for (const event of calendar.events) {
    assert.ok(!ids.has(event.id), 'duplicate ' + event.id);
    ids.add(event.id);
    assert.ok(['US', 'CN'].includes(event.region), event.id);
    assert.ok(['release', 'meeting'].includes(event.kind), event.id);
    assert.ok(event.name.trim(), event.id);
    assert.match(event.date, /^\d{4}-\d{2}-\d{2}$/, event.id);
    assert.ok(ZONES.includes(event.zone), event.id);
    assert.ok(calendar.sources[event.source], event.id + ' names a listed source');
    if (event.weekday) assert.equal(WEEKDAYS[new Date(event.date + 'T12:00:00Z').getUTCDay()], event.weekday, event.id);
    let start;
    if (event.allDay) {
      assert.equal(event.time, undefined, event.id);
      assert.equal(event.utc, undefined, event.id);
      assert.ok(event.endDate >= event.date, event.id);
      start = localToUtc(event.date, '00:00', event.zone).getTime();
    } else {
      assert.match(event.time, /^\d{2}:\d{2}$/, event.id);
      assert.equal(event.utc, localToUtc(event.date, event.time, event.zone).toISOString().replace('.000Z', 'Z'), event.id);
      start = Date.parse(event.utc);
    }
    assert.ok(start >= previous, 'events are in time order: ' + event.id);
    previous = start;
    assert.ok(start > generated - 30 * DAY_MS && start < generated + 150 * DAY_MS, event.id + ' is inside the maintained window');
  }
});

test('the dashboard lists the next items in Malaysia time and marks what was released', () => {
  const brief = {edition: 'US', generatedAt: '2026-10-14T13:01:05Z'};
  const evening = calendarPresentation(calendar, brief, new Date('2026-10-14T13:30:00Z'), 5);
  assert.equal(evening.items.length, 5);
  assert.deepEqual(evening.items.slice(0, 2).map(item => [item.name, item.region, item.status, item.today, item.when]), [
    ['CPI and PPI, September', 'China', 'done', true, 'Wed 14 Oct · 09:30 MYT'],
    ['Consumer Price Index, September', 'US', 'done', true, 'Wed 14 Oct · 20:30 MYT'],
  ]);
  assert.equal(evening.items[2].name, 'Q3 GDP and September activity data');
  assert.equal(evening.items[2].status, 'upcoming');
  assert.equal(evening.items[2].today, false);
  assert.ok(evening.items.every(item => item.source && /^https:\/\//.test(item.source.url)));
  assert.ok(evening.sourceNames.length >= 3);

  // Two days later the released items have left the list, and the FOMC range reads as the publisher's dates.
  const later = calendarPresentation(calendar, brief, new Date('2026-10-16T00:00:00Z'), 6);
  assert.equal(later.items.length, 6);
  assert.ok(later.items.every(item => item.status === 'upcoming'));
  const fomc = later.items.find(item => item.kind === 'meeting');
  assert.equal(fomc.when, 'Tue 27 – Wed 28 Oct');

  // During the meeting it is in progress; a missing or malformed calendar shows nothing.
  const during = calendarPresentation(calendar, brief, new Date('2026-10-28T15:00:00Z'), 3);
  assert.equal(during.items[0].kind, 'meeting');
  assert.equal(during.items[0].status, 'in-progress');
  assert.equal(during.items[0].today, true);
  assert.deepEqual(calendarPresentation(null, brief).items, []);
  assert.deepEqual(calendarPresentation({events: [{name: 'x', date: 'bad', zone: 'Mars/Olympus'}]}, brief).items, []);
  assert.deepEqual(calendarPresentation({events: 'nope', sources: 3}, brief), {items: [], sourceNames: []});
});

test('the page carries the card, and the headline list says what it is', () => {
  const html = readFileSync('docs/index.html', 'utf8');
  assert.match(html, /<section class="card calendar-section" aria-labelledby="calendar-title" hidden>/);
  assert.match(html, /<symbol id="i-calendar"/);
  assert.match(html, /Headlines fetched for this brief<\/h2>/);
  assert.match(html, /which has not read the articles/);
  const app = readFileSync('docs/app.js', 'utf8');
  assert.match(app, /renderCalendar\(node, data, calendar\)/);
  assert.match(app, /fetch\('data\/calendar\.json', \{cache: 'no-store'\}\)/);
});
