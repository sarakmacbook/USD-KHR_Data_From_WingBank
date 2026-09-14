/**
 * USD/KHR tracker — HTTP server.
 *
 * Zero runtime dependencies: Node's built-in http server, fetch and fs only.
 * Serves the dashboard from /public and the JSON API from /api. All route logic
 * lives in ./router.js so the serverless entrypoints (api/*.js) share it.
 *
 *   GET  /api/status                  scraper health + store stats
 *   GET  /api/latest?pair=USD/KHR     current quote, changes, all pairs
 *   GET  /api/history?pair&range&field&grain chart series + summary
 *   GET  /api/daily?pair&range&field  daily snapshot series (OHLC per day)
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
import { createApiRouter } from './router.js';
import { scrapeOnce } from './scrape/index.js';
import { buildBackfill } from './scrape/simulate.js';
import { createScheduler } from './scheduler.js';

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

// --- scraping ----------------------------------------------------------------

/**
 * One scrape cycle: fetch, validate, persist, then refresh the daily snapshot
 * rows (data/daily.jsonl) that long-range graphs are built from.
 */
export async function runScrape({ manual = false } = {}) {
  const previousQuotes = store.latestQuotes();
  const result = await scrapeOnce({ previousQuotes, force: manual });
  if (result.observation) {
    const { stored, reason } = await store.append(result.observation, { force: manual });
    result.stored = stored;
    result.storeReason = reason;
    if (stored) {
      const daily = await store.updateDailySnapshots();
      if (daily.updated?.length) result.daily = daily.updated.map((d) => d.date);
    }
  }
  await store.recordAttempt({ ok: result.ok, error: result.error, simulated: result.simulated });
  return result;
}

const scheduler = createScheduler({
  intervalMin: config.pollIntervalMin,
  name: 'wing-scraper',
  run: runScrape,
});

const router = createApiRouter({ store, scheduler, runScrape, platform: 'node' });

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

// --- request handling --------------------------------------------------------

async function handleApi(req, res, url) {
  const result = await router.handle({
    method: req.method,
    pathname: url.pathname,
    query: url.searchParams,
    headers: req.headers,
  });
  res.writeHead(result.status, { ...result.headers, 'Content-Length': Buffer.byteLength(result.body) });
  res.end(result.body);
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
  await store.updateDailySnapshots({ days: config.simulateBackfillDays + 1 });
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

export { server, scheduler, store, router };

// Only auto-start when executed directly (not when imported by the test suite).
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    logger.error('fatal startup error', { error: err.message, stack: err.stack });
    process.exit(1);
  });
}
