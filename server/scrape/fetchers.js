/**
 * Source fetching.
 *
 * Builds an ordered plan of places to get the rates from and fetches them with a
 * timeout, retries and polite headers:
 *
 *   1. any configured JSON API endpoints (WING_API_ENDPOINTS)
 *   2. the bank page itself (SOURCE_URL)
 *   3. mirrors / reader proxies (FALLBACK_SOURCES) — useful when the host's
 *      egress firewall blocks the bank but allows a reader service
 */
import { config, logger } from '../config.js';

const MAX_REDIRECTS = 5;

export async function fetchText(url, { timeoutMs = config.fetchTimeoutMs, headers = {}, attempt = 0 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': config.userAgent,
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': config.acceptLanguage,
        ...headers,
      },
    });
    const text = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      url: res.url || url,
      contentType: res.headers.get('content-type') || '',
      bytes: Buffer.byteLength(text),
      ms: Date.now() - started,
      text,
      attempt,
      error: res.ok ? null : `HTTP ${res.status}`,
    };
  } catch (err) {
    // `fetch failed` alone is useless for diagnosis — surface the cause code
    // (ENOTFOUND, ECONNREFUSED, ETIMEDOUT, EPROTO, UNABLE_TO_VERIFY_LEAF_SIGNATURE...)
    const cause = err?.cause;
    const detail = cause ? (cause.code ? `${cause.code}${cause.message ? `: ${cause.message}` : ''}` : cause.message) : '';
    return {
      ok: false,
      status: 0,
      url,
      contentType: '',
      bytes: 0,
      ms: Date.now() - started,
      text: '',
      attempt,
      error: err.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : `${err.name}: ${err.message}${detail ? ` (${detail})` : ''}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Ordered list of candidate sources. */
export function buildSourcePlan() {
  const plan = [];
  for (const endpoint of config.apiEndpoints) {
    plan.push({ label: 'api', kind: 'api', url: endpoint });
  }
  plan.push({ label: 'wingbank.com.kh', kind: 'page', url: config.sourceUrl });
  for (const template of config.fallbackSources) {
    if (!template.includes('{url}')) {
      plan.push({ label: hostOf(template), kind: 'mirror', url: template });
      continue;
    }
    plan.push({
      label: hostOf(template),
      kind: 'mirror',
      url: template.replace(/\{url\}/g, encodeURIComponent(config.sourceUrl)),
    });
    plan.push({
      label: hostOf(template),
      kind: 'mirror',
      url: template.replace(/\{url\}/g, config.sourceUrl),
    });
  }
  return plan;
}

function hostOf(u) {
  try {
    return new URL(u).host;
  } catch {
    return u.slice(0, 40);
  }
}

/**
 * Fetch one source with a small retry budget (network blips are common).
 * @returns {Promise<{ok:boolean, text:string, source:object, attempt:number, status:number, error:string|null, ms:number}>}
 */
export async function fetchSource(source, { retries = 1 } = {}) {
  let last = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) await sleep(500 * attempt);
    last = await fetchText(source.url, { attempt });
    if (last.ok && last.bytes > 0) break;
    logger.debug('fetch attempt failed', { source: source.label, url: source.url, attempt, error: last.error });
  }
  return { ...last, source };
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
