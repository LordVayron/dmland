#!/usr/bin/env node
// DMLand demo: starts the dashboard on http://localhost:3100 with made-up data and a fake Meta API.
// Nothing here talks to Instagram or Meta. Use it to explore the dashboard or to take screenshots.
//   npm run demo          (password: demo)
import { rmSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'data'), { recursive: true });
const dbFile = join(root, 'data', 'demo.db');
for (const s of ['', '-shm', '-wal']) rmSync(dbFile + s, { force: true });

process.env.DB_FILE = dbFile;
process.env.PORT = process.env.PORT || '3100';
process.env.DASHBOARD_PASSWORD = 'demo';
process.env.WEBHOOK_VERIFY_TOKEN = 'demo';
process.env.POLL = 'off';

// ---------- deterministic randomness, so every run looks the same ----------
let seed = 20260101;
const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (a, b) => Math.floor(a + rnd() * (b - a + 1));

// ---------- fake reels with generated thumbnails ----------
const PALETTES = [['#7c5cff', '#ff6a88'], ['#ff8a3d', '#ffcf5c'], ['#12b5a6', '#4f8cff'], ['#ff5c8a', '#9a76f5'], ['#4f8cff', '#7c5cff'], ['#f6b73f', '#ff6a88'], ['#27c28a', '#12b5a6'], ['#9a76f5', '#4f8cff']];
const thumb = (title, i) => {
  const [a, b] = PALETTES[i % PALETTES.length];
  const lines = title.split('|').map((t, k) => `<text x="180" y="${290 + k * 52}" text-anchor="middle" font-family="Arial Black,Arial,sans-serif" font-weight="900" font-size="38" fill="#fff">${t}</text>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="640" viewBox="0 0 360 640"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="360" height="640" fill="url(#g)"/><circle cx="300" cy="90" r="120" fill="#fff" fill-opacity=".12"/><circle cx="40" cy="580" r="150" fill="#000" fill-opacity=".12"/>${lines}</svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
};

const REELS = [
  { ch: 0, title: '5 FREE|AI TOOLS', caption: '5 free AI tools that save me 10 hours a week. Comment GUIDE and I will send you the full list.', age: 1, base: 190, kw: 'GUIDE', mode: 'link', name: 'Free AI tools guide', tag: 'lead-guide', url: 'https://example.com/ai-tools-guide', btn: 'Get the guide' },
  { ch: 0, title: 'PROMPT|PACK', caption: 'The exact prompts I use every day. Comment PROMPTS and I will DM you the pack.', age: 3, base: 160, kw: 'PROMPTS', mode: 'email', name: 'Prompt pack', tag: 'lead-prompts', url: 'https://example.com/prompt-pack', btn: 'Open the pack' },
  { ch: 0, title: 'STOP|DOING THIS', caption: 'Three habits that quietly kill your reach. Comment FIX for the checklist.', age: 6, base: 120, kw: 'FIX', mode: 'link', name: 'Reach checklist', tag: 'lead-checklist', url: 'https://example.com/reach-checklist', btn: 'Get the checklist' },
  { ch: 0, title: 'MY MORNING|STACK', caption: 'My whole morning routine in 20 seconds. Comment STACK to get my setup.', age: 9, base: 90, kw: 'STACK', mode: 'email', name: 'Morning stack template', tag: 'lead-stack', url: 'https://example.com/stack', btn: 'See the setup' },
  { ch: 0, title: '3 HOOKS|THAT WORK', caption: 'Hooks that doubled my watch time. Comment HOOKS and I will send them.', age: 14, base: 70, kw: 'HOOKS', mode: 'link', name: 'Hooks swipe file', tag: 'lead-hooks', url: 'https://example.com/hooks', btn: 'Get the hooks' },
  { ch: 0, title: 'CONTENT|CALENDAR', caption: 'Plan a month of content in one hour. Comment PLAN for the template.', age: 19, base: 55, kw: 'PLAN', mode: 'email', name: 'Content calendar', tag: 'lead-plan', url: 'https://example.com/calendar', btn: 'Open the template' },
  { ch: 0, title: 'BEFORE|AND AFTER', caption: 'Same product, two edits. Comment EDIT for my presets.', age: 25, base: 40, kw: 'EDIT', mode: 'link', name: 'Editing presets', tag: 'lead-presets', url: 'https://example.com/presets', btn: 'Get the presets' },
  { ch: 0, title: 'SIMPLE|SALES PAGE', caption: 'The page that converts at 11%. Comment PAGE for the template.', age: 29, base: 30, kw: 'PAGE', mode: 'link', name: 'Sales page template', tag: 'lead-page', url: 'https://example.com/page', btn: 'Get the template' },
  { ch: 1, title: 'LAUNCH|CHECKLIST', caption: 'Everything to check before you launch. Comment LAUNCH.', age: 2, base: 80, kw: 'LAUNCH', mode: 'link', name: 'Launch checklist', tag: 'lead-launch', url: 'https://example.com/launch', btn: 'Get the list' },
  { ch: 1, title: 'PRICING|SECRETS', caption: 'How to price without guessing. Comment PRICE for the sheet.', age: 7, base: 60, kw: 'PRICE', mode: 'email', name: 'Pricing sheet', tag: 'lead-price', url: 'https://example.com/pricing', btn: 'Open the sheet' },
  { ch: 1, title: 'TEAM|RITUALS', caption: 'Weekly rituals that keep a small team fast. Comment TEAM.', age: 13, base: 40, kw: 'TEAM', mode: 'link', name: 'Team rituals', tag: 'lead-team', url: 'https://example.com/team', btn: 'Get the rituals' },
  { ch: 2, title: 'COFFEE|CLUB', caption: 'Join the coffee club and get 10% off your first bag. Comment CLUB and we will message you.', age: 2, base: 55, kw: 'CLUB', mode: 'email', name: 'Coffee club', tag: 'lead-club', url: 'https://example.com/club', btn: 'Join the club' },
  { ch: 2, title: 'HOME|BREW GUIDE', caption: 'Our home brewing guide, free this week. Comment BREW.', age: 8, base: 40, kw: 'BREW', mode: 'link', name: 'Home brew guide', tag: 'lead-brew', url: 'https://example.com/brew', btn: 'Get the guide' },
].map((r, i) => ({ ...r, i, id: `1790000000000${String(i + 1).padStart(4, '0')}` }));

const CHANNELS = [
  { brand: 'Acme Studio', ig: '17841400000000001', user: 'acme.studio', followers: [12480, 13210] },
  { brand: 'Nova Labs', ig: '17841400000000002', user: 'nova.labs', followers: [3120, 3390] },
  { brand: 'Bloom Cafe', ig: '100000000000003', user: 'bloomcafe', followers: [840, 905], type: 'facebook' }, // a Facebook Page
];

// ---------- fake Meta Graph API (the only place the app does network calls) ----------
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = new URL(String(url));
  if (u.hostname !== 'graph.facebook.com') return realFetch(url, opts);
  const m = u.pathname.match(/^\/v[\d.]+\/(\d+)(\/media|\/published_posts)?$/);
  const ch = m && CHANNELS.find((c) => c.ig === m[1]);
  const ok = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
  if (ch && m[2]) {
    const idx = CHANNELS.indexOf(ch);
    if (ch.type === 'facebook') return ok({ data: REELS.filter((r) => r.ch === idx).map((r) => ({
      id: r.id, message: r.caption, full_picture: thumb(r.title, r.i), permalink_url: `https://www.facebook.com/${ch.user}/posts/demo${r.i + 1}`, created_time: new Date(r.pub).toISOString().replace('Z', '+0000') })) });
    return ok({ data: REELS.filter((r) => r.ch === idx).map((r) => ({
      id: r.id, caption: r.caption, media_type: 'VIDEO', thumbnail_url: thumb(r.title, r.i), permalink: `https://www.instagram.com/reel/DEMO${r.i + 1}/`,
      timestamp: new Date(r.pub).toISOString().replace('Z', '+0000'), like_count: 0, comments_count: 0 })) });
  }
  if (ch) return ok({ id: ch.ig, username: ch.user, name: ch.brand, followers_count: ch.followers[1] });
  return new Response(JSON.stringify({ error: { message: 'demo: not available', code: 100 } }), { status: 400, headers: { 'content-type': 'application/json' } });
};

