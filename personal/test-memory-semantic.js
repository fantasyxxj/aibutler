// test-memory-semantic.js — 语义检索门禁。
// 分两段: [A] 纯逻辑(无 electron) 验向量算术与融合规则; [B] 真 electron 里跑通推理闭环。
// 分段是必要的 —— 门禁跑在纯 node 下, 但"推理到底能不能在打好的包里跑起来"只有 electron 能回答,
// 而那恰恰是最容易坏的一环(协议/CORS/wasm 路径), 见 feedback_gates_green_is_not_real_machine_works。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try {
    const r = fn();
    // 异步用例交给 okAsync —— 在这里 return promise 会让失败悄悄溜过去(假绿)。
    assert.ok(!(r && typeof r.then === 'function'), '异步用例请用 okAsync, 否则失败不会被捕获');
    console.log('  ✓', name); pass++;
  } catch (e) { console.log('  ✗', name, '—', e.message); fail++; }
};
// 异步用例: 结果统一在收尾处等齐再打分, 保证 fail 计数是真的。
const asyncRuns = [];
const okAsync = (name, fn) => {
  asyncRuns.push(
    Promise.resolve().then(fn)
      .then(() => { console.log('  ✓', name); pass++; })
      .catch((e) => { console.log('  ✗', name, '—', e.message); fail++; })
  );
};

const { normalize, cosine, topK } = require('../core/memory-vector');
const { MemoryGraph, tokenize, EMBED_MODEL } = require('../core/memory');
const { MemoryStore, contentHash } = require('../core/memory-store');

console.log('\n[1] 向量算术');
ok('归一化后模长为 1', () => {
  const v = normalize(Float32Array.from([3, 4]));
  assert.ok(Math.abs(Math.hypot(v[0], v[1]) - 1) < 1e-6);
});
ok('同向=1 · 正交=0 · 反向=-1', () => {
  const a = normalize([1, 0]), b = normalize([0, 1]), c = normalize([-1, 0]);
  assert.ok(Math.abs(cosine(a, a) - 1) < 1e-6);
  assert.ok(Math.abs(cosine(a, b)) < 1e-6);
  assert.ok(Math.abs(cosine(a, c) + 1) < 1e-6);
});
ok('维度不一致返回 0 而不是抛错(换模型时不该炸)', () => {
  assert.strictEqual(cosine(Float32Array.from([1, 2]), Float32Array.from([1, 2, 3])), 0);
});
ok('topK 按分数降序且滤掉负相关', () => {
  const q = normalize([1, 0]);
  const r = topK(q, [
    { id: 'same', vec: normalize([1, 0]) },
    { id: 'orth', vec: normalize([0, 1]) },
    { id: 'oppo', vec: normalize([-1, 0]) },
  ], { k: 5 });
  assert.deepStrictEqual(r.map((x) => x.id), ['same']);
});

console.log('\n[2] 内容指纹(决定向量何时失效)');
ok('正文变了指纹就变', () => {
  assert.notStrictEqual(contentHash('t', 'd', 'body1'), contentHash('t', 'd', 'body2'));
});
ok('同内容指纹稳定', () => {
  assert.strictEqual(contentHash('标题', '描述', '正文'), contentHash('标题', '描述', '正文'));
});
ok('中日文不塌成同一个值', () => {
  const a = contentHash('', '', '记忆升级');
  const b = contentHash('', '', '記憶升級');
  assert.notStrictEqual(a, b);
});

console.log('\n[3] CJK 分词(个人版长期缺失, 2026-08-13 从行业版回流)');
ok('中文整句切出 2-gram', () => {
  const t = tokenize('记忆升级').map((x) => x.t);
  assert.ok(t.includes('记忆'), '应含「记忆」');
  assert.ok(t.includes('忆升'), '应含「忆升」');
});
ok('切出来的碎片标 derived, 人自己打的整词不标', () => {
  // 「记忆升级」是人打的一整个 token → derived=false; 从它切出来的「记忆」「升级」才是 derived。
  // 这个区分是 IDF 只作用于碎片的前提 —— 标错会让人打的词也被稀有度降权, 既有排序当场变形。
  const t = tokenize('记忆升级 upsert');
  assert.strictEqual(t.find((x) => x.t === 'upsert').derived, false);
  assert.strictEqual(t.find((x) => x.t === '记忆升级').derived, false);
  assert.strictEqual(t.find((x) => x.t === '记忆').derived, true);
});
ok('1-2 位纯数字不进检索, 3 位以上保留', () => {
  const t = tokenize('3 409').map((x) => x.t);
  assert.ok(!t.includes('3'));
  assert.ok(t.includes('409'));
});
ok('日文假名同样切', () => {
  const t = tokenize('予約管理').map((x) => x.t);
  assert.ok(t.includes('予約'));
});

