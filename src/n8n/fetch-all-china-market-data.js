// ============================================
// FETCH ALL MARKET DATA - MarketPulse v6.0 (CN)
// China Market Edition
// Data Sources: Yahoo Finance, World Bank
// ============================================


// ===== DATA-HEALTH INSTRUMENTATION (hardening) =====
// LOUD failures so N/A can never masquerade as success.
// Grep n8n logs:  [MarketPulse][FETCH-FAIL] / [MarketPulse][DATA-HEALTH]
const { health, fail } = createMarketHealth();

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
  headlinesCount: 0
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

publishMarketHealth(results, health, CRITICAL);

return [{ json: results }];
