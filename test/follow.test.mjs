// Tests for "ask for a follow before the resource" (Instagram only). Nothing calls Meta: everything is faked.
import assert from 'node:assert/strict';
process.env.DB_FILE = ':memory:';
const { run, get, all } = await import('../src/db.mjs');
const { handleComment, throttle, DEFAULT_FOLLOW, DEFAULT_FOLLOW_RETRY, FOLLOW_BUTTON, FOLLOW_HINT, drySender } = await import('../src/engine.mjs');
const { pollDMs, captureCounts } = await import('../src/capture.mjs');
const { automationFields } = await import('../src/automations.mjs');
const { analytics } = await import('../src/analytics.mjs');

// ---- setup: one brand with Instagram (channel 1) and its Facebook Page (channel 2) ----
run("INSERT INTO brands(name) VALUES ('T')");
run("INSERT INTO channels(brand_id, type, ig_user_id, username, token, host) VALUES (1,'instagram','IG1','account','tok-ig','graph.facebook.com')");
run("INSERT INTO channels(brand_id, type, ig_user_id, username, token, host) VALUES (1,'facebook','PG1','page','tok-page','graph.facebook.com')");
const ig = get('SELECT * FROM channels WHERE id=1'), fb = get('SELECT * FROM channels WHERE id=2');
const auto = (channel, name, kw) => run(`INSERT INTO automations(channel_id,name,keywords,public_replies,dm_text,tag,delay_seconds,since,mode,follow_gate,follow_text)
  VALUES (${channel},'${name}','["${kw}"]','["done"]','Here is the guide: https://x.com/g','lead',0, datetime('now','-1 hour'),'link',1,'Follow me and I will send you the guide 👇')`);
auto(1, 'Guide', 'guide');
auto(2, 'Guide FB', 'guide');

const sent = [];
const sender = (igsid, { quickFails = false } = {}) => ({
  privateReplyText: async (cid, t) => { sent.push(['text', cid, t]); return { recipient_id: igsid }; },
  privateReplyButton: async (cid, t, title, url) => { sent.push(['button', cid, t, url]); return { recipient_id: igsid }; },
  privateReplyQuick: async (cid, t, replies) => { if (quickFails) throw Object.assign(new Error('Unsupported'), { code: 100 }); sent.push(['quick', cid, t, replies]); return { recipient_id: igsid }; },
  replyToComment: async (cid, t) => { sent.push(['pub', cid, t]); return {}; },
});
const comment = async (channel, id, uid, opts) => { const l = handleComment(channel, { id, text: 'Guide', username: 'u' + uid, from: { id: uid, username: 'u' + uid }, media: { id: 'M1' } }, { sender: sender(uid, opts), instant: true }); await Promise.all(l.map((x) => x.done)); return l.length; };
const at = (ms) => new Date(Date.now() + ms).toISOString().replace('Z', '+0000');
const msg = (from, text, ms) => ({ id: 'x' + Math.random(), from: { id: from }, message: text, created_time: at(ms) });
const conv = (...m) => ({ id: 'c' + Math.random(), messages: { data: m } });

const out = []; const checks = [];
const follows = {}; // igsid -> true/false
const deps = (conversations, extra = {}) => ({
  listConversations: async () => ({ data: conversations }),
  conversationByUser: async () => ({ data: [] }),
  sendText: async (h, t, i, to, text) => { out.push(['text', to, text]); return {}; },
  sendButton: async (h, t, i, to, text, title, url) => { out.push(['button', to, text, title, url]); return {}; },
  sendQuick: async (h, t, i, to, text, replies) => { out.push(['quick', to, text, replies]); return {}; },
  // like Meta: the system user token gets error #100; only the Page token answers
  isFollower: async (h, token, igsid) => { checks.push(token); if (token !== 'tok-page') throw Object.assign(new Error('(#100) The page is not linked to an Instagram account'), { code: 100 }); return follows[igsid] === true; },
  pause: async () => {}, ...extra,
});

