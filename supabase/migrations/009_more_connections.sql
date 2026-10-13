-- 009: More things a company can connect: its own AI model key (OpenAI,
-- Claude, Gemini, OpenRouter), an automation (Zapier, Make, n8n), chat
-- (Slack), a calendar (Google Calendar), documents (Google Drive) and a
-- report sheet (Google Sheets). Still one connection per category.

alter table connections drop constraint if exists connections_category_check;
alter table connections add constraint connections_category_check
  check (category in ('email','crm','finance','tracking','ai','automation','chat','calendar','documents','reports'));
