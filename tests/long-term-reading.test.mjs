import test from 'node:test';
import assert from 'node:assert/strict';
import L from '../src/n8n/long-term-reading.js';
import policy from '../src/n8n/analysis-policy.js';
import {validateDashboardData} from '../.github/scripts/validate-dashboard-data.mjs';
import {runNode, groundTruth, validAnalysis, pipeline} from './helpers/n8n.mjs';

// Published values from the 2026-10-07 US edition (session time 13:39 UTC, a late wake).
const OCT7 = {buffettIndicator:'251%', shillerPE:'41.9', yieldCurve:'+0.47%', sp500VsMa200:'+7.3%', fearGreedValue:'47',
  fearGreedChange1d:'+0', fearGreedChange1w:'+17', treasury10Y:'5.31%', treasury2Y:'4.84%', cpiValue:'3.35%'};
const at = iso => new Date(iso);
const sessionAt = iso => Date.parse(iso) / 1000;

test('valuation levels follow the existing dashboard bands at every boundary', () => {
  const cape = L.MEASURES.shillerPE.bands, buffett = L.MEASURES.buffettIndicator.bands;
  for (const [value, level] of [[19.99,1],[20,2],[24.99,2],[25,3],[29.99,3],[30,4],[34.99,4],[35,5],[41.9,5]]) assert.equal(L.levelFor(value, cape), level, 'CAPE ' + value);
  for (const [value, level] of [[99.9,1],[100,2],[119.9,2],[120,3],[149.9,3],[150,4],[199.9,4],[200,5],[251,5]]) assert.equal(L.levelFor(value, buffett), level, 'Buffett ' + value);
  assert.deepEqual([1,2,3,4,5].map(L.marginFor), ['Wide','Moderate','Narrow','Thin','Thin']);
  assert.deepEqual([-0.1,0,1.99,2,3.99,4].map(L.gapLabel), ['Bonds pay more','Thin','Thin','Moderate','Moderate','Wide']);
  assert.deepEqual([0,24,25,44,45,55,56,75,76,100].map(L.moodLabel), ['Extreme fear','Extreme fear','Fear','Fear','Neutral','Neutral','Greed','Greed','Extreme greed','Extreme greed']);
  assert.deepEqual([-0.01,0,0.49,0.5].map(L.curveLabel), ['Inverted','Flat','Flat','Normal']);
});

test('the 2026-10-07 reading: very expensive, thin margin, and the exact distances to the next band', () => {
  const state = {};
  const {reading, flags} = L.compute(OCT7, state, at('2026-10-07T13:39:14Z'), sessionAt('2026-10-07T13:39:14Z'));
  assert.deepEqual(flags, []);
  assert.equal(reading.status, 'first'); assert.equal(reading.valuation.label, 'Very expensive'); assert.equal(reading.valuation.topBand, true);
  assert.equal(reading.marginOfSafety, 'Thin');
  assert.deepEqual(reading.stocksVsBonds, {earningsYield:2.4, realYield10Y:2, gap:0.4, label:'Thin'});
  assert.equal(reading.mood.label, 'Neutral'); assert.equal(reading.rates.label, 'Flat');
  const down = reading.changes.find(c => c.kind === 'valuation' && c.direction === 'down');
  assert.equal(down.target, 'Expensive');
  assert.deepEqual(down.conditions.map(c => [c.key, c.threshold, c.movePct, c.met]), [['shillerPE',35,16,false],['buffettIndicator',200,20,false]]);
  assert.equal(reading.changes.some(c => c.kind === 'valuation' && c.direction === 'up'), false, 'no step up from the top band');
  assert.match(L.promptSummary(reading), /^Valuation: Very expensive \(Shiller CAPE 41\.9, Buffett Indicator 251%\)\./);
});

