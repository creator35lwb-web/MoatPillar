// Parsers for China's official sources (W32): China Securities Index Co., ChinaBond, the National
// Interbank Funding Center and the National Bureau of Statistics. Each returns null when the page
// does not carry what it should, so the caller records a failure and the field stays N/A. No key.
function parseCsiPerformance(perf) {
  const rows = (perf && Array.isArray(perf.data) ? perf.data : [])
    .filter(r => r && typeof r.close === 'number' && Number.isFinite(r.close) && /^\d{8}$/.test(String(r.tradeDate)))
    .sort((a, b) => String(a.tradeDate).localeCompare(String(b.tradeDate)));
  // Holiday rows repeat the previous session's figures; keep one row per session.
  const sessions = rows.filter((r, i) => i === 0 || r.close !== rows[i - 1].close || r.tradingVol !== rows[i - 1].tradingVol);
  if (!sessions.length) return null;
  const isoDate = value => String(value).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
  // The trailing P/E (`peg`) is published after the session, so the latest row often lacks it;
  // the latest row that has one carries its own date.
  const withPE = sessions.filter(r => typeof r.peg === 'number' && r.peg >= 5 && r.peg <= 40);
  const latest = sessions[sessions.length - 1];
  const out = {
    sessions: sessions.length,
    close: latest.close,
    closeDate: isoDate(latest.tradeDate),
    pe: withPE.length ? withPE[withPE.length - 1].peg : null,
    peDate: withPE.length ? isoDate(withPE[withPE.length - 1].tradeDate) : null,
    // CSI reports turnover in 100 million CNY; shown in billions.
    turnoverBn: typeof latest.tradingValue === 'number' && latest.tradingValue >= 10 && latest.tradingValue <= 100000 ? latest.tradingValue / 10 : null,
    vsMa200: null,
    maSignal: null,
  };
  if (sessions.length >= 200) {
    const closes = sessions.map(r => r.close);
    const average = n => closes.slice(-n).reduce((a, b) => a + b, 0) / n;
    const ma200 = average(200), ma50 = average(50);
    out.vsMa200 = (closes[closes.length - 1] / ma200 - 1) * 100;
    out.maSignal = ma50 > ma200 ? 'Golden Cross' : 'Death Cross';
  }
  return out;
}

// The history query returns an HTML table whose row 中债国债收益率曲线 holds, in order,
// the date and the 3M, 6M, 1Y, 3Y, 5Y, 7Y, 10Y and 30Y yields, newest first.
function parseChinaBondCurve(html) {
  if (typeof html !== 'string') return null;
  for (const row of html.match(/<tr[\s\S]*?<\/tr>/g) || []) {
    const cells = (row.match(/<td[\s\S]*?<\/td>/g) || []).map(cell => cell.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim());
    if (cells[0] !== '中债国债收益率曲线' || !/^\d{4}-\d{2}-\d{2}$/.test(cells[1] || '')) continue;
    const y10 = Number(cells[8]);
    if (Number.isFinite(y10) && y10 > 0 && y10 < 10) return { date: cells[1], y10 };
  }
  return null;
}

// NIFC returns the Loan Prime Rate fixings newest first: {"5Y":"3.50","1Y":"3.00","showDateCN":"2026-09-20"}.
function parseLpr(json) {
  const records = json && Array.isArray(json.records) ? json.records : [];
  for (const record of records) {
    if (!record || !/^\d{4}-\d{2}-\d{2}$/.test(String(record.showDateCN || ''))) continue;
    const lpr1Y = Number(record['1Y']), lpr5Y = Number(record['5Y']);
    if ([lpr1Y, lpr5Y].every(v => Number.isFinite(v) && v > 0 && v < 10)) return { date: record.showDateCN, lpr1Y, lpr5Y };
  }
  return null;
}

// The NBS release listing (stats.gov.cn/sj/zxfb/) titles its CPI and PPI releases with the
// year-on-year figure ("2026年9月份居民消费价格同比上涨0.9%"); the PMI release is linked by title.
function parseNbsListing(html) {
  if (typeof html !== 'string') return null;
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const signed = (direction, value) => (direction === '下降' ? -1 : 1) * Number(value);
  const out = {};
  const cpi = /(\d{4})年(\d{1,2})月份居民消费价格同比(上涨|下降)\s*([\d.]+)\s*%/.exec(text);
  const cpiFlat = /(\d{4})年(\d{1,2})月份居民消费价格同比持平/.exec(text);
  if (cpi) out.cpi = { year: Number(cpi[1]), month: Number(cpi[2]), yoy: signed(cpi[3], cpi[4]) };
  else if (cpiFlat) out.cpi = { year: Number(cpiFlat[1]), month: Number(cpiFlat[2]), yoy: 0 };
  const ppi = /(\d{4})年(\d{1,2})月份工业生产者出厂价格同比(上涨|下降)\s*([\d.]+)\s*%/.exec(text);
  const ppiFlat = /(\d{4})年(\d{1,2})月份工业生产者出厂价格同比持平/.exec(text);
  if (ppi) out.ppi = { year: Number(ppi[1]), month: Number(ppi[2]), yoy: signed(ppi[3], ppi[4]) };
  else if (ppiFlat) out.ppi = { year: Number(ppiFlat[1]), month: Number(ppiFlat[2]), yoy: 0 };
  const pmi = /href="([^"]+)"[^>]*>\s*(\d{4})年(\d{1,2})月中国采购经理指数运行情况/.exec(html);
  if (pmi) out.pmiLink = { href: pmi[1], year: Number(pmi[2]), month: Number(pmi[3]) };
  return Object.keys(out).length ? out : null;
}

function resolveNbsLink(href) {
  if (/^https?:\/\//.test(href)) return href;
  return 'https://www.stats.gov.cn/sj/zxfb/' + String(href).replace(/^\.?\//, '');
}

// The PMI release page reads "制造业采购经理指数（PMI）为 50.1%" and "非制造业商务活动指数为 50.2%".
function parseNbsPmi(html) {
  if (typeof html !== 'string') return null;
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const manufacturing = /(?<!非)制造业采购经理指数\s*[（(]\s*PMI\s*[）)]\s*为\s*([\d.]+)\s*%/.exec(text);
  const services = /非制造业商务活动指数为\s*([\d.]+)\s*%/.exec(text);
  const pmi = manufacturing ? Number(manufacturing[1]) : NaN;
  if (!(pmi >= 30 && pmi <= 70)) return null;
  const nonMfg = services ? Number(services[1]) : NaN;
  return { pmi, nonMfg: nonMfg >= 30 && nonMfg <= 70 ? nonMfg : null };
}

const CN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function monthLabel(year, month) {
  return month >= 1 && month <= 12 ? CN_MONTHS[month - 1] + ' ' + year : String(year);
}
function signedPct(value, digits) {
  return (value >= 0 ? '+' : '') + value.toFixed(digits) + '%';
}
