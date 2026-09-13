/**
 * USD/KHR tracker — HTTP server.
 *
 * Zero runtime dependencies: Node's built-in http server, fetch and fs only.
 * Serves the dashboard from /public and a small JSON API from /api.
 *
 *   GET  /api/status                  scraper health + store stats
 *   GET  /api/latest?pair=USD/KHR     current quote, changes, all pairs
 *   GET  /api/history?pair&range&field chart series + summary
 *   GET  /api/observations?limit      recent raw observations
 *   GET  /api/pairs                   every tracked pair
 *   GET  /api/export.csv?pair&range   CSV download
 *   POST /api/refresh                 scrape now (rate limited)
 *   GET  /healthz                     liveness probe
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { config, logger } from './config.js';
import { store } from './store.js';
import { scrapeOnce } from './scrape/index.js';
import { buildBackfill } from './scrape/simulate.js';
import { createScheduler } from './scheduler.js';
import {
  RANGE_PRESETS,
  aggregate,
  changeWindows,
  decimalsFor,
  pickBucketMs,
  rangeToMs,
  summarize,
  valueOf,
} from './stats.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
};

// --- helpers -----------------------------------------------------------------

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8', extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(text),
    'Access-Control-Allow-Origin': '*',
    ...extraHeaders,
  });
  res.end(text);
}

function queryParam(searchParams, key, fallback = null) {
  const v = searchParams.get(key);
  return v === null || v === '' ? fallback : v;
}

function normalizePair(raw) {
  if (!raw) return config.primaryPair;
  const up = String(raw).toUpperCase().trim();
  const pair = up.includes('/') ? up : up.length === 6 ? `${up.slice(0, 3)}/${up.slice(3)}` : up;
  return /^[A-Z]{3}\/[A-Z]{3}$/.test(pair) ? pair : config.primaryPair;
}

function normalizeField(raw) {
  return ['bid', 'ask', 'mid', 'spread'].includes(String(raw).toLowerCase()) ? String(raw).toLowerCase() : 'mid';
}

/** Is the newest sample for this pair simulated data? */
function isSimulated(pair) {
  const last = store.latestFor(pair);
  return Boolean(last?.sim);
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
  const schedulerState = scheduler.state();
  const meta = store.meta;
  const stats = store.stats();
  const staleThresholdMs = Math.max(config.pollIntervalMin * 60_000 * 3, 30 * 60_000);
  return {
    ok: Boolean(stats.observations),
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

// --- scraping ----------------------------------------------------------------

let lastManualRefresh = 0;

async function runScrape({ manual = false } = {}) {
  const previousQuotes = store.latestQuotes();
  const result = await scrapeOnce({ previousQuotes, force: manual });
  if (result.observation) {
    const { stored, reason } = await store.append(result.observation, { force: manual });
    result.stored = stored;
    result.storeReason = reason;
  }
  await store.recordAttempt({ ok: result.ok, error: result.error, simulated: result.simulated });
  return result;
}

const scheduler = createScheduler({
  intervalMin: config.pollIntervalMin,
  name: 'wing-scraper',
  run: runScrape,
});

// --- static files ------------------------------------------------------------

async function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, 'Forbidden');
    return;
  }
  try {
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) throw Object.assign(new Error('directory'), { code: 'EISDIR' });
    const etag = `W/"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag });
      res.end();
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const isHtml = ext === '.html';
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      ETag: etag,
      'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=300, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR') {
      // Single-page app: unknown non-API paths fall back to index.html.
      if (!urlPath.startsWith('/api/') && !path.extname(urlPath)) {
        await serveStatic(req, res, '/index.html');
        return;
      }
      sendJson(res, 404, { ok: false, error: 'not found', path: urlPath });
      return;
    }
    logger.error('static file error', { path: urlPath, error: err.message });
    sendJson(res, 500, { ok: false, error: 'internal error' });
  }
}

// --- routes ------------------------------------------------------------------

async function handleApi(req, res, url) {
  const route = url.pathname.replace(/\/+$/, '') || '/';
  const params = url.searchParams;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '600',
    });
    res.end();
    return;
  }

  switch (route) {
    case '/api/status':
      sendJson(res, 200, { ok: true, ...statusPayload() });
      return;

    case '/api/latest': {
      const pair = normalizePair(queryParam(params, 'pair'));
      const quote = quotePayload(pair);
      const series = store.series({ pair });
      const changes = changeWindows(series, normalizeField(queryParam(params, 'field', 'mid')));
      const dayPoints = series.filter((p) => p.t >= Date.now() - 86_400_000);
      sendJson(res, 200, {
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
      return;
    }

    case '/api/history': {
      const pair = normalizePair(queryParam(params, 'pair'));
      const field = normalizeField(queryParam(params, 'field'));
      const range = String(queryParam(params, 'range', '30d')).toLowerCase();
      const rangeMs = rangeToMs(range);
      const since = Number.isFinite(rangeMs) ? Date.now() - rangeMs : 0;
      const raw = store.series({ pair, since });
      const bucketParam = queryParam(params, 'bucket', 'auto');
      const bucketMs =
        bucketParam === 'none' || bucketParam === '0'
          ? 0
          : bucketParam === 'auto'
            ? pickBucketMs(Number.isFinite(rangeMs) ? rangeMs : Date.now() - (raw[0]?.t ?? Date.now()), raw.length)
            : Math.max(0, Number(bucketParam) || 0);
      const points = aggregate(raw, field, bucketMs);
      sendJson(res, 200, {
        ok: points.length > 0,
        pair,
        field,
        range,
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
      return;
    }

    case '/api/observations': {
      const limit = Math.min(500, Math.max(1, Number(queryParam(params, 'limit', 50)) || 50));
      const offset = Math.max(0, Number(queryParam(params, 'offset', 0)) || 0);
      const observations = store.recentObservations({ limit, offset });
      sendJson(res, 200, {
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
      return;
    }

    case '/api/pairs': {
      sendJson(res, 200, {
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
      });
      return;
    }

    case '/api/export.csv': {
      const pair = normalizePair(queryParam(params, 'pair'));
      const range = String(queryParam(params, 'range', 'all')).toLowerCase();
      const rangeMs = rangeToMs(range);
      const since = Number.isFinite(rangeMs) ? Date.now() - rangeMs : 0;
      const csv = store.csv({ pair, since });
      const stamp = new Date().toISOString().slice(0, 10);
      sendText(res, 200, csv, 'text/csv; charset=utf-8', {
        'Content-Disposition': `attachment; filename="${pair.replace('/', '-')}-${range}-${stamp}.csv"`,
        'Cache-Control': 'no-store',
      });
      return;
    }

    case '/api/refresh': {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'use POST' });
        return;
      }
      const now = Date.now();
      if (now - lastManualRefresh < config.refreshMinGapSec * 1000) {
        sendJson(res, 429, {
          ok: false,
          error: `refresh rate limited — try again in ${Math.ceil((config.refreshMinGapSec * 1000 - (now - lastManualRefresh)) / 1000)}s`,
        });
        return;
      }
      lastManualRefresh = now;
      const result = await runScrape({ manual: true });
      sendJson(res, result.ok ? 200 : 502, {
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
      return;
    }

    case '/healthz':
      sendJson(res, 200, { ok: true, uptime: process.uptime(), observations: store.stats().observations });
      return;

    default:
      sendJson(res, 404, { ok: false, error: 'unknown endpoint', path: route });
  }
}

/**
 * Demo convenience: when simulation is allowed and the store only holds the
 * bootstrap snapshot, generate N days of clearly-flagged synthetic history so
 * charts, ranges and alerts can be evaluated on a host without egress.
 * Never runs unless ALLOW_SIMULATION=true and SIMULATE_BACKFILL_DAYS > 0.
 */
async function maybeBackfillDemoHistory() {
  if (!config.allowSimulation || config.simulateBackfillDays <= 0) return;
  if (store.count > 2) {
    logger.debug('skipping demo backfill: store already has history', { observations: store.count });
    return;
  }
  const anchor = store.latest();
  if (!anchor || !anchor.quotes?.length) return;
  const observations = buildBackfill({
    seedQuotes: anchor.quotes,
    days: config.simulateBackfillDays,
    intervalMin: config.simulateBackfillIntervalMin,
    now: Date.parse(anchor.capturedAt) || Date.now(),
    meta: { sourceUrl: anchor.sourceUrl, sourceAsOf: anchor.sourceAsOf },
  });
  if (!observations.length) return;
  await store.bulkAppend(observations);
  logger.warn('generated SIMULATED demo history', {
    days: config.simulateBackfillDays,
    observations: observations.length,
    intervalMin: config.simulateBackfillIntervalMin,
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') {
      await handleApi(req, res, url);
      return;
    }
    await serveStatic(req, res, url.pathname);
  } catch (err) {
    logger.error('request failed', { url: req.url, error: err.message, stack: err.stack });
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal server error' });
    else res.end();
  }
});

export async function main() {
  await store.init();
  const seedResult = await store.seedFromFile();
  if (seedResult.seeded) logger.info('seeded empty store', seedResult);
  await maybeBackfillDemoHistory();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      const address = server.address();
      logger.info('server listening', {
        url: `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${address?.port ?? config.port}`,
        primaryPair: config.primaryPair,
        sourceUrl: config.sourceUrl,
        pollIntervalMin: config.pollIntervalMin,
        dataDir: config.dataDir,
        simulation: config.allowSimulation && config.simulateOnFailure ? 'enabled (fallback)' : 'disabled',
      });
      resolve();
    });
  });

  scheduler.start();

  const shutdown = (signal) => {
    logger.info('shutting down', { signal });
    scheduler.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => logger.error('unhandled rejection', { reason: String(reason) }));

  return server.address();
}

export { server, scheduler, store, runScrape };

// Only auto-start when executed directly (not when imported by the test suite).
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    logger.error('fatal startup error', { error: err.message, stack: err.stack });
    process.exit(1);
  });
}
