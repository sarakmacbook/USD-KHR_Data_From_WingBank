/**
 * Daily snapshots — one OHLC row per calendar day per currency pair.
 *
 * The tracker samples the board every few minutes, which is great for a live
 * dashboard but wasteful for a long-horizon graph (a year of 15-minute samples
 * is ~35k points). A *daily snapshot* collapses each local calendar day into a
 * single open/high/low/close row, which is what a price chart wants:
 *
 *   { "date": "2026-09-13", "pair": "USD/KHR", "open": 4054, "high": 4059,
 *     "low": 4049, "close": 4054, "samples": 96, ... }
 *
 * Day boundaries use a fixed UTC offset rather than a timezone database:
 * Cambodia (Asia/Phnom_Penh) is UTC+7 all year round — no DST — so the default
 * offset of +420 minutes is exact and keeps this module dependency-free.
 *
 * Snapshots are derived from the observation log on the fly *and* persisted to
 * `data/daily.jsonl`, because a serverless deployment (Vercel) has no durable
 * filesystem: there the committed/Blob-stored daily file *is* the graph dataset.
 */
import { valueOf } from './stats.js';

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Cambodia / Indochina Time — UTC+7, no daylight saving. */
export const DEFAULT_TZ_OFFSET_MIN = 7 * 60;

const FIELDS = ['mid', 'bid', 'ask', 'spread'];

function pad(n) {
  return String(n).padStart(2, '0');
}

