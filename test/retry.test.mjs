// Retries of DMs Meta rejects temporarily, the per-account pause when Meta restricts a Page, and one contact per
// person on Facebook (Meta does not say who commented on a Page post). Nothing calls Meta: everything is faked.
import assert from 'node:assert/strict';
process.env.DB_FILE = ':memory:';
const { run, get, all } = await import('../src/db.mjs');
const { handleComment, retryDMs, RETRY_MINUTES, isTransientDm, metaError, channelPause, channelPaused, throttle } = await import('../src/engine.mjs');

run("INSERT INTO brands(name) VALUES ('T')");
run("INSERT INTO channels(brand_id, type, ig_user_id, username, token, host) VALUES (1,'facebook','PG1','page','tok','graph.facebook.com')");
run("INSERT INTO channels(brand_id, type, ig_user_id, username, token, host) VALUES (1,'instagram','IG9','other','tok','graph.facebook.com')");
const fb = get('SELECT * FROM channels WHERE id=1');
const ig = get('SELECT * FROM channels WHERE id=2');
run(`INSERT INTO automations(channel_id,name,keywords,public_replies,dm_text,tag,delay_seconds,since,mode)
  VALUES (1,'Guide','["claude"]','["Sent it to your DM!"]','Your guide: https://x.com/g','lead-claude',0, datetime('now','-1 hour'),'link')`);

const denied = () => Object.assign(new Error('Application does not have permission for this action'), { code: 10, subcode: 2018278 });
const sent = [];
// fails: how many times in a row Meta rejects each comment's DM before accepting it
const sender = (fails = {}) => ({
  privateReplyText: async (cid) => { if ((fails[cid] ?? 0) > 0) { fails[cid]--; throw denied(); } sent.push(['dm', cid]); return { recipient_id: 'PSID-' + cid }; },
  privateReplyButton: async () => { throw new Error('not used'); },
  replyToComment: async (cid) => { sent.push(['pub', cid]); return {}; },
});
const comment = async (id, s, channel = fb) => { const l = handleComment(channel, { id, text: 'Claude', media: { id: 'M1' } }, { sender: s, instant: true }); await Promise.all(l.map((x) => x.done)); return l.length; };
const due = () => run("UPDATE runs SET retry_at=? WHERE status='retry'", new Date(Date.now() - 1000).toISOString());

assert.equal(metaError(denied()), 'Application does not have permission for this action (#10/2018278)');
assert.ok(isTransientDm(denied()));
assert.ok(!isTransientDm(new Error('(#10) This message is sent outside of allowed window.')));

// 1) Facebook comments without `from`: each person becomes their own contact (from the id the DM returns)
const s = sender();
assert.equal(await comment('A', s), 1);
assert.equal(await comment('B', s), 1);
const ca = get("SELECT c.* FROM runs r JOIN contacts c ON c.id=r.contact_id WHERE r.comment_id='A'");
const cb = get("SELECT c.* FROM runs r JOIN contacts c ON c.id=r.contact_id WHERE r.comment_id='B'");
assert.equal(ca.external_id, 'PSID-A'); assert.equal(cb.external_id, 'PSID-B');
assert.equal(ca.tags, '["lead-claude"]');
assert.equal(all("SELECT * FROM contacts WHERE external_id='unknown'").length, 0, 'commenters no longer collapse into "unknown"');