// 1) The comment sends ONLY the DM asking for the follow, with the «I follow you» button; no resource yet
assert.equal(await comment(ig, 'C1', 'U1'), 1);
assert.deepEqual(sent.map((s) => s[0]), ['quick', 'pub']);
assert.equal(sent[0][2], 'Follow me and I will send you the guide 👇');
assert.deepEqual(sent[0][3], [FOLLOW_BUTTON]);
assert.ok(!sent.some((s) => String(s[2]).includes('https://x.com/g')), 'the resource is not sent before the follow');
let cap = get("SELECT * FROM captures WHERE igsid='U1'");
assert.equal(cap.status, 'waiting_follow'); assert.equal(cap.follow, 1); assert.equal(cap.email_asked, 0);
assert.equal(get("SELECT tags FROM contacts WHERE external_id='U1'").tags, '[]', 'the tag is added when they get the resource');
assert.equal(captureCounts().waitingFollow, 1);

// 2) No new message from them: nothing is checked
await pollDMs(deps([conv(msg('IG1', 'ours', 1000))]));
assert.equal(checks.length, 0); assert.equal(out.length, 0);

// 3) They tap «I follow you» but do not follow yet -> notice with the button again; the Page token is used
follows.U1 = false;
const tap1 = msg('U1', 'I follow you', 2000);
await pollDMs(deps([conv(tap1)]));
assert.deepEqual(out.at(-1), ['quick', 'U1', DEFAULT_FOLLOW_RETRY, [FOLLOW_BUTTON]]);
assert.deepEqual(checks, ['tok-ig', 'tok-page'], "tries the account's token, then the Page's");
assert.equal(get("SELECT status FROM captures WHERE igsid='U1'").status, 'waiting_follow');
const n = out.length; await pollDMs(deps([conv(tap1)])); assert.equal(out.length, n, 'the same message does not trigger anything again');

// 4) Now they follow and tap again -> the resource goes out, the tag is added. The working token is remembered.
follows.U1 = true; checks.length = 0;
await pollDMs(deps([conv(tap1, msg('U1', 'I follow you', 60000))]));
assert.deepEqual(checks, ['tok-page'], 'uses the token that already worked');
assert.equal(out.at(-1)[0], 'text'); assert.ok(out.at(-1)[2].includes('https://x.com/g'));
cap = get("SELECT * FROM captures WHERE igsid='U1'");
assert.equal(cap.status, 'done'); assert.ok(cap.followed_at); assert.equal(cap.email, null);
assert.equal(get("SELECT tags FROM contacts WHERE external_id='U1'").tags, '["lead"]');

// 5) After 2 notices it stops insisting (only checks quietly), and if they finally follow they get the resource
await comment(ig, 'C2', 'U2'); follows.U2 = false; out.length = 0;
await pollDMs(deps([conv(msg('U2', 'done', 3000))]));
await pollDMs(deps([conv(msg('U2', 'done', 4000))]));
await pollDMs(deps([conv(msg('U2', 'done', 5000))]));
assert.equal(out.length, 2, 'at most two "you do not follow yet" notices');
follows.U2 = true;
await pollDMs(deps([conv(msg('U2', 'ok', 6000))]));
assert.equal(get("SELECT status FROM captures WHERE igsid='U2'").status, 'done');

// 6) If Meta does not let us check the follow (no token works), the resource is sent anyway: nobody is lost
await comment(ig, 'C3', 'U3'); out.length = 0;
await pollDMs(deps([conv(msg('U3', 'I follow you', 3000))], { isFollower: async () => { throw Object.assign(new Error('Unsupported get request'), { code: 100 }); } }));
assert.equal(get("SELECT status FROM captures WHERE igsid='U3'").status, 'done');
assert.ok(out.at(-1)[2].includes('https://x.com/g'));

// 7) Meta slows us down while checking -> pause, and the same message is handled afterwards
await comment(ig, 'C4', 'U4'); follows.U4 = true; out.length = 0;
const tap4 = msg('U4', 'I follow you', 3000);
await pollDMs(deps([conv(tap4)], { isFollower: async () => { throw Object.assign(new Error('Application request limit reached'), { code: 4 }); } }));
assert.equal(get("SELECT status FROM captures WHERE igsid='U4'").status, 'waiting_follow'); assert.ok(throttle.until > Date.now());
throttle.until = 0;
await pollDMs(deps([conv(tap4)]));
assert.equal(get("SELECT status FROM captures WHERE igsid='U4'").status, 'done', 'the same tap is handled after the pause');

// 8) If Meta does not accept the button in the first DM, the text with the instruction goes out
sent.length = 0;
await comment(ig, 'C5', 'U5', { quickFails: true });
assert.equal(sent[0][0], 'text'); assert.equal(sent[0][2], `Follow me and I will send you the guide 👇\n\n${FOLLOW_HINT}`);
assert.equal(get("SELECT status FROM captures WHERE igsid='U5'").status, 'waiting_follow');

