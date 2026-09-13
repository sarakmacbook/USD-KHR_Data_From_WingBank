/**
 * Parser for the Wing Bank exchange-rate page.
 *
 * The site has no documented public API, so the scraper has to survive markup
 * changes. Parsing therefore happens in layers, from most to least structured:
 *
 *   1. JSON payload      – if an API endpoint ever returns JSON.
 *   2. HTML tables       – <tr>/<td> rows (what the page uses today).
 *   3. Markdown tables   – what reader proxies such as r.jina.ai return.
 *   4. Token scan        – tag-stripped text: find "USD/KHR", take next numbers.
 *
 * Every layer produces the same normalized `Quote` objects:
 *   { pair, base, quote, name, bid, ask, mid, spread, spreadPct, source }
 *
 * No third-party dependencies: only string handling + regex, so it is fully
 * unit-testable offline (see test/parse.test.js).
 */

const PAIR_IN_TEXT = /([A-Z]{3})\s*[\/\\|]\s*([A-Z]{3})/g;
const PAIR_EXACT = /^([A-Z]{3})\s*[\/\\|]\s*([A-Z]{3})$/;
const NUMERIC_TOKEN = /^\(?\d{1,3}(?:[,\u00a0\u202f ]\d{3})*(?:\.\d+)?\)?$|^\(?\d+(?:\.\d+)?\)?$/;
const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

export const CURRENCY_NAMES = {
  USD: 'US Dollar',
  KHR: 'Cambodian Riel',
  EUR: 'Euro',
  GBP: 'British Pound',
  THB: 'Thai Baht',
  VND: 'Vietnamese Dong',
  JPY: 'Japanese Yen',
  CNY: 'Chinese Yuan Renminbi',
  KRW: 'South Korean Won',
  PHP: 'Philippine Peso',
  IDR: 'Indonesian Rupiah',
  SGD: 'Singapore Dollar',
  MYR: 'Malaysian Ringgit',
  HKD: 'Hong Kong Dollar',
  CAD: 'Canadian Dollar',
  AUD: 'Australian Dollar',
  NZD: 'New Zealand Dollar',
  CHF: 'Swiss Franc',
};

/** "4,049.00" / "1 327.98" / "(1.15)" -> 4049 | 1327.98 | -1.15
 *  Returns null for anything that is not a bare number ("KHR 0.00", "1 USD"). */
export function toNumber(input) {
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed || !/^[()+\-]?[\d.,\u00a0\u202f ()+\-]+$/.test(trimmed)) return null;
  let s = trimmed.replace(/[^\d.,()+\-]/g, '');
  if (!s || !/\d/.test(s)) return null;
  const negative = /^\(.*\)$/.test(s);
  s = s.replace(/[()]/g, '');
  // Drop thousand separators (commas, nbsp, narrow nbsp, spaces) but keep the
  // decimal separator. If a comma is the only separator and is followed by 1-2
  // digits at the end, treat it as a decimal comma.
  if (s.includes(',')) {
    if (s.includes('.')) s = s.replace(/,/g, '');
    else if (/,\d{1,2}$/.test(s)) s = s.replace(',', '.');
    else s = s.replace(/,/g, '');
  }
  s = s.replace(/[\u00a0\u202f ]/g, '');
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function collapse(s) {
  return s.replace(/\s+/g, ' ').trim();
}

/** Convert an HTML fragment into readable text, keeping cell boundaries. */
export function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(br|\/tr|\/p|\/li|\/div|\/h[1-6]|\/td|\/th)[^>]*>/gi, ' \u0001 ')
      .replace(/<[^>]+>/g, ' ')
  )
    .split('\u0001')
    .map(collapse)
    .filter(Boolean)
    .join(' \u0001 ');
}

function cleanCell(html) {
  return collapse(
    decodeEntities(
      html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<(img|input)[^>]*>/gi, ' ')
        .replace(/<br[^>]*>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
    )
  );
}

/** All <tr> rows of the document, as arrays of cleaned cell strings. */
export function extractHtmlTables(html) {
  const tables = [];
  const tableRe = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  const scope = tableRe.test(html) ? html.match(/<table[^>]*>[\s\S]*?<\/table>/gi) : [html];
  for (const chunk of scope) {
    const rows = [];
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let m;
    while ((m = rowRe.exec(chunk))) {
      const cells = [];
      const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
      let c;
      while ((c = cellRe.exec(m[1]))) cells.push(cleanCell(c[1]));
      if (cells.length) rows.push(cells);
    }
    if (rows.length) tables.push(rows);
  }
  return tables;
}

