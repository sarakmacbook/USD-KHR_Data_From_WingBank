import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RANGE_PRESETS,
  aggregate,
  changeWindows,
  decimalsFor,
  pickBucketMs,
  previousChange,
  rangeToMs,
  summarize,
  valueOf,
} from '../server/stats.js';

const HOUR = 3600_000;
const now = Date.UTC(2026, 8, 13, 12, 0, 0);

/** Ascending hourly samples with a known shape. */
function points(values, stepMs = HOUR, end = now) {
  const start = end - (values.length - 1) * stepMs;
  return values.map((v, i) => ({ t: start + i * stepMs, bid: v - 5, ask: v + 5, mid: v, sim: false }));
}

test('rangeToMs maps presets and falls back to 30d', () => {
  assert.equal(rangeToMs('24h'), 86_400_000);
  assert.equal(rangeToMs('7d'), 7 * 86_400_000);
  assert.equal(rangeToMs('all'), Infinity);
  assert.equal(rangeToMs('nonsense'), 30 * 86_400_000);
  assert.ok(RANGE_PRESETS.every((r) => r.id && r.label));
});

test('valueOf reads the requested field', () => {
  const p = { bid: 4049, ask: 4059, mid: 4054 };
  assert.equal(valueOf(p, 'bid'), 4049);
  assert.equal(valueOf(p, 'ask'), 4059);
  assert.equal(valueOf(p, 'mid'), 4054);
  assert.equal(valueOf(p, 'spread'), 10);
  assert.equal(valueOf({ bid: 4049, ask: null }, 'mid'), 4049, 'mid falls back to the available side');
});

test('pickBucketMs leaves short series raw and coarsens long ones', () => {
  assert.equal(pickBucketMs(24 * HOUR, 50), 0);
  const bucket = pickBucketMs(30 * 24 * HOUR, 5000, 400);
  assert.ok(bucket > 0);
  assert.ok((30 * 24 * HOUR) / bucket <= 420, `bucket ${bucket} keeps the chart under ~400 points`);
});

test('aggregate passes through when bucketMs is 0', () => {
  const pts = points([10, 11, 12]);
  const out = aggregate(pts, 'mid', 0);
  assert.deepEqual(out.map((p) => p.v), [10, 11, 12]);
  assert.ok(out.every((p) => p.count === 1 && p.min === p.v && p.max === p.v));
});

test('aggregate buckets into OHLC samples', () => {
  // 6 hourly samples aligned to the epoch -> 3 buckets of 2h
  const midnight = Date.UTC(2026, 8, 13, 0, 0, 0);
  const pts = [100, 104, 102, 98, 110, 105].map((v, i) => ({
    t: midnight + i * HOUR,
    bid: v - 1,
    ask: v + 1,
    mid: v,
    sim: false,
  }));
  const out = aggregate(pts, 'mid', 2 * HOUR);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((b) => b.count), [2, 2, 2]);
  assert.equal(out[0].open, 100);
  assert.equal(out[0].min, 100);
  assert.equal(out[0].max, 104);
  assert.equal(out[0].v, 104, 'bucket value is the last sample (closes the bucket)');
  assert.equal(out[1].min, 98);
  assert.equal(out[2].max, 110);
  assert.ok(out[1].t > out[0].t && out[2].t > out[1].t, 'timestamps ascend');
});

test('aggregate drops null values', () => {
  const pts = [{ t: now, mid: null, bid: null, ask: null }, { t: now + 1000, mid: 4054, bid: 4049, ask: 4059 }];
  assert.equal(aggregate(pts, 'mid', 0).length, 1);
});

test('summarize reports range statistics', () => {
  const s = summarize(points([4040, 4060, 4050]), 'mid');
  assert.equal(s.count, 3);
  assert.equal(s.first, 4040);
  assert.equal(s.last, 4050);
  assert.equal(s.min, 4040);
  assert.equal(s.max, 4060);
  assert.ok(Math.abs(s.avg - 4050) < 1e-9);
  assert.equal(s.change, 10);
  assert.ok(Math.abs(s.changePct - (10 / 4040) * 100) < 1e-9);
  assert.equal(summarize([], 'mid'), null);
});

test('changeWindows compares against the last sample inside each window', () => {
  // one sample per hour for 40 days
  const values = new Array(40 * 24).fill(0).map((_, i) => 4000 + i);
  const pts = points(values, HOUR, now);
  const w = changeWindows(pts, 'mid', now);

  assert.equal(w.hour.change, 1, 'one hourly step');
  assert.equal(w.day.change, 24);
  assert.equal(w.week.change, 24 * 7);
  assert.equal(w.month.change, 24 * 30);
  assert.equal(w.year.available, false, 'no data a year back');
  assert.equal(w.year.change, null);
  assert.equal(w.day.label, '24H');
  assert.ok(now - w.day.from <= 24 * HOUR + 1000, 'reference sample sits inside the 24h window');
  assert.equal(w.day.fromValue, 4000 + (values.length - 1) - 24);
});

test('previousChange skips unchanged samples', () => {
  const pts = points([4050, 4050, 4050, 4048, 4052]);
  const prev = previousChange(pts, 'mid');
  assert.equal(prev.fromValue, 4048);
  assert.equal(prev.change, 4);
  assert.ok(Math.abs(prev.changePct - (4 / 4048) * 100) < 1e-9);
});

test('previousChange is null-ish without history', () => {
  const single = points([4052]);
  assert.equal(previousChange(single).change, null);
  assert.equal(previousChange([]).changePct, null);
});

test('decimalsFor scales with magnitude', () => {
  assert.equal(decimalsFor(4054), 2);
  assert.equal(decimalsFor(152.58), 3);
  assert.equal(decimalsFor(32.71), 4);
  assert.equal(decimalsFor(0.8059), 4);
  assert.equal(decimalsFor(0.000123), 4);
  assert.equal(decimalsFor(0.0000123), 6);
});
