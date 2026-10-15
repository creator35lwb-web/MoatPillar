import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { buildNodeSource } from '../scripts/node-source.mjs';

async function runFetchingNode(name, respond, input = { watchlist: 'ACME' }) {
  const requested = [], delays = [], logs = [];
  class FixedDate extends Date { static now() { return 1789066800000; } }
  const output = await vm.runInNewContext('(async function(){\n' + buildNodeSource(name) + '\n}).call({helpers})', {
    helpers: { async httpRequest(options) {
      requested.push(structuredClone(options));
      return respond(options, requested.length);
    } },
    $input: { first: () => ({ json: input }) }, Date: FixedDate,
    setTimeout(callback, milliseconds) { delays.push(milliseconds); callback(); },
    console: { log(...args) { logs.push(args.join(' ')); }, error(...args) { logs.push(args.join(' ')); } },
  }, { timeout: 2000 });
  return { data: structuredClone(output[0].json), requested, delays, logs };
}

// Run the actual Code-node bodies with local responses and immediate timers.
// There is no network function in the sandbox, and each test expects one request.
async function fetchStock(edition, meta) {
  const name = edition === 'US' ? 'Fetch Stock Prices' : 'Fetch CN Stock Prices';
  const { data, requested } = await runFetchingNode(name, () => ({ chart: { result: [{ meta: { regularMarketPrice: 100, currency: 'CNY', ...meta } }] } }));
  assert.equal(requested.length, 1);
  assert.match(requested[0].url, /\/ACME\?/);
  assert.equal(data.stockDetails.length, 1);
  return data;
}

test('US stock retries qualifying network errors and preserves backoff and request options', async () => {
  const { data, requested, delays } = await runFetchingNode('Fetch Stock Prices', (_, attempt) => {
    if (attempt < 3) throw new Error('ENETUNREACH');
    return { chart: { result: [{ meta: { regularMarketPrice: 105, chartPreviousClose: 100 } }] } };
  });
  assert.equal(requested.length, 3);
  assert.deepEqual(requested[1], requested[0]);
  assert.equal(requested[0].method, 'GET');
  assert.equal(requested[0].timeout, 15000);
  assert.deepEqual(delays, [2000, 4000, 500]);
  assert.equal(data.stockDetails[0].change, '+5.00%');
});

for (const [name, error] of [['Fetch Stock Prices', 'HTTP 403'], ['Fetch CN Stock Prices', 'ENETUNREACH']]) {
  test(`${name}: terminal failure stays explicit without adding retries`, async () => {
    const { data, requested } = await runFetchingNode(name, () => { throw new Error(error); });
    assert.equal(requested.length, 1);
    assert.equal(data.stockDetails[0].price, 'N/A');
    assert.equal(data.stockDetails[0].change, 'N/A');
  });
}

const sourceRss = '<rss><title>Feed</title><item><title><![CDATA[Market earnings &amp; outlook - Example News]]></title><link><![CDATA[https://example.com/earnings]]></link></item><item><title>Another market report title</title><link>javascript:invalid</link></item></rss>';
// China's official sources (W32), served from the fixtures read on 2026-10-14. Order matters: a release page before the listing.
const CN_FIXTURES = [
  ['csindex.com.cn', () => JSON.parse(readFileSync('tests/fixtures/cn/csi-perf-october.json', 'utf8'))],
  ['chinabond.com.cn', () => readFileSync('tests/fixtures/cn/chinabond-history.html', 'utf8')],
  ['chinamoney.com.cn', () => JSON.parse(readFileSync('tests/fixtures/cn/nifc-lpr.json', 'utf8'))],
  ['stats.gov.cn/sj/zxfb/2026', () => readFileSync('tests/fixtures/cn/nbs-pmi.html', 'utf8')],
  ['stats.gov.cn/sj/zxfb/', () => readFileSync('tests/fixtures/cn/nbs-listing.html', 'utf8')],
];
function marketResponse({ url }, rss = sourceRss) {
  for (const [host, load] of CN_FIXTURES) if (url.includes(host)) return load();
  if (url.includes('finance.yahoo.com')) return { chart: { result: [{
    meta: { regularMarketPrice: 105, chartPreviousClose: 80, previousClose: 90, regularMarketTime: 1789066800 },
    indicators: { quote: [{ close: url.includes('%5EGSPC') ? [...Array(199).fill(100), 100, 105] : [105] }] },
  }] } };
  if (url.includes('cnn.io')) return { fear_and_greed: { score: 64, rating: 'greed', previous_close: 60, previous_1_week: 55 } };
  if (url.includes('multpl.com')) return 'Current Shiller PE Ratio 25.5';
  if (url.includes('stlouisfed.org')) return { observations: Array.from({ length: 13 }, (_, index) => ({ value: String(index === 0 ? 110 : 100), date: '2026-07-01' })) };
  if (url.includes('worldbank.org')) return [{}, [{ value: 4.5, date: '2025' }]];
  return rss;
}

