/**
 * Vercel serverless entrypoint — the whole JSON API in one function.
 *
 * `vercel.json` rewrites `/api/:path*` here, and `resolveApiPath()` maps the
 * original request path back to the matching route, so the dashboard and every
 * API consumer work unchanged on Vercel. The store is read-only: it is hydrated
 * from the dataset that ships with the deployment (`data/observations.jsonl`,
 * `data/daily.jsonl`), which the GitHub Actions tracker keeps current.
 *
 * Local equivalent: `npm start` (same router, writable store, live scheduler).
 */
import { handleServerlessRequest } from '../server/serverless.js';

export default async function handler(req, res) {
  try {
    await handleServerlessRequest(req, res, { platform: 'vercel' });
  } catch (err) {
    const body = JSON.stringify({ ok: false, error: err.message || 'internal server error' });
    res.writeHead(500, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Access-Control-Allow-Origin': '*',
    });
    res.end(body);
  }
}
