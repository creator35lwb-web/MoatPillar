import {additionalEvidence, calendarPresentation, citationEvidence, headlineKey, presentationState, verificationPresentation} from './dashboard-state.mjs';

(function () {
  'use strict';

  var app = document.getElementById('app');
  var tpl = document.getElementById('tpl-report');
  var toggle = document.querySelector('.edition-toggle');
  var loadSequence = 0;

  var LEVELS = ['Cheap', 'Fair', 'Slightly expensive', 'Expensive', 'Very expensive'];
  var BANDS = {shillerPE: {edges: [10, 20, 25, 30, 35, 50], tag: 'CAPE'}, buffettIndicator: {edges: [50, 100, 120, 150, 200, 300], tag: 'Buffett'}};
  var TONE = {Wide: 1, Moderate: 2, Narrow: 3, Thin: 4, 'Bonds pay more': 4};
  var FIELD = {buffettIndicator: 'Buffett Indicator', shillerPE: 'Shiller CAPE', treasury10Y: '10Y Treasury', treasury2Y: '2Y Treasury', cpiValue: 'CPI', yieldCurve: 'Yield curve'};

  // Public links: the same values as src/n8n/public-links.js, which tests/share-feedback.test.mjs
  // holds equal. The feedback form is a Google Form (docs/feedback-form.md); its card stays hidden
  // when no form is set.
  var LINKS = {
    dashboard: 'https://creator35lwb-web.github.io/MoatPillar/',
    channel: 'https://t.me/MoatPillar',
    feedbackForm: 'https://docs.google.com/forms/d/e/1FAIpQLSfxD7YzmLxOOCP580jiIK81aNF_Ky1S4QNpr6JdO0c9JT5cJQ/viewform',
    feedbackDetailsField: 'entry.857131096',
    pitch: 'MoatPillar: a free daily US and China market brief for value investors. ' +
      'A long-term reading on fixed rules, and an AI short-term read that cites its data.'
  };
  // The record published before the beta (W25), archived unchanged by scripts/archive-pre-beta.mjs.
  var ARCHIVE_URL = 'archive/pre-beta.html';
  var current = 'US';
  var dialog = document.querySelector('.share-dialog');
  // The release calendar (W31) is fetched once; a missing or malformed file hides the card and nothing else.
  var calendarPromise = fetch('data/calendar.json', {cache: 'no-store'})
    .then(function (res) { return res.ok ? res.json() : null; })
    .catch(function () { return null; });

  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function changeClass(str) {
    if (typeof str !== 'string') return '';
    var t = str.trim();
    return t.charAt(0) === '+' ? 'up' : t.charAt(0) === '-' ? 'down' : '';
  }
  function sentimentClass(s) {
    var t = String(s || '').toLowerCase();
    return t.indexOf('bullish') !== -1 ? 'bullish' : t.indexOf('bearish') !== -1 ? 'bearish' : 'neutral';
  }
  function fmtDay(dateStr) {
    if (!dateStr) return '';
    var d = new Date(dateStr + 'T12:00:00Z');
    return isNaN(d.getTime()) ? dateStr : d.toLocaleDateString('en-US', {month: 'short', day: 'numeric', timeZone: 'UTC'});
  }
  function fmtLongDay(dateStr) {
    var d = new Date(dateStr + 'T12:00:00Z');
    return Number.isNaN(d.getTime()) ? dateStr : d.toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC'});
  }
  function num(value) { var n = parseFloat(String(value).replace(/[$,%]/g, '')); return isFinite(n) ? n : null; }

  // Each edition has its own address (#us, #cn), so a shared link opens the edition that was shared.
  function editionFromHash() {
    var h = String(window.location.hash || '').toLowerCase();
    return h === '#cn' || h === '#china' ? 'CN' : 'US';
  }
  function editionUrl(edition) { return LINKS.dashboard + (edition === 'CN' ? '#cn' : '#us'); }
  function mytDate(iso) {
    var t = Date.parse(iso);
    return Number.isFinite(t) ? new Date(t + 8 * 3600 * 1000).toISOString().slice(0, 10) : '';
  }
  // Same rule as MP_LINKS.feedback: the form opens with the brief's details filled in.
  function feedbackUrl(details) {
    if (!LINKS.feedbackForm) return '';
    if (!LINKS.feedbackDetailsField || !details) return LINKS.feedbackForm;
    return LINKS.feedbackForm + '?usp=pp_url&' + LINKS.feedbackDetailsField + '=' + encodeURIComponent(details);
  }

  function row(label, value, opts) {
    opts = opts || {};
    var r = el('div', 'ledger-row' + (opts.change === undefined ? ' two-col' : ''));
    if (opts.keys) r.dataset.factkey = opts.keys.join(' ');
    var l = el('div', 'label', label);
    if (opts.period) l.appendChild(el('span', 'period', opts.period));
    r.appendChild(l);
    r.appendChild(el('div', 'value', value));
    if (opts.change !== undefined) r.appendChild(el('div', 'change ' + changeClass(opts.change), opts.change || ''));
    return r;
  }

  // Long-term reading: band meter position for one measure, on a fixed published scale.
  function bandPosition(value, edges) {
    var seg = 0;
    while (seg < 4 && value >= edges[seg + 1]) seg++;
    var within = (value - edges[seg]) / (edges[seg + 1] - edges[seg]);
    return Math.max(0.01, Math.min(0.99, (seg + Math.max(0, Math.min(1, within))) / 5));
  }

  function renderReading(node, data) {
    var card = node.querySelector('.reading-card');
    var body = card.querySelector('.reading-body');
    var note = card.querySelector('.reading-note');
    if (data.edition !== 'US') {
      body.hidden = true;
      note.textContent = 'The long-term reading covers the US market only for now. There is no China valuation source yet.';
      note.hidden = false;
      return;
    }
    var r = data.longTermReading;
    var facts = card.querySelector('.reading-facts');
    function fact(term, valueNode, key) {
      var wrap = el('div');
      if (key) wrap.dataset.factkey = key;
      wrap.appendChild(el('dt', null, term));
      var dd = el('dd');
      dd.appendChild(valueNode);
      wrap.appendChild(dd);
      facts.appendChild(wrap);
      return dd;
    }
    if (!r) {
      // Payload published before the long-term reading existed: show the published measures.
      card.querySelector('.verdict').hidden = true;
      card.querySelector('.band-meter').hidden = true;
      card.querySelector('.changes').hidden = true;
      Object.keys(data.dashboard || {}).forEach(function (key) {
        var d = data.dashboard[key];
        var v = el('span', null, d.value);
        var dd = fact(d.title, v, key);
        if (d.status) dd.appendChild(el('span', 'sub', d.status));
      });
      note.textContent = 'The long-term reading starts with the next edition published under the new rules. Until then, the published valuation measures are shown.';
      note.hidden = false;
      return;
    }
    var word = card.querySelector('.verdict-word');
    var status = card.querySelector('.verdict-status');
    if (!r.valuation) {
      word.textContent = 'Unavailable today';
      status.textContent = 'The valuation inputs did not pass their checks, and there is no earlier reading to hold.';
      card.querySelector('.band-meter').hidden = true;
      card.querySelector('.changes').hidden = true;
    } else {
      word.textContent = r.valuation.label;
      word.dataset.level = String(r.valuation.hi);
      var since = fmtDay(r.since);
      var line = r.status === 'first' ? 'First reading under the published rules'
        : r.status === 'changed' ? 'Changed today'
        : r.status === 'held' ? 'Held since ' + since + ' while today’s inputs are checked'
        : 'Unchanged since ' + since;
      if (r.pending) line += ' · watching a move to ' + String(r.pending.label).toLowerCase() + ' (' + r.pending.count + ' of ' + r.pending.of + ' sessions)';
      status.textContent = line;

      // One track per measure on the same five-band scale, so agreement (or a July-style
      // disagreement) is visible at a glance.
      var meter = card.querySelector('.band-meter');
      var rows = meter.querySelector('.band-rows');
      var labels = meter.querySelector('.band-labels');
      for (var level = 1; level <= 5; level++) {
        labels.appendChild(el('span', level >= r.valuation.lo && level <= r.valuation.hi ? 'is-current' : '', LEVELS[level - 1]));
      }
      var described = [];
      ['buffettIndicator', 'shillerPE'].forEach(function (key) {
        var m = r.measures && r.measures[key];
        var value = m ? num(m.value) : null;
        if (value === null) return;
        var bandRow = el('div', 'band-row');
        bandRow.dataset.factkey = key;
        var track = el('div', 'band-track');
        for (var lv = 1; lv <= 5; lv++) {
          var seg = el('div', 'band-seg' + (lv === m.level ? ' is-current' : ''));
          seg.dataset.level = String(lv);
          track.appendChild(seg);
        }
        var marker = el('div', 'band-marker');
        var position = bandPosition(value, BANDS[key].edges);
        marker.style.left = (position * 100) + '%';
        var tag = el('span', 'tag' + (position > 0.75 ? ' is-left' : position < 0.25 ? ' is-right' : ''), BANDS[key].tag + ' ' + m.value);
        marker.appendChild(tag);
        track.appendChild(marker);
        bandRow.appendChild(track);
        rows.appendChild(bandRow);
        described.push(m.label + ' ' + m.value + ' (' + m.levelLabel + ')');
      });
      meter.setAttribute('aria-label', 'Valuation bands from Cheap to Very expensive. ' + described.join('; ') + '.');

      var list = card.querySelector('.change-list');
      (r.changes || []).forEach(function (c) {
        var li = el('li');
        var text = el('span');
        if (c.kind === 'valuation') {
          li.appendChild(el('span', 'arrow', c.direction === 'down' ? '↘' : '↗'));
          text.appendChild(el('b', null, c.target));
          text.appendChild(document.createTextNode(': '));
          c.conditions.forEach(function (x, i) {
            if (i) text.appendChild(document.createTextNode(' and '));
            text.appendChild(document.createTextNode((x.key === 'shillerPE' ? 'CAPE' : 'Buffett Indicator') + (x.direction === 'down' ? ' under ' : ' at ')));
            text.appendChild(el('code', null, x.threshold + x.unit));
            if (x.direction === 'up') text.appendChild(document.createTextNode(' or more'));
          });
          var allMet = c.conditions.every(function (x) { return x.met; });
          text.appendChild(el('span', 'distance', allMet ? ' · met, waiting for confirmation'
            : ' · about ' + c.conditions.map(function (x) { return x.movePct + '%'; }).join(' and ') + (c.direction === 'down' ? ' lower prices' : ' higher prices') + ' at today’s earnings and GDP'));
        } else if (c.kind === 'rates') {
          li.appendChild(el('span', 'arrow', '↔'));
          text.appendChild(document.createTextNode('Rates turn '));
          c.boundaries.forEach(function (b, i) {
            if (i) text.appendChild(document.createTextNode('; '));
            text.appendChild(el('b', null, b.label));
            text.appendChild(document.createTextNode(b.direction === 'up' ? ' at ' : ' below '));
            text.appendChild(el('code', null, (b.at > 0 ? '+' + b.at.toFixed(2) : b.at.toFixed(0)) + '%'));
          });
        } else {
          li.appendChild(el('span', 'arrow', '◦'));
          text.textContent = 'Mood alone doesn’t change the reading; prices or earnings have to move.';
        }
        li.appendChild(text);
        list.appendChild(li);
      });
      if (!list.children.length) card.querySelector('.changes').hidden = true;
    }
    if (r.marginOfSafety) {
      fact('Margin of safety on offer', el('span', 'chip tone-' + (TONE[r.marginOfSafety] || 2), r.marginOfSafety));
    }
    if (r.stocksVsBonds) {
      var s = r.stocksVsBonds;
      var dd = fact('Stocks vs bonds, after inflation', el('span', 'chip tone-' + (TONE[s.label] || 2), s.label));
      dd.appendChild(el('span', 'sub', 'Earnings yield ' + s.earningsYield.toFixed(1) + '% vs real 10-year ' + s.realYield10Y.toFixed(1) + '%'));
    }
    ['buffettIndicator', 'shillerPE'].forEach(function (key) {
      var m = r.measures && r.measures[key];
      if (!m) return;
      var dd2 = fact(m.label, el('span', null, m.value), key);
      dd2.appendChild(el('span', 'sub', m.levelLabel));
    });
  }

  function renderContext(node, data) {
    var strip = node.querySelector('.context-strip');
    if (data.edition !== 'US') { strip.hidden = true; return; }
    var facts = data.facts || {};
    var r = data.longTermReading || {};
    var mood = node.querySelector('.mood-tile');
    if (data.fearGreed && typeof data.fearGreed.score === 'number' && isFinite(data.fearGreed.score)) {
      mood.querySelector('.mood-score').textContent = String(data.fearGreed.score);
      mood.querySelector('.mood-label').textContent = (r.mood ? r.mood.label : data.fearGreed.classification) +
        (data.fearGreed.change1d ? ' · 1d ' + data.fearGreed.change1d : '') + (data.fearGreed.change1w ? ' · 1w ' + data.fearGreed.change1w : '');
      mood.querySelector('.gauge-dot').style.left = Math.max(0, Math.min(100, data.fearGreed.score)) + '%';
    } else mood.hidden = true;
    var trend = node.querySelector('.trend-tile');
    if (facts.sp500VsMa200) {
      trend.querySelector('.trend-value').textContent = facts.sp500VsMa200;
      trend.querySelector('.trend-value').classList.add(changeClass(facts.sp500VsMa200) === 'down' ? 'is-down' : 'is-up');
      trend.querySelector('.trend-label').textContent = 'S&P 500 vs its 200-day average' + (facts.maSignal ? ' · ' + facts.maSignal : '');
    } else trend.hidden = true;
    var rates = node.querySelector('.rates-tile');
    if (facts.yieldCurve) {
      rates.querySelector('.curve-value').textContent = facts.yieldCurve;
      var parts = [(r.rates ? r.rates.label : 'Yield') + ' curve, 10Y minus 2Y'];
      if (facts.treasury10Y) parts.push('10Y ' + facts.treasury10Y);
      if (facts.treasury2Y) parts.push('2Y ' + facts.treasury2Y);
      rates.querySelector('.curve-label').textContent = parts.join(' · ');
    } else rates.hidden = true;
  }

  function healthBanner(node, data) {
    var banner = node.querySelector('.data-health-banner');
    function set(bold, rest) {
      banner.textContent = '';
      banner.appendChild(el('b', null, bold));
      banner.appendChild(document.createTextNode(' ' + rest));
      banner.hidden = false;
    }
    var h = data.health || {};
    var suspect = Array.isArray(h.suspect) ? h.suspect : [];
    if (h.status === 'OUTAGE') set('Data outage.', 'Most live sources failed to load this run. Values below may be missing.');
    else if (h.status === 'DEGRADED') set('Partial data.', 'Some sources were unavailable this run.');
    else if (suspect.length) {
      var parts = [], cross = [];
      suspect.forEach(function (s) {
        var name = FIELD[s.field] || s.field;
        if (s.check === 'crosscheck') cross.push(name + ' ' + s.value);
        else if (s.check === 'range') parts.push(name + ' ' + s.value + ' is outside its plausible range');
        else if (s.check === 'jump') parts.push(name + ' ' + s.value + ' moved more than ' + s.bound + '% since the last session');
        else parts.push(name + ' (' + s.value + ') moved unusually');
      });
      if (cross.length) parts.push('the two valuation measures disagree (' + cross.join(' vs ') + ')');
      set('Data check.', parts.join('; ') + '. Treat these readings with care until confirmed.');
    }
  }

  function renderCalendar(node, data, calendar) {
    var section = node.querySelector('.calendar-section');
    var shown = calendarPresentation(calendar, data, new Date(), 5);
    if (!shown.items.length) { section.hidden = true; return; }
    section.hidden = false;
    var list = section.querySelector('.calendar-list');
    shown.items.forEach(function (item) {
      var li = el('li', 'calendar-item' + (item.status === 'done' ? ' is-done' : '') + (item.today ? ' is-today' : ''));
      li.appendChild(el('span', 'when', item.when));
      var name = el('span', 'name', item.name);
      if (item.region) name.appendChild(el('span', 'region', item.region));
      li.appendChild(name);
      var flag = item.status === 'done' ? (item.today ? 'Released today' : 'Released')
        : item.status === 'in-progress' ? 'In progress' : item.today ? 'Today' : '';
      if (flag) li.appendChild(el('span', 'flag', flag));
      if (item.source) {
        var a = el('a', 'src', 'source');
        a.href = item.source.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.title = item.source.name;
        li.appendChild(a);
      }
      list.appendChild(li);
    });
    section.querySelector('.calendar-sources').textContent = shown.sourceNames.length
      ? 'Dates from ' + shown.sourceNames.join('; ') + '. Shown in Malaysia time.' : '';
  }

  function render(data, calendar) {
    app.innerHTML = '';
    var node = tpl.content.cloneNode(true);
    var state = presentationState(data);
    var analysis = state.legacy || state.approved ? (data.analysis || {}) : {};
    var verification = verificationPresentation(data, state);

    node.querySelector('.edition-name').textContent = data.edition === 'CN' ? 'China' : 'US';
    node.querySelector('.date').textContent = data.dateLabel || '';
    var asof = node.querySelector('.asof');
    if (data.asOf && data.asOf.label) {
      asof.querySelector('.asof-label').textContent = data.asOf.label;
      if (data.asOf.closed || data.asOf.intraday) asof.classList.add('is-flagged');
    } else asof.hidden = true;
    node.querySelector('.publication-time').textContent = state.validTime
      ? 'Published ' + new Date(data.generatedAt).toLocaleString('en-GB', {timeZone: 'Asia/Kuala_Lumpur'}) + ' MYT. Source reference periods may differ.'
      : 'Publication time unavailable.';

    var publication = node.querySelector('.publication-banner');
    var statusParts = [];
    if (state.stale) statusParts.push('A current update could not be confirmed. Latest expected publication date: ' + state.expectedDate + ' (UTC).');
    if (state.validTime && state.publicationDate < state.expectedDate) statusParts.push('This brief was published earlier and is overdue for an update.');
    if (!state.validTime) statusParts.push('The publication timestamp is missing, invalid, or in the future.');
    if (state.offSchedule) statusParts.push('This publication falls outside the China weekday schedule.');
    if (state.legacy) statusParts.push('Historical brief: its commentary predates the current verification checks.');
    if (state.stale || state.legacy) { publication.textContent = statusParts.join(' '); publication.hidden = false; }

    healthBanner(node, data);
    renderReading(node, data);
    renderContext(node, data);

    // Short-term read (the AI layer), with the claim-to-evidence interaction.
    var sentiment = analysis.sentiment || 'Unavailable';
    node.querySelector('.sentiment-word').textContent = state.stale || state.legacy ? sentiment + ' (archived)' : sentiment;
    node.querySelector('.read-dot').classList.add(sentimentClass(analysis.sentiment));
    node.querySelector('.confidence').textContent = analysis.confidence ? 'confidence ' + analysis.confidence : '';
    var claims = analysis.claims || [];
    node.querySelector('.hint').hidden = claims.length === 0;
    if (!claims.length) {
      node.querySelector('.analysis-notice').textContent = verification.message;
      node.querySelector('.analysis-notice').hidden = false;
    }
    var claimsEl = node.querySelector('.claims');
    claims.forEach(function (c) {
      var claim = el('div', 'claim');
      claim.tabIndex = 0;
      claim.setAttribute('role', 'button');
      claim.setAttribute('aria-pressed', 'false');
      claim.dataset.basedon = JSON.stringify(c.basedOn || []);
      var dir = c.direction === 'supports_bullish' ? 'supports_bullish' : c.direction === 'supports_bearish' ? 'supports_bearish' : 'neutral';
      claim.appendChild(el('div', 'dir ' + dir, dir === 'supports_bullish' ? '▲' : dir === 'supports_bearish' ? '▼' : '◆'));
      var body = el('div');
      body.appendChild(el('div', 'text', c.text));
      body.appendChild(el('div', 'evidence-tag', '→ ' + (c.basedOn || []).map(function (key) {
        var evidence = citationEvidence(data, key);
        return evidence ? evidence.label : key + ' (evidence unavailable)';
      }).join(', ')));
      claim.appendChild(body);
      claimsEl.appendChild(claim);
    });
    node.querySelector('.interpretation').textContent = analysis.interpretation || '';
    var wisdom = node.querySelector('.wisdom');
    if (analysis.wisdom) wisdom.textContent = '“' + analysis.wisdom + '”'; else wisdom.hidden = true;
    var verifiedStrip = node.querySelector('.verified-strip');
    verifiedStrip.textContent = verification.message + (data.analysisModel ? ' Written by ' + data.analysisModel + (data.analysisProvider ? ' (' + data.analysisProvider + ')' : '') + '.' : '');
    verifiedStrip.dataset.status = verification.tone;

    // Source tables.
    var screener = node.querySelector('.screener-ledger');
    (data.screener || []).forEach(function (s) {
      screener.appendChild(row(s.label, s.value, {change: s.change, keys: [s.factKey, s.factKey.replace(/Change$/, '')]}));
    });
    var econ = node.querySelector('.economic-ledger');
    (data.economic || []).forEach(function (e) {
      econ.appendChild(row(e.label, e.value, {period: e.period || '', keys: [e.factKey]}));
    });
    var watchText = (data.watchlist || '').trim();
    var watchBlock = node.querySelector('.watchlist-block');
    // Rendered as the fetched text, never re-parsed into structure.
    if (watchText) { watchBlock.textContent = watchText; watchBlock.hidden = false; }
    else node.querySelector('.watchlist-section').hidden = true;

    if (data.trackRecord) {
      node.querySelector('.accuracy').textContent = data.trackRecord.accuracy || 'Building history';
      node.querySelector('.last').textContent = data.trackRecord.last ? 'Last: ' + data.trackRecord.last : '';
      // The base rate on the same judged days (W4): what "always down" would have scored.
      if (data.trackRecord.baseline) {
        var baseline = node.querySelector('.baseline');
        baseline.textContent = 'For comparison, ' + data.trackRecord.baseline + '.';
        baseline.hidden = false;
      }
      // The beta record (W25): where it starts, and the record from before the beta, archived unchanged.
      if (data.trackRecord.phase === 'beta') {
        var phaseNote = node.querySelector('.phase-note');
        phaseNote.textContent = data.trackRecord.since
          ? 'Beta record since ' + fmtLongDay(data.trackRecord.since) + '. '
          : 'The beta record starts once its first call is graded. ';
        var archive = el('a', null, 'See the record from before the beta');
        archive.href = ARCHIVE_URL;
        phaseNote.appendChild(archive);
        phaseNote.hidden = false;
      }
    }
    document.querySelector('.beta-tag').hidden = data.trackRecord?.phase !== 'beta';
    var history = data.history || [];
    if (history.length < 2) {
      node.querySelector('.history-empty').hidden = false;
      node.querySelector('.history-legend').hidden = true;
    } else {
      var strip = node.querySelector('.history-strip');
      history.forEach(function (h) {
        var cell = el('div', 'history-cell ' + sentimentClass(h.sentiment));
        cell.tabIndex = 0;
        cell.setAttribute('role', 'listitem');
        cell.title = fmtDay(h.date) + ': ' + (h.sentiment || 'n/a');
        cell.dataset.date = h.date || '';
        cell.dataset.sentiment = h.sentiment || 'n/a';
        cell.dataset.result = h.result || '';
        cell.dataset.actualChange = h.actualChange || '';
        cell.appendChild(el('div', 'history-dot' + (h.result ? ' ' + h.result : '')));
        strip.appendChild(cell);
      });
    }

    renderCalendar(node, data, calendar);

    var news = data.news || [];
    if (news.length) {
      var list = node.querySelector('.news-list');
      news.forEach(function (n, index) {
        var li = el('li', 'news-item');
        var key = headlineKey(n, index, state.legacy);
        if (key) { li.dataset.factkey = key; li.value = Number(key.slice(9)); }
        if (typeof n.url === 'string' && /^https?:\/\//i.test(n.url)) {
          var a = el('a', null, n.title);
          a.href = n.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
          li.appendChild(a);
        } else {
          li.textContent = n.title;
          li.appendChild(el('span', 'source-link-unavailable', ' — source link unavailable'));
        }
        list.appendChild(li);
      });
    } else node.querySelector('.news-section').hidden = true;

    // Cited facts with no visible row elsewhere (for example watchlist changes).
    var visibleKeys = [];
    node.querySelectorAll('[data-factkey]').forEach(function (r) { visibleKeys.push.apply(visibleKeys, r.dataset.factkey.split(' ')); });
    var extra = node.querySelector('.extra-evidence-ledger');
    additionalEvidence(data, claims, visibleKeys).forEach(function (evidence) {
      var r = row(evidence.label, evidence.value, {keys: [evidence.key]});
      if (!evidence.available) r.classList.add('evidence-unavailable');
      extra.appendChild(r);
      node.querySelector('.extra-evidence-section').hidden = false;
    });

    node.querySelector('.sources').textContent = 'Sources: ' + (data.sources || []).join(', ');

    // Join, share and feedback. The feedback card appears only when a form is set.
    node.querySelector('.channel-link').href = LINKS.channel;
    var feedback = feedbackUrl(['dashboard', data.edition, mytDate(data.generatedAt)].filter(Boolean).join(' · '));
    if (feedback) {
      node.querySelector('.feedback-link').href = feedback;
      node.querySelector('.feedback-card').hidden = false;
    } else node.querySelector('.connect-grid').classList.add('is-single');
    document.title = 'MoatPillar — ' + (data.edition === 'CN' ? 'China' : 'US') + ' Brief';
    app.appendChild(node);
    wireInteraction();
  }

  function wireInteraction() {
    var byKey = new Map();
    app.querySelectorAll('[data-factkey]').forEach(function (r) {
      r.dataset.factkey.split(' ').forEach(function (k) {
        var rows = byKey.get(k) || [];
        rows.push(r);
        byKey.set(k, rows);
      });
    });
    function clearActive() {
      app.querySelectorAll('.is-cited').forEach(function (r) { r.classList.remove('is-cited'); });
      app.querySelectorAll('.claim.is-active').forEach(function (c) { c.classList.remove('is-active'); c.setAttribute('aria-pressed', 'false'); });
    }
    function activateClaim(claim) {
      var wasActive = claim.classList.contains('is-active');
      clearActive();
      if (wasActive) return;
      claim.classList.add('is-active');
      claim.setAttribute('aria-pressed', 'true');
      var first = null;
      JSON.parse(claim.dataset.basedon || '[]').forEach(function (k) {
        (byKey.get(k) || []).forEach(function (r) { r.classList.add('is-cited'); if (!first) first = r; });
      });
      if (first) first.scrollIntoView({behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center'});
    }
    app.querySelectorAll('.claim').forEach(function (claim) {
      claim.addEventListener('click', function () { activateClaim(claim); });
      claim.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); activateClaim(claim); } });
    });
    var word = app.querySelector('.sentiment-word');
    if (word) word.addEventListener('click', function () { var c = app.querySelector('.claim'); if (c) activateClaim(c); });

    var detail = app.querySelector('.history-detail');
    function showDay(cell) {
      app.querySelectorAll('.history-cell.is-active').forEach(function (c) { c.classList.remove('is-active'); });
      cell.classList.add('is-active');
      if (!detail) return;
      detail.querySelector('.history-detail-date').textContent = fmtDay(cell.dataset.date);
      detail.querySelector('.history-detail-sentiment').textContent = cell.dataset.sentiment;
      var result = cell.dataset.result;
      // "flat" is a real outcome: the market moved too little for a directional call to be
      // right or wrong. It stays distinct from "not yet scored", which means no verdict exists.
      detail.querySelector('.history-detail-result').textContent = result === 'hit' ? '✓ correct — market moved ' + cell.dataset.actualChange
        : result === 'miss' ? '✗ missed — market moved ' + cell.dataset.actualChange
        : result === 'flat' ? '— too flat to judge — market moved only ' + cell.dataset.actualChange
        : 'not yet scored';
      detail.hidden = false;
    }
    app.querySelectorAll('.history-cell').forEach(function (cell) {
      cell.addEventListener('click', function () { showDay(cell); });
      cell.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); showDay(cell); } });
    });
  }

  function showError(message) {
    app.innerHTML = '';
    app.appendChild(el('p', 'state-msg', message));
  }

  function load(edition) {
    var requestSequence = ++loadSequence;
    app.innerHTML = '';
    app.appendChild(el('p', 'state-msg', 'Loading the latest brief…'));
    var brief = fetch('data/latest-' + edition.toLowerCase() + '.json', {cache: 'no-store'})
      .then(function (res) {
        if (!res.ok) throw new Error('No brief published yet for this edition.');
        return res.json();
      });
    Promise.all([brief, calendarPromise])
      .then(function (results) {
        var data = results[0];
        if (requestSequence !== loadSequence) return;
        if (data.edition !== edition) throw new Error('The published brief does not match the selected edition.');
        render(data, results[1]);
      })
      .catch(function (err) { if (requestSequence === loadSequence) showError(err.message || 'Could not load the latest brief.'); });
  }

  // ---------- Share ----------
  // No tracking parameters: the shared link is the edition's plain address.
  function shareTargets(url, text) {
    var u = encodeURIComponent(url);
    var t = encodeURIComponent(text);
    return {
      whatsapp: 'https://wa.me/?text=' + encodeURIComponent(text + ' ' + url),
      telegram: 'https://t.me/share/url?url=' + u + '&text=' + t,
      facebook: 'https://www.facebook.com/sharer/sharer.php?u=' + u,
      x: 'https://x.com/intent/tweet?text=' + t + '&url=' + u,
      linkedin: 'https://www.linkedin.com/sharing/share-offsite/?url=' + u,
      email: 'mailto:?subject=' + encodeURIComponent('MoatPillar · daily market brief') + '&body=' + encodeURIComponent(text + '\n\n' + url)
    };
  }
  function openShare() {
    var url = editionUrl(current);
    // Phones and tablets get their own share sheet; elsewhere, a small panel of links.
    if (navigator.share && window.matchMedia('(pointer: coarse)').matches) {
      navigator.share({title: document.title, text: LINKS.pitch, url: url}).catch(function () { /* dismissed */ });
      return;
    }
    if (!dialog) return;
    var targets = shareTargets(url, LINKS.pitch);
    dialog.querySelector('.share-pitch').textContent = LINKS.pitch;
    dialog.querySelector('.share-url').value = url;
    dialog.querySelector('.copy-label').textContent = 'Copy link';
    dialog.querySelectorAll('[data-share]').forEach(function (a) { a.href = targets[a.dataset.share]; });
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
  }
  function closeShare() {
    if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open');
  }
  function copyLink() {
    var input = dialog.querySelector('.share-url');
    var label = dialog.querySelector('.copy-label');
    function selected() { input.focus(); input.select(); label.textContent = 'Link selected'; }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(input.value).then(function () { label.textContent = 'Copied'; }, selected);
    } else selected();
  }
  document.addEventListener('click', function (ev) {
    if (ev.target.closest('.share-open')) openShare();
  });
  if (dialog) {
    dialog.querySelector('.share-close').addEventListener('click', closeShare);
    dialog.querySelector('.copy-link').addEventListener('click', copyLink);
    // A click on the backdrop (outside the panel's box) closes it.
    dialog.addEventListener('click', function (ev) {
      if (ev.target !== dialog) return;
      var r = dialog.getBoundingClientRect();
      if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) closeShare();
    });
  }

  // ---------- Edition ----------
  function select(edition) {
    current = edition;
    if (toggle) toggle.querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.edition === edition)); });
    load(edition);
  }
  if (toggle) {
    toggle.addEventListener('click', function (ev) {
      var btn = ev.target.closest('button[data-edition]');
      if (!btn) return;
      if (window.history?.replaceState) window.history.replaceState(null, '', btn.dataset.edition === 'CN' ? '#cn' : '#us');
      select(btn.dataset.edition);
    });
  }
  window.addEventListener('hashchange', function () {
    var edition = editionFromHash();
    if (edition !== current) select(edition);
  });
  select(editionFromHash());
})();
