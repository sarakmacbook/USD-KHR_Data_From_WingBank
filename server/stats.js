/**
 * Time-series helpers: range presets, bucketing and change windows.
 * Shared by the API layer and unit-tested in test/stats.test.js.
 */

export const RANGE_PRESETS = [
  { id: '1h', label: '1H', ms: 60 * 60 * 1000 },
  { id: '24h', label: '24H', ms: 24 * 60 * 60 * 1000 },
  { id: '7d', label: '7D', ms: 7 * 24 * 60 * 60 * 1000 },
  { id: '30d', label: '30D', ms: 30 * 24 * 60 * 60 * 1000 },
  { id: '90d', label: '90D', ms: 90 * 24 * 60 * 60 * 1000 },
  { id: '1y', label: '1Y', ms: 365 * 24 * 60 * 60 * 1000 },
  { id: 'all', label: 'ALL', ms: Infinity },
];

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function rangeToMs(range) {
  const preset = RANGE_PRESETS.find((p) => p.id === String(range).toLowerCase());
  return preset ? preset.ms : 30 * DAY;
}

/**
 * Choose a bucket size that keeps the chart under ~400 points while preserving
 * detail for short ranges. Returns 0 for "no bucketing".
 */
export function pickBucketMs(rangeMs, pointCount, maxPoints = 400) {
  if (!Number.isFinite(rangeMs) || pointCount <= maxPoints) return 0;
  const candidates = [MINUTE, 5 * MINUTE, 15 * MINUTE, 30 * MINUTE, HOUR, 2 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY];
  const target = rangeMs / maxPoints;
  for (const c of candidates) if (c >= target) return c;
  return candidates[candidates.length - 1];
}

/**
 * Bucket points into OHLC-ish samples.
 * @param {Array<{t:number}>} points ascending by time
 * @param {'bid'|'ask'|'mid'} field
 * @param {number} bucketMs 0 = pass through
 */
export function aggregate(points, field = 'mid', bucketMs = 0) {
  const rows = points
    .map((p) => ({ t: p.t, v: valueOf(p, field), sim: p.sim }))
    .filter((p) => p.v !== null && p.v !== undefined);
  if (!rows.length) return [];
  if (!bucketMs) return rows.map((r) => ({ t: r.t, v: r.v, open: r.v, min: r.v, max: r.v, count: 1, sim: r.sim }));

  const out = [];
  let bucket = null;
  for (const r of rows) {
    const key = Math.floor(r.t / bucketMs) * bucketMs;
    if (!bucket || bucket.key !== key) {
      if (bucket) out.push(bucket);
      bucket = { key, t: r.t, open: r.v, min: r.v, max: r.v, v: r.v, count: 1, sim: r.sim };
    } else {
      bucket.v = r.v;
      bucket.t = r.t;
      bucket.min = Math.min(bucket.min, r.v);
      bucket.max = Math.max(bucket.max, r.v);
      bucket.count += 1;
      bucket.sim = bucket.sim || r.sim;
    }
  }
  if (bucket) out.push(bucket);
  return out.map((b) => ({ t: b.t, v: b.v, open: b.open, min: b.min, max: b.max, count: b.count, sim: b.sim }));
}

export function valueOf(point, field = 'mid') {
  if (field === 'bid') return point.bid ?? null;
  if (field === 'ask') return point.ask ?? null;
  if (field === 'spread') return point.bid !== null && point.ask !== null ? point.ask - point.bid : null;
  if (point.mid !== null && point.mid !== undefined) return point.mid;
  if (point.bid !== null && point.ask !== null) return (point.bid + point.ask) / 2;
  // A board that only publishes one side still deserves a plotted value.
  return point.bid ?? point.ask ?? null;
}

/** min / max / avg / first / last / change over an arbitrary point array. */
export function summarize(points, field = 'mid') {
  const values = points.map((p) => valueOf(p, field)).filter((v) => v !== null && v !== undefined);
  if (!values.length) return null;
  const first = values[0];
  const last = values[values.length - 1];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    count: values.length,
    first,
    last,
    min,
    max,
    avg: sum / values.length,
    change: last - first,
    changePct: first ? ((last - first) / first) * 100 : null,
    startedAt: points[0]?.t ?? null,
    endedAt: points[points.length - 1]?.t ?? null,
  };
}

/**
 * Change of the newest value against the last sample at (or before) each
 * look-back window. Used for the "1H / 24H / 7D / 30D" chips on the dashboard.
 */
export function changeWindows(points, field = 'mid', now = Date.now()) {
  const windows = [
    { id: 'hour', label: '1H', ms: HOUR },
    { id: 'day', label: '24H', ms: DAY },
    { id: 'week', label: '7D', ms: 7 * DAY },
    { id: 'month', label: '30D', ms: 30 * DAY },
    { id: 'year', label: '1Y', ms: 365 * DAY },
  ];
  const latest = points.at(-1);
  const latestValue = latest ? valueOf(latest, field) : null;
  const out = {};
  for (const w of windows) {
    const target = now - w.ms;
    let ref = null;
    for (const p of points) {
      if (p.t <= target) ref = p;
      else break;
    }
    const refValue = ref ? valueOf(ref, field) : null;
    out[w.id] = {
      label: w.label,
      from: ref ? ref.t : null,
      fromValue: refValue,
      change: refValue !== null && latestValue !== null ? latestValue - refValue : null,
      changePct: refValue ? ((latestValue - refValue) / refValue) * 100 : null,
      available: Boolean(ref),
    };
  }
  out.previous = previousChange(points, field);
  return out;
}

/** Change against the immediately preceding sample (different value only). */
export function previousChange(points, field = 'mid') {
  const latest = points.at(-1);
  if (!latest) return { change: null, changePct: null, from: null, fromValue: null };
  const latestValue = valueOf(latest, field);
  for (let i = points.length - 2; i >= 0; i -= 1) {
    const v = valueOf(points[i], field);
    if (v !== null && v !== latestValue) {
      return {
        from: points[i].t,
        fromValue: v,
        change: latestValue - v,
        changePct: v ? ((latestValue - v) / v) * 100 : null,
      };
    }
  }
  return { change: null, changePct: null, from: null, fromValue: null };
}

/** How many decimals make sense for a given rate magnitude.
 *  4054 KHR -> 2, 152.58 JPY -> 3, 32.71 THB / 0.8059 CHF -> 4. */
export function decimalsFor(value) {
  const v = Math.abs(value ?? 0);
  if (v >= 1000) return 2;
  if (v >= 100) return 3;
  if (v >= 0.0001) return 4;
  return 6;
}
