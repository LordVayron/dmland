// Email capture by DM:
//   1) the comment triggers the first DM that asks for the email (engine.mjs does that and leaves a row in `captures`)
//   2) here the DMs from waiting people are read, the email is extracted and the resource is sent.
// Meta only lets you write to someone within 24 h of their last message: exactly what we use.
import { all, get, run, logEvent } from './db.mjs';
import { apiFor } from './platform.mjs';
import { fill, json, addTag, isRateLimit, isBlocked, throttle, parseMetaTime, withUtm, DEFAULT_RETRY, DEFAULT_ASK, DEFAULT_FOLLOW_RETRY, FOLLOW_BUTTON } from './engine.mjs';
import * as meta from './meta.mjs';

const EXPIRE_DAYS = 3;          // if they do not answer in 3 days, stop watching
const MAX_LOOKUPS = 10;         // individual lookups per cycle (Meta: 2 calls/second per account)
const MAX_RESOURCES = 20;       // resources sent per cycle and account
const MAX_FOLLOW_RETRIES = 2;   // times we say "you do not follow yet"; after that it only checks quietly
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
// Accepts "my email is Ana@Test.com!" and returns "ana@test.com"; null if there is no email.
export const extractEmail = (text) => {
  const m = String(text ?? '').match(EMAIL_RE);
  const e = m?.[0]?.toLowerCase();
  return e && e.length <= 254 ? e : null;
};

export const captureCounts = () => {
  const r = all("SELECT status, COUNT(*) AS n FROM captures WHERE status IN ('waiting','got_email','waiting_follow') GROUP BY status");
  const n = (st) => r.find((x) => x.status === st)?.n ?? 0;
  return { waiting: n('waiting'), gotEmail: n('got_email'), waitingFollow: n('waiting_follow') };
};

// The last argument of each call is the account's platform ('instagram' | 'facebook').
const defaults = {
  listConversations: (host, token, id, limit, type) => apiFor(type).listConversations(host, token, id, limit),
  conversationByUser: (host, token, id, userId, type) => apiFor(type).conversationByUser(host, token, id, userId),
  sendText: (host, token, id, to, text, type) => apiFor(type).sendText(host, token, id, to, text),
  sendButton: (host, token, id, to, text, title, url, type) => apiFor(type).sendButton(host, token, id, to, text, title, url),
  sendQuick: (host, token, id, to, text, replies) => meta.sendQuick(host, token, id, to, text, replies),
  isFollower: (host, token, igsid) => meta.isFollower(host, token, igsid),
  pause: () => sleep(600),
};

// Does the person follow the Instagram account? true | false | null (could not tell).
// Meta only answers with the token of the Facebook Page linked to that account: the account's token is tried first,
// then each connected Page (same brand first). The one that worked is remembered.
const followTokenOf = new Map(); // Instagram channel id -> id of the channel whose token works
export async function checkFollower(d, ch, igsid) {
  const pages = all("SELECT * FROM channels WHERE type='facebook' AND token IS NOT NULL ORDER BY (brand_id=?) DESC, id", ch.brand_id);
  const candidates = [ch, ...pages];
  const known = followTokenOf.get(ch.id);
  if (known) candidates.sort((x, y) => (y.id === known) - (x.id === known));
  let lastErr = null;
  for (const c of candidates) {
    try { const r = await d.isFollower(c.host, c.token, igsid); followTokenOf.set(ch.id, c.id); return r; }
    catch (e) { if (isRateLimit(e) || isBlocked(e)) throw e; lastErr = e; }
  }
  if (lastErr) logEvent('warn', `Could not check whether they follow @${ch.username} (${lastErr.message}). Sending the resource anyway.`);
  return null;
}

function saveEmail(capture, automation, email) {
  const contact = get('SELECT * FROM contacts WHERE id=?', capture.contact_id);
  if (!contact) return;
  const f = json(contact.fields, {});
  f.email = email; f.email_at = new Date().toISOString(); f.email_from = automation.name;
  run('UPDATE contacts SET fields=? WHERE id=?', JSON.stringify(f), contact.id);
}

