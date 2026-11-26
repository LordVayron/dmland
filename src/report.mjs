// Content report: which reels, hooks and posting times work, computed ONLY with fixed rules on data DMLand already stores.
// No AI here. The optional AI reading (ai-report.mjs) takes this same object as input.
// Rule: each reel is compared with the MEDIAN views of the period's reels ("your typical"). With fewer than 3 reels nothing is judged.
// Labels are returned as keys; the dashboard turns them into text (and translates them).
import { all, run } from './db.mjs';
import { analytics } from './analytics.mjs';
import { hookTraits, TRAITS, estSeconds } from './script.mjs';

const median = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const avg = (xs) => { const s = xs.filter((x) => x != null); return s.length ? s.reduce((a, b) => a + b, 0) / s.length : null; };
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const per1k = (n, views) => (views ? r1((n / views) * 1000) : null);
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : null);
const localDay = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const dayDiff = (a, b) => Math.round((Date.parse(b + 'T12:00:00') - Date.parse(a + 'T12:00:00')) / 86400e3);
export const SLOTS = [['late_night', 0, 6], ['morning', 6, 12], ['afternoon', 12, 18], ['evening', 18, 24]];

// Saves (or replaces) the script of one reel. source: where it came from ('dashboard', a script, an import…)
export function saveScript(channelId, mediaId, g, source) {
  run(`INSERT INTO reel_scripts(channel_id, media_id, hook, script, words, source, updated_at) VALUES (?,?,?,?,?,?,datetime('now'))
       ON CONFLICT(channel_id, media_id) DO UPDATE SET hook=excluded.hook, script=excluded.script, words=excluded.words, source=excluded.source, updated_at=excluded.updated_at`,
    channelId, String(mediaId), g.hook || null, g.script || null, g.words ?? null, source ?? null);
}

