import assert from 'node:assert/strict';
process.env.DB_FILE = ':memory:';
const { run, get, all } = await import('../src/db.mjs');
const { analytics } = await import('../src/analytics.mjs');
const { withUtm, handleComment, rng } = await import('../src/engine.mjs');
const { collectStats } = await import('../src/stats.mjs');

// ======== UTM ========
const au = { utm: 1, keywords: '["montage"]', name: 'x' };
assert.equal(withUtm('Mira https://example.com/free-guide. Gracias', au),
  'Mira https://example.com/free-guide?utm_source=instagram&utm_medium=dm&utm_campaign=montage. Gracias', 'the trailing period stays out of the link');
assert.equal(withUtm('https://x.com/a?b=1#z', au), 'https://x.com/a?b=1&utm_source=instagram&utm_medium=dm&utm_campaign=montage#z', 'keeps parameters and anchor');
assert.equal(withUtm('https://x.com/?utm_source=otro', au), 'https://x.com/?utm_source=otro', 'if it already has utm_source it is left alone');
assert.equal(withUtm('Mira https://x.com', { ...au, utm: 0 }), 'Mira https://x.com', 'with the option off the message goes out EXACTLY the same');
assert.equal(withUtm('no links', au), 'no links');
assert.equal(withUtm(null, au), null);
assert.ok(withUtm('https://a.com y https://b.com/x', au).split('utm_source=instagram').length === 3, 'all links');
assert.ok(withUtm('https://x.com', { utm: 1, keywords: '[]', name: 'Mi Campaña Ñandú' }).includes('utm_campaign=mi-campana-nandu'), 'name without accents');

// ======== datos de ejemplo ========
run("INSERT INTO brands(name) VALUES ('Acme'),('Otra')");
run("INSERT INTO channels(brand_id, ig_user_id, username, token, host) VALUES (1,'IG1','acme','t','graph.facebook.com'),(2,'IG2','otra','t','graph.facebook.com')");
const A = (name, ch, mode, kw, media, extra = '') => run(`INSERT INTO automations(channel_id,name,keywords,dm_text,mode,media_id,since,ask_text,alt_ask_text,delay_seconds ${extra ? ',utm' : ''})
  VALUES (?,?,?,?,?,?,datetime('now','-90 days'),'Question A',?,0 ${extra ? ',1' : ''})`, ch, name, JSON.stringify(kw), 'resource https://x.com', mode, media, mode === 'email' && name === 'Email' ? 'Question B' : null);
A('Email', 1, 'email', ['montage'], 'M1'); A('Guia', 1, 'link', ['guia'], 'M2'); A('Otra auto', 2, 'link', ['x'], 'M3');
const iso = (min) => new Date(Date.now() - min * 60e3).toISOString();
const sql = (min) => `datetime('now','-${min} minutes')`;
let cid = 0;
const R = (auto, status, { created = 0, c = null, ca = null, da = null, v = null, media = null, err = null } = {}) => {
  const cont = c ?? `c${++cid}`;
  run(`INSERT OR IGNORE INTO contacts(channel_id, external_id, username) VALUES ((SELECT channel_id FROM automations WHERE id=?),?,?)`, auto, cont, cont);
  const contact = get('SELECT id FROM contacts WHERE external_id=?', cont).id;
  const r = run(`INSERT INTO runs(automation_id, comment_id, contact_id, comment_text, status, error, created_at, comment_at, dm_at, variant, media_id)
                 VALUES (?,?,?,?,?,?,${created ? sql(created) : "datetime('now')"},?,?,?,?)`, auto, 'cm' + (++cid), contact, 'Montage', status, err, ca, da, v, media);
  return { id: Number(r.lastInsertRowid), contact };
};
const C = (runId, auto, ch, status, { ask = iso(60), last = ask, created = 0 } = {}) =>
  run(`INSERT INTO captures(automation_id, channel_id, run_id, igsid, status, asked_at, last_msg_at, created_at) VALUES (?,?,?,?,?,?,?,${created ? sql(created) : "datetime('now')"})`, auto, ch, runId, 'u' + runId, status, ask, last);

