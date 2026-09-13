/**
 * Polling scheduler with jitter, manual triggering and failure backoff.
 *
 * Backoff matters here: the source is a public bank website, so when it is down
 * we must not hammer it every few seconds. After BACKOFF_AFTER consecutive
 * failures the delay doubles (capped at BACKOFF_CAP_MIN minutes).
 */
import { config, logger } from './config.js';

export function createScheduler({ intervalMin = config.pollIntervalMin, run, name = 'scraper' }) {
  let timer = null;
  let running = false;
  let stopped = false;
  let consecutiveFailures = 0;
  let nextRunAt = null;
  let lastRunAt = null;
  let lastResult = null;
  const startedAt = Date.now();

  function currentDelayMs() {
    const base = Math.max(1, intervalMin) * 60_000;
    if (consecutiveFailures < config.maxConsecutiveFailuresBeforeBackoff) return base;
    const extra = consecutiveFailures - config.maxConsecutiveFailuresBeforeBackoff + 1;
    const capped = Math.min(config.backoffCapMin * 60_000, base * 2 ** extra);
    return capped;
  }

  function jitter(ms) {
    // +/- 5% so multiple deployments do not hit the source in lockstep
    const span = ms * 0.05;
    return Math.round(ms + (Math.random() * 2 - 1) * span);
  }

  async function execute({ manual = false } = {}) {
    if (running) {
      logger.debug(`${name}: run already in progress, skipping`);
      return { skipped: true, reason: 'already running', result: lastResult };
    }
    running = true;
    lastRunAt = Date.now();
    nextRunAt = null;
    try {
      const result = await run({ manual });
      lastResult = result;
      consecutiveFailures = result?.ok ? 0 : consecutiveFailures + 1;
      return result;
    } catch (err) {
      consecutiveFailures += 1;
      lastResult = { ok: false, error: err.message };
      logger.error(`${name}: unhandled error`, { error: err.message, stack: err.stack });
      return lastResult;
    } finally {
      running = false;
      if (!stopped) schedule();
    }
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    const delay = jitter(currentDelayMs());
    nextRunAt = Date.now() + delay;
    timer = setTimeout(() => execute(), delay);
    logger.debug(`${name}: next run scheduled`, { inMs: delay, nextRunAt: new Date(nextRunAt).toISOString() });
  }

  return {
    start() {
      stopped = false;
      logger.info(`${name}: starting`, { intervalMin, firstRunInMs: 1500 });
      timer = setTimeout(() => execute(), 1500);
      nextRunAt = Date.now() + 1500;
      return this;
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      nextRunAt = null;
    },
    /** Manual refresh (rate limited by the caller). */
    triggerNow() {
      return execute({ manual: true });
    },
    state() {
      return {
        intervalMin,
        running,
        consecutiveFailures,
        currentDelayMin: currentDelayMs() / 60_000,
        nextRunAt: nextRunAt ? new Date(nextRunAt).toISOString() : null,
        lastRunAt: lastRunAt ? new Date(lastRunAt).toISOString() : null,
        startedAt: new Date(startedAt).toISOString(),
        lastResult: lastResult
          ? {
              ok: lastResult.ok,
              degraded: Boolean(lastResult.degraded),
              simulated: Boolean(lastResult.simulated),
              error: lastResult.error || null,
            }
          : null,
      };
    },
    get nextRunAt() {
      return nextRunAt;
    },
  };
}