test('one level apart shows a range; two or more apart is a disagreement that holds no level', () => {
  const range = L.compute({...OCT7, buffettIndicator:'190%'}, {}, at('2026-10-07T13:00:00Z'), sessionAt('2026-10-06T20:00:00Z')).reading;
  assert.equal(range.valuation.label, 'Expensive to very expensive'); assert.equal(range.marginOfSafety, 'Thin');
  const down = range.changes.find(c => c.direction === 'down');
  assert.deepEqual(down.conditions.map(c => c.key), ['shillerPE'], 'only the more expensive measure has to move');
  const july = L.compute({...OCT7, buffettIndicator:'137%', shillerPE:'41.0'}, {}, at('2026-08-09T14:47:53Z'), sessionAt('2026-08-07T20:00:00Z'));
  assert.equal(july.reading.today, 'disagree'); assert.equal(july.reading.valuation, null); assert.equal(july.reading.status, 'unavailable');
  assert.deepEqual(july.flags.map(f => [f.field, f.check, f.bound]), [['shillerPE','crosscheck',2],['buffettIndicator','crosscheck',2]]);
});

test('a new level shows only after three distinct market sessions; repeat runs do not count', () => {
  const state = {};
  const run = (buffett, nowIso, sessionIso) => L.compute({...OCT7, shillerPE:'34.0', buffettIndicator:buffett}, state, at(nowIso), sessionAt(sessionIso)).reading;
  assert.equal(run('195%', '2026-11-03T14:00:00Z', '2026-11-02T21:00:00Z').status, 'first');   // Expensive (both level 4)
  const first = run('205%', '2026-11-04T14:00:00Z', '2026-11-03T21:00:00Z');                   // Buffett crosses into level 5
  assert.equal(first.status, 'pending'); assert.equal(first.valuation.label, 'Expensive'); assert.equal(first.pending.count, 1);
  assert.equal(run('205%', '2026-11-04T15:00:00Z', '2026-11-03T21:00:00Z').pending.count, 1, 'a repeat run of the same session does not count');
  assert.equal(run('206%', '2026-11-05T14:00:00Z', '2026-11-04T21:00:00Z').pending.count, 2);
  const third = run('207%', '2026-11-06T14:00:00Z', '2026-11-05T21:00:00Z');
  assert.equal(third.status, 'changed'); assert.equal(third.valuation.label, 'Expensive to very expensive');
  assert.deepEqual(state.history, [{date:'2026-11-06', from:'4-4', to:'4-5'}]);
});

test('input checks: implausible range and session-to-session jumps make a measure unavailable for the day', () => {
  const range = L.compute({...OCT7, shillerPE:'95'}, {}, at('2026-10-07T13:00:00Z'), sessionAt('2026-10-06T20:00:00Z'));
  assert.deepEqual(range.flags.map(f => [f.field, f.check]), [['shillerPE','range']]);
  assert.equal(range.reading.today, 'unavailable'); assert.equal(range.reading.measures.shillerPE, null);
  const state = {};
  L.compute(OCT7, state, at('2026-10-07T13:00:00Z'), sessionAt('2026-10-06T20:00:00Z'));
  const jumped = L.compute({...OCT7, buffettIndicator:'139%'}, state, at('2026-10-08T13:00:00Z'), sessionAt('2026-10-07T20:00:00Z'));
  assert.deepEqual(jumped.flags.map(f => [f.field, f.check]), [['buffettIndicator','jump']]);
  assert.equal(jumped.reading.status, 'held'); assert.equal(jumped.reading.valuation.label, 'Very expensive');
  const after = L.compute({...OCT7, buffettIndicator:'139%'}, state, at('2026-10-09T13:00:00Z'), sessionAt('2026-10-08T20:00:00Z'));
  assert.equal(after.flags.some(f => f.check === 'jump'), false, 'a level that persists is compared with itself next session');
  assert.equal(after.flags.some(f => f.check === 'crosscheck'), true, 'and the cross-check still catches the July-style error');
});

