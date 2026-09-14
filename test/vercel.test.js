/**
 * Vercel deployment tests.
 *
 * The serverless entrypoints are exercised directly with mock `req`/`res`
 * objects, so the same code that runs on Vercel is what is under test here:
 * route resolution, cron authentication, the read-only store, `/api/daily` and
 * the daily-snapshot cron committing back to a (fake) GitHub Contents API.
 *
 * Everything is offline: the "bank" is a local server that serves the real
 * board fixture on demand, and "GitHub" is a local Contents API stub.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'khr-vercel-'));
const boardFixture = await fsp.readFile(new URL('./fixtures/wing-table.html', import.meta.url), 'utf8');

// --- fixtures: a bundled dataset, the way a deployment ships it ---------------
const day1 = (h) => new Date(Date.UTC(2026, 8, 12, h, 0, 0)).toISOString(); // 2026-09-12
const day2 = (h) => new Date(Date.UTC(2026, 8, 13, h, 0, 0)).toISOString(); // 2026-09-13

function observation(iso, bid, ask) {
  return {
    id: `${iso}-fixture`,
    capturedAt: iso,
    sourceUrl: 'https://www.wingbank.com.kh/en/exchange-rate',
    sourceLabel: 'wingbank.com.kh',
    strategy: 'html-table',
    format: 'html',
    sourceAsOf: '2026-09-11',
    simulated: false,
    quotes: [{ pair: 'USD/KHR', base: 'USD', quote: 'KHR', name: 'Cambodian Riel', bid, ask, mid: (bid + ask) / 2 }],
    primary: { pair: 'USD/KHR', bid, ask, mid: (bid + ask) / 2, name: 'Cambodian Riel' },
  };
}

await fsp.writeFile(
  path.join(dataDir, 'observations.jsonl'),
  [observation(day1(2), 4040, 4050), observation(day1(8), 4046, 4056), observation(day2(3), 4049, 4059)]
    .map((o) => JSON.stringify(o))
    .join('\n') + '\n',
  'utf8'
);
// A persisted daily row for a day the log no longer covers (as after pruning).
await fsp.writeFile(
  path.join(dataDir, 'daily.jsonl'),
  JSON.stringify({
    pair: 'USD/KHR',
    date: '2026-09-10',
    tz: '+07:00',
    t: Date.parse(day1(2)) - 2 * 86_400_000,
    lastAt: '2026-09-10T16:00:00.000Z',
    samples: 8,
    open: 4030,
    high: 4038,
    low: 4028,
    close: 4034,
  }) + '\n',
  'utf8'
);

// --- a toggleable "bank" (serves the board only when switched on) ------------
let boardHtml = null;
const board = http.createServer((req, res) => {
  if (!boardHtml) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    return res.end('board unavailable');
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(boardHtml);
});
await new Promise((resolve) => board.listen(0, '127.0.0.1', resolve));

// --- a fake GitHub Contents API ---------------------------------------------
const gitState = new Map(); // path -> content
const gitCalls = [];
const github = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const filePath = decodeURIComponent(url.pathname.replace(/^\/repos\/[^/]+\/[^/]+\/contents\//, ''));
  gitCalls.push({ method: req.method, path: filePath });
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.method === 'GET') {
      if (!gitState.has(filePath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ message: 'Not Found' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({
          content: Buffer.from(gitState.get(filePath), 'utf8').toString('base64'),
          encoding: 'base64',
          sha: `sha-${filePath}`,
        })
      );
    }
    if (req.method === 'PUT') {
      const payload = JSON.parse(body);
      assert.equal(payload.branch, 'main', 'commits target the configured branch');
      gitState.set(filePath, Buffer.from(payload.content, 'base64').toString('utf8'));
      res.writeHead(gitState.size === 1 ? 201 : 200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ commit: { sha: 'commit-123' }, content: { sha: `blob-${filePath}` } }));
    }
    res.writeHead(405);
    res.end();
  });
});
await new Promise((resolve) => github.listen(0, '127.0.0.1', resolve));

// --- env must be set before the modules read it ------------------------------
process.env.DATA_DIR = dataDir;
process.env.STORE_MODE = 'readonly';
process.env.LOG_LEVEL = 'error';
process.env.SOURCE_URL = `http://127.0.0.1:${board.address().port}/en/exchange-rate`;
process.env.FALLBACK_SOURCES = '';
process.env.WING_API_ENDPOINTS = '';
process.env.ALLOW_SIMULATION = 'false';
process.env.USE_SEED = 'false';
process.env.FETCH_TIMEOUT_MS = '3000';
process.env.DAILY_TZ_OFFSET_MIN = '420';
process.env.CRON_SECRET = 'test-cron-secret';
process.env.GITHUB_DATA_TOKEN = 'github_pat_test';
process.env.GITHUB_REPO = 'acme/usd-khr';
process.env.GITHUB_BRANCH = 'main';
process.env.GITHUB_API_URL = `http://127.0.0.1:${github.address().port}`;

const { default: apiHandler } = await import('../api/index.js');
const { default: cronHandler } = await import('../api/cron/daily-snapshot.js');
const { bootstrap, resolveApiPath, resolveDataDir, resolveReadonly, scrapeAndPersist, verifyCron } = await import(
  '../server/serverless.js'
);

// --- helpers -----------------------------------------------------------------

function invoke(handler, { method = 'GET', url = '/', headers = {} } = {}) {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    writeHead(status, hdrs = {}) {
      this.statusCode = status;
      for (const [k, v] of Object.entries(hdrs)) this.headers[k.toLowerCase()] = v;
      return this;
    },
    end(chunk = '') {
      this.body += chunk;
      return this;
    },
  };
  return handler({ method, url, headers }, res).then(() => res);
}

const asJson = (res) => JSON.parse(res.body);

test.after(() => {
  board.close();
  github.close();
});

// --- tests -------------------------------------------------------------------

test('the bundled dataset directory is discovered and forced read-only', () => {
  assert.equal(resolveDataDir(), dataDir);
  assert.equal(resolveReadonly(dataDir), true, 'STORE_MODE=readonly wins');
});

test('resolveApiPath maps rewritten and direct paths to routes', () => {
  const q = (s) => new URL(`http://x${s}`).searchParams;
  assert.equal(resolveApiPath('/api/latest', q('/api/latest')), '/api/latest');
  assert.equal(resolveApiPath('/api/daily', q('/api/daily')), '/api/daily');
  assert.equal(resolveApiPath('/api/export.csv', q('/api/export.csv')), '/api/export.csv');
  assert.equal(resolveApiPath('/healthz', q('/healthz')), '/healthz');
  assert.equal(resolveApiPath('/api/index', q('/api/index?route=daily')), '/api/daily');
  assert.equal(resolveApiPath('/api/index.js', q('/api/index.js?route=healthz')), '/healthz');
  assert.equal(resolveApiPath('/api/index', q('/api/index')), '/api/latest', 'falls back to /api/latest');
});

test('cron auth needs the shared secret when one is configured', () => {
  assert.equal(verifyCron({ authorization: 'Bearer test-cron-secret' }).ok, true);
  assert.equal(verifyCron({ authorization: 'Bearer nope' }).ok, false);
  assert.equal(verifyCron({}).ok, false);
});

test('the api function serves /api/latest from the bundled dataset', async () => {
  const res = await invoke(apiHandler, { url: '/api/latest?pair=USD/KHR' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['access-control-allow-origin'], '*');
  assert.equal(res.headers['x-tracker-store'], 'read-only');
  const body = asJson(res);
  assert.equal(body.pair, 'USD/KHR');
  assert.equal(body.quote.bid, 4049);
  assert.equal(body.quote.ask, 4059);
  assert.equal(body.quote.mid, 4054);
  assert.equal(body.status.platform, 'vercel');
  assert.equal(body.status.store.readonly, true);
});

test('/api/daily returns snapshot rows from the log and the persisted file', async () => {
  const res = await invoke(apiHandler, { url: '/api/daily?pair=USD/KHR' });
  assert.equal(res.statusCode, 200);
  const body = asJson(res);
  assert.equal(body.tz, '+07:00');
  assert.deepEqual(body.days.map((d) => d.date), ['2026-09-10', '2026-09-12', '2026-09-13']);
  const d12 = body.days.find((d) => d.date === '2026-09-12');
  assert.equal(d12.samples, 2);
  assert.equal(d12.open, 4045, 'first mid of the local day');
  assert.equal(d12.close, 4051, 'last mid of the local day');
  assert.equal(d12.bid.close, 4046);
  assert.equal(d12.ask.close, 4056);
  assert.equal(body.points.length, 3, 'chart-ready points ride along');
  assert.equal(body.summary.count, 3);
});

test('/api/daily?format=csv downloads the daily series', async () => {
  const res = await invoke(apiHandler, { url: '/api/daily?pair=USD/KHR&format=csv' });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/csv/);
  assert.match(res.headers['content-disposition'], /USD-KHR-daily-all-\d{4}-\d{2}-\d{2}\.csv/);
  const lines = res.body.trim().split('\n');
  assert.equal(lines.length, 4, 'header + 3 days');
  assert.match(lines[0], /^date,pair,tz,open,high,low,close,/);
});

test('/api/history?grain=daily plots one point per day', async () => {
  const res = await invoke(apiHandler, { url: '/api/history?pair=USD/KHR&range=all&grain=daily&field=mid' });
  const body = asJson(res);
  assert.equal(body.grain, 'daily');
  assert.equal(body.bucketMs, 86_400_000);
  assert.equal(body.count, 3);
  assert.equal(body.rawCount, 11, '8 persisted samples + 3 in the log');
  assert.equal(body.points.at(-1).v, 4054);
  assert.equal(body.summary.min, 4034, 'the persisted day participates in the summary');

  const auto = asJson(await invoke(apiHandler, { url: '/api/history?pair=USD/KHR&range=all' }));
  assert.equal(auto.grain, 'sample');
  assert.equal(auto.count, 3, 'raw samples, no bucketing needed for 3 points');
});

test('the store is read-only: a failed scrape writes nothing', async () => {
  const before = await fsp.readdir(dataDir);
  const res = await invoke(apiHandler, { method: 'POST', url: '/api/refresh' });
  assert.equal(res.statusCode, 502, 'the board server is switched off');
  assert.equal(asJson(res).ok, false);
  assert.deepEqual(await fsp.readdir(dataDir), before, 'no files appeared or changed');
});

test('unknown routes 404 as JSON', async () => {
  const res = await invoke(apiHandler, { url: '/api/nope' });
  assert.equal(res.statusCode, 404);
  assert.equal(asJson(res).ok, false);
});

test('/healthz reports the platform', async () => {
  const res = await invoke(apiHandler, { url: '/healthz' });
  assert.equal(res.statusCode, 200);
  const body = asJson(res);
  assert.equal(body.ok, true);
  assert.equal(body.readonly, true);
  assert.equal(body.observations, 3);
});

test('the daily-snapshot cron rejects callers without the secret', async () => {
  const res = await invoke(cronHandler, { url: '/api/cron/daily-snapshot' });
  assert.equal(res.statusCode, 401);
  assert.match(asJson(res).error, /CRON_SECRET/);
  assert.equal(gitCalls.length, 0, 'nothing was written');
});

test('the daily-snapshot cron reports an unreadable board as 502', async () => {
  const res = await invoke(cronHandler, {
    url: '/api/cron/daily-snapshot',
    headers: { authorization: 'Bearer test-cron-secret', 'user-agent': 'vercel-cron' },
  });
  assert.equal(res.statusCode, 502);
  const body = asJson(res);
  assert.equal(body.ok, false);
  assert.equal(body.store.readonly, true);
  assert.equal(body.store.observations, 3);
  assert.match(body.error, /503|no rates|no primary pair|fetch failed/i);
  assert.equal(body.persisted.observations, false);
  assert.match(body.persisted.reason, /no observation/);
});

test('a successful scrape is committed to the repository as a daily snapshot', async () => {
  boardHtml = boardFixture; // the board is readable again
  const app = await bootstrap({ platform: 'test' });
  const result = await scrapeAndPersist({ store: app.store, force: true });
  boardHtml = null;

  assert.equal(result.ok, true, `scrape should succeed against the fixture: ${result.error}`);
  assert.equal(result.observation.primary.pair, 'USD/KHR');
  assert.equal(result.stored, false, 'a read-only store keeps the reading in memory only');
  assert.match(result.storeReason, /read-only/);
  assert.equal(result.persisted.backend, 'git');
  assert.equal(result.persisted.daily, true, result.persisted.reason);

  const committed = gitState.get('data/daily.jsonl');
  assert.ok(committed, 'data/daily.jsonl was committed');
  const rows = committed.trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(rows.length >= 4, `the merged history is committed (${rows.length} rows)`);
  assert.deepEqual(rows.map((r) => r.date).slice(0, 3), ['2026-09-10', '2026-09-12', '2026-09-13']);
  assert.ok(rows.at(-1).samples >= 1);
  assert.equal(rows.at(-1).pair, 'USD/KHR');

  const csv = gitState.get('data/usd-khr-daily.csv');
  assert.ok(csv && csv.startsWith('date,pair,tz,open,high,low,close,'), 'the CSV companion was committed');
  assert.equal(csv.trim().split('\n').length, rows.length + 1);
  assert.ok(gitCalls.some((c) => c.method === 'PUT' && c.path === 'data/daily.jsonl'));
  assert.ok(gitCalls.some((c) => c.method === 'PUT' && c.path === 'data/usd-khr-daily.csv'));
});

test('the live reading is served right after the cron ran', async () => {
  const res = await invoke(apiHandler, { url: '/api/latest' });
  const body = asJson(res);
  assert.equal(body.status.daily.days >= 3, true);
  assert.ok(body.status.daily.lastDate, 'the status payload names the newest snapshot day');
});
