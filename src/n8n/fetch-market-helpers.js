// Shared source-health and RSS parsing for both market editions.
function createMarketHealth() {
  const health = { status: 'OK', failed: [], missing: [] };
  function fail(source, error) {
    const code = (error && (error.code || (error.cause && error.cause.code))) || '';
    const msg = ((error && error.message) || String(error)).slice(0, 180);
    health.failed.push({ source, code, msg });
    console.error('🔴 [MarketPulse][FETCH-FAIL] ' + source + ' :: ' + code + ' ' + msg);
  }
  return { health, fail };
}

function auditMarketHealth(results, health, critical, changeBounds) {
  for (const [label, key] of Object.entries(critical)) {
    const value = results[key];
    if (value === undefined || value === null || value === '' || value === 'N/A') health.missing.push(label);
  }
  if (health.missing.length === 0) health.status = 'OK';
  else if (health.missing.length >= Math.ceil(Object.keys(critical).length * 0.6)) health.status = 'OUTAGE';
  else health.status = 'DEGRADED';

  // Availability and plausibility are separate: flag outliers without removing them.
  for (const field of Object.keys(changeBounds)) {
    const raw = results[field];
    if (raw === undefined || raw === null || raw === 'N/A') continue;
    const number = parseFloat(String(raw).replace('%', ''));
    if (!isNaN(number) && Math.abs(number) > changeBounds[field]) {
      health.suspect = health.suspect || [];
      health.suspect.push({ field, value: raw, bound: changeBounds[field] });
      console.error('🟠 [MarketPulse][DATA-QUALITY] ' + field + ' = ' + raw + ' exceeds plausible ±' + changeBounds[field] + '% - flagged for review, not withheld');
    }
  }
}

function publishMarketHealth(results, health, critical) {
  results._health = health;
  if (health.status !== 'OK') {
    console.error('🔴 [MarketPulse][DATA-HEALTH] ' + health.status + ' | missing: ' + (health.missing.join(', ') || 'none') + ' | fetch errors: ' + health.failed.length);
  } else {
    console.log('✅ [MarketPulse][DATA-HEALTH] OK - all ' + Object.keys(critical).length + ' critical sources populated');
  }
}

// Year-over-year change of a monthly FRED series, from the newest month whose same month a year
// earlier has a value. FRED marks a month that was never published with "." (CPIAUCSL has no
// October 2025: the BLS published no index for it during the 2025 shutdown), and the old fixed
// pair (newest against the 13th) then printed "NaN%". The month shown is the month computed.
// Returns null when no pair exists, so the field stays 'N/A' and the health audit reports it.
function fredYearOverYear(observations) {
  const byDate = new Map();
  for (const o of observations || []) {
    const value = parseFloat(o && o.value);
    if (Number.isFinite(value) && /^\d{4}-\d{2}-\d{2}$/.test(String(o.date))) byDate.set(o.date, value);
  }
  for (const date of [...byDate.keys()].sort().reverse()) {
    const prior = (Number(date.slice(0, 4)) - 1) + date.slice(4);
    if (byDate.has(prior) && byDate.get(prior) !== 0) {
      return { value: ((byDate.get(date) - byDate.get(prior)) / byDate.get(prior) * 100).toFixed(2) + '%', date };
    }
  }
  return null;
}

function populateMarketHeadlines(results, rssResponse, stripAttribution = false) {
  if (!rssResponse || typeof rssResponse !== 'string') return;
  const cleanTitle = title => {
    const cleaned = String(title || '')
      .replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1')
      .replace(/<\/?title>/g, '').trim()
      .replace(/&#x201c;/g, '"').replace(/&#x201d;/g, '"')
      .replace(/&#x2019;/g, "'").replace(/&#x2018;/g, "'")
      .replace(/&#x2014;/g, ' - ').replace(/&#x2013;/g, '-')
      .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#xa0;/g, ' ');
    return stripAttribution ? cleaned.replace(/ - .*$/, '') : cleaned;
  };
  const cleaned = [];
  const links = [];
  for (const block of rssResponse.match(/<item>[\s\S]*?<\/item>/g) || []) {
    if (cleaned.length >= 8) break;
    const titleMatch = /<title>([\s\S]*?)<\/title>/.exec(block);
    const linkMatch = /<link>([\s\S]*?)<\/link>/.exec(block);
    const title = titleMatch ? cleanTitle(titleMatch[1]) : '';
    if (title.length > 10) {
      cleaned.push(title);
      const href = linkMatch ? linkMatch[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1').trim() : '';
      links.push(/^https?:\/\//.test(href) ? href : null);
    }
  }
  if (!cleaned.length) {
    // Keep the existing title-only fallback when a feed has no usable item blocks.
    const titles = rssResponse.match(/<title>([^<]+)<\/title>/g);
    if (titles && titles.length > 1) {
      for (let index = 1; index < Math.min(titles.length, 9); index++) {
        const title = cleanTitle(titles[index]);
        if (title.length > 10) { cleaned.push(title); links.push(null); }
      }
    }
  }
  if (cleaned.length > 0) {
    results.headlinesList = cleaned;
    results.headlinesLinks = links;
    results.headlinesCount = cleaned.length;
    results.headlines = cleaned.map((title, index) => (index + 1) + '. ' + title).join('\n');
  }
}
