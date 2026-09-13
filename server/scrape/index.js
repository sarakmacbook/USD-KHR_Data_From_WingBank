/**
 * Scrape orchestration: fetch -> parse -> validate -> normalize into an
 * `Observation` that the store can persist.
 */
import crypto from 'node:crypto';

import { config, logger } from '../config.js';
import { buildSourcePlan, fetchSource } from './fetchers.js';
import { parseRatePayload, CURRENCY_NAMES } from './parse.js';
import { simulateObservation } from './simulate.js';

const MAX_SOURCES_TRIED = 5;

/** Keep only pairs that plausibly are currency pairs (kills token-scan noise). */
export function filterQuotes(quotes, { primaryPair = config.primaryPair } = {}) {
  return quotes.filter((q) => {
    if (q.pair === primaryPair) return true;
    const known = Boolean(CURRENCY_NAMES[q.base]) && Boolean(CURRENCY_NAMES[q.quote]);
    return known && q.mid !== null && q.mid > 0;
  });
}

export function fingerprint(quotes) {
  const payload = quotes
    .map((q) => `${q.pair}:${q.bid ?? ''}/${q.ask ?? ''}/${q.mid ?? ''}`)
    .sort()
    .join('|');
  return crypto.createHash('sha1').update(payload).digest('hex').slice(0, 16);
}

function buildObservation({ quotes, sourceUrl, sourceLabel, strategy, format, sourceAsOf, simulated = false, warnings = [], capturedAt = new Date() }) {
  const primary = quotes.find((q) => q.pair === config.primaryPair) || null;
  return {
    id: `${capturedAt.toISOString()}-${fingerprint(quotes)}`,
    capturedAt: capturedAt.toISOString(),
    sourceUrl,
    sourceLabel,
    strategy,
    format,
    sourceAsOf,
    simulated,
    fingerprint: fingerprint(quotes),
    quotes,
    primary: primary
      ? { pair: primary.pair, bid: primary.bid, ask: primary.ask, mid: primary.mid, name: primary.name }
      : null,
    ...(warnings.length ? { warnings } : {}),
  };
}

/**
 * Run one scrape cycle.
 * @returns {Promise<{ok:boolean, observation:object|null, simulated:boolean, attempts:Array, warnings:string[], error:string|null}>}
 */
export async function scrapeOnce({ previousQuotes = [], force = false } = {}) {
  const plan = buildSourcePlan().slice(0, MAX_SOURCES_TRIED);
  const attempts = [];
  const warnings = [];

  for (const source of plan) {
    // Retry the bank itself once (transient blips are common); mirrors are a
    // last resort, so a single attempt each keeps the worst-case cycle bounded.
    const fetched = await fetchSource(source, { retries: source.kind === 'page' ? 1 : 0 });
    const attempt = {
      label: source.label,
      kind: source.kind,
      url: source.url,
      status: fetched.status,
      ms: fetched.ms,
      bytes: fetched.bytes,
      error: fetched.error,
      pairs: 0,
      primary: null,
    };

    if (fetched.ok && fetched.text) {
      const parsed = parseRatePayload(fetched.text, { sourceLabel: source.label });
      const quotes = filterQuotes(parsed.quotes);
      attempt.pairs = quotes.length;
      attempt.strategy = parsed.strategy;
      attempt.format = parsed.format;
      attempt.primary = quotes.find((q) => q.pair === config.primaryPair) || null;
      if (parsed.warnings?.length) warnings.push(...parsed.warnings.map((w) => `${source.label}: ${w}`));
      attempts.push(attempt);

      if (attempt.primary && attempt.primary.mid !== null) {
        const observation = buildObservation({
          quotes,
          sourceUrl: source.url,
          sourceLabel: source.label,
          strategy: parsed.strategy,
          format: parsed.format,
          sourceAsOf: parsed.sourceAsOf,
          warnings: parsed.warnings || [],
        });
        logger.info('scrape ok', {
          source: source.label,
          strategy: parsed.strategy,
          pairs: quotes.length,
          primary: observation.primary,
          sourceAsOf: parsed.sourceAsOf,
          ms: fetched.ms,
        });
        return { ok: true, observation, simulated: false, attempts, warnings, error: null, force };
      }
      if (quotes.length) {
        warnings.push(`${source.label}: fetched ${quotes.length} pair(s) but ${config.primaryPair} was missing`);
      } else {
        warnings.push(`${source.label}: no rates recognized (format=${parsed.format})`);
      }
    } else {
      attempts.push(attempt);
    }
  }

  const error = attempts.map((a) => `${a.label}: ${a.error || 'no primary pair'}`).join(' | ') || 'no sources configured';

  if (config.allowSimulation && config.simulateOnFailure) {
    const { quotes } = simulateObservation({ previousQuotes, reason: 'source unreachable' });
    if (quotes.length) {
      const observation = buildObservation({
        quotes,
        sourceUrl: `simulated (last real source unavailable)`,
        sourceLabel: 'simulator',
        strategy: 'random-walk',
        format: 'simulated',
        sourceAsOf: null,
        simulated: true,
        warnings: [`SIMULATED DATA — ${error}`],
      });
      logger.warn('using simulated rates because every source failed', { error });
      // ok: the tracker produced a usable reading. degraded: it is synthetic, so
      // monitoring should still treat the real source as down.
      return { ok: true, degraded: true, observation, simulated: true, attempts, warnings: observation.warnings, error, force };
    }
  }

  logger.error('scrape failed', { error, attempts: attempts.map((a) => ({ label: a.label, error: a.error, status: a.status })) });
  return { ok: false, observation: null, simulated: false, attempts, warnings, error, force };
}
