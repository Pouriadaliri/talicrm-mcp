#!/usr/bin/env node
// TaliCRM MCP server.
//
// Design rules that matter here:
// 1. stdout is the MCP protocol channel. NOTHING may be printed to it. All diagnostics go to stderr.
//    A single stray console.log would corrupt the JSON-RPC stream and break the connection.
// 2. Every tool is read-only and is annotated as such, so a client can surface that honestly and
//    never has to ask the user to approve a "write".
// 3. The API key comes from the environment, is scoped to exactly one TaliCRM account by the server,
//    and is never logged or returned. Two people running this server can never see each other's data.
// 4. Context economy: transcripts can be enormous, so they are opt-in and truncated.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig, createClient, TaliCrmError } from './client.js';

const VERSION = '1.0.0';
const MAX_TRANSCRIPT_CHARS = 20000;

// Read-only, talks to a remote API, safe to repeat.
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}
function fail(err) {
  const msg = err instanceof TaliCrmError ? err.message : `Unexpected error: ${err.message}`;
  return { content: [{ type: 'text', text: msg }], isError: true };
}
// Wrap every handler so a thrown error becomes a clean tool error instead of killing the process.
function handler(fn) {
  return async (args) => {
    try { return ok(await fn(args || {})); } catch (err) { return fail(err); }
  };
}

const config = (() => {
  try { return loadConfig(); } catch (err) {
    console.error('[talicrm-mcp] ' + err.message);
    process.exit(1);
  }
})();
const api = createClient(config);

const server = new McpServer({ name: 'talicrm', version: VERSION });

// ---------------------------------------------------------------- account
server.registerTool('talicrm_whoami', {
  title: 'Who am I in TaliCRM',
  description:
    'Return the TaliCRM account this API key belongs to, plus the organizations it can see. ' +
    'Use this to confirm the connection works and to learn which account you are querying. ' +
    'Every other tool is scoped to exactly this account.',
  inputSchema: {},
  annotations: READ_ONLY,
}, handler(() => api.me()));

// ---------------------------------------------------------------- meetings
server.registerTool('talicrm_search_meetings', {
  title: 'Search meetings',
  description:
    'Search the user\'s meetings (in person, calls, and recorded video calls). Returns each meeting\'s ' +
    'title, date, type, duration, participants, AI summary, key points, action items and tags. ' +
    'Full-text search covers title, summary, transcript and participants. ' +
    'Use filters to narrow down: tag (e.g. "pricing"), contact_id, company_id, or a from/to date range. ' +
    'This is the right tool for questions like "what did we discuss with Acme last month" or ' +
    '"summarise my meetings tagged pricing". Transcripts are NOT included here: call talicrm_get_meeting ' +
    'for a specific meeting if you need the verbatim text.',
  inputSchema: {
    query: z.string().optional().describe('Free text to match against title, summary, transcript and participants'),
    tag: z.string().optional().describe('Only meetings carrying this tag name (case insensitive)'),
    contact_id: z.number().int().optional().describe('Only meetings linked to this contact'),
    company_id: z.number().int().optional().describe('Only meetings linked to this company'),
    from: z.string().optional().describe('Earliest meeting date, ISO 8601 (e.g. 2026-01-01)'),
    to: z.string().optional().describe('Latest meeting date, ISO 8601'),
    archived: z.boolean().optional().describe('Include archived meetings (default false)'),
    limit: z.number().int().min(1).max(100).optional().describe('Max results, 1 to 100 (default 25)'),
    offset: z.number().int().min(0).optional().describe('Offset for paging through results'),
  },
  annotations: READ_ONLY,
}, handler((a) => api.meetings({ ...a, archived: a.archived ? 'true' : undefined })));

