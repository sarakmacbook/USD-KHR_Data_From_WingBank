/**
 * Frontend smoke test.
 *
 * The dashboard is plain HTML/CSS/JS with no build step, so the cheapest way to
 * catch regressions is to run it in jsdom against canned API payloads and assert
 * that it renders. jsdom is a dev-only dependency; if it is not installed the
 * suite skips instead of failing (the runtime itself stays dependency-free).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, '..');

let JSDOM = null;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  JSDOM = null;
}

const QUOTES = [
  { pair: 'USD/KHR', base: 'USD', quote: 'KHR', name: 'Cambodian Riel', bid: 4049, ask: 4059, mid: 4054, spread: 10, spreadPct: 0.247 },
  { pair: 'EUR/USD', base: 'EUR', quote: 'USD', name: 'Euro', bid: 1.1485, ask: 1.1717, mid: 1.1601, spread: 0.0232, spreadPct: 2.02 },
  { pair: 'USD/THB', base: 'USD', quote: 'THB', name: 'Thai Baht', bid: 32.71, ask: 33.37, mid: 33.04, spread: 0.66, spreadPct: 2.02 },
];

function latestPayload({ simulated = false } = {}) {
  const now = Date.now();
  return {
    ok: true,
    generatedAt: new Date(now).toISOString(),
    pair: 'USD/KHR',
    quote: {
      pair: 'USD/KHR',
      name: 'Cambodian Riel',
      bid: 4049,
      ask: 4059,
      mid: 4054,
      spread: 10,
      spreadPct: 0.247,
      decimals: 2,
      capturedAt: new Date(now - 45_000).toISOString(),
      epochMs: now - 45_000,
      ageSeconds: 45,
      sourceAsOf: '2026-09-11',
      simulated,
    },
    changes: {
      hour: { label: '1H', from: now - 3600_000, fromValue: 4052, change: 2, changePct: 0.049, available: true },
      day: { label: '24H', from: now - 86_400_000, fromValue: 4048, change: 6, changePct: 0.148, available: true },
      week: { label: '7D', from: now - 7 * 86_400_000, fromValue: 4061, change: -7, changePct: -0.172, available: true },
      month: { label: '30D', from: now - 30 * 86_400_000, fromValue: 4035, change: 19, changePct: 0.471, available: true },
      year: { label: '1Y', from: null, fromValue: null, change: null, changePct: null, available: false },
      previous: { from: now - 90_000, fromValue: 4051, change: 3, changePct: 0.074 },
    },
    last24h: { count: 48, first: 4048, last: 4054, min: 4046, max: 4062, avg: 4053.2, change: 6, changePct: 0.148 },
    quotes: QUOTES,
    status: {
      ok: true,
      primaryPair: 'USD/KHR',
      sourceUrl: 'https://www.wingbank.com.kh/en/exchange-rate',
      fallbackSources: ['https://r.jina.ai/{url}'],
      pollIntervalMin: 15,
      simulation: { allowed: simulated, on_failure: simulated, active: simulated },
      stale: false,
      staleThresholdMin: 45,
      store: { observations: 1442, pairs: 17, firstAt: new Date(now - 30 * 86_400_000).toISOString(), lastAt: new Date(now - 45_000).toISOString(), logBytes: 900_000 },
      scraper: {
        intervalMin: 15,
        running: false,
        consecutiveFailures: 0,
        currentDelayMin: 15,
        nextRunAt: new Date(now + 600_000).toISOString(),
        lastRunAt: new Date(now - 45_000).toISOString(),
        lastAttemptAt: new Date(now - 45_000).toISOString(),
        lastSuccessAt: new Date(now - 45_000).toISOString(),
        lastSimulatedAt: simulated ? new Date(now - 45_000).toISOString() : null,
        lastSource: simulated ? 'simulated (last real source unavailable)' : 'https://www.wingbank.com.kh/en/exchange-rate',
        lastStrategy: simulated ? 'random-walk' : 'html-table',
        lastSourceAsOf: '2026-09-11',
        lastError: simulated ? 'wingbank.com.kh: fetch failed' : null,
        totalAttempts: 120,
        totalSuccesses: 118,
        totalFailures: 2,
        totalSimulated: simulated ? 40 : 0,
      },
      serverTime: new Date(now).toISOString(),
    },
  };
}

function historyPayload() {
  const now = Date.now();
  const points = [];
  for (let i = 720; i >= 0; i -= 1) {
    points.push({
      t: now - i * 1800_000,
      v: 4050 + Math.round(Math.sin(i / 24) * 8),
      open: 4050,
      min: 4042 + (i % 5),
      max: 4061 - (i % 4),
      count: 4,
      sim: false,
    });
  }
  return {
    ok: true,
    pair: 'USD/KHR',
    field: 'mid',
    range: '30d',
    rangeMs: 2_592_000_000,
    bucketMs: 1_800_000,
    count: points.length,
    rawCount: 1441,
    simulated: false,
    points,
    summary: { count: 1441, first: 4059, last: 4054, min: 4043, max: 4063, avg: 4053.6, change: -5, changePct: -0.12 },
    changes: latestPayload().changes,
    ranges: [{ id: '30d', label: '30D' }],
  };
}

/** What /api/history returns when the chart is switched to daily snapshots. */
function dailyHistoryPayload() {
  const now = Date.now();
  const points = [0, 1, 2].map((i) => ({
    t: now - (2 - i) * 86_400_000,
    date: new Date(now - (2 - i) * 86_400_000).toISOString().slice(0, 10),
    v: 4050 + i * 2,
    open: 4049 + i,
    min: 4044 + i,
    max: 4058 + i,
    count: 96,
    sim: false,
  }));
  return Object.assign(historyPayload(), {
    grain: 'daily',
    tz: '+07:00',
    bucketMs: 86_400_000,
    count: points.length,
    rawCount: 288,
    points,
    summary: { count: 3, first: 4050, last: 4054, min: 4044, max: 4060, avg: 4052, change: 4, changePct: 0.099 },
  });
}

