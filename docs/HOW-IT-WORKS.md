# How DMLand works

## The flow

1. You publish a reel or post and ask people to comment a keyword ("Comment GUIDE").
2. DMLand reads new comments on your account about **once a minute**. Meta does not send comment
   webhooks to apps in development mode, so polling is what makes this work without Meta's approval.
3. When a comment matches an automation (keyword rules, specific post or all posts), DMLand:
   1. sends the **DM first** through Instagram's private reply, so a failed DM never produces a
      public "check your DMs" reply,
   2. then posts a **public reply** under the comment (random variant from your list),
   3. tags the contact and records the run.
4. Optional **email capture**: instead of sending the link right away, DMLand asks for an email.
   When the person replies, it saves the email and sends the resource.

## Safety and limits

| Rule | Value |
|---|---|
| Meta limit for private replies | about 750 per hour per Instagram account |
| DMLand's own cap | 600 per hour and 10 per minute per account, with 2–5 s between sends |
| Comment age | Meta only allows a private reply for comments under 7 days old |
| One reply per comment | The same comment is never answered twice |
| Own comments | Ignored |
| Only new comments | An automation only answers comments posted after it was activated |
| Meta pauses sending | DMLand pauses 10 min (60 min if Meta flags spam) and retries; pending comments are not lost |
| Message size | 1000 bytes per DM (Meta limit) |

These numbers come from Meta's documentation and our own testing; check Meta's current docs, they can change.

## Pages

- **Home**: your reels with views and DMs, trends, health and uptime.
- **Automations**: create and edit rules, A/B test the email request, add UTM parameters to links.
- **Activity**: live log of every comment, reply and DM.
- **Contacts**: everyone who interacted, with tags; export collected emails as CSV.
- **Analysis**: funnel (comments → DMs → emails → resource delivered), best times, top reels.
- **Brands & accounts**: connect Instagram accounts; one brand can have several.

## Project layout

```
src/server.mjs      HTTP server, dashboard API, Basic auth
src/poller.mjs      reads comments and DM replies on a timer
src/engine.mjs      matching, sending, rate limits, pause logic
src/capture.mjs     email capture conversation
src/stats.mjs       daily snapshots, insights, uptime
src/analytics.mjs   numbers behind Home and Analysis
src/meta.mjs        Meta Graph API client
src/db.mjs          SQLite schema and migrations (node:sqlite)
public/index.html   the whole dashboard (vanilla JS, no build step)
public/lang/*.json  one file per extra language (English is built in)
test/               tests, run with `npm test`
```

## Requirements

Node 24+. No npm dependencies, no build step, no external services except the Meta Graph API.