test('freshness says which session the prices come from, including closures and late wakes', () => {
  const us = (sessionIso, nowIso) => L.freshness('US', sessionAt(sessionIso), at(nowIso));
  const normal = us('2026-10-06T20:00:00Z', '2026-10-07T13:00:00Z');
  assert.equal(normal.label, 'Prices as of the Tue, Oct 6 close'); assert.equal(normal.closed, false); assert.equal(normal.intraday, false);
  const late = us('2026-10-07T13:39:14Z', '2026-10-07T13:40:48Z');
  assert.equal(late.label, 'Prices as of Wed, Oct 7, 09:39 ET (market open)'); assert.equal(late.intraday, true);
  assert.equal(us('2026-10-09T20:00:00Z', '2026-10-12T13:00:00Z').closed, false, 'Monday sees Friday');
  assert.equal(us('2026-10-09T20:00:00Z', '2026-10-13T13:00:00Z').closed, true, 'Tuesday after a Monday holiday');
  assert.equal(us('2026-10-09T20:00:00Z', '2026-10-10T13:00:00Z').closed, false, 'weekend editions see Friday');
  const cn = L.freshness('CN', 1790751634, at('2026-10-07T08:30:00Z'));
  assert.equal(cn.label, 'Prices as of the Wed, Sep 30 close · no trading session since'); assert.equal(cn.closed, true);
  assert.equal(L.freshness('CN', sessionAt('2026-10-08T07:00:00Z'), at('2026-10-08T08:30:00Z')).closed, false);
  assert.equal(L.freshness('US', null, at('2026-10-07T13:00:00Z')).available, false);
});

test('replay: July–August values trip the cross-check every edition; September–October read very expensive throughout', () => {
  const july = [['139%','42.2'],['139%','41.9'],['139%','40.6'],['136%','40.6'],['136%','42.4']];
  const state = {};
  july.forEach(([buffett, cape], i) => {
    const r = L.compute({...OCT7, buffettIndicator:buffett, shillerPE:cape}, state, at(`2026-07-2${i}T13:00:00Z`), sessionAt(`2026-07-1${i + 5}T20:00:00Z`));
    assert.equal(r.flags.filter(f => f.check === 'crosscheck').length, 2, buffett + '/' + cape);
    assert.equal(r.reading.valuation, null);
  });
  const autumn = [['250%','41.6'],['248%','41.3'],['249%','41.5'],['246%','41.1'],['245%','41.0'],['248%','41.4'],['249%','41.7'],['251%','41.9']];
  const s2 = {};
  autumn.forEach(([buffett, cape], i) => {
    const r = L.compute({...OCT7, buffettIndicator:buffett, shillerPE:cape}, s2, at(`2026-09-${23 + i}T13:00:00Z`), sessionAt(`2026-09-${22 + i}T20:00:00Z`));
    assert.deepEqual(r.flags, []); assert.equal(r.reading.valuation.label, 'Very expensive');
  });
});

test('combine computes the US reading before the analyst; CN computes its own rules (ltr.cn.v1)', () => {
  const data = {...groundTruth('US'), ...OCT7};
  const state = {};
  const us = runNode('combine-all-data', [{json:data}], {state})[0].json;
  assert.equal(us.longTermReading.valuation.label, 'Very expensive'); assert.match(us.longTermSummary, /^Valuation: Very expensive/);
  assert.equal(state.mpLongTerm.US.confirmed.key, '5-5');
  const flagged = runNode('combine-all-data', [{json:{...data, buffettIndicator:'137%'}}], {state:{}})[0].json;
  assert.equal(flagged._health.suspect.filter(f => f.check === 'crosscheck').length, 2);
  const cn = runNode('combine-all-data1', [{json:groundTruth('CN')}], {state:{}})[0].json;
  assert.equal(cn.longTermReading.version, 'ltr.cn.v1'); assert.equal(cn.longTermReading.valuation, null);
  assert.match(cn.longTermSummary, /not available in this edition/);
});