// 9) On a Facebook Page there is no follow step: the resource goes right away and there is no capture
sent.length = 0;
await comment(fb, 'C6', 'F1');
assert.equal(sent[0][0], 'text'); assert.ok(sent[0][2].includes('https://x.com/g'));
assert.equal(all("SELECT * FROM captures WHERE igsid='F1'").length, 0);

// 10) Follow + email: after the follow the email is asked for, and the email brings the resource
run(`INSERT INTO automations(channel_id,name,keywords,public_replies,dm_text,delay_seconds,since,mode,ask_text,follow_gate,skip_known)
     VALUES (1,'Guide email','["mail"]','[]','Your guide: https://x.com/e',0, datetime('now','-1 hour'),'email','Send me your email',1,1)`);
sent.length = 0;
const l = handleComment(ig, { id: 'C7', text: 'mail', username: 'u6', from: { id: 'U6', username: 'u6' }, media: { id: 'M1' } }, { sender: sender('U6'), instant: true });
await Promise.all(l.map((x) => x.done));
assert.equal(sent[0][0], 'quick'); assert.equal(sent[0][2], DEFAULT_FOLLOW.replace('{{username}}', 'u6'), 'without its own text it uses the default');
follows.U6 = true; out.length = 0;
await pollDMs(deps([conv(msg('U6', 'I follow you', 3000))]));
assert.deepEqual(out.at(-1), ['text', 'U6', 'Send me your email']);
cap = get("SELECT * FROM captures WHERE igsid='U6'");
assert.equal(cap.status, 'waiting'); assert.equal(cap.email_asked, 1); assert.ok(cap.followed_at);
await pollDMs(deps([conv(msg('U6', 'I follow you', 3000), msg('U6', 'six@mail.com', 90000))]));
assert.equal(get("SELECT status FROM captures WHERE igsid='U6'").status, 'done');
assert.ok(out.at(-1)[2].includes('https://x.com/e'));

// 11) Analytics: the follow step does not count as an email, and shows how many followed
const an = analytics({ range: 7 });
assert.equal(an.totals.emails, 1, 'only U6 gave an email');
assert.equal(an.totals.asked, 1, 'only U6 was asked for an email');
assert.equal(an.follow.asked, 6); assert.equal(an.follow.followed, 5, 'U1, U2, U3, U4 and U6 passed the follow step');

// 12) Meta returns SOMEONE ELSE's conversation for a user_id lookup: that message does not count for this capture
assert.equal(await comment(ig, 'C-X1', 'UX1'), 1);
assert.equal(await comment(ig, 'C-X2', 'UX2'), 1);
follows.UX1 = true; follows.UX2 = true;
const other = conv(msg('UX2', 'I follow you', 5000));
const outX = out.length;
await pollDMs(deps([], { conversationByUser: async () => ({ data: [other] }) }));
assert.equal(get("SELECT status FROM captures WHERE igsid='UX1'").status, 'waiting_follow', 'UX1 did not write: still waiting');
assert.equal(get("SELECT status FROM captures WHERE igsid='UX2'").status, 'done', 'UX2 did write: gets the resource');
assert.deepEqual(out.slice(outX).map((o) => o[1]), ['UX2'], 'only the person who answered gets a message');

// 13) Dashboard simulation: shows the follow DM and sends nothing
const log = [];
const ls = handleComment(ig, { id: 'SIM1', text: 'guide', from: { id: 'sim', username: 'test' }, media: { id: 'M1' } }, { sender: drySender(log), dry: true, instant: true });
await Promise.all(ls.map((x) => x.done));
assert.equal(log[0].action, 'dm_follow'); assert.equal(all("SELECT * FROM captures WHERE igsid='sim'").length, 0);

// 14) Validation
const f = automationFields({ channel_id: 1, name: 'x', dm_text: 'y', follow_gate: true, follow_text: ' Follow me ' });
assert.deepEqual(f.slice(-3), [1, 'Follow me', null]);
assert.throws(() => automationFields({ channel_id: 1, name: 'x', dm_text: 'y', follow_gate: 1, follow_text: 'á'.repeat(600) }), /follow is too long/);

console.log('OK: follow gate tests passed');
