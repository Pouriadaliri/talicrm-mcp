// Thin HTTP client for the TaliCRM public read API (https://talicrm.com/api/v1).
//
// Security notes:
// - The API key is read from the environment only. It is never accepted as a CLI argument, because
//   argv is visible to any process via `ps`.
// - The key is never logged, never echoed back in errors, and never returned to the model.
// - Reads are always available. Writes exist only if the key was created with the write scope, and
//   the server re-checks that on every request: this client cannot grant itself write access.
// - There is no delete method here because the upstream API has no delete endpoint at all. Nothing
//   the model does can destroy CRM data.

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
  // Safety valve: force read only even when the key itself carries the write scope. Useful when you
  // want Claude analysing your CRM with no possibility of it changing anything.
  const forceReadOnly = /^(1|true|yes)$/i.test(String(env.TALICRM_READ_ONLY || ''));

  if (!apiKey) {
    throw new Error(
      'TALICRM_API_KEY is not set. Create a key at https://talicrm.com/app/settings (Developers section) ' +
      'and pass it via the "env" block of your MCP config.'
    );
  }
  if (!apiKey.startsWith('talicrm_sk_')) {
    throw new Error('TALICRM_API_KEY does not look like a TaliCRM key (it should start with talicrm_sk_).');
  }
  return { apiKey, baseUrl, forceReadOnly };
}

export function createClient({ apiKey, baseUrl }) {
  async function call(method, path, { params = {}, body } = {}) {
    const url = new URL(baseUrl + '/api/v1' + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }

    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw new TaliCrmError(`TaliCRM did not respond within ${TIMEOUT_MS / 1000}s. Try again.`);
      }
      throw new TaliCrmError(`Could not reach TaliCRM at ${baseUrl}: ${err.message}`);
    }

    if (res.status === 401) {
      throw new TaliCrmError('TaliCRM rejected the API key. It may be revoked or expired. Create a new one in Settings > API.', 401);
    }
    if (res.status === 403) {
      let detail = '';
      try { detail = (await res.json())?.error || ''; } catch { /* ignore */ }
      throw new TaliCrmError(detail || 'This API key is read only. Create a key with write access in Settings > API to change data.', 403);
    }
    if (res.status === 402) {
      let detail = '';
      try { detail = (await res.json())?.error || ''; } catch { /* ignore */ }
      throw new TaliCrmError(detail || 'Plan limit reached.', 402);
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

  const get = (path, params) => call('GET', path, { params });
  const enc = (id) => encodeURIComponent(id);

  return {
    // ---- reads (any key) ----
    me: () => get('/me'),
    contacts: (p) => get('/contacts', p),
    contact: (id) => get(`/contacts/${enc(id)}`),
    companies: (p) => get('/companies', p),
    company: (id) => get(`/companies/${enc(id)}`),
    meetings: (p) => get('/meetings', p),
    meeting: (id) => get(`/meetings/${enc(id)}`),
    tags: () => get('/tags'),
    tasks: (p) => get('/tasks', p),

    // ---- writes (write scope only; the server enforces this, not us) ----
    createContact: (b) => call('POST', '/contacts', { body: b }),
    updateContact: (id, b) => call('PATCH', `/contacts/${enc(id)}`, { body: b }),
    setContactTags: (id, tag_ids) => call('PUT', `/contacts/${enc(id)}/tags`, { body: { tag_ids } }),
    createCompany: (b) => call('POST', '/companies', { body: b }),
    updateCompany: (id, b) => call('PATCH', `/companies/${enc(id)}`, { body: b }),
    createTask: (b) => call('POST', '/tasks', { body: b }),
    updateTask: (id, b) => call('PATCH', `/tasks/${enc(id)}`, { body: b }),
    createMeeting: (b) => call('POST', '/meetings', { body: b }),
    updateMeeting: (id, b) => call('PATCH', `/meetings/${enc(id)}`, { body: b }),
    setMeetingTags: (id, tag_ids) => call('PUT', `/meetings/${enc(id)}/tags`, { body: { tag_ids } }),
  };
}
