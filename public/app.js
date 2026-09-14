/* ============================================================================
   USD/KHR Tracker — dashboard app
   Vanilla JS: polls the local API, renders the hero, chart, converter, alerts,
   pair board and capture log. No build step, no dependencies.
   ========================================================================== */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    statusPill: $('status-pill'),
    statusPillText: $('status-pill-text'),
    lastUpdate: $('last-update'),
    banner: $('banner'),
    tickerInner: $('ticker-inner'),
    pairLabel: $('pair-label'),
    pairName: $('pair-name'),
    rateMid: $('rate-mid'),
    rateUnit: $('rate-unit'),
    heroDeltas: $('hero-deltas'),
    metaAsof: $('meta-asof'),
    metaCaptured: $('meta-captured'),
    metaSource: $('meta-source'),
    statBid: $('stat-bid'),
    statAsk: $('stat-ask'),
    statBidDelta: $('stat-bid-delta'),
    statAskDelta: $('stat-ask-delta'),
    statSpread: $('stat-spread'),
    statSpreadPct: $('stat-spread-pct'),
    statRange: $('stat-range'),
    statRangeCount: $('stat-range-count'),
    rangeButtons: $('range-buttons'),
    fieldButtons: $('field-buttons'),
    grainButtons: $('grain-buttons'),
    btnDailyCsv: $('btn-daily-csv'),
    chartSubtitle: $('chart-subtitle'),
    chartCanvas: $('chart'),
    chartTooltip: $('chart-tooltip'),
    chartEmpty: $('chart-empty'),
    chartLegendLabel: $('chart-legend-label'),
    chartPoints: $('chart-points'),
    chartSummary: $('chart-summary'),
    converterRate: $('converter-rate'),
    convertAmount: $('convert-amount'),
    dirUsdKhr: $('dir-usd-khr'),
    dirKhrUsd: $('dir-khr-usd'),
    convertResult: $('convert-result'),
    convertNotes: $('convert-notes'),
    alertHigh: $('alert-high'),
    alertLow: $('alert-low'),
    btnSaveAlerts: $('btn-save-alerts'),
    btnNotify: $('btn-notify'),
    alertState: $('alert-state'),
    healthList: $('health-list'),
    healthNext: $('health-next'),
    pairsTable: $('pairs-table').querySelector('tbody'),
    logTable: $('log-table').querySelector('tbody'),
    btnMoreLog: $('btn-more-log'),
    logCount: $('log-count'),
    btnCsv: $('btn-csv'),
    btnRefresh: $('btn-refresh'),
    btnTheme: $('btn-theme'),
    toasts: $('toasts'),
    footBuild: $('foot-build'),
  };

  const RANGES = [
    { id: '24h', label: '24H' },
    { id: '7d', label: '7D' },
    { id: '30d', label: '30D' },
    { id: '90d', label: '90D' },
    { id: '1y', label: '1Y' },
    { id: 'all', label: 'ALL' },
  ];
  const POLL_LATEST_MS = 30_000;
  const POLL_HISTORY_MS = 60_000;
  const STORAGE_KEY = 'usdkhr-tracker-v1';

  const state = {
    pair: 'USD/KHR',
    field: 'mid',
    range: '30d',
    /** 'auto' buckets raw samples; 'daily' plots one snapshot per calendar day. */
    grain: 'auto',
    direction: 'usd-khr',
    latest: null,
    history: null,
    status: null,
    quotes: [],
    pairs: [],
    observations: [],
    logOffset: 0,
    alerts: { high: null, low: null, notify: false, lastFired: 0 },
    chart: null,
    timers: [],
    lastMid: null,
  };

  // --- utilities -------------------------------------------------------------

  function loadPrefs() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      if (raw.pair) state.pair = raw.pair;
      if (raw.field) state.field = raw.field;
      if (raw.range) state.range = raw.range;
      if (raw.grain === 'daily' || raw.grain === 'auto') state.grain = raw.grain;
      if (raw.direction) state.direction = raw.direction;
      if (raw.theme) setTheme(raw.theme, false);
      if (raw.alerts) state.alerts = Object.assign(state.alerts, raw.alerts);
    } catch { /* first visit */ }
  }

  function savePrefs() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          pair: state.pair,
          field: state.field,
          range: state.range,
          grain: state.grain,
          direction: state.direction,
          theme: document.documentElement.dataset.theme,
          alerts: state.alerts,
        })
      );
    } catch { /* private mode */ }
  }

  function decimalsFor(value) {
    const v = Math.abs(value || 0);
    if (v >= 1000) return 2;
    if (v >= 100) return 3;
    if (v >= 1) return 4;
    return 6;
  }

  function fmt(value, decimals) {
    if (value === null || value === undefined || Number.isNaN(value)) return '—';
    const d = decimals === undefined ? decimalsFor(value) : decimals;
    return value.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  function fmtSigned(value, decimals) {
    if (value === null || value === undefined || Number.isNaN(value)) return '—';
    const sign = value > 0 ? '+' : value < 0 ? '−' : '±';
    return `${sign}${fmt(Math.abs(value), decimals)}`;
  }

  function fmtPct(value) {
    if (value === null || value === undefined || Number.isNaN(value)) return '—';
    const sign = value > 0 ? '+' : value < 0 ? '−' : '±';
    return `${sign}${Math.abs(value).toFixed(Math.abs(value) < 1 ? 3 : 2)}%`;
  }

  function relTime(isoOrMs) {
    const t = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs);
    if (!t || Number.isNaN(t)) return '—';
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 10) return 'just now';
    if (s < 60) return `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} h ago`;
    const d = Math.round(h / 24);
    return `${d} d ago`;
  }

  function inTime(isoOrMs) {
    const t = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs);
    if (!t || Number.isNaN(t)) return '—';
    const s = Math.round((t - Date.now()) / 1000);
    if (s <= 0) return 'now';
    if (s < 60) return `in ${s}s`;
    const m = Math.round(s / 60);
    if (m < 60) return `in ${m} min`;
    return `in ${Math.round(m / 60)} h`;
  }

  function utcStamp(isoOrMs) {
    const t = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs);
    if (!t) return '—';
    const d = new Date(t);
    return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 19)}Z`;
  }

  function toast(message, kind = 'info', ttl = 4200) {
    const node = document.createElement('div');
    node.className = `toast toast-${kind}`;
    node.textContent = message;
    els.toasts.appendChild(node);
    setTimeout(() => {
      node.style.transition = 'opacity .3s ease';
      node.style.opacity = '0';
      setTimeout(() => node.remove(), 320);
    }, ttl);
  }

  async function api(path, options) {
    const res = await fetch(path, Object.assign({ headers: { Accept: 'application/json' } }, options || {}));
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { ok: false, error: text.slice(0, 200) }; }
    if (!res.ok && !(data && data.error)) throw new Error(`HTTP ${res.status}`);
    return { status: res.status, data };
  }

  function setTheme(theme, persist = true) {
    document.documentElement.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'light' ? '#f3f5fa' : '#0b1020');
    if (persist) savePrefs();
    if (state.chart) {
      const light = theme === 'light';
      state.chart.setTheme({
        gridColor: light ? 'rgba(16,23,40,0.09)' : 'rgba(255,255,255,0.07)',
        axisColor: light ? 'rgba(16,23,40,0.6)' : 'rgba(190,200,225,0.72)',
        color: light ? '#e2590c' : '#ff7a1a',
        bandColor: light ? 'rgba(226,89,12,0.12)' : 'rgba(255,122,26,0.14)',
      });
    }
  }

  // --- rendering -------------------------------------------------------------

  function renderStatus() {
    const status = state.status;
    const quote = state.latest?.quote;
    let kind = 'unknown';
    let label = 'connecting…';

    if (status?.simulation?.active) {
      kind = 'sim';
      label = 'simulated';
    } else if (!quote) {
      kind = 'offline';
      label = 'no data';
    } else if (status?.stale) {
      kind = 'stale';
      label = 'stale';
    } else if (status?.scraper?.lastError) {
      kind = 'stale';
      label = 'degraded';
    } else {
      kind = 'live';
      label = 'tracking';
    }

    els.statusPill.className = `pill pill-${kind}`;
    els.statusPillText.textContent = label;
    els.lastUpdate.textContent = quote ? `updated ${relTime(quote.capturedAt)}` : 'awaiting first capture';
  }

  function renderBanner() {
    const messages = [];
    const status = state.status;
    const quote = state.latest?.quote;

    if (status?.simulation?.active) {
      messages.push(
        `<strong>Simulated data.</strong> This host cannot reach wingbank.com.kh, so the tracker generated a demo series ` +
          `(last real source error: <code>${escapeHtml(status.scraper?.lastError || 'unknown')}</code>). ` +
          `Deploy where outbound HTTPS is allowed — or set <code>FALLBACK_SOURCES</code> — for live rates.`
      );
    } else if (quote && status?.stale) {
      messages.push(
        `<strong>Stale data.</strong> Last successful capture was ${relTime(quote.capturedAt)} (older than ${status.staleThresholdMin} min). ` +
          `The scraper retries with backoff; press <b>Refresh</b> to try now.`
      );
    } else if (status?.scraper?.lastError) {
      messages.push(`<strong>Last scrape failed:</strong> <code>${escapeHtml(status.scraper.lastError)}</code> — showing the last known reading.`);
    }

    const alertMsg = evaluateAlerts(quote);
    if (alertMsg) messages.unshift(alertMsg);

    if (!messages.length) {
      els.banner.hidden = true;
      els.banner.innerHTML = '';
      return;
    }
    els.banner.hidden = false;
    els.banner.className = `banner ${status?.simulation?.active ? 'banner-warn' : alertMsg ? 'banner-warn' : 'banner-error'}`;
    els.banner.innerHTML = messages.map((m) => `<p>${m}</p>`).join('');
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function renderHero() {
    const quote = state.latest?.quote;
    const changes = state.latest?.changes || {};
    els.pairLabel.textContent = state.pair;
    els.pairName.textContent = quote?.name || '';

    if (!quote) {
      els.rateMid.textContent = '—';
      ['stat-bid', 'stat-ask', 'stat-spread', 'stat-range'].forEach((id) => ($(id).textContent = '—'));
      els.metaAsof.textContent = '—';
      els.metaCaptured.textContent = '—';
      els.metaSource.textContent = '—';
      return;
    }

    const decimals = quote.decimals ?? decimalsFor(quote.mid);
    const mid = state.field === 'spread' ? quote.spread : quote[state.field] ?? quote.mid;
    els.rateMid.textContent = fmt(mid, decimals);
    els.rateMid.setAttribute('aria-label', `${state.pair} ${state.field} rate ${fmt(mid, decimals)}`);

    // "KHR per 1 USD" — derived from the pair so switching pairs stays correct.
    const [baseCcy, quoteCcy] = state.pair.split('/');
    els.rateUnit.textContent =
      state.field === 'spread' ? `${quoteCcy} spread per 1 ${baseCcy}` : `${quoteCcy} per 1 ${baseCcy}`;
    document.title = `${fmt(mid, decimals)} · ${state.pair} — Wing Bank rate tracker`;

    // flash on change
    if (state.lastMid !== null && mid !== state.lastMid) {
      els.rateMid.classList.remove('flash-up', 'flash-down');
      void els.rateMid.offsetWidth;
      els.rateMid.classList.add(mid > state.lastMid ? 'flash-up' : 'flash-down');
    }
    state.lastMid = mid;

    els.statBid.textContent = fmt(quote.bid, decimals);
    els.statAsk.textContent = fmt(quote.ask, decimals);
    els.statSpread.textContent = quote.spread !== null ? fmt(quote.spread, Math.max(2, decimals)) : '—';
    els.statSpreadPct.textContent = quote.spreadPct !== null ? `${quote.spreadPct.toFixed(3)}% over bid` : '—';

    const prevBid = changes.previous?.fromValue ?? null;
    els.statBidDelta.textContent = changes.previous?.change !== null && state.field !== 'spread'
      ? `vs previous ${fmtSigned(changes.previous.change, decimals)} (mid)`
      : 'no earlier reading yet';
    els.statAskDelta.textContent = prevBid !== null ? `mid was ${fmt(prevBid, decimals)}` : 'awaiting history';

    const day = state.latest?.last24h;
    if (day && day.count > 1) {
      els.statRange.textContent = `${fmt(day.min, decimals)} – ${fmt(day.max, decimals)}`;
      els.statRangeCount.textContent = `${day.count} sample${day.count === 1 ? '' : 's'} · avg ${fmt(day.avg, decimals)}`;
    } else {
      els.statRange.textContent = fmt(quote.mid, decimals);
      els.statRangeCount.textContent = day?.count ? `${day.count} sample in window` : 'no samples in the last 24h yet';
    }

    els.metaAsof.textContent = quote.sourceAsOf ? new Date(`${quote.sourceAsOf}T00:00:00Z`).toUTCString().slice(5, 16) : 'not published';
    els.metaCaptured.textContent = `${utcStamp(quote.capturedAt)} · ${relTime(quote.capturedAt)}`;
    els.metaSource.textContent = sourceSummary();
    els.metaCaptured.dataset.iso = quote.capturedAt;

    renderDeltas(changes, decimals);
    renderConverter(quote);
  }

  function sourceSummary() {
    const s = state.status?.scraper;
    if (!s?.lastSource) return 'awaiting first scrape';
    const label = s.lastSource.startsWith('simulated') ? 'simulator (source unreachable)' : s.lastSource;
    return `${label} · ${s.lastStrategy || 'n/a'}`;
  }

  function renderDeltas(changes, decimals) {
    const nodes = els.heroDeltas.querySelectorAll('.chip');
    nodes.forEach((node) => {
      const key = node.dataset.window;
      const c = changes?.[key];
      const label = key === 'previous' ? 'vs previous' : c?.label || key;
      if (!c || c.change === null || c.change === undefined) {
        node.className = 'chip chip-neutral';
        node.innerHTML = `${label} <b>—</b>`;
        return;
      }
      const dir = c.change > 0 ? 'up' : c.change < 0 ? 'down' : 'neutral';
      node.className = `chip chip-${dir}`;
      node.innerHTML = `${label} <b>${fmtSigned(c.change, decimals)} (${fmtPct(c.changePct)})</b>`;
      node.title = c.from ? `vs ${fmt(c.fromValue, decimals)} at ${utcStamp(c.from)}` : '';
    });
  }

  function renderTicker() {
    const quotes = state.quotes.length ? state.quotes : [];
    if (!quotes.length) {
      els.tickerInner.innerHTML = '<span class="muted">no pairs captured yet</span>';
      return;
    }
    els.tickerInner.innerHTML = quotes
      .map((q) => {
        const decimals = decimalsFor(q.mid);
        const active = q.pair === state.pair;
        return `<button type="button" class="ticker-item" data-pair="${q.pair}" aria-current="${active}">
            <b>${q.pair}</b><span>${fmt(q.mid, decimals)}</span>${q.simulated ? '<span class="sim-flag">sim</span>' : ''}
          </button>`;
      })
      .join('');
  }

  function renderPairs() {
    if (!state.pairs.length) {
      els.pairsTable.innerHTML = '<tr><td colspan="8" class="muted">No pairs stored yet.</td></tr>';
      return;
    }
    els.pairsTable.innerHTML = state.pairs
      .map((p) => {
        const decimals = decimalsFor(p.mid);
        const spread = p.bid !== null && p.ask !== null ? p.ask - p.bid : null;
        return `<tr data-primary="${p.pair === state.pair}">
          <td><span class="pair-cell">${p.pair}</span></td>
          <td class="muted">${escapeHtml(p.name || '')}</td>
          <td class="num">${fmt(p.bid, decimals)}</td>
          <td class="num">${fmt(p.ask, decimals)}</td>
          <td class="num"><b>${fmt(p.mid, decimals)}</b></td>
          <td class="num muted">${spread !== null ? `${fmt(spread, Math.max(2, decimals))} (${p.spreadPct !== null ? p.spreadPct.toFixed(2) + '%' : '—'})` : '—'}</td>
          <td class="num muted">${p.count}</td>
          <td class="num">${
            p.pair === state.pair
              ? '<span class="tag">tracking</span>'
              : `<button type="button" class="mini-btn" data-track="${p.pair}">track</button>`
          }</td>
        </tr>`;
      })
      .join('');
  }

  function renderLog(append) {
    if (!state.observations.length) {
      els.logTable.innerHTML = '<tr><td colspan="7" class="muted">No captures recorded yet — press Refresh to scrape the source.</td></tr>';
      els.logCount.textContent = '';
      return;
    }
    const rows = state.observations.map((o) => {
      const p = o.primary || {};
      const decimals = decimalsFor(p.mid);
      const status = o.simulated
        ? '<span class="status-sim">simulated</span>'
        : o.seed
          ? '<span class="status-seed">seed snapshot</span>'
          : '<span class="status-ok">ok</span>';
      return `<tr>
        <td>${utcStamp(o.capturedAt)} <span class="muted">(${relTime(o.capturedAt)})</span></td>
        <td class="num">${fmt(p.bid, decimals)}</td>
        <td class="num">${fmt(p.ask, decimals)}</td>
        <td class="num"><b>${fmt(p.mid, decimals)}</b></td>
        <td class="muted">${escapeHtml(o.sourceLabel || '')}</td>
        <td class="muted">${escapeHtml(o.strategy || '')}</td>
        <td>${status}</td>
      </tr>`;
    });
    els.logTable.innerHTML = append ? els.logTable.innerHTML + rows.join('') : rows.join('');
    els.logCount.textContent = `showing ${state.observations.length} of ${state.status?.store?.observations ?? '—'} observations`;
    els.btnMoreLog.disabled = state.observations.length >= (state.status?.store?.observations ?? 0);
  }

  function renderHealth() {
    const s = state.status;
    if (!s) return;
    const rows = [
      ['Poll interval', `${s.pollIntervalMin} min`],
      ['Next poll', s.scraper?.nextRunAt ? `${inTime(s.scraper.nextRunAt)} (${utcStamp(s.scraper.nextRunAt).slice(11, 19)})` : s.scraper?.running ? 'running…' : '—'],
      ['Last attempt', s.scraper?.lastAttemptAt ? `${utcStamp(s.scraper.lastAttemptAt)} · ${relTime(s.scraper.lastAttemptAt)}` : 'never'],
      ['Last success', s.scraper?.lastSuccessAt ? relTime(s.scraper.lastSuccessAt) : 'never'],
      ['Attempts / successes', `${s.scraper?.totalAttempts ?? 0} / ${s.scraper?.totalSuccesses ?? 0}`],
      ['Consecutive failures', String(s.scraper?.consecutiveFailures ?? 0), (s.scraper?.consecutiveFailures ?? 0) > 0 ? 'bad' : 'ok'],
      ['Last strategy', s.scraper?.lastStrategy || '—'],
      ['Bank “as of”', s.scraper?.lastSourceAsOf || '—'],
      ['Observations stored', String(s.store?.observations ?? 0)],
      s.daily
        ? ['Daily snapshots', `${s.daily.days ?? 0} day${(s.daily.days ?? 0) === 1 ? '' : 's'}${s.daily.lastDate ? ` · last ${s.daily.lastDate}` : ''}${s.daily.tz ? ` (${s.daily.tz})` : ''}`]
        : null,
      ['Series starts', s.store?.firstAt ? utcStamp(s.store.firstAt) : '—'],
      ['Log size', s.store?.logBytes ? `${(s.store.logBytes / 1024).toFixed(1)} KB` : '—'],
      ['Simulated rows', String(s.scraper?.totalSimulated ?? 0), (s.scraper?.totalSimulated ?? 0) > 0 ? 'warn' : 'ok'],
    ];
    if (s.scraper?.lastError) rows.push(['Last error', s.scraper.lastError, 'bad']);
    els.healthList.innerHTML = rows
      .filter(Boolean)
      .map(([k, v, cls]) => `<dt>${k}</dt><dd class="${cls || ''}">${escapeHtml(v)}</dd>`)
      .join('');
    els.healthNext.textContent = s.scraper?.running ? 'scraping…' : s.scraper?.nextRunAt ? `next ${new Date(s.scraper.nextRunAt).toISOString().slice(11, 16)}Z` : 'idle';
    els.healthNext.title = s.scraper?.nextRunAt || '';
  }

  function renderConverter(quote) {
    if (!quote) {
      els.convertResult.textContent = '—';
      els.convertNotes.innerHTML = '';
      els.converterRate.textContent = '—';
      return;
    }
    const decimals = quote.decimals ?? decimalsFor(quote.mid);
    els.converterRate.textContent = `bid ${fmt(quote.bid, decimals)} · ask ${fmt(quote.ask, decimals)}`;
    const amount = Number(els.convertAmount.value);
    if (!Number.isFinite(amount) || amount <= 0 || quote.bid === null || quote.ask === null) {
      els.convertResult.textContent = '—';
      els.convertNotes.innerHTML = '<li><span>Enter an amount to convert</span></li>';
      return;
    }
    if (state.direction === 'usd-khr') {
      // You sell USD to the bank -> the bank buys at its Bid.
      const out = amount * quote.bid;
      const midOut = amount * quote.mid;
      els.convertResult.textContent = `${fmt(out, 2)} KHR`;
      els.convertNotes.innerHTML = `
        <li><span>Uses Bank Buy (bid)</span><span>${fmt(quote.bid, decimals)}</span></li>
        <li><span>Mid-rate reference</span><span>${fmt(midOut, 2)} KHR</span></li>
        <li><span>Spread cost</span><span>${fmt(midOut - out, 2)} KHR (${quote.spreadPct !== null ? quote.spreadPct.toFixed(2) + '%' : '—'})</span></li>`;
    } else {
      // You buy USD from the bank -> the bank sells at its Ask.
      const out = amount / quote.ask;
      const midOut = amount / quote.mid;
      els.convertResult.textContent = `${fmt(out, 2)} USD`;
      els.convertNotes.innerHTML = `
        <li><span>Uses Bank Sell (ask)</span><span>${fmt(quote.ask, decimals)}</span></li>
        <li><span>Mid-rate reference</span><span>${fmt(midOut, 2)} USD</span></li>
        <li><span>Spread cost</span><span>${fmt(midOut - out, 2)} USD (${quote.spreadPct !== null ? quote.spreadPct.toFixed(2) + '%' : '—'})</span></li>`;
    }
  }

  function renderChart() {
    const h = state.history;
    const decimals = state.latest?.quote?.decimals ?? decimalsFor(state.latest?.quote?.mid ?? 4050);
    const label = { mid: 'Mid', bid: 'Bank buy (bid)', ask: 'Bank sell (ask)', spread: 'Spread' }[state.field] || 'Mid';
    els.chartLegendLabel.textContent = label;
    const grainNote = h?.grain === 'daily' ? ` · daily closes${h.tz ? ` (${h.tz})` : ''}` : '';
    els.chartSubtitle.textContent = `${label.toLowerCase()} · ${state.pair} · ${rangeLabel(state.range)}${grainNote}`;
    els.btnCsv.href = `./api/export.csv?pair=${encodeURIComponent(state.pair)}&range=${encodeURIComponent(state.range)}`;
    els.btnDailyCsv.href = `./api/daily?pair=${encodeURIComponent(state.pair)}&range=${encodeURIComponent(state.range)}&format=csv`;

    if (!h || !h.points || !h.points.length) {
      els.chartEmpty.hidden = false;
      els.chartPoints.textContent = '';
      els.chartSummary.textContent = '';
      if (state.chart) state.chart.setData({ points: [] });
      return;
    }
    els.chartEmpty.hidden = true;
    state.chart.setData({ points: h.points, options: { decimals } });

    const s = h.summary || {};
    els.chartPoints.textContent =
      h.grain === 'daily'
        ? `${h.count} daily snapshot${h.count === 1 ? '' : 's'} · from ${h.rawCount} sample${h.rawCount === 1 ? '' : 's'}`
        : `${h.count} plotted point${h.count === 1 ? '' : 's'}${h.bucketMs ? ` · aggregated to ${bucketLabel(h.bucketMs)}` : ` · ${h.rawCount} raw sample${h.rawCount === 1 ? '' : 's'}`}`;
    els.chartSummary.textContent = s.count
      ? `open ${fmt(s.first, decimals)} · high ${fmt(s.max, decimals)} · low ${fmt(s.min, decimals)} · close ${fmt(s.last, decimals)} · ${fmtPct(s.changePct)}`
      : '';
    if (h.simulated) els.chartSummary.textContent += ' · includes simulated rows';
  }

  function rangeLabel(id) {
    const r = RANGES.find((x) => x.id === id);
    return r ? r.label : id;
  }

  function bucketLabel(ms) {
    if (ms < 3600_000) return `${Math.round(ms / 60000)} min buckets`;
    if (ms < 86_400_000) return `${Math.round(ms / 3600_000)} h buckets`;
    return `${Math.round(ms / 86_400_000)} d buckets`;
  }

  // --- alerts ----------------------------------------------------------------

  function evaluateAlerts(quote) {
    if (!quote || (state.alerts.high === null && state.alerts.low === null)) return null;
    const value = quote.mid;
    const high = Number(state.alerts.high);
    const low = Number(state.alerts.low);
    let hit = null;
    if (Number.isFinite(high) && high > 0 && value >= high) hit = `above ${fmt(high, 2)}`;
    else if (Number.isFinite(low) && low > 0 && value <= low) hit = `below ${fmt(low, 2)}`;
    if (!hit) return null;

    const now = Date.now();
    const firedRecently = now - state.alerts.lastFired < 10 * 60_000;
    state.alerts.lastFired = now;
    if (!firedRecently) {
      const text = `${state.pair} is ${hit}: ${fmt(value, 2)} KHR per USD`;
      toast(text, 'warn', 8000);
      if (state.alerts.notify && 'Notification' in window && Notification.permission === 'granted') {
        try { new Notification('USD/KHR alert', { body: text }); } catch { /* some browsers block non-service-worker notifications */ }
      }
    }
    return `<strong>Alert:</strong> ${state.pair} mid rate ${fmt(value, 2)} is ${hit}.`;
  }

  function renderAlertState() {
    const { high, low } = state.alerts;
    if (!high && !low) {
      els.alertState.textContent = 'No alerts configured.';
      return;
    }
    const parts = [];
    if (high) parts.push(`≥ ${fmt(Number(high), 2)}`);
    if (low) parts.push(`≤ ${fmt(Number(low), 2)}`);
    els.alertState.innerHTML = `Watching mid rate ${parts.join(' and ')}. ${state.alerts.notify ? 'Desktop notifications on.' : 'On-page banner only.'}`;
  }

  // --- data loading ----------------------------------------------------------

  async function loadLatest() {
    const { data } = await api(`./api/latest?pair=${encodeURIComponent(state.pair)}&field=${state.field}`);
    state.latest = data;
    state.status = data.status || state.status;
    state.quotes = data.quotes || [];
    renderHero();
    renderTicker();
    renderStatus();
    renderBanner();
    renderHealth();
  }

  async function loadHistory() {
    const grain = state.grain === 'daily' ? '&grain=daily' : '';
    const { data } = await api(
      `./api/history?pair=${encodeURIComponent(state.pair)}&field=${state.field}&range=${encodeURIComponent(state.range)}${grain}`
    );
    state.history = data;
    renderChart();
  }

  async function loadPairs() {
    const { data } = await api('./api/pairs');
    state.pairs = data.pairs || [];
    renderPairs();
  }

  async function loadObservations(append = false) {
    const limit = 25;
    const offset = append ? state.observations.length : 0;
    const { data } = await api(`./api/observations?limit=${limit}&offset=${offset}`);
    state.observations = append ? state.observations.concat(data.observations || []) : data.observations || [];
    state.logOffset = state.observations.length;
    renderLog(append);
  }

  async function loadAll() {
    await Promise.all([loadLatest(), loadHistory(), loadPairs(), loadObservations(false)]);
  }

  async function refreshNow() {
    els.btnRefresh.classList.add('loading');
    els.btnRefresh.disabled = true;
    try {
      const { status, data } = await api('./api/refresh', { method: 'POST' });
      if (data?.ok) {
        const p = data.primary || {};
        toast(
          data.simulated
            ? `Refreshed — simulated ${state.pair} ${fmt(p.mid, 2)} (source unreachable)`
            : `Refreshed — ${state.pair} bid ${fmt(p.bid, 2)} / ask ${fmt(p.ask, 2)}`,
          data.simulated ? 'warn' : 'ok'
        );
      } else if (status === 429) {
        toast(data?.error || 'Refreshing too often — wait a moment.', 'warn');
      } else {
        toast(data?.error ? `Scrape failed: ${String(data.error).slice(0, 140)}` : 'Scrape failed', 'error', 7000);
      }
      await loadAll();
    } catch (err) {
      toast(`Refresh failed: ${err.message}`, 'error');
    } finally {
      els.btnRefresh.classList.remove('loading');
      els.btnRefresh.disabled = false;
    }
  }

  function setPair(pair) {
    if (!pair || pair === state.pair) return;
    state.pair = pair;
    state.lastMid = null;
    savePrefs();
    loadAll().catch((err) => toast(`Could not load ${pair}: ${err.message}`, 'error'));
  }

  // --- wiring ----------------------------------------------------------------

  function buildRangeButtons() {
    els.rangeButtons.innerHTML = RANGES.map(
      (r) => `<button type="button" data-range="${r.id}" class="${r.id === state.range ? 'active' : ''}">${r.label}</button>`
    ).join('');
    els.rangeButtons.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-range]');
      if (!btn) return;
      state.range = btn.dataset.range;
      els.rangeButtons.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
      savePrefs();
      loadHistory().catch((err) => toast(err.message, 'error'));
    });

    els.fieldButtons.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.field === state.field));
    els.fieldButtons.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-field]');
      if (!btn) return;
      state.field = btn.dataset.field;
      els.fieldButtons.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
      savePrefs();
      Promise.all([loadHistory(), loadLatest()]).catch((err) => toast(err.message, 'error'));
    });

    els.grainButtons.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.grain === state.grain));
    els.grainButtons.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-grain]');
      if (!btn) return;
      state.grain = btn.dataset.grain;
      els.grainButtons.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
      savePrefs();
      loadHistory().catch((err) => toast(err.message, 'error'));
    });
  }

  function wire() {
    els.btnRefresh.addEventListener('click', refreshNow);
    els.btnTheme.addEventListener('click', () =>
      setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')
    );

    els.tickerInner.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-pair]');
      if (btn) setPair(btn.dataset.pair);
    });

    els.pairsTable.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-track]');
      if (btn) setPair(btn.dataset.track);
    });

    els.convertAmount.addEventListener('input', () => renderConverter(state.latest?.quote));
    els.dirUsdKhr.addEventListener('click', () => setDirection('usd-khr'));
    els.dirKhrUsd.addEventListener('click', () => setDirection('khr-usd'));

    els.btnSaveAlerts.addEventListener('click', () => {
      const high = Number(els.alertHigh.value);
      const low = Number(els.alertLow.value);
      state.alerts.high = Number.isFinite(high) && high > 0 ? high : null;
      state.alerts.low = Number.isFinite(low) && low > 0 ? low : null;
      if (state.alerts.high && state.alerts.low && state.alerts.low >= state.alerts.high) {
        toast('The “below” threshold must be lower than the “above” threshold.', 'error');
        return;
      }
      savePrefs();
      renderAlertState();
      renderBanner();
      toast(state.alerts.high || state.alerts.low ? 'Alerts saved (this browser only).' : 'Alerts cleared.', 'ok');
    });

    els.btnNotify.addEventListener('click', async () => {
      if (!('Notification' in window)) {
        toast('This browser does not support notifications.', 'error');
        return;
      }
      const permission = await Notification.requestPermission();
      state.alerts.notify = permission === 'granted';
      savePrefs();
      renderAlertState();
      toast(state.alerts.notify ? 'Desktop notifications enabled.' : `Notifications not granted (${permission}).`, state.alerts.notify ? 'ok' : 'warn');
    });

    els.btnMoreLog.addEventListener('click', () => {
      loadObservations(true).catch((err) => toast(err.message, 'error'));
    });

    document.addEventListener('keydown', (ev) => {
      if (ev.target instanceof HTMLInputElement || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (ev.key === 'r' || ev.key === 'R') { ev.preventDefault(); refreshNow(); }
      if (ev.key === 't' || ev.key === 'T') {
        ev.preventDefault();
        setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) loadLatest().catch(() => {});
    });
  }

  function setDirection(dir) {
    state.direction = dir;
    els.dirUsdKhr.classList.toggle('active', dir === 'usd-khr');
    els.dirKhrUsd.classList.toggle('active', dir === 'khr-usd');
    savePrefs();
    renderConverter(state.latest?.quote);
  }

  function startPolling() {
    state.timers.push(setInterval(() => loadLatest().then(renderStatus).catch(() => {}), POLL_LATEST_MS));
    state.timers.push(
      setInterval(() => {
        loadHistory().catch(() => {});
        loadPairs().catch(() => {});
      }, POLL_HISTORY_MS)
    );
    state.timers.push(
      setInterval(() => {
        // keep relative timestamps honest without a full reload
        const quote = state.latest?.quote;
        if (quote) els.lastUpdate.textContent = `updated ${relTime(quote.capturedAt)}`;
        if (state.status?.scraper?.lastAttemptAt) renderHealth();
      }, 15_000)
    );
  }

  async function boot() {
    loadPrefs();
    if (!state.chart) {
      state.chart = new RateChart(els.chartCanvas, els.chartTooltip, { decimals: 2 });
      setTheme(document.documentElement.dataset.theme, false);
    }
    buildRangeButtons();
    wire();

    els.alertHigh.value = state.alerts.high ?? '';
    els.alertLow.value = state.alerts.low ?? '';
    els.dirUsdKhr.classList.toggle('active', state.direction === 'usd-khr');
    els.dirKhrUsd.classList.toggle('active', state.direction === 'khr-usd');
    renderAlertState();
    els.footBuild.textContent = ` · API: /api/latest · /api/history · /api/export.csv`;

    try {
      await loadAll();
    } catch (err) {
      toast(`Cannot reach the tracker API: ${err.message}`, 'error', 9000);
      els.statusPill.className = 'pill pill-offline';
      els.statusPillText.textContent = 'api offline';
      els.banner.hidden = false;
      els.banner.className = 'banner banner-error';
      els.banner.innerHTML =
        '<p><strong>API unreachable.</strong> Is the Node server running? Start it with <code>npm start</code> (see README).</p>';
    }
    startPolling();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
