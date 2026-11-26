import { all, get, run, logEvent } from './db.mjs';
import { apiFor } from './platform.mjs';

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function matches(automation, text) {
  const t = norm(text);
  const exclude = json(automation.exclude, []).map(norm).filter(Boolean);
  if (exclude.some((k) => t.includes(k))) return false;
  if (automation.match_mode === 'any') return true;
  const kws = json(automation.keywords, []).map(norm).filter(Boolean);
  if (!kws.length) return false;
  return kws.some((k) => {
    if (automation.match_mode === 'exact') return t === k;
    if (automation.match_mode === 'word') return new RegExp(`(^|[^\\p{L}\\p{N}])${esc(k)}($|[^\\p{L}\\p{N}])`, 'u').test(t);
    return t.includes(k);
  });
}

export const json = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
export const fill = (tpl, vars) => String(tpl ?? '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => vars[k] ?? '');

// Default texts for "ask for email first" mode. Everything can be edited per automation.
export const DEFAULT_ASK = 'Hi {{username}}! 👋 To send you the resource, reply to this message with your email.\n\nBy sending it you agree to receive the resource and occasional emails.';
export const DEFAULT_RETRY = 'Hmm, that does not look like an email 🤔 Please write it like name@example.com';
// Ask for a follow before the resource (Instagram only). The button is a quick reply: tapping it sends us its text.
export const FOLLOW_BUTTON = 'I follow you';
export const DEFAULT_FOLLOW = 'Hi {{username}}! 👋 Follow me and I will send it to you. Once you follow, tap «I follow you» 👇';
export const DEFAULT_FOLLOW_RETRY = 'I cannot see you among my followers yet 👀 Follow me and tap «I follow you» again.';
export const FOLLOW_HINT = 'Once you follow me, reply «done» 👇'; // sent as text if Meta does not accept the button
export const usesFollowGate = (a, channel) => !!a?.follow_gate && (channel?.type || 'instagram') === 'instagram';
const emailOf = (contact) => json(contact.fields, {}).email || null;

// A/B tests: the random choice can be replaced in automated tests
export const rng = { next: () => Math.random() };
const slug = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'dm';
// Adds utm_source / utm_medium / utm_campaign to every http(s) link in the text. If the link already has utm_source, it is left alone.
// Only acts if the automation has it enabled (off by default: messages go out exactly as you wrote them).
export function withUtm(text, a, source = 'instagram') {
  if (!a?.utm || !text) return text;
  const campaign = slug(json(a.keywords, [])[0] || a.name);
  return String(text).replace(/https?:\/\/[^\s<>"']*[^\s<>"'.,;:!?)\]]/g, (m) => {
    try {
      const u = new URL(m);
      if (u.searchParams.has('utm_source')) return m;
      u.searchParams.set('utm_source', source); u.searchParams.set('utm_medium', 'dm'); u.searchParams.set('utm_campaign', campaign);
      return u.toString();
    } catch { return m; }
  });
}

function upsertContact(channelId, externalId, username) {
  run(`INSERT INTO contacts(channel_id, external_id, username) VALUES (?,?,?)
       ON CONFLICT(channel_id, external_id) DO UPDATE SET username=COALESCE(excluded.username, username), last_interaction=CURRENT_TIMESTAMP`,
    channelId, externalId, username ?? null);
  return get('SELECT * FROM contacts WHERE channel_id=? AND external_id=?', channelId, externalId);
}

export function addTag(contact, tag) {
  if (!tag) return;
  const tags = json(contact.tags, []);
  if (!tags.includes(tag)) { tags.push(tag); run('UPDATE contacts SET tags=? WHERE id=?', JSON.stringify(tags), contact.id); }
}

// sender: { replyToComment, privateReplyText, privateReplyButton } -> real o simulado
// `type` is the account's platform ('instagram' or 'facebook'); `igUserId` holds the Instagram account ID or the Page ID.
export const realSender = (host, token, igUserId, type = 'instagram') => {
  const api = apiFor(type);
  return {
    // Follow-up messages to someone who already wrote to us (24 h window)
    sendText: (to, text) => api.sendText(host, token, igUserId, to, text),
    sendButton: (to, text, title, url) => api.sendButton(host, token, igUserId, to, text, title, url),
    replyToComment: (cid, msg) => api.replyToComment(host, token, cid, msg),
    privateReplyText: (cid, text) => api.privateReplyText(host, token, igUserId, cid, text),
    privateReplyButton: (cid, text, title, url) => api.privateReplyButton(host, token, igUserId, cid, text, title, url),
    privateReplyQuick: (cid, text, replies) => api.privateReplyQuick(host, token, igUserId, cid, text, replies),
  };
};

export function drySender(log) {
  return {
    sendText: async (to, text) => { log.push({ action: 'dm_followup', to, text }); return { dry: true }; },
    sendButton: async (to, text, title, url) => { log.push({ action: 'dm_followup_button', to, text, button: { title, url } }); return { dry: true }; },
    replyToComment: async (cid, msg) => { log.push({ action: 'public_reply', comment_id: cid, text: msg }); return { dry: true }; },
    privateReplyText: async (cid, text) => { log.push({ action: 'dm_text', comment_id: cid, text }); return { dry: true }; },
    privateReplyButton: async (cid, text, title, url) => { log.push({ action: 'dm_button', comment_id: cid, text, button: { title, url } }); return { dry: true }; },
    privateReplyQuick: async (cid, text, replies) => { log.push({ action: 'dm_follow', comment_id: cid, text, quick_replies: replies }); return { dry: true }; },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Processes a received comment for a channel. Returns the executions launched.
// Dates: Meta uses "2026-11-12T22:54:24+0000"; SQLite uses "2026-11-12 22:54:24" (UTC).
export const parseMetaTime = (s) => (s ? Date.parse(String(s).replace(/([+-]\d\d)(\d\d)$/, '$1:$2')) : NaN);
export const parseDbTime = (s) => (s ? Date.parse(String(s).replace(' ', 'T') + 'Z') : NaN);

// quiet: does not log "duplicate" events (used by the periodic read, which checks the same comments every minute)
// skip: ids of automations that must not take this comment for now (they reached their pace limit); the comment waits.
export function handleComment(channel, comment, { sender, dry = false, instant = false, quiet = false, skip = null } = {}) {
  if (!dry && throttle.until > Date.now()) return []; // Meta asked for a pause: nothing is sent until it ends
  if (!dry && channelPaused(channel)) return []; // this account is restricted: its comments wait (Meta allows 7 days)
  const from = comment.from || {};
  if (from.id && String(from.id) === String(channel.ig_user_id)) return []; // ignore our own comments
  if (comment.username && channel.username && comment.username === channel.username) return [];
  if (from.username && channel.username && from.username === channel.username) return [];
  const mediaId = comment.media?.id ? String(comment.media.id) : null;
  const commentTime = parseMetaTime(comment.timestamp);
  const automations = all('SELECT * FROM automations WHERE channel_id=? AND active=1', channel.id);
  const launched = [];
  for (const a of automations) {
    if (a.media_id && a.media_id !== mediaId) continue;
    if (skip?.has(a.id)) continue;
    // Only new comments: later than the moment the automation was activated
    const since = parseDbTime(a.since);
    if (!Number.isNaN(commentTime) && !Number.isNaN(since) && commentTime < since) continue;
    if (!matches(a, comment.text)) continue;
    const ins = run(`INSERT OR IGNORE INTO runs(automation_id, comment_id, comment_text, status, comment_at, media_id) VALUES (?,?,?,?,?,?)`,
      a.id, String(comment.id), comment.text ?? '', dry ? 'dry' : 'pending',
      new Date(Number.isNaN(commentTime) ? Date.now() : commentTime).toISOString(), mediaId);
    if (ins.changes === 0) { if (!quiet) logEvent('duplicate', `Comment ${comment.id} already processed by "${a.name}"`); continue; }
    const runId = Number(ins.lastInsertRowid);
    // Facebook does not say who commented on a Page post: without an id, the contact is created after the DM,
    // with the id Meta returns for the recipient (otherwise every commenter would collapse into one contact).
    const contact = from.id ? upsertContact(channel.id, String(from.id), from.username) : { id: null, username: from.username ?? null, tags: '[]', fields: '{}' };
    if (contact.id) run('UPDATE runs SET contact_id=? WHERE id=?', contact.id, runId);
    const p = execute({ a, channel, comment, contact, runId, sender, instant });
    launched.push({ run_id: runId, automation: a.name, automation_id: a.id, done: p });
  }
  return launched;
}

// Meta limits: 750 private replies per hour per account. If Meta slows or blocks us, we pause ALL sending.
export const throttle = { until: 0, reason: '' };
export const isRateLimit = (e) => [4, 17, 32, 613].includes(e.code) || /rate limit|too many|request limit/i.test(e.message || '');
export const isBlocked = (e) => e.code === 368 || /temporarily blocked|restricted|spam/i.test(e.message || '');

// Pause for ONE account (not all of them): Meta temporarily restricted its messages (#10/1893063).
export const channelPause = new Map(); // channel id -> paused until (ms)
export const channelPaused = (ch) => (channelPause.get(ch.id) ?? 0) > Date.now();
export const isPageRestricted = (e) => e.subcode === 1893063 || /temporarily restricted from sending messages/i.test(e.message || '');
export const RESTRICT_PAUSE_MIN = 60;

// Error text with Meta's code, so the exact cause can be looked up: "text (#10/2018108)".
export const metaError = (e) => `${e.message}${e.code ? ` (#${e.code}${e.subcode ? `/${e.subcode}` : ''})` : ''}`;
// Seen on Facebook Pages: some private replies fail with this text and the same send goes through when retried.
// Retried after 2, 10 and 30 min (always inside Meta's 7-day window).
export const isTransientDm = (e) => /does not have permission for this action/i.test(e.message || '');
export const RETRY_MINUTES = [2, 10, 30];

// Retries the DMs Meta rejected temporarily whose turn has come. Returns how many were attempted.
export async function retryDMs(channel, sender, max = 5) {
  if (throttle.until > Date.now() || channelPaused(channel)) return 0;
  const due = all(`SELECT r.* FROM runs r JOIN automations a ON a.id=r.automation_id
    WHERE a.channel_id=? AND a.active=1 AND r.status='retry' AND r.retry_at <= ? ORDER BY r.retry_at LIMIT ?`, channel.id, new Date().toISOString(), max);
  for (const r of due) {
    if (channelPaused(channel)) break;
    const a = get('SELECT * FROM automations WHERE id=?', r.automation_id);
    if (Date.now() - Date.parse(r.comment_at) > 7 * 24 * 3600e3) { // Meta no longer allows a reply
      run("UPDATE runs SET status='error', retry_at=NULL WHERE id=?", r.id); continue;
    }
    const contact = (r.contact_id && get('SELECT * FROM contacts WHERE id=?', r.contact_id)) || { id: null, username: null, tags: '[]', fields: '{}' };
    run("UPDATE runs SET status='pending' WHERE id=?", r.id);
    await execute({ a, channel, comment: { id: r.comment_id, text: r.comment_text, from: {} }, contact, runId: r.id, sender, instant: true });
  }
  return due.length;
}

// Records that we asked this person for their email: from here on the program watches their DMs.
// follow=true: we asked them to follow; their DMs are watched until they tap the button and we see them as a follower.
function createCapture({ a, channel, contact, comment, runId, resp, follow = false }) {
  const igsid = String(resp?.recipient_id ?? comment.from?.id ?? '');
  if (!igsid) { logEvent('warn', `Could not identify @${contact.username} to wait for their ${follow ? 'follow' : 'email'}`); return; }
  const now = new Date().toISOString();
  run(`INSERT INTO captures(automation_id, channel_id, contact_id, run_id, igsid, username, status, asked_at, last_msg_at, follow, email_asked) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    a.id, channel.id, contact.id, runId, igsid, contact.username ?? null, follow ? 'waiting_follow' : 'waiting', now, now, follow ? 1 : 0, follow ? 0 : 1);
}

async function execute({ a, channel, comment, contact, runId, sender, instant }) {
  const vars = { username: contact.username || '', first_name: contact.username || '' };
  try {
    if (!instant && a.delay_seconds > 0) await sleep(a.delay_seconds * 1000);
    // Email mode: if we already have their email (and the automation allows it) the resource goes out directly; otherwise we ask for the email.
    // Follow gate: the first DM only asks for the follow; the email (if any) and the resource come later (capture.mjs).
    const followMode = usesFollowGate(a, channel);
    const knownEmail = !followMode && a.mode === 'email' && a.skip_known ? emailOf(contact) : null;
    const askMode = !followMode && a.mode === 'email' && !knownEmail;
    // DM first: if Meta slows it down, no public reply saying "I sent it" is posted.
    // A/B test (only on the DM that asks for the email): half of the people get version A and half version B; which one each got is recorded.
    const abTest = askMode && !!a.alt_ask_text;
    const useB = abTest && rng.next() < 0.5;
    const variant = abTest ? (useB ? 'B' : 'A') : null;
    const text = withUtm(fill(askMode ? (useB ? a.alt_ask_text : (a.ask_text || DEFAULT_ASK)) : a.dm_text, vars), a, channel.type);
    const buttonUrl = withUtm(a.button_url, a, channel.type);
    let resp;
    try {
      if (followMode) {
        const ftext = fill(a.follow_text || DEFAULT_FOLLOW, vars);
        try { resp = await sender.privateReplyQuick(comment.id, ftext, [FOLLOW_BUTTON]); }
        catch (e) { if (isRateLimit(e) || isBlocked(e) || isPageRestricted(e)) throw e; logEvent('warn', `Button «${FOLLOW_BUTTON}» failed (${e.message}); sending the text with instructions`); resp = await sender.privateReplyText(comment.id, `${ftext}\n\n${FOLLOW_HINT}`); }
      } else if (a.button_url && !askMode) {
        try { resp = await sender.privateReplyButton(comment.id, text, a.button_title || 'Abrir', buttonUrl); }
        catch (e) { if (isRateLimit(e) || isBlocked(e)) throw e; logEvent('warn', `Button failed (${e.message}); sending text with the link`); resp = await sender.privateReplyText(comment.id, `${text}\n${buttonUrl}`); }
      } else {
        resp = await sender.privateReplyText(comment.id, text);
      }
      run('UPDATE runs SET dm_status=?, dm_at=?, variant=?, igsid=?, error=NULL, retry_at=NULL WHERE id=?', 'ok', new Date().toISOString(), variant,
        String(resp?.recipient_id ?? comment.from?.id ?? '') || null, runId);
      if (!contact.id && resp?.recipient_id) { // Facebook: now we know who it is
        Object.assign(contact, upsertContact(channel.id, String(resp.recipient_id), contact.username));
        run('UPDATE runs SET contact_id=? WHERE id=?', contact.id, runId);
      }
      if ((askMode || followMode) && !resp?.dry) createCapture({ a, channel, contact, comment, runId, resp, follow: followMode });
    } catch (e) {
      const err = metaError(e);
      const tries = get('SELECT dm_retries FROM runs WHERE id=?', runId)?.dm_retries ?? 0;
      // Page restricted by Meta: pause only that account; this comment waits for the pause to end
      // (it does not count as an attempt; insisting during a restriction can extend it).
      // Checked before isBlocked, whose "restricted" match would pause every account.
      if (isPageRestricted(e)) {
        const until = Date.now() + RESTRICT_PAUSE_MIN * 60000;
        const was = channelPaused(channel);
        channelPause.set(channel.id, until);
        run('UPDATE runs SET dm_status=?, status=?, error=?, retry_at=? WHERE id=?', 'error', 'retry', err, new Date(until).toISOString(), runId);
        if (!was) logEvent('error', `Meta restricted messages from @${channel.username} (${err}). Pausing ${RESTRICT_PAUSE_MIN} min on that account only; comments will wait.`);
        return;
      }
      if (isRateLimit(e) || isBlocked(e)) {
        // Not marked as an error: the run is deleted so it is retried when the pause ends.
        const minutes = isBlocked(e) ? 60 : 10;
        throttle.until = Date.now() + minutes * 60000;
        throttle.reason = e.message;
        run('DELETE FROM runs WHERE id=?', runId);
        logEvent('error', `Meta paused sending (${e.message}). Pausing ${minutes} min; the comment is retried later.`);
        return;
      }
      // Temporary rejection (Meta accepts it minutes later): kept for a retry instead of being given up.
      if (isTransientDm(e) && tries < RETRY_MINUTES.length) {
        run('UPDATE runs SET dm_status=?, status=?, error=?, dm_retries=?, retry_at=? WHERE id=?', 'error', 'retry', err, tries + 1,
          new Date(Date.now() + RETRY_MINUTES[tries] * 60000).toISOString(), runId);
        logEvent('warn', `DM rejected by Meta (${a.name}): ${err}. Retry ${tries + 1} of ${RETRY_MINUTES.length} in ${RETRY_MINUTES[tries]} min`);
        return;
      }
      run('UPDATE runs SET dm_status=?, status=?, error=?, retry_at=NULL WHERE id=?', 'error', 'error', err, runId);
      logEvent('error', `DM failed (${a.name}): ${err}${tries ? ` (after ${tries} retries)` : ''}`);
      return;
    }
    const replies = json(a.public_replies, []).filter(Boolean);
    if (replies.length) {
      const msg = fill(replies[Math.floor(Math.random() * replies.length)], vars);
      try { await sender.replyToComment(comment.id, msg); run('UPDATE runs SET public_reply_status=? WHERE id=?', 'ok', runId); }
      catch (e) { run('UPDATE runs SET public_reply_status=? WHERE id=?', `error: ${e.message}`, runId); logEvent('error', `Public reply failed: ${e.message}`); }
    }
    if (!followMode) addTag(contact, a.tag); // with the follow gate, the tag is added when the resource goes out
    run(`UPDATE runs SET status=CASE WHEN status='dry' THEN 'dry' ELSE 'done' END WHERE id=?`, runId);
    { const who = contact.username || contact.external_id || '—'; logEvent('run', followMode ? `"${a.name}" asked @${who} to follow` : askMode ? `"${a.name}" asked @${who} for their email` : knownEmail ? `"${a.name}" sent the resource directly (email already known) to @${who}` : `"${a.name}" ran for @${who}`); }
  } catch (e) {
    run('UPDATE runs SET status=?, error=? WHERE id=?', 'error', e.message, runId);
    logEvent('error', e.message);
  }
}
