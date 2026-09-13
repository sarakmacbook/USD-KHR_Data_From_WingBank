import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep test output readable: the store logs every append at info level.
process.env.LOG_LEVEL = 'error';
const { Store } = await import('../server/store.js');

const dir = path.dirname(fileURLToPath(import.meta.url));
const seedFile = path.resolve(dir, '..', 'server', 'seed-snapshot.json');

async function tmpStore(overrides = {}) {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'khr-store-'));
  const store = new Store({ dataDir, minStoreIntervalSec: 60, ...overrides });
  await store.init();
  return { store, dataDir };
}

function observation({ minutesAgo = 0, bid = 4049, ask = 4059, simulated = false, pair = 'USD/KHR', extra = [] } = {}) {
  const capturedAt = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const quotes = [
    { pair, base: pair.split('/')[0], quote: pair.split('/')[1], name: 'Cambodian Riel', bid, ask, mid: (bid + ask) / 2 },
    ...extra,
  ];
  return {
    id: `${capturedAt}-test`,
    capturedAt,
    sourceUrl: 'https://www.wingbank.com.kh/en/exchange-rate',
    sourceLabel: 'test',
    strategy: 'html-table',
    format: 'html',
    sourceAsOf: '2026-09-11',
    simulated,
    quotes,
    primary: { pair, bid, ask, mid: (bid + ask) / 2, name: 'Cambodian Riel' },
  };
}

test('append stores, indexes and exposes the latest quote', async () => {
  const { store, dataDir } = await tmpStore();
  const res = await store.append(observation({ bid: 4049, ask: 4059 }), { force: true });
  assert.equal(res.stored, true);

  const last = store.latestFor('USD/KHR');
  assert.equal(last.bid, 4049);
  assert.equal(last.ask, 4059);
  assert.equal(last.mid, 4054);
  assert.equal(store.count, 1);
  assert.deepEqual(store.pairs().map((p) => p.pair), ['USD/KHR']);

  // files on disk
  const log = await fsp.readFile(path.join(dataDir, 'observations.jsonl'), 'utf8');
  assert.equal(log.trim().split('\n').length, 1);
  const latest = JSON.parse(await fsp.readFile(path.join(dataDir, 'latest.json'), 'utf8'));
  assert.equal(latest.primary.mid, 4054);
  const meta = JSON.parse(await fsp.readFile(path.join(dataDir, 'meta.json'), 'utf8'));
  assert.equal(meta.totalSuccesses, 1);
});

test('unchanged readings inside the minimum interval are skipped unless forced', async () => {
  const { store } = await tmpStore({ minStoreIntervalSec: 600 });
  const first = await store.append(observation({ minutesAgo: 1, bid: 4049, ask: 4059 }), { force: true });
  assert.equal(first.stored, true);

  const dupe = await store.append(observation({ minutesAgo: 0, bid: 4049, ask: 4059 }));
  assert.equal(dupe.stored, false);
  assert.match(dupe.reason, /unchanged/);
  assert.equal(store.count, 1);

  const forced = await store.append(observation({ minutesAgo: 0, bid: 4049, ask: 4059 }), { force: true });
  assert.equal(forced.stored, true);
  assert.equal(store.count, 2);

  const changed = await store.append(observation({ minutesAgo: 0, bid: 4050, ask: 4060 }));
  assert.equal(changed.stored, true, 'a real change is always stored');
});

test('index survives a restart (JSONL is the source of truth)', async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'khr-restart-'));
  const first = new Store({ dataDir, minStoreIntervalSec: 0 });
  await first.init();
  await first.append(observation({ minutesAgo: 30, bid: 4040, ask: 4050 }), { force: true });
  await first.append(observation({ minutesAgo: 15, bid: 4045, ask: 4055 }), { force: true });
  await first.append(observation({ minutesAgo: 1, bid: 4049, ask: 4059 }), { force: true });
  assert.equal(first.count, 3);

  const second = new Store({ dataDir });
  await second.init();
  assert.equal(second.count, 3);
  const series = second.series({ pair: 'USD/KHR' });
  assert.deepEqual(series.map((p) => p.bid), [4040, 4045, 4049]);
  assert.equal(second.latestFor('USD/KHR').ask, 4059);
  assert.equal(second.recentObservations({ limit: 1 })[0].primary.bid, 4049, 'newest first');
});

