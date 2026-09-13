/**
 * CLI contract tests.
 *
 * The CLI is what cron and the GitHub Actions workflow call, so its stdout must
 * stay machine-readable: logs go to stderr, data goes to stdout. These tests run
 * the real binary as a child process against a closed local port (no network).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, '..');
const cli = path.join(root, 'server', 'cli.js');

async function exec(args, extraEnv = {}) {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'khr-cli-'));
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args], {
      cwd: root,
      timeout: 30_000,
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        SOURCE_URL: 'http://127.0.0.1:9/exchange-rate', // nothing listens here
        FALLBACK_SOURCES: '',
        WING_API_ENDPOINTS: '',
        ALLOW_SIMULATION: 'false',
        SIMULATE_ON_FAILURE: 'false',
        USE_SEED: 'true',
        LOG_LEVEL: 'info',
        FETCH_TIMEOUT_MS: '1500',
        PRIMARY_PAIR: 'USD/KHR',
        ...extraEnv,
      },
    });
    return { stdout, stderr, code: 0, dataDir };
  } catch (err) {
    return { stdout: err.stdout || '', stderr: err.stderr || '', code: err.code ?? 1, dataDir };
  }
}

const LOG_LINE = /^\{"ts":/;

test('--export writes pure CSV to stdout and logs to stderr', async () => {
  const { stdout, stderr, code } = await exec(['--export']);
  assert.equal(code, 0);
  const lines = stdout.trim().split('\n');
  assert.equal(lines[0], 'captured_at,epoch_ms,pair,bid,ask,mid,spread,source_as_of,simulated');
  assert.ok(lines.length >= 2, 'the seeded snapshot is exported');
  assert.ok(!lines.some((l) => LOG_LINE.test(l)), 'no log lines inside the CSV');
  assert.match(lines[1], /USD\/KHR,4049,4059,4054,10,2026-09-11,false$/);
  assert.ok(LOG_LINE.test(stderr.split('\n')[0]), 'logs still reach stderr');
});

test('--format json writes parseable JSON to stdout', async () => {
  const { stdout, code } = await exec(['--format', 'json']);
  assert.equal(code, 1, 'the unreachable source makes the run fail');
  const payload = JSON.parse(stdout); // throws if a single log line leaked in
  assert.equal(payload.ok, false);
  assert.match(payload.error, /fetch failed|ECONNREFUSED/i);
  assert.ok(Array.isArray(payload.attempts) && payload.attempts.length >= 1);
  assert.equal(payload.attempts[0].status, 0);
});

test('--json is an alias for --format json', async () => {
  const { stdout } = await exec(['--json']);
  const payload = JSON.parse(stdout);
  assert.equal(typeof payload.ok, 'boolean');
  assert.equal(payload.simulated, false, 'simulation is disabled in tests');
});

test('text mode prints a readable failure report', async () => {
  const { stdout, stderr, code } = await exec([]);
  assert.equal(code, 1);
  assert.match(`${stdout}${stderr}`, /scrape failed/i);
  assert.ok(!LOG_LINE.test(stdout.split('\n')[0] || ''), 'human summary is not a log line');
});

test('--seed-only bootstraps an empty store', async () => {
  const { stdout, code, dataDir } = await exec(['--seed-only']);
  assert.equal(code, 0);
  assert.match(stdout, /seeded \d+ pairs/);
  const log = await fsp.readFile(path.join(dataDir, 'observations.jsonl'), 'utf8');
  const obs = JSON.parse(log.trim().split('\n')[0]);
  assert.equal(obs.seed, true);
  assert.equal(obs.primary.pair, 'USD/KHR');
  assert.equal(obs.primary.bid, 4049);
});

test('a successful scrape prints the quote (simulated source, flagged)', async () => {
  const { stdout, code } = await exec([], {
    ALLOW_SIMULATION: 'true',
    SIMULATE_ON_FAILURE: 'true',
  });
  assert.equal(code, 0);
  assert.match(stdout, /USD\/KHR\s+bid \d+\s+ask \d+\s+mid \d+ \[SIMULATED\]/);
  assert.match(stdout, /source:\s+simulator/);
});

test('PRIMARY_PAIR is honoured end to end', async () => {
  const { stdout } = await exec(['--export'], { PRIMARY_PAIR: 'USD/THB' });
  const lines = stdout.trim().split('\n');
  assert.match(lines[1], /,USD\/THB,32\.71,33\.37,33\.04,/);
});
