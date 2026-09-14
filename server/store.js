/**
 * Append-only storage for scraped observations.
 *
 * Layout (all inside DATA_DIR, default ./data):
 *   observations.jsonl  one JSON object per successful scrape (append-only log)
 *   latest.json         the most recent observation (fast cold start / debugging)
 *   meta.json           scraper health: last attempt, last success, errors...
 *
 * A JSONL log keeps the project dependency-free (no database to install), is
 * trivially auditable with `tail -f`, converts straight to CSV, and survives
 * crashes because writes are appended. An in-memory index is built at boot so
 * the API can answer chart/history queries without re-reading the file.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

import { config, logger } from './config.js';
import { dailyCsv, dailySnapshots, mergeDailyRows, DEFAULT_TZ_OFFSET_MIN } from './daily.js';

const TAIL_KEEP = 1000; // full observations kept in memory for the table view

export class Store {
  constructor({
    dataDir = config.dataDir,
    maxObservations = config.maxObservations,
    retentionDays = config.retentionDays,
    minStoreIntervalSec = config.minStoreIntervalSec,
    dailyTzOffsetMin = config.dailyTzOffsetMin,
    readonly = false,
  } = {}) {
    this.dataDir = dataDir;
    this.logFile = path.join(dataDir, 'observations.jsonl');
    this.latestFile = path.join(dataDir, 'latest.json');
    this.metaFile = path.join(dataDir, 'meta.json');
    this.dailyFile = path.join(dataDir, 'daily.jsonl');
    this.maxObservations = maxObservations;
    this.retentionDays = retentionDays;
    this.minStoreIntervalSec = minStoreIntervalSec;
    this.dailyTzOffsetMin = dailyTzOffsetMin ?? DEFAULT_TZ_OFFSET_MIN;
    /** Read-only stores (serverless) index in memory but never touch the disk. */
    this.readonly = Boolean(readonly);

    /** @type {Map<string, Array<{t:number,bid:number|null,ask:number|null,mid:number|null,sim:boolean,name:string}>>} */
    this.points = new Map();
    /** @type {Array<object>} */
    this.tail = [];
    /** @type {Map<string, object>} `${pair}|${date}` -> daily snapshot row */
    this.daily = new Map();
    this.count = 0;
    this.firstAt = null;
    this.lastAt = null;
    this.lastReal = null; // most recent non-simulated observation
    this.meta = {
      startedAt: new Date().toISOString(),
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastSimulatedAt: null,
      lastError: null,
      consecutiveFailures: 0,
      totalAttempts: 0,
      totalSuccesses: 0,
      totalSimulated: 0,
      lastSource: null,
      lastStrategy: null,
      lastSourceAsOf: null,
      lastDailySnapshot: null,
    };
    this._writeChain = Promise.resolve();
  }

  async init() {
    if (!this.readonly) {
      try {
        await fsp.mkdir(this.dataDir, { recursive: true });
      } catch (err) {
        logger.warn('data dir is not writable — switching to read-only store', {
          dataDir: this.dataDir,
          error: err.message,
        });
        this.readonly = true;
      }
    }
    await this._loadMeta();
    await this._loadLog();
    await this._loadDaily();
    logger.info('store ready', {
      dataDir: this.dataDir,
      observations: this.count,
      pairs: this.points.size,
      dailySnapshots: this.daily.size,
      readonly: this.readonly,
      firstAt: this.firstAt,
      lastAt: this.lastAt,
    });
    return this;
  }

  // --- loading ---------------------------------------------------------------

  async _loadMeta() {
    try {
      const raw = await fsp.readFile(this.metaFile, 'utf8');
      this.meta = { ...this.meta, ...JSON.parse(raw) };
    } catch {
      /* first run */
    }
  }

  async _loadLog() {
    if (!fs.existsSync(this.logFile)) return;
    const stream = fs.createReadStream(this.logFile, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let bad = 0;
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        this._index(JSON.parse(line));
      } catch {
        bad += 1;
      }
    }
    if (bad) logger.warn('skipped malformed observation lines', { count: bad });
    this._sortIndex();
  }

  /**
   * Load persisted daily snapshots (`data/daily.jsonl`, one row per day/pair).
   * On a serverless host this file — not the observation log — is what makes a
   * multi-month graph possible.
   */
  async _loadDaily() {
    let raw = '';
    try {
      raw = await fsp.readFile(this.dailyFile, 'utf8');
    } catch {
      return; // optional file
    }
    let bad = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (!row?.date) continue;
        this.daily.set(`${row.pair || ''}|${row.date}`, row);
      } catch {
        bad += 1;
      }
    }
    if (bad) logger.warn('skipped malformed daily snapshot lines', { count: bad });
  }

  /**
   * Index observations without writing anything (serverless cold start, or a
   * caller that already persisted the rows elsewhere).
   */
  hydrate(observations) {
    if (!Array.isArray(observations) || !observations.length) return { observations: 0 };
    for (const obs of observations) this._index(obs);
    this._sortIndex();
    return { observations: observations.length };
  }

  /** Index daily snapshot rows in memory (used by the serverless bootstrap). */
  hydrateDaily(rows) {
    if (!Array.isArray(rows) || !rows.length) return { rows: 0 };
    for (const row of rows) {
      if (!row?.date) continue;
      this.daily.set(`${row.pair || ''}|${row.date}`, row);
    }
    return { rows: rows.length };
  }

  /**
   * Keep the in-memory index chronological. Appends are normally in time order,
   * but a demo backfill inserts older rows after newer ones.
   */
  _sortIndex() {
    for (const arr of this.points.values()) arr.sort((a, b) => a.t - b.t);
    this.tail.sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
    const newestReal = [...this.tail].reverse().find((o) => !o.simulated);
    if (newestReal) this.lastReal = newestReal;
    const last = this.tail.at(-1);
    if (last) this.lastAt = Date.parse(last.capturedAt);
    const first = this.tail[0];
    if (first && (!this.firstAt || Date.parse(first.capturedAt) < this.firstAt)) this.firstAt = Date.parse(first.capturedAt);
  }

  _index(obs) {
    if (!obs || !Array.isArray(obs.quotes) || !obs.capturedAt) return;
    const t = Date.parse(obs.capturedAt);
    if (Number.isNaN(t)) return;
    this.count += 1;
    if (!this.firstAt || t < this.firstAt) this.firstAt = t;
    if (!this.lastAt || t > this.lastAt) this.lastAt = t;
    if (!obs.simulated) this.lastReal = obs;

    for (const q of obs.quotes) {
      if (!q?.pair) continue;
      const arr = this.points.get(q.pair) || [];
      arr.push({
        t,
        bid: num(q.bid),
        ask: num(q.ask),
        mid: num(q.mid),
        sim: Boolean(obs.simulated),
        name: q.name || q.pair,
        asOf: obs.sourceAsOf || null,
      });
      this.points.set(q.pair, arr);
    }

    this.tail.push(obs);
    if (this.tail.length > TAIL_KEEP) this.tail.splice(0, this.tail.length - TAIL_KEEP);
  }

  // --- writing ---------------------------------------------------------------

  _enqueue(task) {
    const run = this._writeChain.then(task, task);
    this._writeChain = run.catch(() => {});
    return run;
  }

  /**
   * Persist an observation.
   * @returns {Promise<{stored:boolean, reason:string}>}
   */
  async append(obs, { force = false } = {}) {
    if (!obs) return { stored: false, reason: 'no observation' };
    return this._enqueue(async () => {
      const t = Date.parse(obs.capturedAt);
      const lastPoint = this.points.get(config.primaryPair)?.at(-1);
      const unchanged =
        lastPoint &&
        lastPoint.bid === obs.primary?.bid &&
        lastPoint.ask === obs.primary?.ask &&
        Boolean(obs.simulated) === lastPoint.sim;
      const tooSoon = lastPoint && t - lastPoint.t < this.minStoreIntervalSec * 1000;

      if (unchanged && tooSoon && !force) {
        return { stored: false, reason: 'unchanged within min store interval' };
      }

      if (this.readonly) {
        // Serverless: the filesystem is read-only, so the reading is kept in
        // memory for the rest of this instance's life and reported as unpersisted.
        this._index(obs);
        this.meta.lastSuccessAt = obs.capturedAt;
        this.meta.lastSource = obs.sourceUrl;
        this.meta.lastStrategy = obs.strategy;
        this.meta.lastSourceAsOf = obs.sourceAsOf;
        return { stored: false, reason: 'read-only store (serverless filesystem)' };
      }

      await fsp.appendFile(this.logFile, `${JSON.stringify(obs)}\n`, 'utf8');
      this._index(obs);
      await this._writeJson(this.latestFile, obs);
      this.meta.lastSuccessAt = obs.capturedAt;
      this.meta.lastSource = obs.sourceUrl;
      this.meta.lastStrategy = obs.strategy;
      this.meta.lastSourceAsOf = obs.sourceAsOf;
      this.meta.consecutiveFailures = 0;
      this.meta.totalSuccesses = (this.meta.totalSuccesses || 0) + 1;
      if (obs.simulated) {
        this.meta.lastSimulatedAt = obs.capturedAt;
        this.meta.totalSimulated = (this.meta.totalSimulated || 0) + 1;
      }
      await this._writeJson(this.metaFile, this.meta);
      await this._maybePrune();
      return { stored: true, reason: unchanged ? 'stored (unchanged, forced)' : 'stored' };
    });
  }

  /**
   * Append many observations in one go (used by the demo backfill). Writes the
   * log once and refreshes latest.json/meta.json a single time.
   */
  async bulkAppend(observations) {
    if (!Array.isArray(observations) || !observations.length) return { stored: 0 };
    if (this.readonly) return { stored: 0, reason: 'read-only store (serverless filesystem)' };
    return this._enqueue(async () => {
      const payload = observations.map((o) => `${JSON.stringify(o)}`).join('\n') + '\n';
      await fsp.appendFile(this.logFile, payload, 'utf8');
      for (const obs of observations) this._index(obs);
      this._sortIndex();
      const last = this.tail.at(-1) || observations[observations.length - 1];
      const lastNew = observations[observations.length - 1];
      await this._writeJson(this.latestFile, last);
      this.meta.lastSuccessAt = last.capturedAt;
      this.meta.lastSource = last.sourceUrl;
      this.meta.lastStrategy = last.strategy;
      this.meta.lastSourceAsOf = last.sourceAsOf;
      this.meta.totalSuccesses = (this.meta.totalSuccesses || 0) + observations.length;
      if (lastNew.simulated) {
        this.meta.lastSimulatedAt = lastNew.capturedAt;
        this.meta.totalSimulated = (this.meta.totalSimulated || 0) + observations.length;
      }
      await this._writeJson(this.metaFile, this.meta);
      logger.info('bulk append complete', { observations: observations.length, total: this.count });
      return { stored: observations.length };
    });
  }

  async recordAttempt({ ok, error, simulated = false }) {
    return this._enqueue(async () => {
      this.meta.lastAttemptAt = new Date().toISOString();
      this.meta.totalAttempts = (this.meta.totalAttempts || 0) + 1;
      if (!ok) {
        this.meta.consecutiveFailures = (this.meta.consecutiveFailures || 0) + 1;
        this.meta.lastError = error || 'unknown error';
      } else {
        this.meta.consecutiveFailures = 0;
        this.meta.lastError = simulated ? `simulated: ${error || 'source unreachable'}` : null;
      }
      await this._writeJson(this.metaFile, this.meta);
      return this.meta;
    });
  }

  async _writeJson(file, value) {
    if (this.readonly) return;
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await fsp.rename(tmp, file);
  }

  /** Rewrite the log when it grows past the configured bounds. */
  async _maybePrune() {
    if (this.readonly) return;
    const tooMany = this.maxObservations > 0 && this.count > this.maxObservations;
    const cutoff = this.retentionDays > 0 ? Date.now() - this.retentionDays * 86_400_000 : 0;
    const tooOld = cutoff > 0 && this.firstAt && this.firstAt < cutoff;
    if (!tooMany && !tooOld) return;

    logger.info('pruning observation log', { count: this.count, tooMany, tooOld });
    const keepFrom = tooMany ? this._cutoffForCount(this.maxObservations) : cutoff;
    const tmpFile = `${this.logFile}.prune`;
    const out = fs.createWriteStream(tmpFile, { encoding: 'utf8' });
    const stream = fs.createReadStream(this.logFile, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let kept = 0;
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const obs = JSON.parse(line);
        const t = Date.parse(obs.capturedAt);
        if (Number.isNaN(t) || t < keepFrom) continue;
        out.write(`${line}\n`);
        kept += 1;
      } catch {
        /* drop malformed */
      }
    }
    await new Promise((resolve) => out.end(resolve));
    await fsp.rename(tmpFile, this.logFile);

    // Rebuild the in-memory index from the pruned file.
    this.points = new Map();
    this.tail = [];
    this.count = 0;
    this.firstAt = null;
    this.lastAt = null;
    await this._loadLog();
    logger.info('pruned observation log', { kept });
  }

  _cutoffForCount(max) {
    const arr = this.points.get(config.primaryPair) || [];
    if (arr.length <= max) return 0;
    return arr[arr.length - max].t;
  }

  // --- queries ---------------------------------------------------------------

  pairs() {
    return [...this.points.entries()]
      .map(([pair, arr]) => ({ pair, count: arr.length, last: arr.at(-1) }))
      .sort((a, b) => (a.pair === config.primaryPair ? -1 : b.pair === config.primaryPair ? 1 : a.pair.localeCompare(b.pair)));
  }

  has(pair) {
    return this.points.has(pair);
  }

  latest() {
    return this.tail.at(-1) || null;
  }

  latestFor(pair = config.primaryPair) {
    const arr = this.points.get(pair);
    return arr?.length ? arr.at(-1) : null;
  }

  latestQuotes() {
    const obs = this.latest();
    return obs?.quotes || [];
  }

  /**
   * Raw point series for a pair.
   * @param {object} o
   * @param {string} o.pair
   * @param {number} [o.since]  epoch ms lower bound
   * @param {number} [o.until]  epoch ms upper bound
   * @param {number} [o.limit]  max points returned (newest)
   */
  series({ pair = config.primaryPair, since = 0, until = Infinity, limit = 0 } = {}) {
    const arr = this.points.get(pair);
    if (!arr) return [];
    let out = arr;
    if (since || until !== Infinity) out = out.filter((p) => p.t >= since && p.t <= until);
    if (limit > 0 && out.length > limit) out = out.slice(-limit);
    return out;
  }

  recentObservations({ limit = 50, offset = 0 } = {}) {
    const arr = this.tail.slice().reverse();
    return arr.slice(offset, offset + limit);
  }

  stats() {
    return {
      observations: this.count,
      pairs: this.points.size,
      firstAt: this.firstAt ? new Date(this.firstAt).toISOString() : null,
      lastAt: this.lastAt ? new Date(this.lastAt).toISOString() : null,
      logBytes: fs.existsSync(this.logFile) ? fs.statSync(this.logFile).size : 0,
      dailySnapshots: this.daily.size,
      dailyTz: this.dailyTzOffsetMin,
      readonly: this.readonly,
    };
  }

  // --- daily snapshots -------------------------------------------------------

  /**
   * Daily snapshot rows for a pair: persisted rows (which survive log pruning
   * and are all a serverless host has) merged with rows recomputed from the
   * observation log. Recomputed rows win for the days they cover because they
   * are derived from the full-resolution samples.
   */
  dailyRows({ pair = config.primaryPair, since = 0, until = Infinity } = {}) {
    const persisted = [];
    for (const row of this.daily.values()) {
      if (row.pair !== pair) continue;
      const t = Date.parse(row.lastAt || 0);
      if (Number.isFinite(t) && (t < since || t > until)) continue;
      persisted.push(row);
    }
    const derived = dailySnapshots(this.series({ pair, since, until }), {
      pair,
      offsetMin: this.dailyTzOffsetMin,
    });
    return mergeDailyRows(persisted, derived);
  }

  /** Daily snapshot rows as CSV. */
  dailyCsv({ pair = config.primaryPair, since = 0, until = Infinity } = {}) {
    return dailyCsv(this.dailyRows({ pair, since, until }));
  }

  /**
   * Recompute the most recent daily snapshots from the observation log and keep
   * `data/daily.jsonl` in sync (rewritten only when the content actually
   * changed). Returns the rows for the affected days.
   */
  async updateDailySnapshots({ pairs = null, days = 2, now = Date.now() } = {}) {
    const targets = (pairs || this.dailyPairs()).filter((p) => this.points.has(p));
    if (!targets.length) return { updated: [], written: false };

    const sinceMs = now - days * 86_400_000 - 6 * 60 * 60_000; // overlap the tz boundary
    const touched = [];
    for (const pair of targets) {
      for (const row of dailySnapshots(this.series({ pair, since: sinceMs }), {
        pair,
        offsetMin: this.dailyTzOffsetMin,
      })) {
        this.daily.set(`${pair}|${row.date}`, row);
        touched.push(row);
      }
    }
    if (!touched.length) return { updated: [], written: false };

    const written = await this.writeDailyFile();
    this.meta.lastDailySnapshot = touched.at(-1)?.date || null;
    if (!this.readonly) await this._writeJson(this.metaFile, this.meta);
    return { updated: touched, written };
  }

  /** Pairs whose daily snapshots are persisted (`DAILY_SNAPSHOT_PAIRS`). */
  dailyPairs() {
    const configured = config.dailyPairs;
    if (!configured || !configured.length || configured.includes('*')) return this.pairs().map((p) => p.pair);
    return configured.map((p) => p.toUpperCase());
  }

  /** Serialize + write `data/daily.jsonl`; no-op when nothing changed. */
  async writeDailyFile() {
    if (this.readonly) return false;
    const cutoff = config.dailyRetentionDays > 0 ? new Date(Date.now() - config.dailyRetentionDays * 86_400_000).toISOString().slice(0, 10) : null;
    const rows = [...this.daily.values()]
      .filter((r) => !cutoff || r.date >= cutoff)
      .sort((a, b) => (a.date === b.date ? String(a.pair).localeCompare(String(b.pair)) : a.date.localeCompare(b.date)));
    const payload = rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
    let current = null;
    try {
      current = await fsp.readFile(this.dailyFile, 'utf8');
    } catch {
      current = null;
    }
    if (current === payload) return false;
    const tmp = `${this.dailyFile}.tmp`;
    await fsp.writeFile(tmp, payload, 'utf8');
    await fsp.rename(tmp, this.dailyFile);
    return true;
  }

  /** CSV export of the raw log (optionally filtered by pair/time window). */
  csv({ pair = config.primaryPair, since = 0, until = Infinity } = {}) {
    const rows = this.series({ pair, since, until });
    const header = 'captured_at,epoch_ms,pair,bid,ask,mid,spread,source_as_of,simulated';
    const lines = rows.map((p) => {
      const spread = p.bid !== null && p.ask !== null ? Number((p.ask - p.bid).toFixed(6)) : '';
      return [
        new Date(p.t).toISOString(),
        p.t,
        pair,
        p.bid ?? '',
        p.ask ?? '',
        p.mid ?? '',
        spread,
        p.asOf ?? '',
        p.sim ? 'true' : 'false',
      ].join(',');
    });
    return [header, ...lines].join('\n') + (lines.length ? '\n' : '');
  }

  /** Seed the log from a committed snapshot on first boot. */
  async seedFromFile(file = config.seedFile) {
    if (!config.useSeed) return { seeded: false, reason: 'USE_SEED=false' };
    if (this.count > 0) return { seeded: false, reason: 'store already has data' };
    if (!fs.existsSync(file)) return { seeded: false, reason: 'seed file missing' };
    try {
      const snapshot = JSON.parse(await fsp.readFile(file, 'utf8'));
      const obs = {
        id: `seed-${snapshot.capturedAt || new Date().toISOString()}`,
        capturedAt: snapshot.capturedAt || new Date().toISOString(),
        sourceUrl: snapshot.sourceUrl || config.sourceUrl,
        sourceLabel: snapshot.sourceLabel || 'seed-snapshot',
        strategy: snapshot.strategy || 'seed',
        format: snapshot.format || 'seed',
        sourceAsOf: snapshot.sourceAsOf || null,
        simulated: false,
        seed: true,
        note: snapshot.note || 'Bootstrap snapshot captured from the source page.',
        quotes: snapshot.quotes || [],
        primary:
          (snapshot.quotes || []).find((q) => q.pair === config.primaryPair) || null,
      };
      if (!obs.quotes.length) return { seeded: false, reason: 'seed file has no quotes' };
      if (!this.readonly) await fsp.appendFile(this.logFile, `${JSON.stringify(obs)}\n`, 'utf8');
      this._index(obs);
      await this._writeJson(this.latestFile, obs);
      await this._writeJson(this.metaFile, this.meta);
      logger.info('seeded store from snapshot', { pairs: obs.quotes.length, capturedAt: obs.capturedAt });
      return { seeded: true, pairs: obs.quotes.length };
    } catch (err) {
      logger.warn('seed failed', { error: err.message });
      return { seeded: false, reason: err.message };
    }
  }
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export const store = new Store();