server.registerTool('talicrm_get_meeting', {
  title: 'Get one meeting',
  description:
    'Get a single meeting in full: summary, key points, action items, participants, tags, and optionally ' +
    'the verbatim transcript. Prefer the summary and key points when answering; only set ' +
    'include_transcript when you genuinely need exact wording, since transcripts are long.',
  inputSchema: {
    id: z.number().int().describe('Meeting id, from talicrm_search_meetings'),
    include_transcript: z.boolean().optional().describe('Include the full transcript text (default false)'),
  },
  annotations: READ_ONLY,
}, handler(async ({ id, include_transcript }) => {
  const m = await api.meeting(id);
  if (!include_transcript) {
    const had = !!m.transcript;
    delete m.transcript;
    m.transcript_available = had;
    m.transcript_note = had ? 'Call again with include_transcript=true to read the verbatim transcript.' : null;
  } else if (m.transcript && m.transcript.length > MAX_TRANSCRIPT_CHARS) {
    m.transcript = m.transcript.slice(0, MAX_TRANSCRIPT_CHARS);
    m.transcript_truncated = `Truncated to the first ${MAX_TRANSCRIPT_CHARS} characters.`;
  }
  return m;
}));

// ---------------------------------------------------------------- contacts
server.registerTool('talicrm_search_contacts', {
  title: 'Search contacts',
  description:
    'Search the people in the user\'s CRM. Matches name, email, phone, job title, notes and company name. ' +
    'Filter by tag or company_id. Returns each contact with their company and tags. ' +
    'Use talicrm_get_contact for one person\'s full record plus their recent meetings.',
  inputSchema: {
    query: z.string().optional().describe('Free text: name, email, phone, job title, notes, company'),
    tag: z.string().optional().describe('Only contacts carrying this tag name (case insensitive)'),
    company_id: z.number().int().optional().describe('Only contacts at this company'),
    limit: z.number().int().min(1).max(100).optional().describe('Max results, 1 to 100 (default 25)'),
    offset: z.number().int().min(0).optional().describe('Offset for paging'),
  },
  annotations: READ_ONLY,
}, handler((a) => api.contacts(a)));

server.registerTool('talicrm_get_contact', {
  title: 'Get one contact',
  description:
    'Get a single contact in full: details, custom fields, company, tags, and their 20 most recent ' +
    'meetings (with summaries and action items). Best tool for "what is going on with <person>".',
  inputSchema: { id: z.number().int().describe('Contact id, from talicrm_search_contacts') },
  annotations: READ_ONLY,
}, handler(({ id }) => api.contact(id)));

// ---------------------------------------------------------------- companies
server.registerTool('talicrm_list_companies', {
  title: 'List companies',
  description: 'List or search companies in the CRM, with a contact count for each. Matches name, industry, website and notes.',
  inputSchema: {
    query: z.string().optional().describe('Free text: name, industry, website, notes'),
    limit: z.number().int().min(1).max(100).optional().describe('Max results, 1 to 100 (default 25)'),
    offset: z.number().int().min(0).optional().describe('Offset for paging'),
  },
  annotations: READ_ONLY,
}, handler((a) => api.companies(a)));

server.registerTool('talicrm_get_company', {
  title: 'Get one company',
  description: 'Get a single company plus the contacts who work there.',
  inputSchema: { id: z.number().int().describe('Company id, from talicrm_list_companies') },
  annotations: READ_ONLY,
}, handler(({ id }) => api.company(id)));

// ---------------------------------------------------------------- tags
server.registerTool('talicrm_list_tags', {
  title: 'List tags',
  description:
    'List the user\'s tag vocabulary with how many contacts and meetings carry each tag. ' +
    'Call this first when the user mentions a tag by name, so you filter with a tag that actually exists.',
  inputSchema: {},
  annotations: READ_ONLY,
}, handler(() => api.tags()));

// ---------------------------------------------------------------- tasks
server.registerTool('talicrm_list_tasks', {
  title: 'List tasks and action items',
  description:
    'List the user\'s follow ups: both standalone tasks and action items extracted from meetings by AI. ' +
    'Each item says which meeting, person and company it came from. Defaults to open items only.',
  inputSchema: {
    status: z.enum(['open', 'done', 'all']).optional().describe('Which items to return (default open)'),
  },
  annotations: READ_ONLY,
}, handler((a) => api.tasks(a)));

// ---------------------------------------------------------------- lifecycle
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[talicrm-mcp] v${VERSION} ready, talking to ${config.baseUrl} (read-only)`);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    try { await server.close(); } catch { /* shutting down anyway */ }
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[talicrm-mcp] fatal: ' + err.message);
  process.exit(1);
});
