// Publication freshness is independent of source quality and Telegram delivery.
export function expectedPublicationDate(edition, now = new Date()) {
  const day = new Date(now);
  const minutes = day.getUTCHours() * 60 + day.getUTCMinutes();
  const deadline = edition === 'CN' ? 9 * 60 + 30 : 14 * 60;
  if (minutes < deadline) day.setUTCDate(day.getUTCDate() - 1);
  if (edition === 'CN') {
    while (day.getUTCDay() === 0 || day.getUTCDay() === 6) day.setUTCDate(day.getUTCDate() - 1);
  }
  return day.toISOString().slice(0, 10);
}

const own = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);
const text = value => typeof value === 'string' && !!value.trim();
const available = value => typeof value === 'number' ? Number.isFinite(value)
  : text(value) && !/^(?:n\/?a|unknown|unavailable|null|undefined|nan|[+-]?infinity)$/i.test(value.trim());

export function headlineKey(item, index, legacy = false) {
  if (/^headline_[1-9]\d*$/.test(item?.factKey || '')) return item.factKey;
  return legacy ? 'headline_' + (index + 1) : null;
}

export function citationEvidence(data, key) {
  if (typeof key !== 'string') return null;
  const headline = (data.news || []).find((item, index) => headlineKey(item, index, data.schemaVersion === undefined) === key);
  if (headline && text(headline.title)) return {label: 'Headline ' + key.slice(9), value: headline.title};
  if (/^headline_/.test(key)) return null;
  if (!own(data.facts, key) || !available(data.facts[key])) return null;
  const row = [...(data.screener || []), ...(data.economic || [])].find(item => item.factKey === key || item.factKey === key + 'Change');
  // Facts shown in a tile rather than a table row carry their reader-facing name here.
  const TILE_LABELS = {fearGreedValue: 'Fear & Greed score', csi300VsMa200: 'CSI 300 vs 200-day average', maSignal: 'Trend signal', sp500VsMa200: 'S&P 500 vs 200-day average'};
  const label = data.dashboard?.[key]?.title || row?.label
    || TILE_LABELS[key] || key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, char => char.toUpperCase());
  return {label, value: String(data.facts[key])};
}

// Every displayed citation gets a visible target, including unavailable legacy evidence.
export function additionalEvidence(data, claims, visibleKeys = []) {
  const seen = new Set(visibleKeys);
  const rows = [];
  for (const claim of claims) {
    for (const key of Array.isArray(claim.basedOn) ? claim.basedOn : []) {
      if (typeof key !== 'string' || seen.has(key)) continue;
      const evidence = citationEvidence(data, key);
      rows.push({key, ...(evidence || {label: key, value: 'Evidence unavailable in this briefing'}), available: !!evidence});
      seen.add(key);
    }
  }
  return rows;
}

export function presentationState(data, now = new Date()) {
  const published = new Date(data.generatedAt);
  const validTime = typeof data.generatedAt === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(data.generatedAt)
    && Number.isFinite(published.getTime())
    && published.toISOString().slice(0, 19) === data.generatedAt.slice(0, 19)
    && published.getTime() <= now.getTime();
  const expectedDate = expectedPublicationDate(data.edition, now);
  const publicationDate = validTime ? published.toISOString().slice(0, 10) : null;
  const offSchedule = validTime && data.edition === 'CN' && [0, 6].includes(published.getUTCDay());
  const stale = !validTime || offSchedule || !['US', 'CN'].includes(data.edition) || publicationDate < expectedDate;
  const legacy = data.schemaVersion === undefined;
  const claims = Array.isArray(data.analysis?.claims) ? data.analysis.claims : [];
  const approved = data.schemaVersion === 2 && data.verification?.version === 1 && data.verification?.status === 'approved'
    && Array.isArray(data.verification.reasonCodes) && data.verification.reasonCodes.length === 0
    && ['OK', 'DEGRADED'].includes(data.health?.status)
    && claims.length > 0 && claims.length <= 6 && data.verification.checkedClaims === claims.length
    && claims.every(claim => text(claim?.text) && Array.isArray(claim.basedOn) && claim.basedOn.length > 0
      && claim.basedOn.every(key => citationEvidence(data, key)));
  return {stale, legacy, approved, validTime, expectedDate, publicationDate, offSchedule};
}

