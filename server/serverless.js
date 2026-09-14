/**
 * Serverless bootstrap — everything the `api/*.js` entrypoints need to serve
 * the same API as the long-running server, on a platform with a read-only
 * filesystem and no scheduler.
 *
 * Data sources, in order of preference:
 *   1. the dataset that ships with the deployment (`data/observations.jsonl`,
 *      `data/daily.jsonl` — kept up to date by the GitHub Actions tracker, which
 *      is also what triggers a redeploy);
 *   2. a fresh scrape performed by the request itself (kept in memory only,
 *      unless a git-backed store is configured to commit it back).
 *
 * Parsed datasets are cached on `globalThis` so warm invocations skip the
 * filesystem entirely.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { config, logger, ROOT_DIR } from './config.js';
import { Store } from './store.js';
import { createApiRouter } from './router.js';
import { createGitStore } from './gitstore.js';
import { scrapeOnce } from './scrape/index.js';
import { dailyCsv, mergeDailyRows } from './daily.js';

const OBSERVATIONS_FILE = 'observations.jsonl';
const DAILY_FILE = 'daily.jsonl';

function parseJsonl(raw) {
  const out = [];
  for (const line of String(raw || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

/** First directory that actually holds dataset files (bundled, cwd or /var/task). */
export function resolveDataDir() {
  const candidates = [
    config.dataDir,
    path.join(process.cwd(), 'data'),
    path.join(ROOT_DIR, 'data'),
    '/var/task/data',
  ];
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, OBSERVATIONS_FILE)) || fs.existsSync(path.join(dir, DAILY_FILE))) return dir;
    } catch {
      /* unreadable candidate */
    }
  }
  return config.dataDir;
}

function isWritable(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Should this process write to the dataset directory? */
export function resolveReadonly(dataDir = resolveDataDir()) {
  if (config.storeMode === 'readonly') return true;
  if (config.storeMode === 'fs') return false;
  if (process.env.VERCEL) return true; // Vercel's runtime filesystem is read-only
  return !isWritable(dataDir);
}

/** Read the bundled dataset (cached across warm invocations). */
export async function loadDataset(dataDir = resolveDataDir()) {
  const cacheKey = `__usdkhrDataset:${dataDir}`;
  const cached = globalThis[cacheKey];
  if (cached) return cached;

  const [observations, daily] = await Promise.all([
    fsp.readFile(path.join(dataDir, OBSERVATIONS_FILE), 'utf8').catch(() => ''),
    fsp.readFile(path.join(dataDir, DAILY_FILE), 'utf8').catch(() => ''),
  ]);
  const dataset = {
    dataDir,
    observations: parseJsonl(observations),
    daily: parseJsonl(daily),
    loadedAt: new Date().toISOString(),
  };
  globalThis[cacheKey] = dataset;
  return dataset;
}

/** A read-only store preloaded with the bundled dataset. */
export async function createDatasetStore({ dataDir = resolveDataDir() } = {}) {
  const readonly = resolveReadonly(dataDir);
  const store = new Store({ dataDir, readonly });
  await store.init();
  const dataset = await loadDataset(dataDir);
  // `init()` already read whatever the store can see; hydrate the rest so a
  // bundled daily.jsonl is served even when the log was trimmed.
  if (dataset.daily.length) store.hydrateDaily(dataset.daily);
  if (dataset.observations.length > store.count) {
    const seen = new Set(store.tail.map((o) => o.id));
    store.hydrate(dataset.observations.filter((o) => !seen.has(o.id)));
  }
  return store;
}

/** Verify a Vercel Cron invocation (or an operator with the shared secret). */
export function verifyCron(headers = {}) {
  const auth = String(headers.authorization || headers.Authorization || '');
  const agent = String(headers['user-agent'] || headers['User-Agent'] || '');
  const secret = config.cronSecret;
  if (secret) {
    return auth === `Bearer ${secret}`
      ? { ok: true, reason: 'cron secret' }
      : { ok: false, reason: 'invalid or missing CRON_SECRET bearer token' };
  }
  // No secret configured: only accept Vercel's own cron runner.
  return /vercel-cron/i.test(agent)
    ? { ok: true, reason: 'vercel-cron user agent (no CRON_SECRET configured)' }
    : { ok: false, reason: 'set CRON_SECRET, or let Vercel Cron call this route' };
}

/**
 * Scrape once and persist what we can.
 *
 * On a writable filesystem this behaves exactly like the server's scrape cycle.
 * On Vercel the observation is kept in memory for this instance, and the daily
 * snapshot rows are committed back to the repository when `GITHUB_DATA_TOKEN`
 * is configured — the redeploy then ships them with the bundle.
 */
export async function scrapeAndPersist({ store, force = true, previousQuotes = null } = {}) {
  const result = await scrapeOnce({ previousQuotes: previousQuotes ?? store.latestQuotes(), force });
  const persisted = { observations: false, daily: false, backend: store.readonly ? 'git' : 'filesystem', reason: null };

  if (result.observation) {
    const { stored, reason } = await store.append(result.observation, { force: true });
    result.stored = stored;
    result.storeReason = reason;
  }
  await store.recordAttempt({ ok: result.ok, error: result.error, simulated: result.simulated });

  if (!store.readonly) {
    const daily = result.observation ? await store.updateDailySnapshots() : { updated: [] };
    persisted.observations = Boolean(result.stored);
    persisted.daily = Boolean(daily.written);
    persisted.backend = 'filesystem';
    result.daily = (daily.updated || []).map((d) => d.date);
    result.persisted = persisted;
    return result;
  }

  // Read-only host: commit the daily snapshot rows back to git when configured.
  const git = createGitStore(config.git);
  if (!result.observation) {
    persisted.reason = 'scrape produced no observation';
    result.persisted = persisted;
    return result;
  }
  if (!git.enabled) {
    persisted.reason = 'no git store configured (set GITHUB_DATA_TOKEN + GITHUB_REPO to persist snapshots)';
    result.persisted = persisted;
    return result;
  }

  const pair = config.primaryPair;
  const existing = parseJsonl((await git.readFile(config.dailyFile))?.content || '');
  const rows = mergeDailyRows(
    existing,
    store.dailyRows({ pair }).filter((r) => r.pair === pair)
  );
  const payload = rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16);

  const dailyRes = await git.updateFile(
    config.dailyFile,
    () => payload,
    { message: `data: ${pair} daily snapshot ${rows.at(-1)?.date || stamp} UTC` }
  );
  persisted.daily = Boolean(dailyRes.ok);
  if (!dailyRes.ok) persisted.reason = `daily.jsonl: ${dailyRes.error}`;

  if (dailyRes.ok) {
    const csvRes = await git.updateFile(
      config.dailyCsvFile,
      () => dailyCsv(rows),
      { message: `data: ${pair} daily snapshot CSV ${rows.at(-1)?.date || stamp} UTC` }
    );
    if (!csvRes.ok) persisted.reason = `${persisted.reason ? persisted.reason + '; ' : ''}csv: ${csvRes.error}`;
  }

  result.persisted = persisted;
  result.daily = rows.slice(-2).map((r) => r.date);
  logger.info('serverless snapshot persisted', { ...persisted, days: rows.length });
  return result;
}

