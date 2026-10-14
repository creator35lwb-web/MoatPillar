// Shared dashboard projection: edition selects source rows, never model behavior.
function MP_PREPARE(EDITION, {$input, $getWorkflowStaticData, Date: RuntimeDate, console}) {
  const items = $input.all();
  const d = {};
  for (const item of items) {
    const j = item.json || {};
    for (const key of Object.keys(j)) {
      if (j[key] !== undefined && j[key] !== null) d[key] = j[key];
    }
  }
  const safe = (value, fallback = 'N/A') =>
    (value === undefined || value === null || value === 'N/A' || value === '') ? fallback : value;
  const isUS = EDITION === 'US';
  const approval = MP_POLICY.readApproval(d, EDITION);
  const analysis = approval.ok ? approval.analysis : null;
  const health = d._health || null;
  const now = new RuntimeDate();
  const dateLabel = now.toLocaleDateString('en-US', {weekday:'long',year:'numeric',month:'long',day:'numeric'});

  const dashboard = {};
  if (isUS) {
    const cards = [
      ['buffettIndicator','Buffett Indicator','buffettStatus','buffettEmoji'],
      ['shillerPE','Shiller P/E (CAPE)','shillerStatus','shillerEmoji'],
      ['yieldCurve','Yield Curve (10Y-2Y)','yieldCurveStatus','yieldCurveEmoji'],
      ['sp500VsMa200','S&P 500 vs 200D-MA','sp500VsMa200Status','sp500VsMa200Emoji'],
    ];
    for (const [key,title,statusKey,emojiKey] of cards) {
      const trend = key === 'sp500VsMa200' && MP_POLICY.isUsableFact(d.maSignal, 'maSignal') ? ' (' + d.maSignal + ')' : '';
      dashboard[key] = {title,value:safe(d[key]),status:safe(d[statusKey],'') + trend,emoji:d[emojiKey] || ''};
    }
  }
  const fearGreed = isUS && MP_POLICY.isUsableFact(d.fearGreedValue, 'fearGreedValue') &&
    Number(d.fearGreedValue) >= 0 && Number(d.fearGreedValue) <= 100
    ? {score:Number(d.fearGreedValue),classification:d.fearGreedClassification || 'Unknown',change1d:d.fearGreedChange1d || '',change1w:d.fearGreedChange1w || ''}
    : null;
  const markets = isUS
    ? [['sp500','S&P 500'],['dowJones','Dow Jones'],['vix','VIX'],['gold','Gold'],['oil','Oil (WTI)'],['dxy','US Dollar'],['btc','Bitcoin']]
    : [['csi300','CSI 300'],['sseComposite','SSE Composite'],['szseComponent','SZSE Component'],['hangSeng','Hang Seng'],['gold','Gold'],['usdCny','USD/CNY']];
  const screener = markets.map(([key,label]) => ({
    label,factKey:key + 'Change',value:safe(d[key]),change:safe(d[key + 'Change'],''),
  }));
  const economicFields = [
    ['gdpValue','GDP Growth','gdpYear'],
    ['cpiValue','Inflation/CPI','cpiYear'],
    ['unemploymentValue','Unemployment','unemploymentYear'],
  ];
  if (isUS) economicFields.push(['fedRateValue','Fed Funds Rate'],['treasury10Y','10Y Treasury'],['treasury2Y','2Y Treasury']);
  else economicFields.push(['ppiValue','Producer prices (PPI)','ppiMonth'],['pmiValue','Manufacturing PMI','pmiMonth'],['lpr1Y','Loan Prime Rate 1Y','lprDate'],
    ['lpr5Y','Loan Prime Rate 5Y','lprDate'],['cgb10Y','10Y government bond','cgb10YDate'],['csi300PE','CSI 300 P/E (trailing)','csi300PEDate'],['csi300Turnover','CSI 300 turnover, ¥bn']);
  const economic = economicFields.map(([key,label,periodKey]) => ({
    label,...(periodKey ? {period:d[periodKey] || ''} : {}),factKey:key,value:safe(d[key]),
  }));
  const claims = analysis && Array.isArray(analysis.claims)
    ? analysis.claims.map(claim => ({text:claim.claim,basedOn:claim.basedOn || [],direction:claim.direction || 'neutral'}))
    : [];

  // Read existing observations and scores without modifying ledger state. The beta record only
  // (W25): the strip starts with the beta's first call.
  function buildHistory() {
    try {
      const state = $getWorkflowStaticData('global');
      const ledger = (state.mpLedger?.[EDITION] || []).filter(MP_PHASE.current);
      const scores = (state.mpTrackRecord?.[EDITION] || []).filter(MP_PHASE.current);
      const scoredByPriorDate = {};
      for (const score of scores) scoredByPriorDate[score.priorDate] = score;
      return ledger.map(entry => {
        const scored = scoredByPriorDate[entry.date];
        return {date:entry.date,sentiment:entry.sentiment || 'n/a',verdict:entry.verdict || 'n/a',
          result:scored ? scored.result : null,actualChange:scored ? scored.actualChange : null};
      });
    } catch (_) { return []; }
  }
  const history = buildHistory();
  const facts = MP_POLICY.collectFacts(d, EDITION);

  // Long-term reading (US ltr.v1, China ltr.cn.v1) and session freshness: code-computed, projected to known fields only.
  const pick = (o, keys) => Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k]]));
  function projectReading(r) {
    if (!MP_POLICY.record(r) || r.version !== MP_LTR.versionFor(EDITION)) return null;
    const sub = (o, keys) => MP_POLICY.record(o) ? pick(o, keys) : null;
    return {
      version:r.version,status:r.status,today:r.today,
      valuation:sub(r.valuation, ['lo','hi','label','topBand']),
      since:typeof r.since === 'string' ? r.since : null,
      pending:sub(r.pending, ['label','count','of']),
      marginOfSafety:typeof r.marginOfSafety === 'string' ? r.marginOfSafety : null,
      measures:Object.fromEntries(MP_LTR.measureKeysFor(EDITION).map(k => [k, MP_POLICY.record(r.measures) ? sub(r.measures[k], ['label','value','level','levelLabel','asOf']) : null])),
      stocksVsBonds:sub(r.stocksVsBonds, ['basis','earningsYield','realYield10Y','bondYield10Y','gap','label']),
      mood:sub(r.mood, ['score','label','change1d','change1w']),
      trend:sub(r.trend, ['value','above']),
      rates:sub(r.rates, ['curve','label','lpr1Y','lpr5Y','cgb10Y','asOf']),
      changes:Array.isArray(r.changes) ? r.changes : [],
    };
  }
  const fresh = MP_LTR.freshness(EDITION, isUS ? d.sp500MarketTime : d.csi300MarketTime, now);
  const asOf = {label:fresh.label,session:fresh.session || null,closed:!!fresh.closed,intraday:!!fresh.intraday};
  const availableScreener = screener.filter(row => MP_POLICY.own(facts, row.factKey) && MP_POLICY.own(facts, row.factKey.replace(/Change$/, '')));
  if (Object.keys(facts).length === 0 || availableScreener.length === 0 || !health || !['OK','DEGRADED'].includes(health.status)) {
    console.error('[MarketPulse][PUBLISH-GUARD] dashboard publish SKIPPED (facts=' + Object.keys(facts).length + ', marketRows=' + availableScreener.length + ', health=' + (health ? health.status : 'none') + ') - retaining the last published payload without usable market quotes.');
    return [];
  }
  // China publishes the reading once its sources are live: a reading, or a flagged input; the US always did.
  const carriesReading = r => MP_POLICY.record(r) && (MP_POLICY.record(r.valuation) || (Array.isArray(r.flags) && r.flags.length > 0));
  const payload = {
    schemaVersion:2,
    verification:MP_POLICY.verificationFor(approval, d),
    edition:EDITION,
    generatedAt:now.toISOString(),
    dateLabel,
    asOf,
    ...(isUS || carriesReading(d.longTermReading) ? {longTermReading:projectReading(d.longTermReading)} : {}),
    health:health ? {status:health.status,missing:health.missing || [],suspect:health.suspect || []} : {status:'OUTAGE',missing:['ALL'],suspect:[]},
    dashboard:Object.fromEntries(Object.entries(dashboard).filter(([key]) => MP_POLICY.own(facts, key))),
    facts,
    fearGreed,
    screener:availableScreener,
    economic:economic.filter(row => MP_POLICY.own(facts, row.factKey)),
    watchlist:d.watchlistSummary || '',
    trackRecord:{accuracy:d.trackRecordAccuracy || 'Building history',last:d.trackRecordLast || '',baseline:d.trackRecordBaseline || '',
      phase:MP_PHASE.CURRENT,since:d.trackRecordSince || ''},
    history,
    analysisModel:analysis ? (d._analysisModel || null) : null,
    analysisProvider:analysis ? (d._analysisProvider || null) : null,
    analysis:analysis
      ? {sentiment:analysis.sentiment || 'n/a',confidence:analysis.confidence || 'n/a',claims,interpretation:analysis.interpretation || '',wisdom:analysis.wisdom || ''}
      : {sentiment:'Unavailable',confidence:'',claims:[],interpretation:'',wisdom:''},
    news:(Array.isArray(d.headlinesList) ? d.headlinesList : []).map((title,index) =>
      MP_POLICY.isUsableHeadline(title) ? {factKey:'headline_' + (index + 1),title,url:MP_POLICY.safeHttpUrl(Array.isArray(d.headlinesLinks) ? d.headlinesLinks[index] : null)} : null
    ).filter(Boolean),
    sources:isUS ? ['CNN Fear & Greed','FRED','MarketWatch','Yahoo Finance','multpl.com']
      : ['Yahoo Finance','China Securities Index Co.','ChinaBond','NIFC','NBS','World Bank','Google News'],
  };
  return [{json:{dashboardJson:JSON.stringify(payload,null,2),commitMessage:'Publish ' + EDITION + ' dashboard data - ' + dateLabel}}];
}
