/**
 * Transport-agnostic API router.
 *
 * Every `/api/*` route lives here so the long-running Node server
 * (`server/index.js`) and the serverless entrypoints (`api/*.js`, Vercel) share
 * one implementation. The router never touches `req`/`res`: it takes a plain
 * request descriptor and returns `{ status, headers, body }`, which each host
 * then writes however it likes.
 *
 *   GET  /api/status                  scraper health + store stats
 *   GET  /api/latest?pair=USD/KHR     current quote, changes, all pairs
 *   GET  /api/history?pair&range&field&grain   chart series + summary
 *   GET  /api/daily?pair&range&field&format    daily snapshot series (OHLC)
 *   GET  /api/observations?limit      recent raw observations
 *   GET  /api/pairs                   every tracked pair
 *   GET  /api/export.csv?pair&range   CSV download
 *   POST /api/refresh                 scrape now (rate limited)
 *   GET  /healthz                     liveness probe
 */
import { config as defaultConfig, logger as defaultLogger } from './config.js';
import {
  RANGE_PRESETS,
  aggregate,
  changeWindows,
  decimalsFor,
  pickBucketMs,
  rangeToMs,
  summarize,
} from './stats.js';
import { DAY_MS, dailyToPoints, dailyCsv, tzLabel } from './daily.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export const FIELDS = ['bid', 'ask', 'mid', 'spread'];

/** `USD/KHR`, `USDKHR`, `usd khr` -> `USD/KHR`; anything else -> primary pair. */
export function normalizePair(raw, primaryPair = defaultConfig.primaryPair) {
  if (!raw) return primaryPair;
  const up = String(raw).toUpperCase().trim().replace(/\s+/g, '');
  const pair = up.includes('/') ? up : up.length === 6 ? `${up.slice(0, 3)}/${up.slice(3)}` : up;
  return /^[A-Z]{3}\/[A-Z]{3}$/.test(pair) ? pair : primaryPair;
}

export function normalizeField(raw) {
  return FIELDS.includes(String(raw).toLowerCase()) ? String(raw).toLowerCase() : 'mid';
}

/**
 * @param {object} deps
 * @param {import('./store.js').Store} deps.store
 * @param {object} [deps.scheduler]  long-running host only; serverless passes null
 * @param {Function} [deps.runScrape] `({manual}) => result`; absent => /api/refresh is 501
 * @param {object} [deps.config]
 * @param {object} [deps.logger]
 * @param {string} [deps.platform] 'node' | 'vercel' — reported by /api/status
 */
