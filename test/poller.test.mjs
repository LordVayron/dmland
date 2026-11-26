import assert from 'node:assert/strict';
process.env.DB_FILE = ':memory:';
const { run, get, all } = await import('../src/db.mjs');
const { pollOnce } = await import('../src/poller.mjs');
const { throttle } = await import('../src/engine.mjs');

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace('Z', '+0000'); // formato de Meta
const H = 3600e3, D = 24 * H;

run("INSERT INTO brands(name) VALUES ('T')");
run("INSERT INTO channels(brand_id, ig_user_id, username, token, host) VALUES (1,'IG1','account','tok','graph.facebook.com')");
run(`INSERT INTO automations(channel_id,name,media_id,keywords,public_replies,dm_text,tag,delay_seconds,since)
     VALUES (1,'A','M1','["montage"]','["ok {{username}}"]','hola {{username}}','lead',0, datetime('now','-1 hour'))`);

const sent = [];
const sender = () => ({
  replyToComment: async (id, t) => sent.push(['pub', id, t]),
  privateReplyText: async (id, t) => sent.push(['dm', id, t]),
  privateReplyButton: async (id, t) => sent.push(['dmb', id, t]),
});
const mk = (id, text, ago, user = 'ana') => ({ id, text, username: user, timestamp: iso(ago), from: { id: 'u_' + user, username: user } });
const deps = (comments, extra = {}) => ({ listComments: async () => ({ data: comments }), makeSender: sender, pause: async () => {}, ...extra });

// 1) Filters: new yes; before activation no; 8 days old no; own comment no; without the keyword no
let comments = [
  mk('c1', 'Montage', 5 * 60e3),
  mk('c2', 'montage', 2 * H),                 // before the automation was activated
  mk('c3', 'montage', 8 * D),                 // more than 7 days
  mk('c4', 'montage', 60e3, 'account'),        // own comment
  mk('c5', 'great video', 60e3),           // does not contain the keyword
];
assert.equal(await pollOnce(deps(comments)), 1, 'only the valid comment');
assert.deepEqual(sent.map((s) => s[0]), ['dm', 'pub'], 'DM first, then public reply');
assert.equal(sent[0][1], 'c1');
assert.equal(get("SELECT tags FROM contacts WHERE external_id='u_ana'").tags, '["lead"]');

// 2) Second read: no repeats and no duplicate events
const before = all("SELECT COUNT(*) n FROM events WHERE kind='duplicate'")[0].n;
assert.equal(await pollOnce(deps(comments)), 0, 'does not repeat the same comment');
assert.equal(sent.length, 2);
assert.equal(all("SELECT COUNT(*) n FROM events WHERE kind='duplicate'")[0].n, before, 'no noise in the log');

// 3) Per-cycle cap: 25 new comments -> 10, 10, 5
const many = Array.from({ length: 25 }, (_, i) => mk('m' + i, 'montage', 60e3, 'u' + i));
assert.equal(await pollOnce(deps(many)), 10);
assert.equal(await pollOnce(deps(many)), 10);
assert.equal(await pollOnce(deps(many)), 5);
assert.equal(await pollOnce(deps(many)), 0);

// 4) Meta slows us (code 4): pause, NOT marked as error, and the comment is retried later
const limited = [mk('r1', 'montage', 60e3, 'zed')];
const rateErr = Object.assign(new Error('Application request limit reached'), { code: 4 });
const failing = () => ({ replyToComment: async () => { throw new Error('must not happen'); }, privateReplyText: async () => { throw rateErr; }, privateReplyButton: async () => { throw rateErr; } });
const sentBefore = sent.length;
assert.equal(await pollOnce(deps(limited, { makeSender: failing })), 1);
assert.ok(throttle.until > Date.now(), 'stays paused');
assert.equal(get("SELECT COUNT(*) n FROM runs WHERE comment_id='r1'").n, 0, 'deleted so it can be retried');
assert.equal(sent.length, sentBefore, 'no public reply was posted');
assert.equal(await pollOnce(deps(limited)), 0, 'paused: does not send');
throttle.until = 0; // the pause ends
assert.equal(await pollOnce(deps(limited)), 1, 'after the pause it is retried');
assert.equal(get("SELECT status FROM runs WHERE comment_id='r1'").status, 'done');

// 5) Another error (not a limit): marked as error and NOT retried
const otherErr = () => ({ replyToComment: async () => {}, privateReplyText: async () => { throw Object.assign(new Error('user not available'), { code: 100 }); }, privateReplyButton: async () => {} });
assert.equal(await pollOnce(deps([mk('e1', 'montage', 60e3, 'bob')], { makeSender: otherErr })), 1);
assert.equal(get("SELECT status FROM runs WHERE comment_id='e1'").status, 'error');
assert.equal(await pollOnce(deps([mk('e1', 'montage', 60e3, 'bob')])), 0, 'does not retry definitive errors');