function pairsPayload() {
  return {
    ok: true,
    primaryPair: 'USD/KHR',
    pairs: QUOTES.map((q, i) => ({
      pair: q.pair,
      name: q.name,
      count: 1442 - i,
      bid: q.bid,
      ask: q.ask,
      mid: q.mid,
      spreadPct: q.spreadPct,
      capturedAt: new Date().toISOString(),
      simulated: false,
    })),
  };
}

function observationsPayload() {
  const now = Date.now();
  return {
    ok: true,
    limit: 25,
    offset: 0,
    total: 1442,
    observations: [0, 1, 2].map((i) => ({
      id: `obs-${i}`,
      capturedAt: new Date(now - i * 900_000).toISOString(),
      sourceLabel: i === 2 ? 'seed-snapshot' : 'wingbank.com.kh',
      sourceUrl: 'https://www.wingbank.com.kh/en/exchange-rate',
      strategy: i === 2 ? 'seed' : 'html-table',
      sourceAsOf: '2026-09-11',
      simulated: false,
      seed: i === 2,
      primary: { pair: 'USD/KHR', bid: 4049 - i, ask: 4059 - i, mid: 4054 - i, name: 'Cambodian Riel' },
      pairs: 17,
    })),
  };
}

/** Recording 2D context so we can assert the canvas chart actually drew. */
function createCanvasMock() {
  const calls = { count: 0, byMethod: {} };
  const noop = (name) => (...args) => {
    calls.count += 1;
    calls.byMethod[name] = (calls.byMethod[name] || 0) + 1;
    if (name === 'createLinearGradient') return { addColorStop() {} };
    if (name === 'measureText') return { width: 20 };
    return undefined;
  };
  const ctx = {};
  for (const m of [
    'save', 'restore', 'setTransform', 'clearRect', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc',
    'stroke', 'fill', 'fillText', 'setLineDash', 'createLinearGradient', 'measureText', 'translate', 'scale',
  ]) {
    ctx[m] = noop(m);
  }
  Object.assign(ctx, { canvas: null, font: '', textAlign: '', textBaseline: '', lineWidth: 1, strokeStyle: '', fillStyle: '' });
  return { ctx, calls };
}

