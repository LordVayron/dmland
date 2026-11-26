# Content report

**Analytics → Content report** (or `#/report`) tells you which reels, hooks and posting times work for
your account. It is built from data DMLand already stores: the stats it reads every 30 minutes, the
comments and DMs of your automations, and the script of each reel if you add it.

Everything on the page comes from fixed rules. No AI is needed. An optional AI reading can be added on
top (see below).

## How a reel is judged

Each reel is compared with **your typical reel**: the median views of the reels in the period
(7 or 30 days).

| Verdict | Rule |
|---|---|
| Winner | 1.5× your typical or more |
| Normal | between 0.6× and 1.5× |
| Low | 0.6× or less |

With fewer than 3 reels in the period, nothing is judged.

## What the page shows

| Section | What it is |
|---|---|
| Totals | Views, DMs sent (and per 1,000 views), emails captured, follower change. |
| Findings | When your people comment, the winning reel, average seconds watched, how many comments use the keyword. |
| Reel ranking | Every reel with views against your typical, seconds watched, saves, shares and DMs per 1,000 views. |
| Hooks | The hooks that worked and the ones that did not, and which **traits** go with more views. |
| Posting time | Times-your-typical by posting slot (late night, morning, afternoon, evening). |
| How long a reel lives | % of its final views a reel reaches each day after posting. |
| Funnel | Views → comments → comments with the keyword → DMs → emails. |
| What to do next week | Short actions from fixed rules. An action only shows up when there is enough data behind it. |

The page can be saved as a PDF with the **PDF** button.

## Scripts and hooks

The **hook** is what is *said* in the first seconds of the video, not the caption. Meta does not give
DMLand that text, so you add it:

- In the ranking, a reel without a script shows **No script · Add**. Paste what is said in the video.
- You can paste plain text, or a JSON file shaped like `{"hook": "...", "text": "..."}` or
  `{"chapters": [{"label": "hook", "beats": [{"text": "..."}]}]}`.
- The first two sentences are taken as the hook unless the JSON names one.
- Approximate length is estimated from the word count (about 2.6 words per second).

Reels without a script still appear in the ranking; they are only left out of the hook analysis.

The hook traits are simple word rules, in English and Spanish:

| Trait | Example |
|---|---|
| Has a number | "5 tools", "three habits" |
| Is a question | "Did you know…?" |
| Says "you" | "your", "you" |
| Contrarian | "nobody", "stop", "never" |
| Names a brand or tool | ChatGPT, Notion, Instagram… |
| 12 words or fewer | short hooks |

A trait is only compared when at least 2 reels have it and 2 do not.

## Posting times

Meta returns the posting time of each reel when DMLand lists your posts. Reels read before this
version have no posting time until they are listed again (it happens on its own every 30 minutes),
so the posting-time chart fills in over time.

Instagram only lets DMLand read stats for the 12 most recent reels of each account.

## Optional: AI reading

With an [OpenRouter](https://openrouter.ai) key, an **Interpret with AI** button appears. The AI reads
the report and returns a summary, patterns in your hooks and scripts, timing advice, what to try next
week and 3 new hooks to test.

Add to `.env` and restart DMLand:

```
OPENROUTER_API_KEY=sk-or-...
# OPENROUTER_MODEL=anthropic/claude-haiku-5.5   # optional, any OpenRouter model id
```

Good to know:

- **What is sent:** only numbers, posting times, keywords, hooks and the full script of the 4 best and
  4 worst reels. Never usernames, emails, comments, account ids or tokens.
- **Where it goes:** to OpenRouter and the model you choose. Without the key nothing leaves your machine
  except your calls to Meta.
- **Cost:** a reading with the default model usually costs under a cent. The cost is shown with each
  reading.
- **Saved:** one reading per day, brand, period and language is saved. Opening the page again does not
  pay again; **Interpret again** does.
- The AI answers in the dashboard language.
