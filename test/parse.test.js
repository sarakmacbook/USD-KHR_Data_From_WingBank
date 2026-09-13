import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseRatePayload,
  toNumber,
  extractAsOf,
  tokenize,
  dedupeQuotes,
} from '../server/scrape/parse.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => fs.readFileSync(path.join(dir, 'fixtures', name), 'utf8');

const byPair = (quotes) => Object.fromEntries(quotes.map((q) => [q.pair, q]));

test('toNumber handles bank formatting', () => {
  assert.equal(toNumber('4049'), 4049);
  assert.equal(toNumber('4,049'), 4049);
  assert.equal(toNumber('4,049.00'), 4049);
  assert.equal(toNumber('25,650.9'), 25650.9);
  assert.equal(toNumber('1,329.36'), 1329.36);
  assert.equal(toNumber('1327,98'), 1327.98); // decimal comma
  assert.equal(toNumber('1\u00a0327.98'), 1327.98); // nbsp thousand separator
  assert.equal(toNumber(' 32.71 '), 32.71);
  assert.equal(toNumber('(1.15)'), -1.15);
  assert.equal(toNumber('KHR 0.00'), null); // not a bare number
  assert.equal(toNumber(''), null);
  assert.equal(toNumber(null), null);
  assert.equal(toNumber(4054), 4054);
});

test('extractAsOf understands the page footers', () => {
  assert.equal(extractAsOf('<th>Currency Pair As of 11 Sep 2026</th>'), '2026-09-11');
  assert.equal(extractAsOf('Updated as of: **11 Sep 2026**'), '2026-09-11');
  assert.equal(extractAsOf('Updated as of: September 11, 2026'), '2026-09-11');
  assert.equal(extractAsOf('as of 2026-09-11'), '2026-09-11');
  assert.equal(extractAsOf('no date here'), null);
});

test('tokenize keeps pair codes and thousands-separated numbers intact', () => {
  assert.deepEqual(tokenize('USD/KHR 4,049 4059'), ['USD/KHR', '4,049', '4059']);
});

test('parses the live HTML table layout', () => {
  const res = parseRatePayload(fixture('wing-table.html'), { sourceLabel: 'wing' });
  assert.equal(res.format, 'html');
  assert.equal(res.strategy, 'html-table');
  assert.equal(res.sourceAsOf, '2026-09-11');

  const quotes = byPair(res.quotes);
  const khr = quotes['USD/KHR'];
  assert.ok(khr, 'USD/KHR must be found');
  assert.equal(khr.bid, 4049);
  assert.equal(khr.ask, 4059);
  assert.equal(khr.mid, 4054);
  assert.equal(khr.spread, 10);
  assert.ok(Math.abs(khr.spreadPct - 0.247) < 0.01);
  assert.equal(khr.name, 'Cambodian Riel');
  assert.equal(khr.base, 'USD');
  assert.equal(khr.quote, 'KHR');

  assert.equal(quotes['USD/VND'].bid, 25652, 'thousand separators stripped');
  assert.equal(quotes['USD/KRW'].ask, 1356.22);
  assert.equal(quotes['EUR/USD'].bid, 1.1485);

  // USD/THB appears in both tables; the first (bid+ask) occurrence wins.
  assert.equal(quotes['USD/THB'].bid, 32.71);
  assert.equal(quotes['USD/THB'].ask, 33.37);
  assert.equal(quotes['USD/THB'].duplicates, 2);

  // Header/footer noise must not become quotes.
  assert.equal(quotes['USD/KHR'].warnings, undefined);
  assert.ok(!res.quotes.some((q) => q.pair === 'ATE/KHR'), 'no false positives from image URLs');
});

test('parses reader-proxy markdown (fallback source)', () => {
  const res = parseRatePayload(fixture('wing-reader.md'), { sourceLabel: 'r.jina.ai' });
  assert.equal(res.format, 'markdown');
  assert.equal(res.strategy, 'markdown-table');
  assert.equal(res.sourceAsOf, '2026-09-11');
  const quotes = byPair(res.quotes);
  assert.equal(quotes['USD/KHR'].bid, 4049);
  assert.equal(quotes['USD/KHR'].ask, 4059);
  assert.equal(quotes['USD/KHR'].name, 'Cambodian Riel');
  assert.equal(quotes['USD/VND'].bid, 25652);
  assert.equal(quotes['USD/KRW'].bid, 1329.36);
});

test('falls back to a token scan when there are no tables', () => {
  const res = parseRatePayload(fixture('wing-div.html'), { sourceLabel: 'wing' });
  assert.equal(res.strategy, 'token-scan');
  assert.equal(res.sourceAsOf, '2026-09-12');
  const quotes = byPair(res.quotes);
  assert.ok(quotes['USD/KHR'], 'USD/KHR recovered from div markup');
  assert.equal(quotes['USD/KHR'].bid, 4050);
  assert.equal(quotes['USD/KHR'].ask, 4060);
  assert.equal(quotes['USD/THB'].bid, 32.7);
});

test('parses a hypothetical JSON API', () => {
  const res = parseRatePayload(fixture('wing-api.json'), { sourceLabel: 'api' });
  assert.equal(res.format, 'json');
  const quotes = byPair(res.quotes);
  assert.equal(quotes['USD/KHR'].bid, 4049);
  assert.equal(quotes['USD/KHR'].ask, 4059);
  assert.equal(quotes['USD/KHR'].name, 'Cambodian Riel');
  assert.equal(quotes['EUR/USD'].bid, 1.1485, 'string numbers coerced');
  assert.equal(quotes['USD/VND'].bid, 25652, 'object-keyed pairs supported');
  assert.equal(quotes['USD/KRW'].mid, 1342.79, 'mid-only pairs supported');
});

test('rejects implausible spreads instead of storing garbage', () => {
  const html = `
    <table>
      <tr><td>Cambodian Riel</td><td>USD/KHR</td><td>4049</td><td>8098</td></tr>
    </table>`;
  const res = parseRatePayload(html);
  const khr = res.quotes.find((q) => q.pair === 'USD/KHR');
  assert.equal(khr.bid, 4049);
  assert.equal(khr.ask, null);
  assert.ok(res.warnings.some((w) => w.includes('implausible')));
});

test('ignores empty or unparseable payloads', () => {
  assert.deepEqual(parseRatePayload('').quotes, []);
  assert.deepEqual(parseRatePayload('<html><body>Nothing here</body></html>').quotes, []);
  assert.equal(parseRatePayload('{oops').quotes.length, 0);
});

test('dedupeQuotes keeps the first occurrence and reports duplicates', () => {
  const quotes = dedupeQuotes([
    { pair: 'USD/KHR', base: 'USD', quote: 'KHR', name: 'Riel', bid: 1, ask: 2, mid: 1.5, spread: 1, spreadPct: 100, source: 'a' },
    { pair: 'USD/KHR', base: 'USD', quote: 'KHR', name: 'Riel', bid: 9, ask: 9, mid: 9, spread: 0, spreadPct: 0, source: 'b' },
  ]);
  assert.equal(quotes.length, 1);
  assert.equal(quotes[0].bid, 1);
  assert.equal(quotes[0].duplicates, 2);
});