test('bulkAppend keeps the index chronological even when older rows arrive late', async () => {
  const { store } = await tmpStore();
  await store.append(observation({ minutesAgo: 0, bid: 4049, ask: 4059 }), { force: true });
  await store.bulkAppend([
    observation({ minutesAgo: 120, bid: 4030, ask: 4040, simulated: true }),
    observation({ minutesAgo: 60, bid: 4040, ask: 4050, simulated: true }),
  ]);
  const series = store.series({ pair: 'USD/KHR' });
  assert.deepEqual(series.map((p) => p.bid), [4030, 4040, 4049]);
  assert.equal(store.latestFor('USD/KHR').bid, 4049, 'latest is still the newest sample');
  assert.equal(store.latest().primary.bid, 4049);
  assert.equal(store.count, 3);
});

test('series honours time windows and limits', async () => {
  const { store } = await tmpStore();
  for (const minutesAgo of [180, 120, 60, 30, 5]) {
    await store.append(observation({ minutesAgo, bid: 4000 + minutesAgo, ask: 4010 + minutesAgo }), { force: true });
  }
  const since = Date.now() - 90 * 60_000;
  const window = store.series({ pair: 'USD/KHR', since });
  assert.equal(window.length, 3);
  assert.ok(window.every((p) => p.t >= since));
  assert.equal(store.series({ pair: 'USD/KHR', limit: 2 }).length, 2);
  assert.deepEqual(store.series({ pair: 'USD/KHR', limit: 2 }).map((p) => p.bid), [4030, 4005]);
  assert.deepEqual(store.series({ pair: 'EUR/USD' }), []);
});

test('csv export has a header row and one line per sample', async () => {
  const { store } = await tmpStore();
  await store.append(observation({ minutesAgo: 10, bid: 4049, ask: 4059 }), { force: true });
  await store.append(observation({ minutesAgo: 1, bid: 4050, ask: 4060 }), { force: true });
  const csv = store.csv({ pair: 'USD/KHR' });
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], 'captured_at,epoch_ms,pair,bid,ask,mid,spread,source_as_of,simulated');
  assert.equal(lines.length, 3);
  assert.match(lines[1], /USD\/KHR,4049,4059,4054,10,2026-09-11,false$/);
});

test('recordAttempt tracks failures and errors', async () => {
  const { store, dataDir } = await tmpStore();
  await store.recordAttempt({ ok: false, error: 'boom' });
  await store.recordAttempt({ ok: false, error: 'boom again' });
  assert.equal(store.meta.consecutiveFailures, 2);
  assert.equal(store.meta.lastError, 'boom again');
  assert.equal(store.meta.totalAttempts, 2);

  await store.recordAttempt({ ok: true });
  assert.equal(store.meta.consecutiveFailures, 0);
  assert.equal(store.meta.lastError, null);

  const persisted = JSON.parse(await fsp.readFile(path.join(dataDir, 'meta.json'), 'utf8'));
  assert.equal(persisted.totalAttempts, 3);
});

test('seedFromFile bootstraps an empty store once', async () => {
  const { store } = await tmpStore();
  const res = await store.seedFromFile(seedFile);
  assert.equal(res.seeded, true);
  assert.ok(res.pairs >= 10);
  const khr = store.latestFor('USD/KHR');
  assert.equal(khr.bid, 4049);
  assert.equal(khr.ask, 4059);
  assert.equal(store.latest().seed, true);

  const again = await store.seedFromFile(seedFile);
  assert.equal(again.seeded, false, 'never re-seeds a store that has data');
  assert.equal(store.count, res.pairs ? 1 : 1);
});

test('seed is skipped when USE_SEED=false', async () => {
  const previous = process.env.USE_SEED;
  process.env.USE_SEED = 'false';
  try {
    const { config } = await import('../server/config.js');
    config.useSeed = false;
    const { store } = await tmpStore();
    const res = await store.seedFromFile(seedFile);
    assert.equal(res.seeded, false);
    config.useSeed = true;
  } finally {
    if (previous === undefined) delete process.env.USE_SEED;
    else process.env.USE_SEED = previous;
  }
});

test('malformed lines are skipped without losing the rest of the log', async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'khr-bad-'));
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.writeFile(
    path.join(dataDir, 'observations.jsonl'),
    `${JSON.stringify(observation({ minutesAgo: 5, bid: 4048, ask: 4058 }))}\n{not json}\n\n${JSON.stringify(
      observation({ minutesAgo: 1, bid: 4049, ask: 4059 })
    )}\n`,
    'utf8'
  );
  const store = new Store({ dataDir });
  await store.init();
  assert.equal(store.count, 2);
  assert.equal(store.latestFor('USD/KHR').bid, 4049);
});

test('stats reports the log footprint', async () => {
  const { store } = await tmpStore();
  await store.append(observation({}), { force: true });
  const stats = store.stats();
  assert.equal(stats.observations, 1);
  assert.equal(stats.pairs, 1);
  assert.ok(stats.logBytes > 0);
  assert.ok(fs.existsSync(path.join(store.dataDir, 'observations.jsonl')));
});
