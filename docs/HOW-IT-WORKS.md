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
5. Optional **follow gate** (Instagram): the first DM asks the person to follow you. See below.

## Ask for a follow first (Instagram)

Turn on **Ask people to follow me before sending the resource** in step 3 of an automation. Then:

1. The comment gets a DM that asks for the follow, with an **«I follow you»** quick-reply button. No resource yet.
2. When the person taps the button (or writes anything), DMLand asks Meta whether they follow the account.
3. If they follow: they get the resource, or, if the automation asks for an email, DMLand asks for it next.
4. If they do not follow yet: they get a short notice with the button again, at most twice. After that DMLand only
   checks quietly each time they write.
5. If Meta does not let DMLand check: the resource goes out anyway, so nobody who asked is lost.

Good to know:

| Topic | Detail |
|---|---|
| Needs a Page token | Meta only answers "does this person follow?" (`is_user_follow_business`) with the token of the **Facebook Page linked to the Instagram account**. Connect that Page in DMLand (Meta connection → Facebook Page); DMLand tries every connected Page and remembers the one that works. Without it, the check fails and people get the resource anyway. |
| Instagram only | On a Facebook Page there is no API to know who follows the Page: the option is hidden and the resource goes out right away. |
| The tag | The contact's tag is added when the resource goes out, not when the follow is asked. |
| How long it waits | Like email capture: 3 days, then the person shows as **Did not follow** in Activity. |
| If the button is rejected | Meta may not accept the button inside the private reply; then the DM goes as text and asks them to reply «done». |
| Analytics | The API returns `follow: { asked, followed, rate }`; follow steps do not count as emails. |
| Meta's rules | Asking for a follow in exchange for a resource is common, but read Meta's current Platform Terms and Instagram's messaging policies for your use. |

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
| Meta rejects one DM temporarily | The run shows **Retrying** and is retried after 2, 10 and 30 min; after that it becomes an error |
| Error details | Every failed DM stores Meta's code, e.g. `(#10/1893063)`, so the exact cause can be looked up in Meta's error codes |
| Message size | 1000 bytes per DM (Meta limit) |

These numbers come from Meta's documentation and our own testing; check Meta's current docs, they can change.

### Facebook Pages

Facebook Pages follow the same flow: the DM goes through Messenger as a private reply to the comment,
then the public reply goes under the comment. Differences:

| Rule | Value |
|---|---|
| Sending pace | Much slower than Instagram: 2 per minute and 60 per hour per Page (see [Sending pace on Facebook Pages](#sending-pace-on-facebook-pages)). Instagram and the Page each have their own counter. |
| Comment age | Private replies only for comments under 7 days old, one per comment (same as Instagram) |
| Follow-up messages | Only within 24 hours of the person's last message (Messenger's standard window), which covers the email capture conversation |
| Message size | DMLand keeps the 1000-byte cap for both platforms. Messages with a button are cut to 640 characters (Messenger limit). |
| Which posts | The Page's 24 most recent posts and reels (a reel that is also a post shows once), top-level comments only |
| Insights | Not implemented yet: views and reach show "no data" for Pages |
| UTM links | `utm_source` is `facebook` or `instagram`, depending on the account |
| Who commented | Meta does not return who commented on a Page post. DMLand creates the contact after the DM, from the id Meta returns for the recipient. Names are not available. |

Connecting a real Page, reading its comments and sending Messenger DMs to real commenters have been checked.

### Sending pace on Facebook Pages

Meta does not publish how many private replies a Page may send, and Pages are restricted much faster than Instagram
accounts. In real use, a Page that sent about 40 near-identical DMs with links in 12 minutes was restricted
(`#10/1893063`, "You are temporarily restricted from sending messages"). After that, Meta rejected some DMs and let
others through for hours. So DMLand protects Pages in four ways:

| Protection | What it does |
|---|---|
| Page pace | At most **2 DMs per minute and 60 per hour** per Page. Attempts Meta rejected count too. The rest waits for the next minute. |
| Viral mode | When one automation's video gets **20 or more keyword comments in the last hour**, or 20 or more are still waiting for their DM, **that automation** drops to **1 DM per minute and 30 per hour for 24 hours** (the 24 hours restart while the burst lasts). The Page's other automations keep their pace. The dashboard shows a **🔥 viral · slow pace** chip and the log says when it started. |
| Restriction pause | If Meta answers `#10/1893063`, DMLand pauses **only that Page** for 60 minutes. The comment is kept (it does not spend a retry) and new comments wait. Other accounts keep sending. |
| Retries | If Meta rejects a DM with "Application does not have permission for this action" but it is not a restriction, DMLand retries after 2, 10 and 30 minutes. |

Nobody is skipped: comments wait and are answered later, as long as they are under 7 days old. A burst also happens
when DMLand was off or the computer was asleep: the comments pile up and would all go out together when it comes back.
The pace limits prevent that too.

You can change the numbers in `.env` (restart DMLand after):

| Variable | Default | Meaning |
|---|---|---|
| `FB_MAX_PER_CYCLE` | 2 | DMs per minute per Page |
| `FB_HOURLY_CAP` | 60 | DMs per hour per Page |
| `FB_VIRAL_TRIGGER` | 20 | Keyword comments (last hour, or waiting) that turn on viral mode |
| `FB_VIRAL_PER_CYCLE` | 1 | DMs per minute for a viral automation |
| `FB_VIRAL_HOURLY_CAP` | 30 | DMs per hour for a viral automation |
| `FB_VIRAL_HOURS` | 24 | How long viral mode lasts after the last burst |

Raising them is at your own risk: Meta's real limit is unknown. If your Page gets restricted, look for the notice in
**Meta Business Suite → Page quality**, and leave DMLand running: it will keep pausing and trying again slowly.

## Pages

- **Home**: your reels with views and DMs, trends, health and uptime.
- **Automations**: create and edit rules, A/B test the email request, add UTM parameters to links.
- **Activity**: live log of every comment, reply and DM.
- **Contacts**: everyone who interacted, with tags; export collected emails as CSV.
- **Analysis**: funnel (comments → DMs → emails → resource delivered), best times, top reels.
- **Brands & accounts**: connect Instagram accounts and Facebook Pages; one brand can have several.

## Project layout

```
src/server.mjs      HTTP server, dashboard API, Basic auth
src/poller.mjs      reads comments and DM replies on a timer
src/engine.mjs      matching, sending, rate limits, pause logic
src/capture.mjs     email capture and follow gate conversation
src/stats.mjs       daily snapshots, insights, uptime
src/analytics.mjs   numbers behind Home and Analysis
src/meta.mjs        Meta Graph API client (Instagram)
src/facebook.mjs    Facebook Page client (Messenger), same shapes as meta.mjs
src/platform.mjs    picks the client for an account (Instagram or Facebook)
src/db.mjs          SQLite schema and migrations (node:sqlite)
public/index.html   the whole dashboard (vanilla JS, no build step)
public/lang/*.json  one file per extra language (English is built in)
test/               tests, run with `npm test`
```

## Requirements

Node 24+. No npm dependencies, no build step, no external services except the Meta Graph API.
