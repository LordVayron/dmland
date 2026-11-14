// Validation and creation of automations. Used by the dashboard (server.mjs),
// so every entry point applies exactly the same rules.
import { run } from './db.mjs';

export function automationFields(b) {
  const arr = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[\n,]/)).map((s) => String(s).trim()).filter(Boolean);
  if (!b.name || !b.dm_text || !b.channel_id) throw new Error('Name, account or DM message is missing');
  if (b.button_url && !/^https:\/\//i.test(b.button_url)) throw new Error('The button link must start with https://');
  const mode = b.mode === 'email' ? 'email' : 'link';
  const ask = String(b.ask_text ?? '').trim(), retry = String(b.retry_text ?? '').trim();
  if (mode === 'email' && !ask) throw new Error('Write the first DM that asks for the email');
  // Instagram limits a message to 1000 bytes
  for (const [label, t] of [['The message with the resource', b.dm_text], ['The DM that asks for the email', ask], ['The "invalid email" text', retry], ['Version B of the DM that asks for the email', b.alt_ask_text]]) {
    if (Buffer.byteLength(String(t ?? ''), 'utf8') > 1000) throw new Error(`${label} is too long (Instagram allows 1000 bytes)`);
  }
  return [
    Number(b.channel_id), b.name, b.active === false ? 0 : 1, b.media_id || null,
    ['any', 'contains', 'word', 'exact'].includes(b.match_mode) ? b.match_mode : 'contains',
    JSON.stringify(arr(b.keywords)), JSON.stringify(arr(b.exclude)), JSON.stringify(arr(b.public_replies)),
    b.dm_text, b.button_title || null, b.button_url || null, b.tag || null, Math.max(0, Number(b.delay_seconds ?? 3)),
    mode, ask || null, retry || null, b.skip_known === false || b.skip_known === 0 ? 0 : 1,
    mode === 'email' && String(b.alt_ask_text ?? '').trim() ? String(b.alt_ask_text).trim() : null, b.utm === true || b.utm === 1 ? 1 : 0,
  ];
}

// since: 'YYYY-MM-DD HH:MM:SS' (UTC). If not passed, it applies from now on.
export function insertAutomation(b, { sourceId = null, since = null } = {}) {
  const f = automationFields(b);
  const r = run(`INSERT INTO automations(channel_id,name,active,media_id,match_mode,keywords,exclude,public_replies,dm_text,button_title,button_url,tag,delay_seconds,mode,ask_text,retry_text,skip_known,alt_ask_text,utm,source_id,since)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,COALESCE(?, datetime('now')))`, ...f, sourceId, since);
  return Number(r.lastInsertRowid);
}
