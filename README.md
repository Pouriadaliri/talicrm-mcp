# TaliCRM MCP server

Ask Claude about your [TaliCRM](https://talicrm.com) meetings, contacts, companies, tags and action items.

> **"What did I agree to in my meetings with Acme last month?"**
> **"Summarise everything tagged `pricing`."**
> **"Which follow ups are still open, and who are they for?"**

This is a [Model Context Protocol](https://modelcontextprotocol.io) server. It connects Claude to your own
TaliCRM account over the public read-only API.

## Security

This is the part that matters, so it is first.

- **Read only unless you choose otherwise.** Write tools are only registered if your key was created
  with **write** access. With a read-only key they do not exist at all, so Claude cannot call them
  even by mistake. The server re-checks the scope on every request, so this client can never grant
  itself write access. If anything goes wrong verifying the key, it falls back to read-only.
- **Nothing can ever be deleted.** The API has no delete endpoint, so even a write key can add and
  correct data but can never destroy it.
- **Writes cannot bypass your plan.** They go through the same quota and ownership rules as the app,
  and never trigger AI transcription or summarising (which cost money).
- Set `TALICRM_READ_ONLY=true` to force read-only even when using a write key.
- **Your data only.** Your API key is bound to your account on the server side. Every query is scoped
  to your user id and the organizations you belong to. Another person's key can never read your rows,
  and yours can never read theirs. This is enforced in the database query, not in this client.
- **The key never leaves your machine** except as a `Authorization: Bearer` header to `talicrm.com`.
  It is read from the environment only (never a CLI argument, which would be visible in `ps`), and it
  is never logged, printed, or returned to the model.
- **Only a hash is stored.** TaliCRM stores a SHA-256 of your key, never the key itself. It is shown
  once at creation. If you lose it, revoke it and make a new one.
- **Revocable instantly**, and optionally auto-expiring. Revoking takes effect on the next request.
- **Rate limited** to 120 requests/minute per key.

## Setup

### 1. Create an API key

Go to **[talicrm.com](https://talicrm.com) → Settings → API → Create API key**, and pick **Read only** or **Read and write**.
Copy it immediately: it is shown once and starts with `talicrm_sk_`.

### 2. Add it to Claude

**Claude Code**

```bash
claude mcp add talicrm --env TALICRM_API_KEY=talicrm_sk_your_key_here -- npx -y github:Pouriadaliri/talicrm-mcp
```

**Claude Desktop** — edit `claude_desktop_config.json`
(macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "talicrm": {
      "command": "npx",
      "args": ["-y", "github:Pouriadaliri/talicrm-mcp"],
      "env": {
        "TALICRM_API_KEY": "talicrm_sk_your_key_here"
      }
    }
  }
}
```

Restart Claude, then ask it: *"Use talicrm_whoami to check my CRM connection."*

> Keep the key in the `env` block. Never paste it into a chat, a prompt, or a public repo.

## Tools

| Tool | What it does |
|---|---|
| `talicrm_whoami` | The account this key belongs to, plus its organizations. Good first call. |
| `talicrm_search_meetings` | Search meetings by text, tag, contact, company or date range. Returns summaries, key points, action items, participants, tags. |
| `talicrm_get_meeting` | One meeting in full. Transcript is opt-in via `include_transcript`. |
| `talicrm_search_contacts` | Search people by name, email, phone, title, notes, company. Filter by tag. |
| `talicrm_get_contact` | One person in full, plus their 20 most recent meetings. |
| `talicrm_list_companies` | List/search companies with contact counts. |
| `talicrm_get_company` | One company plus its contacts. |
| `talicrm_list_tags` | Your tag vocabulary with contact and meeting counts. |
| `talicrm_list_tasks` | Open/done follow ups: standalone tasks and AI-extracted meeting action items. |

Transcripts are excluded by default and truncated at 20,000 characters when requested, so a long call
cannot blow up the context window. Summaries and key points are always included.

### Write tools (only with a write-access key)

These appear **only** if your key has write access. All are create/update: there is no delete.

| Tool | What it does |
|---|---|
| `talicrm_create_contact` | Add a person. Optionally attach a company and tags. |
| `talicrm_update_contact` | Change fields on a contact. Only what you send changes. |
| `talicrm_set_contact_tags` | Replace a contact's tags (send the complete set). |
| `talicrm_create_company` | Add a company. |
| `talicrm_update_company` | Change fields on a company. |
| `talicrm_create_task` | Add a follow up, optionally linked to a person and due-dated. |
| `talicrm_update_task` | Update a task, e.g. mark it done. |
| `talicrm_create_meeting_note` | Log a **typed** meeting note. No audio, and it never triggers AI. |
| `talicrm_update_meeting` | Change a meeting's title or notes. AI fields are not writable. |
| `talicrm_set_meeting_tags` | Replace a meeting's tags. |

## Configuration

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `TALICRM_API_KEY` | yes | | Your key, starting `talicrm_sk_` |
| `TALICRM_API_URL` | no | `https://talicrm.com` | Override for self-hosted instances |
| `TALICRM_READ_ONLY` | no | `false` | `true` hides the write tools even with a write-access key |

## Development

```bash
npm install
TALICRM_API_KEY=talicrm_sk_... npm start      # run over stdio
TALICRM_API_KEY=talicrm_sk_... npm run inspect # MCP Inspector UI
```

Requires Node 18+ (uses the built-in `fetch`).

## Troubleshooting

**"TALICRM_API_KEY is not set"** — the `env` block is missing or Claude was not restarted.

**"TaliCRM rejected the API key"** — it was revoked or expired. Create a new one in Settings → API.

**"Not found in your TaliCRM account"** — the id does not exist *or* it belongs to someone else. The API
deliberately does not distinguish between the two.

**Rate limited** — 120 requests/minute per key. Wait a moment.

## API

This server is a thin client over the TaliCRM public API. Full endpoint docs:
[talicrm.com/developers](https://talicrm.com/developers).

## License

MIT
