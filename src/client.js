// Thin HTTP client for the TaliCRM public read API (https://talicrm.com/api/v1).
//
// Security notes:
// - The API key is read from the environment only. It is never accepted as a CLI argument, because
//   argv is visible to any process via `ps`.
// - The key is never logged, never echoed back in errors, and never returned to the model.
// - Everything here is a GET. The upstream API has no write path at all, so this server cannot
//   modify or delete anything in the CRM even if the model asks it to.

const DEFAULT_BASE = 'https://talicrm.com';
const TIMEOUT_MS = 20000;

export class TaliCrmError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'TaliCrmError';
    this.status = status;
  }
}

export function loadConfig(env = process.env) {
  const apiKey = (env.TALICRM_API_KEY || '').trim();
  const baseUrl = (env.TALICRM_API_URL || DEFAULT_BASE).trim().replace(/\/+$/, '');

  if (!apiKey) {
    throw new Error(
      'TALICRM_API_KEY is not set. Create a key at https://talicrm.com/app/settings (Developers section) ' +
      'and pass it via the "env" block of your MCP config.'
    );
  }
  if (!apiKey.startsWith('talicrm_sk_')) {
    throw new Error('TALICRM_API_KEY does not look like a TaliCRM key (it should start with talicrm_sk_).');
  }
  return { apiKey, baseUrl };
}

export function createClient({ apiKey, baseUrl }) {
  async function get(path, params = {}) {
    const url = new URL(baseUrl + '/api/v1' + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }

    let res;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw new TaliCrmError(`TaliCRM did not respond within ${TIMEOUT_MS / 1000}s. Try again.`);
      }
      throw new TaliCrmError(`Could not reach TaliCRM at ${baseUrl}: ${err.message}`);
    }

    if (res.status === 401) {
      throw new TaliCrmError('TaliCRM rejected the API key. It may be revoked or expired. Create a new one in Settings > Developers.', 401);
    }
    if (res.status === 429) {
      throw new TaliCrmError('Rate limited by TaliCRM (120 requests per minute per key). Wait a moment and retry.', 429);
    }
    if (res.status === 404) {
      // The API returns 404 both for "does not exist" and "not yours". Never imply the row exists.
      throw new TaliCrmError('Not found in your TaliCRM account.', 404);
    }
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json())?.error || ''; } catch { /* ignore body parse errors */ }
      throw new TaliCrmError(`TaliCRM returned ${res.status}${detail ? ': ' + detail : ''}`, res.status);
    }
    return res.json();
  }

  return {
    me: () => get('/me'),
    contacts: (p) => get('/contacts', p),
    contact: (id) => get(`/contacts/${encodeURIComponent(id)}`),
    companies: (p) => get('/companies', p),
    company: (id) => get(`/companies/${encodeURIComponent(id)}`),
    meetings: (p) => get('/meetings', p),
    meeting: (id) => get(`/meetings/${encodeURIComponent(id)}`),
    tags: () => get('/tags'),
    tasks: (p) => get('/tasks', p),
  };
}
