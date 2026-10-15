// ============================================
// FETCH ALL MARKET DATA - MarketPulse v6.0 (CN)
// China Market Edition
// Data Sources: Yahoo Finance, World Bank, China Securities Index Co., ChinaBond, NIFC, NBS, Google News
// ============================================


// ===== DATA-HEALTH INSTRUMENTATION (hardening) =====
// LOUD failures so N/A can never masquerade as success.
// Grep n8n logs:  [MarketPulse][FETCH-FAIL] / [MarketPulse][DATA-HEALTH]
const { health, fail } = createMarketHealth();

// Time budget (the US node's pattern): return what was fetched before n8n's 300 s limit, with
// health flags set, rather than nothing. Sources added in W32 are skipped when little time is left.
const NODE_START = Date.now();
const TIME_BUDGET_MS = 235000;
const RETRY_RESERVE_MS = 20000;
function msLeft() { return TIME_BUDGET_MS - (Date.now() - NODE_START); }
const safeFetch = retrySourceFetch(options => this.helpers.httpRequest(options), {
  msLeft, reserveMs: RETRY_RESERVE_MS, includeNetwork: true,
  logRetry: (attempt, options) => console.log('Retry ' + attempt + '/2 (' + Math.round(msLeft() / 1000) + 's budget left): ' + (options.url || '').substring(0, 60))
});
const isoDay = date => date.toISOString().slice(0, 10);

const results = {
  // China Market Indices
  csi300: 'N/A',
  csi300Change: 'N/A',
  sseComposite: 'N/A',
  sseCompositeChange: 'N/A',
  szseComponent: 'N/A',
  szseComponentChange: 'N/A',
  hangSeng: 'N/A',
  hangSengChange: 'N/A',
  // Commodities & Forex
  gold: 'N/A',
  goldChange: 'N/A',
  usdCny: 'N/A',
  usdCnyChange: 'N/A',
  // Economic Indicators (World Bank - China)
  gdpValue: 'N/A',
  gdpYear: 'N/A',
  cpiValue: 'N/A',
  cpiYear: 'N/A',
  unemploymentValue: 'N/A',
  unemploymentYear: 'N/A',
  // News Headlines
  headlines: 'No headlines available',
  csi300MarketTime: null,
  headlinesList: [],
  headlinesCount: 0,
  // Valuation, rates, trend and monthly prices (W32). Each value carries its own date.
  csi300PE: 'N/A', csi300PEDate: 'N/A', csi300Turnover: 'N/A', csi300VsMa200: 'N/A', maSignal: 'N/A',
  cgb10Y: 'N/A', cgb10YDate: 'N/A',
  lpr1Y: 'N/A', lpr5Y: 'N/A', lprDate: 'N/A',
  ppiValue: 'N/A', ppiMonth: 'N/A', pmiValue: 'N/A', pmiNonMfg: 'N/A', pmiMonth: 'N/A',
  cpiSource: 'World Bank'
};

// --- Helper Functions ---

function formatPct(price, prevClose) {
  if (!price || !prevClose || prevClose === 0) return 'N/A';
  const changePct = ((price - prevClose) / prevClose) * 100;
  const sign = changePct >= 0 ? '+' : '';
  return sign + changePct.toFixed(2) + '%';
}

// --- 1. FETCH CHINA MARKET INDICES (Yahoo Finance) ---

const indices = [
  { symbol: '000300.SS', namePrice: 'csi300', nameChange: 'csi300Change', label: 'CSI 300' },
  { symbol: '000001.SS', namePrice: 'sseComposite', nameChange: 'sseCompositeChange', label: 'SSE Composite' },
  { symbol: '399001.SZ', namePrice: 'szseComponent', nameChange: 'szseComponentChange', label: 'SZSE Component' },
  { symbol: '^HSI', namePrice: 'hangSeng', nameChange: 'hangSengChange', label: 'Hang Seng' },
  { symbol: 'GC=F', namePrice: 'gold', nameChange: 'goldChange', label: 'Gold', prefix: '$' },
  { symbol: 'CNY=X', namePrice: 'usdCny', nameChange: 'usdCnyChange', label: 'USD/CNY' }
];

for (const idx of indices) {
  try {
    const result = yahooChartResult(await this.helpers.httpRequest(yahooChartRequest(idx.symbol)));
    if (result) {
      const meta = result.meta;
      const price = meta.regularMarketPrice;
      // The exchange timestamp distinguishes a new trading session from a rerun.
      if (idx.symbol === '000300.SS' && meta.regularMarketTime) results.csi300MarketTime = meta.regularMarketTime;
      // A prior close below half or above double today's price is broken source data, not a
      // market move: on 2026-10-09 Yahoo gave SSE and SZSE a prior close of 0.0002050505, and
      // the post printed +1859927722.66%. Treat it as missing, so the change reads N/A.
      const prevClose = [meta.chartPreviousClose, meta.previousClose]
        .find(value => typeof value === 'number' && value > price / 2 && value < price * 2);
      if (price) {
        const formatted = idx.symbol === 'CNY=X' ? price.toFixed(4)
          : price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        results[idx.namePrice] = (idx.prefix || '') + formatted;
        if (prevClose && prevClose > 0) results[idx.nameChange] = formatPct(price, prevClose);
      }
    }
    await fetchDelay(500);
  } catch (e) { fail(idx.label, e); }
}