// ---------- seed the database ----------
const { db, run, all, get } = await import('../src/db.mjs');
const iso = (ms) => new Date(ms).toISOString();
const sqlTs = (ms) => iso(ms).replace('T', ' ').slice(0, 19);
const DAY = 86400e3, NOW = Date.now();
const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
for (const r of REELS) r.pub = Math.min(NOW - 3600e3, startOfDay(NOW - r.age * DAY) + 12 * 3600e3); // reels go out at noon

const FIRST = ['maya', 'leo', 'sofia', 'noah', 'emma', 'liam', 'zoe', 'ethan', 'lucia', 'mateo', 'ava', 'lucas', 'mia', 'oliver', 'nina', 'jack', 'sara', 'diego', 'ivy', 'omar', 'luna', 'felix', 'rosa', 'hugo', 'clara', 'theo', 'nora', 'adam', 'elena', 'ruben'];
const SUFFIX = ['studio', 'creates', 'daily', 'builds', 'works', 'diary', 'hq', 'moves', 'makes', 'lab'];
const DOMAINS = ['example.com', 'example.org', 'example.net', 'example.com', 'mail.example', 'demo.test'];

// Mark the seed as clearly fake in the database itself.
const brandIds = [], chanIds = [];
for (const c of CHANNELS) {
  const b = Number(run('INSERT INTO brands(name) VALUES (?)', c.brand).lastInsertRowid);
  brandIds.push(b);
  chanIds.push(Number(run("INSERT INTO channels(brand_id, ig_user_id, username, token, host, type) VALUES (?,?,?,?,'graph.facebook.com',?)", b, c.ig, c.user, 'DEMO-TOKEN-NOT-REAL-0000', c.type || 'instagram').lastInsertRowid));
}

