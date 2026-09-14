/**
 * Git-backed persistence — commit dataset files back to this repository over
 * the GitHub Contents API.
 *
 * Why this exists: a serverless host (Vercel) has a read-only filesystem, so a
 * cron that scrapes the board has nowhere to put the result. This repository
 * already treats git as its database (`.github/workflows/track.yml` commits the
 * dataset), so the Vercel daily-snapshot cron writes the *daily* file the same
 * way. The subsequent redeploy ships the fresh file with the bundle, and the
 * dashboard's graph data grows one row per day with no extra service.
 *
 * Zero dependencies: plain `fetch` against `api.github.com`. Needs a token with
 * `contents: write` on this repo (`GITHUB_DATA_TOKEN`, e.g. a fine-grained PAT).
 * When no token is configured every write is a polite no-op, so the cron still
 * reports what it captured.
 */
import { logger } from './config.js';

export function createGitStore({ token = '', repo = '', branch = 'main', apiUrl = 'https://api.github.com' } = {}) {
  const enabled = Boolean(token && repo);

  function url(path) {
    return `${apiUrl.replace(/\/+$/, '')}/repos/${repo}/contents/${path.replace(/^\/+/, '')}`;
  }

  function headers(extra = {}) {
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'usd-khr-tracker',
      ...extra,
    };
  }

  async function request(method, path, body) {
    const res = await fetch(url(path), {
      method,
      headers: headers(body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    let payload = null;
    try {
      payload = await res.json();
    } catch {
      /* 204 / non-JSON */
    }
    return { ok: res.ok, status: res.status, payload };
  }

  return {
    enabled,
    repo,
    branch,

    /** @returns {Promise<{content:string, sha:string}|null>} null when the file does not exist yet. */
    async readFile(path) {
      if (!enabled) return null;
      const res = await request('GET', `${path}?ref=${encodeURIComponent(branch)}`);
      if (!res.ok) {
        if (res.status !== 404) logger.warn('git: read failed', { path, status: res.status, message: res.payload?.message });
        return null;
      }
      const raw = res.payload?.content || '';
      return {
        content: Buffer.from(raw, res.payload?.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8'),
        sha: res.payload?.sha || null,
      };
    },

    /** Create-or-update one file. `sha` must be the current blob sha when updating. */
    async writeFile(path, content, { message, sha = null } = {}) {
      if (!enabled) return { ok: false, error: 'git store disabled (no token/repo)', status: 0 };
      const res = await request('PUT', path, {
        message: message || `data: update ${path}`,
        content: Buffer.from(content, 'utf8').toString('base64'),
        branch,
        ...(sha ? { sha } : {}),
      });
      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          error: res.status === 409 ? 'conflict: file changed upstream' : res.payload?.message || `HTTP ${res.status}`,
        };
      }
      return {
        ok: true,
        status: res.status,
        created: res.status === 201,
        commit: res.payload?.commit?.sha || null,
        contentSha: res.payload?.content?.sha || null,
      };
    },

    /**
     * Write `path` with `build(current)` as its new content, retrying once when
     * another writer (the Actions tracker) landed a commit in between.
     */
    async updateFile(path, build, { message } = {}) {
      if (!enabled) return { ok: false, error: 'git store disabled (no token/repo)', status: 0 };
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const current = await this.readFile(path);
        const content = build(current?.content ?? '');
        if (content === current?.content) return { ok: true, unchanged: true };
        const res = await this.writeFile(path, content, { message, sha: current?.sha });
        if (res.ok || res.status !== 409 || attempt === 2) return res;
        logger.warn('git: retrying after conflict', { path, attempt });
      }
      return { ok: false, error: 'unreachable' };
    },
  };
}