console.log('\n[4] 存储层');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memsem-'));
const w = (n, b) => fs.writeFileSync(path.join(tmp, n), b);
w('n_alpha.md', `---\nname: 甲\ndescription: "关于向量检索的说明"\nmetadata:\n  type: reference\n---\n正文含独特词 zorblat。\n`);
w('n_beta.md', `---\nname: 乙\ndescription: "另一条"\nmetadata:\n  type: project\n---\n提到 [[n_alpha]]。\n`);
const g = new MemoryGraph(tmp);
g.build();

ok('allNodes 不带 body(尺度约束: 内存不随正文总量增长)', () => {
  const n = g.store.allNodes();
  assert.ok(n.n_alpha, '节点应存在');
  assert.strictEqual(n.n_alpha.body, undefined, 'allNodes 不该返回 body');
});
ok('正文兜底仍能命中(走库, 不走内存)', () => {
  const r = g.query('zorblat');
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].id, 'n_alpha');
  assert.ok(r[0].via.includes('正文'), 'via 应标明来自正文兜底, 实际: ' + r[0].via);
});
ok('向量存取往返不失真', () => {
  const v = normalize([0.1, 0.2, 0.3, 0.4]);
  g.store.putVector('n_alpha', { dim: v.length, vec: v, model: 'test-model', srcHash: 'h1' });
  const back = g.store.allVectors('test-model');
  assert.strictEqual(back.length, 1);
  assert.ok(Math.abs(cosine(v, back[0].vec) - 1) < 1e-6, '取回的向量应与存入的同向');
});
ok('换模型 = 旧向量不参与(向量空间不可比)', () => {
  assert.strictEqual(g.store.allVectors('another-model').length, 0);
});
ok('待补清单认得出"没算过"的节点', () => {
  const row0 = g.store.db.get('SELECT title, description, body FROM nodes WHERE id = ?', ['n_alpha']);
  g.store.putVector('n_alpha', { dim: 4, vec: normalize([0.1, 0.2, 0.3, 0.4]), model: 'test-model',
                                 srcHash: contentHash(row0.title, row0.description, row0.body) });
  const p = g.store.pendingEmbed('test-model');
  assert.ok(p.some((x) => x.id === 'n_beta'), 'n_beta 从没算过, 应在待补清单里');
  assert.ok(!p.some((x) => x.id === 'n_alpha'), 'n_alpha 刚存过且内容没变, 不该重算');
});
ok('正文改了 → 旧向量作废, 重新进待补清单', () => {
  const row = g.store.db.get('SELECT title, description, body FROM nodes WHERE id = ?', ['n_alpha']);
  g.store.putVector('n_alpha', { dim: 4, vec: normalize([1, 0, 0, 0]), model: 'test-model',
                                 srcHash: contentHash(row.title, row.description, row.body) });
  assert.ok(!g.store.pendingEmbed('test-model').some((x) => x.id === 'n_alpha'), '指纹对上时不该重算');
  w('n_alpha.md', `---\nname: 甲\ndescription: "关于向量检索的说明"\nmetadata:\n  type: reference\n---\n正文已经改了。\n`);
  g._fresh();
  assert.ok(g.store.pendingEmbed('test-model').some((x) => x.id === 'n_alpha'), '正文变了必须重算');
});
ok('删节点连带删向量(否则语义会召回已不存在的记忆)', () => {
  fs.unlinkSync(path.join(tmp, 'n_alpha.md'));
  g._fresh();
  assert.strictEqual(g.store.allVectors('test-model').length, 0);
});