export function contentReport({ brand = null, range = 30 } = {}) {
  const days = Number(range) >= 2 ? Number(range) : 7; // "today" is not enough to compare reels: use a week
  const B = brand ? 'AND ch.brand_id=?' : '', bp = brand ? [Number(brand)] : [];
  const base = analytics({ brand, range: days === 30 ? 30 : 7 });

  // ---- reels of the period with their latest stats snapshot ----
  const ids = all(`SELECT DISTINCT s.channel_id, s.media_id, md.published_at, md.permalink, md.media_type, MIN(s.day) first_day
      FROM media_stats s JOIN channels ch ON ch.id=s.channel_id LEFT JOIN media md ON md.channel_id=s.channel_id AND md.media_id=s.media_id
      WHERE s.views IS NOT NULL ${B} GROUP BY s.channel_id, s.media_id`, ...bp);
  const fromDay = localDay(Date.now() - (days - 1) * 86400e3);
  const reels = ids.map((x) => {
    const pubDay = x.published_at ? localDay(x.published_at) : x.first_day;
    if (pubDay < fromDay) return null;
    const hist = all('SELECT day, views, likes, comments, saved, shares, reach, watch_ms FROM media_stats WHERE channel_id=? AND media_id=? AND views IS NOT NULL ORDER BY day', x.channel_id, x.media_id);
    const s = hist.at(-1);
    const sc = all('SELECT hook, script, words FROM reel_scripts WHERE channel_id=? AND media_id=?', x.channel_id, x.media_id)[0] ?? null;
    const runs = all(`SELECT COUNT(*) matched, SUM(r.status='done') dms, SUM((cp.status IN ('got_email','done') AND cp.email_asked=1)) emails FROM runs r JOIN automations a ON a.id=r.automation_id
        LEFT JOIN captures cp ON cp.run_id=r.id WHERE r.status != 'dry' AND COALESCE(r.media_id, a.media_id)=? AND a.channel_id=?`, x.media_id, x.channel_id)[0];
    const auto = all(`SELECT a.keywords, a.mode FROM automations a LEFT JOIN runs r ON r.automation_id=a.id WHERE a.media_id=? AND a.channel_id=?
        GROUP BY a.id ORDER BY COUNT(r.id) DESC, a.id DESC LIMIT 1`, x.media_id, x.channel_id)[0]; // the one that handled the most comments
    let keyword = null; try { keyword = JSON.parse(auto?.keywords || '[]')[0] ?? null; } catch {}
    const pub = x.published_at ? new Date(x.published_at) : null;
    const secs = estSeconds(sc?.words);
    const watch = s.watch_ms != null ? r1(s.watch_ms / 1000) : null;
    return {
      channel_id: x.channel_id, media_id: x.media_id, permalink: x.permalink, publishedAt: x.published_at ?? null, publishedDay: pubDay,
      hour: pub ? pub.getHours() : null, dow: pub ? pub.getDay() : null,
      views: s.views ?? 0, reach: s.reach, likes: s.likes, comments: s.comments, saved: s.saved, shares: s.shares, watchSec: watch,
      estSec: secs, watchPct: watch != null && secs ? Math.min(100, Math.round((watch / secs) * 100)) : null,
      savedPer1k: per1k(s.saved ?? 0, s.views), sharesPer1k: per1k(s.shares ?? 0, s.views),
      matched: runs.matched ?? 0, dms: runs.dms ?? 0, emails: runs.emails ?? 0, dmsPer1k: per1k(runs.dms ?? 0, s.views),
      keyword, mode: auto?.mode ?? null, keywordShare: keyword && s.comments ? Math.min(100, pct(runs.matched ?? 0, s.comments)) : null,
      hook: sc?.hook ?? null, script: sc?.script ?? null, words: sc?.words ?? null,
      history: hist.map((h) => ({ day: h.day, views: h.views })),
    };
  }).filter(Boolean);

  // ---- against your typical ----
  const typical = median(reels.map((r) => r.views));
  const enough = reels.length >= 3 && typical > 0;
  for (const r of reels) {
    r.ratio = enough ? r1(r.views / typical) : null;
    r.verdict = !enough ? null : r.ratio >= 1.5 ? 'winner' : r.ratio <= 0.6 ? 'low' : 'normal';
  }
  reels.sort((a, b) => b.views - a.views);

  // ---- hooks ----
  const withHook = reels.filter((r) => r.hook && r.ratio != null);
  const hookRank = [...withHook].sort((a, b) => b.ratio - a.ratio || (b.watchPct ?? 0) - (a.watchPct ?? 0));
  const n3 = Math.min(3, Math.floor(hookRank.length / 2));
  const bestHooks = hookRank.slice(0, n3), worstHooks = n3 ? hookRank.slice(-n3).reverse() : [];
  const tagged = withHook.map((r) => ({ r, t: hookTraits(r.hook) }));
  for (const x of tagged) x.r.traits = Object.keys(x.t).filter((k) => x.t[k]);
  const traits = TRAITS.map((k) => {
    const yes = tagged.filter((x) => x.t[k]).map((x) => x.r.ratio), no = tagged.filter((x) => !x.t[k]).map((x) => x.r.ratio);
    if (yes.length < 2 || no.length < 2) return null; // without two reels on each side there is nothing to compare
    const a = avg(yes), b = avg(no);
    return { key: k, withN: yes.length, withoutN: no.length, withAvg: r1(a), withoutAvg: r1(b), lift: b ? r1(a / b) : null };
  }).filter(Boolean).sort((a, b) => Math.abs(Math.log(b.lift || 1)) - Math.abs(Math.log(a.lift || 1)));

  // ---- length ----
  const sized = reels.filter((r) => r.estSec != null && r.ratio != null);
  const shortR = sized.filter((r) => r.estSec <= 60), longR = sized.filter((r) => r.estSec > 60);
  const length = shortR.length >= 2 && longR.length >= 2 ? {
    cut: 60, short: { n: shortR.length, ratio: r1(avg(shortR.map((r) => r.ratio))), watchPct: Math.round(avg(shortR.map((r) => r.watchPct)) ?? 0) || null },
    long: { n: longR.length, ratio: r1(avg(longR.map((r) => r.ratio))), watchPct: Math.round(avg(longR.map((r) => r.watchPct)) ?? 0) || null },
  } : null;

  // ---- posting hour and day ----
  const timed = reels.filter((r) => r.hour != null && r.ratio != null);
  const slots = SLOTS.map(([key, a, b]) => { const xs = timed.filter((r) => r.hour >= a && r.hour < b); return { key, from: a, to: b, n: xs.length, ratio: xs.length ? r1(avg(xs.map((r) => r.ratio))) : null, views: xs.length ? Math.round(avg(xs.map((r) => r.views))) : null }; });
  const okSlots = slots.filter((s) => s.n >= 2);
  const bestSlot = okSlots.length >= 2 ? okSlots.reduce((m, s) => (s.ratio > m.ratio ? s : m)) : null;
  const worstSlot = okSlots.length >= 2 ? okSlots.reduce((m, s) => (s.ratio < m.ratio ? s : m)) : null;
  const byHour = Array.from({ length: 24 }, (_, h) => { const xs = timed.filter((r) => r.hour === h); return xs.length ? Math.round(avg(xs.map((r) => r.views))) : 0; });
  const byDow = Array.from({ length: 7 }, (_, d) => { const xs = timed.filter((r) => r.dow === d); return { n: xs.length, views: xs.length ? Math.round(avg(xs.map((r) => r.views))) : null }; });

  // ---- how long a reel lives: % of its final views reached each day after posting ----
  const lifeOf = (r) => {
    if (!r.history.length || r.history[0].day > r.publishedDay) return null; // without the posting-day snapshot the curve would lie
    const final = r.history.at(-1).views; if (!final) return null;
    const pts = Array(7).fill(null);
    for (const h of r.history) { const d = dayDiff(r.publishedDay, h.day); if (d >= 0 && d < 7) pts[d] = Math.round((h.views / final) * 100); }
    for (let i = 1; i < 7; i++) if (pts[i] == null && pts[i - 1] != null && i <= dayDiff(r.publishedDay, r.history.at(-1).day)) pts[i] = pts[i - 1];
    return dayDiff(r.publishedDay, r.history.at(-1).day) >= 2 ? pts : null;
  };
  const curveOf = (xs) => { const ls = xs.map(lifeOf).filter(Boolean); return ls.length ? { n: ls.length, pts: Array.from({ length: 7 }, (_, i) => { const v = ls.map((l) => l[i]).filter((x) => x != null); return v.length ? Math.round(avg(v)) : null; }) } : null; };
  const life = { winners: curveOf(reels.filter((r) => r.verdict === 'winner')), others: curveOf(reels.filter((r) => r.verdict && r.verdict !== 'winner')) };
  const at48 = life.others?.pts[1] ?? null;

  // ---- funnel ----
  const sum = (k) => reels.reduce((s, r) => s + (r[k] ?? 0), 0);
  const emailDms = reels.filter((r) => r.mode === 'email').reduce((s, r) => s + r.dms, 0); // only reels that ask for the email
  const tv = sum('views'), tc = sum('comments'), tm = sum('matched'), td = sum('dms'), te = sum('emails');
  const funnel = [
    { key: 'views', n: tv },
    { key: 'comments', n: tc, rate: tv ? r1((tc / tv) * 100) : null },
    { key: 'matched', n: tm, rate: pct(tm, tc) },
    { key: 'dms', n: td, rate: pct(td, tm) },
    { key: 'emails', n: te, rate: pct(te, emailDms), of: emailDms },
  ];

  // ---- keywords ----
  const keywords = reels.filter((r) => r.keyword && r.keywordShare != null && r.comments >= 5).map((r) => ({ keyword: r.keyword, share: r.keywordShare, comments: r.comments, media_id: r.media_id, channel_id: r.channel_id }))
    .sort((a, b) => b.share - a.share);

  // ---- totals ----
  const ins = base.insights.series.slice(-days);
  const accViews = ins.length ? ins.reduce((s, x) => s + (x.views ?? 0), 0) : tv;
  const kpis = {
    views: accViews, viewsFromAccount: ins.length > 0,
    reels: reels.length, dms: base.totals.dms, emails: base.totals.emails,
    dmsPer1k: per1k(base.totals.dms, accViews),
    emailRate: pct(base.totals.emails, base.totals.asked),
    followersDelta: base.followers.delta, followers: base.followers.latest,
  };

  // ---- findings and actions (fixed rules) ----
  const top = reels.find((r) => r.verdict === 'winner') ?? null;
  const ret = reels.filter((r) => r.watchSec != null);
  const findings = {
    peak: base.heatmap.peakHours, peakDay: base.heatmap.peak?.dow ?? null, commentsInPeak: (() => { const ph = base.heatmap.peakHours; if (!ph) return null; const g = base.heatmap.grid; let inP = 0, tot = 0; for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) { tot += g[d][h]; if ([ph.from, (ph.from + 1) % 24, (ph.from + 2) % 24].includes(h)) inP += g[d][h]; } return pct(inP, tot); })(),
    top: top ? { media_id: top.media_id, channel_id: top.channel_id, ratio: top.ratio, views: top.views, hook: top.hook } : null,
    watch: ret.length ? { avg: r1(avg(ret.map((r) => r.watchSec))), best: ret.reduce((m, r) => (r.watchSec > m.watchSec ? r : m)) } : null,
    keyword: keywords.length ? { avg: Math.round(avg(keywords.map((k) => k.share))), best: keywords[0], worst: keywords.at(-1) } : null,
  };
  // Each action is a key plus its values; the dashboard writes the sentence
  const actions = [];
  if (bestSlot && worstSlot && bestSlot.key !== worstSlot.key && bestSlot.ratio >= worstSlot.ratio * 1.3) actions.push({ key: 'slot', v: { best: bestSlot.key, bestRatio: bestSlot.ratio, bestN: bestSlot.n, worst: worstSlot.key, worstRatio: worstSlot.ratio, worstN: worstSlot.n, few: bestSlot.n < 5 } });
  else if (findings.peak) actions.push({ key: 'peak', v: { from: findings.peak.from } });
  const tr = traits.find((t) => t.lift >= 1.3 && t.withN >= 2);
  if (tr) actions.push({ key: 'repeatTrait', v: { trait: tr.key, withAvg: tr.withAvg, withoutAvg: tr.withoutAvg, withN: tr.withN, withoutN: tr.withoutN } });
  const trBad = traits.find((t) => t.lift && t.lift <= 0.75 && t.withN >= 2);
  if (trBad) actions.push({ key: 'avoidTrait', v: { trait: trBad.key, withAvg: trBad.withAvg, withoutAvg: trBad.withoutAvg } });
  if (length && Math.abs(length.short.ratio - length.long.ratio) >= 0.3) actions.push({ key: length.short.ratio > length.long.ratio ? 'keepShort' : 'keepLong', v: { short: length.short.ratio, shortN: length.short.n, long: length.long.ratio, longN: length.long.n } });
  if (findings.keyword && findings.keyword.best.keyword !== findings.keyword.worst.keyword && findings.keyword.best.share - findings.keyword.worst.share >= 15) actions.push({ key: 'keyword', v: { best: findings.keyword.best.keyword, bestShare: findings.keyword.best.share, worst: findings.keyword.worst.keyword, worstShare: findings.keyword.worst.share } });
  if (at48 != null && at48 >= 75) actions.push({ key: 'push48', v: { pct: at48 } });
  const noScript = reels.filter((r) => !r.hook).length;

  return {
    generatedAt: new Date().toISOString(), days, from: fromDay, brand, typical, enough,
    kpis, findings, reels, bestHooks, worstHooks, traits, length, slots, bestSlot, byHour, byDow,
    heatmap: base.heatmap, life, funnel, keywords, actions, noScript,
  };
}
