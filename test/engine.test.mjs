import assert from 'node:assert/strict';
process.env.DB_FILE = ':memory:';
const { run, get, all } = await import('../src/db.mjs');
const { matches, handleComment, drySender } = await import('../src/engine.mjs');

const A = (o) => ({ match_mode: 'contains', keywords: '[]', exclude: '[]', ...o });

// Keyword matching
assert.ok(matches(A({ keywords: '["guía"]' }), 'QUIERO LA GUIA porfa'), 'ignores case and accents');
assert.ok(!matches(A({ keywords: '["guia"]', match_mode: 'word' }), 'guiamos a todos'), 'whole word does not match inside another word');
assert.ok(matches(A({ keywords: '["guia"]', match_mode: 'word' }), 'Me das la guia?'), 'whole word matches');
assert.ok(matches(A({ keywords: '["yo"]', match_mode: 'exact' }), ' Yo '), 'exacto');
assert.ok(!matches(A({ keywords: '["yo"]', match_mode: 'exact' }), 'yo quiero'), 'exact does not match with extra text');
assert.ok(!matches(A({ keywords: '["guia"]', exclude: '["spam"]' }), 'guia spam'), 'exclusion');
assert.ok(matches(A({ match_mode: 'any' }), 'lo que sea'), 'any comment');
assert.ok(!matches(A({}), 'hola'), 'without keywords it does not match');

// Full flow with a simulated sender
run("INSERT INTO brands(name) VALUES ('T')");
run("INSERT INTO channels(brand_id, ig_user_id, username) VALUES (1,'IG1','cuenta')");
run(`INSERT INTO automations(channel_id,name,media_id,keywords,public_replies,dm_text,button_title,button_url,tag,delay_seconds)
     VALUES (1,'A','M1','["guia"]','["Listo {{username}}"]','Hola {{username}}','Abrir','https://x.com','lead',0)`);
const ch = get('SELECT * FROM channels WHERE id=1');
const log = [];
const c = { id: 'C1', text: 'quiero la guia', from: { id: 'U1', username: 'ana' }, media: { id: 'M1' } };

let l = handleComment(ch, c, { sender: drySender(log), dry: true, instant: true });
await Promise.all(l.map((x) => x.done));
assert.equal(l.length, 1);
assert.deepEqual(log.map((x) => x.action), ['dm_button', 'public_reply']); // primero el DM
assert.equal(log[1].text, 'Listo ana');
assert.equal(get('SELECT tags FROM contacts WHERE external_id=?', 'U1').tags, '["lead"]');

// Does not duplicate the same comment
assert.equal(handleComment(ch, c, { sender: drySender([]), dry: true, instant: true }).length, 0);
// Another post: does not apply
assert.equal(handleComment(ch, { ...c, id: 'C2', media: { id: 'OTRO' } }, { sender: drySender([]), instant: true }).length, 0);
// Own comment: ignored
assert.equal(handleComment(ch, { ...c, id: 'C3', from: { id: 'IG1', username: 'cuenta' } }, { sender: drySender([]), instant: true }).length, 0);

console.log('OK: engine tests passed');
