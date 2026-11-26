// Content report: scripts, the report's rules and the AI reading (with a fake fetch: nothing is spent).
import assert from 'node:assert/strict';
process.env.DB_FILE = ':memory:';
process.env.OPENROUTER_API_KEY = 'sk-test';
const { run } = await import('../src/db.mjs');
const { parseScript, hookTraits, estSeconds } = await import('../src/script.mjs');
const { saveMediaInfo } = await import('../src/stats.mjs');
const { contentReport, saveScript } = await import('../src/report.mjs');
const ai = await import('../src/ai-report.mjs');

// ======== scripts ========
const json = { chapters: [{ label: 'the hook', beats: [{ text: 'Nobody shares your PDF.' }, { text: 'But your game, yes.' }] }, { label: 'body', beats: [{ text: 'The AI writes it for you.' }] }] };
let g = parseScript(JSON.stringify(json));
assert.equal(g.hook, 'Nobody shares your PDF. But your game, yes.', 'the hook is the "hook" chapter');
assert.equal(g.script, 'Nobody shares your PDF. But your game, yes. The AI writes it for you.');
assert.equal(g.words, 14);
g = parseScript({ chapters: [{ label: 'intro', beats: [{ text: 'One.' }, { text: 'Two.' }, { text: 'Three.' }] }] });
assert.equal(g.hook, 'One. Two.', 'without a "hook" chapter: the first 2 sentences');
g = parseScript('First sentence here. Second? Third.');
assert.equal(g.hook, 'First sentence here. Second?', 'plain text: first 2 sentences');
assert.equal(parseScript({ hook: 'My hook', text: 'My hook and more' }).hook, 'My hook');
assert.equal(parseScript(''), null); assert.equal(parseScript(null), null);
assert.equal(estSeconds(26), 10); assert.equal(estSeconds(0), null);
const t = hookTraits('Did you know 3 ChatGPT prompts save you hours?');
assert.ok(t.number && t.question && t.you && t.brand && t.short && !t.contrarian, JSON.stringify(t));
assert.ok(hookTraits('Nobody shares your PDF').contrarian);
assert.ok(hookTraits('Twelve free prompts').number, 'numbers written as words');
assert.ok(hookTraits('¿Sabías que nadie usa esto?').contrarian, 'Spanish hooks are measured too');

// ======== sample data: 6 reels ========
run("INSERT INTO brands(name) VALUES ('Brand')");
run("INSERT INTO channels(brand_id, ig_user_id, username, token, host) VALUES (1,'IG1','acct','t','graph.instagram.com')");
const day = (n) => new Date(Date.now() - n * 86400e3).toLocaleDateString('sv');
const at = (n, h) => { const d = new Date(Date.now() - n * 86400e3); d.setHours(h, 0, 0, 0); return d.toISOString(); };
const reels = [ // id, views, days since posted, hour, hook
  ['R1', 3000, 6, 19, 'Nobody shares your PDF. But your game, yes.'], ['R2', 2600, 5, 20, 'The AI makes 99 video styles.'],
  ['R3', 1000, 4, 9, 'Today I want to talk about a new tool that came out this week and that might be useful.'], ['R4', 900, 3, 10, 'Did you know AI can write?'],
  ['R5', 300, 3, 8, 'A quick tutorial to organize all of your work for the week in one single place, step by step.'], ['R6', 1100, 2, 21, null],
];
for (const [id, v, d, h, hook] of reels) {
  saveMediaInfo(1, { id, timestamp: at(d, h).replace('Z', '+0000').replace(/\.\d{3}/, ''), media_type: 'VIDEO', permalink: 'https://instagram.com/reel/' + id });
  for (let i = d; i >= 0; i--) run('INSERT INTO media_stats(channel_id, media_id, day, likes, comments, views, saved, shares, watch_ms) VALUES (1,?,?,?,?,?,?,?,?)', id, day(i), 10, 40, Math.round(v * Math.min(1, (d - i + 1) / 2)), 30, 5, 9000);
  if (hook) saveScript(1, id, parseScript({ hook, text: hook + ' ' + 'word '.repeat(100) }), 'test');
}
run(`INSERT INTO automations(channel_id,name,keywords,dm_text,mode,media_id,since) VALUES (1,'A','["game"]','x','link','R1',datetime('now','-30 days'))`);
for (let i = 0; i < 20; i++) run(`INSERT INTO runs(automation_id, comment_id, status, media_id, created_at) VALUES (1, ?, 'done', 'R1', datetime('now','-1 days'))`, 'c' + i);
run("INSERT INTO account_stats(channel_id, day, followers, views) VALUES (1, ?, 100, 5000), (1, ?, 130, 6000)", day(6), day(0));

