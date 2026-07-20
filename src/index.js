#!/usr/bin/env node
// TaliCRM MCP server.
//
// Design rules that matter here:
// 1. stdout is the MCP protocol channel. NOTHING may be printed to it. All diagnostics go to stderr.
//    A single stray console.log would corrupt the JSON-RPC stream and break the connection.
// 2. Read and write are kept strictly apart. Write tools are registered ONLY when the key really
//    carries the write scope, discovered from the server at boot. If that check fails for any
//    reason we fall back to read-only: the safe direction. The server re-checks the scope on every
//    single request, so this client can never grant itself write access, and the annotations tell
//    the client honestly which tools mutate.
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
// Mutating. destructiveHint is false and that is the truth, not optimism: the API has no delete, so
// a write can add or amend but never removes data. Not idempotent: calling create twice makes two rows.
const WRITES = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
// Replaces a whole set (tags), so re-running it lands on the same state.
const WRITES_IDEMPOTENT = { ...WRITES, idempotentHint: true };

// Counted rather than hardcoded, so the startup line can never drift out of date as tools change.
const registered = { read: 0, write: 0 };

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

// Tally every tool as it registers, by its own annotation, so the startup line reports what is
// actually exposed and can never drift out of date as tools are added.
const _registerTool = server.registerTool.bind(server);
server.registerTool = (name, cfg, fn) => {
  if (cfg?.annotations?.readOnlyHint === false) registered.write++; else registered.read++;
  return _registerTool(name, cfg, fn);
};

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
    'the verbatim transcript. This is the tool for "give me the transcript of meeting 165" or "what was ' +
    'said in meeting 165" — pass that number as id with include_transcript true. Otherwise prefer the ' +
    'summary and key points, and only set include_transcript when you genuinely need exact wording, ' +
    'since transcripts are long.',
  inputSchema: {
    id: z.number().int().describe('Meeting id, from talicrm_search_meetings, or the #number shown on each recording in the TaliCRM app (e.g. "meeting 165")'),
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

// ---------------------------------------------------------------- writes
// Registered only when the key actually has the write scope. See the header note.
function registerWriteTools() {
  server.registerTool('talicrm_create_contact', {
    title: 'Add a contact',
    description:
      'Add a new person to the CRM. Give at least a name or an email. You can attach them to a company ' +
      '(company_id from talicrm_list_companies) and tag them (tag_ids from talicrm_list_tags). ' +
      'Check with talicrm_search_contacts first so you do not create a duplicate.',
    inputSchema: {
      first_name: z.string().optional(), last_name: z.string().optional(),
      email: z.string().optional(), phone: z.string().optional(),
      job_title: z.string().optional(), notes: z.string().optional(),
      company_id: z.number().int().optional().describe('Existing company to attach them to'),
      tag_ids: z.array(z.number().int()).optional().describe('Tag ids from talicrm_list_tags'),
      org_id: z.number().int().optional().describe('Organization to file under; defaults to personal'),
    },
    annotations: WRITES,
  }, handler((a) => api.createContact(a)));

  server.registerTool('talicrm_update_contact', {
    title: 'Update a contact',
    description: 'Change fields on an existing contact. Only the fields you send are touched; everything else is left alone.',
    inputSchema: {
      id: z.number().int().describe('Contact id'),
      first_name: z.string().optional(), last_name: z.string().optional(),
      email: z.string().optional(), phone: z.string().optional(),
      job_title: z.string().optional(), notes: z.string().optional(),
      company_id: z.number().int().optional(),
    },
    annotations: WRITES,
  }, handler(({ id, ...rest }) => api.updateContact(id, rest)));

  server.registerTool('talicrm_set_contact_tags', {
    title: 'Set a contact\'s tags',
    description:
      'REPLACE the tags on a contact with exactly this set. Passing an empty list clears them. ' +
      'To add one tag, read the contact first and send the existing tag ids plus the new one.',
    inputSchema: { id: z.number().int(), tag_ids: z.array(z.number().int()).describe('The complete tag set, not just additions') },
    annotations: WRITES_IDEMPOTENT,
  }, handler(({ id, tag_ids }) => api.setContactTags(id, tag_ids)));

  server.registerTool('talicrm_create_company', {
    title: 'Add a company',
    description: 'Add a company to the CRM. Check talicrm_list_companies first to avoid duplicates.',
    inputSchema: {
      name: z.string().describe('Company name (required)'),
      website: z.string().optional(), industry: z.string().optional(), notes: z.string().optional(),
      org_id: z.number().int().optional(),
    },
    annotations: WRITES,
  }, handler((a) => api.createCompany(a)));

  server.registerTool('talicrm_update_company', {
    title: 'Update a company',
    description: 'Change fields on an existing company. Only the fields you send are touched.',
    inputSchema: {
      id: z.number().int(), name: z.string().optional(), website: z.string().optional(),
      industry: z.string().optional(), notes: z.string().optional(),
    },
    annotations: WRITES,
  }, handler(({ id, ...rest }) => api.updateCompany(id, rest)));

  server.registerTool('talicrm_create_task', {
    title: 'Add a follow up task',
    description: 'Create a follow up. Link it to a person with contact_id so it shows against them. due_at is ISO 8601.',
    inputSchema: {
      text: z.string().describe('What needs doing'),
      due_at: z.string().optional().describe('ISO 8601 due date, e.g. 2026-08-01T09:00:00Z'),
      contact_id: z.number().int().optional(), company_id: z.number().int().optional(),
      org_id: z.number().int().optional(),
    },
    annotations: WRITES,
  }, handler((a) => api.createTask(a)));

  server.registerTool('talicrm_update_task', {
    title: 'Update or complete a task',
    description: 'Update a task. Send done=true to tick it off. Only works on standalone tasks (source "task" from talicrm_list_tasks), not on meeting action items.',
    inputSchema: {
      id: z.number().int(), text: z.string().optional(),
      done: z.boolean().optional().describe('true marks it complete'),
      due_at: z.string().optional(),
    },
    annotations: WRITES,
  }, handler(({ id, ...rest }) => api.updateTask(id, rest)));

  server.registerTool('talicrm_create_meeting_note', {
    title: 'Log a meeting note',
    description:
      'Log a TYPED meeting note (no audio). Use this to record what was discussed when there was no ' +
      'recording. It does NOT transcribe or summarise: those cost money and time, so they stay a ' +
      'deliberate in-app action. On the free plan this counts against the 5 meeting limit.',
    inputSchema: {
      title: z.string().optional().describe('Meeting title'),
      raw_notes: z.string().optional().describe('What was discussed'),
      meeting_type: z.enum(['in_person', 'virtual', 'call', 'other']).optional(),
      met_at: z.string().optional().describe('ISO 8601; defaults to now'),
      contact_id: z.number().int().optional(), company_id: z.number().int().optional(),
      tag_ids: z.array(z.number().int()).optional(), org_id: z.number().int().optional(),
    },
    annotations: WRITES,
  }, handler((a) => api.createMeeting(a)));

  server.registerTool('talicrm_update_meeting', {
    title: 'Update a meeting',
    description: 'Change a meeting\'s title or typed notes. The AI fields (summary, transcript, action items) are not editable.',
    inputSchema: { id: z.number().int(), title: z.string().optional(), raw_notes: z.string().optional() },
    annotations: WRITES,
  }, handler(({ id, ...rest }) => api.updateMeeting(id, rest)));

  server.registerTool('talicrm_set_meeting_tags', {
    title: 'Set a meeting\'s tags',
    description:
      'REPLACE the tags on a meeting with exactly this set. Passing an empty list clears them. ' +
      'Tagging meetings is what makes talicrm_search_meetings tag filters useful.',
    inputSchema: { id: z.number().int(), tag_ids: z.array(z.number().int()).describe('The complete tag set, not just additions') },
    annotations: WRITES_IDEMPOTENT,
  }, handler(({ id, tag_ids }) => api.setMeetingTags(id, tag_ids)));
}

// ---------------------------------------------------------------- lifecycle
// Ask the server what this key may do. Fail safe: any problem means read-only.
async function resolveScopes() {
  if (config.forceReadOnly) return { scopes: ['read'], reason: 'TALICRM_READ_ONLY is set' };
  try {
    const me = await api.me();
    return { scopes: me.scopes || ['read'], reason: null };
  } catch (err) {
    return { scopes: ['read'], reason: `could not verify the key (${err.message})` };
  }
}

async function main() {
  const { scopes, reason } = await resolveScopes();
  const canWrite = scopes.includes('write');
  if (canWrite) registerWriteTools();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[talicrm-mcp] v${VERSION} ready, talking to ${config.baseUrl} | ` +
    (canWrite ? `read + write (${registered.read} read, ${registered.write} write tools)`
              : `READ ONLY (${registered.read} tools)`) +
    (reason ? ` | ${reason}` : '')
  );
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