console.log('\n[5] 融合规则: 置信度加权 RRF (2026-08-13 换掉硬锁头)');
// 造一个可控的库: 12 条都含关键词 omega, 用 use_count 拉开关键词排名(hotness 参与打分),
// 于是 kw 排名 = w_0 > w_1 > ... > w_11。向量另给一套, 想让谁当语义第一就给谁 star。
const mkFuseLib = (tag, n = 12) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), tag));
  for (let i = 0; i < n; i++) {
    fs.writeFileSync(path.join(d, `w_${i}.md`),
      `---\nname: 节点${i}\ndescription: "含关键词 omega 的第${i}条"\nmetadata:\n  type: reference\n  use_count: ${(n - i) * 10}\n---\n正文\n`);
  }
  const gg = new MemoryGraph(d);
  gg.build();
  return { d, gg };
};
// 背景向量彼此雷同(互相之间没有区分度), 指定的那条给 star = 与查询同向。
const setVecs = (gg, n, starId) => {
  const star = normalize([0, 1, 0, 0]);
  for (let i = 0; i < n; i++) {
    gg.store.putVector(`w_${i}`, { dim: 4, vec: normalize([1, 0.02 + i * 0.001, 0, 0]), model: gg.embedModel, srcHash: 'x' });
  }
  if (starId) gg.store.putVector(starId, { dim: 4, vec: star, model: gg.embedModel, srcHash: 'x' });
  gg._vecCache = null;
  gg._pendingQueryVec = star;
  return star;
};
// 尖头夹具: w_0 命中查询里全部 3 个词, 其余只命中 omega → 分数 34.1 vs 10.4, ratio3/1≈0.31。
// mkFuseLib 那套 use_count 梯度只能拉开 10.5 与 10.4(ratio≈0.99), 那是【平头】, 不是尖头 ——
// 想验"关键词有把握"这一支必须靠相关性差, 靠热度差是不够的。
const mkPeakedLib = (tag) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), tag));
  fs.writeFileSync(path.join(d, 'w_0.md'),
    '---\nname: alpha beta omega\ndescription: "omega alpha beta 全都有"\nmetadata:\n  type: reference\n  use_count: 10\n---\n正文\n');
  for (let i = 1; i < 12; i++) {
    fs.writeFileSync(path.join(d, `w_${i}.md`),
      `---\nname: 节点${i}\ndescription: "只含 omega 的第${i}条"\nmetadata:\n  type: reference\n  use_count: ${(12 - i) * 10}\n---\n正文\n`);
  }
  const gg = new MemoryGraph(d);
  gg.build();
  return { d, gg };
};
ok('关键词头部尖(它分得出高下)时, 语义动不了第一名', () => {
  const { d, gg } = mkPeakedLib('memfuse1a-');
  const kw = gg.query('omega alpha beta', { k: 8, semantic: false }).map((x) => x.id);
  assert.strictEqual(kw[0], 'w_0', '前提: 关键词把 w_0 排第一且远高于其余');
  setVecs(gg, 12, 'w_9');   // 语义第一名是关键词排得很后的那条
  const r = gg.query('omega alpha beta', { k: 8 }).map((x) => x.id);
  assert.strictEqual(r[0], 'w_0', '关键词有把握时头名不许被语义顶掉');
  gg.store.close(); fs.rmSync(d, { recursive: true, force: true });
});
ok('关键词头部平(它自己也在猜)时, 语义拿得到话语权', () => {
  const { d, gg } = mkFuseLib('memfuse1b-');
  const kw = gg.query('omega', { k: 8, semantic: false }).map((x) => x.id);
  assert.ok(!kw.slice(0, 3).includes('w_9'), '前提: w_9 本不在关键词前 3');
  setVecs(gg, 12, 'w_9');
  const r = gg.query('omega', { k: 8 }).map((x) => x.id);
  assert.ok(r.slice(0, 3).includes('w_9'),
    '头部平 = 关键词分不出高下, 此时必须让语义重排, 否则英语那类查询永远救不回来');
  gg.store.close(); fs.rmSync(d, { recursive: true, force: true });
});
ok('两路都认的条目会升上来 —— 关键词 top-8 之外也捞得回(旧机制正是在这里丢东西)', () => {
  const { d, gg } = mkFuseLib('memfuse2-');
  const kw = gg.query('omega', { k: 8, semantic: false }).map((x) => x.id);
  assert.ok(!kw.includes('w_9'), '前提: w_9 本来不在关键词 top-8 里');
  setVecs(gg, 12, 'w_9');
  const r = gg.query('omega', { k: 8 });
  assert.ok(r.some((x) => x.id === 'w_9'), '语义排 #1 + 关键词排 #10 的条目必须进 top-8');
  assert.strictEqual(r.length, 8, '总数仍是 k');
  assert.strictEqual(new Set(r.map((x) => x.id)).size, 8, '不许出现重复条目');
  gg.store.close(); fs.rmSync(d, { recursive: true, force: true });
});
ok('分布没有展开时照样正常出结果(旧的显著性门槛已删)', () => {
  const { d, gg } = mkFuseLib('memfuse3-', 5);
  // 5 条向量完全相同 = 谁都不比谁突出。旧机制在这里整体拒绝语义; 现在 RRF 不需要门槛,
  // 语义排名平铺, 关键词排名说了算 —— 结果应与纯关键词一致, 而不是报错或乱序。
  const v = normalize([1, 0, 0, 0]);
  for (let i = 0; i < 5; i++) gg.store.putVector(`w_${i}`, { dim: 4, vec: v, model: gg.embedModel, srcHash: 'x' });
  gg._vecCache = null;
  gg._pendingQueryVec = v;
  const kw = gg.query('omega', { k: 3, semantic: false }).map((x) => x.id);
  const r = gg.query('omega', { k: 3 }).map((x) => x.id);
  assert.strictEqual(r.length, 3);
  assert.deepStrictEqual(r, kw, '两路排名一致时结果就该等于关键词排名');
  gg.store.close(); fs.rmSync(d, { recursive: true, force: true });
});
ok('关键词一条都不命中时, 语义单路顶上', () => {
  const { d, gg } = mkFuseLib('memfuse4-');
  assert.strictEqual(gg.query('qqqzzz', { k: 8, semantic: false }).length, 0, '前提: 这个词关键词搜不到');
  setVecs(gg, 12, 'w_4');
  const r = gg.query('qqqzzz', { k: 3 });
  assert.strictEqual(r[0].id, 'w_4', '语义第一名该排第一');
  assert.ok(r[0].via.includes('语义'), 'via 要标明来自语义, 实际: ' + r[0].via);
  assert.ok(r[0].score > 0.5 && r[0].score <= 1, '展示分该是真实相似度而不是内部压制值, 实际 ' + r[0].score);
  gg.store.close(); fs.rmSync(d, { recursive: true, force: true });
});
ok('没有查询向量 = 结果与纯关键词逐条一致(降级路径不需要开关保护)', () => {
  const { d, gg } = mkFuseLib('memfuse5-');
  setVecs(gg, 12, 'w_9');
  gg._pendingQueryVec = null;
  assert.deepStrictEqual(gg.query('omega', { k: 8 }).map((x) => x.id),
                         gg.query('omega', { k: 8, semantic: false }).map((x) => x.id));
  gg.store.close(); fs.rmSync(d, { recursive: true, force: true });
});
ok('向量还在但节点已删的, 不许被召回', () => {
  const { d, gg } = mkFuseLib('memfuse6-');
  setVecs(gg, 12, 'w_9');
  fs.unlinkSync(path.join(d, 'w_9.md'));
  gg._fresh();
  gg._pendingQueryVec = normalize([0, 1, 0, 0]);
  assert.ok(!gg.query('omega', { k: 8 }).some((x) => x.id === 'w_9'));
  gg.store.close(); fs.rmSync(d, { recursive: true, force: true });
});
ok('没有语义可掺时不碰全表 LIKE(正文兜底不许被拖进热路径)', () => {
  const { d, gg } = mkFuseLib('memfuse7-');
  let called = 0;
  const orig = gg._bodyHitIds.bind(gg);
  gg._bodyHitIds = (...a) => { called++; return orig(...a); };
  gg.query('omega', { k: 8 });   // 关键词就能凑满 k 条, 且没有查询向量
  assert.strictEqual(called, 0, '关键词凑满且无语义时, 不该去库里做全表 LIKE');
  gg.store.close(); fs.rmSync(d, { recursive: true, force: true });
});
ok('没有 embedder 时静默降级, 不抛错', () => {
  const g4 = new MemoryGraph(tmp);
  assert.strictEqual(g4.hasEmbedder(), false);
  assert.doesNotThrow(() => g4.query('任意'));
  g4.store.close();
});
ok('旧的显著性门槛不许回潮', () => {
  const m = require('./kernel-src').engineSource('memory');
  assert.ok(!/SEMANTIC_MIN_Z|_semanticHits/.test(m),
    '2026-08-13 已实测: 那个 2.8 是照中文分布标的, 在英语库上挡掉 8 条真命中里的 7 条');
  assert.ok(/const RRF_C = 10/.test(m) && /const SEM_WEIGHT_GAIN = 0\.8/.test(m),
    '两个参数是在中英两个规模上标出来的, 要改先重跑 scripts/lab-dump.js + lab-sweep2.js');
  assert.ok(!/SEM_LOCK_HEAD/.test(m),
    '硬锁头已于 2026-08-13 换成置信度软权重: 锁头在中文零退步, 但把英语的 top3/top1 收益一起锁没了');
});