// 2) Meta rejects the DM once: the run waits as "retry", no public reply yet, and the retry sends it
const s2 = sender({ C: 1 });
await comment('C', s2);
let r = get("SELECT * FROM runs WHERE comment_id='C'");
assert.equal(r.status, 'retry'); assert.equal(r.dm_retries, 1); assert.equal(r.contact_id, null);
assert.match(r.error, /#10\/2018278/);
assert.ok(Date.parse(r.retry_at) > Date.now(), 'the retry waits');
assert.ok(!sent.some((x) => x[1] === 'C'), 'nothing goes out meanwhile');
assert.equal(await retryDMs(fb, s2), 0, 'not retried before its time');
due();
assert.equal(await retryDMs(fb, s2), 1);
r = get("SELECT * FROM runs WHERE comment_id='C'");
assert.equal(r.status, 'done'); assert.equal(r.dm_status, 'ok'); assert.equal(r.error, null); assert.equal(r.public_reply_status, 'ok');
assert.equal(get('SELECT external_id FROM contacts WHERE id=?', r.contact_id).external_id, 'PSID-C');
assert.deepEqual(sent.filter((x) => x[1] === 'C').map((x) => x[0]), ['dm', 'pub']);

// 3) If Meta always rejects it: tried 1 + N times, then an error with Meta's code
const s3 = sender({ D: 99 });
await comment('D', s3);
for (let i = 0; i < RETRY_MINUTES.length; i++) { due(); assert.equal(await retryDMs(fb, s3), 1); }
r = get("SELECT * FROM runs WHERE comment_id='D'");
assert.equal(r.status, 'error'); assert.equal(r.dm_retries, RETRY_MINUTES.length); assert.equal(r.retry_at, null);
assert.match(r.error, /#10\/2018278/);
due(); assert.equal(await retryDMs(fb, s3), 0, 'no more retries');
assert.ok(get("SELECT * FROM events WHERE note LIKE 'DM failed%retries)'"), 'the final error says it was retried');

// 4) A comment past Meta's 7 days is not retried: it becomes an error
const s4 = sender({ E: 5 });
await comment('E', s4);
run("UPDATE runs SET comment_at=? WHERE comment_id='E'", new Date(Date.now() - 8 * 24 * 3600e3).toISOString());
due(); assert.equal(await retryDMs(fb, s4), 1);
assert.equal(get("SELECT status FROM runs WHERE comment_id='E'").status, 'error');

// 5) An error that is not temporary goes straight to error (no retries)
const s5 = { ...sender(), privateReplyText: async () => { throw Object.assign(new Error('This user cant reply to this activity'), { code: 10, subcode: 2018108 }); } };
await comment('F', s5);
r = get("SELECT * FROM runs WHERE comment_id='F'");
assert.equal(r.status, 'error'); assert.equal(r.dm_retries, 0);

// 6) Page restricted by Meta (#10/1893063): ONLY that account pauses, no attempt is spent, and nothing insists
const restricted = () => Object.assign(new Error('Application does not have permission for this action'), { code: 10, subcode: 1893063 });
let calls = 0;
const s6 = { ...sender(), privateReplyText: async () => { calls++; throw restricted(); } };
await comment('G', s6);
r = get("SELECT * FROM runs WHERE comment_id='G'");
assert.equal(r.status, 'retry'); assert.equal(r.dm_retries, 0, 'a restriction does not spend an attempt');
assert.match(r.error, /#10\/1893063/);
assert.ok(Date.parse(r.retry_at) > Date.now() + 50 * 60000, 'waits for the pause to end');
assert.ok(channelPaused(fb)); assert.ok(!channelPaused(ig), 'other accounts keep going');
assert.equal(await comment('H', s6), 0, "the paused account's new comments wait (no run is created)");
assert.equal(get("SELECT * FROM runs WHERE comment_id='H'"), undefined);
due(); assert.equal(await retryDMs(fb, s6), 0, 'nothing is retried during the pause');
assert.equal(calls, 1, 'Meta was asked only once');
assert.equal(all("SELECT * FROM events WHERE note LIKE 'Meta restricted messages from @page%'").length, 1);
// when the pause ends it resumes
channelPause.set(fb.id, 0);
const s7 = sender();
due(); assert.equal(await retryDMs(fb, s7), 1);
assert.equal(get("SELECT status FROM runs WHERE comment_id='G'").status, 'done');
assert.equal(await comment('H', s7), 1, 'the comment that waited is handled');

// 7) Meta's documented text for the restriction (no subcode) must pause only that account, not every account:
// "restricted" also matches the global block check, so the order of the checks matters.
const s8 = { ...sender(), privateReplyText: async () => { throw Object.assign(new Error('You are temporarily restricted from sending messages'), { code: 10 }); } };
await comment('I', s8);
assert.ok(channelPaused(fb), 'the Page is paused');
assert.ok(throttle.until <= Date.now(), 'the global pause is NOT used');
assert.equal(get("SELECT status FROM runs WHERE comment_id='I'").status, 'retry', 'the run is kept, not deleted');

console.log('OK: DM retry tests passed');
