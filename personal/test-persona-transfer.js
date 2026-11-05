#!/usr/bin/env node
// test-persona-transfer.js — 人格导出/导入的门禁。
// 重点不在"能不能打包", 而在四件出事才知道的事:
//   ① 包是别的机器给的文件 → 路径必须当不可信输入处理(zip slip)
//   ② 凭据不能跟着包走遍邮件和网盘
//   ③ 记忆必须一条不差地过去 —— 少一条, 导入的人格就是个缺了记忆还不报错的壳
//   ④ 🔴 边不能错位: 数字主键不跨机器, 导入端重新发 id, 边必须跟着重新指向
//      (错位的边比断掉的边坏得多 —— 它会把两条不相干的记忆连起来, 且看不出来)
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const os = require('os');
const T = require('./persona-transfer');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}`); } };
const throws = (fn, re, m) => {
  try { fn(); fail++; console.log(`  ✗ ${m} (没抛错)`); }
  catch (e) { const good = !re || re.test(e.message); if (good) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m} — 抛的是: ${e.message}`); } }
};

const TMP = path.join(os.tmpdir(), 'persona-transfer-test');
fs.rmSync(TMP, { recursive: true, force: true });
const HOME = path.join(TMP, 'src');
const mk = (rel, content) => {
  const abs = path.join(HOME, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
};

// —— 造一个像样的人格目录 ——
mk('.claude/memory/persona.md', '---\nname: 测试人格\n---\n我是测试人格');
mk('.claude/memory/MEMORY.md', '# 交接便条\n- 一件没干完的事');
// 记忆库文件。🔴 它【不该进包】—— 搬的是记忆内容(memory.export.json), 不是数据库文件。
// 留在这里正是为了断言它被排除, 以及验 hasV2Db 认得出"这人格有 v2 库"。
mk('.claude/memory/memory.v2.db', Buffer.from([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0, 1, 2, 3]));
mk('.claude/memory/memory.db', Buffer.from([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 9]));   // v1 派生索引, 同样不带
mk('.claude/memory/_revisions/a.jsonl', '{"op":"update"}\n');
mk('mcp.json', '{"servers":["bus"]}');
mk('schedule.json', '{"enabled":true,"entries":[]}');
// 下面这些都不该进包
mk('node_modules/junk/index.js', 'module.exports=1');
mk('logs/run.log', 'noise');
mk('.claude/memory/memory_index.json', '{"cache":true}');
mk('.claude/memory/memory.v2.db-wal', 'wal');
// 🔴 SQLite 的锁是个【目录】不是文件。后缀表原先只对文件生效, `.lock` 对它完全没起作用。
mk('.claude/memory/memory.v2.db.lock/held', 'pid');
mk('line_messages.jsonl', '{"from":"客户","text":"隐私"}');
mk('.DS_Store', 'junk');
// 实测 banto 那份 177KB, 里面是逐字对话 + 用户粘过的 token/Bearer/key
mk('.claude/memory/.session.json', '{"sessionId":"abc","messages":[{"text":"我的 token 是 sk-xxx"}]}');
mk('attachments/2026-08-01/pic.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));

const ENTRY = {
  id: 'old-id', name: '测试人格', avatar: '🧪', model: 'claude-sonnet-4-6',
  homeDir: HOME, isButler: true, createdAt: 111,
  chips: { used: 3 },
  plugins: { tg: { mode: 'on', bot_token: '123:SECRET', chat_ids: ['c1'] } },
};

// 记忆记录清单: 真实导出时由 store.exportGraph() 现造, 磁盘上没有这个文件, 走 extraFiles 进包。
const MEM_REL = `.claude/memory/${T.MEMORY_EXPORT}`;
const GRAPH = {
  nodes: [
    { id: 7, slug: 'a', title: '甲', claim: '甲是真的', body: '正文甲', type: 'reference', importance: 'high', use_count: 5 },
    { id: 9, slug: 'b', title: '乙', claim: '乙是真的', body: '正文乙', type: 'feedback', importance: 'med', use_count: 1 },
    { id: 4, slug: 'c', title: '丙', claim: '丙是真的', body: '正文丙', type: 'project', importance: 'low', use_count: 2 },
  ],
  edges: [
    { src: 7, dst: 9, rel: 'relates', made_by: 'human', weight: 1 },
    { src: 9, dst: 4, rel: 'supersedes', made_by: 'human', weight: 1 },
    { src: 7, dst: 999, rel: 'relates', made_by: 'engine', weight: 1 },   // 悬空边: 指向不存在的节点
  ],
  pinned: [{ node_id: 4, added_at: '2026-08-19', reason: '常查' }],
  redlines: [{ node_id: 7, trigger_pattern: 'rm -rf', correct_action: '先问', level: 'block', violations: 2 }],
};
const memBuf = Buffer.from(JSON.stringify(GRAPH), 'utf8');
const EXTRA = { [MEM_REL]: memBuf };

console.log('\n[收集: 该带的带上, 不该带的一个不带]');
const files = T.collectFiles(HOME).map((f) => f.path);
ok(!files.includes('.claude/memory/memory.v2.db'),
  '🔴 记忆库文件不进包 —— 搬的是记忆内容不是数据库(顺带堵掉 utterances 逐字原话跟着库走的隐私漏)');
ok(!files.includes('.claude/memory/memory.db'), 'v1 库也不进包(它只是 .md 的派生索引, 导入端自己重建)');
ok(T.hasV2Db(HOME), 'hasV2Db 认得出这人格有 v2 库(据此强制要求调用方给记录清单)');
ok(files.includes('.claude/memory/persona.md'), '身份档案进包');
ok(files.includes('.claude/memory/MEMORY.md'), '交接便条进包');
ok(files.includes('.claude/memory/_revisions/a.jsonl'), '修订史进包');
ok(files.includes('mcp.json') && files.includes('schedule.json'), '人格级配置进包');
ok(!files.some((f) => f.startsWith('node_modules/')), 'node_modules 不进包');
ok(!files.some((f) => f.startsWith('logs/')), '日志不进包');
ok(!files.includes('.claude/memory/memory_index.json'), '检索缓存不进包(可重建, 白占 600KB)');
ok(!files.includes('.claude/memory/memory.v2.db-wal'), 'SQLite 伴生文件不进包(会和主库对不上号)');
ok(!files.some((f) => f.includes('memory.v2.db.lock')),
  '🔴 后缀表对目录也生效 —— SQLite 的 .lock 是个目录, 别让锁跟着包搬到别的机器上');
ok(T.shouldSkip('x.lock', true) && T.shouldSkip('x.lock', false), '.lock 不管是文件还是目录都跳过');
ok(T.shouldSkip('logs', true) && !T.shouldSkip('logs', false), '目录名表只对目录生效(叫 logs 的文件不误伤)');
ok(!files.includes('line_messages.jsonl'), '🔴 聊天记录不进包(隐私; 人格的记忆在记忆库里)');
ok(!files.includes('.claude/memory/.session.json'),
  '🔴 .session.json 不进包 —— 它是逐字对话史, 且实测含用户粘过的 token/Bearer/key');
ok(!files.some((f) => f.startsWith('attachments/')), '🔴 消息附件不进包(对话都不带了, 附件是没上下文的隐私)');
ok(!files.includes('.DS_Store'), '系统垃圾文件不进包');
// 兜底: 整包里不该出现任何像凭据的字符串。这条比逐个文件名断言更耐得住"以后又多了个新文件"
{
  const raw = zlib.gunzipSync(T.packPersona(HOME, ENTRY, { extraFiles: EXTRA })).toString('binary');
  ok(!/sk-xxx/.test(raw), '🔴 整包扫一遍: 测试语料里的假密钥没被打进去');
}
// 🔴 这条挡的是最坏的一种错: 包看着导出成功, 对面导入后人格失忆, 而那时源机器可能已经不在手边
throws(() => T.packPersona(HOME, ENTRY, {}), /没有提供/,
  '🔴 有 v2 库却没给记录清单 → 当场炸, 不许导出一个没有记忆的包');

console.log('\n[凭据: 绝不跟着包走]');
const { persona, stripped } = T.stripCredentials(ENTRY);
ok(persona.name === '测试人格' && persona.avatar === '🧪', '身份跟着走');
ok(persona.model === 'claude-sonnet-4-6', '模型选择跟着走');
ok(persona.plugins.tg.mode === 'on', '插件开关跟着走');
ok(persona.plugins.tg.bot_token === undefined, '🔴 bot_token 被摘掉');
ok(stripped.includes('tg.bot_token'), '摘掉了什么要说出来(导入端好提示用户重配)');
ok(persona.isButler === undefined, '🔴 管家身份不跟着走(管家全局唯一, 导进去会挤掉新机器原本的管家)');
ok(persona.id === undefined && persona.homeDir === undefined, 'id 与 homeDir 不跟着走(新机器另发)');
ok(T.stripCredentials({ plugins: { x: { api_key: 'k', apiSecret: 's', password: 'p', mode: 'on' } } })
  .persona.plugins.x.mode === 'on', '按名字判凭据: 新插件加进来也自动挡住');
ok(Object.keys(T.stripCredentials({ plugins: { x: { api_key: 'k', apiSecret: 's', password: 'p' } } })
  .persona.plugins.x).length === 0, 'api_key / apiSecret / password 全被摘');
// 🔴 bus 目标表是**数组**, 每条各带一个 token。只剥最外层的话它们会整条进包。
{
  const r = T.stripCredentials({ plugins: { buses: [
    { id: 'line', kind: 'v1', base_url: 'https://bus.example.com', token: 'SECRET-1' },
    { id: 'bothub', kind: 'bothub', base_url: 'https://hub.example.com', agent: 'me', token: 'SECRET-2' },
  ] } });
  const out = r.persona.plugins.buses;
  ok(Array.isArray(out) && out.length === 2, '表还是表(别把数组剥成对象, 导入端就读不出顺序了)');
  ok(out[0].token === undefined && out[1].token === undefined, '🔴 每条 bus 的 token 都被摘掉');
  ok(out[0].base_url === 'https://bus.example.com' && out[1].agent === 'me', '不是凭据的照常跟着走');
  ok(r.stripped.includes('buses[0].token') && r.stripped.includes('buses[1].token'),
     '摘的是哪一条要说清(导入端要提示用户逐条重配)');
}

console.log('\n[往返: 导出再导入, 内容一个字节不差]');
const PACK_OPTS = { butlerVersion: '0.0.58', extraFiles: EXTRA, memory: { mode: 'graph', nodes: 3 } };
const pkg = T.packPersona(HOME, ENTRY, PACK_OPTS);
ok(Buffer.isBuffer(pkg) && pkg.length > 0, '打出来是一个 Buffer');
const { header, files: got } = T.readPackage(pkg);
ok(header.format === 'butler-persona/2', '格式号写进了头部');
ok(header.butlerVersion === '0.0.58', '导出时的 butler 版本写进了头部');
ok(header.persona.name === '测试人格', '人格信息在头部(导入前就能给用户看清是谁)');
ok(header.memory && header.memory.nodes === 3, '记忆条数写进头部(导入前就能看出带了多少记忆)');
ok(got.size === files.length + 1, `文件数对得上: 磁盘文件 + 记录清单 (${got.size}/${files.length + 1})`);
ok(got.get(MEM_REL).equals(memBuf), '🔴 记忆记录清单字节完全一致');
ok(got.get('.claude/memory/persona.md').toString() === fs.readFileSync(path.join(HOME, '.claude/memory/persona.md'), 'utf8'),
  '身份档案内容一致');

const DEST = path.join(TMP, 'dest');
T.installFiles(got, DEST);
ok(fs.readFileSync(path.join(DEST, MEM_REL)).equals(memBuf), '落盘后记录清单仍然一致');
ok(!fs.existsSync(path.join(DEST, '.claude/memory/memory.v2.db')), '落盘后目标目录里没有源机器的库文件');
ok(fs.existsSync(path.join(DEST, '.claude/memory/_revisions/a.jsonl')), '子目录结构还原');

console.log('\n[同一人格导两次, 字节一致(便于比对/去重)]');
const pkg2 = T.packPersona(HOME, ENTRY, PACK_OPTS);
const h1 = T.readPackage(pkg).header, h2 = T.readPackage(pkg2).header;
ok(h1.sha256 === h2.sha256, '内容校验和稳定(文件顺序是排过序的)');

console.log('\n[🔴 安全: 包是别的机器给的文件, 路径当不可信输入]');
ok(T.checkRelPath('a/b.txt'), '正常相对路径放行');
ok(!T.checkRelPath('../../.ssh/authorized_keys'), '🔴 ../ 逃逸拒绝');
ok(!T.checkRelPath('/etc/passwd'), '🔴 绝对路径拒绝');
ok(!T.checkRelPath('C:\\Windows\\system32\\x.dll'), '🔴 盘符路径拒绝');
ok(!T.checkRelPath('a\\..\\..\\b'), '🔴 反斜线拒绝(Windows 上它也是分隔符)');
ok(!T.checkRelPath('a/./b'), '. 段拒绝');
ok(!T.checkRelPath('a//b'), '空段拒绝');
ok(!T.checkRelPath('a/b\0c'), '空字节拒绝');

// 手工构造一个恶意包: 头部声明一个逃逸路径
const evilHeader = Buffer.from(JSON.stringify({
  format: 'butler-persona/2', files: [{ path: '../../pwned.txt', size: 3 }],
}), 'utf8');
const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32LE(evilHeader.length, 0);
const evil = zlib.gzipSync(Buffer.concat([T.MAGIC, lenBuf, evilHeader, Buffer.from('pwn')]));
throws(() => T.readPackage(evil), /不安全的路径/, '🔴 带逃逸路径的包直接拒收(不是跳过那一条)');
ok(!fs.existsSync(path.join(TMP, 'pwned.txt')), '没有任何文件被写到目标目录之外');

console.log('\n[坏包: 每种坏法都要有句人话]');
throws(() => T.readPackage(Buffer.from('not gzip at all')), /损坏|不是一个人格包/, '不是 gzip');
throws(() => T.readPackage(zlib.gzipSync(Buffer.from('hello world hello world'))), /不是一个人格包/, 'gzip 了但没有魔数');
const badFmt = Buffer.from(JSON.stringify({ format: 'butler-persona/99', files: [] }), 'utf8');
const bl = Buffer.alloc(4); bl.writeUInt32LE(badFmt.length, 0);
throws(() => T.readPackage(zlib.gzipSync(Buffer.concat([T.MAGIC, bl, badFmt]))), /不支持的包格式/, '未来版本的包说清楚不支持');
// 截断: 头部说有 999 字节, 实际没有
const truncHeader = Buffer.from(JSON.stringify({ format: 'butler-persona/2', files: [{ path: 'a.txt', size: 999 }] }), 'utf8');
const tl = Buffer.alloc(4); tl.writeUInt32LE(truncHeader.length, 0);
throws(() => T.readPackage(zlib.gzipSync(Buffer.concat([T.MAGIC, tl, truncHeader, Buffer.from('ab')]))), /截断/, '内容截断报得出是哪个文件');
// 校验和不符: 改一个字节
const tampered = Buffer.from(zlib.gunzipSync(pkg));
tampered[tampered.length - 1] ^= 0xff;
throws(() => T.readPackage(zlib.gzipSync(tampered)), /校验和/, '🔴 内容被改过 → 校验和拦下');

console.log('\n[落盘: 不覆盖已有人格]');
throws(() => T.installFiles(got, DEST), /非空/, '🔴 目标目录非空就拒绝(两个人格的记忆库对冲没法回滚)');
ok(/^测试人格-\d{4}-\d{2}-\d{2}\.butlerpersona$/.test(T.suggestFileName('测试人格')), '默认文件名带人格名和日期');
ok(T.suggestFileName('../../etc/passwd').indexOf('/') === -1, '🔴 建议文件名里的路径分隔符被清掉');

// ── 🔴 这一组是这次改动的核心门禁 ────────────────────────────────
// 拿【真库】走一遍 导出 → 导入, 而不是拿手写的 JSON 对付。
// 关键设计: 目标库先垫两个占位节点, 逼着自增 id 从不同起点发号 ——
// 否则源和目标碰巧 id 一样, "边跟着重新指向"这件事就测了个寂寞(照抄数字也能过)。
console.log('\n[🔴 记忆往返: 搬内容不搬库, 且边必须跟着重新指向]');
{
  const { MemoryStoreV2 } = require('../core/memory-store-v2');
  const src = new MemoryStoreV2(path.join(TMP, 'memsrc'));
  const dst = new MemoryStoreV2(path.join(TMP, 'memdst'));

  const a = src.upsertNode({ slug: 'a', title: '甲', claim: '甲是真的', body: '正文甲', type: 'reference', importance: 'high', use_count: 5 });
  const b = src.upsertNode({ slug: 'b', title: '乙', claim: '乙是真的', body: '正文乙', type: 'feedback' });
  const c = src.upsertNode({ slug: 'c', title: '丙', claim: '丙是真的', body: '正文丙', type: 'project' });
  src.addEdge(a, b, 'relates', 'human');
  src.addEdge(b, c, 'supersedes', 'human');
  src.setPinned(c, '常查');
  src.setRedline(a, { trigger_pattern: 'rm -rf', correct_action: '先问', level: 'block' });

  // 垫高目标库的自增起点
  dst.upsertNode({ slug: 'z1', title: '占位一', claim: '占位' });
  dst.upsertNode({ slug: 'z2', title: '占位二', claim: '占位' });

  const graph = src.exportGraph();
  ok(graph.nodes.length === 3 && graph.edges.length === 2, `导出拿到 3 节点 2 边 (${graph.nodes.length}/${graph.edges.length})`);
  ok(graph.nodes.every((n) => typeof n.body === 'string' && n.body), '🔴 正文跟着走(NODE_COLS 不含 body, 漏了就是搬了个空壳)');
  ok(!('utterances' in graph), '🔴 逐字原话流水不在导出内容里(隐私 —— 拷 .db 时它是跟着走的)');

  // 经过一次 JSON 往返, 跟真实走包的路径一致(Buffer → 字符串 → 对象)
  const stat = dst.importGraph(JSON.parse(JSON.stringify(graph)));
  ok(stat.nodes === 3, `3 条记忆都灌进去了 (${stat.nodes})`);

  const A = dst.nodeBySlug('a'); const B = dst.nodeBySlug('b'); const C = dst.nodeBySlug('c');
  ok(A && B && C, '三条记忆按 slug 都找得到');
  ok(A.id !== a, `🔴 目标库的 id 确实是重新发的 (源 ${a} → 目标 ${A.id}), 这条不成立下面的边测试就没意义`);
  ok(A.title === '甲' && A.importance === 'high' && A.use_count === 5, '标题/档位/热度原样过去');
  ok(dst.bodiesOf([A.id]).get(A.id) === '正文甲', '正文原样过去');

  const es = dst.allEdges();
  ok(es.length === 2, `边数对 (${es.length}/2)`);
  ok(es.some((e) => e.src === A.id && e.dst === B.id && e.rel === 'relates'), '🔴 甲→乙 relates 指向正确(没照抄源库的数字)');
  ok(es.some((e) => e.src === B.id && e.dst === C.id && e.rel === 'supersedes'), '🔴 乙→丙 supersedes 指向正确');
  ok(!es.some((e) => e.src === a && e.dst === b), '没有一条边还指着源库的旧 id');

  ok(dst.pinnedIds().includes(C.id) && !dst.pinnedIds().includes(A.id), 'pinned 跟对了节点(丙, 不是别人)');
  const rl = dst.redline(A.id);
  ok(rl && rl.trigger_pattern === 'rm -rf' && rl.correct_action === '先问', '红线跟对了节点且内容完整');

  // 悬空边: 源库有外键管着不会有, 但包可能来自一个坏掉的库 / 被人改过。搬家正是挡下它的时机。
  const dst2 = new MemoryStoreV2(path.join(TMP, 'memdst2'));
  const s2 = dst2.importGraph({
    nodes: [{ slug: 'x', title: 'X', claim: 'X 是真的' }],
    edges: [{ src: 1, dst: 999, rel: 'relates' }],
  });
  ok(s2.dropped === 1 && dst2.allEdges().length === 0, '🔴 指不到节点的悬空边被丢掉(v1 库里攒了 95 条, 别跟着搬家)');

  src.close(); dst.close(); dst2.close();
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${fail ? '❌' : '✅'} test-persona-transfer: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