export function verificationPresentation(data, state = presentationState(data)) {
  if (state.legacy) return {tone: 'historical', message: 'Historical commentary. It predates the current verification checks and carries no current approval.'};
  if (state.approved) {
    const count = data.analysis.claims.length;
    return {tone: state.stale ? 'historical' : 'approved', message: 'At publication, ' + count + ' claim' + (count === 1 ? '' : 's')
      + ' passed structure and attribution checks. Market figures come from data; interpretations remain AI-generated. Headline citations confirm an available headline, not the truth of its report.'};
  }
  const reasons = Array.isArray(data.verification?.reasonCodes) ? data.verification.reasonCodes : [];
  if (data.health?.status === 'OUTAGE' || reasons.includes('SOURCE_HEALTH_UNAVAILABLE')) {
    return {tone: 'unavailable', message: 'AI commentary unavailable: sufficient source data and health checks were not available for this run.'};
  }
  if (reasons.includes('MODEL_OUTPUT_UNAVAILABLE')) {
    return {tone: 'unavailable', message: 'AI commentary unavailable: the model did not return a response for this run.'};
  }
  if (reasons.some(code => ['APPROVAL_MISSING', 'APPROVAL_INVALID', 'APPROVAL_COUNT_MISMATCH', 'VERIFICATION_EXCEPTION'].includes(code))
      || data.verification?.status !== 'withheld' || !reasons.length) {
    return {tone: 'unavailable', message: 'AI commentary hidden: a complete verification record is unavailable. No approval is claimed.'};
  }
  if (reasons.some(code => ['FACT_UNAVAILABLE', 'HEADLINE_UNAVAILABLE', 'CITATION_LIST_INVALID', 'CITATION_KEY_INVALID'].includes(code))) {
    return {tone: 'withheld', message: 'AI commentary withheld: its evidence references failed attribution checks. The available source data is shown separately.'};
  }
  if (reasons.includes('NUMERIC_MODEL_TEXT')) {
    return {tone: 'withheld', message: 'AI commentary withheld: its text triggered the numerical-language filter. The available source data is shown separately.'};
  }
  if (reasons.some(code => ['ADVICE_IN_CLAIM', 'ADVICE_ONLY_TEXT'].includes(code))) {
    return {tone: 'withheld', message: 'AI commentary withheld: it told readers what to do with their money, which this brief never publishes. The available source data is shown separately.'};
  }
  if (reasons.includes('LONG_TERM_DIRECTION')) {
    return {tone: 'withheld', message: 'AI commentary withheld: it used long-term valuation as short-term evidence. The available source data is shown separately.'};
  }
  return {tone: 'withheld', message: 'AI commentary withheld: the response failed the required format or consistency checks. The available source data is shown separately.'};
}

// ---- Scheduled releases (W31) ----
// docs/data/calendar.json is copied by hand from the official release calendars (BLS, BEA, the Federal
// Reserve, NBS, the St. Louis Fed's FRED calendar), each entry with its source. The dashboard shows the
// next few items in Malaysia time and marks what has already been released. Nothing here predicts a figure.
const DAY_MS = 24 * 60 * 60 * 1000;
const DISPLAY_ZONE = 'Asia/Kuala_Lumpur';
const RELEASE_WINDOW_MS = 18 * 60 * 60 * 1000; // a release stays listed until the next morning

function zoneParts(zone, at, options) {
  const parts = new Intl.DateTimeFormat('en-GB', {timeZone: zone, hourCycle: 'h23', ...options}).formatToParts(at);
  return type => parts.find(part => part.type === type)?.value || '';
}

