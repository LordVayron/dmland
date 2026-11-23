// Facebook Page support: request shapes (fetch is faked, nothing leaves the machine), data normalization,
// webhook mapping and that the shared engine/poller/capture code picks the Facebook client for 'facebook' accounts.
import assert from 'node:assert/strict';
process.env.DB_FILE = ':memory:';

const calls = [];
let reply = {};
globalThis.fetch = async (url, opts = {}) => {
  calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null, auth: opts.headers?.Authorization });
  return new Response(JSON.stringify(typeof reply === 'function' ? reply(String(url)) : reply), { status: 200, headers: { 'content-type': 'application/json' } });
};
const last = () => calls[calls.length - 1];
const path = () => decodeURIComponent(new URL(last().url).pathname + new URL(last().url).search);

const fb = await import('../src/facebook.mjs');
const { apiFor } = await import('../src/platform.mjs');
const { realSender, withUtm } = await import('../src/engine.mjs');
const H = 'graph.facebook.com';

// ---- platform picker ----
assert.equal(apiFor('facebook'), fb);
assert.notEqual(apiFor('instagram'), fb);
assert.notEqual(apiFor(undefined), fb, 'older rows without a type stay on Instagram');

// ---- account: Pages without a username use their name without spaces ----
reply = { id: '111', name: 'Acme Studio Page' };
assert.equal((await fb.getAccount(H, 'tok', '111')).username, 'AcmeStudioPage');
reply = { id: '111', name: 'Acme', username: 'acme.studio' };
assert.equal((await fb.getAccount(H, 'tok', '111')).username, 'acme.studio');
assert.equal(last().auth, 'Bearer tok', 'the token travels in the header, never in the URL');

// ---- posts come back in the shape the dashboard already uses ----
const postsReply = { data: [{ id: '111_1', message: 'Hello', permalink_url: 'https://fb.example/p/1', created_time: '2026-11-12T22:54:24+0000', full_picture: 'https://img.example/1.jpg',
  likes: { summary: { total_count: 7 } }, comments: { summary: { total_count: 3 } } }] };
const reelsReply = { data: [{ id: '777', description: 'Reel text', created_time: '2026-11-13T10:00:00+0000', permalink_url: '/reel/777/', picture: 'https://img.example/r.jpg' }] };
reply = (u) => (u.includes('/video_reels') ? reelsReply : postsReply);
let n0 = calls.length;
const posts = await fb.listMedia(H, 'tok', '111');
const urls = calls.slice(n0).map((c) => decodeURIComponent(new URL(c.url).pathname));
assert.ok(urls.includes('/v27.0/111/published_posts'), 'reads the Page posts');
assert.ok(urls.includes('/v27.0/111/video_reels'), 'reads the Page reels too');
assert.equal(posts.data.length, 2);
assert.deepEqual(posts.data[0], { id: '777', caption: 'Reel text', media_type: 'REELS', thumbnail_url: 'https://img.example/r.jpg', media_url: 'https://img.example/r.jpg',
  permalink: 'https://www.facebook.com/reel/777/', timestamp: '2026-11-13T10:00:00+0000', like_count: null, comments_count: null }, 'newest first, reels in the same shape');
assert.deepEqual(posts.data[1], { id: '111_1', caption: 'Hello', media_type: 'POST', thumbnail_url: 'https://img.example/1.jpg', media_url: 'https://img.example/1.jpg',
  permalink: 'https://fb.example/p/1', timestamp: '2026-11-12T22:54:24+0000', like_count: 7, comments_count: 3 });
// a reel that is also listed as a post is the same video: only the post stays
reply = (u) => (u.includes('/video_reels') ? { data: [...reelsReply.data, { id: '888', description: 'Hello', created_time: '2026-11-12T22:54:00+0000', post_id: '1' }] } : postsReply);
assert.deepEqual((await fb.listMedia(H, 'tok', '111')).data.map((m) => m.id), ['777', '111_1']);
// if Meta refuses the reels list, the posts still come back
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => (String(url).includes('/video_reels')
  ? new Response(JSON.stringify({ error: { message: 'nope', code: 100 } }), { status: 400, headers: { 'content-type': 'application/json' } })
  : realFetch(url, opts));