async function mount(t, { simulated = false } = {}) {
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'http://localhost:3000/',
    beforeParse(window) {
      const { ctx } = createCanvasMock();
      window.HTMLCanvasElement.prototype.getContext = () => ctx;
      window.ResizeObserver = class { observe() {} disconnect() {} };
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      window.Notification = class { static permission = 'default'; static requestPermission() { return Promise.resolve('granted'); } };
      const routes = {
        latest: latestPayload({ simulated }),
        history: historyPayload(),
        historyDaily: dailyHistoryPayload(),
        pairs: pairsPayload(),
        observations: observationsPayload(),
        refresh: { ok: true, simulated, primary: { pair: 'USD/KHR', bid: 4049, ask: 4059, mid: 4054 }, attempts: [], warnings: [] },
      };
      window.__fetchLog = [];
      window.fetch = (url, options) => {
        const u = String(url);
        window.__fetchLog.push({ url: u, method: options?.method || 'GET' });
        const key = u.includes('/api/latest')
          ? 'latest'
          : u.includes('/api/history') && u.includes('grain=daily')
            ? 'historyDaily'
            : u.includes('/api/history')
              ? 'history'
              : u.includes('/api/pairs')
              ? 'pairs'
              : u.includes('/api/observations')
                ? 'observations'
                : u.includes('/api/refresh')
                  ? 'refresh'
                  : null;
        const payload = key ? routes[key] : { ok: false, error: 'unexpected url' };
        return Promise.resolve({
          ok: key !== null,
          status: key ? 200 : 404,
          text: () => Promise.resolve(JSON.stringify(payload)),
          json: () => Promise.resolve(payload),
        });
      };
      window.__errors = [];
      window.addEventListener('error', (e) => window.__errors.push(String(e.message)));
      const origError = window.console.error;
      window.console.error = (...args) => {
        window.__errors.push(args.map(String).join(' '));
        origError.apply(window.console, args);
      };
    },
  });

  const { window } = dom;
  window.eval(fs.readFileSync(path.join(root, 'public', 'chart.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8'));

  // jsdom keeps the app's polling intervals alive; close the window after the
  // test so the Node event loop can drain and the runner exits.
  if (t && typeof t.after === 'function') t.after(() => window.close());

  // let boot() + its promise chain settle
  for (let i = 0; i < 8; i += 1) await new Promise((r) => window.setTimeout(r, 12));
  return { window, document: window.document };
}

