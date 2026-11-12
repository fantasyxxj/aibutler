// test-lone-surrogate.js — 半个 emoji(孤立代理项)不许落盘: 记忆库每张表、聊天快照、聊天日志、修订日志。
// 截文字时也不许切开 emoji。用法: node personal/test-lone-surrogate.js (只在 /tmp 建库)
const fs = require('fs');
const path = require('path');
const ls = require('../core/lone-surrogate');
const { MemoryStoreV2 } = require('../core/memory-store-v2');
const chat = require('../core/chat-store');

const DIR = '/tmp/test-lone-surrogate';
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

const HIGH = '😀'.slice(0, 1), LOW = '😀'.slice(1);
let fail = 0;
const t = (name, fn) => {
  try { fn(); console.log('✔', name); } catch (e) { fail++; console.log('✖', name, '—', e.message); }
};
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}: 期望 ${JSON.stringify(b)}, 实得 ${JSON.stringify(a)}`); };
const clean = (s, m) => { if (ls.hasLone(s)) throw new Error(`${m} 里还有半个 emoji: ${JSON.stringify(s)}`); };

t('dropLone 删掉前半个、后半个, 完整 emoji 不动', () => {
  eq(ls.dropLone(`特价${HIGH}后面`), '特价后面', '中间');
  eq(ls.dropLone(`${LOW}开头`), '开头', '开头');
  eq(ls.dropLone('正常 😀 👍🏻'), '正常 😀 👍🏻', '完整');
  eq(ls.hasLone(`x${HIGH}`), true, 'hasLone');
  eq(ls.hasLone('😀'), false, 'hasLone 完整');
});

t('head / tail 不切开 emoji', () => {
  eq(ls.head('ab😀cd', 3), 'ab', 'head 切在 emoji 中间就少取一个');
  eq(ls.head('ab😀cd', 4), 'ab😀', 'head 切在 emoji 后');
  eq(ls.tail('ab😀cd', 3), 'cd', 'tail 切在 emoji 中间就少取一个');
  eq(ls.tail('ab😀cd', 4), '😀cd', 'tail 切在 emoji 前');
});

t('记忆库: 节点、错误日志写进去就没有半个 emoji', () => {
  const s = new MemoryStoreV2(path.join(DIR, 'mem'));
  const id = s.upsertNode({ slug: 'cut_node', title: `标题${HIGH}`, claim: `老板说今天特价${HIGH}`, keywords: `特价 ${LOW}`, body: `正文 😀 完整, 截断${HIGH}`, type: 'reference' });
  const n = s.nodeBySlug('cut_node');
  eq(n.claim, '老板说今天特价', 'claim');
  eq(n.title, '标题', 'title');
  clean(n.keywords, 'keywords');
  eq(s.bodiesOf([id]).get(id), '正文 😀 完整, 截断', 'body');
  s.logError({ node_id: id, raw: `[Write] 一段被截到五百字的预览${HIGH}` });
  eq(s.errorLog()[0].raw, '[Write] 一段被截到五百字的预览', 'error_log');
});

t('聊天快照和日志: 落盘的 JSON 里没有 \\udXXX 落单', () => {
  const f = path.join(DIR, '.session.json');
  chat.save(f, { sessionId: 's', messages: [{ role: 'user', text: `截断${HIGH}`, ts: 1 }, { role: 'assistant', text: '写着 \\ud83d 这几个字 😀', ts: 2 }] });
  const raw = fs.readFileSync(f, 'utf8');
  if (/(?<!\\)\\ud83d/.test(raw)) throw new Error('快照里有转义的半个 emoji: ' + raw);
  const back = chat.load(f).messages;
  eq(back[0].text, '截断', '快照读回');
  eq(back[1].text, '写着 \\ud83d 这几个字 😀', '正文里写着转义字样的不动');
  const hd = path.join(DIR, 'history');
  chat.appendHistory(hd, [{ role: 'tool', text: `${LOW}开头被截`, ts: Date.now() }]);
  const line = fs.readFileSync(path.join(hd, fs.readdirSync(hd)[0]), 'utf8');
  clean(JSON.parse(line).text, '日志');
  eq(JSON.parse(line).text, '开头被截', '日志读回');
});

t('chat_log 检索按 clip 截每条, 不切开 emoji', () => {
  const hd = path.join(DIR, 'history-clip');
  chat.appendHistory(hd, [{ role: 'user', text: 'x'.repeat(79) + '😀' + '尾巴'.repeat(10), ts: Date.now() }]);
  const r = chat.searchHistory(hd, { terms: ['x'], clip: 80 });
  clean(r.hits[0].text, 'chat_log 截断');
  if (!r.hits[0].text.startsWith('x'.repeat(79) + ' …[+')) throw new Error('截法不对: ' + r.hits[0].text.slice(0, 100));
});

t('修订日志: 截断不切开 emoji', () => {
  const rev = require('../core/memory-revisions');
  rev.logRevision(DIR, { op: rev.OPS ? [...rev.OPS][0] : 'upsert', node_id: 'n1', old_body: '😀'.repeat(3000), new_body: `x${HIGH}` });
  const dir = fs.readdirSync(DIR).find((d) => d.startsWith('_rev'));
  const line = fs.readFileSync(path.join(DIR, dir, 'n1.jsonl'), 'utf8').trim();
  const r = JSON.parse(line);
  clean(r.old_body, 'old_body'); clean(r.new_body, 'new_body');
});

t('旧库里已有的半个 emoji: 打开库时清掉一次, doctor 再查报 0, 向量不动', () => {
  const dir = path.join(DIR, 'old');
  const s0 = new MemoryStoreV2(dir);
  const id = s0.upsertNode({ slug: 'old_node', title: 'T', claim: '旧命题', body: '旧正文', type: 'reference' });
  s0.logError({ node_id: id, raw: '旧记账' });
  s0.db.close(); s0._db = null;
  // 绕过写入口, 模拟 1.1.4 之前存进去的坏数据
  const { Database } = require('node-sqlite3-wasm');
  const raw = new Database(path.join(dir, require('../core/memory-store-v2').DB_FILE));
  // 直接写字节(驱动编码半个 emoji 时会吞掉后一个字): 词 ED A0 BD 语 —— 与真实坏数据同形
  raw.run("UPDATE nodes SET claim = ?, keywords = CAST(X'E8AF8DEDA0BDE8AFAD' AS TEXT) WHERE id = ?", [`被截断的命题${HIGH}`, id]);
  raw.run('UPDATE error_log SET raw = ?', [`预览${HIGH}`]);
  raw.run("DELETE FROM meta WHERE k = 'lone_heal'");
  raw.run('CREATE TABLE IF NOT EXISTS probe_blob (b BLOB)');
  raw.run('INSERT INTO probe_blob VALUES (?)', [new Uint8Array([1, 0xED, 0xA0, 0x80, 2])]);
  raw.close();
  const s1 = new MemoryStoreV2(dir);
  const n = s1.nodeBySlug('old_node');
  eq(n.claim, '被截断的命题', '开库后 claim');
  eq(n.keywords, '词语', '开库后 keywords');
  eq(s1.errorLog()[0].raw, '预览', '开库后 error_log');
  eq(s1.getMeta('lone_heal'), '1', '记过一次');
  eq(s1.loneSurrogateScan().found, 0, '再查为 0');
  eq(Buffer.from(s1.db.get('SELECT b FROM probe_blob').b).toString('hex'), '01eda08002', 'BLOB 原样');
});

t('体检 doctor: 查到就删, 报删了几处; 再查为 0', () => {
  require('./host-wiring');
  const { Butler } = require('../core/agent');
  const g = new Butler(path.join(DIR, 'doc'), { name: '体检测试' }).memory;
  g.upsert({ slug: 'doc_node', claim: '体检用的命题' });
  // SQL 里直接写字节, 不经写入口: 模拟 1.1.4 之前存进去的
  g.store.db.run("UPDATE nodes SET claim = CAST(X'E4BD93EDA0BD' AS TEXT) WHERE slug = 'doc_node'");
  eq(g.doctor().lone_surrogates_fixed, 1, '第一次体检删 1 处');
  eq(g.store.nodeBySlug('doc_node').claim, '体', '删完的命题');
  eq(g.doctor().lone_surrogates_fixed, 0, '再查 0 处');
});

fs.rmSync(DIR, { recursive: true, force: true });
console.log(fail ? `✖ ${fail} 项失败` : '✔ 全部通过');
process.exit(fail ? 1 : 0);