// CN: six Yahoo quotes, CSI, ChinaBond, NIFC, three World Bank series, the NBS listing and the RSS feed; the
// PMI page is requested only when the listing links one (W32).
for (const [edition, name, expectedRequests] of [['US', 'Fetch All Market Data', 18], ['CN', 'Fetch All China Market Data', 15]]) {
  test(`${edition}: shared market helpers retain source requests, RSS evidence, and health signals`, async () => {
    const { data, requested } = await runFetchingNode(name, options => marketResponse(options));
    assert.equal(requested.length, expectedRequests);
    assert.equal(data._health.status, 'OK');
    assert.deepEqual(data._health.failed, []);
    assert.deepEqual(data._health.missing, []);
    assert.equal(data.headlinesCount, 2);
    assert.deepEqual(data.headlinesLinks, ['https://example.com/earnings', null]);
    assert.equal(data.headlinesList[0], edition === 'CN' ? 'Market earnings & outlook' : 'Market earnings & outlook - Example News');
    assert.ok(data._health.suspect.some(item => item.field === 'goldChange'));
    if (edition === 'US') {
      assert.equal(data.sp500Change, '+5.00%');
      assert.equal(data.sp500MarketTime, 1789066800);
      assert.ok(requested.some(request => request.url.includes('%5EGSPC?interval=1d&range=1y')));
      assert.match(data.gdpValue, /QoQ annualized/);
    } else {
      assert.equal(data.csi300, '105.00');
      assert.equal(data.gold, '$105.00');
      assert.equal(data.usdCny, '105.0000');
      assert.equal(data.csi300MarketTime, 1789066800);
      // W32: the valuation, the bond yield, the policy rates and the monthly prices, each with its own date.
      assert.equal(data.csi300PE, '13.10'); assert.equal(data.csi300PEDate, '2026-10-13');
      assert.equal(data.csi300Turnover, '442'); assert.equal(data.csi300VsMa200, 'N/A');
      assert.equal(data.cgb10Y, '1.65%'); assert.equal(data.cgb10YDate, '2026-10-14');
      assert.deepEqual([data.lpr1Y, data.lpr5Y, data.lprDate], ['3.00%', '3.50%', '2026-09-20']);
      assert.deepEqual([data.cpiValue, data.cpiYear, data.cpiSource], ['+0.9%', 'Sep 2026', 'NBS']);
      assert.deepEqual([data.ppiValue, data.ppiMonth], ['+5.0%', 'Sep 2026']);
      assert.deepEqual([data.pmiValue, data.pmiNonMfg, data.pmiMonth], ['50.1', '50.2', 'Sep 2026']);
      assert.equal(data.gdpYear, '2025');
    }
  });
  test(`${edition}: source failures retain outage, failure codes, and missing fields`, async () => {
    const { data, requested } = await runFetchingNode(name, () => { throw Object.assign(new Error('HTTP 503'), { code: 'UPSTREAM' }); });
    // Each edition skips one dependent request when its source fails: the US 200-day history, the China PMI page.
    assert.equal(requested.length, expectedRequests - 1);
    assert.equal(data._health.status, 'OUTAGE');
    assert.ok(data._health.missing.length >= 8);
    assert.ok(data._health.failed.every(failure => failure.code === 'UPSTREAM'));
    assert.equal(data.headlinesCount, 0);
  });
  test(`${edition}: title-only RSS fallback retains evidence with unavailable links`, async () => {
    const { data } = await runFetchingNode(name, options => marketResponse(options, '<rss><title>Feed</title><title>Long market update title</title></rss>'));
    assert.deepEqual(data.headlinesList, ['Long market update title']);
    assert.deepEqual(data.headlinesLinks, [null]);
  });
}

