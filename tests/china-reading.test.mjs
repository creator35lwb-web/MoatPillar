import test from 'node:test';
import assert from 'node:assert/strict';
import L from '../src/n8n/long-term-reading.js';
import policy from '../src/n8n/analysis-policy.js';
import {validateDashboardData} from '../.github/scripts/validate-dashboard-data.mjs';
import {runNode, groundTruth, pipeline, publishedSourceFixture} from './helpers/n8n.mjs';

// The China edition of 2026-10-14, read from the official sources that afternoon (W32).
const OCT14 = {csi300PE:'13.10', csi300PEDate:'2026-10-13', cgb10Y:'1.65%', cgb10YDate:'2026-10-14', lpr1Y:'3.00%', lpr5Y:'3.50%', lprDate:'2026-09-20',
  csi300VsMa200:'-9.9%', maSignal:'Death Cross', csi300Turnover:'368', ppiValue:'+5.0%', ppiMonth:'Sep 2026', pmiValue:'50.1', pmiMonth:'Sep 2026',
  cpiValue:'+0.9%', cpiYear:'Sep 2026'};
const at = iso => new Date(iso);
const sessionAt = iso => Date.parse(iso) / 1000;

test('China bands (ltr.cn.v1) at every boundary, and the nominal gap labels', () => {
  const bands = L.MEASURES_CN.csi300PE.bands;
  assert.deepEqual([11.19, 11.2, 13.39, 13.4, 14.49, 14.5, 16.19, 16.2].map(v => L.levelFor(v, bands)), [1, 2, 2, 3, 3, 4, 4, 5]);
  assert.deepEqual([-0.1, 0, 3.69, 3.7, 6.09, 6.1].map(L.gapLabelCN), ['Bonds pay more', 'Thin', 'Thin', 'Moderate', 'Moderate', 'Wide']);
  assert.equal(L.versionFor('CN'), 'ltr.cn.v1'); assert.deepEqual(L.measureKeysFor('CN'), ['csi300PE']);
});

test('the 2026-10-14 China reading: Fair, a moderate nominal gap, the trend and the policy rates', () => {
  const state = {};
  const {reading, flags} = L.computeCN(OCT14, state, at('2026-10-14T08:30:00Z'), sessionAt('2026-10-14T07:00:00Z'));
  assert.deepEqual(flags, []);
  assert.equal(reading.version, 'ltr.cn.v1'); assert.equal(reading.status, 'first');
  assert.deepEqual(reading.valuation, {lo: 2, hi: 2, label: 'Fair', topBand: false});
  assert.equal(reading.marginOfSafety, 'Moderate');
  assert.deepEqual(reading.measures.csi300PE, {label: 'CSI 300 P/E', value: '13.10', level: 2, levelLabel: 'Fair', asOf: '2026-10-13'});
  assert.deepEqual(reading.stocksVsBonds, {basis: 'nominal', earningsYield: 7.6, bondYield10Y: 1.65, gap: 6, label: 'Moderate'});
  assert.deepEqual(reading.trend, {value: '-9.9%', above: false});
  assert.deepEqual(reading.rates, {lpr1Y: '3.00%', lpr5Y: '3.50%', cgb10Y: '1.65%', asOf: '2026-09-20'});
  assert.equal(reading.mood, null);
  assert.deepEqual(reading.changes.map(c => c.kind), ['valuation', 'valuation', 'bonds']);
  const [down, up, bonds] = reading.changes;
  assert.equal(down.target, 'Cheap'); assert.deepEqual([down.conditions[0].threshold, down.conditions[0].movePct, down.conditions[0].met], [11.2, 15, false]);
  assert.equal(up.target, 'Slightly expensive'); assert.deepEqual([up.conditions[0].threshold, up.conditions[0].movePct], [13.4, 2]);
  assert.deepEqual(bonds.boundaries.map(b => [b.label, b.at]), [['Wide', 6.1], ['Thin', 3.7]]);
  assert.match(L.promptSummaryCN(reading), /^Valuation: Fair \(CSI 300 trailing P\/E 13\.10, as of 2026-10-13, judged against its own history since 2011, never against US levels\)\. Stocks vs bonds, nominal: Moderate \(earnings yield 7\.6% vs ten-year government bond 1\.65%\)\. Margin of safety on offer: Moderate\. Trend: CSI 300 below its 200-day average \(-9\.9%\)\. Policy rates: LPR one-year 3\.00%, five-year 3\.50% \(fixing of 2026-09-20\)\.$/);
  assert.equal(state.mpLongTerm, undefined); assert.equal(state.confirmed.key, '2-2'); assert.equal(state.v, 'ltr.cn.v1');
});

