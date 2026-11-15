// Facebook Page client (Messenger). Same function shapes as meta.mjs (Instagram), so the poller,
// the engine and the email capture work on both without knowing which one they talk to.
// Everything here is returned in Instagram's shape: posts as {id, caption, thumbnail_url, permalink,
// timestamp, ...} and comments as {id, text, username, timestamp, from}.
// The "account id" is the Page ID; the token is a Page access token (or a system user token with the Page assigned).
import { call } from './meta.mjs';

export const DEFAULT_HOST = 'graph.facebook.com';

// Page data. Facebook Pages may have no @username: fall back to the name without spaces.
export const getAccount = async (host, token, pageId) => {
  const r = await call(host, 'GET', `/${pageId}?fields=id,name,username`, token);
  return { ...r, username: r.username || String(r.name || r.id).replace(/\s+/g, '') };
};

const POST_FIELDS = 'id,message,permalink_url,created_time,full_picture,likes.limit(0).summary(true),comments.limit(0).summary(true)';
export const listMedia = async (host, token, pageId) => {
  const r = await call(host, 'GET', `/${pageId}/published_posts?fields=${POST_FIELDS}&limit=24`, token);
  return { ...r, data: (r.data || []).map((p) => ({
    id: p.id, caption: p.message || '', media_type: 'POST', thumbnail_url: p.full_picture || '', media_url: p.full_picture || '',
    permalink: p.permalink_url, timestamp: p.created_time,
    like_count: p.likes?.summary?.total_count ?? null, comments_count: p.comments?.summary?.total_count ?? null })) };
};

export const getAccountStats = async (host, token, pageId) => {
  const r = await call(host, 'GET', `/${pageId}?fields=followers_count,fan_count`, token);
  return { followers_count: r.followers_count ?? r.fan_count ?? null, media_count: null };
};

// Facebook insights need another permission (read_insights): not used yet, so analytics show "no data" for them.
export const getMediaInsights = async () => ({});
export const getAccountInsights = async () => ({});

// Top-level comments, newest first (the poller stops paging as soon as a whole page is older than it cares about).
export const listComments = async (host, token, postId, limit = 50, after = null) => {
  const r = await call(host, 'GET', `/${postId}/comments?fields=id,message,from{id,name},created_time&filter=toplevel&order=reverse_chronological&limit=${limit}${after ? `&after=${encodeURIComponent(after)}` : ''}`, token);
  return { ...r, data: (r.data || []).map((c) => ({
    id: c.id, text: c.message || '', username: c.from?.name, timestamp: c.created_time,
    from: { id: c.from?.id ?? null, username: c.from?.name } })) };
};

// ---- Direct messages (Messenger) ----
const MSG_FIELDS = 'id,updated_time,messages.limit(8){id,created_time,from,message}';
export const listConversations = (host, token, pageId, limit = 30) =>
  call(host, 'GET', `/${pageId}/conversations?platform=messenger&fields=${MSG_FIELDS}&limit=${limit}`, token);
export const conversationByUser = (host, token, pageId, psid) =>
  call(host, 'GET', `/${pageId}/conversations?platform=messenger&user_id=${encodeURIComponent(psid)}&fields=${MSG_FIELDS}`, token);

const buttonMessage = (text, title, url) => ({
  attachment: { type: 'template', payload: { template_type: 'button', text: text.slice(0, 640), buttons: [{ type: 'web_url', url, title: title.slice(0, 20) }] } },
});

// Regular message to a person. Only allowed within 24 h of their last message.
export const sendText = (host, token, pageId, recipientId, text) =>
  call(host, 'POST', `/${pageId}/messages`, token, { recipient: { id: recipientId }, messaging_type: 'RESPONSE', message: { text } });
export const sendButton = (host, token, pageId, recipientId, text, title, url) =>
  call(host, 'POST', `/${pageId}/messages`, token, { recipient: { id: recipientId }, messaging_type: 'RESPONSE', message: buttonMessage(text, title, url) });

export const subscribeWebhooks = (host, token, pageId) =>
  call(host, 'POST', `/${pageId}/subscribed_apps?subscribed_fields=feed,messages`, token);

export const replyToComment = (host, token, commentId, message) =>
  call(host, 'POST', `/${commentId}/comments`, token, { message });

// Private reply: one message per comment, within 7 days of the comment.
export const privateReplyText = (host, token, pageId, commentId, text) =>
  call(host, 'POST', `/${pageId}/messages`, token, { recipient: { comment_id: commentId }, message: { text } });
export const privateReplyButton = (host, token, pageId, commentId, text, title, url) =>
  call(host, 'POST', `/${pageId}/messages`, token, { recipient: { comment_id: commentId }, message: buttonMessage(text, title, url) });

// Webhook "feed" event -> the comment shape the engine understands (null if it is not a new top-level comment).
// Facebook sends created_time as unix seconds here.
export function commentFromWebhook(value) {
  if (!value || value.item !== 'comment' || value.verb !== 'add' || !value.comment_id) return null;
  if (value.parent_id && value.parent_id !== value.post_id) return null; // a reply to a comment, not a top-level comment
  const t = Number(value.created_time);
  return {
    id: value.comment_id, text: value.message || '', username: value.from?.name,
    timestamp: Number.isFinite(t) ? new Date(t * 1000).toISOString().replace(/\.\d{3}Z$/, '+0000') : undefined,
    from: { id: value.from?.id ?? null, username: value.from?.name }, media: { id: value.post_id },
  };
}