/** Markdown / reader-proxy tables: lines of `| a | b | c |`. */
export function extractMarkdownTables(text) {
  const tables = [];
  let current = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('|')) {
      if (current.length) tables.push(current);
      current = [];
      continue;
    }
    if (/^\|[\s:-]+\|[\s:|-]*$/.test(line)) continue; // separator row
    const cells = line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => collapse(cell.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/<br\s*\/?>/gi, ' ')));
    current.push(cells);
  }
  if (current.length) tables.push(current);
  return tables.filter((rows) => rows.some((r) => r.length >= 2));
}

/** Split plain text into tokens that keep numbers and pair codes intact. */
export function tokenize(text) {
  // Thousands separators are limited to "," and non-breaking spaces: a plain
  // space would otherwise glue two adjacent numbers into one token.
  const matches = text.match(
    /[A-Z]{3}\s*[\/\\|]\s*[A-Z]{3}|\d{1,3}(?:[,\u00a0\u202f]\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|[A-Za-z]{2,}/g
  );
  return matches ? matches.map((t) => t.trim()) : [];
}

function makeQuote({ base, quote, name, bid, ask, mid, source, warnings = [] }) {
  if (!base || !quote) return null;
  const b = typeof bid === 'number' && Number.isFinite(bid) && bid > 0 ? bid : null;
  const a = typeof ask === 'number' && Number.isFinite(ask) && ask > 0 ? ask : null;
  let m = typeof mid === 'number' && Number.isFinite(mid) && mid > 0 ? mid : null;
  if (m === null && b !== null && a !== null) m = (b + a) / 2;
  if (m === null && b !== null) m = b;
  if (m === null && a !== null) m = a;
  if (b === null && a === null && m === null) return null;

  // Sanity: a bank spread is a few percent, never 2x. If the "ask" looks like a
  // different column entirely (e.g. a timestamp), drop it rather than corrupt data.
  let finalAsk = a;
  let finalBid = b;
  if (a !== null && b !== null) {
    const ratio = a / b;
    if (ratio < 0.8 || ratio > 1.25) {
      warnings.push(`${base}/${quote}: implausible bid/ask spread (${b} / ${a}) — ask discarded`);
      finalAsk = null;
    }
  }
  const resolvedMid = finalBid !== null && finalAsk !== null ? (finalBid + finalAsk) / 2 : m;
  const spread = finalBid !== null && finalAsk !== null ? finalAsk - finalBid : null;

  return {
    pair: `${base}/${quote}`,
    base,
    quote,
    name: collapse(name || '') || CURRENCY_NAMES[quote] || quote,
    bid: finalBid,
    ask: finalAsk,
    mid: resolvedMid,
    spread,
    spreadPct: spread !== null && finalBid ? (spread / finalBid) * 100 : null,
    source: source || null,
    ...(warnings.length ? { warnings } : {}),
  };
}

/**
 * Turn table rows (HTML or markdown) into quotes.
 * A row qualifies when it contains a currency pair; the first one or two numeric
 * cells after the pair are read as bid / ask (Bank Buy / Bank Sell).
 */
export function quotesFromRows(tables, sourceLabel) {
  const quotes = [];
  const warnings = [];
  tables.forEach((rows, tableIndex) => {
    for (const cells of rows) {
      if (!cells.length) continue;

      // Locate the pair: prefer a cell that is exactly "USD/KHR".
      let pair = null;
      let pairCellIndex = -1;
      let exact = false;
      for (let i = 0; i < cells.length; i += 1) {
        const m = PAIR_EXACT.exec(cells[i].toUpperCase());
        if (m) {
          pair = { base: m[1], quote: m[2] };
          pairCellIndex = i;
          exact = true;
          break;
        }
      }
      if (!pair) {
        for (let i = 0; i < cells.length; i += 1) {
          PAIR_IN_TEXT.lastIndex = 0;
          const m = PAIR_IN_TEXT.exec(cells[i].toUpperCase());
          if (m) {
            pair = { base: m[1], quote: m[2] };
            pairCellIndex = i;
            break;
          }
        }
      }
      if (!pair) continue;

      // Numbers may live in the pair cell itself ("USD/KHR 4049 4059") or after it.
      const numbers = [];
      const inline = cells[pairCellIndex].toUpperCase().split(PAIR_IN_TEXT).pop() || '';
      for (const tok of tokenize(inline)) {
        if (NUMERIC_TOKEN.test(tok)) numbers.push(toNumber(tok));
      }
      for (let i = pairCellIndex + 1; i < cells.length && numbers.length < 2; i += 1) {
        const value = toNumber(cells[i]);
        if (value !== null && NUMERIC_TOKEN.test(cells[i].trim())) numbers.push(value);
      }
      if (!numbers.length) continue;

      const nameCell = cells.slice(0, exact ? pairCellIndex : pairCellIndex + 1).join(' ');
      const name = collapse(nameCell.replace(PAIR_IN_TEXT, ' ')).replace(/\s{2,}/g, ' ');

      const q = makeQuote({
        base: pair.base,
        quote: pair.quote,
        name,
        bid: numbers[0] ?? null,
        ask: numbers[1] ?? null,
        source: `${sourceLabel}:table${tableIndex + 1}`,
      });
      if (q) {
        if (q.warnings) warnings.push(...q.warnings);
        quotes.push(q);
      }
    }
  });
  return { quotes, warnings };
}

/** Last-resort scan over tag-stripped text. */
export function quotesFromTokens(text, sourceLabel) {
  const tokens = tokenize(htmlToText(text).replace(/\u0001/g, ' '));
  const quotes = [];
  const warnings = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const m = PAIR_EXACT.exec(tokens[i].toUpperCase().replace(/\s+/g, ''));
    if (!m) continue;
    const numbers = [];
    for (let j = i + 1; j < tokens.length && numbers.length < 2; j += 1) {
      if (NUMERIC_TOKEN.test(tokens[j])) numbers.push(toNumber(tokens[j]));
      else if (PAIR_EXACT.test(tokens[j].toUpperCase().replace(/\s+/g, ''))) break;
      else if (numbers.length === 0 && j - i > 6) break; // pair label with no rate nearby
    }
    if (!numbers.length) continue;
    const q = makeQuote({
      base: m[1],
      quote: m[2],
      bid: numbers[0] ?? null,
      ask: numbers[1] ?? null,
      source: `${sourceLabel}:tokens`,
    });
    if (q) {
      if (q.warnings) warnings.push(...q.warnings);
      quotes.push(q);
    }
  }
  return { quotes, warnings };
}