// On 2026-10-09 Yahoo gave SSE and SZSE a prior close of 0.0002050505, and the China post printed
// +1859927722.66%. A prior close outside half to double today's price is broken source data, so the
// change reads N/A. A large move that is still possible stays published and flagged, as before.
function chinaResponse(priorBySymbol) {
  return options => {
    if (!options.url.includes('finance.yahoo.com')) return marketResponse(options);
    const symbol = decodeURIComponent(options.url.split('/chart/')[1].split('?')[0]);
    return { chart: { result: [{
      meta: { regularMarketPrice: 105, chartPreviousClose: 100, regularMarketTime: 1789066800, ...priorBySymbol[symbol] },
      indicators: { quote: [{ close: [105] }] },
    }] } };
  };
}
const fetchChina = priorBySymbol => runFetchingNode('Fetch All China Market Data', chinaResponse(priorBySymbol));

test('CN: a broken prior close reads N/A instead of an impossible change', async () => {
  const broken = { chartPreviousClose: 0.0002050505, previousClose: null };
  const { data } = await fetchChina({ '000001.SS': broken, '399001.SZ': broken });
  assert.equal(data.sseComposite, '105.00');
  assert.equal(data.sseCompositeChange, 'N/A');
  assert.equal(data.szseComponentChange, 'N/A');
  assert.equal(data.csi300Change, '+5.00%');
  assert.equal(data.hangSengChange, '+5.00%');
  assert.equal(data._health.status, 'OK');
  assert.deepEqual(data._health.suspect || [], []);
});

test('CN: a usable alternate prior close replaces a broken chart close', async () => {
  const { data } = await fetchChina({ '000001.SS': { chartPreviousClose: 0.0002050505, previousClose: 100 } });
  assert.equal(data.sseCompositeChange, '+5.00%');
});

test('CN: a large but possible move is still published and flagged, not withheld', async () => {
  const { data } = await fetchChina({ '000001.SS': { chartPreviousClose: 84 } });
  assert.equal(data.sseCompositeChange, '+25.00%');
  assert.ok(data._health.suspect.some(item => item.field === 'sseCompositeChange'));
});

test('CN: a prior close counts only strictly between half and double today\'s price', async () => {
  for (const [prior, expected] of [[52.5, 'N/A'], [52.6, '+99.62%'], [209.9, '-49.98%'], [210, 'N/A']]) {
    const { data } = await fetchChina({ '000001.SS': { chartPreviousClose: prior } });
    assert.equal(data.sseCompositeChange, expected, String(prior));
  }
});