const mkContacts = (chIdx, n) => Array.from({ length: n }, (_, k) => {
  const username = `${pick(FIRST)}_${pick(SUFFIX)}${int(10, 99)}`;
  const ext = String(5000000000 + chIdx * 100000 + k);
  const first = NOW - int(1, 29) * DAY;
  const id = Number(run('INSERT INTO contacts(channel_id, external_id, username, tags, fields, first_seen, last_interaction) VALUES (?,?,?,?,?,?,?)',
    chanIds[chIdx], ext, username, '[]', '{}', sqlTs(first), sqlTs(first)).lastInsertRowid);
  return { id, username, ext, tags: new Set() };
});
const pools = [mkContacts(0, 520), mkContacts(1, 160), mkContacts(2, 70)];

const AUTO = {};
for (const r of REELS) {
  const askA = `Hey {{username}}! 👋 Reply with your email and I will send you the ${r.name.toLowerCase()} right away.\n\nBy sending it you agree to receive the resource and occasional emails.`;
  const askB = `{{username}}, almost there! Drop your best email here and the ${r.name.toLowerCase()} lands in your inbox.\n\nBy sending it you agree to receive the resource and occasional emails.`;
  const id = Number(run(`INSERT INTO automations(channel_id,name,active,media_id,match_mode,keywords,exclude,public_replies,dm_text,button_title,button_url,tag,delay_seconds,mode,ask_text,retry_text,skip_known,alt_ask_text,utm,since)
    VALUES (?,?,1,?,'contains',?,'[]',?,?,?,?,?,3,?,?,?,1,?,1,?)`,
    chanIds[r.ch], r.name, r.id, JSON.stringify([r.kw.toLowerCase()]),
    JSON.stringify(['Sent! Check your DMs 📩', 'Just sent it to your DMs ✨', 'On its way, check your inbox 🚀']),
    `Hey {{username}}! Here is the ${r.name.toLowerCase()} you asked for 👇`, r.btn, r.url, r.tag, r.mode,
    r.mode === 'email' ? askA : null, r.mode === 'email' ? 'Hmm, that does not look like an email. Please write it like name@example.com' : null,
    r.mode === 'email' && r.i % 2 === 1 ? askB : null, sqlTs(NOW - (r.age + 2) * DAY)).lastInsertRowid);
  AUTO[r.i] = id;
}