assert.deepEqual((await fb.listMedia(H, 'tok', '111')).data.map((m) => m.id), ['111_1']);
globalThis.fetch = realFetch;

// ---- connecting: the system user token is exchanged for the Page token ----
reply = { id: '111', name: 'Acme', access_token: 'PAGE-TOKEN' };
const acct = await fb.getAccount(H, 'sys', '111');
assert.equal(acct.page_token, 'PAGE-TOKEN');
assert.equal(acct.access_token, undefined, 'the raw token is not passed around under its Meta name');
assert.ok(path().includes('fields=id,name,username,access_token'));
// checkAccess names the missing permission
globalThis.fetch = async (url) => (String(url).includes('/comments')
  ? new Response(JSON.stringify({ error: { message: "(#10) This endpoint requires the 'pages_read_user_content' permission", code: 10 } }), { status: 400, headers: { 'content-type': 'application/json' } })
  : new Response(JSON.stringify({ data: [{ id: '111_1' }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
await assert.rejects(fb.checkAccess(H, 'PAGE-TOKEN', '111'), /pages_read_user_content/);
globalThis.fetch = realFetch;

// ---- comments: newest first, top-level only, normalized ----
reply = { data: [{ id: '111_1_9', message: 'GUIDE', from: { id: 'u1', name: 'Ana' }, created_time: '2026-11-12T22:54:24+0000' }, { id: '111_1_8', message: 'hi', created_time: '2026-11-12T22:50:00+0000' }], paging: { cursors: { after: 'C' } } };
const cm = await fb.listComments(H, 'tok', '111_1', 50, 'AFTER 1');
assert.ok(path().includes('/111_1/comments') && path().includes('order=reverse_chronological') && path().includes('filter=toplevel') && path().includes('after=AFTER 1'));
assert.deepEqual(cm.data[0], { id: '111_1_9', text: 'GUIDE', username: 'Ana', timestamp: '2026-11-12T22:54:24+0000', from: { id: 'u1', username: 'Ana' } });
assert.equal(cm.data[1].from.id, null, 'a commenter Facebook hides has no id');
assert.equal(cm.paging.cursors.after, 'C');

// ---- sending ----
reply = { recipient_id: 'PSID1', message_id: 'm.1' };
await fb.privateReplyText(H, 'tok', '111', '111_1_9', 'hi');
assert.equal(path(), '/v27.0/111/messages');
assert.deepEqual(last().body, { recipient: { comment_id: '111_1_9' }, message: { text: 'hi' } });
await fb.privateReplyButton(H, 'tok', '111', '111_1_9', 'x'.repeat(700), 'A very long button title here', 'https://example.com');
const btn = last().body.message.attachment.payload;
assert.equal(btn.template_type, 'button'); assert.equal(btn.text.length, 640); assert.equal(btn.buttons[0].title.length, 20); assert.equal(btn.buttons[0].url, 'https://example.com');
await fb.replyToComment(H, 'tok', '111_1_9', 'Sent!');
assert.equal(path(), '/v27.0/111_1_9/comments', 'the public reply is a comment under the comment');
assert.deepEqual(last().body, { message: 'Sent!' });
await fb.sendText(H, 'tok', '111', 'PSID1', 'follow up');
assert.deepEqual(last().body, { recipient: { id: 'PSID1' }, messaging_type: 'RESPONSE', message: { text: 'follow up' } });
await fb.sendButton(H, 'tok', '111', 'PSID1', 'res', 'Open', 'https://example.com');
assert.equal(last().body.messaging_type, 'RESPONSE');
await fb.subscribeWebhooks(H, 'tok', '111');
assert.ok(path().includes('/111/subscribed_apps') && path().includes('subscribed_fields=feed,messages'));

// ---- conversations are Messenger ones ----
reply = { data: [] };
await fb.listConversations(H, 'tok', '111', 30);
assert.ok(path().includes('platform=messenger'));
await fb.conversationByUser(H, 'tok', '111', 'PSID1');
assert.ok(path().includes('platform=messenger') && path().includes('user_id=PSID1'));

// ---- stats ----
reply = { followers_count: 120, fan_count: 100 };
assert.deepEqual(await fb.getAccountStats(H, 'tok', '111'), { followers_count: 120, media_count: null });
reply = { fan_count: 100 };
assert.equal((await fb.getAccountStats(H, 'tok', '111')).followers_count, 100, 'falls back to fan_count');
assert.deepEqual(await fb.getMediaInsights(), {}); assert.deepEqual(await fb.getAccountInsights(), {});

// ---- webhook "feed" event ----
const ev = { item: 'comment', verb: 'add', comment_id: '111_1_9', post_id: '111_1', parent_id: '111_1', message: 'GUIDE', from: { id: 'u1', name: 'Ana' }, created_time: 1794524064 };
assert.deepEqual(fb.commentFromWebhook(ev), { id: '111_1_9', text: 'GUIDE', username: 'Ana', timestamp: '2026-11-12T22:54:24+0000', from: { id: 'u1', username: 'Ana' }, media: { id: '111_1' } });
assert.equal(fb.commentFromWebhook({ ...ev, parent_id: '111_1_5' }), null, 'a reply to a comment is ignored');
assert.equal(fb.commentFromWebhook({ ...ev, verb: 'edited' }), null);
assert.equal(fb.commentFromWebhook({ ...ev, item: 'reaction' }), null);
assert.equal(fb.commentFromWebhook(null), null);

// ---- the shared engine picks the right client for the account's platform ----
calls.length = 0; reply = { recipient_id: 'PSID1' };
await realSender(H, 'tok', '111', 'facebook').privateReplyText('c1', 'x');
assert.ok(path().endsWith('/111/messages'));
await realSender(H, 'tok', '111', 'facebook').replyToComment('c1', 'x');
assert.ok(path().endsWith('/c1/comments'), 'Facebook public reply');
await realSender(H, 'tok', '17841', 'instagram').replyToComment('c1', 'x');
assert.ok(path().endsWith('/c1/replies'), 'Instagram public reply is unchanged');
await realSender(H, 'tok', '17841').replyToComment('c1', 'x');
assert.ok(path().endsWith('/c1/replies'), 'default platform is Instagram');

// ---- UTM source follows the platform ----
const au = { utm: 1, keywords: '["guide"]', name: 'g' };
assert.ok(withUtm('https://x.com', au, 'facebook').includes('utm_source=facebook'));
assert.ok(withUtm('https://x.com', au).includes('utm_source=instagram'));

// ---- the poller reads a Facebook Page with Facebook calls and sends the Page's own replies ----
const { run, get } = await import('../src/db.mjs');
const { pollOnce } = await import('../src/poller.mjs');
run("INSERT INTO brands(name) VALUES ('T')");
run("INSERT INTO channels(brand_id, type, ig_user_id, username, token, host) VALUES (1,'facebook','111','AcmePage','tok','graph.facebook.com')");
run(`INSERT INTO automations(channel_id,name,media_id,keywords,public_replies,dm_text,delay_seconds,since)
     VALUES (1,'FB','111_1','["guide"]','["sent"]','here {{username}}',0, datetime('now','-1 hour'))`);
const seenTypes = [], sent = [];
const iso = (ago) => new Date(Date.now() - ago).toISOString().replace('Z', '+0000');
const deps = {
  listComments: async (h, t, m, l, a, type) => { seenTypes.push(type); return { data: [
    { id: 'k1', text: 'GUIDE', username: 'Ana', timestamp: iso(60e3), from: { id: 'u1', username: 'Ana' } },
    { id: 'k2', text: 'GUIDE', username: 'AcmePage', timestamp: iso(60e3), from: { id: '111', username: 'AcmePage' } }, // the Page itself
  ] }; },
  makeSender: (h, t, id, type) => { seenTypes.push('sender:' + type); return {
    replyToComment: async (id2, tx) => sent.push(['pub', id2, tx]),
    privateReplyText: async (id2, tx) => { sent.push(['dm', id2, tx]); return { recipient_id: 'PSID1' }; },
    privateReplyButton: async () => ({}) }; },
  pause: async () => {},
};
assert.equal(await pollOnce(deps), 1, 'one comment answered; the Page does not answer itself');
assert.deepEqual(sent.map((s) => s[0]), ['dm', 'pub']);
assert.ok(seenTypes.includes('facebook') && seenTypes.includes('sender:facebook'), 'the poller passes the platform on');
assert.equal(get("SELECT status FROM runs WHERE comment_id='k1'").status, 'done');

console.log('OK: facebook tests passed');