for (const edition of ['US', 'CN']) {
  for (const prior of [undefined, null, 0, -1, NaN, Infinity, '100', {}, []]) {
    test(`${edition}: unavailable prior close ${String(prior)} never becomes a flat return`, async () => {
      const data = await fetchStock(edition, { chartPreviousClose: prior });
      assert.equal(data.stockDetails[0].change, 'N/A');
      assert.match(data.watchlistSummary, /\(N\/A\)/);
      assert.doesNotMatch(data.watchlistSummary, /\+0\.00%/);
      if (edition === 'CN') assert.equal(data.stockDetails[0].arrow, '');
    });
  }
  test(`${edition}: unchanged prices retain a valid zero return`, async () => {
    const data = await fetchStock(edition, { chartPreviousClose: 100 });
    assert.equal(data.stockDetails[0].change, '+0.00%');
  });
  test(`${edition}: finite positive prior close preserves directional changes`, async () => {
    for (const [price, expected] of [[105, '+5.00%'], [95, '-5.00%']]) {
      const data = await fetchStock(edition, { regularMarketPrice: price, chartPreviousClose: 100 });
      assert.equal(data.stockDetails[0].change, expected);
    }
  });
  test(`${edition}: valid alternate prior close recovers absent or malformed chart close`, async () => {
    for (const prior of [undefined, null, 0, -1, NaN, Infinity, 'invalid']) {
      const data = await fetchStock(edition, { regularMarketPrice: 105, chartPreviousClose: prior, previousClose: 100 });
      assert.equal(data.stockDetails[0].change, '+5.00%');
    }
  });
  test(`${edition}: chart close remains preferred when both numeric closes are usable`, async () => {
    const data = await fetchStock(edition, { regularMarketPrice: 105, chartPreviousClose: 100, previousClose: 50 });
    assert.equal(data.stockDetails[0].change, '+5.00%');
  });
  test(`${edition}: overflowed return is unavailable`, async () => {
    const data = await fetchStock(edition, { chartPreviousClose: Number.MIN_VALUE });
    assert.equal(data.stockDetails[0].change, 'N/A');
    if (edition === 'CN') assert.equal(data.stockDetails[0].arrow, '');
  });
}

// 2026-10-14: Google News search RSS ranks by relevance unless the query carries when:1d. Without it the
// China edition published the same May–August articles for a week and cited them as today's evidence.
test('CN: the headline feed asks Google News for same-day items only', async () => {
  const { requested, data } = await runFetchingNode('Fetch All China Market Data', options => marketResponse(options));
  const rss = requested.filter(request => request.url.includes('news.google.com/rss/search'));
  assert.equal(rss.length, 1);
  assert.match(rss[0].url, /[?&]q=[^&]*when:1d/);
  assert.match(rss[0].url, /&hl=en&gl=US&ceid=US:en$/);
  assert.equal(data.headlinesCount, 2);
});

// W32: a year of CSI sessions gives the 200-day trend; a short series does not, and nothing is invented.
test('CN: the CSI 300 trend needs two hundred sessions and reads from the official closes', async () => {
  const series = n => ({ data: Array.from({ length: n }, (_, i) => ({ tradeDate: String(20260101 + i), close: 4000 + i, tradingVol: 1e9 + i, tradingValue: 4000, peg: 13 })) });
  const long = await runFetchingNode('Fetch All China Market Data', options => options.url.includes('csindex.com.cn') ? series(210) : marketResponse(options));
  assert.equal(long.data.maSignal, 'Golden Cross');
  assert.match(long.data.csi300VsMa200, /^\+\d+\.\d%$/);
  assert.equal(long.data.csi300PE, '13.00');
  const short = await runFetchingNode('Fetch All China Market Data', options => options.url.includes('csindex.com.cn') ? series(120) : marketResponse(options));
  assert.equal(short.data.csi300VsMa200, 'N/A'); assert.equal(short.data.maSignal, 'N/A');
  // The World Bank annual CPI stays when the NBS listing carries no release.
  const noNbs = await runFetchingNode('Fetch All China Market Data', options => options.url.includes('stats.gov.cn') ? '<html></html>' : marketResponse(options));
  assert.deepEqual([noNbs.data.cpiYear, noNbs.data.cpiSource, noNbs.data.ppiValue], ['2025', 'World Bank', 'N/A']);
  assert.ok(noNbs.data._health.failed.some(f => f.source === 'NBS releases'));
});