// comments per hour of day: lunch bump and an evening peak
const HOUR_W = [1, 1, 1, 1, 1, 2, 3, 5, 6, 6, 7, 8, 10, 9, 8, 7, 8, 9, 12, 14, 15, 13, 8, 4];
const hourPick = () => { const t = HOUR_W.reduce((a, b) => a + b, 0); let x = rnd() * t; for (let h = 0; h < 24; h++) { x -= HOUR_W[h]; if (x <= 0) return h; } return 20; };
const FORMS = (kw) => [kw, kw.toLowerCase(), kw + '!', `${kw} please`, `${kw} 🙌`, `Send me ${kw}`, `${kw}!!`];

let commentSeq = 1;
const recipients = [];
for (const r of REELS) {
  const aId = AUTO[r.i], pool = pools[r.ch];
  for (let d = r.age; d >= 0; d--) {
    const sinceDays = r.age - d;
    const dayStart0 = startOfDay(NOW - d * DAY), window = Math.min(dayStart0 + DAY, NOW - 60e3) - Math.max(dayStart0, r.pub);
    if (window <= 0) continue;
    const volume = Math.round(r.base * Math.exp(-sinceDays / 3.2) * (0.8 + rnd() * 0.4) * [1, 0.7, 0.45][r.ch] * Math.min(1, window / DAY + 0.15));
    for (let k = 0; k < volume; k++) {
      const dayStart = startOfDay(NOW - d * DAY);
      const lo = Math.max(dayStart, r.pub), hi = Math.min(dayStart + DAY, NOW - 60e3); // after publishing, before now
      let at = 0;
      for (let t = 0; t < 30 && !(at >= lo && at <= hi); t++) at = dayStart + (hourPick() * 3600 + int(0, 3599)) * 1000;
      if (!(at >= lo && at <= hi)) at = int(lo, hi);
      const contact = pick(pool);
      const bad = rnd() < 0.012;
      const dmAt = at + int(4, 55) * 1000 + (rnd() < 0.04 ? int(120, 900) * 1000 : 0);
      const variant = r.mode === 'email' && r.i % 2 === 1 ? (rnd() < 0.5 ? 'A' : 'B') : null;
      const runId = Number(run(`INSERT INTO runs(automation_id, comment_id, contact_id, comment_text, status, public_reply_status, dm_status, error, created_at, comment_at, media_id, dm_at, variant, igsid)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, aId, `demo_c_${commentSeq++}`, contact.id, pick(FORMS(r.kw)), bad ? 'error' : 'done', bad ? null : 'ok', bad ? 'error' : 'ok',
        bad ? 'The user has blocked messages from this account' : null, sqlTs(dmAt), iso(at), r.id, bad ? null : iso(dmAt), variant, contact.ext).lastInsertRowid);
      if (bad) continue;
      contact.tags.add(r.tag);
      if (r.mode === 'email') {
        const gave = rnd() < (variant === 'B' ? 0.62 : 0.5);
        const replyAt = dmAt + int(30, 3000) * 1000;
        if (gave) {
          const email = `${contact.username}@${pick(DOMAINS)}`;
          run(`INSERT INTO captures(automation_id, channel_id, contact_id, run_id, igsid, username, status, email, retries, asked_at, last_msg_at, created_at, done_at)
               VALUES (?,?,?,?,?,?,?,?,0,?,?,?,?)`, aId, chanIds[r.ch], contact.id, runId, contact.ext, contact.username, 'done', email, iso(dmAt), iso(replyAt), sqlTs(dmAt), iso(replyAt + 3000));
          const f = JSON.parse(get('SELECT fields FROM contacts WHERE id=?', contact.id).fields || '{}');
          if (!f.email) { f.email = email; f.email_at = iso(replyAt); run('UPDATE contacts SET fields=? WHERE id=?', JSON.stringify(f), contact.id); }
          recipients.push({ ch: chanIds[r.ch], ext: contact.ext, at: replyAt });
        } else {
          run(`INSERT INTO captures(automation_id, channel_id, contact_id, run_id, igsid, username, status, retries, asked_at, last_msg_at, created_at)
               VALUES (?,?,?,?,?,?,?,0,?,?,?)`, aId, chanIds[r.ch], contact.id, runId, contact.ext, contact.username, d === 0 ? 'waiting' : 'expired', iso(dmAt), iso(dmAt), sqlTs(dmAt));
        }
      } else recipients.push({ ch: chanIds[r.ch], ext: contact.ext, at: dmAt });
    }
  }
}
for (const [chIdx, pool] of pools.entries()) for (const c of pool) run('UPDATE contacts SET tags=? WHERE id=?', JSON.stringify([...c.tags]), c.id);

// people who wrote back after receiving the resource
for (const rc of recipients) if (rnd() < 0.13) run('INSERT OR IGNORE INTO followups(channel_id, igsid, last_in) VALUES (?,?,?)', rc.ch, rc.ext, iso(Math.min(NOW - 60e3, rc.at + int(10, 600) * 60e3)));

// daily snapshots for reels and accounts
for (const r of REELS) {
  const viewsTotal = Math.round(r.base * 120 * (0.9 + rnd() * 0.3));
  for (let d = r.age; d >= 0; d--) {
    const f = 1 - Math.exp(-(r.age - d + 1) / 3);
    const day = new Date(NOW - d * DAY); const ds = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    const views = Math.round(viewsTotal * f);
    run(`INSERT INTO media_stats(channel_id, media_id, day, likes, comments, views, reach, saved, shares, interactions, watch_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      chanIds[r.ch], r.id, ds, Math.round(views * 0.07), Math.round(r.base * 9 * f), views, Math.round(views * 0.78), Math.round(views * 0.022), Math.round(views * 0.015), Math.round(views * 0.11), int(7200, 15500));
  }
}
for (const [i, c] of CHANNELS.entries()) {
  for (let d = 29; d >= 0; d--) {
    const day = new Date(NOW - d * DAY); const ds = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    const f = (29 - d) / 29, followers = Math.round(c.followers[0] + (c.followers[1] - c.followers[0]) * f + (rnd() - 0.5) * 12);
    const reach = Math.round((i ? 5200 : 21000) * (0.7 + rnd() * 0.7)), views = Math.round(reach * (1.5 + rnd() * 0.5));
    run('INSERT INTO account_stats(channel_id, day, followers, media_count, reach, views, engaged) VALUES (?,?,?,?,?,?,?)', chanIds[i], ds, followers, 120 + (29 - d), reach, views, Math.round(reach * 0.06));
  }
}

// uptime: on almost all the time, with two short gaps
const spans = [[29.9, 21.4], [21.2, 14.05], [13.9, 6.3], [6.28, 0.0]];
for (const [a, b] of spans) run('INSERT INTO uptime(started, last) VALUES (?,?)', iso(NOW - a * DAY), iso(NOW - Math.max(b, 0) * DAY - (b === 0 ? 5e3 : 0)));

// a few activity log lines (the dashboard translates these patterns)
const ev = (minsAgo, kind, note) => run('INSERT INTO events(ts, kind, note) VALUES (?,?,?)', sqlTs(NOW - minsAgo * 60e3), kind, note);
ev(2400, 'channel', `Conectada @acme.studio (${CHANNELS[0].ig}); webhooks: ok`);
ev(2399, 'channel', `Conectada @nova.labs (${CHANNELS[1].ig}); webhooks: ok`);
ev(2398, 'channel', `Connected Facebook Page @bloomcafe (${CHANNELS[2].ig}); webhooks: ok`);
const recent = all("SELECT r.id, a.name, c.username FROM runs r JOIN automations a ON a.id=r.automation_id JOIN contacts c ON c.id=r.contact_id WHERE r.status='done' ORDER BY r.created_at DESC LIMIT 14");
recent.forEach((x, i) => ev(i * 7 + 1, 'run', `"${x.name}" ran for @${x.username}`));

await import('../src/server.mjs');
const { status } = await import('../src/poller.mjs'); // show the "reading comments" indicator as on; nothing is actually read in demo mode
Object.assign(status, { enabled: true, running: false, lastRun: new Date().toISOString(), lastCount: 0, intervalSec: 60 });
console.log('\nDemo mode: fake data, fake Meta API. Password: demo\n');