test('frontend renders the dashboard from the API', { skip: JSDOM ? false : 'jsdom not installed (npm i -D jsdom)', timeout: 30_000 }, async (t) => {
  const { window, document } = await mount(t);
  const text = (id) => document.getElementById(id).textContent.trim();

  assert.deepEqual(window.__errors, [], 'no runtime errors while booting');

  // hero
  assert.equal(text('pair-label'), 'USD/KHR');
  assert.equal(text('pair-name'), 'Cambodian Riel');
  assert.equal(text('rate-mid'), '4,054.00');
  assert.equal(text('stat-bid'), '4,049.00');
  assert.equal(text('stat-ask'), '4,059.00');
  assert.equal(text('stat-spread'), '10.00');
  assert.match(text('stat-range'), /4,046.*4,062/);
  assert.match(text('meta-asof'), /11 Sep 2026/);
  assert.match(text('meta-captured'), /ago/);

  // delta chips
  const chips = [...document.querySelectorAll('#hero-deltas .chip')];
  assert.equal(chips.length, 4);
  assert.match(chips[0].textContent, /vs previous/);
  assert.match(chips[1].textContent, /\+6\.00 \(\+0\.148%\)/);
  assert.equal(chips[2].className, 'chip chip-down');
  assert.equal(chips[3].className, 'chip chip-up');

  // status + no banner when healthy
  assert.equal(text('status-pill-text'), 'tracking');
  assert.equal(document.getElementById('status-pill').className, 'pill pill-live');
  assert.equal(document.getElementById('banner').hidden, true);

  // ticker + tables
  assert.equal(document.querySelectorAll('#ticker-inner .ticker-item').length, QUOTES.length);
  assert.equal(document.querySelectorAll('#pairs-table tbody tr').length, QUOTES.length);
  assert.equal(document.querySelectorAll('#log-table tbody tr').length, 3);
  assert.match(document.querySelector('#log-table tbody tr:last-child').textContent, /seed snapshot/);
  assert.match(text('log-count'), /showing 3 of 1442/);

  // converter: 100 USD sold to the bank at the bid
  assert.equal(text('convert-result'), '404,900.00 KHR');
  assert.match(document.getElementById('convert-notes').textContent, /Bank Buy/);

  // health panel
  assert.match(document.getElementById('health-list').textContent, /Poll interval/);
  assert.match(document.getElementById('health-list').textContent, /15 min/);

  // chart drew
  assert.ok(window.__fetchLog.some((f) => f.url.includes('/api/history')), 'history endpoint called');
  assert.equal(document.getElementById('chart-empty').hidden, true);
  assert.match(text('chart-points'), /721 plotted points/);
  assert.match(text('chart-summary'), /open 4,059/);
});

test('converter switches direction and uses the ask', { skip: JSDOM ? false : 'jsdom not installed', timeout: 30_000 }, async (t) => {
  const { window, document } = await mount(t);
  document.getElementById('dir-khr-usd').click();
  await new Promise((r) => window.setTimeout(r, 10));
  const amount = document.getElementById('convert-amount');
  amount.value = '4059000';
  amount.dispatchEvent(new window.Event('input'));
  await new Promise((r) => window.setTimeout(r, 10));
  assert.equal(document.getElementById('convert-result').textContent.trim(), '1,000.00 USD');
  assert.match(document.getElementById('convert-notes').textContent, /Bank Sell/);
});

test('range and field buttons reload the chart', { skip: JSDOM ? false : 'jsdom not installed', timeout: 30_000 }, async (t) => {
  const { window, document } = await mount(t);
  const before = window.__fetchLog.filter((f) => f.url.includes('/api/history')).length;
  document.querySelector('#range-buttons button[data-range="7d"]').click();
  await new Promise((r) => window.setTimeout(r, 20));
  document.querySelector('#field-buttons button[data-field="bid"]').click();
  await new Promise((r) => window.setTimeout(r, 20));
  const after = window.__fetchLog.filter((f) => f.url.includes('/api/history'));
  assert.ok(after.length > before, 'history refetched');
  assert.ok(after.some((f) => f.url.includes('range=7d')), 'range propagated');
  assert.ok(after.some((f) => f.url.includes('field=bid')), 'field propagated');
  assert.match(document.getElementById('chart-subtitle').textContent, /bank buy \(bid\)/i);
});

test('clicking a ticker item switches the tracked pair', { skip: JSDOM ? false : 'jsdom not installed', timeout: 30_000 }, async (t) => {
  const { window, document } = await mount(t);
  document.querySelector('#ticker-inner .ticker-item[data-pair="USD/THB"]').click();
  await new Promise((r) => window.setTimeout(r, 30));
  assert.equal(document.getElementById('pair-label').textContent.trim(), 'USD/THB');
  assert.equal(document.getElementById('rate-unit').textContent.trim(), 'THB per 1 USD');
  assert.match(window.document.title, /USD\/THB/);
  assert.ok(window.__fetchLog.some((f) => f.url.includes('pair=USD%2FTHB') || f.url.includes('pair=USD/THB')));
});

