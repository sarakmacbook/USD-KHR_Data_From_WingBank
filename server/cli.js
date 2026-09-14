/**
 * Command-line scraper — one cycle, then exit. Useful for cron / CI:
 *
 *   node server/cli.js                 # scrape once, print a human summary
 *   node server/cli.js --json          # machine readable result
 *   node server/cli.js --seed-only     # bootstrap an empty store from the snapshot
 *   node server/cli.js --export csv    # dump the stored series as CSV
 *   node server/cli.js --daily         # daily snapshot prices (JSON, or --format csv)
 *   node server/cli.js --loop          # keep polling (same cadence as the server)
 *
 * cron example (every 15 minutes, outside of the web server):
 *   *\/15 * * * * cd /opt/usd-khr-tracker && /usr/bin/node server/cli.js >> data/cron.log 2>&1
 */
import { config, logger } from './config.js';
import { store } from './store.js';
import { scrapeOnce } from './scrape/index.js';
import { createScheduler } from './scheduler.js';

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag, fallback = null) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

async function once() {
  const previousQuotes = store.latestQuotes();
  const result = await scrapeOnce({ previousQuotes, force: true });
  if (result.observation) {
    const { stored, reason } = await store.append(result.observation, { force: true });
    result.stored = stored;
    result.storeReason = reason;
    // Keep data/daily.jsonl current: this is what long-range graphs are built
    // from, and the file a Vercel deployment ships with.
    if (stored) {
      const daily = await store.updateDailySnapshots();
      result.daily = (daily.updated || []).map((d) => d.date);
    }
  }
  await store.recordAttempt({ ok: result.ok, error: result.error, simulated: result.simulated });
  return result;
}

function printHuman(result) {
  const p = result.observation?.primary;
  if (result.ok && p) {
    const flag = result.simulated ? ' [SIMULATED]' : '';
    console.log(
      `${p.pair}  bid ${p.bid}  ask ${p.ask}  mid ${p.mid}${flag}\n` +
        `  source:  ${result.observation.sourceLabel} (${result.observation.strategy})\n` +
        `  as of:   ${result.observation.sourceAsOf || 'unknown'}\n` +
        `  stored:  ${result.stored ? 'yes' : `no (${result.storeReason})`}\n` +
        `  pairs:   ${result.observation.quotes.length}`
    );
  } else {
    console.error(`scrape failed: ${result.error}`);
    for (const a of result.attempts) console.error(`  - ${a.label}: ${a.error || `no primary pair (status ${a.status})`}`);
  }
  if (result.warnings?.length) {
    for (const w of result.warnings) console.error(`  ! ${w}`);
  }
}

async function main() {
  await store.init();

  if (has('--seed-only')) {
    const res = await store.seedFromFile();
    console.log(res.seeded ? `seeded ${res.pairs} pairs` : `not seeded: ${res.reason}`);
    return res.seeded ? 0 : 1;
  }

  // Same bootstrap behaviour as the server: an empty store gets the committed
  // snapshot so exports and dashboards are never blank before the first scrape.
  if (store.count === 0) {
    const seeded = await store.seedFromFile();
    if (seeded.seeded) logger.debug('seeded empty store from snapshot', { pairs: seeded.pairs });
  }

  const format = valueOf('--format', has('--json') ? 'json' : 'text');

  // Daily snapshot prices: one open/high/low/close row per calendar day.
  if (has('--daily') || has('--daily-csv')) {
    const pair = valueOf('--pair', config.primaryPair);
    const days = Number(valueOf('--days', 0)) || 0;
    const since = days > 0 ? Date.now() - days * 86_400_000 : 0;
    if (has('--daily-csv') || format === 'csv') {
      process.stdout.write(store.dailyCsv({ pair, since }));
      return 0;
    }
    const rows = store.dailyRows({ pair, since });
    if (format === 'jsonl') {
      // The exact shape of data/daily.jsonl — pipe straight into the file.
      process.stdout.write(rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
      return 0;
    }
    process.stdout.write(`${JSON.stringify({ ok: rows.length > 0, pair, tz: store.dailyTzOffsetMin, count: rows.length, days: rows }, null, 2)}\n`);
    return rows.length ? 0 : 1;
  }

  if (has('--export') || has('--csv') || format === 'csv') {
    process.stdout.write(store.csv({ pair: valueOf('--pair', config.primaryPair) }));
    return 0;
  }

  if (has('--loop')) {
    const scheduler = createScheduler({
      intervalMin: config.pollIntervalMin,
      name: 'cli-loop',
      run: async () => {
        const result = await once();
        if (format === 'json') console.log(JSON.stringify({ ok: result.ok, primary: result.observation?.primary ?? null, simulated: result.simulated, error: result.error }));
        else printHuman(result);
        return result;
      },
    });
    scheduler.start();
    logger.info('loop mode', { intervalMin: config.pollIntervalMin });
    return new Promise(() => {}); // run until interrupted
  }

  const result = await once();
  if (format === 'json') {
    console.log(
      JSON.stringify(
        {
          ok: result.ok,
          simulated: result.simulated,
          stored: result.stored ?? false,
          storeReason: result.storeReason ?? null,
          error: result.error,
          observation: result.observation,
          attempts: result.attempts,
          warnings: result.warnings,
        },
        null,
        2
      )
    );
  } else {
    printHuman(result);
  }
  return result.ok ? 0 : 1;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    logger.error('cli failed', { error: err.message, stack: err.stack });
    process.exit(1);
  });
