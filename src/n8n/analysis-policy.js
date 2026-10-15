// Shared policy, prepended to n8n node bodies by the workflow builder.
// Also importable by the dashboard validator and offline regression tests.
// This checks schema, citation availability and a conservative numeric lexicon;
// it does NOT prove that unrestricted prose follows logically from its evidence.
const MP_POLICY = (() => {
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const record = o => o !== null && typeof o === 'object' && !Array.isArray(o);
  const exactKeys = (o, keys) => record(o) && Object.keys(o).length === keys.length && keys.every(k => own(o, k));
  const sentiments = ['Bullish', 'Cautiously Bullish', 'Neutral', 'Cautiously Bearish', 'Bearish'];
  const confidences = ['High', 'Medium', 'Low'];
  const directions = ['supports_bullish', 'supports_bearish', 'neutral'];
  const numericWords = /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|trillion|quadrillion|half|halves|quarter|quarters|percent|percentage|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/i;
  // Deliberately conservative: fixed instrument names containing digits and ordinary
  // uses of words such as "one" are withheld too. No claim of exhaustive language detection.
  const hasNumericText = text => typeof text !== 'string' || /\p{N}/u.test(text) || /\p{N}/u.test(text.normalize('NFKC')) || numericWords.test(text.normalize('NFKC'));
  const text = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);
  const isUsableFact = (v, key) => {
    if (key === 'maSignal') return ['Golden Cross', 'Death Cross'].includes(v);
    if (typeof v === 'number') return Number.isFinite(v) && (key !== 'fearGreedValue' || (v >= 0 && v <= 100));
    if (typeof v !== 'string' || !v.trim() || v.length > 200) return false;
    // Match the complete fetched value, including the known GDP annotation.
    // Finding a numeric substring in malformed text is not usable source evidence.
    const match = /^(?:[$¥€£]|HK\$)?([+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][+-]?\d+)?)(%)?(?: \((QoQ(?: annualized)?|YoY|annualized)\))?$/.exec(v.trim());
    if (!match || (match[3] && key !== 'gdpValue')) return false;
    const value = Number(match[1].replace(/,/g, ''));
    if (!Number.isFinite(value)) return false;
    return key !== 'fearGreedValue' || (/^\d+(?:\.\d+)?$/.test(v.trim()) && value >= 0 && value <= 100);
  };
  const isUsableHeadline = value => text(value, 2000);
  const keysByEdition = {
    US: ['buffettIndicator','shillerPE','yieldCurve','sp500VsMa200','maSignal','fearGreedValue','sp500','sp500Change','dowJones','dowJonesChange','vix','vixChange','gold','goldChange','oil','oilChange','dxy','dxyChange','btc','btcChange','gdpValue','cpiValue','unemploymentValue','fedRateValue','treasury10Y','treasury2Y'],
    CN: ['csi300','csi300Change','sseComposite','sseCompositeChange','szseComponent','szseComponentChange','hangSeng','hangSengChange','gold','goldChange','usdCny','usdCnyChange','gdpValue','cpiValue','unemploymentValue',
      'csi300PE','csi300VsMa200','maSignal','csi300Turnover','cgb10Y','lpr1Y','lpr5Y','ppiValue','pmiValue'],
  };
  const factKeysFor = edition => [...(keysByEdition[edition] || [])];
  const collectFacts = (data, edition) => {
    const keys = new Set(keysByEdition[edition] || []);
    for (const stock of (Array.isArray(data.stockDetails) ? data.stockDetails : [])) {
      if (!record(stock)) continue;
      const slug = String(stock.name || stock.symbol || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (slug) keys.add(slug + 'Change');
    }
    const facts = {};
    for (const key of keys) if (own(data, key) && isUsableFact(data[key], key)) facts[key] = data[key];
    return facts;
  };
  const validateAnalysis = (candidate, { facts = {}, headlines = [] } = {}) => {
    const reasons = new Set();
    const fail = code => reasons.add(code);
    if (!exactKeys(candidate, ['sentiment','confidence','claims','interpretation','wisdom'])) {
      return {ok:false,reasonCodes:['ANALYSIS_SCHEMA_INVALID'],analysis:null};
    }
    if (!sentiments.includes(candidate.sentiment)) fail('SENTIMENT_INVALID');
    if (!confidences.includes(candidate.confidence)) fail('CONFIDENCE_INVALID');
    for (const [field,max] of [['sentiment',40],['confidence',10],['interpretation',1200],['wisdom',600]]) {
      // Editorial rules may remove an advising wisdom sentence entirely (see applyEditorialRules).
      if (field === 'wisdom' && candidate.wisdom === '') continue;
      if (!text(candidate[field], max)) fail('ANALYSIS_TEXT_INVALID');
      else if (hasNumericText(candidate[field])) fail('NUMERIC_MODEL_TEXT');
    }
    if (!Array.isArray(candidate.claims) || candidate.claims.length < 1 || candidate.claims.length > 6) fail('CLAIM_COUNT_INVALID');
    const claims = [];
    if (Array.isArray(candidate.claims) && candidate.claims.length <= 6) {
      for (const claim of candidate.claims) {
        if (!exactKeys(claim, ['claim','basedOn','direction'])) { fail('CLAIM_SCHEMA_INVALID'); continue; }
        if (!text(claim.claim, 600)) fail('CLAIM_TEXT_INVALID');
        else if (hasNumericText(claim.claim)) fail('NUMERIC_MODEL_TEXT');
        if (!directions.includes(claim.direction)) fail('DIRECTION_INVALID');
        if (!Array.isArray(claim.basedOn) || claim.basedOn.length < 1 || claim.basedOn.length > 12 || new Set(claim.basedOn).size !== claim.basedOn.length) {
          fail('CITATION_LIST_INVALID');
        } else {
          for (const key of claim.basedOn) {
            if (typeof key !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(key)) { fail('CITATION_KEY_INVALID'); continue; }
            const headline = /^headline_([1-9]\d*)$/.exec(key);
            if (headline) {
              const index = Number(headline[1]) - 1;
              if (!Number.isSafeInteger(index) || !isUsableHeadline(headlines[index])) fail('HEADLINE_UNAVAILABLE');
            } else if (!own(facts, key) || !isUsableFact(facts[key], key)) fail('FACT_UNAVAILABLE');
          }
        }
        claims.push({claim:typeof claim.claim === 'string' ? claim.claim.trim() : '',basedOn:Array.isArray(claim.basedOn) ? [...claim.basedOn] : [],direction:claim.direction});
      }
    }
    const bull = claims.filter(c => c.direction === 'supports_bullish').length;
    const bear = claims.filter(c => c.direction === 'supports_bearish').length;
    if (/Bullish/.test(candidate.sentiment) && !bull && bear) fail('DIRECTION_CONFLICT');
    if (/Bearish/.test(candidate.sentiment) && !bear && bull) fail('DIRECTION_CONFLICT');
    const reasonCodes = [...reasons];
    return {ok:!reasonCodes.length,reasonCodes,analysis:reasonCodes.length ? null : {
      sentiment:candidate.sentiment,confidence:candidate.confidence,claims,
      interpretation:candidate.interpretation.trim(),wisdom:candidate.wisdom.trim(),
    }};
  };
  // Editorial rules (W15 spec sections 4 and 5), applied once at verification time to an
  // analysis that already passed validateAnalysis. Published payloads are not re-judged by
  // them, so data published under the earlier contract stays valid.
  // 1. Long-term valuation inputs describe the backdrop, not the short-term read: a claim
  //    citing only them must be neutral.
  // 2. The broadcast describes the market and never tells readers what to do with money.
  //    Advising sentences are removed from interpretation and wisdom; an advising claim
  //    withholds the analysis, because a claim cannot be edited away from its evidence.
  //    A recommended stance counts as advice too ("a defensive stance is warranted").
  const LONG_TERM_KEYS = new Set(['buffettIndicator', 'shillerPE', 'csi300PE']);
  const ADVICE = [
    /\b(?:you|investors?|value investors?|readers?|one)\s+(?:should|must|need to|ought to|may want to|might consider)\b/i,
    /\b(?:we|i)\s+(?:recommend|suggest|advise)\b/i,
    /\b(?:consider|time to)\s+(?:buying|selling|adding|trimming|reducing|accumulating)\b/i,
    /\bit(?:'s|’s| is| would be| may be| might be)\s+(?:prudent|wise|advisable|sensible)\s+to\b/i,
    /\b(?:caution|patience|selectivity)\s+(?:is|remains)\s+(?:warranted|advised|advisable|prudent)\b/i,
  ];
  // A stance word and a verdict on it in the same sentence (each sentence is checked alone).
  const STANCE = /\b(?:stance|posture|positioning|allocation)\b/i;
  const STANCE_VERDICT = /\b(?:is|remains|seems|would be|may be)\s+(?:appropriate|warranted|advisable|prudent|justified|sensible|wise)\b/i;
  const advises = value => typeof value === 'string' &&
    (ADVICE.some(pattern => pattern.test(value)) || (STANCE.test(value) && STANCE_VERDICT.test(value)));
  const trimAdvice = value => {
    const sentences = value.split(/(?<=[.!?])\s+/);
    const kept = sentences.filter(sentence => !advises(sentence));
    return {text:kept.join(' ').trim(), trimmed:kept.length !== sentences.length};
  };
  const applyEditorialRules = analysis => {
    const reasons = new Set(), notes = [];
    for (const claim of analysis.claims) {
      if (advises(claim.claim)) reasons.add('ADVICE_IN_CLAIM');
      if (claim.basedOn.length && claim.basedOn.every(key => LONG_TERM_KEYS.has(key)) && claim.direction !== 'neutral') reasons.add('LONG_TERM_DIRECTION');
    }
    const interpretation = trimAdvice(analysis.interpretation);
    const wisdom = trimAdvice(analysis.wisdom);
    if (!interpretation.text) reasons.add('ADVICE_ONLY_TEXT');
    if (interpretation.trimmed || wisdom.trimmed) notes.push('ADVICE_TRIMMED');
    const reasonCodes = [...reasons];
    return {ok:!reasonCodes.length,reasonCodes,notes,analysis:reasonCodes.length ? null : {
      ...analysis,claims:analysis.claims.map(claim => ({...claim,basedOn:[...claim.basedOn]})),
      interpretation:interpretation.text,wisdom:wisdom.text,
    }};
  };
  const readApproval = (data, edition) => {
    try {
      const a = data.approvedAnalysis, v = data._verification;
      if (!record(data._health) || !['OK','DEGRADED'].includes(data._health.status)) return {ok:false,analysis:null,reasonCodes:['SOURCE_HEALTH_UNAVAILABLE']};
      if (!exactKeys(a, ['version','edition','analysis']) || a.version !== 1 || a.edition !== edition ||
          !record(v) || v.contractVersion !== 1 || v.status !== 'PASS' || v.action !== 'none' || v.edition !== edition ||
          !Array.isArray(v.reasonCodes) || v.reasonCodes.length) return {ok:false,analysis:null,reasonCodes:['APPROVAL_MISSING']};
      const result = validateAnalysis(a.analysis, {facts:collectFacts(data, edition),headlines:Array.isArray(data.headlinesList) ? data.headlinesList : []});
      if (result.ok && v.checked !== result.analysis.claims.length) return {ok:false,analysis:null,reasonCodes:['APPROVAL_COUNT_MISMATCH']};
      return result;
    } catch (_) { return {ok:false,analysis:null,reasonCodes:['APPROVAL_INVALID']}; }
  };
  const safeHttpUrl = value => {
    if (typeof value !== 'string' || !/^https?:\/\/[^\s<>"'\\]+$/i.test(value)) return null;
    // URL is not exposed by every n8n Code-node sandbox, so avoid depending on it.
    if (!/^https?:\/\/(?:[a-z0-9.-]+|\[[0-9a-f:]+\])(?::\d{1,5})?(?:[/?#]|$)/i.test(value)) return null;
    return value;
  };
  const verificationFor = (approval, data) => {
    const source = data._verification && Array.isArray(data._verification.reasonCodes) && data._verification.reasonCodes.length ? data._verification.reasonCodes : approval.reasonCodes;
    const reasonCodes = [...new Set((source || []).filter(c => typeof c === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(c)))];
    return {version:1,status:approval.ok ? 'approved' : 'withheld',checkedClaims:approval.ok ? approval.analysis.claims.length : 0,
      reasonCodes:approval.ok ? [] : reasonCodes.length ? reasonCodes : ['APPROVAL_INVALID']};
  };
  return {own,record,exactKeys,sentiments,confidences,directions,hasNumericText,isUsableFact,isUsableHeadline,factKeysFor,collectFacts,validateAnalysis,applyEditorialRules,advises,readApproval,safeHttpUrl,verificationFor};
})();
if (typeof module !== 'undefined' && module.exports) module.exports = MP_POLICY;