/** Lazily build (and cache) the shared read-only store + router for this instance. */
export async function bootstrap({ platform = 'vercel' } = {}) {
  const cacheKey = '__usdkhrApp';
  if (globalThis[cacheKey]) return globalThis[cacheKey];
  const dataDir = resolveDataDir();
  const store = await createDatasetStore({ dataDir });
  const app = {
    store,
    dataDir,
    readonly: store.readonly,
    router: createApiRouter({ store, scheduler: null, runScrape: () => scrapeAndPersist({ store }), platform }),
    git: createGitStore(config.git),
  };
  globalThis[cacheKey] = app;
  return app;
}

/**
 * Adapt a Node-style serverless request (`req`, `res`) to the router.
 * Works for Vercel's Node runtime and for `node:http` alike.
 */
export async function handleServerlessRequest(req, res, { platform = 'vercel', pathname = null, query = null } = {}) {
  const app = await bootstrap({ platform });
  const url = new URL(req.url || '/', `http://${req.headers?.host || 'localhost'}`);
  const resolvedPath = pathname || resolveApiPath(url.pathname, url.searchParams);
  const result = await app.router.handle({
    method: req.method || 'GET',
    pathname: resolvedPath,
    query: query || url.searchParams,
    headers: req.headers || {},
  });
  res.setHeader?.('X-Tracker-Store', app.readonly ? 'read-only' : 'read-write');
  res.writeHead?.(result.status, { ...result.headers, 'Content-Length': Buffer.byteLength(result.body) });
  res.end(result.body);
  return result;
}

/**
 * Which API route does this invocation serve?
 * Vercel rewrites `/api/latest` to the single `api/index.js` function and keeps
 * the original path in `req.url`; if a platform hands us the function's own path
 * instead, `?route=` (injected by the rewrite) decides.
 */
export function resolveApiPath(pathname, searchParams = new URLSearchParams()) {
  const clean = String(pathname || '').replace(/\/+$/, '');
  if (clean === '/healthz' || /^\/api\/[a-z0-9._-]+/i.test(clean)) {
    if (!/^\/api\/(index|_app)(\.js)?$/i.test(clean)) return clean;
  }
  const route = searchParams.get('route');
  if (!route) return '/api/latest';
  return route === 'healthz' ? '/healthz' : `/api/${route.replace(/^\/+|\/+$/g, '')}`;
}