console.log('\n[6] 模型配置一致性');
ok('memory.js 与 core/embed/model.js 认的是同一个模型', () => {
  assert.strictEqual(EMBED_MODEL, require('../core/embed/model').MODEL_ID,
    '两处模型名必须一致, 否则下载的和检索用的对不上, 且失败方式是"永远 0 条向量"');
});
ok('vendor 产物齐全(缺了会打出装上就初始化失败的包)', () => {
  for (const [, dst] of require('../scripts/vendor-embed').FILES) {
    const p = path.join(__dirname, '..', 'core', 'embed', 'vendor', dst);
    assert.ok(fs.existsSync(p), `缺 core/embed/vendor/${dst} — 先跑 node scripts/vendor-embed.js`);
  }
});
ok('推理子进程源码不住在可再生的 vendor 目录里', () => {
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'core', 'embed', 'embed-worker.js')));
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'core', 'embed', 'vendor', 'embed-worker.js')),
    'vendor/ 是打包时重新生成的产物目录, 源码放里面会被清掉');
});
ok('协议注册早于 app ready(Electron 硬时序)', () => {
  const m = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const reg = m.indexOf('registerScheme(');
  const ready = m.indexOf('app.whenReady()');
  assert.ok(reg > 0 && ready > 0, '两处都该存在');
    assert.ok(reg < ready, 'registerScheme 必须在 app.whenReady 之前, 否则协议静默失效');
});

