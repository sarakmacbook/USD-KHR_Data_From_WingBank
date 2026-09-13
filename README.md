# USD/KHR Tracker — Wing Bank exchange-rate board

A small, self-hosted service that **keeps tracking the USD/KHR exchange rate published by
[Wing Bank Cambodia](https://www.wingbank.com.kh/en/exchange-rate)** and turns it into a live
dashboard, a queryable JSON API and a growing dataset you can export as CSV.

The bank publishes a board (Bank Buy / Bank Sell for USD/KHR and ~16 other pairs) but no history
and no public API. This project polls that board on a schedule, appends every reading to an
append-only log, and serves a fast dashboard on top of it — with **zero runtime dependencies**
(Node ≥ 20 built-ins only, vanilla HTML/CSS/JS, hand-written canvas chart).

```
USD/KHR   Bank Buy 4,049.00   Bank Sell 4,059.00   Mid 4,054.00   spread 10 (0.247%)
```

---

## Contents

- [Features](#features)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Dashboard](#dashboard)
- [HTTP API](#http-api)
- [Configuration](#configuration)
- [Data & storage](#data--storage)
- [Deployment](#deployment)
- [Offline / demo mode (simulation)](#offline--demo-mode-simulation)
- [Development & tests](#development--tests)
- [Troubleshooting](#troubleshooting)
- [Disclaimer](#disclaimer)

---

## Features

- **Continuous tracking** — polls the board on an interval (default 15 min), with jitter and
  exponential backoff so a bank outage never turns into a request storm.
- **Resilient scraper** — four parsing layers (JSON API → HTML tables → markdown tables → token
  scan) and a mirror fallback chain, so small markup changes do not silently produce empty data.
  Implausible quotes (e.g. an ask of 2× the bid) are rejected instead of stored.
- **Full board, not just USD/KHR** — every poll stores all pairs (EUR/USD, USD/THB, USD/VND,
  USD/JPY, …). The dashboard can switch the tracked pair with one click.
- **Dashboard** — big mid-rate display, bid/ask/spread cards, 1H/24H/7D/30D change chips,
  interactive chart (24H→ALL, bid/ask/mid/spread, hover crosshair, min/max band for bucketed
  ranges), USD↔KHR converter that uses the correct bank side, threshold alerts, pair board,
  capture log and CSV export. Dark/light themes, responsive, keyboard shortcuts (`R`, `T`).
- **JSON API + CSV** — consume the data from anything (spreadsheets, Grafana, a bot, your own app).
- **Append-only JSONL dataset** — auditable, crash-safe, `tail -f`-able, trivially backed up.
- **Serverless mode** — a GitHub Actions workflow can do the tracking for you and commit the
  dataset back to this repo (no server required).
- **Tested** — parser, stats, store, HTTP API and a jsdom smoke test of the dashboard
  (54 tests, all offline).

## Quick start

```bash
git clone https://github.com/sarakmacbook/USD-KHR_Data_From_WingBank.git
cd USD-KHR_Data_From_WingBank

npm start                 # http://localhost:3000
```

Logs are structured JSON on **stderr**, so CLI output stays clean and pipeable:

```bash
node server/cli.js --format json | jq '.observation.primary'
node server/cli.js --export > usd-khr.csv      # dataset, no log lines mixed in
```

That is it — no `npm install` needed for the app itself. Open <http://localhost:3000>, and the
tracker will scrape the board ~1.5 s after boot and every `POLL_INTERVAL_MIN` minutes after that.

Useful variants:

```bash
POLL_INTERVAL_MIN=5 npm start          # poll more often
PRIMARY_PAIR=USD/THB npm start         # track another pair from the same board
npm run scrape                         # one-off scrape (cron friendly), prints the quote
npm run scrape -- --format json        # machine-readable one-off scrape
npm run scrape -- --export             # dump the stored series as CSV
npm run simulate                       # demo mode for hosts with no internet egress
npm test                               # full offline test suite (npm i -D jsdom first for the UI test)
```

> **First boot:** if the store is empty, it is seeded from
> [`server/seed-snapshot.json`](server/seed-snapshot.json) — a real snapshot of the board
> (USD/KHR bid 4,049 / ask 4,059, page header “As of 11 Sep 2026”) captured while building this
> project, so the dashboard is never blank. The seed row is marked `"seed": true` in the log and
> shown as *seed snapshot* in the UI. Set `USE_SEED=false` to disable it.

## How it works

```
                 ┌────────────────────────────┐
   every N min   │  scheduler (jitter+backoff) │
        ┌───────▶└──────────────┬─────────────┘
        │                       │ runScrape()
        │                       ▼
        │        ┌──────────────────────────────┐   1. WING_API_ENDPOINTS (json)
        │        │  scrape: fetch → parse →     │   2. SOURCE_URL (html)
        │        │  validate → normalize        │   3. FALLBACK_SOURCES (mirrors)
        │        └──────────────┬───────────────┘   4. simulator (opt-in, flagged)
        │                       │ Observation {capturedAt, sourceAsOf, quotes[17]}
        │                       ▼
        │        ┌──────────────────────────────┐   data/observations.jsonl  (append-only)
        │        │  store: JSONL + in-memory     │   data/latest.json
        │        │  per-pair time index          │   data/meta.json
        │        └──────────────┬───────────────┘
        │                       │ series / latest / stats / csv
        │                       ▼
        │        ┌──────────────────────────────┐        ┌────────────────────┐
        └────────│  HTTP server (node:http)      │◀──────▶│  dashboard (public) │
                 │  /api/*  +  static files      │  fetch │  vanilla JS + canvas│
                 └──────────────────────────────┘        └────────────────────┘
```

**Scrape cycle.** Each cycle walks an ordered source plan, fetches with a timeout and one retry,
parses the payload, keeps only plausible currency pairs and requires the primary pair
(`USD/KHR`) to be present before accepting the result. The first source that satisfies this wins,
so a mirror is only used when the bank itself is unreachable.

**Parsing layers** (see [`server/scrape/parse.js`](server/scrape/parse.js)):

| Layer | Input | How |
| --- | --- | --- |
| JSON | `{ "currencyPair": "USD/KHR", "bankBuy": 4049, "bankSell": 4059 }`, `{ "USD/KHR": {...} }`, `{ base, quote, bid, ask }` | recursive walk, key heuristics |
| HTML tables | the board as published today | `<tr>`/`<td>` extraction, pair cell → next two numeric cells = bid/ask |
| Markdown tables | reader proxies (`r.jina.ai`) | `\| … \|` rows, images stripped |
| Token scan | any div/list redesign | tokenize text, find `XXX/YYY`, take the next numbers |

The page’s “As of 11 Sep 2026” / “Updated as of” stamps are parsed into `sourceAsOf` (ISO date) so
you can tell *when the bank set the rate* apart from *when we captured it*.

**Deduplication.** Wing shows some pairs in two tables (telegraphic transfer vs outbound). The
first occurrence wins; repeats are counted in `duplicates` rather than merged, because the two
boards have different meanings.

## Dashboard

| Area | What you get |
| --- | --- |
| Header | live / stale / simulated / offline status pill, “updated Xm ago”, refresh, source link, theme |
| Ticker | every pair from the last capture; click one to track it instead |
| Hero | mid rate, 1H/24H/7D/30D change chips, bank “as of”, capture time, source + strategy |
| Stat cards | Bank Buy (bid), Bank Sell (ask), spread (absolute + %), 24h range |
| Chart | 24H/7D/30D/90D/1Y/ALL, bid/ask/mid/spread, hover crosshair + tooltip, min/max band when the range is bucketed, dashed amber line for simulated rows |
| Converter | USD→KHR uses the **bid** (you sell USD), KHR→USD uses the **ask** (you buy USD), plus mid-rate reference and spread cost |
| Alerts | min/max thresholds stored in your browser; on-page banner, toast and optional desktop notification |
| Scraper health | poll interval, next poll, attempts/successes, consecutive failures, strategy, log size |
| Pair board | bid/ask/mid/spread/sample count for all pairs, one-click tracking |
| Capture log | newest captures with source, strategy and status (ok / seed / simulated) + CSV export |

Keyboard: <kbd>R</kbd> refresh, <kbd>T</kbd> theme.

## HTTP API

All endpoints are CORS-enabled (`Access-Control-Allow-Origin: *`) and JSON unless noted.

| Endpoint | Description |
| --- | --- |
| `GET /api/latest?pair=USD/KHR&field=mid` | current quote, change windows, 24h summary, all pairs, status |
| `GET /api/history?pair=USD/KHR&range=30d&field=mid&bucket=auto` | chart series + summary. `range`: `1h 24h 7d 30d 90d 1y all`; `field`: `mid bid ask spread`; `bucket`: `auto none <ms>` |
| `GET /api/pairs` | every tracked pair with its latest quote and sample count |
| `GET /api/observations?limit=25&offset=0` | recent raw captures (source, strategy, `simulated`, `seed`) |
| `GET /api/export.csv?pair=USD/KHR&range=all` | CSV download of the stored series |
| `GET /api/status` | scraper + store health (same object embedded in `/api/latest`) |
| `POST /api/refresh` | scrape now; `200` on success, `502` if every source failed, `429` if rate limited |
| `GET /healthz` | liveness probe for Docker/systemd/uptime checks |

```bash
curl -s localhost:3000/api/latest | jq '.quote'
# {
#   "pair": "USD/KHR",
#   "name": "Cambodian Riel",
#   "bid": 4049,
#   "ask": 4059,
#   "mid": 4054,
#   "spread": 10,
#   "spreadPct": 0.247,
#   "capturedAt": "2026-09-13T13:25:38.620Z",
#   "sourceAsOf": "2026-09-11",
#   "simulated": false
# }

curl -s 'localhost:3000/api/history?range=7d&field=mid' | jq '.summary'
curl -s -X POST localhost:3000/api/refresh | jq '{ok, primary}'
curl -sOJ 'localhost:3000/api/export.csv?range=30d'
```

## Configuration

Everything is environment-driven (see [`.env.example`](.env.example)). Defaults in
[`server/config.js`](server/config.js).

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` / `PORT` | `0.0.0.0` / `3000` | bind address |
| `SOURCE_URL` | Wing exchange-rate page | primary source |
| `FALLBACK_SOURCES` | `https://r.jina.ai/{url}` | mirrors tried when the primary fails (`{url}` placeholder) |
| `WING_API_ENDPOINTS` | *(empty)* | JSON endpoints probed before the HTML page |
| `PRIMARY_PAIR` | `USD/KHR` | pair the tracker requires before accepting a scrape |
| `POLL_INTERVAL_MIN` | `15` | polling cadence (±5% jitter) |
| `BACKOFF_AFTER` / `BACKOFF_CAP_MIN` | `3` / `120` | failures before backoff starts, and its ceiling |
| `REFRESH_MIN_GAP_SEC` | `10` | minimum gap between manual `POST /api/refresh` |
| `DATA_DIR` | `./data` | where the log lives |
| `MIN_STORE_INTERVAL_SEC` | `30` | unchanged readings closer together than this are skipped (unless forced) |
| `MAX_OBSERVATIONS` / `RETENTION_DAYS` | `500000` / `0` | pruning bounds (`0` = keep forever) |
| `USE_SEED` | `true` | seed an empty store from the committed snapshot |
| `FETCH_TIMEOUT_MS` | `20000` | per-request timeout |
| `USER_AGENT` / `ACCEPT_LANGUAGE` | browser-like | request headers |
| `LOG_LEVEL` | `info` | `error` \| `warn` \| `info` \| `debug` (structured JSON logs) |
| `LOG_STREAM` | `stderr` | where logs go — `stderr` keeps `--export` and `--format json` pipeable; set `stdout` if your platform only collects stdout |
| `ALLOW_SIMULATION` / `SIMULATE_ON_FAILURE` / `SIMULATE_BACKFILL_DAYS` | `false` / `false` / `0` | demo mode, see below |

## Data & storage

```
data/
├── observations.jsonl   # append-only: one JSON object per accepted capture
├── latest.json          # most recent observation (fast cold start / debugging)
└── meta.json            # scraper health: attempts, successes, failures, last error
```

One observation:

```json
{
  "id": "2026-09-13T13:25:38.620Z-792e10b6e41e65b3",
  "capturedAt": "2026-09-13T13:25:38.620Z",
  "sourceUrl": "https://www.wingbank.com.kh/en/exchange-rate",
  "sourceLabel": "wingbank.com.kh",
  "strategy": "html-table",
  "format": "html",
  "sourceAsOf": "2026-09-11",
  "simulated": false,
  "quotes": [
    { "pair": "USD/KHR", "name": "Cambodian Riel", "bid": 4049, "ask": 4059, "mid": 4054, "spread": 10, "spreadPct": 0.247 },
    { "pair": "USD/THB", "name": "Thai Baht", "bid": 32.71, "ask": 33.37, "mid": 33.04 }
  ],
  "primary": { "pair": "USD/KHR", "bid": 4049, "ask": 4059, "mid": 4054, "name": "Cambodian Riel" }
}
```

`data/` is gitignored for local runs (it is regenerated by the scraper). The GitHub Actions
workflow force-adds `data/observations.jsonl` and `data/usd-khr.csv`, because in *that* setup the
dataset **is** the deliverable.

Handy one-liners:

```bash
tail -f data/observations.jsonl | jq -c '{t:.capturedAt, mid:.primary.mid}'   # live feed
jq -r '[.capturedAt, .primary.bid, .primary.ask, .primary.mid] | @csv' data/observations.jsonl > usd-khr.csv
node server/cli.js --export > usd-khr.csv                                     # same, via the CLI
```

## Deployment

### Docker

```bash
docker compose up -d --build
docker compose logs -f tracker
curl -s localhost:3000/api/latest | jq .quote
```

The image is `node:22-alpine`, runs as the non-root `node` user, keeps data in a named volume and
has a built-in `HEALTHCHECK` on `/healthz`.

### VPS with systemd (+ nginx)

```bash
sudo mkdir -p /opt/usd-khr-tracker /var/lib/usd-khr-tracker
sudo cp -r . /opt/usd-khr-tracker
sudo useradd --system --home /opt/usd-khr-tracker tracker || true
sudo chown -R tracker:tracker /opt/usd-khr-tracker /var/lib/usd-khr-tracker
sudo cp deploy/usd-khr-tracker.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now usd-khr-tracker
journalctl -u usd-khr-tracker -f
```

The unit is hardened (`ProtectSystem=strict`, `NoNewPrivileges`, `MemoryMax=256M`) and writes only
to `/var/lib/usd-khr-tracker`. Put [`deploy/nginx.conf.example`](deploy/nginx.conf.example) in
front of it for TLS and optional basic auth.

### cron instead of the built-in scheduler

Prefer scraping from cron and serving from the same store? Run the server with a huge poll
interval (`POLL_INTERVAL_MIN=525600`) and add:

```cron
*/15 * * * * cd /opt/usd-khr-tracker && DATA_DIR=/var/lib/usd-khr-tracker /usr/bin/node server/cli.js >> /var/log/usd-khr.log 2>&1
```

Both processes share the JSONL log; the server reloads its index on restart, and `POST /api/refresh`
still works on demand.

### GitHub Actions (no server)

[`.github/workflows/track.yml`](.github/workflows/track.yml) scrapes hourly (`cron: "5 * * * *"`)
and commits `data/observations.jsonl` + `data/usd-khr.csv` back to the repo. Enable it by pushing
to your default branch; run it on demand from the *Actions → Track USD/KHR* tab. Scheduled
workflows only run on the default branch and can be delayed by GitHub.

### Behind a tunnel / no public IP

`cloudflared tunnel --url http://localhost:3000` or `ssh -R 80:localhost:3000 localhost.run` both
work — the app has no absolute URLs and no external CDN dependencies, so it renders identically
through a proxy path.

## Offline / demo mode (simulation)

The scraper needs outbound HTTPS to `wingbank.com.kh`. Some hosts do not have it (sandboxes, CI
runners without egress, a laptop on a plane). Rather than ship an empty dashboard, this project has
an **explicitly opt-in** simulation mode:

```bash
ALLOW_SIMULATION=true SIMULATE_ON_FAILURE=true SIMULATE_BACKFILL_DAYS=30 npm run simulate
```

- `SIMULATE_ON_FAILURE` — when every source fails, generate a mean-reverting random walk around the
  last real value instead of storing nothing.
- `SIMULATE_BACKFILL_DAYS` — on an empty store, generate that many days of history (anchored on the
  real seed snapshot) so charts, ranges and alerts can be evaluated.

Simulated data can never masquerade as real:

- every quote and observation carries `"simulated": true` (and `"backfill": true` where relevant);
- `/api/status` reports `simulation.active`, `/api/history` reports `simulated`;
- the dashboard shows a persistent amber banner, a **simulated** status pill, `sim` badges in the
  ticker, dashed amber chart segments and a *simulated* marker in every tooltip;
- the CSV export has a `simulated` column.

**Leave simulation disabled on any host that can reach the bank.** It exists to evaluate the
product, not to publish rates.

## Development & tests

```
server/
├── index.js            # HTTP server, API routes, static files, boot sequence
├── config.js           # env-driven config + structured logger
├── store.js            # JSONL append-only store, in-memory per-pair index, CSV, pruning
├── scheduler.js        # interval polling with jitter, backoff and manual trigger
├── stats.js            # range presets, bucketing (OHLC), summaries, change windows
├── cli.js              # one-off scrape / CSV export / seed / --loop (cron friendly)
├── seed-snapshot.json  # real bootstrap snapshot of the board
└── scrape/
    ├── index.js        # orchestration: source plan → parse → validate → Observation
    ├── fetchers.js     # timeouts, retries, mirrors
    ├── parse.js        # the four parsing layers + number/date normalization
    └── simulate.js     # opt-in demo generator (random walk + backfill)
public/
├── index.html          # dashboard markup
├── styles.css          # design system (dark/light, responsive, print)
├── app.js              # state, polling, rendering, converter, alerts
└── chart.js            # dependency-free canvas chart (DPR-aware, touch, crosshair)
test/
├── fixtures/           # HTML/markdown/JSON snapshots of the board (incl. a div-only redesign)
├── parse.test.js       # parser layers, number & date normalization, sanity filters
├── stats.test.js       # bucketing, summaries, change windows
├── store.test.js       # append/dedupe/persistence/ordering/CSV/meta
├── api.test.js         # boots the real server and exercises every endpoint
└── frontend.test.js    # jsdom smoke test: renders the dashboard, converter, alerts, banner
```

```bash
npm install --save-dev jsdom   # only needed by test/frontend.test.js (it skips if absent)
npm test                       # 54 tests, no network required
npm run test:watch
```

The whole suite runs offline: the API test points `SOURCE_URL` at a closed local port, and the
parser tests use the fixtures in `test/fixtures/`.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Status pill shows **offline**, `/api/latest` has no `quote` | no outbound HTTPS to the bank | check egress/firewall/DNS; set `FALLBACK_SOURCES`; or use demo mode |
| `fetch failed` / `ENOTFOUND` in `meta.json` | DNS or proxy blocking | test with `curl -v https://www.wingbank.com.kh/en/exchange-rate` from the same host |
| Scrape succeeds but “no rates recognized” | Wing changed markup, **or** the board is rendered client-side and the raw HTML has no numbers | add the new markup as a fixture and extend `parse.js`; or rely on `FALLBACK_SOURCES` (a reader proxy renders the JS and returns markdown, which the parser understands); or open devtools → Network, find the JSON call behind the board and set `WING_API_ENDPOINTS` |
| Rates stored but `USD/KHR` missing | board layout/tab change | inspect `data/observations.jsonl`; adjust `PRIMARY_PAIR` or the parser |
| Chart is flat / one point | only one capture so far | wait for the next poll, lower `POLL_INTERVAL_MIN`, or press **Refresh** |
| History missing after restart | `DATA_DIR` differs between runs | use the same `DATA_DIR` for the server, CLI and cron |
| `429` from `POST /api/refresh` | manual refresh rate limit | wait `REFRESH_MIN_GAP_SEC` |
| Port already in use | another service on `:3000` | `PORT=8080 npm start` |

Diagnostics:

```bash
curl -s localhost:3000/api/status | jq '.scraper'      # attempts, failures, last error, strategy
jq -c 'select(.simulated)' data/observations.jsonl     # any simulated rows?
LOG_LEVEL=debug npm start                              # per-attempt fetch logging
```

## Disclaimer

- Rates come from Wing Bank’s public page and are **indicative only**; the bank states they change
  without prior notice. Always confirm with the bank before transacting.
- This project is an independent tracker. It is **not affiliated with, endorsed by, or operated by
  Wing Bank**. Respect the source: keep `POLL_INTERVAL_MIN` reasonable (≥ 5), leave the
  `User-Agent` identifiable, and do not scrape more often than you need.
- Nothing here is financial advice.

## License

MIT — see [LICENSE](LICENSE).