test('editorial rules: long-term-only claims must be neutral and advice never reaches readers', () => {
  const facts = {buffettIndicator:'251%', shillerPE:'41.9', vix:'15.81'};
  const base = {sentiment:'Cautiously Bearish', confidence:'High', interpretation:'Prices sit far above long-run norms. Volatility rose.', wisdom:'Price is what you pay, value is what you get.',
    claims:[{claim:'Valuations remain far above historical norms.', basedOn:['buffettIndicator','shillerPE'], direction:'supports_bearish'},
            {claim:'Volatility ticked higher.', basedOn:['vix'], direction:'supports_bearish'}]};
  const valid = policy.validateAnalysis(base, {facts}); assert.equal(valid.ok, true);
  assert.deepEqual(policy.applyEditorialRules(valid.analysis).reasonCodes, ['LONG_TERM_DIRECTION']);
  const neutral = structuredClone(valid.analysis); neutral.claims[0].direction = 'neutral';
  assert.equal(policy.applyEditorialRules(neutral).ok, true);
  const advisingClaim = structuredClone(neutral); advisingClaim.claims[1].claim = 'Investors should trim positions as volatility rises.';
  assert.deepEqual(policy.applyEditorialRules(advisingClaim).reasonCodes, ['ADVICE_IN_CLAIM']);
  const advisingText = structuredClone(neutral);
  advisingText.interpretation = 'Prices sit far above long-run norms. Value investors should prioritize cash preservation.';
  advisingText.wisdom = 'Investors should be fearful when others are greedy.';
  const trimmed = policy.applyEditorialRules(advisingText);
  assert.equal(trimmed.ok, true); assert.deepEqual(trimmed.notes, ['ADVICE_TRIMMED']);
  assert.equal(trimmed.analysis.interpretation, 'Prices sit far above long-run norms.'); assert.equal(trimmed.analysis.wisdom, '');
  assert.equal(policy.validateAnalysis(trimmed.analysis, {facts}).ok, true, 'a trimmed analysis re-validates');
  const onlyAdvice = structuredClone(neutral); onlyAdvice.interpretation = 'We recommend caution.';
  assert.deepEqual(policy.applyEditorialRules(onlyAdvice).reasonCodes, ['ADVICE_ONLY_TEXT']);
});

test('editorial rules: a recommended stance is advice, while describing a stance is not', () => {
  // The first two are the only such sentences in 50 published editions (US 2026-10-07 and a CN edition);
  // the rule matched no published claim, so it would never have withheld an analysis.
  for (const sentence of ['Consequently, a cautious stance that leans bearish is appropriate.',
    'Although offshore markets remain resilient, the persistent weakness in consumer demand coupled with mainland selling pressure suggests a more defensive stance is warranted.',
    'It is prudent to wait for confirmation.', 'It’s wise to stay patient here.', 'Caution is warranted while volatility stays high.']) {
    assert.equal(policy.advises(sentence), true, sentence);
  }
  for (const sentence of ['The Fed kept a restrictive stance.', 'Volatility remains elevated, which is consistent with a cautious market mood.',
    'Prices sit far above long-run norms, leaving a thin margin of safety.', 'Positioning in futures remains crowded.']) {
    assert.equal(policy.advises(sentence), false, sentence);
  }
  const facts = {buffettIndicator:'251%', shillerPE:'41.9'};
  const analysis = {sentiment:'Cautiously Bearish', confidence:'High', wisdom:'',
    interpretation:'Equity valuations are still far above what earnings and GDP would justify. Consequently, a cautious stance that leans bearish is appropriate.',
    claims:[{claim:'Valuations remain far above historical norms.', basedOn:['buffettIndicator','shillerPE'], direction:'neutral'}]};
  const trimmed = policy.applyEditorialRules(policy.validateAnalysis(analysis, {facts}).analysis);
  assert.equal(trimmed.analysis.interpretation, 'Equity valuations are still far above what earnings and GDP would justify.');
  assert.deepEqual(trimmed.notes, ['ADVICE_TRIMMED']);
});

test('pipeline: a bearish valuation-only claim is withheld; a neutral one is published with the reading', () => {
  const data = {...groundTruth('US'), ...OCT7, sp500MarketTime:sessionAt('2026-09-09T20:00:00Z')};
  const combined = runNode('combine-all-data', [{json:data}], {state:{}})[0].json;
  const bearish = {...validAnalysis('US'), claims:[{claim:'Valuations remain far above historical norms.', basedOn:['buffettIndicator','shillerPE'], direction:'supports_bearish'},
    {claim:'Equities face pressure.', basedOn:['sp500Change'], direction:'supports_bearish'}]};
  const withheld = pipeline('US', bearish, {data:combined});
  assert.equal(withheld.data._verification.status, 'FAIL'); assert.deepEqual([...withheld.data._verification.reasonCodes], ['LONG_TERM_DIRECTION']);
  bearish.claims[0].direction = 'neutral';
  const ok = pipeline('US', bearish, {data:combined});
  assert.equal(ok.data._verification.status, 'PASS');
  assert.match(ok.message, /🧭 <b>LONG-TERM READING<\/b>/); assert.match(ok.message, /Valuation · VERY EXPENSIVE/);
  assert.match(ok.message, /CAPE under <code>35<\/code> and Buffett Indicator under <code>200%<\/code> \(≈16% \/ 20% lower\)/);
  assert.match(ok.message, /🕒 <i>Prices as of the Wed, Sep 9 close<\/i>/);
  assert.equal(ok.payload.longTermReading.valuation.label, 'Very expensive'); assert.equal(ok.payload.asOf.closed, false);
  assert.equal(validateDashboardData(ok.payload, {edition:'US', now:Date.parse('2026-09-10T12:05:00Z')}).ok, true);
  const cn = pipeline('CN', validAnalysis('CN'));
  assert.doesNotMatch(cn.message, /LONG-TERM READING/); assert.equal(Object.hasOwn(cn.payload, 'longTermReading'), false);
});

