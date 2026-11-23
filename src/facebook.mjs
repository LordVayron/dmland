// Facebook Page client (Messenger). Same function shapes as meta.mjs (Instagram), so the poller,
// the engine and the email capture work on both without knowing which one they talk to.
// Everything here is returned in Instagram's shape: posts as {id, caption, thumbnail_url, permalink,
// timestamp, ...} and comments as {id, text, username, timestamp, from}.
// The "account id" is the Page ID. The stored token is a Page access token: the person pastes a system user
// token and DMLand exchanges it for the Page token when connecting (see getAccount).
import { call } from './meta.mjs';

export const DEFAULT_HOST = 'graph.facebook.com';

// Page data. Facebook Pages may have no @username: fall back to the name without spaces.
// Also returns `page_token`: Meta requires a Page access token for posts, comments and Messenger.
// It is obtained with the system user token; if that token never expires, this one does not either.
export const getAccount = async (host, token, pageId) => {
  const r = await call(host, 'GET', `/${pageId}?fields=id,name,username,access_token`, token);
  const { access_token: pageToken, ...info } = r;
  return { ...info, username: info.username || String(info.name || info.id).replace(/\s+/g, ''), page_token: pageToken || null };
};

const POST_FIELDS = 'id,message,permalink_url,created_time,full_picture,likes.limit(0).summary(true),comments.limit(0).summary(true)';
const LIGHT_POST_FIELDS = 'id,message,permalink_url,created_time,full_picture';
const fromPost = (p) => ({
  id: p.id, caption: p.message || '', media_type: 'POST', thumbnail_url: p.full_picture || '', media_url: p.full_picture || '',
  permalink: p.permalink_url, timestamp: p.created_time,
  like_count: p.likes?.summary?.total_count ?? null, comments_count: p.comments?.summary?.total_count ?? null });

// Meta sometimes answers "Please reduce the amount of data" (code 1) to the full list: retry smaller and without counts.
async function publishedPosts(host, token, pageId) {
  try { return await call(host, 'GET', `/${pageId}/published_posts?fields=${POST_FIELDS}&limit=24`, token); }
  catch (e) {
    if (e.code !== 1 && !/reduce the amount of data/i.test(e.message)) throw e;
    return call(host, 'GET', `/${pageId}/published_posts?fields=${LIGHT_POST_FIELDS}&limit=12`, token);
  }
}

// Page reels. A reel usually also shows up as a post (its `post_id`) and both share the same comments.
const REEL_FIELDS = 'id,description,created_time,permalink_url,picture,post_id';
const fromReel = (v) => ({
  id: v.id, caption: v.description || '', media_type: 'REELS', thumbnail_url: v.picture || '', media_url: v.picture || '',
  permalink: v.permalink_url ? (String(v.permalink_url).startsWith('http') ? v.permalink_url : `https://www.facebook.com${v.permalink_url}`) : null,
  timestamp: v.created_time, like_count: null, comments_count: null });
export const listReels = async (host, token, pageId) =>
  ((await call(host, 'GET', `/${pageId}/video_reels?fields=${REEL_FIELDS}&limit=12`, token)).data || []).map((v) => ({ ...fromReel(v), post_id: v.post_id || null }));

// Posts and reels together, newest first. A reel that is already listed as a post is the same video:
// only the post stays (it has the thumbnail and like count). If Meta refuses the reels list, posts alone come back.
export const listMedia = async (host, token, pageId) => {
  const r = await publishedPosts(host, token, pageId);
  const posts = (r.data || []).map(fromPost);
  let reels = [];
  try { reels = await listReels(host, token, pageId); } catch { /* no reels: posts only */ }
  const postIds = new Set(posts.map((p) => String(p.id)));
  reels = reels.filter((v) => !v.post_id || !postIds.has(`${pageId}_${v.post_id}`)).map(({ post_id, ...v }) => v);
  const data = [...posts, ...reels].sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || ''))).slice(0, 24);
  return { ...r, data };
};

// One post or reel by its ID.
export const getMedia = async (host, token, id) => {
  try { return fromPost(await call(host, 'GET', `/${id}?fields=${POST_FIELDS}`, token)); }
  catch { return fromReel(await call(host, 'GET', `/${id}?fields=${REEL_FIELDS}`, token)); }
};

// Checks, with the Page token, what DMLand needs: reading posts, comments and Messenger.
// Throws an error that names the missing permission.
const PERM_HINT = { 10: 'pages_read_user_content', 200: 'pages_read_engagement', 190: 'pages_messaging' };
export async function checkAccess(host, pageToken, pageId) {
  const step = async (what, path) => {
    try { return await call(host, 'GET', path, pageToken); }
    catch (e) {
      const perm = String(e.message).match(/'(pages_[a-z_]+)'/)?.[1] || PERM_HINT[e.code];
      throw new Error(`The Page was found, but Meta does not allow ${what}${perm ? `: the token is missing the ${perm} permission` : ''}. Add it to the app and the token, generate a new token and connect again. (Meta: ${e.message})`);
    }
  };
  const posts = await step('reading its posts', `/${pageId}/published_posts?fields=id&limit=1`);
  const first = posts.data?.[0];
  if (first) await step('reading comments', `/${first.id}/comments?fields=id&filter=toplevel&limit=1`);
  await step('reading Messenger conversations', `/${pageId}/conversations?platform=messenger&fields=id&limit=1`);
}

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