// --- 2. CSI 300 VALUATION, TURNOVER AND TREND (China Securities Index Co.) ---
// One request for the last 320 days: the trailing P/E (published after the session, so the latest
// row with one carries its own date), turnover, and the closes for the 200-day average (W29).
try {
  if (msLeft() > RETRY_RESERVE_MS) {
    const end = new Date(), start = new Date(end.getTime() - 320 * 86400000);
    const perf = parseCsiPerformance(await safeFetch({ method: 'GET', timeout: 20000,
      url: 'https://www.csindex.com.cn/csindex-home/perf/index-perf?indexCode=000300&startDate=' + isoDay(start).replaceAll('-', '') + '&endDate=' + isoDay(end).replaceAll('-', '') }));
    if (perf && perf.pe !== null) { results.csi300PE = perf.pe.toFixed(2); results.csi300PEDate = perf.peDate; }
    if (perf && perf.turnoverBn !== null) results.csi300Turnover = perf.turnoverBn.toFixed(0);
    if (perf && perf.vsMa200 !== null) { results.csi300VsMa200 = (perf.vsMa200 >= 0 ? '+' : '') + perf.vsMa200.toFixed(1) + '%'; results.maSignal = perf.maSignal; }
    if (!perf) fail('CSI 300 valuation', new Error('no sessions in the response'));
  }
} catch (e) { fail('CSI 300 valuation', e); }

// --- 2b. CHINA 10-YEAR GOVERNMENT BOND YIELD (ChinaBond, CCDC) ---
try {
  if (msLeft() > RETRY_RESERVE_MS) {
    const end = new Date(), start = new Date(end.getTime() - 14 * 86400000);
    const curve = parseChinaBondCurve(await safeFetch({ method: 'GET', timeout: 20000, json: false,
      url: 'https://yield.chinabond.com.cn/cbweb-pbc-web/pbc/historyQuery?startDate=' + isoDay(start) + '&endDate=' + isoDay(end) + '&gjqx=0&qxId=ycqx&locale=cn_ZH' }));
    if (curve) { results.cgb10Y = curve.y10.toFixed(2) + '%'; results.cgb10YDate = curve.date; }
    else fail('ChinaBond 10Y', new Error('curve row not found'));
  }
} catch (e) { fail('ChinaBond 10Y', e); }

// --- 2c. LOAN PRIME RATE (National Interbank Funding Center) ---
try {
  if (msLeft() > RETRY_RESERVE_MS) {
    const end = new Date(), start = new Date(end.getTime() - 90 * 86400000);
    const lpr = parseLpr(await safeFetch({ method: 'GET', timeout: 20000,
      url: 'https://www.chinamoney.com.cn/ags/ms/cm-u-bk-currency/LprHis?lang=CN&strStartDate=' + isoDay(start) + '&strEndDate=' + isoDay(end) + '&pageNum=1&pageSize=20' }));
    if (lpr) { results.lpr1Y = lpr.lpr1Y.toFixed(2) + '%'; results.lpr5Y = lpr.lpr5Y.toFixed(2) + '%'; results.lprDate = lpr.date; }
    else fail('NIFC LPR', new Error('no fixing in the response'));
  }
} catch (e) { fail('NIFC LPR', e); }

// --- 3. FETCH CHINA ECONOMIC DATA (World Bank API) ---

// GDP Growth
try {
  const gdpData = await this.helpers.httpRequest({
    method: 'GET',
    url: 'https://api.worldbank.org/v2/country/CN/indicator/NY.GDP.MKTP.KD.ZG?format=json&per_page=5&mrv=1',
    timeout: 30000
  });

  if (gdpData && gdpData[1] && gdpData[1][0]) {
    const obs = gdpData[1][0];
    if (obs.value !== null) {
      const sign = obs.value >= 0 ? '+' : '';
      results.gdpValue = sign + parseFloat(obs.value).toFixed(2) + '%';
      results.gdpYear = obs.date;
    }
  }
} catch (e) { fail('World Bank GDP', e); }