test('a new China level shows only after three distinct sessions; implausible inputs are flagged, never shown', () => {
  const state = {};
  L.computeCN(OCT14, state, at('2026-10-14T08:30:00Z'), sessionAt('2026-10-14T07:00:00Z'));
  const higher = {...OCT14, csi300PE: '13.60'};
  const d1 = L.computeCN(higher, state, at('2026-10-15T08:30:00Z'), sessionAt('2026-10-15T07:00:00Z')).reading;
  assert.equal(d1.status, 'pending'); assert.equal(d1.valuation.label, 'Fair'); assert.deepEqual(d1.pending, {label: 'Slightly expensive', count: 1, of: 3});
  const rerun = L.computeCN(higher, state, at('2026-10-15T09:00:00Z'), sessionAt('2026-10-15T07:00:00Z')).reading;
  assert.equal(rerun.pending.count, 1, 'a rerun of the same session does not count');
  L.computeCN(higher, state, at('2026-10-16T08:30:00Z'), sessionAt('2026-10-16T07:00:00Z'));
  const d3 = L.computeCN(higher, state, at('2026-10-19T08:30:00Z'), sessionAt('2026-10-19T07:00:00Z')).reading;
  assert.equal(d3.status, 'changed'); assert.equal(d3.valuation.label, 'Slightly expensive'); assert.equal(d3.marginOfSafety, 'Narrow');
  const bad = L.computeCN({...OCT14, csi300PE: '120', cgb10Y: '55%'}, {}, at('2026-10-14T08:30:00Z'), sessionAt('2026-10-14T07:00:00Z'));
  assert.deepEqual(bad.flags.map(f => [f.field, f.check]), [['csi300PE', 'range'], ['cgb10Y', 'range']]);
  assert.equal(bad.reading.valuation, null); assert.equal(bad.reading.status, 'unavailable'); assert.equal(bad.reading.stocksVsBonds, null);
  const jump = L.computeCN({...OCT14, csi300PE: '15.00'}, state, at('2026-10-20T08:30:00Z'), sessionAt('2026-10-20T07:00:00Z'));
  assert.deepEqual(jump.flags.map(f => f.check), ['jump']); assert.equal(jump.reading.status, 'held');
});

test('combine computes the China reading before the analyst, with its state under mpLongTerm.CN', () => {
  const state = {};
  const cn = runNode('combine-all-data1', [{json: {...groundTruth('CN'), ...OCT14}}], {state})[0].json;
  assert.equal(cn.longTermReading.version, 'ltr.cn.v1'); assert.equal(cn.longTermReading.valuation.label, 'Fair');
  assert.match(cn.longTermSummary, /^Valuation: Fair/);
  assert.equal(state.mpLongTerm.CN.confirmed.key, '2-2'); assert.equal(state.mpLongTerm.US, undefined);
  const flagged = runNode('combine-all-data1', [{json: {...groundTruth('CN'), ...OCT14, csi300PE: '120'}}], {state: {}})[0].json;
  assert.ok(flagged._health.suspect.some(f => f.field === 'csi300PE' && f.check === 'range'));
});

test('editorial rule: a China claim resting only on the P/E must be neutral', () => {
  const claim = direction => ({sentiment: 'Cautiously Bearish', confidence: 'Medium', interpretation: 'Prices sit in the middle of their own history.', wisdom: 'Price is what you pay.',
    claims: [{claim: 'The index trades at a middling multiple against its own past.', basedOn: ['csi300PE'], direction}]});
  assert.deepEqual(policy.applyEditorialRules(claim('supports_bearish')).reasonCodes, ['LONG_TERM_DIRECTION']);
  assert.equal(policy.applyEditorialRules(claim('neutral')).ok, true);
  assert.ok(policy.factKeysFor('CN').includes('csi300PE') && policy.factKeysFor('CN').includes('cgb10Y') && policy.factKeysFor('CN').includes('pmiValue'));
});