// Sends the resource (final DM). Returns true if it went out or is definitively settled.
async function sendResource(d, ch, capture, automation, okNote = null) {
  if (throttle.until > Date.now()) return false; // Meta asked for a pause: retry on the next cycle
  const vars = { username: capture.username || '', first_name: capture.username || '' };
  const text = withUtm(fill(automation.dm_text, vars), automation, ch.type);
  const buttonUrl = withUtm(automation.button_url, automation, ch.type);
  try {
    if (automation.button_url) {
      try { await d.sendButton(ch, capture.igsid, text, automation.button_title || 'Abrir', buttonUrl); }
      catch (e) { if (isRateLimit(e) || isBlocked(e)) throw e; await d.sendText(ch, capture.igsid, `${text}\n${buttonUrl}`); }
    } else {
      await d.sendText(ch, capture.igsid, text);
    }
  } catch (e) {
    if (isRateLimit(e) || isBlocked(e)) {
      const minutes = isBlocked(e) ? 60 : 10;
      throttle.until = Date.now() + minutes * 60000; throttle.reason = e.message;
      logEvent('error', `Meta paused sending (${e.message}). Pausing ${minutes} min; the resource is sent later.`);
      return false;
    }
    run("UPDATE captures SET status='failed', error=? WHERE id=?", e.message, capture.id);
    logEvent('error', `Could not send the resource to @${capture.username}: ${e.message}`);
    return true;
  }
  run("UPDATE captures SET status='done', done_at=CURRENT_TIMESTAMP, error=NULL WHERE id=?", capture.id);
  const contact = get('SELECT * FROM contacts WHERE id=?', capture.contact_id);
  if (contact) addTag(contact, automation.tag);
  logEvent('run', okNote ? `${okNote} @${capture.username} ("${automation.name}")` : `Email captured and resource sent to @${capture.username} ("${automation.name}")`); // the email is not written to the log
  return true;
}

const pauseFor = (e) => { const minutes = isBlocked(e) ? 60 : 10; throttle.until = Date.now() + minutes * 60000; throttle.reason = e.message;
  logEvent('error', `Meta paused sending (${e.message}). Pausing ${minutes} min; it is retried later.`); };