/** `+07:00` / `-05:30` label for a UTC offset in minutes. */
export function tzLabel(offsetMin = 0) {
  const sign = offsetMin < 0 ? '-' : '+';
  const abs = Math.abs(Math.round(offsetMin));
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/**
 * Calendar date (`YYYY-MM-DD`) of a timestamp in UTC+offset.
 * Computed from the UTC parts of a shifted Date so no ICU/timezone data is
 * needed and the result is identical on every platform.
 */
export function dayKey(t, offsetMin = 0) {
  const d = new Date(t + offsetMin * 60_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Epoch ms of 00:00 of `YYYY-MM-DD` in UTC+offset. */
export function dayStartMs(date, offsetMin = 0) {
  const t = Date.parse(`${date}T00:00:00.000Z`);
  return Number.isNaN(t) ? NaN : t - offsetMin * 60_000;
}

/** Shift a date key by whole days (used for "yesterday's close"). */
export function shiftDay(date, days = 1, offsetMin = 0) {
  const start = dayStartMs(date, offsetMin);
  if (Number.isNaN(start)) return date;
  return dayKey(start + days * DAY_MS, offsetMin);
}

/** OHLC over a list of numeric values; null when there is nothing usable. */
export function ohlcOf(values) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (!nums.length) return null;
  return {
    open: nums[0],
    high: Math.max(...nums),
    low: Math.min(...nums),
    close: nums[nums.length - 1],
    count: nums.length,
  };
}

/**
 * Collapse one day of points into a snapshot row.
 * @param {Array<{t:number,bid:number|null,ask:number|null,mid:number|null,sim?:boolean,asOf?:string|null}>} points ascending
 */
export function dailySnapshot(points, { date, pair = null, offsetMin = 0 } = {}) {
  if (!Array.isArray(points) || !points.length) return null;
  const day = date || dayKey(points[0].t, offsetMin);
  const perField = {};
  for (const field of FIELDS) {
    perField[field] = ohlcOf(points.map((p) => valueOf(p, field)));
  }
  const reference = perField.mid || perField.bid || perField.ask;
  const first = points[0];
  const last = points[points.length - 1];
  const open = reference?.open ?? null;
  const close = reference?.close ?? null;
  const spreadClose = perField.spread ? perField.spread.close : null;
  return {
    pair,
    date: day,
    tz: tzLabel(offsetMin),
    t: last.t,
    firstAt: new Date(first.t).toISOString(),
    lastAt: new Date(last.t).toISOString(),
    samples: points.length,
    open,
    high: reference?.high ?? null,
    low: reference?.low ?? null,
    close,
    spreadClose,
    change: open !== null && close !== null ? round6(close - open) : null,
    changePct: open ? round6(((close - open) / open) * 100) : null,
    mid: perField.mid,
    bid: perField.bid,
    ask: perField.ask,
    spread: perField.spread,
    sourceAsOf: last.asOf || first.asOf || null,
    simulated: points.some((p) => p.sim),
  };
}

/**
 * Group a point series into daily snapshot rows (ascending by date).
 * Points are bucketed by their local calendar day; empty days are not invented.
 */
export function dailySnapshots(points, { pair = null, offsetMin = 0, since = 0, until = Infinity } = {}) {
  if (!Array.isArray(points) || !points.length) return [];
  const buckets = new Map();
  for (const p of points) {
    if (!p || !Number.isFinite(p.t)) continue;
    if (p.t < since || p.t > until) continue;
    const key = dayKey(p.t, offsetMin);
    const arr = buckets.get(key);
    if (arr) arr.push(p);
    else buckets.set(key, [p]);
  }
  return [...buckets.keys()]
    .sort()
    .map((key) => dailySnapshot(buckets.get(key), { date: key, pair, offsetMin }))
    .filter(Boolean);
}

/**
 * Upsert snapshot rows by (pair, date). The row that saw the most recent sample
 * wins, so a recomputation from a longer log always beats a stale persisted row
 * while days that only exist in the persisted file survive.
 */
export function mergeDailyRows(...rowSets) {
  const byKey = new Map();
  for (const rows of rowSets) {
    for (const row of rows || []) {
      if (!row?.date) continue;
      const key = `${row.pair || ''}|${row.date}`;
      const prev = byKey.get(key);
      if (!prev) {
        byKey.set(key, row);
        continue;
      }
      const prevLast = Date.parse(prev.lastAt || 0) || 0;
      const nextLast = Date.parse(row.lastAt || 0) || 0;
      if (nextLast >= prevLast) byKey.set(key, row);
    }
  }
  return [...byKey.values()].sort((a, b) => (a.date === b.date ? String(a.pair).localeCompare(String(b.pair)) : a.date.localeCompare(b.date)));
}

/**
 * Chart-ready points from daily rows. The shape matches `aggregate()` output so
 * the existing canvas chart (line + min/max band) renders it unchanged:
 * `v` is the day's close, `open/min/max` drive the band and the tooltip.
 */
export function dailyToPoints(rows, field = 'mid') {
  return (rows || [])
    .map((row) => {
      const src = field === 'spread' ? row.spread : row[field] || row.mid;
      const v = src ? src.close : row.close;
      if (v === null || v === undefined) return null;
      return {
        t: row.t,
        date: row.date,
        v,
        open: src ? src.open : row.open,
        min: src ? src.low : row.low,
        max: src ? src.high : row.high,
        count: row.samples ?? (src ? src.count : 1),
        sim: Boolean(row.simulated),
        // Day closes for every field, so `valueOf()`/`summarize()` keep working
        // on daily points exactly as they do on raw samples.
        mid: row.mid?.close ?? row.close ?? null,
        bid: row.bid?.close ?? null,
        ask: row.ask?.close ?? null,
      };
    })
    .filter(Boolean);
}

const DAILY_HEADER =
  'date,pair,tz,open,high,low,close,mid_open,mid_high,mid_low,mid_close,bid_close,ask_close,spread_close,change,change_pct,samples,first_at,last_at,source_as_of,simulated';

function csvValue(v) {
  if (v === null || v === undefined || v === '') return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Daily snapshots as CSV (one line per day) — spreadsheet/Grafana friendly. */
export function dailyCsv(rows) {
  const lines = (rows || []).map((r) =>
    [
      r.date,
      r.pair ?? '',
      r.tz ?? '',
      r.open,
      r.high,
      r.low,
      r.close,
      r.mid?.open,
      r.mid?.high,
      r.mid?.low,
      r.mid?.close,
      r.bid?.close,
      r.ask?.close,
      r.spreadClose,
      r.change,
      r.changePct,
      r.samples,
      r.firstAt ?? '',
      r.lastAt ?? '',
      r.sourceAsOf ?? '',
      r.simulated ? 'true' : 'false',
    ]
      .map(csvValue)
      .join(',')
  );
  return [DAILY_HEADER, ...lines].join('\n') + (lines.length ? '\n' : '');
}

export { DAILY_HEADER };

function round6(v) {
  return typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(6)) : null;
}
