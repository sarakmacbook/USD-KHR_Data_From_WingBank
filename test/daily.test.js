/**
 * Daily snapshot tests: calendar-day bucketing (UTC+7), OHLC math, row merging,
 * chart-point shape and CSV output.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_TZ_OFFSET_MIN,
  DAILY_HEADER,
  dailyCsv,
  dailySnapshot,
  dailySnapshots,
  dailyToPoints,
  dayKey,
  dayStartMs,
  mergeDailyRows,
  ohlcOf,
  shiftDay,
  tzLabel,
} from '../server/daily.js';

const ICT = DEFAULT_TZ_OFFSET_MIN; // +420

function point(iso, bid, ask, extra = {}) {
  return { t: Date.parse(iso), bid, ask, mid: (bid + ask) / 2, sim: false, asOf: null, ...extra };
}

test('day boundaries follow the UTC+7 offset, not UTC', () => {
  // 2026-09-13T23:30Z is already 06:30 on the 14th in Phnom Penh.
  assert.equal(dayKey(Date.parse('2026-09-13T23:30:00Z'), ICT), '2026-09-14');
  assert.equal(dayKey(Date.parse('2026-09-13T16:30:00Z'), ICT), '2026-09-13');
  // ...and still the 13th in UTC.
  assert.equal(dayKey(Date.parse('2026-09-13T23:30:00Z'), 0), '2026-09-13');
  assert.equal(tzLabel(ICT), '+07:00');
  assert.equal(tzLabel(-330), '-05:30');
  assert.equal(dayKey(dayStartMs('2026-09-14', ICT), ICT), '2026-09-14');
  assert.equal(shiftDay('2026-03-01', -1, ICT), '2026-02-28');
  assert.equal(shiftDay('2024-03-01', -1, ICT), '2024-02-29', 'leap year');
});

test('ohlcOf reports open/high/low/close and ignores non-numbers', () => {
  assert.deepEqual(ohlcOf([4050, 4062, 4041, 4054]), { open: 4050, high: 4062, low: 4041, close: 4054, count: 4 });
  assert.deepEqual(ohlcOf([4050, null, undefined, NaN, 4052]), { open: 4050, high: 4052, low: 4050, close: 4052, count: 2 });
  assert.equal(ohlcOf([]), null);
  assert.equal(ohlcOf([null, null]), null);
});

test('a day of samples collapses into one OHLC snapshot', () => {
  const day = [
    point('2026-09-13T01:00:00Z', 4049, 4059),
    point('2026-09-13T05:00:00Z', 4052, 4064),
    point('2026-09-13T09:00:00Z', 4044, 4056),
    point('2026-09-13T12:00:00Z', 4050, 4060),
  ];
  const row = dailySnapshot(day, { pair: 'USD/KHR', offsetMin: ICT });
  assert.equal(row.date, '2026-09-13');
  assert.equal(row.pair, 'USD/KHR');
  assert.equal(row.tz, '+07:00');
  assert.equal(row.samples, 4);
  assert.equal(row.open, 4054, 'mid open');
  assert.equal(row.high, 4058);
  assert.equal(row.low, 4050);
  assert.equal(row.close, 4055);
  assert.equal(row.change, 1);
  assert.equal(row.bid.close, 4050);
  assert.equal(row.ask.close, 4060);
  assert.equal(row.spread.close, 10);
  assert.equal(row.spreadClose, 10);
  assert.equal(row.firstAt, '2026-09-13T01:00:00.000Z');
  assert.equal(row.lastAt, '2026-09-13T12:00:00.000Z');
  assert.equal(row.simulated, false);
  assert.equal(dailySnapshot([], { pair: 'USD/KHR' }), null);
});

test('dailySnapshots groups by local day and stays sorted', () => {
  const points = [
    point('2026-09-12T02:00:00Z', 4040, 4050),
    point('2026-09-12T08:00:00Z', 4046, 4056),
    point('2026-09-13T02:00:00Z', 4048, 4058),
    // 2026-09-13T23:30Z belongs to the 14th in UTC+7
    point('2026-09-13T23:30:00Z', 4060, 4070),
  ];
  const rows = dailySnapshots(points, { pair: 'USD/KHR', offsetMin: ICT });
  assert.deepEqual(rows.map((r) => r.date), ['2026-09-12', '2026-09-13', '2026-09-14']);
  assert.deepEqual(rows.map((r) => r.samples), [2, 1, 1]);
  assert.equal(rows[2].close, 4065);

  // since/until filter on sample time, so a partial day still produces a row
  const partial = dailySnapshots(points, { pair: 'USD/KHR', offsetMin: ICT, since: Date.parse('2026-09-12T07:00:00Z') });
  assert.deepEqual(partial.map((r) => r.date), ['2026-09-12', '2026-09-13', '2026-09-14']);
  assert.equal(partial[0].samples, 1, 'the earlier sample was filtered out');
  assert.deepEqual(dailySnapshots([], {}), []);
});

test('simulated samples are flagged on the day they appear in', () => {
  const rows = dailySnapshots(
    [point('2026-09-13T02:00:00Z', 4048, 4058), point('2026-09-13T03:00:00Z', 4050, 4060, { sim: true })],
    { pair: 'USD/KHR', offsetMin: ICT }
  );
  assert.equal(rows[0].simulated, true);
});

test('mergeDailyRows prefers the row that saw the newest sample', () => {
  const persisted = [{ pair: 'USD/KHR', date: '2026-09-13', lastAt: '2026-09-13T08:00:00.000Z', close: 4050, samples: 3 }];
  const fresher = [{ pair: 'USD/KHR', date: '2026-09-13', lastAt: '2026-09-13T16:00:00.000Z', close: 4055, samples: 9 }];
  const older = [{ pair: 'USD/KHR', date: '2026-09-13', lastAt: '2026-09-13T01:00:00.000Z', close: 4000, samples: 1 }];
  const onlyPersisted = [{ pair: 'USD/KHR', date: '2026-09-12', lastAt: '2026-09-12T16:00:00.000Z', close: 4044 }];

  const merged = mergeDailyRows(persisted, fresher, older, onlyPersisted);
  assert.deepEqual(merged.map((r) => r.date), ['2026-09-12', '2026-09-13']);
  assert.equal(merged[1].close, 4055, 'newest lastAt wins');
  assert.equal(merged[0].close, 4044, 'days only present in the persisted file survive');

  const other = mergeDailyRows([{ pair: 'USD/THB', date: '2026-09-13', lastAt: '2026-09-13T09:00:00.000Z' }], merged);
  assert.equal(other.length, 3, 'pairs never collide');
});

test('dailyToPoints matches the chart/aggregate point shape', () => {
  const rows = dailySnapshots(
    [point('2026-09-13T02:00:00Z', 4049, 4059), point('2026-09-13T06:00:00Z', 4055, 4065)],
    { pair: 'USD/KHR', offsetMin: ICT }
  );
  const points = dailyToPoints(rows, 'mid');
  assert.equal(points.length, 1);
  const p = points[0];
  assert.equal(p.date, '2026-09-13');
  assert.equal(p.v, 4060, 'close of the day');
  assert.equal(p.open, 4054);
  assert.equal(p.min, 4054);
  assert.equal(p.max, 4060);
  assert.equal(p.count, 2);
  assert.equal(p.sim, false);
  assert.equal(p.bid, 4055, 'day closes ride along so summarize() keeps working');
  assert.equal(p.ask, 4065);

  const spread = dailyToPoints(rows, 'spread');
  assert.equal(spread[0].v, 10);
  assert.equal(spread[0].open, 10);
  assert.deepEqual(dailyToPoints([], 'mid'), []);
});

test('dailyCsv has a stable header and one row per day', () => {
  const rows = dailySnapshots([point('2026-09-13T02:00:00Z', 4049, 4059)], { pair: 'USD/KHR', offsetMin: ICT });
  const csv = dailyCsv(rows);
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], DAILY_HEADER);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /^2026-09-13,USD\/KHR,\+07:00,4054,4054,4054,4054,4054,4054,4054,4054,4049,4059,10,0,0,1,2026-09-13T02:00:00\.000Z,2026-09-13T02:00:00\.000Z,,false$/);
  assert.equal(dailyCsv([]), DAILY_HEADER, 'an empty series is just the header');
});