// Follow step: the person wrote to us (tapped the button or replied). If they follow, the normal flow continues:
// in email mode they are asked for their email; otherwise the resource goes out. If we could not tell, it is sent
// anyway (nobody is lost).
async function handleFollow(d, ch, capture, automation, fresh) {
  if (throttle.until > Date.now()) return;
  const lastAt = new Date(parseMetaTime(fresh[fresh.length - 1].created_time)).toISOString();
  const mark = new Date(Math.max(Date.now(), Date.parse(lastAt))).toISOString();
  const vars = { username: capture.username || '' };
  const retryText = fill(automation.follow_retry_text || DEFAULT_FOLLOW_RETRY, vars);
  let follows;
  try { follows = await checkFollower(d, ch, capture.igsid); }
  catch (e) { pauseFor(e); return; }
  if (follows === false) {
    if (capture.retries >= MAX_FOLLOW_RETRIES) { run('UPDATE captures SET last_msg_at=? WHERE id=?', mark, capture.id); return; }
    try {
      try { await d.sendQuick(ch, capture.igsid, retryText, [FOLLOW_BUTTON]); }
      catch (e) { if (isRateLimit(e) || isBlocked(e)) throw e; await d.sendText(ch, capture.igsid, retryText); } // no button: same notice as text
      run('UPDATE captures SET retries=retries+1, last_msg_at=? WHERE id=?', mark, capture.id);
    } catch (e) {
      if (isRateLimit(e) || isBlocked(e)) { pauseFor(e); return; }
      run("UPDATE captures SET status='failed', error=? WHERE id=?", e.message, capture.id);
      logEvent('error', `Could not tell @${capture.username} they do not follow yet: ${e.message}`);
    }
    return;
  }
  const contact = get('SELECT * FROM contacts WHERE id=?', capture.contact_id);
  const knownEmail = automation.skip_known ? json(contact?.fields, {}).email : null;
  if (automation.mode === 'email' && !knownEmail) {
    try { await d.sendText(ch, capture.igsid, fill(automation.ask_text || DEFAULT_ASK, vars)); }
    catch (e) {
      if (isRateLimit(e) || isBlocked(e)) { pauseFor(e); return; }
      run("UPDATE captures SET status='failed', error=? WHERE id=?", e.message, capture.id);
      logEvent('error', `Could not ask @${capture.username} for the email: ${e.message}`); return;
    }
    const now = new Date().toISOString();
    run("UPDATE captures SET status='waiting', followed_at=?, email_asked=1, asked_at=?, last_msg_at=?, retries=0 WHERE id=?", now, now, mark, capture.id);
    logEvent('run', `@${capture.username} ${follows ? 'follows us' : 'replied'}: asked for the email ("${automation.name}")`);
    return;
  }
  run('UPDATE captures SET followed_at=?, last_msg_at=? WHERE id=?', new Date().toISOString(), mark, capture.id);
  const done = await sendResource(d, ch, capture, automation, follows ? 'Followed us and got the resource:' : 'Got the resource (the follow could not be checked):');
  // Meta asked for a pause: undone so it is retried with their next message checked again
  if (!done) run("UPDATE captures SET followed_at=NULL, last_msg_at=? WHERE id=? AND status='waiting_follow'", capture.last_msg_at, capture.id);
}

// Messages from the person (not ours), oldest to newest, after `since`.
// Only messages written by THAT person (userId) count. Meta can return someone else's conversation (the Instagram
// lookup by user_id does not filter and returns the most recent one): without this filter, one person's reply was
// taken as the reply of everyone who was waiting.
function newUserMessages(msgs, selfId, since, userId) {
  return (msgs || [])
    .filter((m) => m.from?.id && String(m.from.id) !== String(selfId) && m.message)
    .filter((m) => !userId || String(m.from.id) === String(userId))
    .filter((m) => parseMetaTime(m.created_time) > since)
    .sort((a, b) => parseMetaTime(a.created_time) - parseMetaTime(b.created_time));
}

async function handleReply(d, ch, capture, automation, msgs) {
  const fresh = newUserMessages(msgs, ch.ig_user_id, Date.parse(capture.last_msg_at), capture.igsid);
  if (!fresh.length) return;
  if (capture.status === 'waiting_follow') return handleFollow(d, ch, capture, automation, fresh);
  const lastAt = new Date(parseMetaTime(fresh[fresh.length - 1].created_time)).toISOString();
  // If any of their new messages contains an email, use it (even if they wrote something else first).
  const hit = fresh.map((m) => extractEmail(m.message)).find(Boolean);
  if (hit) {
    saveEmail(capture, automation, hit);
    run("UPDATE captures SET status='got_email', email=?, last_msg_at=? WHERE id=?", hit, lastAt, capture.id);
    capture.status = 'got_email'; capture.email = hit;
    await sendResource(d, ch, capture, automation);
    return;
  }
  // They wrote but it was not an email: one more chance, then leave it.
  if (capture.retries < 1) {
    try {
      await d.sendText(ch, capture.igsid, fill(automation.retry_text || DEFAULT_RETRY, { username: capture.username || '' }));
      // mark as reviewed up to the later of "now" and their last message (in case Meta's clock runs ahead)
      const mark = new Date(Math.max(Date.now(), Date.parse(lastAt))).toISOString();
      run('UPDATE captures SET retries=retries+1, last_msg_at=? WHERE id=?', mark, capture.id);
    } catch (e) {
      if (isRateLimit(e) || isBlocked(e)) { throttle.until = Date.now() + 10 * 60000; throttle.reason = e.message; return; }
      run("UPDATE captures SET status='failed', error=? WHERE id=?", e.message, capture.id);
      logEvent('error', `Could not ask @${capture.username} for the email again: ${e.message}`);
    }
  } else {
    run("UPDATE captures SET status='expired', error='Did not write a valid email', last_msg_at=? WHERE id=?", lastAt, capture.id);
  }
}