test('contract: the published reading must quote the published facts', () => {
  const data = {...groundTruth('US'), ...OCT7};
  const combined = runNode('combine-all-data', [{json:data}], {state:{}})[0].json;
  const ok = pipeline('US', validAnalysis('US'), {data:combined});
  const now = Date.parse('2026-09-10T12:05:00Z');
  assert.equal(validateDashboardData(ok.payload, {edition:'US', now}).ok, true);
  const tampered = structuredClone(ok.payload); tampered.longTermReading.measures.shillerPE.value = '20.0';
  assert.equal(validateDashboardData(tampered, {edition:'US', now}).ok, false);
  const wrongEdition = structuredClone(ok.payload); wrongEdition.edition = 'CN';
  assert.ok(validateDashboardData(wrongEdition, {now}).errors.some(e => e.startsWith('longTermReading')));
  const badAsOf = structuredClone(ok.payload); badAsOf.asOf.closed = 'no';
  assert.equal(validateDashboardData(badAsOf, {edition:'US', now}).ok, false);
});

test('the US digest with the long-term reading stays within the 3,900-character budget', () => {
  const data = {...groundTruth('US'), ...OCT7, sp500:'7770.67', sp500Change:'-0.62%', dowJones:'51073.31', dowJonesChange:'-0.87%', vix:'15.81', vixChange:'+5.33%',
    gold:'$4116.60', goldChange:'-1.68%', oil:'$90.39', oilChange:'+1.06%', dxy:'102.42', dxyChange:'+0.58%', btc:'$83,060', btcChange:'-2.91%',
    gdpValue:'+2.2% (QoQ annualized)', gdpYear:'Apr 2026', cpiValue:'3.35%', cpiYear:'Aug 2026', unemploymentValue:'4.2%', unemploymentYear:'Sep 2026', fedRateValue:'4.00%',
    stockDetails:['GOOGL','BABA','ADBE','SOFI','ASML'].map(n => ({name:n, symbol:n, price:'$1792.88', change:'-2.25%'}))};
  const combined = runNode('combine-all-data', [{json:data}], {state:{}})[0].json;
  const analysis = {sentiment:'Cautiously Bearish', confidence:'High',
    claims:[{claim:'Overall equity valuations are markedly above historical norms, limiting margin of safety.', basedOn:['buffettIndicator','shillerPE'], direction:'neutral'},
      {claim:'The flattening yield curve signals heightened uncertainty about future growth.', basedOn:['yieldCurve'], direction:'supports_bearish'},
      {claim:'Equity momentum remains positive as the broad market trades above its long term trend line.', basedOn:['sp500VsMa200'], direction:'supports_bullish'},
      {claim:'Market volatility has ticked higher, reflecting increasing investor nervousness.', basedOn:['vix','vixChange'], direction:'supports_bearish'}],
    interpretation:'Equity valuations are still far above what earnings and output would justify, eroding the safety cushion that value investors seek. At the same time, price momentum is strong, though the flat yield curve and rising volatility point to meaningful downside risk.',
    wisdom:'Price is what you pay, value is what you get.'};
  const r = pipeline('US', analysis, {data:combined});
  assert.equal(r.data._verification.status, 'PASS');
  assert.ok(r.message.length <= 3900, 'message is ' + r.message.length + ' characters');
  for (const tag of ['b','i','code','pre','blockquote']) {
    assert.equal((r.message.match(new RegExp('<' + tag + '[ >]', 'g')) || []).length, (r.message.match(new RegExp('</' + tag + '>', 'g')) || []).length, tag + ' tags balance');
  }
});