const BUY_KEY = /(bank[\s_-]?)?(buy|bid|we[\s_-]?buy|purchase)/i;
const SELL_KEY = /(bank[\s_-]?)?(sell|ask|offer|we[\s_-]?sell)/i;
const RATE_KEY = /(mid|rate|value|price|close|last)/i;

/** Walk an arbitrary JSON payload looking for currency quotes. */
export function quotesFromJson(payload, sourceLabel) {
  const quotes = [];
  const warnings = [];

  const push = (candidate) => {
    const q = makeQuote({ ...candidate, source: sourceLabel });
    if (q) {
      if (q.warnings) warnings.push(...q.warnings);
      quotes.push(q);
    }
  };

  const walk = (node, depth = 0) => {
    if (!node || depth > 12) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;

    const entries = Object.entries(node);
    const str = (re) => {
      const hit = entries.find(([k, v]) => re.test(k) && typeof v === 'string');
      return hit ? hit[1] : null;
    };
    const num = (re) => {
      const hit = entries.find(([k, v]) => re.test(k) && (typeof v === 'number' || (typeof v === 'string' && NUMERIC_TOKEN.test(v.trim()))));
      return hit ? toNumber(hit[1]) : null;
    };

    // A human readable label, e.g. "currencyName": "Cambodian Riel". Values that
    // are themselves pair codes ("USD/KHR") are rejected so the name stays a name.
    const label = () => {
      const hit = entries.find(
        ([k, v]) => /(name|description|label|title|currency)/i.test(k) && typeof v === 'string' && !PAIR_EXACT.test(String(v).trim().toUpperCase())
      );
      return hit ? hit[1] : null;
    };

    // Shape A: { pair: "USD/KHR", buy: 4049, sell: 4059 }
    const pairText = str(/pair|symbol|instrument|ccy[\s_-]?pair|currency[\s_-]?pair/i) || str(/^code$/i);
    if (pairText) {
      PAIR_IN_TEXT.lastIndex = 0;
      const m = PAIR_IN_TEXT.exec(String(pairText).toUpperCase());
      const compact = String(pairText).toUpperCase().replace(/[^A-Z]/g, '');
      const knownCompact = compact.length === 6 && CURRENCY_NAMES[compact.slice(0, 3)] && CURRENCY_NAMES[compact.slice(3)];
      if (m) {
        push({ base: m[1], quote: m[2], name: label(), bid: num(BUY_KEY), ask: num(SELL_KEY), mid: num(RATE_KEY) });
      } else if (knownCompact) {
        push({ base: compact.slice(0, 3), quote: compact.slice(3), name: label(), bid: num(BUY_KEY), ask: num(SELL_KEY), mid: num(RATE_KEY) });
      }
    }

    // Shape B: { base: "USD", quote: "KHR", bid: ..., ask: ... }
    const base = str(/^(base|from|sell[\s_-]??currency|baseCurrency|ccy)$/i);
    const quoteCcy = str(/^(quote|to|buy[\s_-]?currency|quoteCurrency|target|currency|code)$/i);
    if (base && quoteCcy && /^[A-Z]{3}$/i.test(base) && /^[A-Z]{3}$/i.test(quoteCcy)) {
      push({ base: base.toUpperCase(), quote: quoteCcy.toUpperCase(), bid: num(BUY_KEY), ask: num(SELL_KEY), mid: num(RATE_KEY) });
    }

    // Shape C: { "USD/KHR": { bid, ask } } or { "USD/KHR": 4054 } or { USDKHR: 4054 }
    for (const [key, value] of entries) {
      const squashed = String(key).toUpperCase().replace(/\s+/g, '');
      let b = null;
      let q = null;
      if (/^[A-Z]{3}[\/\\|][A-Z]{3}$/.test(squashed)) {
        b = squashed[0] + squashed[1] + squashed[2];
        q = squashed[4] + squashed[5] + squashed[6];
      } else if (/^[A-Z]{6}$/.test(squashed) && CURRENCY_NAMES[squashed.slice(0, 3)] && CURRENCY_NAMES[squashed.slice(3)]) {
        b = squashed.slice(0, 3);
        q = squashed.slice(3);
      }
      if (!b) continue;
      if (typeof value === 'number' || (typeof value === 'string' && NUMERIC_TOKEN.test(value.trim()))) {
        push({ base: b, quote: q, mid: toNumber(value) });
      } else if (value && typeof value === 'object') {
        const sub = Object.entries(value);
        const subNum = (re) => {
          const hit = sub.find(([k, v]) => re.test(k) && (typeof v === 'number' || typeof v === 'string'));
          return hit ? toNumber(hit[1]) : null;
        };
        push({ base: b, quote: q, bid: subNum(BUY_KEY), ask: subNum(SELL_KEY), mid: subNum(RATE_KEY) });
      }
    }

    for (const [, value] of entries) walk(value, depth + 1);
  };

  walk(payload);
  return { quotes, warnings };
}