const rep = contentReport({ range: 30 });
assert.equal(rep.reels.length, 6);
assert.equal(rep.typical, 1050, 'median of 3000, 2600, 1100, 1000, 900, 300');
const R = Object.fromEntries(rep.reels.map((r) => [r.media_id, r]));
assert.equal(R.R1.verdict, 'winner'); assert.equal(R.R5.verdict, 'low'); assert.equal(R.R3.verdict, 'normal');
assert.equal(R.R1.ratio, 2.9);
assert.equal(R.R1.dms, 20); assert.equal(R.R1.keyword, 'game'); assert.equal(R.R1.keywordShare, 50, '20 of 40 comments');
assert.equal(R.R1.hour, 19, 'local posting hour');
assert.equal(rep.bestHooks[0].media_id, 'R1'); assert.equal(rep.worstHooks[0].media_id, 'R5');
assert.ok(!rep.bestHooks.concat(rep.worstHooks).some((r) => r.media_id === 'R6'), 'a reel without a script is left out of hooks');
assert.equal(rep.noScript, 1);
assert.ok(rep.traits.find((x) => x.key === 'short'), 'compares short hooks with long ones');
const evening = rep.slots.find((s) => s.key === 'evening');
assert.equal(evening.n, 3); assert.equal(rep.bestSlot.key, 'evening');
assert.ok(rep.actions.some((a) => a.key === 'slot' && a.v.best === 'evening'), 'recommends the winning slot');
assert.ok(rep.life.winners || rep.life.others, 'life curve with data from the posting day');
assert.equal(rep.funnel[0].n, 8900); assert.equal(rep.funnel[3].n, 20);
assert.equal(contentReport({ range: 7 }).reels.length, 6);
const empty = contentReport({ range: 30, brand: 99 });
assert.equal(empty.reels.length, 0); assert.equal(empty.enough, false);

// ======== AI ========
run("INSERT INTO contacts(channel_id, external_id, username, fields) VALUES (1,'p1','secret_user','{\"email\":\"secret@example.com\"}')");
const input = JSON.stringify(ai.aiInput(rep));
assert.ok(!/secret_user|secret@example|sk-test|IG1/.test(input), 'the model never gets usernames, emails or keys');
assert.ok(input.includes('Nobody shares your PDF'), 'it does get the hooks');
let calls = 0, sent;
const fake = async (url, o) => { calls++; sent = JSON.parse(o.body); return { ok: true, status: 200, json: async () => ({ model: 'anthropic/claude-haiku-5.5', usage: { cost: 0.002 }, choices: [{ message: { content: '```json\n{"summary":"S","hook_patterns":["a"],"script_patterns":[],"timing":"h","try_next":["p"],"new_hooks":[{"text":"t","why":"w"}]}\n```' } }] }) }; };
const out = await ai.interpret({ range: 30, lang: 'es' }, fake);
assert.equal(out.summary, 'S'); assert.equal(out.cost, 0.002); assert.equal(out.cached, false);
assert.equal(sent.model, 'anthropic/claude-haiku-5.5');
assert.ok(sent.messages[0].content.includes('Write in Spanish'), 'answers in the dashboard language');
const again = await ai.interpret({ range: 30, lang: 'es' }, fake);
assert.equal(calls, 1, 'the second time comes from what was saved: not paid twice'); assert.equal(again.cached, true);
await ai.interpret({ range: 30, lang: 'es', force: true }, fake);
assert.equal(calls, 2, '"Interpret again" does call');
await assert.rejects(() => ai.interpret({ range: 30, lang: 'en', force: true }, async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'bad key' } }) })), /OpenRouter: bad key/);
await assert.rejects(() => ai.interpret({ range: 30, brand: 99, force: true }, fake), /At least 3 reels/);
delete process.env.OPENROUTER_API_KEY;
assert.equal(ai.aiEnabled(), false);
await assert.rejects(() => ai.interpret({ range: 30 }, fake), /OPENROUTER_API_KEY/);

console.log('OK: content report tests passed');