const r1 = R(1, 'done', { ca: iso(61), da: iso(60), v: 'A', media: 'M1' });          // rapidez 60 s
const r2 = R(1, 'done', { ca: iso(70), da: iso(70 - 400 / 60), v: 'B', media: 'M1' }); // rapidez 400 s (tarde)
const r3 = R(1, 'done', { v: 'A', media: 'M1' });
R(2, 'done', { media: 'M2' }); R(2, 'error', { media: 'M2', err: 'Meta error X' });
const r6 = R(1, 'pending', { media: 'M1' });
R(3, 'done', { media: 'M3' });
R(1, 'done', { created: 3 * 24 * 60, media: 'M1' });   // 3 days ago
R(1, 'done', { created: 40 * 24 * 60, media: 'M1' });  // 40 days ago: outside the 7 and 30 day windows
C(r1.id, 1, 1, 'done', { ask: iso(60), last: iso(55) });
C(r2.id, 1, 1, 'got_email', { ask: iso(65), last: iso(60) });
C(r3.id, 1, 1, 'waiting');                              // asked and did not answer
C(r6.id, 1, 1, 'expired', { ask: iso(60), last: iso(50) }); // answered but it was not an email
const E = (cont, email, minAgo) => run('UPDATE contacts SET fields=? WHERE id=?', JSON.stringify({ email, email_at: iso(minAgo) }), cont);
E(r1.contact, 'a@gmail.com', 55); E(r2.contact, 'b@gmail.com', 60);
const old = R(1, 'done', { created: 10 * 24 * 60 }); E(old.contact, 'z@outlook.com', 10 * 24 * 60);
run("INSERT INTO account_stats(channel_id, day, followers) VALUES (1, date('now','localtime'), 120), (1, date('now','localtime','-8 days'), 100)");
run("INSERT INTO media_stats(channel_id, media_id, day, likes, comments) VALUES (1,'M1', date('now','localtime'), 50, 80)");

// ======== funnel (7 days, all brands) ========
let a = analytics({ range: 7 });
assert.deepEqual(a.totals, { comments: 8, dms: 6, asked: 4, replied: 3, emails: 2, delivered: 3, errors: 1 }, JSON.stringify(a.totals));
assert.equal(a.funnel[1].rate, 75); assert.equal(a.funnel[2].rate, 50); assert.equal(a.funnel[2].of, 4); assert.equal(a.funnel[3].rate, 75);
assert.deepEqual(a.outcomes, { sent: 6, waiting: 1, error: 1 });
// ======== filtros ========
assert.equal(analytics({ brand: 2, range: 7 }).totals.comments, 1, 'brand filter');
assert.equal(analytics({ brand: 2, range: 7 }).totals.asked, 0);
assert.equal(analytics({ range: 'today' }).totals.comments, 7, 'solo hoy');
assert.equal(analytics({ range: 'basura' }).days, 7, 'an unknown range falls back to 7 days');
// ======== series y tendencias ========
assert.equal(a.series30.length, 30); assert.equal(a.series30.at(-1).dms, 5); assert.equal(a.series30.at(-1).emails, 2);
assert.equal(a.series30.reduce((s, x) => s + x.comments, 0), 9, '30-day window: 9 (the one from 40 days ago is out)');
assert.equal(a.listGrowth.total, 3); assert.equal(a.listGrowth.week, 2); assert.equal(a.listGrowth.cumulative.at(-1).total, 3); assert.equal(a.listGrowth.cumulative[0].total, 0, 'the list was empty at the start of the window'); assert.equal(a.listGrowth.cumulative.find((x) => x.date === a.series30[19].date).total, 1, 'the email from 10 days ago counts there');
assert.deepEqual(a.emails.domains.map((x) => ({ ...x })), [{ d: 'gmail.com', n: 2 }, { d: 'outlook.com', n: 1 }]);
// ======== mapa de calor ========
assert.equal(a.heatmap.grid.flat().reduce((s, n) => s + n, 0), 9); assert.ok(a.heatmap.peak.n >= 1); assert.equal(a.heatmap.grid.length, 7); assert.equal(a.heatmap.grid[0].length, 24);
// ======== brands ========
const b1 = a.brands.find((b) => b.name === 'Acme');
assert.equal(b1.dms, 5); assert.equal(b1.comments, 7); assert.equal(b1.deliveredPct, 71); assert.equal(b1.spark.length, 7); assert.equal(b1.followers, 120); assert.equal(b1.followersDelta, 20);
assert.equal(b1.topReel.media_id, 'M1'); assert.equal(b1.automations, 2); assert.equal(b1.errors24h, 1);
// ======== automatizaciones y reels ========
const top = a.topAutomations[0]; assert.equal(top.name, 'Email'); assert.equal(top.dms, 4); assert.equal(top.emails, 2);
const reel = a.reels.find((x) => x.media_id === 'M1'); assert.equal(reel.likes, 50); assert.equal(reel.commentsTotal, 80); assert.equal(reel.keywordShare, 6, '5 with the keyword out of 80 comments');
assert.equal(a.reels.find((x) => x.media_id === 'M2').dms, 1);
// ======== rapidez ========
assert.equal(a.speed.lagSamples, 2); assert.ok(Math.abs(a.speed.medianLagSec - 230) < 1, `mediana de rapidez ${a.speed.medianLagSec}`); assert.equal(a.speed.lateCount, 1);
assert.equal(a.speed.emailSamples, 2); assert.ok(Math.abs(a.speed.medianToEmailSec - 300) < 1, `median until the email ${a.speed.medianToEmailSec}`);
// ======== errores ========
assert.deepEqual(a.errorsInfo.groups.map((x) => ({ ...x })), [{ e: 'Meta error X', n: 1 }]);