// CPI Inflation
try {
  const cpiData = await this.helpers.httpRequest({
    method: 'GET',
    url: 'https://api.worldbank.org/v2/country/CN/indicator/FP.CPI.TOTL.ZG?format=json&per_page=5&mrv=1',
    timeout: 30000
  });

  if (cpiData && cpiData[1] && cpiData[1][0]) {
    const obs = cpiData[1][0];
    if (obs.value !== null) {
      results.cpiValue = parseFloat(obs.value).toFixed(2) + '%';
      results.cpiYear = obs.date;
    }
  }
} catch (e) { fail('World Bank CPI', e); }

// Unemployment Rate
try {
  const unempData = await this.helpers.httpRequest({
    method: 'GET',
    url: 'https://api.worldbank.org/v2/country/CN/indicator/SL.UEM.TOTL.ZS?format=json&per_page=5&mrv=1',
    timeout: 30000
  });

  if (unempData && unempData[1] && unempData[1][0]) {
    const obs = unempData[1][0];
    if (obs.value !== null) {
      results.unemploymentValue = parseFloat(obs.value).toFixed(2) + '%';
      results.unemploymentYear = obs.date;
    }
  }
} catch (e) { fail('World Bank Unemployment', e); }

// --- 3b. MONTHLY PRICES AND PMI (National Bureau of Statistics) ---
// The release listing's titles carry the CPI and PPI year-on-year figures, and the PMI figure is
// on its release page (W30). The monthly CPI replaces the World Bank's annual figure when read;
// otherwise the annual figure stays, with its year as the label.
let nbs = null;
try {
  if (msLeft() > RETRY_RESERVE_MS) {
    nbs = parseNbsListing(await safeFetch({ method: 'GET', url: 'https://www.stats.gov.cn/sj/zxfb/', timeout: 20000, json: false }));
    if (!nbs) fail('NBS releases', new Error('no CPI, PPI or PMI release in the listing'));
    if (nbs?.cpi && Math.abs(nbs.cpi.yoy) <= 15) { results.cpiValue = signedPct(nbs.cpi.yoy, 1); results.cpiYear = monthLabel(nbs.cpi.year, nbs.cpi.month); results.cpiSource = 'NBS'; }
    if (nbs?.ppi && Math.abs(nbs.ppi.yoy) <= 15) { results.ppiValue = signedPct(nbs.ppi.yoy, 1); results.ppiMonth = monthLabel(nbs.ppi.year, nbs.ppi.month); }
  }
} catch (e) { fail('NBS releases', e); }
try {
  if (nbs?.pmiLink && msLeft() > RETRY_RESERVE_MS) {
    const pmi = parseNbsPmi(await safeFetch({ method: 'GET', url: resolveNbsLink(nbs.pmiLink.href), timeout: 20000, json: false }));
    if (pmi) {
      results.pmiValue = pmi.pmi.toFixed(1);
      results.pmiMonth = monthLabel(nbs.pmiLink.year, nbs.pmiLink.month);
      if (pmi.nonMfg !== null) results.pmiNonMfg = pmi.nonMfg.toFixed(1);
    } else fail('NBS PMI', new Error('PMI sentence not found'));
  }
} catch (e) { fail('NBS PMI', e); }

// --- 4. FETCH NEWS HEADLINES (Google News RSS search, same-day items) ---

try {
  // Google News search RSS ranks by relevance unless the query carries when:1d. Without it the same
  // May–August articles led the feed for a week in October 2026 and were cited as today's evidence.
  const rssResponse = await this.helpers.httpRequest({
    method: 'GET',
    url: 'https://news.google.com/rss/search?q=China+economy+OR+China+stocks+when:1d&hl=en&gl=US&ceid=US:en',
    timeout: 30000,
    json: false
  });

  populateMarketHeadlines(results, rssResponse, true);
} catch (e) { fail('RSS', e); }

// ===== HEALTH AUDIT: flag any critical field still N/A =====
const CRITICAL = {
  'CSI 300':'csi300',
  'SSE Composite':'sseComposite',
  'SZSE Component':'szseComponent',
  'Hang Seng':'hangSeng',
  'USD/CNY':'usdCny',
  'GDP':'gdpValue',
  'CPI':'cpiValue',
  'Unemployment':'unemploymentValue'
};
// Flag implausible changes without removing the available source values.
const CHANGE_BOUNDS = { csi300Change: 15, sseCompositeChange: 15, szseComponentChange: 15, hangSengChange: 15, goldChange: 10, usdCnyChange: 5 };
auditMarketHealth(results, health, CRITICAL, CHANGE_BOUNDS);
health.elapsedMs = Date.now() - NODE_START;
if (msLeft() <= 0) console.error('🟠 [MarketPulse][TIME-BUDGET] exhausted after ' + Math.round(health.elapsedMs / 1000) + 's - some sources were skipped to protect the run');

publishMarketHealth(results, health, CRITICAL);

return [{ json: results }];