test('pipeline: the China digest and dashboard carry the reading, the new rows and the sources, within budget', () => {
  const fixture = publishedSourceFixture('CN');
  const data = {...fixture.data, ...OCT14, stockDetails: ['Moutai', 'CATL', 'BYD', 'Alibaba', 'Tencent'].map(n => ({name: n, symbol: n, price: '¥1,286.00', change: '-3.11%'}))};
  const combined = runNode('combine-all-data1', [{json: data}], {state: {}})[0].json;
  const analysis = {sentiment: 'Cautiously Bearish', confidence: 'Medium',
    claims: [{claim: 'Mainland benchmarks fell across the board.', basedOn: ['csi300Change', 'sseCompositeChange', 'szseComponentChange'], direction: 'supports_bearish'},
      {claim: 'The index sits below its long-run trend line.', basedOn: ['csi300VsMa200', 'maSignal'], direction: 'supports_bearish'},
      {claim: 'Factory-gate prices are rising while consumer inflation stays mild.', basedOn: ['ppiValue', 'cpiValue'], direction: 'neutral'},
      {claim: 'The valuation sits in the middle of its own history.', basedOn: ['csi300PE'], direction: 'neutral'}],
    interpretation: 'Prices weakened while the policy rates held and factory-gate inflation climbed. The read moved to cautious from the prior session.',
    wisdom: 'Judge a market against its own history, not against another market\'s.'};
  const r = pipeline('CN', analysis, {data: combined});
  assert.equal(r.data._verification.status, 'PASS');
  const now = Date.parse('2026-09-10T12:05:00Z');
  const check = validateDashboardData(r.payload, {edition: 'CN', now});
  assert.deepEqual(check.errors, []); assert.equal(check.ok, true);
  assert.equal(r.payload.longTermReading.version, 'ltr.cn.v1'); assert.equal(r.payload.longTermReading.valuation.label, 'Fair');
  assert.equal(r.payload.longTermReading.stocksVsBonds.basis, 'nominal'); assert.equal(r.payload.longTermReading.measures.csi300PE.asOf, '2026-10-13');
  assert.deepEqual(r.payload.economic.map(row => row.factKey), ['gdpValue', 'cpiValue', 'unemploymentValue', 'ppiValue', 'pmiValue', 'lpr1Y', 'lpr5Y', 'cgb10Y', 'csi300PE', 'csi300Turnover']);
  assert.deepEqual(r.payload.economic.find(row => row.factKey === 'cpiValue'), {label: 'Inflation/CPI', period: 'Sep 2026', factKey: 'cpiValue', value: '+0.9%'});
  assert.deepEqual(r.payload.sources, ['Yahoo Finance', 'China Securities Index Co.', 'ChinaBond', 'NIFC', 'NBS', 'World Bank', 'Google News']);
  assert.match(r.message, /🧭 <b>LONG-TERM READING<\/b>/); assert.match(r.message, /CSI 300 P\/E <code>13\.10<\/code> <i>\(2026-10-13\)<\/i>/);
  assert.match(r.message, /vs 10Y government bond <code>1\.65%<\/code> <i>\(nominal\)<\/i>/);
  assert.match(r.message, /📈 <b>TREND<\/b> CSI 300 <code>-9\.9%<\/code>/); assert.match(r.message, /LPR 1Y <code>3\.00%<\/code>/); assert.match(r.message, /TURNOVER<\/b> CSI 300 <code>¥368bn<\/code>/);
  assert.match(r.message, /PPI <code>\+5\.0%<\/code> \(Sep 2026\) · PMI <code>50\.1<\/code> \(Sep 2026\)/);
  // Every cited new key renders its evidence under the claim, with a reader-facing label.
  assert.match(r.message, /evidence: CSI 300 vs 200D-MA -9\.9%; Trend Signal Death Cross/);
  assert.match(r.message, /evidence: PPI \+5\.0%; CPI \+0\.9%/); assert.match(r.message, /evidence: CSI 300 P\/E 13\.10/);
  assert.match(r.message, /Yahoo Finance · CSI · ChinaBond · NIFC · NBS · World Bank · Google News/);
  assert.ok(r.message.length <= 3900, 'message is ' + r.message.length + ' characters');
  for (const tag of ['b', 'i', 'code', 'pre', 'blockquote']) {
    assert.equal((r.message.match(new RegExp('<' + tag + '[ >]', 'g')) || []).length, (r.message.match(new RegExp('</' + tag + '>', 'g')) || []).length, tag + ' tags balance');
  }
  // A US-shaped reading under the China edition is refused, and a tampered P/E is caught.
  const tampered = structuredClone(r.payload); tampered.longTermReading.measures.csi300PE.value = '9.0';
  assert.equal(validateDashboardData(tampered, {edition: 'CN', now}).ok, false);
  const wrongBasis = structuredClone(r.payload); delete wrongBasis.longTermReading.stocksVsBonds.basis;
  assert.ok(validateDashboardData(wrongBasis, {edition: 'CN', now}).errors.some(e => e.includes('stocksVsBonds.basis')));
});

test('without the new sources the China edition still publishes as before: no reading block, no reading key, the three annual rows', () => {
  const fixture = publishedSourceFixture('CN');
  const combined = runNode('combine-all-data1', [{json: fixture.data}], {state: {}})[0].json;
  const r = pipeline('CN', fixture.analysis, {data: combined});
  const check = validateDashboardData(r.payload, {edition: 'CN', now: Date.parse('2026-09-10T12:05:00Z')});
  assert.deepEqual(check.errors, []);
  assert.equal(Object.hasOwn(r.payload, 'longTermReading'), false); assert.equal(r.payload.economic.length, 3);
  assert.doesNotMatch(r.message, /LONG-TERM READING/);
  assert.doesNotMatch(r.message, /TREND<\/b> CSI 300/);
});
