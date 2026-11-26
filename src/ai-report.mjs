// Optional AI reading of the content report, through OpenRouter. Without OPENROUTER_API_KEY the button does not show.
// Only numbers, times and the reels' SCRIPTS are sent. Never usernames, emails, comments or tokens.
import { get, run } from './db.mjs';
import { contentReport } from './report.mjs';

export const aiModel = () => process.env.OPENROUTER_MODEL || 'anthropic/claude-haiku-5.5';
export const aiEnabled = () => !!process.env.OPENROUTER_API_KEY;
const LANGS = { en: 'English', es: 'Spanish' };
const langOf = (l) => (LANGS[l] ? l : 'en');
const keyOf = ({ brand, range, lang }) => `${brand || 'all'}|${range}|${lang}|${new Date().toLocaleDateString('sv')}`; // one per day, brand, period and language

export function cachedInterpretation(opts) {
  const row = get('SELECT * FROM report_ai WHERE key=?', keyOf({ ...opts, lang: langOf(opts.lang) }));
  return row ? { ...JSON.parse(row.content), model: row.model, cost: row.cost, createdAt: row.created_at, cached: true } : null;
}

// What the model sees: compact and without personal data
export function aiInput(rep) {
  const ranked = rep.reels.filter((r) => r.ratio != null);
  const withScript = ranked.filter((r) => r.script);
  const deep = new Set([...withScript.slice(0, 4), ...withScript.slice(-4)].map((r) => r.media_id)); // full script: the 4 best and the 4 worst
  return {
    period_days: rep.days, reels: rep.kpis.reels, typical_views_median: rep.typical,
    totals: { views: rep.kpis.views, dms: rep.kpis.dms, emails: rep.kpis.emails, dms_per_1000_views: rep.kpis.dmsPer1k, followers_change: rep.kpis.followersDelta },
    comment_peak_hours: rep.findings.peak ? `${rep.findings.peak.from}:00-${rep.findings.peak.to}:00` : null,
    posting_slots: rep.slots.filter((s) => s.n).map((s) => ({ slot: `${s.from}:00-${s.to}:00`, reels: s.n, times_typical: s.ratio })),
    hook_traits: rep.traits.map((t) => ({ trait: t.key, with: `${t.withAvg}x (${t.withN} reels)`, without: `${t.withoutAvg}x (${t.withoutN} reels)` })),
    funnel: rep.funnel.map((f) => ({ step: f.key, n: f.n, rate_pct: f.rate ?? null })),
    reels_detail: ranked.map((r) => ({
      verdict: r.verdict, times_typical: r.ratio, views: r.views, avg_seconds_watched: r.watchSec, approx_length_seconds: r.estSec,
      saves_per_1000: r.savedPer1k, shares_per_1000: r.sharesPer1k, dms_per_1000: r.dmsPer1k, keyword: r.keyword, dm_mode: r.mode, emails: r.mode === 'email' ? r.emails : undefined, pct_comments_with_keyword: r.keywordShare,
      posted: r.publishedAt ? new Date(r.publishedAt).toLocaleString('en-US', { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : null,
      hook: r.hook, script: deep.has(r.media_id) ? r.script : undefined,
    })),
  };
}

const system = (lang) => `You are a content strategist for Instagram reels. You analyze REAL data from one account and give concrete, useful conclusions.
Rules:
- Use only the data you receive. Do not invent numbers. If something rests on fewer than 3 reels, say so.
- "times_typical" compares the reel's views with the account's median (1 = normal).
- The hook is what is SAID in the first seconds of the video. The script is everything that is said. Some scripts may be spelled phonetically for a voice-over.
- Compare the scripts of winning reels against the rest: structure, promise, pace, topic, when the proof shows up.
- Fixed context: a bot answers every keyword comment by itself and sends the DM within seconds, at any hour. Never recommend "replying at a certain time". Only some reels ask for the email first (email mode); the rest send the link directly, so few emails does not mean the DM fails.
- Mention only tools, brands and hooks that appear in the data. The focus is improving the CONTENT: hooks, scripts, topics and posting time.
- Write in ${LANGS[lang]}, short sentences, no filler, no emojis. New hooks go in the language of the account's scripts.
Reply ONLY with valid JSON shaped like:
{"summary":"2-3 sentences with what matters most","hook_patterns":["..."],"script_patterns":["..."],"timing":"1-2 sentences","try_next":["concrete actions for next week"],"new_hooks":[{"text":"new hook","why":"which pattern in the data it builds on"}]}
2 to 4 items per list; exactly 3 new_hooks on the account's topic.`;

function parseJson(text) {
  const t = String(text || '').replace(/^```(?:json)?\s*|\s*```$/g, '');
  try { return JSON.parse(t); } catch {}
  const m = t.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]);
  throw new Error('The AI did not return valid JSON');
}

export async function interpret({ brand = null, range = 30, lang = 'en', force = false } = {}, fetchImpl = fetch) {
  if (!aiEnabled()) throw new Error('OPENROUTER_API_KEY is missing in the .env file');
  const opts = { brand, range, lang: langOf(lang) };
  if (!force) { const c = cachedInterpretation(opts); if (c) return c; }
  const rep = contentReport({ brand, range });
  if (rep.reels.length < 3) throw new Error('At least 3 reels with data are needed');
  const res = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'X-Title': 'DMLand' },
    body: JSON.stringify({
      model: aiModel(), temperature: 0.4, max_tokens: 7000, usage: { include: true }, reasoning: { effort: 'low', exclude: true },
      messages: [{ role: 'system', content: system(opts.lang) }, { role: 'user', content: JSON.stringify(aiInput(rep)) }],
    }),
    signal: AbortSignal.timeout(90000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(`OpenRouter: ${body.error?.message || res.status}`);
  const out = parseJson(body.choices?.[0]?.message?.content);
  const cost = body.usage?.cost ?? null, model = body.model || aiModel();
  run(`INSERT INTO report_ai(key, model, cost, content) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET model=excluded.model, cost=excluded.cost, content=excluded.content, created_at=CURRENT_TIMESTAMP`,
    keyOf(opts), model, cost, JSON.stringify(out));
  return { ...out, model, cost, createdAt: new Date().toISOString().slice(0, 19).replace('T', ' '), cached: false };
}
