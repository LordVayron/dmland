// Analytics: everything is computed from what the program already stores. "Today" and the days use your computer's LOCAL date.
// Rows from before a data point existed (for example speed) are ignored instead of inventing values.
import { all } from './db.mjs';

const RANGES = { today: 1, '1': 1, '7': 7, '30': 30 };
export const rangeDays = (r) => RANGES[String(r)] ?? 7;
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : null);
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const sec = (a, b) => (Date.parse(b) - Date.parse(a)) / 1000;

export function analytics({ brand = null, range = 7 } = {}) {
  const days = rangeDays(range);
  const B = brand ? 'AND ch.brand_id=?' : '', bp = brand ? [Number(brand)] : [];
  const runsFrom = `FROM runs r JOIN automations a ON a.id=r.automation_id JOIN channels ch ON ch.id=a.channel_id WHERE r.status != 'dry' ${B}`;
  const capsFrom = `FROM captures cp JOIN channels ch ON ch.id=cp.channel_id WHERE 1=1 ${B}`;
  const inR = (col, n = days) => `date(${col},'localtime') >= date('now','localtime','-${n - 1} days')`;
  const n1 = (sql, ...p) => all(sql, ...p)[0].n;

  // ---- funnel ----
  const comments = n1(`SELECT COUNT(*) n ${runsFrom} AND ${inR('r.created_at')}`, ...bp);
  const dms = n1(`SELECT COUNT(*) n ${runsFrom} AND r.status='done' AND ${inR('r.created_at')}`, ...bp);
  const linkDms = n1(`SELECT COUNT(*) n ${runsFrom} AND r.status='done' AND a.mode='link' AND ${inR('r.created_at')}`, ...bp);
  const errors = n1(`SELECT COUNT(*) n ${runsFrom} AND r.status='error' AND ${inR('r.created_at')}`, ...bp);
  const asked = n1(`SELECT COUNT(*) n ${capsFrom} AND ${inR('cp.created_at')}`, ...bp);
  const replied = n1(`SELECT COUNT(*) n ${capsFrom} AND cp.last_msg_at > cp.asked_at AND ${inR('cp.created_at')}`, ...bp);
  const emails = n1(`SELECT COUNT(*) n ${capsFrom} AND cp.status IN ('got_email','done') AND ${inR('cp.created_at')}`, ...bp);
  const emailDelivered = n1(`SELECT COUNT(*) n ${capsFrom} AND cp.status='done' AND ${inR('cp.created_at')}`, ...bp);
  const delivered = emailDelivered + linkDms;
  const funnel = [
    { key: 'comments', n: comments },
    { key: 'dms', n: dms, rate: pct(dms, comments) },
    { key: 'emails', n: emails, rate: pct(emails, asked), of: asked },           // of those who received the email question
    { key: 'delivered', n: delivered, rate: pct(delivered, emails + linkDms) },  // of those who could already receive the resource
  ];

  // ---- 30-day series ----
  const dayList = all(`WITH RECURSIVE d(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM d WHERE i<29)
                       SELECT date('now','localtime','-'||(29-i)||' days') AS d FROM d`).map((x) => x.d);
  const byDay = (rows) => Object.fromEntries(rows.map((x) => [x.d, x.n]));
  const dmsBy = byDay(all(`SELECT date(r.created_at,'localtime') d, COUNT(*) n ${runsFrom} AND r.status='done' AND ${inR('r.created_at', 30)} GROUP BY d`, ...bp));
  const comBy = byDay(all(`SELECT date(r.created_at,'localtime') d, COUNT(*) n ${runsFrom} AND ${inR('r.created_at', 30)} GROUP BY d`, ...bp));
  const emailRows = `FROM contacts c JOIN channels ch ON ch.id=c.channel_id WHERE json_extract(c.fields,'$.email') IS NOT NULL ${B}`;
  const emBy = byDay(all(`SELECT date(json_extract(c.fields,'$.email_at'),'localtime') d, COUNT(*) n ${emailRows} AND ${inR("json_extract(c.fields,'$.email_at')", 30)} GROUP BY d`, ...bp));
  const series30 = dayList.map((d) => ({ date: d, dms: dmsBy[d] ?? 0, emails: emBy[d] ?? 0, comments: comBy[d] ?? 0 }));

  // ---- email list growth ----
  const totalEmails = n1(`SELECT COUNT(*) n ${emailRows}`, ...bp);
  const inWindow = series30.reduce((a, x) => a + x.emails, 0);
  let acc = totalEmails - inWindow;
  const cumulative = series30.map((x) => ({ date: x.date, total: (acc += x.emails) }));
  const week = series30.slice(-7).reduce((a, x) => a + x.emails, 0);

  // ---- when do people comment? (last 30 days, weekday x hour) ----
  const T = 'COALESCE(r.comment_at, r.created_at)';
  const cells = all(`SELECT CAST(strftime('%w', ${T}, 'localtime') AS INTEGER) dow, CAST(strftime('%H', ${T}, 'localtime') AS INTEGER) hr, COUNT(*) n
                     ${runsFrom} AND ${inR(T, 30)} GROUP BY dow, hr`, ...bp);
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const c of cells) grid[c.dow][c.hr] = c.n;
  const peak = cells.length ? cells.reduce((m, c) => (c.n > m.n ? c : m)) : null;
  const byHour = Array(24).fill(0); cells.forEach((c) => { byHour[c.hr] += c.n; });
  const peakHours = byHour.some(Boolean) ? (() => { let best = 0, h = 0; for (let i = 0; i < 24; i++) { const s = byHour[i] + byHour[(i + 1) % 24] + byHour[(i + 2) % 24]; if (s > best) { best = s; h = i; } } return { from: h, to: (h + 3) % 24 }; })() : null;

  // ---- send results ----
  const st = Object.fromEntries(all(`SELECT r.status s, COUNT(*) n ${runsFrom} AND ${inR('r.created_at')} GROUP BY r.status`, ...bp).map((x) => [x.s, x.n]));
  const outcomes = { sent: st.done ?? 0, waiting: st.pending ?? 0, error: st.error ?? 0 };

  // ---- per brand ----
  const brands = all('SELECT id, name FROM brands ORDER BY id').filter((b) => !brand || b.id === Number(brand)).map((b) => {
    const rb = `FROM runs r JOIN automations a ON a.id=r.automation_id JOIN channels ch ON ch.id=a.channel_id WHERE r.status != 'dry' AND ch.brand_id=?`;
    const sent = n1(`SELECT COUNT(*) n ${rb} AND r.status='done' AND ${inR('r.created_at')}`, b.id);
    const total = n1(`SELECT COUNT(*) n ${rb} AND ${inR('r.created_at')}`, b.id);
    const sp = byDay(all(`SELECT date(r.created_at,'localtime') d, COUNT(*) n ${rb} AND r.status='done' AND ${inR('r.created_at', 7)} GROUP BY d`, b.id));
    const spark = dayList.slice(-7).map((d) => sp[d] ?? 0);
    const top = all(`SELECT COALESCE(r.media_id, a.media_id) media_id, ch.id channel_id, COUNT(*) n ${rb} AND r.status='done' AND ${inR('r.created_at')}
                     GROUP BY COALESCE(r.media_id, a.media_id), ch.id ORDER BY n DESC LIMIT 1`, b.id)[0] ?? null;
    const em = n1(`SELECT COUNT(*) n FROM contacts c JOIN channels ch ON ch.id=c.channel_id WHERE ch.brand_id=? AND json_extract(c.fields,'$.email') IS NOT NULL AND ${inR("json_extract(c.fields,'$.email_at')")}`, b.id);
    const autos = n1('SELECT COUNT(*) n FROM automations a JOIN channels ch ON ch.id=a.channel_id WHERE ch.brand_id=? AND a.active=1', b.id);
    const errs24 = n1(`SELECT COUNT(*) n ${rb} AND r.status='error' AND r.created_at >= datetime('now','-1 day')`, b.id);
    let followers = null, delta = null;
    for (const c of all('SELECT id FROM channels WHERE brand_id=?', b.id)) {
      const last = all('SELECT followers f FROM account_stats WHERE channel_id=? AND followers IS NOT NULL ORDER BY day DESC LIMIT 1', c.id)[0];
      if (!last) continue;
      const prev = all(`SELECT followers f FROM account_stats WHERE channel_id=? AND followers IS NOT NULL AND day <= date('now','localtime','-7 days') ORDER BY day DESC LIMIT 1`, c.id)[0]
        ?? all('SELECT followers f FROM account_stats WHERE channel_id=? AND followers IS NOT NULL ORDER BY day ASC LIMIT 1', c.id)[0];
      followers = (followers ?? 0) + last.f; delta = (delta ?? 0) + (last.f - (prev?.f ?? last.f));
    }
    return { id: b.id, name: b.name, dms: sent, comments: total, deliveredPct: pct(sent, total), spark, topReel: top, emails: em, automations: autos, errors24h: errs24, followers, followersDelta: delta };
  });

  // ---- best automations ----
  const topAutomations = all(`SELECT a.id, a.name, a.mode, a.keywords, a.media_id, ch.id channel_id, COUNT(*) comments, SUM(r.status='done') dms,
      SUM(cp.status IN ('got_email','done')) emails ${runsFrom.replace('WHERE', 'LEFT JOIN captures cp ON cp.run_id=r.id WHERE')} AND ${inR('r.created_at')}
      GROUP BY a.id ORDER BY dms DESC, comments DESC LIMIT 6`, ...bp).map((x) => ({ ...x, keywords: JSON.parse(x.keywords || '[]'), emails: x.emails ?? 0, dms: x.dms ?? 0 }));

  // ---- per reel (with total likes and comments from the daily snapshot) ----
  const reels = all(`SELECT COALESCE(r.media_id, a.media_id) media_id, ch.id channel_id, COUNT(*) matched, SUM(r.status='done') dms, SUM(cp.status IN ('got_email','done')) emails
      ${runsFrom.replace('WHERE', 'LEFT JOIN captures cp ON cp.run_id=r.id WHERE')} AND ${inR('r.created_at')} GROUP BY COALESCE(r.media_id, a.media_id), ch.id ORDER BY dms DESC LIMIT 12`, ...bp)
    .filter((x) => x.media_id).map((x) => {
      const s = all('SELECT likes, comments, views, reach, saved, shares, interactions, watch_ms FROM media_stats WHERE channel_id=? AND media_id=? ORDER BY day DESC LIMIT 1', x.channel_id, String(x.media_id))[0];
      const kw = all(`SELECT a.keywords k, COUNT(*) n ${runsFrom} AND COALESCE(r.media_id, a.media_id)=? AND ch.id=? GROUP BY a.id ORDER BY n DESC LIMIT 1`, ...bp, String(x.media_id), x.channel_id)[0];
      const byD = Object.fromEntries(all(`SELECT date(r.created_at,'localtime') d, COUNT(*) n ${runsFrom} AND r.status='done' AND COALESCE(r.media_id, a.media_id)=? AND ch.id=? AND ${inR('r.created_at', 7)} GROUP BY d`, ...bp, String(x.media_id), x.channel_id).map((y) => [y.d, y.n]));
      const spark = all(`WITH RECURSIVE d(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM d WHERE i<6) SELECT date('now','localtime','-'||(6-i)||' days') AS d FROM d`).map((y) => byD[y.d] ?? 0);
      let keyword = null; try { keyword = JSON.parse(kw?.k || '[]')[0] ?? null; } catch {}
      return { ...x, dms: x.dms ?? 0, emails: x.emails ?? 0, likes: s?.likes ?? null, commentsTotal: s?.comments ?? null, views: s?.views ?? null, reach: s?.reach ?? null, saved: s?.saved ?? null, shares: s?.shares ?? null, interactions: s?.interactions ?? null, watchSec: s?.watch_ms != null ? Math.round(s.watch_ms / 100) / 10 : null, dmPerView: s?.views ? Math.round((x.dms ?? 0) / s.views * 1000) / 10 : null, keywordShare: s?.comments ? pct(x.matched, s.comments) : null, keyword, spark };
    });

  // ---- speed ----
  const lag = all(`SELECT r.comment_at ca, r.dm_at da ${runsFrom} AND r.dm_at IS NOT NULL AND r.comment_at IS NOT NULL AND ${inR('r.created_at')}`, ...bp).map((x) => sec(x.ca, x.da)).filter((x) => x >= 0);
  const toEmail = all(`SELECT cp.asked_at aa, cp.last_msg_at la ${capsFrom} AND cp.status IN ('got_email','done') AND ${inR('cp.created_at')}`, ...bp).map((x) => sec(x.aa, x.la)).filter((x) => x >= 0);
  const speed = { medianLagSec: median(lag), lateCount: lag.filter((x) => x > 300).length, lagSamples: lag.length, medianToEmailSec: median(toEmail), emailSamples: toEmail.length };

  // ---- emails ----
  const domains = all(`SELECT lower(substr(e, instr(e,'@')+1)) d, COUNT(*) n FROM (SELECT json_extract(c.fields,'$.email') e ${emailRows}) GROUP BY d ORDER BY n DESC LIMIT 6`, ...bp);
  const repeat = n1(`SELECT COUNT(*) n FROM (SELECT r.contact_id ${runsFrom} AND r.contact_id IS NOT NULL GROUP BY r.contact_id HAVING COUNT(DISTINCT r.automation_id) >= 2)`, ...bp);

  // ---- errors ----
  const errGroups = all(`SELECT substr(r.error,1,80) e, COUNT(*) n ${runsFrom} AND r.status='error' AND ${inR('r.created_at')} GROUP BY e ORDER BY n DESC LIMIT 5`, ...bp);
  const capFailed = n1(`SELECT COUNT(*) n ${capsFrom} AND cp.status='failed' AND ${inR('cp.created_at')}`, ...bp);
  const pauses = n1(`SELECT COUNT(*) n FROM events WHERE kind='error' AND note LIKE 'Meta paused sending%' AND ${inR('ts')}`);

  // ---- A/B tests of the DM that asks for the email ----
  const abRows = all(`SELECT a.id, a.name, r.variant v, COUNT(*) n, SUM(cp.status IN ('got_email','done')) em
      ${runsFrom.replace('WHERE', 'LEFT JOIN captures cp ON cp.run_id=r.id WHERE')} AND r.variant IS NOT NULL GROUP BY a.id, r.variant`, ...bp);
  const ab = [...new Set(abRows.map((x) => x.id))].map((id) => {
    const g = (v) => { const x = abRows.find((y) => y.id === id && y.v === v); return { n: x?.n ?? 0, emails: x?.em ?? 0, rate: pct(x?.em ?? 0, x?.n ?? 0) }; };
    const A = g('A'), Bv = g('B'); let winner = null;
    if (A.n >= 30 && Bv.n >= 30) { // two proportions: a winner is declared only with a statistically clear difference (95%)
      const p1 = A.emails / A.n, p2 = Bv.emails / Bv.n, p = (A.emails + Bv.emails) / (A.n + Bv.n), se = Math.sqrt(p * (1 - p) * (1 / A.n + 1 / Bv.n));
      if (se > 0 && Math.abs(p1 - p2) / se > 1.96) winner = p1 > p2 ? 'A' : 'B';
    }
    return { id, name: abRows.find((y) => y.id === id).name, A, B: Bv, winner };
  });

  // ---- followers ----
  const fRows = all(`SELECT s.day, SUM(s.followers) f FROM account_stats s JOIN channels ch ON ch.id=s.channel_id WHERE s.followers IS NOT NULL ${B}
                     AND s.day >= date('now','localtime','-29 days') GROUP BY s.day ORDER BY s.day`, ...bp);

  // ---- wrote back after receiving the resource ----
  const recips = all(`SELECT COALESCE(r.igsid, cp.igsid) g, ch.id c, COALESCE(cp.done_at, r.dm_at) t, a.mode m, cp.status cs
      ${runsFrom.replace('WHERE', 'LEFT JOIN captures cp ON cp.run_id=r.id WHERE')} AND r.status='done' AND COALESCE(r.igsid, cp.igsid) IS NOT NULL AND ${inR('r.created_at')}`, ...bp);
  const fu = new Map(all('SELECT channel_id c, igsid g, last_in t FROM followups').map((x) => [`${x.c}|${x.g}`, x.t]));
  const toIso = (t) => (t && !String(t).includes('T') ? String(t).replace(' ', 'T') + 'Z' : t);
  let got = 0, wrote = 0;
  for (const x of recips) {
    if (x.m === 'email' && x.cs !== 'done') continue;            // has not received the resource yet
    if (!x.t) continue;
    got++; const last = fu.get(`${x.c}|${x.g}`);
    if (last && Date.parse(last) > Date.parse(toIso(x.t)) + 5000) wrote++;
  }
  const followups = { delivered: got, wroteBack: wrote, rate: pct(wrote, got) };

  // ---- encendido del programa ----
  const fromMs = Date.now() - days * 86400e3, spans = all('SELECT started s, last l FROM uptime ORDER BY id').map((x) => [Date.parse(x.s), Date.parse(x.l) + 60e3]);
  let uptime = null;
  if (spans.length) {
    const start = Math.max(fromMs, spans[0][0]), total = Date.now() - start;
    let on = 0; for (const [s, l] of spans) on += Math.max(0, Math.min(l, Date.now()) - Math.max(s, start));
    const gaps = []; for (let i = 1; i < spans.length; i++) { const g = spans[i][0] - spans[i - 1][1]; if (g > 120e3 && spans[i][0] > start) gaps.push({ from: new Date(spans[i - 1][1]).toISOString(), minutes: Math.round(g / 60e3) }); }
    uptime = { pct: total > 0 ? Math.min(100, Math.round((on / total) * 1000) / 10) : 100, since: new Date(start).toISOString(), offCount: gaps.length, offMinutes: gaps.reduce((s, g) => s + g.minutes, 0), lastOff: gaps.at(-1) ?? null, runningSince: new Date(spans.at(-1)[0]).toISOString() };
  }

  // ---- account insights (reach and plays per day) ----
  const ins = all(`SELECT s.day, SUM(s.reach) reach, SUM(s.views) views, SUM(s.engaged) engaged FROM account_stats s JOIN channels ch ON ch.id=s.channel_id WHERE s.views IS NOT NULL ${B}
                   AND s.day >= date('now','localtime','-29 days') GROUP BY s.day ORDER BY s.day`, ...bp);
  const lastN = ins.slice(-days);
  const insights = { series: ins, views: lastN.reduce((s, x) => s + (x.views ?? 0), 0), reach: lastN.reduce((s, x) => s + (x.reach ?? 0), 0), has: ins.length > 0 };

  return {
    followups, uptime, insights,
    range: days === 1 ? 'today' : String(days), days, generatedAt: new Date().toISOString(),
    totals: { comments, dms, asked, replied, emails, delivered, errors },
    funnel, series30, listGrowth: { total: totalEmails, week, cumulative },
    heatmap: { grid, peak: peak ? { dow: peak.dow, hour: peak.hr, n: peak.n } : null, peakHours },
    outcomes, brands, topAutomations, reels, speed,
    emails: { total: totalEmails, domains, repeat }, errorsInfo: { groups: errGroups, captureFailures: capFailed, rateLimitPauses: pauses },
    ab, followers: { series: fRows, latest: fRows.at(-1)?.f ?? null, delta: fRows.length > 1 ? fRows.at(-1).f - fRows[0].f : null },
  };
}