const AS_OF_PREFIX =
  '(?:\\bas\\s+of\\b|\\bupdated\\b(?:\\s+as)?\\s*(?:\\bof\\b|\\bon\\b)?|\\beffective\\b(?:\\s+from)?|\\bdate\\b|\\blast\\s+updated\\b)';
const AS_OF_PATTERNS = [
  { re: new RegExp(`${AS_OF_PREFIX}\\s*[:\\-]?\\s*(\\d{1,2})\\s+([A-Za-z]{3,9})\\.?,?\\s+(\\d{4})`, 'i'), shape: 'd-mon-y' },
  { re: new RegExp(`${AS_OF_PREFIX}\\s*[:\\-]?\\s*([A-Za-z]{3,9})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})`, 'i'), shape: 'mon-d-y' },
  { re: new RegExp(`${AS_OF_PREFIX}\\s*[:\\-]?\\s*(\\d{4})-(\\d{1,2})-(\\d{1,2})`, 'i'), shape: 'iso' },
  { re: new RegExp(`${AS_OF_PREFIX}\\s*[:\\-]?\\s*(\\d{1,2})[/.-](\\d{1,2})[/.-](\\d{4})`, 'i'), shape: 'd-m-y' },
  { re: new RegExp(`${AS_OF_PREFIX}\\s*[:\\-]?\\s*"(\\d{4})-(\\d{1,2})-(\\d{1,2})`, 'i'), shape: 'iso' },
];