// ======== A/B ========
let ab = a.ab.find((x) => x.name === 'Email');
assert.deepEqual([ab.A.n, ab.A.emails, ab.A.rate, ab.B.n, ab.B.emails, ab.B.rate], [2, 1, 50, 1, 1, 100]); assert.equal(ab.winner, null, 'with few people no winner is declared');
A('Test AB', 1, 'email', ['ab'], 'M9');
const abId = get("SELECT id FROM automations WHERE name='Test AB'").id;
for (let i = 0; i < 40; i++) { const x = R(abId, 'done', { v: 'A', media: 'M9' }); C(x.id, abId, 1, i < 10 ? 'done' : 'waiting'); }
for (let i = 0; i < 40; i++) { const x = R(abId, 'done', { v: 'B', media: 'M9' }); C(x.id, abId, 1, i < 25 ? 'done' : 'waiting'); }
ab = analytics({ range: 7 }).ab.find((x) => x.name === 'Test AB');
assert.deepEqual([ab.A.rate, ab.B.rate, ab.winner], [25, 63, 'B'], 'clear difference with 40 and 40 people: B wins');
for (let i = 0; i < 40; i++) { const x = R(abId, 'done', { v: 'A', media: 'M9' }); C(x.id, abId, 1, i < 21 ? 'done' : 'waiting'); }
for (let i = 0; i < 40; i++) { const x = R(abId, 'done', { v: 'B', media: 'M9' }); C(x.id, abId, 1, i < 18 ? 'done' : 'waiting'); }

// ======== the engine stores comment time, reel, speed and variant ========
const chan = get('SELECT * FROM channels WHERE id=1');
const asked = [];
const sender = { replyToComment: async () => ({}), privateReplyText: async (cid, t) => { asked.push(t); return { recipient_id: 'X' + cid }; }, privateReplyButton: async () => ({}) };
const mk = (id) => ({ id, text: 'Montage', username: 'u' + id, from: { id: 'U' + id, username: 'u' + id }, media: { id: 'M1' }, timestamp: new Date(Date.now() - 20 * 1000).toISOString().replace('Z', '+0000') });
const go = async (id) => { const l = handleComment(chan, mk(id), { sender, instant: true }); await Promise.all(l.map((x) => x.done)); return get('SELECT * FROM runs WHERE comment_id=?', id); };
rng.next = () => 0.1; let row = await go('E1');
assert.equal(row.variant, 'B'); assert.equal(asked.at(-1), 'Question B'); assert.equal(row.media_id, 'M1');
assert.ok(row.comment_at && row.dm_at && Date.parse(row.dm_at) >= Date.parse(row.comment_at), 'stores comment time and DM time');
assert.ok(Date.parse(row.dm_at) - Date.parse(row.comment_at) >= 19000, 'speed measured from the real comment, not from when it was read');
rng.next = () => 0.9; row = await go('E2'); assert.equal(row.variant, 'A'); assert.equal(asked.at(-1), 'Question A');
// without version B there is no variant
run("UPDATE automations SET alt_ask_text=NULL WHERE name='Email'"); row = await go('E3'); assert.equal(row.variant, null);
// real UTM in the send
run("UPDATE automations SET mode='link', utm=1, dm_text='Here https://x.com/r' WHERE name='Email'");
await go('E4'); assert.ok(asked.at(-1).includes('utm_campaign=montage'), asked.at(-1));
run("UPDATE automations SET utm=0 WHERE name='Email'");
await go('E5'); assert.equal(asked.at(-1), 'Here https://x.com/r', 'with UTM off the message goes out as is');

// ======== foto diaria ========
let stats = { followers_count: 123, media_count: 12 };
const deps = () => ({ getAccountStats: async () => stats, listMedia: async () => ({ data: [{ id: 'M1', like_count: 51, comments_count: 81 }, { id: 'M7', comments_count: 3 }] }) });
assert.equal(await collectStats(deps()), 2, 'las 2 cuentas');
assert.equal(get("SELECT followers f FROM account_stats WHERE channel_id=1 AND day=date('now','localtime')").f, 123, 'updates today\'s snapshot');
assert.equal(all("SELECT * FROM account_stats WHERE channel_id=1 AND day=date('now','localtime')").length, 1, 'a single snapshot per day');
assert.equal(get("SELECT likes, comments FROM media_stats WHERE media_id='M1' AND day=date('now','localtime')").comments, 81);
assert.equal(get("SELECT likes FROM media_stats WHERE media_id='M7'").likes, null, 'if Meta gives no likes it stays empty, not 0');
stats = { followers_count: 130 }; await collectStats(deps());
assert.equal(get("SELECT followers f FROM account_stats WHERE channel_id=1 AND day=date('now','localtime')").f, 130);
await collectStats({ getAccountStats: async () => { throw new Error('boom'); }, listMedia: async () => ({}) }); // a failure breaks nothing

console.log('OK: analytics tests passed');
