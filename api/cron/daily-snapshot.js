/**
 * Vercel Cron: capture today's daily snapshot of the Wing Bank board.
 *
 * Scheduled from `vercel.json` (`crons`, once a day — the Hobby plan's minimum
 * granularity). Each run scrapes the board and commits one OHLC row per day to
 * `data/daily.jsonl` + `data/usd-khr-daily.csv` in this repository, which is
 * exactly what the dashboard's long-range graph needs. The commit triggers a
 * redeploy, so the new row ships with the bundle a minute later.
 *
 * Auth: Vercel sends `Authorization: Bearer $CRON_SECRET`. With no secret set,
 * only requests whose User-Agent is `vercel-cron` are accepted.
 *
 * Manual run:
 *   curl -H "Authorization: Bearer $CRON_SECRET" https://your-app/api/cron/daily-snapshot
 */
import { bootstrap, scrapeAndPersist, verifyCron } from '../../server/serverless.js';

function send(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export default async function handler(req, res) {
  const auth = verifyCron(req.headers || {});
  if (!auth.ok) return send(res, 401, { ok: false, error: auth.reason });

  const started = Date.now();
  try {
    const app = await bootstrap({ platform: 'vercel-cron' });
    const result = await scrapeAndPersist({ store: app.store, force: true });
    const primary = result.observation?.primary || null;
    const payload = {
      ok: result.ok,
      ranAt: new Date().toISOString(),
      ms: Date.now() - started,
      auth: auth.reason,
      store: { readonly: app.readonly, observations: app.store.count, dailySnapshots: app.store.daily.size },
      quote: primary,
      simulated: result.simulated,
      stored: result.stored ?? false,
      daily: result.daily || [],
      persisted: result.persisted || null,
      error: result.error || null,
      warnings: result.warnings || [],
      hint: result.persisted?.reason || null,
    };
    // Non-2xx makes Vercel report the cron run as failed, which is what you want
    // when the board could not be read at all.
    return send(res, result.ok ? 200 : 502, payload);
  } catch (err) {
    return send(res, 500, { ok: false, error: err.message, stack: err.stack });
  }
}
