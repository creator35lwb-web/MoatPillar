// Shared US/CN source merge and historical scoring. The two node wrappers supply the edition.
function MP_COMBINE(EDITION, runtime) {
  const {$input, $getWorkflowStaticData, Date: RuntimeDate, console} = runtime;
  const benchmark = EDITION === 'CN' ? 'csi300' : 'sp500';
  const items = $input.all();
  const combined = {};

  for (const item of items) {
    const j = item.json || {};
    for (const key of Object.keys(j)) {
      if (j[key] !== undefined && j[key] !== null) {
        combined[key] = j[key];
      }
    }
  }


  // ===== WATCHLIST FACT KEYS (2026-07-22) =====
  // Flatten per-stock changes into citable, verifiable factKeys (moutaiChange / googlChange).
  // Before this, watchlist moves were visible to the analyst but absent from the allowed-key
  // list - models invented key names for them and the claims gate (rightly) withheld the
  // analysis. The slug rule must stay byte-identical everywhere it appears (combine / verify /
  // compose / dashboard) - all derive from the same fetched stockDetails, so they cannot drift.
  const wlSlug = (s) => String((s && (s.name || s.symbol)) || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const wlKeys = [];
  for (const s of (Array.isArray(combined.stockDetails) ? combined.stockDetails : [])) {
    const b = wlSlug(s);
    if (b && combined[b + 'Change'] === undefined) {
      combined[b + 'Change'] = s.change;
      wlKeys.push(b + 'Change');
    }
  }
  combined.watchlistFactKeys = wlKeys.length ? wlKeys.join(', ') : 'none available today';

  // ===== VERDICT LEDGER (read): yesterday's analysis as challengeable prior =====
  combined.previousAnalysis = 'No prior analysis available.';
  combined.trackRecordAccuracy = 'Building history';
  combined.trackRecordLast = '';
  combined.trackRecordBaseline = '';
  combined.trackRecordSince = '';
  try {
    const sd = $getWorkflowStaticData('global');
    const led = (sd.mpLedger && sd.mpLedger[EDITION]) || [];
    // ===== PRIOR SELECTION (2026-07-27): skip verdict-less entries =====
    // An OUTAGE / model-failure run used to persist a sentiment:null row. Because
    // `prev` was the last row unconditionally, that row became the next run's prior:
    // its marketTime is null, so the trading-day guard skipped scoring forever and
    // orphaned the last real call (CN 2026-07-23), while 'your sentiment was null'
    // leaked into the prompt. Walk back to the most recent stated verdict instead.
    // The beta (W25): only a call written by this code can be the prior, so the beta's first call
    // has none, and the beta scorer never grades a call from before the beta.
    let prev = null;
    for (let i = led.length - 1; i >= 0; i--) {
      if (led[i]?.sentiment && MP_PHASE.current(led[i])) { prev = led[i]; break; }
    }
    if (prev && prev.date) {
      let t = 'On ' + prev.date + ' your sentiment was ' + prev.sentiment + ' (confidence ' + prev.confidence + '; verification verdict ' + prev.verdict + ').';
      if (Array.isArray(prev.claims) && prev.claims.length) {
        t += ' Your claims were: ' + prev.claims.map(function(c){ return '"' + c.claim + '" [based on: ' + (c.basedOn || []).join(', ') + ']'; }).join('; ') + '.';
      }
      combined.previousAnalysis = t;
    }

    // ===== TRACK RECORD (deterministic, code-only, never a prediction): was
    // yesterday's stated sentiment consistent with what the market actually did
    // next? Purely retrospective - the LLM is never asked about the future. =====
    if (!sd.mpTrackRecord) sd.mpTrackRecord = {};
    if (!sd.mpTrackRecord[EDITION]) sd.mpTrackRecord[EDITION] = [];
    const tr = sd.mpTrackRecord[EDITION];
    const todayChangeStr = combined[benchmark + 'Change'];
    const todayChange = (todayChangeStr && todayChangeStr !== 'N/A') ? parseFloat(todayChangeStr) : NaN;
      // ===== TRADING-DAY GUARD (2026-07-14, supersedes the gapDays guard) =====
    // The scorer compares a prior call against "what the market did next". That is only
    // meaningful if the market has ACTUALLY TRADED since the call was made.
    //
    // The digest fires PRE-MARKET (9am ET), so every run reports the LAST COMPLETED
    // session. On a Saturday, a Sunday, a market holiday, or a duplicate same-day run,
    // the "move" it would score against is the SAME move the prior call was formed on —
    // the call already knew the answer. Circular, and it silently poisons the record.
    //
    // meta.regularMarketTime is the exchange's OWN last-trade timestamp. Comparing it to
    // the one stored with the prior call is ground truth: has a new session closed since?
    // One signal closes weekends, holidays AND duplicate runs — no hard-coded calendar.
    const todayMarketTime = combined[benchmark + 'MarketTime'] || null;
    const priorMarketTime = (prev && prev.marketTime) || null;
    let gapDays = null;
    if (prev && prev.date) {
      const todayUTC = new RuntimeDate().toISOString().slice(0, 10);
      gapDays = Math.round((RuntimeDate.parse(todayUTC + 'T00:00:00Z') - RuntimeDate.parse(prev.date + 'T00:00:00Z')) / 86400000);
    }
    const marketAdvanced = (todayMarketTime !== null && priorMarketTime !== null && todayMarketTime > priorMarketTime);
    // ===== GAP CEILING + SAME-DAY IDEMPOTENCY (2026-07-17) =====
    // marketAdvanced alone left two holes: (1) after a multi-day miss it would grade a stale
    // pre-gap call against an unrelated later single-day move (no upper bound on the gap);
    // (2) a manual/duplicate re-trigger on the same day would score the same prior call twice,
    // inflating the track record with a duplicate entry. Compose both guards with marketAdvanced.
    const todayScoreUTC = new RuntimeDate().toISOString().slice(0, 10);
    const alreadyScoredToday = (tr.length > 0 && tr[tr.length - 1].scoredDate === todayScoreUTC);
    const gapInBounds = (gapDays === null || gapDays <= 4);
    // ===== ONE GRADE PER CALL AND PER SESSION, CLOSED SESSIONS ONLY (W3, 2026-10-08) =====
    // The guards above assume the ledger advances on every run. When the AI layer fails for
    // days, no new call is written, so every run graded the same stale call again: the US call
    // of 2026-09-17 was graded four times, and on 2026-10-07 the Oct 3 call was graded a second
    // time, against the first nine minutes of trading after a late wake. So: a call is graded
    // at most once; a market session grades at most one call, and only a session that began
    // after the one the call was formed on; and only a closed session grades, because a run
    // that wakes during trading sees a partial move.
    const sessionOf = t => MP_LTR.sessionDate(EDITION, t);
    const todaySession = sessionOf(todayMarketTime);
    const priorSession = sessionOf(priorMarketTime);
    const laterSession = todaySession !== null && priorSession !== null && todaySession > priorSession;
    const intraday = todayMarketTime !== null && MP_LTR.freshness(EDITION, todayMarketTime, new RuntimeDate()).intraday;
    const callGraded = !!prev?.date && tr.some(x => x?.priorDate === prev.date);
    const sessionGraded = todaySession !== null && tr.some(x => x && (x.session || sessionOf(x.marketTime)) === todaySession);
    const scoreable = marketAdvanced && laterSession && !intraday && !callGraded && !sessionGraded && gapInBounds && !alreadyScoredToday;
    if (prev && prev.sentiment && !isNaN(todayChange) && !scoreable) {
      let why;
      if (!marketAdvanced || !laterSession) why = 'no new session has traded since the prior call (prior=' + priorMarketTime + ' today=' + todayMarketTime + ') - weekend, holiday, or a repeat run; scoring would grade a call against the move it was formed on';
      else if (intraday) why = 'the ' + todaySession + ' session is still trading - a partial move cannot grade a call';
      else if (callGraded) why = 'the call of ' + prev.date + ' is already graded - a call is graded once';
      else if (sessionGraded) why = 'the ' + todaySession + ' session already graded a call - a session grades one call';
      else if (!gapInBounds) why = 'the gap is ' + gapDays + ' days (a run was missed) - too stale to attribute today\'s single-day move to that call; the point stays in the history, unscored';
      else why = 'already scored today (' + todayScoreUTC + ') - a duplicate or manual re-trigger must not score the same prior call twice';
      console.error('[MarketPulse][TRACK-RECORD] not scored: ' + why + '.');
    }
    if (prev && prev.sentiment && !isNaN(todayChange) && scoreable) {
      const bullish = /Bullish/i.test(prev.sentiment);
      const bearish = /Bearish/i.test(prev.sentiment);
      let result;
      // ===== SCORING DEAD-BAND (2026-07-30) =====
      // A directional call graded against a move of 0.01% is not a correct call, and
      // publishing it as one overstates what this record measures. On 2026-07-30, 5 of
      // the 9 scored US days had moved less than 0.25% (median absolute move: 0.21%) -
      // so roughly half the published accuracy was decided by noise rather than by the
      // call. Note the asymmetry this repairs: 'Neutral' already had a 0.5% band, while
      // directional calls had none, so any move at all decided them.
      // Below the band the day records as 'flat' - a real outcome, distinct from 'not
      // yet scored' - and is excluded from the accuracy denominator. The band is stamped
      // on each entry so a later reader can tell which rule graded it; entries with no
      // band field were graded before this rule existed and are left untouched.
      const FLAT_BAND = 0.25;
      if (bullish) result = todayChange > 0 ? 'hit' : 'miss';
      else if (bearish) result = todayChange < 0 ? 'hit' : 'miss';
      else result = Math.abs(todayChange) < 0.5 ? 'hit' : 'miss'; // Neutral: correct only if the market was actually quiet
      // Directional calls only. A Neutral call on a quiet day is a genuine hit, not a
      // non-event: being right that nothing would happen is the whole content of it.
      if ((bullish || bearish) && Math.abs(todayChange) < FLAT_BAND) result = 'flat';
      // session and priorSession record which session graded the call, and which one it was formed on.
      tr.push({ priorDate: prev.date, scoredDate: new RuntimeDate().toISOString().slice(0, 10), priorSentiment: prev.sentiment, actualChange: todayChangeStr, result: result, gapDays: gapDays, model: (prev.model || null), marketTime: todayMarketTime, band: FLAT_BAND, session: todaySession, priorSession: priorSession, phase: MP_PHASE.CURRENT });
      if (tr.length > 30) tr.splice(0, tr.length - 30);
      // Accuracy counts only days the market actually decided. Flats are surfaced beside
      // the ratio rather than hidden, so the reader can see how many days were unjudgeable.
    }

    // ===== RECORD DISPLAY IS UNCONDITIONAL (2026-08-01) =====
    // BUG THIS FIXES: trackRecordAccuracy / trackRecordLast used to be assigned ONLY
    // inside the `scoreable` branch above, while their defaults ('Building history' and
    // '') were set unconditionally at the top. So every run that did not score - a
    // weekend, a holiday, a repeat run, a gap over the ceiling, an outage - published a
    // dashboard claiming the track record did not exist yet. It had already happened at
    // least 9 times (US 07-19, 07-20, 07-24, 07-26, 07-27; CN 07-14, 07-16, 07-24,
    // 07-27), each time while a real scored record was sitting in staticData: on
    // 2026-07-27 the US dashboard said 'Building history' with 7 scored calls on file.
    //
    // Scoring and REPORTING are different questions. Whether a new call can be graded
    // today depends on the market; what the record currently says does not. The record
    // is read from the persisted trackRecord, so it is computed here for every run.
    // The beta (W25): readers see only the grades written by this code. The guards above read
    // every entry, of any phase, so a session still grades at most one call.
    const shown = tr.filter(MP_PHASE.current);
    if (shown.length) {
      const decided = shown.filter(function (x) { return x.result === 'hit' || x.result === 'miss'; });
      const hits = decided.filter(function (x) { return x.result === 'hit'; }).length;
      const flats = shown.filter(function (x) { return x.result === 'flat'; }).length;
      combined.trackRecordAccuracy = decided.length
        ? hits + '/' + decided.length + ' (' + Math.round(100 * hits / decided.length) + '%)' + (flats ? ' · ' + flats + ' too flat to judge' : '')
        : (flats ? '0 judged · ' + flats + ' too flat to judge' : 'Building history');
      const last = shown[shown.length - 1];
      // The call date of the oldest grade shown: the record covers every call made since then.
      combined.trackRecordSince = shown[0].priorDate || '';
      combined.trackRecordLast = last.priorSentiment + ' (' + last.priorDate + ') → market moved ' + last.actualChange + ' → ' + (last.result === 'hit' ? 'Correct' : last.result === 'flat' ? 'Too flat to judge' : 'Miss');
      // ===== BASE RATE BESIDE THE HIT RATE (W4, 2026-10-08) =====
      // A call that rarely changes scores whatever share of days the market moved its way, so the
      // hit rate alone flatters it: in October 2026 all 30 graded US calls in the window were bearish.
      // Readers see how often the market fell on the same judged days, which is what "always down"
      // would have scored.
      const fell = decided.filter(function (x) { return Number.parseFloat(x.actualChange) < 0; }).length;
      if (decided.length === 1) combined.trackRecordBaseline = 'the market ' + (fell ? 'fell' : 'did not fall') + ' on that day';
      else if (decided.length > 1) combined.trackRecordBaseline = 'the market fell on ' + fell + ' of those ' + decided.length + ' days';
    }
  } catch (e) { console.log('[MarketPulse][LEDGER] read/trackrecord skipped: ' + (e && e.message)); }


  if (!combined._health) {
    combined._health = {
      status: 'OUTAGE',
      failed: [{ source: 'ALL', code: 'NO_DATA', msg: 'Fetch node produced no output this run (timeout, crash, or task-runner failure) - see n8n execution log' }],
      missing: ['ALL']
    };
    console.error('\u{1F534} [MarketPulse][DATA-HEALTH] OUTAGE | Fetch node returned nothing at all this run (total upstream failure)');
  }

  // ===== LONG-TERM READING (W15, rules ltr.v1) + VALUATION INPUT CHECKS (W18) =====
  // Code computes the reading before the analyst runs, so the prompt receives it as a
  // fixed fact. Failed input checks join the existing data-quality flags; they never
  // stop the edition. The US reading (ltr.v1) uses CAPE and the Buffett Indicator; the China
  // reading (ltr.cn.v1, W32) uses the CSI 300 P/E against its own history and the 10-year yield.
  combined.longTermReading = null;
  combined.longTermSummary = 'Long-term reading unavailable today.';
  try {
    const sd = $getWorkflowStaticData('global');
    if (!sd.mpLongTerm) sd.mpLongTerm = {};
    if (!sd.mpLongTerm[EDITION]) sd.mpLongTerm[EDITION] = {};
    const result = EDITION === 'CN'
      ? MP_LTR.computeCN(combined, sd.mpLongTerm.CN, new RuntimeDate(), combined.csi300MarketTime)
      : MP_LTR.compute(combined, sd.mpLongTerm.US, new RuntimeDate(), combined.sp500MarketTime);
    combined.longTermReading = result.reading;
    combined.longTermSummary = EDITION === 'CN' ? MP_LTR.promptSummaryCN(result.reading) : MP_LTR.promptSummary(result.reading);
    if (result.flags.length && combined._health && typeof combined._health === 'object') {
      combined._health.suspect = [...(Array.isArray(combined._health.suspect) ? combined._health.suspect : []), ...result.flags];
      console.error('[MarketPulse][INPUT-CHECK] ' + result.flags.map(f => f.field + ':' + f.check).join(', '));
    }
  } catch (e) { console.error('[MarketPulse][LTR] reading unavailable: ' + (e && e.message)); }

  return [{ json: combined }];
}