/** "As of 11 Sep 2026" -> "2026-09-11" */
export function extractAsOf(text) {
  if (typeof text !== 'string' || !text) return null;
  // Try visible text first, then the raw payload (dates sometimes live in a
  // data-* attribute or in an inline JSON blob).
  const candidates = [text.replace(/<[^>]+>/g, ' ').replace(/[*_]{1,2}/g, ' '), text];
  for (const haystack of candidates) {
    for (const { re, shape } of AS_OF_PATTERNS) {
      const m = re.exec(haystack);
      if (!m) continue;
      let year;
      let month;
      let day;
      if (shape === 'd-mon-y') {
        day = Number(m[1]);
        month = MONTHS[m[2].slice(0, 3).toLowerCase()];
        year = Number(m[3]);
      } else if (shape === 'mon-d-y') {
        month = MONTHS[m[1].slice(0, 3).toLowerCase()];
        day = Number(m[2]);
        year = Number(m[3]);
      } else if (shape === 'iso') {
        year = Number(m[1]);
        month = Number(m[2]);
        day = Number(m[3]);
      } else {
        // d/m/y — the page is Cambodian, so day-first is the safer assumption.
        day = Number(m[1]);
        month = Number(m[2]);
        year = Number(m[3]);
      }
      if (!year || !month || !day || month > 12 || day > 31) continue;
      const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const ts = Date.parse(iso);
      if (!Number.isNaN(ts) && ts < Date.now() + 86_400_000 * 3) return iso;
    }
  }
  return null;
}


function detectFormat(text) {
  const head = text.trimStart().slice(0, 512);
  if (head.startsWith('{') || head.startsWith('[')) return 'json';
  if (/<(html|table|div|body|!doctype|script|p|tr|li)\b/i.test(text.slice(0, 20_000))) return 'html';
  if (/^\s*\|.*\|\s*$/m.test(text)) return 'markdown';
  return 'text';
}

/**
 * Main entry point. Accepts raw HTML, reader-proxy markdown or JSON.
 * @returns {{quotes: Quote[], sourceAsOf: string|null, format: string, strategy: string, warnings: string[]}}
 */
export function parseRatePayload(text, { sourceLabel = 'source' } = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    return { quotes: [], sourceAsOf: null, format: 'empty', strategy: 'none', warnings: ['empty payload'] };
  }

  const format = detectFormat(text);
  const warnings = [];
  let quotes = [];
  let strategy = 'none';

  if (format === 'json') {
    try {
      const parsed = JSON.parse(text);
      const res = quotesFromJson(parsed, sourceLabel);
      quotes = res.quotes;
      warnings.push(...res.warnings);
      strategy = 'json';
    } catch (err) {
      warnings.push(`json parse failed: ${err.message}`);
    }
  }

  if (!quotes.length && (format === 'html' || format === 'markdown' || format === 'text')) {
    const tables = format === 'markdown' ? extractMarkdownTables(text) : extractHtmlTables(text);
    if (format === 'html' && !tables.length) {
      // Div/list based markup: fall straight through to the token scanner.
      warnings.push('no <table> markup found — using token scan');
    }
    const res = quotesFromRows(tables, sourceLabel);
    quotes = res.quotes;
    warnings.push(...res.warnings);
    strategy = format === 'markdown' ? 'markdown-table' : 'html-table';
  }

  if (!quotes.length) {
    const res = quotesFromTokens(text, sourceLabel);
    quotes = res.quotes;
    warnings.push(...res.warnings);
    strategy = 'token-scan';
  }

  return {
    quotes: dedupeQuotes(quotes, warnings),
    sourceAsOf: extractAsOf(text),
    format,
    strategy,
    warnings,
  };
}

/** First occurrence of a pair wins (the page repeats some pairs in a second
 *  table with different semantics — Telegraphic Transfer vs outbound cash). */
export function dedupeQuotes(quotes, warnings = []) {
  const seen = new Map();
  for (const q of quotes) {
    const existing = seen.get(q.pair);
    if (!existing) {
      seen.set(q.pair, { ...q });
    } else {
      existing.duplicates = (existing.duplicates || 1) + 1;
      // Fill in a missing side only when it comes from the same table/strategy.
      if (existing.ask === null && q.ask !== null && existing.source === q.source) existing.ask = q.ask;
      if (existing.bid === null && q.bid !== null && existing.source === q.source) existing.bid = q.bid;
      if (existing.bid !== null && existing.ask !== null) {
        existing.mid = (existing.bid + existing.ask) / 2;
        existing.spread = existing.ask - existing.bid;
        existing.spreadPct = existing.bid ? (existing.spread / existing.bid) * 100 : null;
      }
    }
  }
  if (seen.size < quotes.length) {
    warnings.push(`collapsed ${quotes.length - seen.size} duplicate pair row(s)`);
  }
  return [...seen.values()];
}
