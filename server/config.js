/**
 * Central configuration.
 *
 * Everything can be overridden with environment variables so the same code runs
 * unchanged on a laptop, a VPS, Docker or a PaaS. See README.md for the full list.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, '..');

const env = process.env;

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function list(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  // --- HTTP server -----------------------------------------------------------
  host: env.HOST || '0.0.0.0',
  port: num(env.PORT, 3000),

  // --- Storage ---------------------------------------------------------------
  dataDir: path.resolve(env.DATA_DIR || path.join(ROOT_DIR, 'data')),
  maxObservations: num(env.MAX_OBSERVATIONS, 500_000),
  retentionDays: num(env.RETENTION_DAYS, 0), // 0 = keep forever
  minStoreIntervalSec: num(env.MIN_STORE_INTERVAL_SEC, 30),
  /**
   * `auto`  — writable filesystem => read/write; serverless/read-only => read-only.
   * `fs`    — always read/write (fails loudly if the disk is read-only).
   * `readonly` — never write; the dataset is whatever ships with the bundle.
   */
  storeMode: ['auto', 'fs', 'readonly'].includes(String(env.STORE_MODE || 'auto').toLowerCase())
    ? String(env.STORE_MODE || 'auto').toLowerCase()
    : 'auto',

  // --- Daily snapshots -------------------------------------------------------
  /**
   * UTC offset (minutes) used for calendar-day boundaries. 420 = UTC+7,
   * i.e. Asia/Phnom_Penh — Cambodia has no DST, so a fixed offset is exact.
   */
  dailyTzOffsetMin: num(env.DAILY_TZ_OFFSET_MIN, 420),
  /** Pairs persisted to daily.jsonl: `*` = every tracked pair, else a CSV list. */
  dailyPairs: list(env.DAILY_SNAPSHOT_PAIRS || '').length ? list(env.DAILY_SNAPSHOT_PAIRS) : null,
  dailyRetentionDays: num(env.DAILY_RETENTION_DAYS, 0), // 0 = keep forever

  // --- Source ----------------------------------------------------------------
  sourceUrl: env.SOURCE_URL || 'https://www.wingbank.com.kh/en/exchange-rate',
  /**
   * Optional mirrors tried (in order) when the primary URL is unreachable.
   * `{url}` is replaced with the encoded source URL. A reader proxy is handy
   * when the host machine sits behind an egress firewall that blocks the bank.
   */
  fallbackSources: list(env.FALLBACK_SOURCES || 'https://r.jina.ai/{url}'),
  /** Extra endpoints probed first (e.g. a JSON API discovered later). */
  apiEndpoints: list(env.WING_API_ENDPOINTS),
  userAgent:
    env.USER_AGENT ||
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 USD-KHR-Tracker/1.0',
  fetchTimeoutMs: num(env.FETCH_TIMEOUT_MS, 20_000),
  acceptLanguage: env.ACCEPT_LANGUAGE || 'en-US,en;q=0.9',

  // --- Tracking --------------------------------------------------------------
  primaryPair: (env.PRIMARY_PAIR || 'USD/KHR').toUpperCase(),
  pollIntervalMin: num(env.POLL_INTERVAL_MIN, 15),
  maxConsecutiveFailuresBeforeBackoff: num(env.BACKOFF_AFTER, 3),
  backoffCapMin: num(env.BACKOFF_CAP_MIN, 120),
  refreshMinGapSec: num(env.REFRESH_MIN_GAP_SEC, 10),

  // --- Simulation (demo / offline development ONLY) --------------------------
  // Simulated rows are flagged in storage and surfaced in the API + UI so they
  // can never be mistaken for real bank data.
  allowSimulation: bool(env.ALLOW_SIMULATION, false),
  simulateOnFailure: bool(env.SIMULATE_ON_FAILURE, false),
  simulateSeedValue: num(env.SIMULATE_SEED_VALUE, 4054),
  simulateVolatilityPct: num(env.SIMULATE_VOLATILITY_PCT, 0.05),
  /** Generate N days of clearly-flagged synthetic history into an empty store. */
  simulateBackfillDays: num(env.SIMULATE_BACKFILL_DAYS, 0),
  simulateBackfillIntervalMin: num(env.SIMULATE_BACKFILL_INTERVAL_MIN, 60),

  // --- Seed snapshot ---------------------------------------------------------
  seedFile: env.SEED_FILE || path.join(ROOT_DIR, 'server', 'seed-snapshot.json'),
  useSeed: bool(env.USE_SEED, true),

  // --- Serverless deployment (Vercel) ----------------------------------------
  /**
   * Vercel Cron authenticates with `Authorization: Bearer $CRON_SECRET`.
   * Without it the cron route answers only to requests whose User-Agent is
   * `vercel-cron`, and any other caller gets a 401.
   */
  cronSecret: env.CRON_SECRET || '',
  /** Where the serverless cron commits its dataset files (see gitstore.js). */
  git: {
    token: env.GITHUB_DATA_TOKEN || '',
    repo: env.GITHUB_REPO || '',
    branch: env.GITHUB_BRANCH || 'main',
    apiUrl: env.GITHUB_API_URL || 'https://api.github.com',
  },
  /** Files the serverless snapshot job maintains in git. */
  dailyFile: env.DAILY_FILE || 'data/daily.jsonl',
  dailyCsvFile: env.DAILY_CSV_FILE || 'data/usd-khr-daily.csv',

  logLevel: (env.LOG_LEVEL || 'info').toLowerCase(),
  /**
   * Where structured logs go. stderr by default so that CLI output stays
   * pipeable (`node server/cli.js --export > rates.csv`, `--format json | jq`)
   * without log lines corrupting the data. Set LOG_STREAM=stdout for platforms
   * that only collect stdout.
   */
  logStream: String(env.LOG_STREAM || 'stderr').toLowerCase() === 'stdout' ? 'stdout' : 'stderr',
};

export const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

export function log(level, message, meta) {
  if ((LEVELS[level] ?? 2) > (LEVELS[config.logLevel] ?? 2)) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(meta ? { meta } : {}),
  };
  const out = config.logStream === 'stdout' ? console.log : console.error;
  out(JSON.stringify(line));
}

export const logger = {
  error: (m, meta) => log('error', m, meta),
  warn: (m, meta) => log('warn', m, meta),
  info: (m, meta) => log('info', m, meta),
  debug: (m, meta) => log('debug', m, meta),
};
