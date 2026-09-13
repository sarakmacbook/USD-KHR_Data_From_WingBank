/**
 * Simulation fallback — DEVELOPMENT / DEMO ONLY.
 *
 * When the host cannot reach wingbank.com.kh (air-gapped CI, a sandbox without
 * egress, a laptop on a plane) the dashboard would otherwise be empty and
 * impossible to evaluate. With ALLOW_SIMULATION=true the tracker can generate a
 * bounded random walk around the last real value so every feature (chart,
 * converter, alerts, CSV export) can be exercised.
 *
 * Simulated rows are never silent:
 *   - every quote and observation carries `simulated: true`
 *   - the API returns `simulated: true` and the UI shows a persistent banner
 */
import { config } from '../config.js';

/** Deterministic PRNG so a replayed timestamp yields the same series. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function round(value, step) {
  const decimals = step < 1 ? 4 : step < 100 ? 2 : 0;
  const rounded = Number(value.toFixed(decimals));
  return step && step >= 1 ? Math.round(rounded / step) * step : rounded;
}

/** Tick size per pair so simulated numbers look like the real page. */
function tickFor(pair) {
  const quote = pair.split('/')[1] || '';
  if (quote === 'KHR') return 1;
  if (['VND', 'IDR', 'KRW'].includes(quote)) return 0.01;
  return 0.0001;
}

/**
 * @param {object} opts
 * @param {Array}  opts.previousQuotes  last known real (or simulated) quotes
 * @param {Date|number} opts.now
 * @param {string} opts.reason why simulation kicked in
 */
export function simulateObservation({ previousQuotes = [], now = Date.now(), reason = 'source unreachable' } = {}) {
  const ts = typeof now === 'number' ? now : now.getTime();
  const rand = mulberry32(Math.floor(ts / 1000));
  const previous = new Map(previousQuotes.map((q) => [q.pair, q]));

  const pairs = previous.size
    ? [...previous.keys()]
    : [config.primaryPair];

  const quotes = pairs.map((pair) => {
    const prev = previous.get(pair);
    const prevMid = prev?.mid ?? (pair === config.primaryPair ? config.simulateSeedValue : null);
    if (prevMid === null) return null;

    const tick = tickFor(pair);
    const drift = (rand() - 0.5) * 2 * (config.simulateVolatilityPct / 100);
    // Mean-reverting random walk: keeps the series believable over long runs.
    const anchor = prev?.simulatedAnchor ?? prevMid;
    const pull = (anchor - prevMid) / anchor;
    const mid = round(Math.max(tick, prevMid * (1 + drift + pull * 0.15)), tick);
    const halfSpread = round(Math.max(tick, mid * 0.0012), tick);

    return {
      pair,
      base: pair.split('/')[0],
      quote: pair.split('/')[1],
      name: prev?.name || pair.split('/')[1],
      bid: round(mid - halfSpread, tick),
      ask: round(mid + halfSpread, tick),
      mid,
      spread: round(halfSpread * 2, tick),
      spreadPct: mid ? (halfSpread * 2) / (mid - halfSpread) * 100 : null,
      source: `simulated:${reason}`,
      simulated: true,
      simulatedAnchor: anchor,
    };
  }).filter(Boolean);

  return { quotes, rand };
}

/**
 * Build a synthetic history so the dashboard is not empty on a fresh install
 * that cannot reach the source (SIMULATE_BACKFILL_DAYS > 0).
 *
 * The walk is mean-reverting around the real seed snapshot, so the series hovers
 * around the last published rate instead of inventing a trend. Every row is
 * flagged `simulated: true` / `backfill: true`.
 *
 * @param {object} o
 * @param {Array}  o.seedQuotes   real quotes to anchor the walk
 * @param {number} o.days         how far back to generate
 * @param {number} o.intervalMin  minutes between generated samples
 * @param {number} [o.now]        end timestamp (exclusive of "now")
 * @param {object} [o.meta]       source metadata copied onto each observation
 */
export function buildBackfill({ seedQuotes = [], days = 30, intervalMin = 30, now = Date.now(), meta = {} }) {
  const stepMs = Math.max(1, intervalMin) * 60_000;
  const steps = Math.min(20_000, Math.floor((days * 86_400_000) / stepMs));
  if (!seedQuotes.length || steps <= 0) return [];

  const rand = mulberry32(0x5eed + steps);
  const anchors = seedQuotes
    .filter((q) => q && Number.isFinite(q.mid) && q.mid > 0)
    .map((q) => ({
      ...q,
      anchor: q.mid,
      spreadPct: Number.isFinite(q.spreadPct) && q.spreadPct > 0 ? q.spreadPct / 100 : 0.0024,
      tick: tickFor(q.pair),
      value: q.mid * (1 + (rand() - 0.5) * 0.004),
    }));
  if (!anchors.length) return [];

  const startTs = now - steps * stepMs;
  const volatility = config.simulateVolatilityPct / 100;
  const observations = [];

  for (let i = 0; i < steps; i += 1) {
    const ts = startTs + i * stepMs;
    const quotes = anchors.map((a) => {
      const drift = (rand() - 0.5) * 2 * volatility * Math.sqrt(intervalMin / 15);
      const pull = ((a.anchor - a.value) / a.anchor) * 0.12;
      a.value = Math.max(a.tick, a.value * (1 + drift + pull));
      const mid = round(a.value, a.tick);
      const half = round(Math.max(a.tick, (mid * a.spreadPct) / 2), a.tick);
      return {
        pair: a.pair,
        base: a.base,
        quote: a.quote,
        name: a.name,
        bid: round(mid - half, a.tick),
        ask: round(mid + half, a.tick),
        mid,
        spread: round(half * 2, a.tick),
        spreadPct: mid - half ? ((half * 2) / (mid - half)) * 100 : null,
        source: 'simulated:backfill',
        simulated: true,
        simulatedAnchor: a.anchor,
      };
    });

    const capturedAt = new Date(ts).toISOString();
    const primary = quotes.find((q) => q.pair === config.primaryPair) || null;
    observations.push({
      id: `${capturedAt}-backfill`,
      capturedAt,
      sourceUrl: meta.sourceUrl || 'simulated (backfill)',
      sourceLabel: 'simulator',
      strategy: 'random-walk-backfill',
      format: 'simulated',
      sourceAsOf: meta.sourceAsOf || null,
      simulated: true,
      backfill: true,
      fingerprint: `backfill-${i}`,
      quotes,
      primary: primary
        ? { pair: primary.pair, bid: primary.bid, ask: primary.ask, mid: primary.mid, name: primary.name }
        : null,
      warnings: ['SIMULATED DATA — generated locally because the source was unreachable'],
    });
  }
  return observations;
}
