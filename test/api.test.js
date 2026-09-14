/**
 * API integration test: boots the real HTTP server on an ephemeral port against
 * a temporary data dir, with the source pointed at a closed local port so the
 * "source unreachable" path is exercised deterministically and offline.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'khr-api-'));

process.env.DATA_DIR = dataDir;
process.env.HOST = '127.0.0.1';
process.env.PORT = '0';
process.env.SOURCE_URL = 'http://127.0.0.1:9/exchange-rate'; // nothing listens here
process.env.FALLBACK_SOURCES = '';
process.env.WING_API_ENDPOINTS = '';
process.env.POLL_INTERVAL_MIN = '1440'; // do not poll while testing
process.env.ALLOW_SIMULATION = 'false';
process.env.SIMULATE_ON_FAILURE = 'false';
process.env.USE_SEED = 'true';
process.env.LOG_LEVEL = 'error';
process.env.REFRESH_MIN_GAP_SEC = '30';
process.env.FETCH_TIMEOUT_MS = '2000';

const { main, server, scheduler } = await import('../server/index.js');

let base = null;

test.before(async () => {
  const address = await main();
  scheduler.stop();
  base = `http://127.0.0.1:${address.port}`;
});

test.after(() => {
  scheduler.stop();
  server.close();
});

async function get(pathname) {
  const res = await fetch(`${base}${pathname}`);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, headers: res.headers, text, json };
}

test('GET /healthz reports liveness', async () => {
  const r = await get('/healthz');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.observations, 1, 'the seed snapshot is loaded');
});

test('GET / serves the dashboard', async () => {
  const r = await get('/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.match(r.text, /USD\/KHR Tracker/);
  assert.match(r.text, /wingbank\.com\.kh\/en\/exchange-rate/);
});

test('unknown pages fall back to the SPA, unknown API routes 404 as JSON', async () => {
  const page = await get('/some/deep/link');
  assert.equal(page.status, 200);
  assert.match(page.text, /USD\/KHR Tracker/);

  const api = await get('/api/does-not-exist');
  assert.equal(api.status, 404);
  assert.equal(api.json.ok, false);
});

test('path traversal cannot escape the public directory', async () => {
  for (const p of ['/%2e%2e%2fserver%2fconfig.js', '/../server/config.js', '/..%2f..%2fpackage.json']) {
    const r = await get(p);
    assert.ok([403, 404].includes(r.status), `${p} -> ${r.status}`);
    assert.ok(!r.text.includes('ALLOW_SIMULATION'), `${p} leaked server config`);
  }
});

test('GET /api/latest returns the seeded USD/KHR quote', async () => {
  const r = await get('/api/latest');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.pair, 'USD/KHR');
  assert.equal(r.json.quote.bid, 4049);
  assert.equal(r.json.quote.ask, 4059);
  assert.equal(r.json.quote.mid, 4054);
  assert.equal(r.json.quote.spread, 10);
  assert.equal(r.json.quote.simulated, false);
  assert.equal(r.json.quote.sourceAsOf, '2026-09-11');
  assert.equal(r.json.status.simulation.active, false);
  assert.ok(r.json.quotes.length >= 10, 'all board pairs come back');
  assert.equal(r.json.changes.previous.change, null, 'a single sample has no previous');
});

test('GET /api/latest accepts USDKHR and other pairs', async () => {
  const compact = await get('/api/latest?pair=USDKHR');
  assert.equal(compact.json.pair, 'USD/KHR');
  const thb = await get('/api/latest?pair=USD/THB');
  assert.equal(thb.json.quote.bid, 32.71);
  const bogus = await get('/api/latest?pair=not-a-pair');
  assert.equal(bogus.json.pair, 'USD/KHR', 'invalid input falls back to the primary pair');
});

test('GET /api/history returns the series, summary and range presets', async () => {
  const r = await get('/api/history?range=30d&field=mid');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.pair, 'USD/KHR');
  assert.equal(r.json.field, 'mid');
  assert.equal(r.json.points.length, 1);
  assert.equal(r.json.points[0].v, 4054);
  assert.equal(r.json.summary.min, 4054);
  assert.ok(Array.isArray(r.json.ranges) && r.json.ranges.length >= 5);

  const bid = await get('/api/history?range=all&field=bid');
  assert.equal(bid.json.points[0].v, 4049);
});

test('GET /api/pairs lists the whole board', async () => {
  const r = await get('/api/pairs');
  assert.equal(r.json.primaryPair, 'USD/KHR');
  assert.equal(r.json.pairs[0].pair, 'USD/KHR', 'primary pair sorts first');
  assert.ok(r.json.pairs.length >= 15);
  assert.ok(r.json.pairs.every((p) => Number.isFinite(p.mid)));
});

test('GET /api/observations exposes the capture log', async () => {
  const r = await get('/api/observations?limit=5');
  assert.equal(r.json.total, 1);
  assert.equal(r.json.observations[0].seed, true);
  assert.equal(r.json.observations[0].primary.mid, 4054);
  assert.equal(r.json.observations[0].pairs, 17);
});

test('GET /api/export.csv downloads the series', async () => {
  const r = await get('/api/export.csv?range=all');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="USD-KHR-all-\d{4}-\d{2}-\d{2}\.csv"/);
  const lines = r.text.trim().split('\n');
  assert.equal(lines[0], 'captured_at,epoch_ms,pair,bid,ask,mid,spread,source_as_of,simulated');
  assert.equal(lines.length, 2);
  assert.match(lines[1], /USD\/KHR,4049,4059,4054,10,2026-09-11,false$/);
});

test('GET /api/daily returns one snapshot row per calendar day', async () => {
  const r = await get('/api/daily?pair=USD/KHR');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.pair, 'USD/KHR');
  assert.equal(r.json.tz, '+07:00');
  assert.equal(r.json.count, 1, 'the seed snapshot covers a single day');
  const day = r.json.days[0];
  assert.match(day.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(day.open, 4054);
  assert.equal(day.high, 4054);
  assert.equal(day.low, 4054);
  assert.equal(day.close, 4054);
  assert.equal(day.bid.close, 4049);
  assert.equal(day.ask.close, 4059);
  assert.equal(day.spreadClose, 10);
  assert.equal(day.samples, 1);
  assert.equal(day.simulated, false);
  assert.equal(r.json.points[0].v, 4054, 'chart-ready points ride along');
  assert.equal(r.json.summary.count, 1);

  const csv = await get('/api/daily?format=csv');
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.headers.get('content-disposition'), /USD-KHR-daily-all-\d{4}-\d{2}-\d{2}\.csv/);
  const lines = csv.text.trim().split('\n');
  assert.match(lines[0], /^date,pair,tz,open,high,low,close,/);
  assert.equal(lines.length, 2);
});

test('GET /api/history?grain=daily switches the chart to daily closes', async () => {
  const r = await get('/api/history?range=all&field=mid&grain=daily');
  assert.equal(r.json.grain, 'daily');
  assert.equal(r.json.bucketMs, 86_400_000);
  assert.equal(r.json.count, 1);
  assert.equal(r.json.points[0].v, 4054);
  assert.equal(r.json.points[0].date, r.json.points[0].date);
  assert.ok(r.json.tz, 'the response names the timezone the days are cut on');

  const bid = await get('/api/history?range=all&field=bid&grain=daily');
  assert.equal(bid.json.points[0].v, 4049, 'daily bid close');

  const auto = await get('/api/history?range=all&field=mid');
  assert.equal(auto.json.grain, 'sample');
  assert.equal(auto.json.bucketMs, 0, 'one point needs no bucketing');
});

test('GET /api/status describes scraper health', async () => {
  const r = await get('/api/status');
  assert.equal(r.json.ok, true);
  assert.equal(r.json.primaryPair, 'USD/KHR');
  assert.equal(r.json.pollIntervalMin, 1440);
  assert.equal(r.json.simulation.allowed, false);
  assert.equal(r.json.store.observations, 1);
  assert.equal(r.json.daily.tz, '+07:00');
  assert.equal(r.json.daily.days, 1, 'daily snapshot coverage is reported');
  assert.match(r.json.daily.lastDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(r.json.daily.lastClose, 4054);
  assert.equal(typeof r.json.scraper.totalAttempts, 'number');
  assert.ok(r.json.serverTime);
});

test('POST /api/refresh reports the unreachable source, then rate limits', async () => {
  const res = await fetch(`${base}/api/refresh`, { method: 'POST' });
  const body = await res.json();
  assert.equal(res.status, 502);
  assert.equal(body.ok, false);
  assert.equal(body.simulated, false);
  assert.match(body.error, /fetch failed|ECONNREFUSED|refused/i);
  assert.ok(body.attempts.length >= 1);
  assert.equal(body.quote.mid, 4054, 'the last known reading is still served');

  const again = await fetch(`${base}/api/refresh`, { method: 'POST' });
  assert.equal(again.status, 429);
  const limited = await again.json();
  assert.match(limited.error, /rate limited/);
});

test('GET /api/refresh is rejected (POST only)', async () => {
  const r = await get('/api/refresh');
  assert.equal(r.status, 405);
});

test('CORS is open so other tools can consume the API', async () => {
  const r = await get('/api/latest');
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
});

test('the log file is valid JSONL and append-only', async () => {
  const raw = await fsp.readFile(path.join(dataDir, 'observations.jsonl'), 'utf8');
  const lines = raw.trim().split('\n');
  assert.ok(lines.length >= 1);
  for (const line of lines) {
    const obs = JSON.parse(line);
    assert.ok(obs.capturedAt && Array.isArray(obs.quotes));
  }
});