// 2026-08-13 真机测出的洞: 补齐一次之后, 新沉的记忆永远没有向量且不报错 ——
// 语义覆盖率随使用逐日下降, 表现成"这功能越来越不准", 没人查得出原因。
console.log('\n[6.4] 检索掺不掺语义: 默认开, 但真正的准入关口是"有没有向量"');
okAsync('没补过向量的库不算查询向量(白等一次推理), 补过之后才算', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'memfus-'));
  fs.writeFileSync(path.join(d, 'a.md'), '---\nname: a\ndescription: 甲\n---\n正文');
  const gg = new MemoryGraph(d);
  gg.rebuild();
  let called = 0;
  gg.setEmbedder(async (t) => { called++; return t.map(() => normalize(Float32Array.from({ length: 384 }, (_, i) => (i % 7) + 1))); });
  assert.strictEqual(gg.semanticFusionOn(), true, '默认必须是开');
  return gg.prepareSemantic('随便问一句').then((release) => {
    assert.strictEqual(called, 0, '库里没有向量时不该去算查询向量');
    assert.strictEqual(typeof release, 'function', '仍要返回可调用的归还函数');
    release();
    gg.markSemanticOptIn();
    return gg.prepareSemantic('随便问一句').then((r2) => {
      assert.strictEqual(called, 1, '点过头之后才算查询向量');
      r2();
      gg.setSemanticFusion(false);   // 逃生口: 手动关掉就该立刻回到纯关键词
      return gg.prepareSemantic('随便问一句').then((r3) => {
        assert.strictEqual(called, 1, '手动关掉后不该再算');
        r3();
        gg.store.close(); fs.rmSync(d, { recursive: true, force: true });
      });
    });
  });
});
ok('向量标签带文本配方 —— 换配方旧向量自动作废', () => {
  const { VECTOR_TAG, EMBED_MODEL } = require('../core/memory');
  assert.ok(VECTOR_TAG.startsWith(EMBED_MODEL + '#'), '标签 = 模型名 + 配方');
  const m = require('./kernel-src').readSrc('memory.js');
  assert.ok(!/passage: \$\{r\.title[^`]*body/.test(m), '正文不再喂进向量(长正文会造出"万能吸铁石"节点)');
});

console.log('\n[6.5] 增量向量: 没开闸的图一动不动, 开过闸的必须引擎自己跟上');
const mkGraph = (tag) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), tag));
  fs.writeFileSync(path.join(d, 'a.md'), '---\nname: a\ndescription: 甲\n---\n甲的正文');
  const gg = new MemoryGraph(d);
  gg.rebuild();
  return { d, gg };
};
ok('没开闸的库: 写入不启动补算(模型还没到位, 推理必然白转一场)', () => {
  const { d, gg } = mkGraph('memopt1-');
  let called = 0;
  gg.setEmbedder(async (texts) => { called++; return texts.map(() => new Float32Array(384).fill(0.1)); });
  assert.strictEqual(gg.semanticOptedIn(), false, '全新库不该算作已开启');
  gg.kickEmbed();
  assert.strictEqual(called, 0, '未开闸时 kickEmbed 必须什么都不做');
  gg.store.close(); fs.rmSync(d, { recursive: true, force: true });
});
okAsync('开闸之后: 写入会把新节点的向量补上', () => {
  const { d, gg } = mkGraph('memopt2-');
  gg.setEmbedder(async (texts) => texts.map(() => normalize(Float32Array.from({ length: 384 }, (_, i) => (i % 7) + 1))));
  gg.markSemanticOptIn();
  assert.strictEqual(gg.semanticOptedIn(), true);
  return gg.embedPending({}).then(() => {
    const before = gg.embedStats().embedded;
    assert.ok(before > 0, '补齐后应有向量');
    gg.upsert({ id: 'b', description: '乙', body: '乙的正文' });   // 引擎内部自己 kickEmbed
    return new Promise((r) => setTimeout(r, 500)).then(() => {
      const s = gg.embedStats();
      assert.strictEqual(s.pending, 0, `新节点应被自动补上向量, 实际还欠 ${s.pending}`);
      gg.store.close(); fs.rmSync(d, { recursive: true, force: true });
    });
  });
});
// 🔴 上面那条测的是 v1, 而产品跑的是 v2 —— v2 的 upsert 漏挂 kickEmbed 整整一版都没被照出来,
// 因为这个文件里所有行为测试用的都是 v1 的 MemoryGraph。这条专盯 v2。
okAsync('v2 引擎: 写入同样自动补向量, 且 setEmbedder 会把模型标签落库', () => {
  const { MemoryGraphV2 } = require('../core/memory-v2');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'memoptv2-'));
  const gg = new MemoryGraphV2(d);
  gg.ensureReady();
  gg.setEmbedder(async (texts) => texts.map(() => normalize(Float32Array.from({ length: 384 }, (_, i) => (i % 7) + 1))));
  assert.ok(gg.embedModel, 'setEmbedder 之后模型标签必须落库, 否则 embedStats 对外报"模型 (未装)"');
  gg.markSemanticOptIn();
  gg.upsert({ slug: 'a1', type: 'reference', claim: '命题: 甲成立', body: '甲的正文' });
  return gg.embedPending({}).then(() => {
    assert.ok(gg.embedStats().embedded > 0, '补齐后应有向量');
    gg.upsert({ slug: 'b1', type: 'reference', claim: '命题: 乙成立', body: '乙的正文' });   // v2 引擎内部自己 kickEmbed
    return new Promise((r) => setTimeout(r, 500)).then(() => {
      const s = gg.embedStats();
      assert.strictEqual(s.pending, 0, `v2 新节点应被自动补上向量, 实际还欠 ${s.pending}`);
      gg.store.close(); fs.rmSync(d, { recursive: true, force: true });
    });
  });
});
okAsync('本标记之前就补齐过的老库不会被误判成"没开过"', () => {
  const { d, gg } = mkGraph('memopt3-');
  gg.setEmbedder(async (texts) => texts.map(() => normalize(Float32Array.from({ length: 384 }, (_, i) => i + 1))));
  return gg.embedPending({}).then(() => {
    gg.store.setMeta('semantic_optin', '');   // 模拟老库: 有向量但没有本次新增的标记
    assert.strictEqual(gg.semanticOptedIn(), true, '库里已有向量就该算作已开启');
    gg.store.close(); fs.rmSync(d, { recursive: true, force: true });
  });
});
okAsync('补算在飞的时候又写一条, 那条也不会被漏下', () => {
  const { d, gg } = mkGraph('memopt4-');
  gg.setEmbedder(async (t) => {
    await new Promise((r) => setTimeout(r, 120));
    return t.map(() => normalize(Float32Array.from({ length: 384 }, (_, i) => (i % 7) + 1)));
  });
  gg.markSemanticOptIn();
  return gg.embedPending({}).then(() => {
    gg.upsert({ id: 'b', description: '乙', body: '乙正文' });
    return new Promise((r) => setTimeout(r, 20)).then(() => {
      gg.upsert({ id: 'c', description: '丙', body: '丙正文' });   // 上一轮补算还没跑完
      return new Promise((r) => setTimeout(r, 1200)).then(() => {
        const s = gg.embedStats();
        assert.strictEqual(s.pending, 0, `写入撞上补算不该漏, 实际还欠 ${s.pending}`);
        gg.store.close(); fs.rmSync(d, { recursive: true, force: true });
      });
    });
  });
});
ok('补算挂在引擎的写入点上, 不指望调用方记得调', () => {
  // 引擎已拆包, 只读主壳会数到 0 —— 主壳连同它拆出的目录一起读, 才是"整个引擎"。
  const { engineSource } = require('./kernel-src');
  const m = engineSource('memory');
  assert.strictEqual((m.match(/this\.kickEmbed\(\)/g) || []).length, 2,
    'upsert 与 append 两个真写入点各挂一次');
  // 🔴 v2 才是真正在跑的引擎。这条断言原先只读 v1, 于是 v2 漏挂了整整一版都照常绿 ——
  // 守卫指着一个已经不服役的文件, 比没有守卫更坏, 因为它让人以为守住了。
  const m2 = engineSource('memory-v2');
  assert.strictEqual((m2.match(/this\.kickEmbed\(\)/g) || []).length, 2,
    'v2 的 upsert 与 write 两个真写入点也各挂一次');
  const a = require('./kernel-src').kernelSource();
  assert.ok(a.includes('markSemanticOptIn()'), 'backfill 必须记下这张图已开闸');
});

console.log('\n[6.6] 模型首启自动装(默认开: 不问用户、不看语言占比)');
const me = require('../core/embed/model');
// 替身是模块级的, 所以这几条必须排队跑 —— okAsync 是并发发车, 不排队就会互相把替身撤掉
// (第一版就栽在这里: 三条同时在飞, 谁先结束谁就把 detect 换回真的, 另外两条当场看见"模型已装")。
let stubChain = Promise.resolve();
const withStubInstall = (impl, fn) => {
  const run = stubChain.then(() => {
    const realInstall = me.install, realDetect = me.detect;
    me.install = impl;
    me.detect = () => ({ ok: false, dir: '/tmp/x', root: '/tmp', missing: ['onnx/model_quantized.onnx'], modelId: me.MODEL_ID });
    return Promise.resolve().then(fn).finally(() => { me.install = realInstall; me.detect = realDetect; });
  });
  stubChain = run.catch(() => {});
  return run;
};
okAsync('并发调用只下载一次(每个人格都会调, 模型却只有全应用一份)', () => {
  let calls = 0;
  return withStubInstall(async () => { calls++; await new Promise((r) => setTimeout(r, 60)); return { ok: true, dir: '/tmp/x' }; },
    () => Promise.all([me.ensureInstalled(), me.ensureInstalled(), me.ensureInstalled()])
      .then((rs) => {
        assert.strictEqual(calls, 1, `三路并发只该真下一次, 实际 ${calls} 次`);
        assert.ok(rs.every((r) => r.ok), '三路都该拿到同一个成功结果');
      }));
});
okAsync('下载失败要静默降级, 不能把异常抛给启动流程', () => {
  return withStubInstall(async () => { throw new Error('网络不通'); },
    () => me.ensureInstalled().then((r) => {
      assert.strictEqual(r.ok, false, '失败要以 {ok:false} 返回');
      assert.ok(/网络不通/.test(r.error), '失败原因要留下来, 否则查不出为什么没装上');
    }));
});
okAsync('失败之后不许把自己焊死: 下一次还能再试', () => {
  let calls = 0;
  return withStubInstall(async () => { calls++; if (calls === 1) throw new Error('第一次失败'); return { ok: true, dir: '/tmp/x' }; },
    () => me.ensureInstalled()
      .then((r1) => { assert.strictEqual(r1.ok, false); return me.ensureInstalled(); })
      .then((r2) => assert.strictEqual(r2.ok, true, '单飞的锁必须在失败后释放')));
});
ok('app 启动真的会去装, 且排在开窗之后(补向量的推理在渲染进程)', () => {
  const m = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  assert.ok(/function kickSemanticModel/.test(m), 'main.js 必须有首启自动装那一步');
  // 判顺序, 不判字面相邻。原来写死的是 'createWindow();\n    kickSemanticModel();' 两行挨着,
  // bd87fb7 在中间插了一句 startupDone=true 就判红了 —— 顺序没变、意图没破, 纯粹是断言比它
  // 要守的东西更严。要守的只有一条: 开窗在前(补向量的推理跑在渲染进程, 没窗就没得推)。
  const iWin = m.indexOf('createWindow();');
  const iKick = m.indexOf('kickSemanticModel();', iWin);
  assert.ok(iWin > 0 && iKick > iWin, 'kickSemanticModel 必须排在 createWindow() 之后');
  assert.ok(/ensureInstalled\(\)/.test(m), '要走单飞的 ensureInstalled, 不是裸 install');
});
ok('装不上不能就此撂下: 退避重试到装上为止, 且退避有封顶', () => {
  const m = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const arr = /const SEM_RETRY_MS = \[([^\]]+)\]/.exec(m);
  assert.ok(arr, '重试间隔要写成一张明表, 别散在代码里');
  const steps = arr[1].split(',').map((s) => Number(eval(s.trim())));   // eslint-disable-line no-eval
  assert.ok(steps.length >= 3, `退避要有几档, 实际 ${steps.length} 档`);
  assert.ok(steps.every((v, i) => i === 0 || v > steps[i - 1]), '必须是递增退避, 不能定频猛敲人家服务器');
  assert.ok(steps[steps.length - 1] <= 60 * 60e3, '封顶不该超过 1 小时, 否则网通了也要等太久');
  assert.ok(/setTimeout\(\(\) => kickSemanticModel\(attempt \+ 1\), wait\)/.test(m),
    '失败分支必须把自己重新排期(这正是 2026-08-13 作者纠的那条: 失败了不能默默不管)');
});
ok('重试要能真正接上, 靠的是下载器不丢半成品', () => {
  const v = fs.readFileSync(path.join(__dirname, '..', 'core', 'voice-stt.js'), 'utf8');
  assert.ok(/headers\.Range = `bytes=\$\{have\}-`/.test(v), '有半成品时要带 Range 续下');
  const tail = v.slice(v.indexOf('} catch (e) {', v.indexOf('async function download')));
  assert.ok(!/unlinkSync\(part\)/.test(tail.slice(0, 400)),
    '下载出错时不许删半成品 —— 删了就等于每次重试都从头下 118MB');
});
ok('模型已在本机时, 新开的人格自己就开闸(否则它永远停在没向量且不报错)', () => {
  const a = require('./kernel-src').kernelSource();
  // 向量算子改成宿主注入(core 不认识 Electron), 所以这里认的是注入面而不是具体实现文件。
  assert.ok(/embedder\.detect\(\)\.ok\) this\.memory\.markSemanticOptIn\(\)/.test(a),
    'Agent 启动时要按"模型在不在"决定开闸');
});

g.store.close();
fs.rmSync(tmp, { recursive: true, force: true });

// —— [B] 真 electron 闭环 ——
// 只在模型已下载时跑; 没下载就跳过并明说(而不是当成通过 —— 静默跳过等于假绿)。
console.log('\n[7] 真 Electron 推理闭环');
const embedReady = require('../core/embed/model').detect().ok;
if (!embedReady) {
  console.log('  ⊘ 跳过: 语义模型未下载 (node -e "require(\'../core/embed/model\').install(console.log)")');
} else if (process.env.SKIP_ELECTRON === '1') {
  console.log('  ⊘ 跳过: SKIP_ELECTRON=1');
} else {
  const r = spawnSync(require('electron'), [path.join(__dirname, '..', 'scripts', 'embed-probe.js')],
    { encoding: 'utf8', timeout: 180000, env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' } });
  const out = (r.stdout || '') + (r.stderr || '');
  const line = out.split('\n').find((l) => l.startsWith('PROBE:'));
  ok('electron 里能真跑出向量', () => {
    assert.ok(line, '探针无输出。完整输出:\n' + out.slice(-1500));
    const j = JSON.parse(line.slice(6));
    assert.ok(j.ok, '探针报错: ' + j.error);
    assert.strictEqual(j.dim, 384, '维度应为 384');
    assert.ok(j.selfSim > 0.99, '同一句话两次编码应几乎相同, 实际 ' + j.selfSim);
    // 语义的价值判据: 用词完全不同但意思相同的两句, 相似度必须高于毫不相干的两句。
    assert.ok(j.related > j.unrelated + 0.05,
      `近义句(${j.related}) 应明显高于无关句(${j.unrelated})`);
  });
}

Promise.all(asyncRuns).then(() => {
  console.log(`\n结果: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
});