// 6) Pagination: follows pages while there are new comments and stops as soon as a whole page is old
run("INSERT INTO automations(channel_id,name,media_id,keywords,dm_text,delay_seconds,since) VALUES (1,'P','MP','[\"montage\"]','x',0, datetime('now','-1 hour'))");
run("UPDATE automations SET active=0 WHERE name='A'"); // only the automation of reel MP
const pages = [
  { data: [mk('p1', 'montage', 60e3, 'a1'), mk('p2', 'montage', 61e3, 'a2')], paging: { next: 'x', cursors: { after: 'C1' } } },
  { data: [mk('p3', 'montage', 62e3, 'a3'), mk('p4', 'montage', 63e3, 'a4')], paging: { next: 'x', cursors: { after: 'C2' } } },
  { data: [mk('p5', 'montage', 3 * H, 'a5'), mk('p6', 'montage', 4 * H, 'a6')], paging: { next: 'x', cursors: { after: 'C3' } } }, // before activation
  { data: [mk('p7', 'montage', 5 * H, 'a7')], paging: {} },
];
const asked = [];
const paged = { listComments: async (h, t, media, limit, after) => { asked.push(after); return pages[asked.length - 1]; }, makeSender: sender, pause: async () => {} };
assert.equal(await pollOnce(paged), 4, 'handles the 4 new ones from the first 2 pages');
assert.deepEqual(asked, [null, 'C1', 'C2'], 'asks for 3 pages and stops: the third is already older than the activation');

// Facebook Page: a much lower pace (2 per cycle, 60 per hour); the rest waits. Instagram does not change.
const { limitsFor, VIRAL } = await import('../src/poller.mjs');
assert.deepEqual(limitsFor({ type: 'facebook' }), { perCycle: 2, hourly: 60 });
assert.deepEqual(limitsFor({ type: 'instagram' }), { perCycle: 10, hourly: 600 });
run("UPDATE automations SET active=0");
run("INSERT INTO channels(brand_id, type, ig_user_id, username, token, host) VALUES (1,'facebook','PG1','page','tok','graph.facebook.com')");
const pg = get("SELECT id FROM channels WHERE ig_user_id='PG1'").id;
run(`INSERT INTO automations(channel_id,name,media_id,keywords,dm_text,delay_seconds,since) VALUES (?,'F','P1','["claude"]','hi',0, datetime('now','-1 hour'))`, pg);
const burst = Array.from({ length: 10 }, (_, i) => ({ id: 'v' + i, text: 'Claude', timestamp: iso(60e3) })); // no `from`, like Facebook
assert.equal(await pollOnce(deps(burst)), 2, 'only 2 per minute');
assert.equal(await pollOnce(deps(burst)), 2);
// the hourly limit also counts the attempts Meta rejected
for (let i = 0; i < 56; i++) run("INSERT INTO runs(automation_id, comment_id, status, created_at) VALUES ((SELECT id FROM automations WHERE name='F'), ?, 'error', datetime('now'))", 'x' + i);
assert.equal(await pollOnce(deps(burst)), 0, 'with 60 attempts in the last hour, it waits');
assert.equal(all("SELECT COUNT(*) n FROM runs WHERE comment_id LIKE 'v%'")[0].n, 4, 'the other 6 comments are still pending');

// Viral mode per automation (Facebook only): with 20+ keyword comments, THAT automation drops to 1 per minute and
// 30 per hour for 24 h; another automation on the same Page keeps 2 per minute.
assert.deepEqual([VIRAL.trigger, VIRAL.perCycle, VIRAL.hourly, VIRAL.hours], [20, 1, 30, 24]);
run("UPDATE automations SET active=0");
run("DELETE FROM runs WHERE comment_id LIKE 'x%'");
run(`INSERT INTO automations(channel_id,name,media_id,keywords,dm_text,delay_seconds,since) VALUES (?,'Viral','P2','["claude"]','hi',0, datetime('now','-1 hour'))`, pg);
run(`INSERT INTO automations(channel_id,name,media_id,keywords,dm_text,delay_seconds,since) VALUES (?,'Calm','P3','["guide"]','hi',0, datetime('now','-1 hour'))`, pg);
const avalanche = Array.from({ length: 25 }, (_, i) => ({ id: 'w' + i, text: 'Claude', timestamp: iso(60e3) }));
const few = Array.from({ length: 5 }, (_, i) => ({ id: 't' + i, text: 'guide', timestamp: iso(60e3) }));
const byVideo = deps([], { listComments: async (h, t, mediaId) => ({ data: mediaId === 'P2' ? avalanche : mediaId === 'P3' ? few : [] }) });
assert.equal(await pollOnce(byVideo), 2, "the Page's limit: 2 per minute");
assert.ok(Date.parse(get("SELECT viral_until FROM automations WHERE name='Viral'").viral_until) > Date.now() + 23 * 3600e3, 'viral mode for 24 h');
assert.equal(get("SELECT viral_until FROM automations WHERE name='Calm'").viral_until, null, 'the other one is not viral');
const perAuto = (n) => all('SELECT COUNT(*) c FROM runs r JOIN automations a ON a.id=r.automation_id WHERE a.name=?', n)[0].c;
assert.equal(perAuto('Viral'), 1, 'the viral one: 1 per minute'); assert.equal(perAuto('Calm'), 1, 'the other one uses the rest of the limit');
assert.equal(await pollOnce(byVideo), 2);
assert.equal(perAuto('Viral'), 2); assert.equal(perAuto('Calm'), 2);
assert.equal(all(`SELECT COUNT(*) n FROM events WHERE note LIKE '🔥 "Viral" went viral%'`)[0].n, 1, 'a single notice');
const vid = get("SELECT id FROM automations WHERE name='Viral'").id;
for (let i = 0; i < 28; i++) run("INSERT INTO runs(automation_id, comment_id, status, created_at) VALUES (?, ?, 'done', datetime('now'))", vid, 'y' + i);
const before30 = perAuto('Viral');
const onlyViral = deps([], { listComments: async (h, t, mediaId) => ({ data: mediaId === 'P2' ? avalanche : [] }) });
assert.equal(await pollOnce(onlyViral), 0, 'the viral one reached 30 in the hour');
assert.equal(perAuto('Viral'), before30);

console.log('OK: poller tests passed');