export async function pollDMs(deps = {}) {
  const d = { ...defaults, ...deps };
  run(`UPDATE captures SET status='expired', error='Did not reply in time' WHERE status IN ('waiting','waiting_follow') AND created_at < datetime('now','-${EXPIRE_DAYS} days')`);
  const open = all("SELECT * FROM captures WHERE status IN ('waiting','got_email','waiting_follow') ORDER BY id");
  if (!open.length) return 0;
  let handled = 0;
  const byChannel = new Map();
  for (const c of open) (byChannel.get(c.channel_id) ?? byChannel.set(c.channel_id, []).get(c.channel_id)).push(c);

  for (const [channelId, caps] of byChannel) {
    const rawCh = get('SELECT * FROM channels WHERE id=?', channelId);
    if (!rawCh?.token) continue;
    // the senders receive the channel as first argument, so tests can replace them
    const ch = rawCh;
    const send = {
      sendText: (c, to, t) => d.sendText(c.host, c.token, c.ig_user_id, to, t, c.type),
      sendButton: (c, to, t, title, url) => d.sendButton(c.host, c.token, c.ig_user_id, to, t, title, url, c.type),
      sendQuick: (c, to, t, replies) => d.sendQuick(c.host, c.token, c.ig_user_id, to, t, replies),
    };
    const dd = { ...d, ...send };
    try {
      // 1) people who already have an email and wait for the resource (sending had stalled or failed)
      let sent = 0;
      for (const cap of caps.filter((c) => c.status === 'got_email')) {
        if (sent >= MAX_RESOURCES) break;
        const a = get('SELECT * FROM automations WHERE id=?', cap.automation_id);
        if (a && await sendResource(dd, ch, cap, a)) { sent++; handled++; }
      }
      // 2) people who have not answered yet: a single call brings everyone's recent conversations
      const waiting = caps.filter((c) => c.status === 'waiting' || c.status === 'waiting_follow');
      if (!waiting.length) continue;
      const list = (await d.listConversations(ch.host, ch.token, ch.ig_user_id, 30, ch.type)).data || [];
      const byUser = new Map(); // person id -> messages of their conversation
      for (const conv of list) {
        const msgs = conv.messages?.data || [];
        const uid = msgs.map((m) => String(m.from?.id ?? '')).find((id) => id && id !== String(ch.ig_user_id));
        if (uid) byUser.set(uid, msgs);
      }
      let lookups = 0;
      for (const cap of waiting) {
        const a = get('SELECT * FROM automations WHERE id=?', cap.automation_id);
        if (!a) continue;
        let msgs = byUser.get(String(cap.igsid));
        if (!msgs && lookups < MAX_LOOKUPS) { // not in the recent list: ask for that person
          lookups++; await d.pause();
          const conv = (await d.conversationByUser(ch.host, ch.token, ch.ig_user_id, cap.igsid, ch.type)).data?.[0];
          msgs = conv?.messages?.data;
        }
        if (!msgs) continue;
        const before = cap.status;
        await handleReply(dd, ch, cap, a, msgs);
        if (before === 'waiting' && get('SELECT status FROM captures WHERE id=?', cap.id).status !== 'waiting') handled++;
      }
      lastErr.delete(channelId);
    } catch (e) {
      if (lastErr.get(channelId) !== e.message) logEvent('error', `Reading DMs of @${ch.username} failed: ${e.message}`); // one warning per distinct error
      lastErr.set(channelId, e.message);
    }
  }
  return handled;
}
const lastErr = new Map();
