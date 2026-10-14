// Shared Telegram renderer: facts, evidence, approval and truncation have one path.
function MP_COMPOSE(EDITION, {$input, Date: RuntimeDate, console}) {
const items = $input.all();
const now = new RuntimeDate();
const isUS = EDITION === 'US';
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function oneLine(s) { return String(s).replace(/\s*\n+\s*/g,' ').trim(); }
const d = {
  ...Object.fromEntries(MP_POLICY.factKeysFor(EDITION).map(key => [key,'N/A'])),
  gdpYear:'N/A',cpiYear:'N/A',unemploymentYear:'N/A',watchlistSummary:'N/A',
  ppiMonth:'N/A',pmiMonth:'N/A',lprDate:'N/A',cgb10YDate:'N/A',csi300PEDate:'N/A',
  trackRecordAccuracy:'Building history',trackRecordLast:'',trackRecordBaseline:'',trackRecordSince:'',
  headlinesList:[],headlinesLinks:[],
  ...(isUS ? {
    fearGreedClassification:'Unknown',fearGreedChange1d:'N/A',fearGreedChange1w:'N/A',
    buffettStatus:'N/A',buffettEmoji:'',shillerStatus:'N/A',shillerEmoji:'',
    yieldCurveStatus:'N/A',yieldCurveEmoji:'',sp500VsMa200Status:'N/A',sp500VsMa200Emoji:'',
  } : {}),
};
for (const item of items) {
  const j = item.json || {};
  for (const key of Object.keys(d)) {
    if (j[key] !== undefined && j[key] !== null && j[key] !== '' && j[key] !== 'N/A' && j[key] !== 'Unknown' && j[key] !== 'Analysis unavailable') {
      d[key] = j[key];
    }
  }
}

// Apply the same availability rule to source tables and citation evidence.
for (const key of [...MP_POLICY.factKeysFor(EDITION),...(isUS ? ['fearGreedChange1d','fearGreedChange1w'] : [])]) {
  if (MP_POLICY.own(d, key) && !MP_POLICY.isUsableFact(d[key], key)) d[key] = 'N/A';
}

// escape every dynamic value ONCE, here - the template below only ever uses
// pre-escaped d[] fields, so it is free to add its own trusted <b>/<code>/<i> tags
// without a final blanket-escape stripping them back out.
// headlinesList stays an array (escaped per-element where it's actually used) - String()-ing
// it here would collapse it to a comma-joined string and break headline_N index lookups.
for (const k of Object.keys(d)) { if (k !== 'headlinesList' && k !== 'headlinesLinks') d[k] = esc(d[k]); }


// ===== DATA HEALTH BANNER (hardening) =====
let _health = null;
for (const item of items) { if (item.json && item.json._health) _health = item.json._health; }
let healthBanner = '';
if (_health && _health.status === 'OUTAGE') {
  healthBanner = `🚨 <b>DATA OUTAGE</b> - most live sources failed to load today.\nValues below may be missing/stale (${esc((_health.missing || []).join(', '))}).\n\n`;
} else if (_health && _health.status === 'DEGRADED') {
  healthBanner = `⚠️ <b>PARTIAL DATA</b> - some sources unavailable: ${esc((_health.missing || []).join(', '))}.\n\n`;
}
if (_health && _health.suspect && _health.suspect.length) {
  // Day-change flags come from the fetch layer; range, jump and cross-check flags come from
  // the long-term input checks (W18). Each says what was unusual, in plain words.
  const FIELD = {buffettIndicator:'Buffett Indicator', shillerPE:'Shiller CAPE', treasury10Y:'10Y Treasury', treasury2Y:'2Y Treasury', cpiValue:'CPI', yieldCurve:'Yield curve',
    csi300PE:'CSI 300 P/E', cgb10Y:'10Y government bond', lpr1Y:'LPR 1Y', lpr5Y:'LPR 5Y'};
  const named = f => esc(FIELD[f.field] || String(f.field));
  const parts = [], crossNames = [];
  for (const f of _health.suspect) {
    if (f.check === 'crosscheck') { crossNames.push(named(f) + ' ' + esc(String(f.value))); continue; }
    if (f.check === 'range') parts.push(named(f) + ' ' + esc(String(f.value)) + ' is outside its plausible range');
    else if (f.check === 'jump') parts.push(named(f) + ' ' + esc(String(f.value)) + ' moved more than ' + f.bound + '% since the last session');
    else parts.push(named(f) + ' (' + esc(String(f.value)) + ', exceeds \u00b1' + f.bound + '%)');
  }
  if (crossNames.length) parts.push('the two valuation measures disagree (' + crossNames.join(' vs ') + ')');
  healthBanner += '\uD83D\uDD0D <b>DATA CHECK</b> \u2014 ' + parts.join('; ') + '. Treat these readings with care until confirmed.\n\n';
}

// Only the explicitly approved analysis can supply commentary. Raw fields are ignored.
let _analysisModel = null, _analysisProvider = null;
for (const item of items) { if (item.json && item.json._analysisModel) { _analysisModel = item.json._analysisModel; _analysisProvider = item.json._analysisProvider; } }
const boundaryData = Object.assign({}, ...items.map(item => item.json || {}));
const approval = MP_POLICY.readApproval(boundaryData, EDITION);
const _structured = approval.ok ? approval.analysis : null;
const evidenceFacts = MP_POLICY.collectFacts(boundaryData, EDITION);
// Why there is no AI section today. "Unavailable" means no analysis existed to check;
// "withheld" means one existed and failed a check. The reason codes choose the words, the
// same way the dashboard explains them (verificationPresentation in docs/dashboard-state.mjs).
function withheldNotice(verification) {
  const reasons = verification && Array.isArray(verification.reasonCodes) ? verification.reasonCodes : [];
  const has = codes => reasons.some(code => codes.includes(code));
  const shown = ' The source data is shown above.';
  if (_health?.status === 'OUTAGE' || has(['SOURCE_HEALTH_UNAVAILABLE'])) {
    return '⏸️ AI commentary unavailable: the source data did not load well enough for an analysis this run.' + shown;
  }
  if (has(['MODEL_OUTPUT_UNAVAILABLE'])) return '⏸️ AI commentary unavailable: no AI model returned a response this run.' + shown;
  if (!reasons.length || has(['APPROVAL_MISSING', 'APPROVAL_INVALID', 'APPROVAL_COUNT_MISMATCH', 'VERIFICATION_EXCEPTION'])) {
    return '🚫 AI commentary withheld: a complete verification record was not available, so no analysis is shown.' + shown;
  }
  if (has(['FACT_UNAVAILABLE', 'HEADLINE_UNAVAILABLE', 'CITATION_LIST_INVALID', 'CITATION_KEY_INVALID'])) {
    return '🚫 AI commentary withheld: its evidence references failed the citation checks.' + shown;
  }
  if (has(['NUMERIC_MODEL_TEXT'])) return '🚫 AI commentary withheld: its text triggered the numerical-language filter.' + shown;
  if (has(['ADVICE_IN_CLAIM', 'ADVICE_ONLY_TEXT'])) return '🚫 AI commentary withheld: it told readers what to do with their money, which this brief never publishes.' + shown;
  if (has(['LONG_TERM_DIRECTION'])) return '🚫 AI commentary withheld: it used long-term valuation as short-term evidence.' + shown;
  return '🚫 AI commentary withheld: the response failed the required format or consistency checks.' + shown;
}

let analysisBlock = '', compactAnalysis = '', checkedLine = '';
if (_structured) {
  const LBL = {
    buffettIndicator: ['Buffett Indicator', 'buffettStatus'], shillerPE: ['Shiller CAPE', 'shillerStatus'],
    yieldCurve: ['Yield Curve 10Y-2Y', 'yieldCurveStatus'], sp500VsMa200: ['S&P vs 200D-MA', 'sp500VsMa200Status'],
    maSignal: ['Trend Signal', null], fearGreedValue: ['Fear & Greed', 'fearGreedClassification'],
    sp500: ['S&P 500', null], sp500Change: ['S&P 500 change', null], dowJones: ['Dow Jones', null],
    dowJonesChange: ['Dow change', null], vix: ['VIX', null], vixChange: ['VIX change', null],
    gold: ['Gold', null], goldChange: ['Gold change', null], oil: ['Oil WTI', null], oilChange: ['Oil change', null],
    dxy: ['Dollar DXY', null], dxyChange: ['DXY change', null], btc: ['Bitcoin', null], btcChange: ['Bitcoin change', null],
    gdpValue: ['GDP', null], cpiValue: ['CPI', null], unemploymentValue: ['Unemployment', null],
    fedRateValue: ['Fed Funds', null], treasury10Y: ['10Y Treasury', null], treasury2Y: ['2Y Treasury', null],
    csi300: ['CSI 300', null], csi300Change: ['CSI 300 change', null], sseComposite: ['SSE Composite', null],
    sseCompositeChange: ['SSE change', null], szseComponent: ['SZSE Component', null], szseComponentChange: ['SZSE change', null],
    hangSeng: ['Hang Seng', null], hangSengChange: ['Hang Seng change', null],
    usdCny: ['USD/CNY', null], usdCnyChange: ['USD/CNY change', null]
  };
  // d[] is already HTML-escaped above; these labels are our own trusted literals.
  // Watchlist evidence is dynamic - labels AND values come from the same stockDetails
  // the factKeys were derived from. The template merge copies only predefined keys
  // into d, so the per-stock keys are injected here from the items (escaped at
  // insertion, matching the pre-escape doctrine of the template fields).
  const wlSlug = (s) => String((s && (s.name || s.symbol)) || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const item of items) {
    const sdl = item.json && item.json.stockDetails;
    if (!Array.isArray(sdl)) continue;
    for (const s of sdl) {
      const b = wlSlug(s);
      if (!b) continue;
      if (!LBL[b + 'Change']) LBL[b + 'Change'] = [esc(String(s.name || s.symbol)) + ' change', null];
      if (MP_POLICY.own(evidenceFacts, b + 'Change')) d[b + 'Change'] = esc(evidenceFacts[b + 'Change']);
    }
  }
  // headline_N citations aren't in LBL (dynamic per-day, not a fixed factKey) - handled
  // separately, quoting the actual headline text (escaped here, at point of use, since
  // headlinesList was deliberately skipped in the blanket-escape pass above).
  const evidenceFor = (keys) => (keys || []).map((k) => {
    const hm = /^headline_(\d+)$/.exec(k);
    if (hm) {
      const hIdx = parseInt(hm[1], 10) - 1;
      const text = Array.isArray(d.headlinesList) ? d.headlinesList[hIdx] : null;
      if (!text) return null;
      // NEWS LINKS (Phase A): a cited headline links to its real source when captured
      const href = MP_POLICY.safeHttpUrl(Array.isArray(d.headlinesLinks) ? d.headlinesLinks[hIdx] : null);
      const q = '"' + esc(oneLine(text)) + '"';
      return href ? ('📰 <a href="' + esc(String(href)).replace(/"/g, '%22') + '">' + q + '</a>') : ('📰 ' + q);
    }
    const m = LBL[k]; if (!m) return null;
    if (!MP_POLICY.own(evidenceFacts, k)) return null;
    const val = esc(evidenceFacts[k]);
    const st = m[1] && d[m[1]] && d[m[1]] !== 'N/A' ? ' (' + d[m[1]] + ')' : '';
    return m[0] + ' ' + val + st;
  }).filter(Boolean).join('; ');
  const dirMark = c => c.direction === 'supports_bullish' ? '▲' : c.direction === 'supports_bearish' ? '▼' : '◆';
  const claimLines = _structured.claims.map(c => {
    const ev = evidenceFor(c.basedOn);
    return dirMark(c) + ' ' + esc(oneLine(c.claim)) + (ev ? '\n<i>evidence: ' + ev + '</i>' : '');
  });
  const read = esc(oneLine(_structured.sentiment || 'n/a'));
  const confidence = esc(oneLine(_structured.confidence || 'n/a'));
  analysisBlock = SENTIMENT_DOT(_structured.sentiment) + ' <b>' + read + '</b> · confidence ' + confidence +
    '\n<blockquote expandable>' + claimLines.join('\n') +
    (_structured.interpretation ? '\n\n' + esc(oneLine(_structured.interpretation)) : '') + '</blockquote>' +
    (_structured.wisdom ? '\n💬 <i>' + esc(oneLine(_structured.wisdom)) + '</i>' : '');
  compactAnalysis = SENTIMENT_DOT(_structured.sentiment) + ' <b>' + read + '</b> · confidence ' + confidence +
    '\n<i>Detailed commentary omitted to fit Telegram. Schema and citation availability checked; prose accuracy is not fact-checked.</i>';
  const modelNote = _analysisModel ? (' Written by ' + esc(_analysisModel) + ' (' + esc(_analysisProvider) + ').') : '';
  checkedLine = '✅ <i>' + ((_structured.claims || []).length) + ' claims cite available source data. Schema and citation availability checked; prose accuracy is not fact-checked.' + modelNote + '</i>';
} else {
  // Withholding notice is fixed code-owned text, never the original model response.
  analysisBlock = esc(withheldNotice(boundaryData._verification));
  compactAnalysis = analysisBlock;
}

// ===== LAYOUT HELPERS (presentation only: every figure is the fetched string) =====
function isNA(v) { return v === undefined || v === null || v === '' || v === 'N/A'; }
function visible(s) { return String(s).replace(/&(?:amp|lt|gt);/g, '_').length; }
function padEnd(s, n) { return s + ' '.repeat(Math.max(0, n - visible(s))); }
function padStart(s, n) { return ' '.repeat(Math.max(0, n - visible(s))) + s; }
// Thousands separators only; the digits, decimals, currency sign and sign stay as fetched.
function grouped(v) {
  if (isNA(v)) return 'N/A';
  const s = String(v);
  const prefix = (/^(?:HK\$|[$¥€£])/.exec(s) || [''])[0];
  const rest = s.slice(prefix.length);
  const sign = /^[+-]/.test(rest) ? rest[0] : '';
  const [whole, fraction] = rest.slice(sign.length).split('.');
  if (!/^\d{4,}$/.test(whole) || (fraction !== undefined && !/^\d+$/.test(fraction))) return s;
  let out = '';
  for (let i = 0; i < whole.length; i++) out += (i && (whole.length - i) % 3 === 0 ? ',' : '') + whole[i];
  return prefix + sign + out + (fraction === undefined ? '' : '.' + fraction);
}
// The change is shown exactly as fetched, with a direction mark in front.
function changeCell(v) {
  if (isNA(v)) return 'N/A';
  const s = String(v);
  return (s.startsWith('+') ? '▲ ' : s.startsWith('-') ? '▼ ' : '• ') + s;
}
function table(rows) {
  const cells = rows.map(([label, value, change]) => [label, grouped(value), changeCell(change)]);
  const w = [0, 1, 2].map(i => Math.max(...cells.map(c => visible(c[i]))));
  return '<pre>' + cells.map(c => padEnd(c[0], w[0]) + '  ' + padStart(c[1], w[1]) + '  ' + padStart(c[2], w[2])).join('\n') + '</pre>';
}
function SENTIMENT_DOT(s) {
  const t = String(s || '');
  return /Bullish/.test(t) ? '🟢' : /Cautiously Bearish/.test(t) ? '🟠' : /Bearish/.test(t) ? '🔴' : '🟡';
}

const dateStr = now.toLocaleDateString('en-US', {weekday:'long',year:'numeric',month:'long',day:'numeric'});
const fresh = MP_LTR.freshness(EDITION, isUS ? boundaryData.sp500MarketTime : boundaryData.csi300MarketTime, now);
const freshLine = '🕒 ' + (fresh.closed || fresh.intraday ? '<b>' + esc(fresh.label) + '</b>' : '<i>' + esc(fresh.label) + '</i>');
const header = '🏛️ <b>MoatPillar</b> · ' + (isUS ? 'US' : 'China') + ' Daily Brief · <i>' + MP_PHASE.LABEL + '</i>\n<i>' + esc(dateStr) + '</i>\n' + freshLine + '\n\n';

// ===== LONG-TERM READING (US ltr.v1, China ltr.cn.v1): computed by code before the analyst ran =====
function longTermSection(r) {
  if (!r || !r.valuation) return '🧭 <b>LONG-TERM READING</b>\n<i>Unavailable today: the valuation inputs did not pass their checks.</i>';
  const LEVEL_DOT = ['🟢', '🟢', '🟡', '🟠', '🔴'];
  const MOS_DOT = {Wide:'🟢', Moderate:'🟡', Narrow:'🟠', Thin:'🔴'};
  const SVB_DOT = {Wide:'🟢', Moderate:'🟡', Thin:'🟠', 'Bonds pay more':'🔴'};
  const SHORT = {buffettIndicator:'Buffett Indicator', shillerPE:'CAPE', csi300PE:'CSI 300 P/E'};
  const dayLabel = iso => {
    const t = Date.parse(String(iso) + 'T12:00:00Z');
    return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-US', {month:'short', day:'numeric', timeZone:'UTC'}) : esc(String(iso));
  };
  const measures = Object.keys(SHORT).filter(k => r.measures && r.measures[k])
    .map(k => SHORT[k] + ' <code>' + esc(r.measures[k].value) + '</code>' + (r.measures[k].asOf ? ' <i>(' + esc(r.measures[k].asOf) + ')</i>' : ''));
  let q = (LEVEL_DOT[r.valuation.hi - 1] || '⚪') + ' <b>Valuation · ' + esc(String(r.valuation.label).toUpperCase()) + '</b>';
  if (measures.length) q += '\n' + measures.join(' · ');
  if (r.valuation.topBand) q += measures.length > 1 ? '\nBoth measures in their top band' : '\nIn its top band';
  if (r.stocksVsBonds) {
    const s = r.stocksVsBonds;
    const bond = s.basis === 'nominal'
      ? ' vs 10Y government bond <code>' + Number(s.bondYield10Y).toFixed(2) + '%</code> <i>(nominal)</i>'
      : ' vs real 10Y <code>' + Number(s.realYield10Y).toFixed(1) + '%</code>';
    q += '\n' + (SVB_DOT[s.label] || '⚪') + ' <b>Stocks vs bonds · ' + esc(String(s.label).toUpperCase()) + '</b>' +
      '\nEarnings yield <code>' + Number(s.earningsYield).toFixed(1) + '%</code>' + bond;
  }
  q += '\n' + (MOS_DOT[r.marginOfSafety] || '⚪') + ' <b>Margin of safety · ' + esc(String(r.marginOfSafety).toUpperCase()) + '</b>';
  const status = r.status === 'first' ? 'First reading' : r.status === 'changed' ? 'Changed today'
    : r.status === 'held' ? 'Held since ' + dayLabel(r.since) + ' while today\'s inputs are checked' : 'Since ' + dayLabel(r.since);
  const pending = r.pending ? ' · watching a move to ' + esc(String(r.pending.label).toLowerCase()) + ' (' + r.pending.count + '/' + r.pending.of + ')' : '';
  q += '\n<i>' + status + pending + ' · fixed rules, not AI opinion</i>';
  const lines = [];
  for (const c of (r.changes || [])) {
    if (c.kind === 'valuation') {
      const conds = c.conditions.map(x => SHORT[x.key] + (x.direction === 'down' ? ' under ' : ' at ') + '<code>' + x.threshold + x.unit + '</code>' + (x.direction === 'up' ? ' or more' : ''));
      const moves = c.conditions.map(x => x.met ? 'met' : x.movePct + '%');
      const tail = c.conditions.every(x => x.met) ? 'met, confirming' : '≈' + moves.join(' / ') + (c.direction === 'down' ? ' lower' : ' higher');
      lines.push((c.direction === 'down' ? '↘ ' : '↗ ') + '<i>' + esc(c.target) + '</i>: ' + conds.join(' and ') + ' (' + tail + ')');
    } else if (c.kind === 'rates') {
      lines.push('↔ Rates: ' + c.boundaries.map(b => '<i>' + esc(b.label) + '</i> ' + (b.direction === 'up' ? 'at ' : 'below ') +
        '<code>' + (b.at > 0 ? '+' + b.at.toFixed(2) : b.at.toFixed(0)) + '%</code>').join(' · '));
    } else if (c.kind === 'bonds') {
      lines.push('↔ Stocks vs bonds: ' + c.boundaries.map(b => '<i>' + esc(b.label) + '</i> ' + (b.direction === 'up' ? 'at a gap of ' : 'below ') +
        '<code>' + b.at.toFixed(1) + '</code> points').join(' · '));
    } else if (c.kind === 'mood') lines.push('◦ Mood alone doesn\'t change it; prices or earnings must move');
  }
  return '🧭 <b>LONG-TERM READING</b>\n<blockquote>' + q + '</blockquote>' + (lines.length ? '\n<b>What would change it</b>\n' + lines.join('\n') : '');
}

function usContext(r) {
  const mood = r && r.mood ? esc(r.mood.label) : d.fearGreedClassification;
  const curve = r && r.rates ? esc(r.rates.label) : String(d.yieldCurveStatus).replace(/\s*\(.*\)$/, '');
  const trend = isNA(d.maSignal) ? '' : ' · ' + d.maSignal;
  return '🌡️ <b>MR. MARKET</b> ' + mood + ' <code>' + d.fearGreedValue + '</code>/100 · 1d ' + d.fearGreedChange1d + ' · 1w ' + d.fearGreedChange1w +
    '\n📈 <b>TREND</b> S&amp;P 500 <code>' + d.sp500VsMa200 + '</code> vs its 200-day average' + trend +
    '\n🏦 <b>RATES</b> Curve <code>' + d.yieldCurve + '</code> ' + curve.toLowerCase() + ' · 10Y <code>' + d.treasury10Y + '</code> · 2Y <code>' + d.treasury2Y + '</code> · Fed <code>' + d.fedRateValue + '</code>';
}

// China has no Fear & Greed gauge: the context is the trend, the policy rates and turnover.
function cnContext() {
  const trend = isNA(d.csi300VsMa200) ? '' : '📈 <b>TREND</b> CSI 300 <code>' + d.csi300VsMa200 + '</code> vs its 200-day average' + (isNA(d.maSignal) ? '' : ' · ' + d.maSignal);
  const parts = [];
  if (!isNA(d.cgb10Y)) parts.push('10Y bond <code>' + d.cgb10Y + '</code>');
  if (!isNA(d.lpr1Y)) parts.push('LPR 1Y <code>' + d.lpr1Y + '</code>');
  if (!isNA(d.lpr5Y)) parts.push('5Y <code>' + d.lpr5Y + '</code>' + (isNA(d.lprDate) ? '' : ' <i>(' + d.lprDate + ')</i>'));
  const rates = parts.length ? '🏦 <b>RATES</b> ' + parts.join(' · ') : '';
  const turnover = isNA(d.csi300Turnover) ? '' : '💱 <b>TURNOVER</b> CSI 300 <code>¥' + d.csi300Turnover + 'bn</code>';
  return [trend, rates, turnover].filter(Boolean).join('\n');
}

const marketRows = isUS
  ? [['S&amp;P 500', d.sp500, d.sp500Change], ['Dow', d.dowJones, d.dowJonesChange], ['VIX', d.vix, d.vixChange], ['Gold', d.gold, d.goldChange],
     ['Oil WTI', d.oil, d.oilChange], ['US Dollar', d.dxy, d.dxyChange], ['Bitcoin', d.btc, d.btcChange]]
  : [['CSI 300', d.csi300, d.csi300Change], ['SSE Composite', d.sseComposite, d.sseCompositeChange], ['SZSE Component', d.szseComponent, d.szseComponentChange],
     ['Hang Seng', d.hangSeng, d.hangSengChange], ['Gold', d.gold, d.goldChange], ['USD/CNY', d.usdCny, d.usdCnyChange]];
const cnyNote = !isUS && !isNA(d.usdCnyChange)
  ? '\n<i>' + (String(d.usdCnyChange).startsWith('+') ? 'Yuan weaker against the dollar' : String(d.usdCnyChange).startsWith('-') ? 'Yuan stronger against the dollar' : 'Yuan steady against the dollar') + '</i>'
  : '';
const economyFields = [['GDP', 'gdpValue', 'gdpYear'], ['CPI', 'cpiValue', 'cpiYear'], ['Unemployment', 'unemploymentValue', 'unemploymentYear'],
  ...(isUS ? [] : [['PPI', 'ppiValue', 'ppiMonth'], ['PMI', 'pmiValue', 'pmiMonth']])];
const economy = economyFields.filter(([label, key]) => !['PPI', 'PMI'].includes(label) || !isNA(d[key]))
  .map(([label, key, period]) => label + ' <code>' + d[key] + '</code>' + (isNA(d[period]) ? '' : ' (' + d[period] + ')')).join(' · ');

// Watchlist from structured stock details when present; otherwise the fetched summary text.
let watchRows = [];
for (const item of items) {
  const sdl = item.json && item.json.stockDetails;
  if (Array.isArray(sdl) && sdl.length) {
    watchRows = sdl.filter(s => s && (s.symbol || s.name))
      .map(s => [esc(String(s.name || s.symbol)), esc(String(s.price === undefined || s.price === null ? 'N/A' : s.price)), esc(String(s.change === undefined || s.change === null ? 'N/A' : s.change))]);
  }
}
const watchlist = watchRows.length ? table(watchRows) : (isNA(d.watchlistSummary) ? '<i>Unavailable today</i>' : '<pre>' + d.watchlistSummary + '</pre>');

// The beta record (W25) names the call date it covers from; the record before the beta is archived.
const recordSince = MP_PHASE.dateLabel(d.trackRecordSince);
const trackRecord = '🎯 <b>TRACK RECORD</b> <code>' + d.trackRecordAccuracy + '</code>' +
  (d.trackRecordBaseline ? '\n<i>For comparison, ' + d.trackRecordBaseline + '.</i>' : '') +
  (d.trackRecordLast ? '\n<i>Last: ' + d.trackRecordLast + '</i>' : '') +
  '\n<i>' + (recordSince ? MP_PHASE.LABEL + ' record since ' + recordSince + '.' : 'The ' + MP_PHASE.LABEL.toLowerCase() + ' record starts once its first call is graded.') +
  ' Short-term reads are graded automatically against what the market did next, never predicted.</i>';

const footer = '━━━━━━━━━━━━━━━━━━' +
  (checkedLine ? '\n' + checkedLine : '') +
  '\n📎 <i>' + (isUS ? 'CNN Fear &amp; Greed · FRED · MarketWatch · Yahoo Finance · multpl.com' : 'Yahoo Finance · CSI · ChinaBond · NIFC · NBS · World Bank · Google News') + '</i>' +
  '\n🔗 <a href="' + MP_LINKS.DASHBOARD + '">Dashboard</a> · <a href="' + MP_LINKS.REPOSITORY + '">Open source</a>' +
  '\n<i>Information only, not financial advice. AI commentary is checked for sources, not for correctness.</i>';

const ltr = boundaryData.longTermReading;
const context = isUS ? usContext(ltr) : cnContext();
// The US always carries the section; China carries it once its sources are live (a reading, or a flagged input).
const carriesReading = isUS || !!(ltr && (ltr.valuation || (Array.isArray(ltr.flags) && ltr.flags.length)));
const body = (carriesReading ? longTermSection(ltr) + '\n\n' : '') + (context ? context + '\n\n' : '') +
  '💹 <b>MARKETS</b>\n' + table(marketRows) + cnyNote +
  '\n\n🏛️ <b>ECONOMY</b>\n' + economy +
  '\n\n👁️ <b>WATCHLIST</b>\n' + watchlist + '\n\n';
const ANALYSIS = '📍 <b>SHORT-TERM READ</b> · <i>AI, graded daily</i>\n';
let message = header + healthBanner + body + ANALYSIS + analysisBlock + '\n\n' + trackRecord + '\n\n' + footer;
// Keep commentary and its evidence together. Removing individual trailing lines
// could leave a claim on Telegram after removing the evidence immediately below it.
if (message.length > 4096) {
  message = header + healthBanner + body + ANALYSIS + compactAnalysis + '\n\n' + trackRecord + '\n\n' + footer;
  if (message.length > 4096) {
    const sourceValue = key => MP_POLICY.own(evidenceFacts, key) ? esc(evidenceFacts[key]) : 'N/A';
    const sourceStatus = _health && ['OK','DEGRADED','OUTAGE'].includes(_health.status) ? _health.status : 'OUTAGE';
    message = '🏛️ <b>MoatPillar Daily Brief (' + EDITION + ')</b> · <i>' + MP_PHASE.LABEL + '</i>\n📅 ' + dateStr +
      '\n<b>Source health:</b> ' + sourceStatus +
      '\n' + (isUS ? 'S&amp;P 500' : 'CSI 300') + ': <code>' + sourceValue(isUS ? 'sp500' : 'csi300') + '</code> (' + sourceValue(isUS ? 'sp500Change' : 'csi300Change') + ')' +
      '\nGold: <code>' + sourceValue('gold') + '</code> (' + sourceValue('goldChange') + ')' +
      '\n\n' + compactAnalysis +
      '\n\n<i>Digest shortened to fit Telegram. AI commentary is informational only, not financial advice.</i>' +
      '\n<a href="' + MP_LINKS.DASHBOARD + '">Open Dashboard</a>';
  }
  console.error('[MarketPulse][TG-COMPACT] digest shortened to ' + message.length + ' chars');
}
// URLs for the Dashboard, Feedback and Share buttons under the post; the date is the brief's MYT date.
const links = MP_LINKS.forPost(EDITION, new RuntimeDate(now.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10));
return [{ json: { message, timestamp: now.toISOString(), links } }];
}
