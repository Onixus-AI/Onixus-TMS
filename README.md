# Onixus Drayage OS

Drayage TMS: dispatch, tracking, StreetTurn, client portal, FMCSA and port data.
This repo currently ships the foundation: one authenticated API over
swappable providers, the database schema, and the dispatcher web app.

## Providers

Pick each provider with one environment variable. Switching is a config
change, never a code change.

| Capability | Variable | Options |
|---|---|---|
| Email | `EMAIL_PROVIDER` | `gmail`, `microsoft` (Outlook.com, Outlook and Microsoft 365; alias `outlook`), `onyx` (Onyx Mail, coming soon) |
| CRM | `CRM_PROVIDER` | `hubspot`, `onyx` (Onyx CRM, coming soon) |
| AI model | `LLM_PROVIDER` | `claude` (default `claude-opus-5-5`), `openai`, `onyx` (OpenAI-compatible endpoint) |
| Database | `DATABASE_PROVIDER` | `supabase` |

A "coming soon" provider can be selected and answers `501 Not Implemented`;
nothing returns a fake success. A selected provider with missing credentials
answers `503` naming the variables to set, and the web app's Connections page
shows the same.

## Run locally

```bash
cp .env.example .env        # set TMS_API_KEY and the providers you use
npm install
npm run dev                 # API on :4000, web app on :5173
```

Open http://localhost:5173 and enter the `TMS_API_KEY` under Connections.

```bash
npm test                    # API + provider tests
npm run typecheck
npm run build               # web app → apps/web/dist
```

## API

Every route except `/health` requires `Authorization: Bearer $TMS_API_KEY`.

| Route | Does |
|---|---|
| `GET /providers` | Which provider each capability uses and whether it is configured |
| `POST /email/send` | `{to, subject, html, replyTo?}` from the connected mailbox |
| `GET /email/unread?limit=20` | Unread inbox messages |
| `GET /crm/companies?q=` | Search companies |
| `POST /crm/companies` | `{name, domain?, type?, phone?}` |
| `POST /crm/contacts` | `{email, firstName?, lastName?, phone?, companyId?}` |
| `POST /llm/complete` | `{prompt, system?, maxTokens?}` |

## Layout

- `packages/providers`: the email, CRM, AI and database adapters, plus the registry that picks one per capability.
- `apps/api`: the Express API (`apps/api/Dockerfile`; build from the repo root).
- `apps/web`: the Vite + React dispatcher app, deployed to Vercel.
- `supabase/migrations`: the schema. `002` turns on row-level security for every table; the API uses the service-role key.

## Deploy

```bash
./scripts/init-supabase.sh  # link, push migrations, generate types
./scripts/init-vercel.sh    # web app; set VITE_API_URL to the API's URL
```

The API runs anywhere Docker runs (for example Railway); keep every secret there, never in `VITE_` variables.

## Not built yet

- StreetTurn matching
- FMCSA monitoring and the port webhook. Their Supabase functions are still stubs, and the port webhook must verify a signature before it goes live.
- Per-organization RLS policies, for when the web app reads Supabase directly
- MCP endpoints for agents