test('simulated data raises a loud banner and a warn status', { skip: JSDOM ? false : 'jsdom not installed', timeout: 30_000 }, async (t) => {
  const { window, document } = await mount(t, { simulated: true });
  const banner = document.getElementById('banner');
  assert.equal(banner.hidden, false);
  assert.match(banner.textContent, /Simulated data/);
  assert.match(banner.textContent, /wingbank\.com\.kh/);
  assert.equal(document.getElementById('status-pill-text').textContent.trim(), 'simulated');
  assert.equal(document.getElementById('status-pill').className, 'pill pill-sim');
  assert.deepEqual(window.__errors, []);
});

test('alerts fire when the mid rate crosses a threshold', { skip: JSDOM ? false : 'jsdom not installed', timeout: 30_000 }, async (t) => {
  const { window, document } = await mount(t);
  document.getElementById('alert-high').value = '4050';
  document.getElementById('btn-save-alerts').click();
  await new Promise((r) => window.setTimeout(r, 20));
  assert.match(document.getElementById('alert-state').textContent, /≥ 4,050/);
  assert.match(document.getElementById('banner').textContent, /Alert:/);
  assert.equal(document.getElementById('banner').hidden, false);
});

test('manual refresh posts to the API', { skip: JSDOM ? false : 'jsdom not installed', timeout: 30_000 }, async (t) => {
  const { window, document } = await mount(t);
  document.getElementById('btn-refresh').click();
  await new Promise((r) => window.setTimeout(r, 40));
  assert.ok(window.__fetchLog.some((f) => f.url.includes('/api/refresh') && f.method === 'POST'));
});

test('the Daily toggle re-requests the chart at daily resolution', { skip: JSDOM ? false : 'jsdom not installed', timeout: 30_000 }, async (t) => {
  const { window, document } = await mount(t);
  const btn = document.querySelector('#grain-buttons button[data-grain="daily"]');
  assert.ok(btn, 'the Auto/Daily resolution toggle is rendered');
  assert.equal(document.querySelector('#grain-buttons button[data-grain="auto"]').className, 'active');

  btn.click();
  for (let i = 0; i < 8; i += 1) await new Promise((r) => window.setTimeout(r, 12));

  const calls = window.__fetchLog.filter((f) => f.url.includes('/api/history'));
  assert.match(calls.at(-1).url, /grain=daily/, 'the chart asks for daily snapshots');
  assert.match(document.getElementById('chart-subtitle').textContent, /daily closes \(\+07:00\)/);
  assert.match(document.getElementById('chart-points').textContent, /3 daily snapshots · from 288 samples/);
  assert.match(document.getElementById('btn-daily-csv').getAttribute('href'), /^\.\/api\/daily\?pair=USD%2FKHR&range=30d&format=csv$/);
  assert.equal(btn.className, 'active', 'the toggle reflects the new resolution');
  assert.deepEqual(window.__errors, [], 'no runtime errors while switching');

  // switching back drops the parameter again
  document.querySelector('#grain-buttons button[data-grain="auto"]').click();
  for (let i = 0; i < 8; i += 1) await new Promise((r) => window.setTimeout(r, 12));
  assert.doesNotMatch(window.__fetchLog.filter((f) => f.url.includes('/api/history')).at(-1).url, /grain=daily/);
});

test('the daily CSV link follows the tracked pair', { skip: JSDOM ? false : 'jsdom not installed', timeout: 30_000 }, async (t) => {
  const { window, document } = await mount(t);
  document.querySelector('#ticker-inner button[data-pair="USD/THB"]').click();
  for (let i = 0; i < 8; i += 1) await new Promise((r) => window.setTimeout(r, 12));
  assert.match(document.getElementById('btn-daily-csv').getAttribute('href'), /pair=USD%2FTHB/);
  assert.match(document.getElementById('btn-csv').getAttribute('href'), /pair=USD%2FTHB/);
});