// Minutes east of UTC for `zone` at the instant `at`, from the platform's time-zone data.
export function zoneOffsetMinutes(zone, at) {
  const get = zoneParts(zone, at, {year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'});
  const asUtc = Date.UTC(Number(get('year')), Number(get('month')) - 1, Number(get('day')), Number(get('hour')), Number(get('minute')), Number(get('second')));
  return Math.round((asUtc - at.getTime()) / 60000);
}

// The instant at which the wall clock in `zone` reads `date` ("YYYY-MM-DD") and `time` ("HH:MM").
export function localToUtc(date, time, zone) {
  const [year, month, day] = String(date).split('-').map(Number);
  const [hour, minute] = String(time || '00:00').split(':').map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = wall - zoneOffsetMinutes(zone, new Date(wall)) * 60000;
  guess = wall - zoneOffsetMinutes(zone, new Date(guess)) * 60000; // a second pass settles a clock change
  return new Date(guess);
}

function displayDay(at) {
  const get = zoneParts(DISPLAY_ZONE, at, {weekday: 'short', day: 'numeric', month: 'short'});
  return {weekday: get('weekday'), day: get('day'), month: get('month')};
}
function displayTime(at) {
  const get = zoneParts(DISPLAY_ZONE, at, {hour: '2-digit', minute: '2-digit'});
  return get('hour') + ':' + get('minute');
}
function dateOnlyDay(date) {
  // All-day items keep the publisher's own dates (a Washington meeting is not shifted into Malaysia time).
  return displayDay(localToUtc(date, '12:00', DISPLAY_ZONE));
}
const dayLabel = parts => parts.weekday + ' ' + parts.day + ' ' + parts.month;

export function calendarWhenLabel(event, start) {
  if (!event.allDay) return dayLabel(displayDay(start)) + ' · ' + displayTime(start) + ' MYT';
  const first = dateOnlyDay(event.date);
  const last = dateOnlyDay(event.endDate || event.date);
  if (event.endDate === undefined || event.endDate === event.date) return dayLabel(first);
  if (first.month === last.month) return first.weekday + ' ' + first.day + ' – ' + dayLabel(last);
  return dayLabel(first) + ' – ' + dayLabel(last);
}

const REGION_NAMES = {CN: 'China', US: 'US'};
const timedStart = event => (text(event.utc) ? new Date(event.utc) : localToUtc(event.date, event.time, event.zone));

// Where an event sits on the clock: {start, end, allDay}, or null when it cannot be placed.
function eventSpan(event) {
  const allDay = event.allDay === true || !text(event.time);
  try {
    const start = allDay ? localToUtc(event.date, '00:00', event.zone) : timedStart(event);
    const end = allDay ? new Date(localToUtc(event.endDate || event.date, '00:00', event.zone).getTime() + DAY_MS) : start;
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return null;
    return {start, end, allDay};
  } catch { return null; }
}
function statusOf(span, now) {
  if (span.end.getTime() <= now.getTime()) return 'done';
  if (span.start.getTime() > now.getTime()) return 'upcoming';
  return span.allDay ? 'in-progress' : 'done';
}
function isToday(span, now, todayLabel) {
  if (span.allDay) return span.start.getTime() <= now.getTime() && now.getTime() < span.end.getTime();
  return dayLabel(displayDay(span.start)) === todayLabel;
}
function sourceOf(sources, event) {
  const source = sources[event.source];
  if (!source || !text(source.name) || !String(source.url || '').startsWith('https://')) return null;
  return {name: source.name, url: source.url};
}
function calendarItem(event, sources, now, todayLabel) {
  if (!text(event?.name) || !text(event?.date) || !text(event?.zone)) return null;
  const span = eventSpan(event);
  if (!span || span.end.getTime() < now.getTime() - RELEASE_WINDOW_MS) return null;
  let when;
  try { when = calendarWhenLabel({...event, allDay: span.allDay}, span.start); } catch { return null; }
  return {
    id: text(event.id) ? event.id : event.name,
    name: event.name,
    region: REGION_NAMES[event.region] || '',
    kind: event.kind === 'meeting' ? 'meeting' : 'release',
    start: span.start, allDay: span.allDay, status: statusOf(span, now), when,
    today: isToday(span, now, todayLabel),
    source: sourceOf(sources, event),
  };
}

export function calendarPresentation(calendar, data, now = new Date(), limit = 5) {
  const events = Array.isArray(calendar?.events) ? calendar.events : [];
  const sources = calendar && typeof calendar.sources === 'object' && calendar.sources ? calendar.sources : {};
  const todayLabel = dayLabel(displayDay(now));
  const items = events.map(event => calendarItem(event, sources, now, todayLabel)).filter(Boolean);
  items.sort((a, b) => a.start - b.start);
  const shown = items.slice(0, limit);
  return {items: shown, sourceNames: [...new Set(shown.map(item => item.source?.name).filter(Boolean))]};
}
