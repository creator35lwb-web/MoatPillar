// Long-term reading (rules ltr.v1 for the US, ltr.cn.v1 for China), valuation input checks and
// data freshness. Code computes every part of the reading from fetched facts; the model may only
// explain it. Prepended by the workflow builder to Combine, Compose, Prepare and Weekly nodes, and
// importable by tests. The reading describes the market; it never forecasts or advises.
const MP_LTR = (() => {
  const VERSION = 'ltr.v1';
  const LEVELS = ['Cheap', 'Fair', 'Slightly expensive', 'Expensive', 'Very expensive'];
  // Bands are the existing dashboard bands, so the reading never contradicts the
  // per-measure status shown beside it. Lower bound of each level above Cheap.
  const MEASURES = {
    shillerPE: {label: 'Shiller CAPE', unit: '', bands: [20, 25, 30, 35], range: [5, 80]},
    buffettIndicator: {label: 'Buffett Indicator', unit: '%', bands: [100, 120, 150, 200], range: [40, 400]},
  };
  const RANGES = {treasury10Y: [0, 20], treasury2Y: [0, 20], cpiValue: [-5, 25], yieldCurve: [-10, 10]};
  // China (rules ltr.cn.v1, W29 and W32): the CSI 300 trailing P/E against its own history is the
  // anchor. The bands are the p20, p60, p80 and p95 of CSI's daily series from 2011-06-28 to
  // 2026-10-09, frozen there and versioned; they await Alton's review. China is never judged against
  // US thresholds. Stocks against bonds is nominal (100 ÷ P/E minus the 10-year government yield):
  // no daily inflation series exists for the history, so it is not comparable with the US real gap.
  const VERSION_CN = 'ltr.cn.v1';
  const MEASURES_CN = {
    csi300PE: {label: 'CSI 300 P/E', unit: '', bands: [11.2, 13.4, 14.5, 16.2], range: [5, 40]},
  };
  const RANGES_CN = {cgb10Y: [0, 10], lpr1Y: [0, 10], lpr5Y: [0, 10]};
  const GAP_BANDS_CN = {thin: 3.7, wide: 6.1};  // p20 and p80 of the gap's own history (W29)
  const JUMP_LIMIT = 0.10;     // relative move between two market sessions that needs a human look
  const CONFIRM_SESSIONS = 3;  // a new valuation level shows only after it holds this many sessions
  const HISTORY_CAP = 60;
  const SESSION_CAP = 5;
  const RULES = {
    US: {version: VERSION, measures: MEASURES, ranges: RANGES, crosscheck: true},
    CN: {version: VERSION_CN, measures: MEASURES_CN, ranges: RANGES_CN, crosscheck: false},
  };

  const own = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
  const toNumber = value => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'string') return null;
    // Strip the known decorations one at a time, then accept plain or comma-grouped digits.
    // Each pattern is anchored and unambiguous, so matching time stays linear.
    let t = value.trim().replace(/^(?:HK\$|[$¥€£])/, '').replace(/\s*\([^()]*\)$/, '').replace(/\s*%$/, '');
    const sign = /^[+-]/.test(t) ? t[0] : '';
    t = t.slice(sign.length);
    if (!/^\d+(?:\.\d+)?$/.test(t) && !/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(t)) return null;
    const n = Number(sign + t.replaceAll(',', ''));
    return Number.isFinite(n) ? n : null;
  };
  const round = (value, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;
  const levelFor = (value, bands) => 1 + bands.filter(threshold => value >= threshold).length;
  const levelLabel = level => LEVELS[level - 1];
  const rangeLabel = (lo, hi) => lo === hi ? levelLabel(lo) : levelLabel(lo) + ' to ' + levelLabel(hi).toLowerCase();
  const marginFor = level => level <= 1 ? 'Wide' : level === 2 ? 'Moderate' : level === 3 ? 'Narrow' : 'Thin';
  const gapLabel = gap => gap < 0 ? 'Bonds pay more' : gap < 2 ? 'Thin' : gap < 4 ? 'Moderate' : 'Wide';
  const gapLabelCN = gap => gap < 0 ? 'Bonds pay more' : gap < GAP_BANDS_CN.thin ? 'Thin' : gap < GAP_BANDS_CN.wide ? 'Moderate' : 'Wide';
  const moodLabel = score => score <= 24 ? 'Extreme fear' : score <= 44 ? 'Fear' : score <= 55 ? 'Neutral' : score <= 75 ? 'Greed' : 'Extreme greed';
  const curveLabel = value => value < 0 ? 'Inverted' : value < 0.5 ? 'Flat' : 'Normal';
  const fmt = (value, unit, digits = 1) => (unit === '%' ? String(round(value, 0)) : round(value, digits).toFixed(digits)) + unit;
  const versionFor = edition => edition === 'CN' ? VERSION_CN : VERSION;
  const measureKeysFor = edition => Object.keys(edition === 'CN' ? MEASURES_CN : MEASURES);

  // ---- Exchange calendar helpers (no holiday table: the exchange's own timestamp decides) ----
  const zoneFor = edition => edition === 'CN' ? 'Asia/Shanghai' : 'America/New_York';
  function localParts(date, timeZone) {
    const parts = {};
    for (const p of new Intl.DateTimeFormat('en-US', {timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short'}).formatToParts(date)) parts[p.type] = p.value;
    return {date: parts.year + '-' + parts.month + '-' + parts.day, minutes: Number(parts.hour) * 60 + Number(parts.minute), weekday: parts.weekday};
  }
  const shiftDate = (isoDate, days) => new Date(Date.parse(isoDate + 'T12:00:00Z') + days * 86400000).toISOString().slice(0, 10);
  const weekdayOf = isoDate => new Date(Date.parse(isoDate + 'T12:00:00Z')).getUTCDay();
  function previousWeekday(isoDate) {
    let day = shiftDate(isoDate, -1);
    while ([0, 6].includes(weekdayOf(day))) day = shiftDate(day, -1);
    return day;
  }
  const sessionDate = (edition, marketTime) =>
    (typeof marketTime === 'number' && Number.isFinite(marketTime) && marketTime > 0)
      ? localParts(new Date(marketTime * 1000), zoneFor(edition)).date : null;

  // Freshness: what session the figures come from, said plainly in every edition.
  // US runs before the New York open, CN after the Shanghai close.
  function freshness(edition, marketTime, now) {
    if (!(typeof marketTime === 'number' && Number.isFinite(marketTime) && marketTime > 0)) {
      return {available: false, label: 'Session time unavailable', closed: false, intraday: false};
    }
    const zone = zoneFor(edition);
    const market = localParts(new Date(marketTime * 1000), zone);
    const today = localParts(now, zone);
    const openMinutes = 9 * 60 + 30;  // both exchanges open at 09:30 local time
    const closeMinutes = edition === 'CN' ? 15 * 60 : 16 * 60;
    const weekday = ![0, 6].includes(weekdayOf(today.date));
    // The last session a run should see: CN runs after the close, US before the open.
    const expected = edition === 'CN'
      ? (weekday && today.minutes >= closeMinutes ? today.date : previousWeekday(today.date))
      : (weekday && today.minutes >= openMinutes ? today.date : previousWeekday(today.date));
    const intraday = market.date === today.date && market.minutes < closeMinutes && today.minutes < closeMinutes + 30;
    const closed = market.date < expected;
    const dayLabel = new Intl.DateTimeFormat('en-US', {timeZone: zone, weekday: 'short', month: 'short', day: 'numeric'}).format(new Date(marketTime * 1000));
    const zoneLabel = edition === 'CN' ? 'Shanghai' : 'ET';
    const hh = String(Math.floor(market.minutes / 60)).padStart(2, '0'), mm = String(market.minutes % 60).padStart(2, '0');
    let label;
    if (intraday) label = 'Prices as of ' + dayLabel + ', ' + hh + ':' + mm + ' ' + zoneLabel + ' (market open)';
    else if (closed) label = 'Prices as of the ' + dayLabel + ' close · no trading session since';
    else label = 'Prices as of the ' + dayLabel + ' close';
    return {available: true, label, session: market.date, expected, closed, intraday};
  }

  // ---- Input checks (W18): range, jump between sessions, cross-check of the two US measures ----
  function checkInputs(facts, state, session, rules = RULES.US) {
    const values = {}, flags = [];
    const limits = Object.assign({}, ...Object.entries(rules.measures).map(([k, m]) => ({[k]: m.range})), rules.ranges);
    for (const [key, range] of Object.entries(limits)) {
      const n = own(facts, key) ? toNumber(facts[key]) : null;
      if (n === null) { values[key] = null; continue; }
      if (n < range[0] || n > range[1]) {
        values[key] = null;
        flags.push({field: key, value: String(facts[key]), bound: Math.abs(n < range[0] ? range[0] : range[1]), check: 'range'});
        continue;
      }
      values[key] = n;
    }
    const raw = Object.fromEntries(Object.keys(rules.measures).map(k => [k, values[k]]));
    const sessions = Array.isArray(state.sessions) ? state.sessions : [];
    const reference = session ? sessions.filter(s => s && s.session !== session).slice(-1)[0] : null;
    for (const key of Object.keys(rules.measures)) {
      const previous = reference && reference.values ? toNumber(reference.values[key]) : null;
      if (values[key] !== null && previous !== null && previous > 0 && Math.abs(values[key] / previous - 1) > JUMP_LIMIT) {
        flags.push({field: key, value: String(facts[key]), bound: JUMP_LIMIT * 100, check: 'jump'});
        values[key] = null;
      }
    }
    if (rules.crosscheck && values.shillerPE !== null && values.buffettIndicator !== null) {
      const gap = Math.abs(levelFor(values.shillerPE, MEASURES.shillerPE.bands) - levelFor(values.buffettIndicator, MEASURES.buffettIndicator.bands));
      if (gap >= 2) {
        for (const key of Object.keys(MEASURES)) flags.push({field: key, value: String(facts[key]), bound: gap, check: 'crosscheck'});
      }
    }
    return {values, raw, flags};
  }

  // ---- What would change the reading (Principle 6: conditions, never dates or targets) ----
  function changesFor(lo, hi, values, rates) {
    const lines = [];
    const condition = (key, threshold, direction) => {
      const m = MEASURES[key], value = values[key];
      const move = direction === 'down' ? (value - threshold) / value : (threshold - value) / value;
      return {key, label: m.label, threshold, unit: m.unit, value: round(value, 1), direction,
        movePct: Math.round(move * 100), met: direction === 'down' ? value < threshold : value >= threshold};
    };
    const levels = {shillerPE: levelFor(values.shillerPE, MEASURES.shillerPE.bands), buffettIndicator: levelFor(values.buffettIndicator, MEASURES.buffettIndicator.bands)};
    const down = lo === hi ? lo - 1 : lo;
    if (down >= 1) {
      lines.push({kind: 'valuation', direction: 'down', target: levelLabel(down),
        conditions: Object.keys(MEASURES).filter(k => levels[k] > down).map(k => condition(k, MEASURES[k].bands[down - 1], 'down'))});
    }
    const up = lo === hi ? hi + 1 : hi;
    if (up <= LEVELS.length && !(lo === hi && hi === LEVELS.length)) {
      const conditions = Object.keys(MEASURES).filter(k => levels[k] < up).map(k => condition(k, MEASURES[k].bands[up - 2], 'up'));
      if (conditions.length) lines.push({kind: 'valuation', direction: 'up', target: levelLabel(up), conditions});
    }
    if (rates) {
      const boundaries = rates.label === 'Normal' ? [{label: 'Flat', at: 0.5, direction: 'down'}]
        : rates.label === 'Flat' ? [{label: 'Normal', at: 0.5, direction: 'up'}, {label: 'Inverted', at: 0, direction: 'down'}]
        : [{label: 'Flat', at: 0, direction: 'up'}];
      lines.push({kind: 'rates', current: rates.label, boundaries});
    }
    lines.push({kind: 'mood'});
    return lines;
  }

  // China: one anchor, so the next level up and down, plus where the stocks-against-bonds gap turns.
  function changesForCN(level, values, stocksVsBonds) {
    const lines = [];
    const m = MEASURES_CN.csi300PE, value = values.csi300PE;
    const condition = (threshold, direction) => ({key: 'csi300PE', label: m.label, threshold, unit: m.unit, value: round(value, 1), direction,
      movePct: Math.round((direction === 'down' ? (value - threshold) / value : (threshold - value) / value) * 100),
      met: direction === 'down' ? value < threshold : value >= threshold});
    if (level > 1) lines.push({kind: 'valuation', direction: 'down', target: levelLabel(level - 1), conditions: [condition(m.bands[level - 2], 'down')]});
    if (level < LEVELS.length) lines.push({kind: 'valuation', direction: 'up', target: levelLabel(level + 1), conditions: [condition(m.bands[level - 1], 'up')]});
    if (stocksVsBonds) {
      const {thin, wide} = GAP_BANDS_CN;
      const boundaries = stocksVsBonds.label === 'Wide' ? [{label: 'Moderate', at: wide, direction: 'down'}]
        : stocksVsBonds.label === 'Moderate' ? [{label: 'Wide', at: wide, direction: 'up'}, {label: 'Thin', at: thin, direction: 'down'}]
        : stocksVsBonds.label === 'Thin' ? [{label: 'Moderate', at: thin, direction: 'up'}, {label: 'Bonds pay more', at: 0, direction: 'down'}]
        : [{label: 'Thin', at: 0, direction: 'up'}];
      lines.push({kind: 'bonds', current: stocksVsBonds.label, boundaries});
    }
    return lines;
  }

  // ---- Stability rules shared by both editions: a new level shows only after it holds for
  // CONFIRM_SESSIONS distinct market sessions. Mutates the edition's state (staticData mpLongTerm).
  function settle(state, current, session, today) {
    let status;
    if (current.status === 'ok') {
      if (!state.confirmed) { state.confirmed = {key: current.key, lo: current.lo, hi: current.hi, since: today}; state.pending = null; status = 'first'; }
      else if (state.confirmed.key === current.key) { state.pending = null; status = 'steady'; }
      else {
        if (state.pending && state.pending.key === current.key) {
          if (state.pending.session !== session) { state.pending.count += 1; state.pending.session = session; }
        } else state.pending = {key: current.key, lo: current.lo, hi: current.hi, count: 1, session};
        if (state.pending.count >= CONFIRM_SESSIONS) {
          if (!Array.isArray(state.history)) state.history = [];
          state.history.push({date: today, from: state.confirmed.key, to: current.key});
          if (state.history.length > HISTORY_CAP) state.history.splice(0, state.history.length - HISTORY_CAP);
          state.confirmed = {key: current.key, lo: current.lo, hi: current.hi, since: today};
          state.pending = null;
          status = 'changed';
        } else status = 'pending';
      }
    } else status = state.confirmed ? 'held' : 'unavailable';
    return status;
  }
  // Remember this session's in-range inputs for tomorrow's jump check.
  function rememberSession(state, session, values, version) {
    if (!Array.isArray(state.sessions)) state.sessions = [];
    const record = {session, values};
    const last = state.sessions[state.sessions.length - 1];
    if (last && last.session === session) state.sessions[state.sessions.length - 1] = record; else state.sessions.push(record);
    if (state.sessions.length > SESSION_CAP) state.sessions.splice(0, state.sessions.length - SESSION_CAP);
    state.v = version;
  }

  // ---- The US reading. Mutates state (staticData mpLongTerm.US) only through the stability rules ----
  function compute(facts, state, now, marketTime) {
    const today = now.toISOString().slice(0, 10);
    const session = sessionDate('US', marketTime) || today;
    const {values, raw, flags} = checkInputs(facts, state, session, RULES.US);

    let current = {status: 'unavailable'};
    if (values.shillerPE !== null && values.buffettIndicator !== null) {
      const lc = levelFor(values.shillerPE, MEASURES.shillerPE.bands), lb = levelFor(values.buffettIndicator, MEASURES.buffettIndicator.bands);
      const lo = Math.min(lc, lb), hi = Math.max(lc, lb);
      current = hi - lo >= 2 ? {status: 'disagree'} : {status: 'ok', key: lo + '-' + hi, lo, hi};
    }
    const status = settle(state, current, session, today);
    rememberSession(state, session, {shillerPE: raw.shillerPE, buffettIndicator: raw.buffettIndicator}, VERSION);

    const shown = state.confirmed || null;
    const measures = {};
    for (const [key, m] of Object.entries(MEASURES)) {
      measures[key] = values[key] === null ? null
        : {label: m.label, value: String(facts[key]), level: levelFor(values[key], m.bands), levelLabel: levelLabel(levelFor(values[key], m.bands))};
    }
    const stocksVsBonds = values.shillerPE !== null && values.treasury10Y !== null && values.cpiValue !== null
      ? (() => {
        const earningsYield = 100 / values.shillerPE, realYield = values.treasury10Y - values.cpiValue, gap = earningsYield - realYield;
        return {earningsYield: round(earningsYield, 1), realYield10Y: round(realYield, 1), gap: round(gap, 1), label: gapLabel(round(gap, 1))};
      })()
      : null;
    const fear = own(facts, 'fearGreedValue') ? toNumber(facts.fearGreedValue) : null;
    const mood = fear !== null && fear >= 0 && fear <= 100
      ? {score: fear, label: moodLabel(fear), change1d: typeof facts.fearGreedChange1d === 'string' ? facts.fearGreedChange1d : null,
        change1w: typeof facts.fearGreedChange1w === 'string' ? facts.fearGreedChange1w : null}
      : null;
    const trendValue = own(facts, 'sp500VsMa200') ? toNumber(facts.sp500VsMa200) : null;
    const trend = trendValue === null ? null : {value: String(facts.sp500VsMa200), above: trendValue >= 0};
    const rates = values.yieldCurve === null ? null : {curve: String(facts.yieldCurve), label: curveLabel(values.yieldCurve)};

    const reading = {
      version: VERSION,
      status,                                   // first | steady | pending | changed | held | unavailable
      today: current.status,                     // ok | disagree | unavailable
      valuation: shown ? {lo: shown.lo, hi: shown.hi, label: rangeLabel(shown.lo, shown.hi), topBand: shown.lo === LEVELS.length} : null,
      since: shown ? shown.since : null,
      pending: state.pending ? {label: rangeLabel(state.pending.lo, state.pending.hi), count: state.pending.count, of: CONFIRM_SESSIONS} : null,
      marginOfSafety: shown ? marginFor(shown.hi) : null,
      measures,
      stocksVsBonds,
      mood,
      trend,
      rates,
      changes: shown && current.status === 'ok' ? changesFor(shown.lo, shown.hi, values, rates) : [],
      flags: flags.map(f => ({field: f.field, check: f.check})),
    };
    return {reading, flags};
  }

  // ---- The China reading (ltr.cn.v1). The same stability rules, one anchor, a nominal gap, the
  // CSI 300 trend against its 200-day average and the policy rates as context. State: mpLongTerm.CN.
  function computeCN(facts, state, now, marketTime) {
    const today = now.toISOString().slice(0, 10);
    const session = sessionDate('CN', marketTime) || today;
    const {values, raw, flags} = checkInputs(facts, state, session, RULES.CN);
    const m = MEASURES_CN.csi300PE;

    let current = {status: 'unavailable'};
    if (values.csi300PE !== null) {
      const level = levelFor(values.csi300PE, m.bands);
      current = {status: 'ok', key: level + '-' + level, lo: level, hi: level};
    }
    const status = settle(state, current, session, today);
    rememberSession(state, session, {csi300PE: raw.csi300PE}, VERSION_CN);

    const shown = state.confirmed || null;
    const level = values.csi300PE === null ? null : levelFor(values.csi300PE, m.bands);
    const isoDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
    const measures = {
      csi300PE: level === null ? null : {label: m.label, value: String(facts.csi300PE), level, levelLabel: levelLabel(level), asOf: isoDate(facts.csi300PEDate)},
    };
    const stocksVsBonds = values.csi300PE !== null && values.cgb10Y !== null
      ? (() => {
        const earningsYield = 100 / values.csi300PE, gap = earningsYield - values.cgb10Y;
        return {basis: 'nominal', earningsYield: round(earningsYield, 1), bondYield10Y: round(values.cgb10Y, 2), gap: round(gap, 1), label: gapLabelCN(round(gap, 1))};
      })()
      : null;
    const trendValue = own(facts, 'csi300VsMa200') ? toNumber(facts.csi300VsMa200) : null;
    const trend = trendValue === null ? null : {value: String(facts.csi300VsMa200), above: trendValue >= 0};
    const rates = values.lpr1Y !== null || values.lpr5Y !== null || values.cgb10Y !== null
      ? {lpr1Y: values.lpr1Y === null ? null : String(facts.lpr1Y), lpr5Y: values.lpr5Y === null ? null : String(facts.lpr5Y),
        cgb10Y: values.cgb10Y === null ? null : String(facts.cgb10Y), asOf: isoDate(facts.lprDate)}
      : null;

    const reading = {
      version: VERSION_CN,
      status,
      today: current.status,
      valuation: shown ? {lo: shown.lo, hi: shown.hi, label: rangeLabel(shown.lo, shown.hi), topBand: shown.lo === LEVELS.length} : null,
      since: shown ? shown.since : null,
      pending: state.pending ? {label: rangeLabel(state.pending.lo, state.pending.hi), count: state.pending.count, of: CONFIRM_SESSIONS} : null,
      marginOfSafety: shown ? marginFor(shown.hi) : null,
      measures,
      stocksVsBonds,
      mood: null,
      trend,
      rates,
      changes: shown && current.status === 'ok' ? changesForCN(shown.lo, values, stocksVsBonds) : [],
      flags: flags.map(f => ({field: f.field, check: f.check})),
    };
    return {reading, flags};
  }

  function promptSummary(reading) {
    if (!reading || !reading.valuation) return 'Long-term reading unavailable today: valuation inputs did not pass their checks.';
    const parts = [];
    const m = reading.measures, inputs = Object.values(m).filter(Boolean).map(x => x.label + ' ' + x.value).join(', ');
    parts.push('Valuation: ' + reading.valuation.label + (inputs ? ' (' + inputs + ')' : '') + (reading.status === 'held' ? '; held from an earlier session because today\'s inputs failed their checks' : '') + '.');
    if (reading.stocksVsBonds) parts.push('Stocks vs bonds after inflation: ' + reading.stocksVsBonds.label + ' (earnings yield ' + reading.stocksVsBonds.earningsYield + '% vs real ten-year yield ' + reading.stocksVsBonds.realYield10Y + '%).');
    parts.push('Margin of safety on offer: ' + reading.marginOfSafety + '.');
    if (reading.mood) parts.push('Mr. Market: ' + reading.mood.label + '.');
    if (reading.rates) parts.push('Yield curve: ' + reading.rates.label + '.');
    return parts.join(' ');
  }

  function promptSummaryCN(reading) {
    if (!reading || !reading.valuation) {
      return Array.isArray(reading && reading.flags) && reading.flags.length
        ? 'Long-term reading unavailable today: the CSI 300 P/E did not pass its checks.' : 'Long-term reading not available in this edition.';
    }
    const parts = [];
    const m = reading.measures && reading.measures.csi300PE;
    parts.push('Valuation: ' + reading.valuation.label + (m ? ' (CSI 300 trailing P/E ' + m.value + (m.asOf ? ', as of ' + m.asOf : '') + ', judged against its own history since 2011, never against US levels)' : '')
      + (reading.status === 'held' ? '; held from an earlier session because today\'s inputs failed their checks' : '') + '.');
    if (reading.stocksVsBonds) parts.push('Stocks vs bonds, nominal: ' + reading.stocksVsBonds.label + ' (earnings yield ' + reading.stocksVsBonds.earningsYield + '% vs ten-year government bond ' + reading.stocksVsBonds.bondYield10Y + '%).');
    parts.push('Margin of safety on offer: ' + reading.marginOfSafety + '.');
    if (reading.trend) parts.push('Trend: CSI 300 ' + (reading.trend.above ? 'above' : 'below') + ' its 200-day average (' + reading.trend.value + ').');
    if (reading.rates && (reading.rates.lpr1Y || reading.rates.lpr5Y)) parts.push('Policy rates: LPR one-year ' + (reading.rates.lpr1Y || 'n/a') + ', five-year ' + (reading.rates.lpr5Y || 'n/a') + (reading.rates.asOf ? ' (fixing of ' + reading.rates.asOf + ')' : '') + '.');
    return parts.join(' ');
  }

  return {VERSION, VERSION_CN, LEVELS, MEASURES, MEASURES_CN, GAP_BANDS_CN, CONFIRM_SESSIONS, JUMP_LIMIT, toNumber, levelFor, rangeLabel, marginFor, gapLabel, gapLabelCN, moodLabel,
    curveLabel, fmt, versionFor, measureKeysFor, checkInputs, changesFor, changesForCN, compute, computeCN, promptSummary, promptSummaryCN, freshness, sessionDate, previousWeekday};
})();
if (typeof module !== 'undefined' && module.exports) module.exports = MP_LTR;