export function createApiRouter({
  store,
  scheduler = null,
  runScrape = null,
  config = defaultConfig,
  logger = defaultLogger,
  platform = 'node',
} = {}) {
  let lastManualRefresh = 0;

  // --- payloads --------------------------------------------------------------

  function isSimulated(pair) {
    return Boolean(store.latestFor(pair)?.sim);
  }

  function isStale(pair, thresholdMs) {
    const last = store.latestFor(pair);
    if (!last) return true;
    return Date.now() - last.t > thresholdMs;
  }

  function quotePayload(pair) {
    const last = store.latestFor(pair);
    if (!last) return null;
    const bid = last.bid;
    const ask = last.ask;
    return {
      pair,
      name: last.name,
      bid,
      ask,
      mid: last.mid,
      spread: bid !== null && ask !== null ? Number((ask - bid).toFixed(decimalsFor(ask - bid))) : null,
      spreadPct: bid && ask !== null ? Number((((ask - bid) / bid) * 100).toFixed(4)) : null,
      decimals: decimalsFor(last.mid),
      capturedAt: new Date(last.t).toISOString(),
      epochMs: last.t,
      ageSeconds: Math.round((Date.now() - last.t) / 1000),
      sourceAsOf: last.asOf || null,
      simulated: Boolean(last.sim),
    };
  }

  function statusPayload() {
    const schedulerState = scheduler?.state() || {
      intervalMin: null,
      running: false,
      consecutiveFailures: 0,
      currentDelayMin: null,
      nextRunAt: null,
      lastRunAt: null,
      startedAt: null,
      lastResult: null,
    };
    const meta = store.meta;
    const stats = store.stats();
    const staleThresholdMs = Math.max((config.pollIntervalMin || 15) * 60_000 * 3, 30 * 60_000);
    const daily = store.dailyRows({ pair: config.primaryPair });
    const lastDaily = daily.at(-1) || null;
    return {
      ok: Boolean(stats.observations),
      platform,
      primaryPair: config.primaryPair,
      sourceUrl: config.sourceUrl,
      fallbackSources: config.fallbackSources,
      pollIntervalMin: config.pollIntervalMin,
      simulation: {
        allowed: config.allowSimulation,
        on_failure: config.simulateOnFailure,
        active: isSimulated(config.primaryPair),
      },
      stale: isStale(config.primaryPair, staleThresholdMs),
      staleThresholdMin: Math.round(staleThresholdMs / 60_000),
      store: stats,
      daily: {
        tz: tzLabel(store.dailyTzOffsetMin),
        days: daily.length,
        lastDate: lastDaily?.date || null,
        lastClose: lastDaily?.close ?? null,
        persisted: stats.dailySnapshots || 0,
      },
      scraper: {
        ...schedulerState,
        lastAttemptAt: meta.lastAttemptAt,
        lastSuccessAt: meta.lastSuccessAt,
        lastSimulatedAt: meta.lastSimulatedAt || null,
        lastSource: meta.lastSource || null,
        lastStrategy: meta.lastStrategy || null,
        lastSourceAsOf: meta.lastSourceAsOf || null,
        lastError: meta.lastError || null,
        totalAttempts: meta.totalAttempts || 0,
        totalSuccesses: meta.totalSuccesses || 0,
        totalFailures: (meta.totalAttempts || 0) - (meta.totalSuccesses || 0),
        totalSimulated: meta.totalSimulated || 0,
      },
      serverTime: new Date().toISOString(),
    };
  }

  // --- responses -------------------------------------------------------------

  const json = (status, payload, extra = {}) => ({
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS, ...extra },
    body: JSON.stringify(payload),
  });

  const text = (status, body, type = 'text/plain; charset=utf-8', extra = {}) => ({
    status,
    headers: { 'Content-Type': type, ...CORS, ...extra },
    body,
  });

  const param = (query, key, fallback = null) => {
    const v = query.get(key);
    return v === null || v === '' ? fallback : v;
  };

  // --- routes ----------------------------------------------------------------

  const routes = {
    '/api/status': () => json(200, { ok: true, ...statusPayload() }),

    '/api/latest': ({ query }) => {
      const pair = normalizePair(param(query, 'pair'), config.primaryPair);
      const quote = quotePayload(pair);
      const series = store.series({ pair });
      const changes = changeWindows(series, normalizeField(param(query, 'field', 'mid')));
      const dayPoints = series.filter((p) => p.t >= Date.now() - DAY_MS);
      return json(200, {
        ok: Boolean(quote),
        generatedAt: new Date().toISOString(),
        pair,
        quote,
        changes,
        last24h: summarize(dayPoints, 'mid'),
        quotes: store.latestQuotes(),
        status: statusPayload(),
        ...(quote ? {} : { hint: 'No data yet — the scraper has not produced a reading. POST /api/refresh to try now.' }),
      });
    },

    '/api/history': ({ query }) => {
      const pair = normalizePair(param(query, 'pair'), config.primaryPair);
      const field = normalizeField(param(query, 'field'));
      const range = String(param(query, 'range', '30d')).toLowerCase();
      const rangeMs = rangeToMs(range);
      const since = Number.isFinite(rangeMs) ? Date.now() - rangeMs : 0;
      const grain = String(param(query, 'grain', 'auto')).toLowerCase();
      const bucketParam = param(query, 'bucket', 'auto');
      const wantsDaily = grain === 'daily' || grain === 'day' || bucketParam === 'daily' || bucketParam === 'day';
      const raw = store.series({ pair, since });

      if (wantsDaily) {
        const rows = store.dailyRows({ pair, since });
        const points = dailyToPoints(rows, field);
        return json(200, {
          ok: points.length > 0,
          pair,
          field,
          range,
          grain: 'daily',
          tz: tzLabel(store.dailyTzOffsetMin),
          rangeMs: Number.isFinite(rangeMs) ? rangeMs : null,
          bucketMs: DAY_MS,
          since: since ? new Date(since).toISOString() : null,
          count: points.length,
          rawCount: rows.reduce((n, r) => n + (r.samples || 0), 0),
          simulated: points.some((p) => p.sim),
          points,
          summary: summarize(points, field),
          changes: changeWindows(store.series({ pair }), field),
          ranges: RANGE_PRESETS.map((r) => ({ id: r.id, label: r.label })),
        });
      }

      const bucketMs =
        bucketParam === 'none' || bucketParam === '0'
          ? 0
          : bucketParam === 'auto'
            ? pickBucketMs(Number.isFinite(rangeMs) ? rangeMs : Date.now() - (raw[0]?.t ?? Date.now()), raw.length)
            : Math.max(0, Number(bucketParam) || 0);
      const points = aggregate(raw, field, bucketMs);
      return json(200, {
        ok: points.length > 0,
        pair,
        field,
        range,
        grain: bucketMs === DAY_MS ? 'daily' : 'sample',
        rangeMs: Number.isFinite(rangeMs) ? rangeMs : null,
        bucketMs,
        since: since ? new Date(since).toISOString() : null,
        count: points.length,
        rawCount: raw.length,
        simulated: points.some((p) => p.sim),
        points,
        summary: summarize(raw, field),
        changes: changeWindows(store.series({ pair }), field),
        ranges: RANGE_PRESETS.map((r) => ({ id: r.id, label: r.label })),
      });
    },

    /**
     * Daily snapshot series — the graph-friendly view: one OHLC row per
     * calendar day (UTC+7 by default), merged from `data/daily.jsonl` and the
     * observation log. `format=csv` returns the same rows as a download.
     */
    '/api/daily': ({ query }) => {
      const pair = normalizePair(param(query, 'pair'), config.primaryPair);
      const range = String(param(query, 'range', 'all')).toLowerCase();
      const field = normalizeField(param(query, 'field', 'mid'));
      const rangeMs = rangeToMs(range);
      const since = Number.isFinite(rangeMs) ? Date.now() - rangeMs : 0;
      const format = String(param(query, 'format', 'json')).toLowerCase();
      const rows = store.dailyRows({ pair, since });

      if (format === 'csv') {
        const stamp = new Date().toISOString().slice(0, 10);
        return text(200, dailyCsv(rows), 'text/csv; charset=utf-8', {
          'Content-Disposition': `attachment; filename="${pair.replace('/', '-')}-daily-${range}-${stamp}.csv"`,
          'Cache-Control': 'no-store',
        });
      }

      const points = dailyToPoints(rows, field);
      return json(200, {
        ok: rows.length > 0,
        pair,
        field,
        range,
        tz: tzLabel(store.dailyTzOffsetMin),
        since: since ? new Date(since).toISOString() : null,
        generatedAt: new Date().toISOString(),
        count: rows.length,
        days: rows,
        points,
        summary: summarize(points, field),
        hint: 'One row per calendar day: open/high/low/close of every board field plus sample count.',
      });
    },

    '/api/observations': ({ query }) => {
      const limit = Math.min(500, Math.max(1, Number(param(query, 'limit', 50)) || 50));
      const offset = Math.max(0, Number(param(query, 'offset', 0)) || 0);
      const observations = store.recentObservations({ limit, offset });
      return json(200, {
        ok: true,
        limit,
        offset,
        total: store.stats().observations,
        observations: observations.map((o) => ({
          id: o.id,
          capturedAt: o.capturedAt,
          sourceLabel: o.sourceLabel,
          sourceUrl: o.sourceUrl,
          strategy: o.strategy,
          sourceAsOf: o.sourceAsOf,
          simulated: Boolean(o.simulated),
          seed: Boolean(o.seed),
          primary: o.primary,
          pairs: o.quotes?.length || 0,
        })),
      });
    },

    '/api/pairs': () =>
      json(200, {
        ok: true,
        primaryPair: config.primaryPair,
        pairs: store.pairs().map((p) => ({
          pair: p.pair,
          name: p.last?.name || p.pair,
          count: p.count,
          bid: p.last?.bid ?? null,
          ask: p.last?.ask ?? null,
          mid: p.last?.mid ?? null,
          spreadPct: p.last?.bid && p.last?.ask ? Number((((p.last.ask - p.last.bid) / p.last.bid) * 100).toFixed(4)) : null,
          capturedAt: p.last ? new Date(p.last.t).toISOString() : null,
          simulated: Boolean(p.last?.sim),
        })),
      }),

    '/api/export.csv': ({ query }) => {
      const pair = normalizePair(param(query, 'pair'), config.primaryPair);
      const range = String(param(query, 'range', 'all')).toLowerCase();
      const rangeMs = rangeToMs(range);
      const since = Number.isFinite(rangeMs) ? Date.now() - rangeMs : 0;
      const csv = store.csv({ pair, since });
      const stamp = new Date().toISOString().slice(0, 10);
      return text(200, csv, 'text/csv; charset=utf-8', {
        'Content-Disposition': `attachment; filename="${pair.replace('/', '-')}-${range}-${stamp}.csv"`,
        'Cache-Control': 'no-store',
      });
    },

    '/api/refresh': async ({ method }) => {
      if (method !== 'POST') return json(405, { ok: false, error: 'use POST' });
      if (!runScrape) {
        return json(501, {
          ok: false,
          error: 'this deployment cannot scrape on demand (no scraper wired to the router)',
        });
      }
      const now = Date.now();
      if (now - lastManualRefresh < config.refreshMinGapSec * 1000) {
        return json(429, {
          ok: false,
          error: `refresh rate limited — try again in ${Math.ceil((config.refreshMinGapSec * 1000 - (now - lastManualRefresh)) / 1000)}s`,
        });
      }
      lastManualRefresh = now;
      const result = await runScrape({ manual: true });
      return json(result.ok ? 200 : 502, {
        ok: result.ok,
        simulated: result.simulated,
        stored: result.stored ?? false,
        storeReason: result.storeReason ?? null,
        error: result.error,
        attempts: result.attempts,
        warnings: result.warnings,
        primary: result.observation?.primary ?? null,
        quote: quotePayload(config.primaryPair),
        status: statusPayload(),
      });
    },

    '/healthz': () =>
      json(200, {
        ok: true,
        platform,
        uptime: typeof process.uptime === 'function' ? process.uptime() : null,
        observations: store.stats().observations,
        readonly: store.readonly,
      }),
  };
  routes['/api/healthz'] = routes['/healthz'];

  /**
   * @param {{method?:string, pathname:string, query?:URLSearchParams}} request
   * @returns {Promise<{status:number, headers:object, body:string}>}
   */
  async function handle({ method = 'GET', pathname = '/', query = new URLSearchParams(), headers = {} } = {}) {
    if (String(method).toUpperCase() === 'OPTIONS') {
      return { status: 204, headers: { ...CORS, 'Access-Control-Max-Age': '600' }, body: '' };
    }
    const route = String(pathname).replace(/\/+$/, '') || '/';
    const handler = routes[route];
    if (!handler) return json(404, { ok: false, error: 'unknown endpoint', path: route });
    try {
      return await handler({ method: String(method).toUpperCase(), query, headers });
    } catch (err) {
      logger.error('api route failed', { route, error: err.message, stack: err.stack });
      return json(500, { ok: false, error: 'internal server error', route });
    }
  }

  return { handle, routes: Object.keys(routes), statusPayload, quotePayload, normalizePair, normalizeField };
}
