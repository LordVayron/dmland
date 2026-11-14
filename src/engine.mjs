import { all, get, run, logEvent } from './db.mjs';
import * as meta from './meta.mjs';

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
const emailOf = (contact) => json(contact.fields, {}).email || null;

// A/B tests: the random choice can be replaced in automated tests
export const rng = { next: () => Math.random() };
const slug = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'dm';
// Adds utm_source / utm_medium / utm_campaign to every http(s) link in the text. If the link already has utm_source, it is left alone.
// Only acts if the automation has it enabled (off by default: messages go out exactly as you wrote them).
export function withUtm(text, a) {
  if (!a?.utm || !text) return text;
  const campaign = slug(json(a.keywords, [])[0] || a.name);
  return String(text).replace(/https?:\/\/[^\s<>"']*[^\s<>"'.,;:!?)\]]/g, (m) => {
    try {
      const u = new URL(m);
      if (u.searchParams.has('utm_source')) return m;
      u.searchParams.set('utm_source', 'instagram'); u.searchParams.set('utm_medium', 'dm'); u.searchParams.set('utm_campaign', campaign);
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
export const realSender = (host, token, igUserId) => ({
  // Follow-up messages to someone who already wrote to us (24 h window)
  sendText: (to, text) => meta.sendText(host, token, igUserId, to, text),
  sendButton: (to, text, title, url) => meta.sendButton(host, token, igUserId, to, text, title, url),
  replyToComment: (cid, msg) => meta.replyToComment(host, token, cid, msg),
  privateReplyText: (cid, text) => meta.privateReplyText(host, token, igUserId, cid, text),
  privateReplyButton: (cid, text, title, url) => meta.privateReplyButton(host, token, igUserId, cid, text, title, url),
});

export function drySender(log) {
  return {
    sendText: async (to, text) => { log.push({ action: 'dm_followup', to, text }); return { dry: true }; },
    sendButton: async (to, text, title, url) => { log.push({ action: 'dm_followup_button', to, text, button: { title, url } }); return { dry: true }; },
    replyToComment: async (cid, msg) => { log.push({ action: 'public_reply', comment_id: cid, text: msg }); return { dry: true }; },
    privateReplyText: async (cid, text) => { log.push({ action: 'dm_text', comment_id: cid, text }); return { dry: true }; },
    privateReplyButton: async (cid, text, title, url) => { log.push({ action: 'dm_button', comment_id: cid, text, button: { title, url } }); return { dry: true }; },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Processes a received comment for a channel. Returns the executions launched.
// Dates: Meta uses "2026-11-12T22:54:24+0000"; SQLite uses "2026-11-12 22:54:24" (UTC).
export const parseMetaTime = (s) => (s ? Date.parse(String(s).replace(/([+-]\d\d)(\d\d)$/, '$1:$2')) : NaN);
export const parseDbTime = (s) => (s ? Date.parse(String(s).replace(' ', 'T') + 'Z') : NaN);

// quiet: does not log "duplicate" events (used by the periodic read, which checks the same comments every minute)
export function handleComment(channel, comment, { sender, dry = false, instant = false, quiet = false } = {}) {
  if (!dry && throttle.until > Date.now()) return []; // Meta asked for a pause: nothing is sent until it ends
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
    // Only new comments: later than the moment the automation was activated
    const since = parseDbTime(a.since);
    if (!Number.isNaN(commentTime) && !Number.isNaN(since) && commentTime < since) continue;
    if (!matches(a, comment.text)) continue;
    const ins = run(`INSERT OR IGNORE INTO runs(automation_id, comment_id, comment_text, status, comment_at, media_id) VALUES (?,?,?,?,?,?)`,
      a.id, String(comment.id), comment.text ?? '', dry ? 'dry' : 'pending',
      new Date(Number.isNaN(commentTime) ? Date.now() : commentTime).toISOString(), mediaId);
    if (ins.changes === 0) { if (!quiet) logEvent('duplicate', `Comment ${comment.id} already processed by "${a.name}"`); continue; }
    const runId = Number(ins.lastInsertRowid);
    const contact = upsertContact(channel.id, String(from.id ?? 'unknown'), from.username);
    run('UPDATE runs SET contact_id=? WHERE id=?', contact.id, runId);
    const p = execute({ a, channel, comment, contact, runId, sender, instant });
    launched.push({ run_id: runId, automation: a.name, done: p });
  }
  return launched;
}

// Meta limits: 750 private replies per hour per account. If Meta slows or blocks us, we pause ALL sending.
export const throttle = { until: 0, reason: '' };
export const isRateLimit = (e) => [4, 17, 32, 613].includes(e.code) || /rate limit|too many|request limit/i.test(e.message || '');
export const isBlocked = (e) => e.code === 368 || /temporarily blocked|restricted|spam/i.test(e.message || '');

// Records that we asked this person for their email: from here on the program watches their DMs.
function createCapture({ a, channel, contact, comment, runId, resp }) {
  const igsid = String(resp?.recipient_id ?? comment.from?.id ?? '');
  if (!igsid) { logEvent('warn', `Could not identify @${contact.username} to wait for their email`); return; }
  const now = new Date().toISOString();
  run(`INSERT INTO captures(automation_id, channel_id, contact_id, run_id, igsid, username, status, asked_at, last_msg_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    a.id, channel.id, contact.id, runId, igsid, contact.username ?? null, 'waiting', now, now);
}

async function execute({ a, channel, comment, contact, runId, sender, instant }) {
  const vars = { username: contact.username || '', first_name: contact.username || '' };
  try {
    if (!instant && a.delay_seconds > 0) await sleep(a.delay_seconds * 1000);
    // Email mode: if we already have their email (and the automation allows it) the resource goes out directly; otherwise we ask for the email.
    const knownEmail = a.mode === 'email' && a.skip_known ? emailOf(contact) : null;
    const askMode = a.mode === 'email' && !knownEmail;
    // DM first: if Meta slows it down, no public reply saying "I sent it" is posted.
    // A/B test (only on the DM that asks for the email): half of the people get version A and half version B; which one each got is recorded.
    const abTest = askMode && !!a.alt_ask_text;
    const useB = abTest && rng.next() < 0.5;
    const variant = abTest ? (useB ? 'B' : 'A') : null;
    const text = withUtm(fill(askMode ? (useB ? a.alt_ask_text : (a.ask_text || DEFAULT_ASK)) : a.dm_text, vars), a);
    const buttonUrl = withUtm(a.button_url, a);
    let resp;
    try {
      if (a.button_url && !askMode) {
        try { resp = await sender.privateReplyButton(comment.id, text, a.button_title || 'Abrir', buttonUrl); }
        catch (e) { if (isRateLimit(e) || isBlocked(e)) throw e; logEvent('warn', `Button failed (${e.message}); sending text with the link`); resp = await sender.privateReplyText(comment.id, `${text}\n${buttonUrl}`); }
      } else {
        resp = await sender.privateReplyText(comment.id, text);
      }
      run('UPDATE runs SET dm_status=?, dm_at=?, variant=?, igsid=? WHERE id=?', 'ok', new Date().toISOString(), variant,
        String(resp?.recipient_id ?? comment.from?.id ?? '') || null, runId);
      if (askMode && !resp?.dry) createCapture({ a, channel, contact, comment, runId, resp });
    } catch (e) {
      if (isRateLimit(e) || isBlocked(e)) {
        // Not marked as an error: the run is deleted so it is retried when the pause ends.
        const minutes = isBlocked(e) ? 60 : 10;
        throttle.until = Date.now() + minutes * 60000;
        throttle.reason = e.message;
        run('DELETE FROM runs WHERE id=?', runId);
        logEvent('error', `Meta paused sending (${e.message}). Pausing ${minutes} min; the comment is retried later.`);
        return;
      }
      run('UPDATE runs SET dm_status=?, status=?, error=? WHERE id=?', 'error', 'error', e.message, runId);
      logEvent('error', `DM failed (${a.name}): ${e.message}`);
      return;
    }
    const replies = json(a.public_replies, []).filter(Boolean);
    if (replies.length) {
      const msg = fill(replies[Math.floor(Math.random() * replies.length)], vars);
      try { await sender.replyToComment(comment.id, msg); run('UPDATE runs SET public_reply_status=? WHERE id=?', 'ok', runId); }
      catch (e) { run('UPDATE runs SET public_reply_status=? WHERE id=?', `error: ${e.message}`, runId); logEvent('error', `Public reply failed: ${e.message}`); }
    }
    addTag(contact, a.tag);
    run(`UPDATE runs SET status=CASE WHEN status='dry' THEN 'dry' ELSE 'done' END WHERE id=?`, runId);
    { const who = contact.username || contact.external_id; logEvent('run', askMode ? `"${a.name}" asked @${who} for their email` : knownEmail ? `"${a.name}" sent the resource directly (email already known) to @${who}` : `"${a.name}" ran for @${who}`); }
  } catch (e) {
    run('UPDATE runs SET status=?, error=? WHERE id=?', 'error', e.message, runId);
    logEvent('error', e.message);
  }
}
