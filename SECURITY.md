# Security

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's
**Security → Report a vulnerability** form on this repository so the report stays private.

## What DMLand stores, and where

- Everything is stored locally in `data/app.db` (SQLite) on the machine that runs DMLand.
- Your Meta access token is stored in that database and shown masked (`••••1234`) in the dashboard.
- Emails collected through the "ask for email first" mode are stored in the same database and
  can be exported as CSV from the Contacts page.
- DMLand sends nothing to any third party. It only talks to the Meta Graph API. The one exception is opt-in: if you set
  `OPENROUTER_API_KEY`, the content report's **Interpret with AI** button sends numbers and reel scripts to OpenRouter
  (never usernames, emails, comments or tokens).

## Keep safe

- Never commit `.env` or `data/`. The included `.gitignore` already excludes them.
- Never paste your access token or App Secret into chats, issues or screenshots.
- The dashboard uses HTTP Basic auth over plain HTTP. Do not expose it directly to the internet.
  To reach it from your phone use a private network such as Tailscale, or put it behind an HTTPS proxy.
- You are responsible for how you use collected emails (consent, privacy laws such as GDPR).
  The default email request includes a consent line you can edit.
