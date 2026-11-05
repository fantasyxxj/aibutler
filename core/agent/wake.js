// 唤醒正文拼装 + 配记忆(强制召回 / 知识碎片 / 插件提示 / 沉淀提醒)
// 由 agent.js 拆出(内核抽包第 1 步)。方法体逐字搬运, 经 util.mixin 挂回 Butler.prototype。
const path = require('path');
const fs = require('fs');
const { paths } = require('../host');
const registry = require('../registry');
const { cfg } = require('../host');
const capUpdate = require('../capability-update');
const factory = require('../factory-sync');
const workflow = require('../workflow');
const { HAS_EXTERNAL_TEXT, WAKE_MEMORY_INDEX_MAX_BYTES } = require('./util');
// 注入的松紧值与 token 估算都从记忆引擎那边取: 标定值只此一份真源, 别在大脑侧再抄一套。
const lang = require('../memory-v2/lang');
const { tune } = require('../memory-v2/tuning');
const { estTokens } = require('../memory-v2/consts');

class WakeMixin {
// 记忆心法曾经在这里以 UNIVERSAL_RULES 的形式每次苏醒硬装进唤醒正文(v5 分层注入)。
// 2026-08-17 撤除: 心法已随出厂知识包进人格自己的记忆库, 代码再塞一份就是第二副本 + 每次苏醒常驻开销。
// 现在走触发式 —— wake/preamble.md 那句"第一个动作是 memory_hot"负责把人格引到库里去查。别再加回来。

  // 动态记忆提醒 (2026-08-06 作者派单: "总有人忘记保存记忆")。
  // 静态铁律写在 systemPrompt 里会漂 —— 注意力被任务占满时, 常驻文本不会自己触发工具调用。
  // 这里换成"带当下事实的动态提醒": 本回合用户话里有纠正/定案/事故特征, 而你一个 memory_* 都没调 → 下一轮当面点出来。
  // 注: systemPrompt 在持久流创建那刻定死(agent.js query 构造), 中途改不了 → 只能 prepend 进下一条消息正文。
  _evalMemoryNudge() {
    if (!this._turnUserText) return;            // auto 回合(心跳/唤醒/出生教育/沉淀)不判, 也不计数
    // 差し戻されたまま書き直されなかった保存 → 次の回合で名指しして保存させ、「記録した」と言っていたら訂正させる。
    const un = this._turnUnsaved;
    if (un && un.seq === this._turnSeq && un.ids.size) this._memoryNudgeUnsaved = [...un.ids.entries()];
    // 🔴 两个判据不是同一个数: 情绪词那格问「连查都没查吗」(_turnMemoryOps), 连续零沉这格问
    // 「到底存没存」(_turnMemoryWrites)。混用后者会放跑"用户说了记住却只 query 一下"的场合,
    // 混用前者则让连续计数永远数不到 1 —— 查记忆是每轮必做的动作。
    if (this._turnMemoryWrites > 0) this._turnsSinceMemoryOp = 0;
    else this._turnsSinceMemoryOp++;
    try {
      const c = cfg.json('main/memory_nudge');
      // 情绪词那格维持原样: 只要碰过记忆(哪怕只是查一下)就不啰嗦。
      if (this._turnMemoryOps === 0) {
        const hit = (c.patterns || []).find((p) => this._turnUserText.includes(p));
        if (hit) { this._memoryNudge = hit; return; }
      }
      // 第三格: 平静的技术讨论。没有情绪词所以撞不上 patterns, 没查网所以够不着 force_sediment,
      // 于是讨论了一整程、定了好几件事, 一条提醒都不会有 —— 这里按"连续几轮一条都没写进库"补上。
      const th = Number(c.streak_threshold) || 0;
      if (c.streak_enabled !== false && th > 0 && this._turnsSinceMemoryOp >= th) {
        this._memoryNudgeStreak = this._turnsSinceMemoryOp;
      }
    } catch (e) { console.error(`[nudge] ${this.name} 判定失败: ${e && e.message}`); }
  }

  // 原话流水: 一字不改落库。v1 引擎没这张表 → 软判断跳过, 不炸。
  // 🔴 底片绝不能因为记账失败而挡住对话, 所以整段吞异常(只留声)。
  _logUtterance(role, text, source) {
    if (typeof text !== 'string' || !text.trim()) return;
    if (typeof this.memory.addUtterance !== 'function') return;
    try { this.memory.addUtterance({ role, text, source }); }
    catch (e) { console.error(`[utterance] ${this.name} 落库失败(不挡对话):`, e && e.message); }
  }

  // 每轮拿用户原话查一次, 但**结果一个字都不进上下文** —— 只写 recall_log。
  //
  // 🔴 为什么查了不给 AI 看: 按字面撞出来的命中, 和它自己会主动去查的场合完全重叠 —— 字面一撞,
  // 它本来就想得到要查; 而真正想不到查的场合(要用的知识跟话题字面不沾边)也照样撞不上。
  // 有用时冗余, 不冗余时没用。代价却是实的: 用户说"不做插件了", 插件那几条会以满分召回 ——
  // 语义相似度衡量的是"像不像"不是"该不该用", 越是明确的拒绝匹配得越准。调门槛救不了,
  // 关键字认否定也救不了(中文否定花样太多, 还会误伤"不做X的话怎么办"这种其实还要谈 X 的句子)。
  //
  // 🔴 那为什么还查: 留一把尺子。AI 自觉查的失败是静默的 —— 它不会说"我本来记得这事但没想起来查",
  // 而是直接凭印象答了, 没人发现。有这条流水才能事后比对"库里明明有高分命中, 而这轮一次
  // memory_query 都没调"。不给看 ≠ 不用查, 否则是拿一种静默失败换回另一种。
  //
  // 🔴 只在真人回合查。心跳/唤醒/沉淀/出生教育那些 auto 轮拿去检索捞回来的是噪音,
  // 而且它们本来就不缺上下文(唤醒有起床清单, 沉淀有刚说完的话)。
  // 异步壳: **只**负责"要不要先把查询向量算出来"。打分、分档、注入的全部判断留在下面那个
  // 同步的 _auditRecall 里 —— 这样门禁在没有 embedder 的纯 node 环境下仍能测到全部注入逻辑,
  // 不必为了一次 wasm 推理把整套断言改成异步。
  //
  // 语义通道由 forced_recall.semantic 控制。关着时这里一步 await 都不多走, 逐位退回原来的
  // 纯字面行为。开着才付那次推理 —— 它买的是【跨语言】: 用户语言与库语言不同时字面通道是
  // 零命中(不是"差一点"), 语义是唯一能撞上的那条腿。
  async _auditRecallAsync(text, sourceKind, isHeartbeat) {
    let c = null;
    try { c = cfg.json('main/forced_recall'); } catch (_) {}
    const eligible = HAS_EXTERNAL_TEXT(sourceKind) && !isHeartbeat
      && typeof text === 'string' && !!text.trim()
      && typeof this.memory.prepareSemantic === 'function';
    if (!(c && c.semantic === true && eligible)) return this._auditRecall(text, sourceKind, isHeartbeat, false);
    let release = () => {};
    const t0 = Date.now();
    // 算不出向量就静默降级成纯字面 —— 语义是增强不是前置条件, 缺了不该让召回整个失败。
    try { release = await this.memory.prepareSemantic(text, { semantic: true }); } catch (_) { release = () => {}; }
    try {
      const out = this._auditRecall(text, sourceKind, isHeartbeat, true);
      // 每轮首字延迟上的开销必须留痕, 否则"是不是变慢了"只能靠感觉吵。
      console.log(`[recall-cost] ${this.name} 语义通道 ${Date.now() - t0}ms`);
      return out;
    } finally { release(); }
  }

  _auditRecall(text, sourceKind, isHeartbeat, useSem = false) {
    if (!HAS_EXTERNAL_TEXT(sourceKind) || isHeartbeat) return '';
    if (typeof text !== 'string' || !text.trim()) return '';
    if (typeof this.memory.query !== 'function') return '';
    let c;
    try { c = cfg.json('main/forced_recall'); } catch (e) { console.error('[recall] 配置读取失败:', e && e.message); return ''; }
    if (!c || c.enabled === false) return '';
    if (text.trim().length < (c.min_query_len || 4)) return '';
    try {
      // pinned 已整份常驻在系统提示里, 再召回一遍只是重复付钱。
      const rows = (this.memory.query(text, {
        k: c.k || 5, budget: c.budget_tokens || 400, semantic: useSem, kind: 'auto',
      }) || []).filter((r) => !r.pinned);
      // 原话什么都没对上时也说一句: 教过的规则多半是按事情的类别存的, 店主换个说法就撞不上,
      // 只有它自己换成类别词去查才找得回来(10-11 行业版实测: 没任何提示的轮次一次都没查)。
      const miss = () => (c.miss_line ? `${c.inject_heading || ''}${c.miss_line}\n\n` : '');
      if (!rows.length) return miss();
      // 🔴 门禁: 够不上高档的**一个字都不注入**。这不是省 token, 是"不相干的东西塞进上下文"
      // 比"没查到"更坏 —— 它会被当成依据用掉。tier 由 tierOf(confidence) 算, 与这里 log 的
      // 是同一个数(retrieval.js 同一处组装), 所以分档线直接用现成的 tier_hi, 不新造地板。
      const hi = rows.filter((r) => r.tier === 'high');
      // 中档只点名不给命题行: 名字带着具体条目, 比常驻的「先查」更咬得住; 错的看一眼名字就跳过。
      const hint = rows.filter((r) => r.tier === 'med' && r.confidence >= tune('recall_hint_floor'))
        .slice(0, tune('recall_hint_max')).map((r) => r.slug);
      const hintLine = hint.length && c.hint_line ? `${c.hint_line.replace('{slugs}', hint.join(', '))}\n` : '';
      console.log(`[recall-audit] ${this.name} 命中 ${rows.length} 条 top=${rows[0].confidence} 够高档 ${hi.length} 条 · 点名中档 ${hint.length} 条`);
      if (!hi.length && !hintLine) return miss();
      // 🔴 **只给主键 + 命题行, 不给正文**。给全文的话错的那条会被当事实用掉, 地板就得抬到
      // 0.85+ 才敢给, 而那个覆盖率极低 = 等于没注入; 只给命题行则要主动决定展不展开,
      // 错的扫一眼就跳过(约 20 token), 地板因此能压到 tier_hi 这一档。
      // 带主键的额外好处: 要展开时直接 memory_section(node=id) 精确取, 不用再查一次。
      const max = tune('recall_inject_max');
      const budget = tune('recall_inject_budget');
      const lines = [];
      let spent = 0;
      const dropped = [];
      for (const r of hi.slice(0, max)) {
        const line = `- #${r.id} ${r.slug}: ${r.claim}`;
        const cost = estTokens(line);
        if (spent + cost > budget) { dropped.push(`${r.slug}(${cost}tok)`); break; }
        lines.push(line);
        spent += cost;
      }
      // 🔴 命题行比预算还长的节点会一条都注不进去, 而 recall_log 照样记它命中 —— 静默到
      // 光看日志会以为人格收到了。丢弃必须留痕: 这行日志是"命题行写太长了"的唯一线索。
      if (dropped.length) console.log(`[recall-inject] ${this.name} 超预算丢弃 ${dropped.join(' ')} · 预算 ${budget}`);
      if (!lines.length && !hintLine) return miss();
      console.log(`[recall-inject] ${this.name} 注入 ${lines.length} 条 · 约 ${spent} token${hintLine ? ` · 点名 ${hint.join(' ')}` : ''}`);
      return `${c.inject_heading || ''}${lines.map((l) => `${l}\n`).join('')}${hintLine}\n`;
    } catch (e) {
      // 🔴 检索坏了绝不能挡住对话。与原话流水同一条原则: 附加能力的故障不该让主路不可用。
      console.error(`[recall] ${this.name} 检索审计失败(不挡对话):`, e && e.message);
    }
    return '';
  }

  // 6.2 常驻瘦身试点: 表单/画图的写法细则不再每轮常驻, 命中触发词才把整份附上来。
  //
  // 为什么"整份"而不是像强制检索那样按 token 预算截断: 这些是**照着抄的语法**, 截一半比不给更坏
  // (半份参数枚举会让人以为自己看全了)。所以这里按"片"给, 一轮最多两片。
  //
  // 保底腿: 常驻目录里留了"没附上就直说「把画图细则给我」", 那句话本身也是触发词 ——
  // 细则在 asar 里, 打包后我自己 Read 不到, 主动腿只能走代码侧。
  /* 片可以带前置条件。语音细则就是: 语音关着时整套 SSML 语法一个字都不该给 ——
     那时标签会被全部剥掉, 教了等于让 AI 去用一个它这台机器上使不出来的能力。
     不认识的门一律判关: 宁可少给一片, 不能把没验过的条件当通过。 */
  _shardGateOpen(s) {
    if (!s || !s.when) return true;
    if (s.when === 'voice_on') return !!(this.voice && this.voice.enabled);
    if (s.when === 'workflows_installed') {
      try { return ((workflow.summary() || []).length > 0); } catch (_) { return false; }
    }
    console.error(`[shard] ${this.name} 片 ${s.key} 的前置条件「${s.when}」不认识, 按关处理`);
    return false;
  }

  _takeKnowledgeShards(text, sourceKind, isHeartbeat) {
    if (!HAS_EXTERNAL_TEXT(sourceKind) || isHeartbeat) return '';
    if (typeof text !== 'string' || !text.trim()) return '';
    let c;
    try { c = cfg.json('main/knowledge_shards'); } catch (e) { console.error('[shard] 配置读取失败:', e && e.message); return ''; }
    if (!c || c.enabled === false) return '';
    const q = text.trim();
    if (q.length < (c.min_query_len || 2)) return '';
    try {
      const lower = q.toLowerCase();
      const hit = (c.shards || []).filter((s) => this._shardGateOpen(s)
        && (s.triggers || []).some((w) => lower.includes(String(w).toLowerCase())));
      if (!hit.length) return '';
      // 同一片这条流里给过就不再给 —— 它还在上文。记账同样挂在【流】的生命周期上(_teardownStream 清)。
      if (!this._shardSeen) this._shardSeen = new Set();
      const fresh = hit.filter((s) => !this._shardSeen.has(s.key)).slice(0, c.max_shards_per_turn || 2);
      if (!fresh.length) return '';
      let vars = null;
      const bodies = [];
      for (const s of fresh) {
        this._shardSeen.add(s.key);
        if (s.render) vars = vars || this._shardVars();
        bodies.push((s.render ? cfg.render('knowledge/' + s.key, vars) : cfg.text('knowledge/' + s.key)).trim());
      }
      console.log(`[shard] ${this.name} 注入能力细则 ${fresh.length} 片: ${fresh.map((s) => s.key).join(',')}`);
      return `${c.header}\n\n${bodies.join('\n\n')}\n\n${c.footer}\n\n`;
    } catch (e) {
      console.error(`[shard] ${this.name} 细则注入失败(不挡对话):`, e && e.message);
      return '';
    }
  }

  // 取出待注入的提醒(一次性)。只在真人回合注入 —— 别插进心跳/唤醒/沉淀那些 auto 轮。
  _takeMemoryNudge(sourceKind) {
    if (!HAS_EXTERNAL_TEXT(sourceKind)) return '';
    return this._vagueHeardNote() + this._takeMemoryNudgeInner();
  }

  // 相手の言葉に「うまく・大事に・何か」の類があれば、その回合の頭で「具体的に何を・いつ」を問わせる。
  // haiku は曖昧な規則を保存すらせず「心がけます」で終える(10-15 dev v7: 4 件中 3 件、upsert 0 回)ので、
  // 保存時の閂だけでは届かない。語表は保存閂と同じ main/memory_vague_claim.json の said。
  _vagueHeardNote() {
    const said = typeof this._turnUserText === 'string' ? this._turnUserText.toLowerCase() : '';
    if (!said) return '';
    try {
      const V = cfg.json('main/memory_vague_claim');
      const word = (V.said || []).find((w) => said.includes(w.toLowerCase()));
      if (word) return cfg.render('main/memory_vague_heard', { word }) + '\n\n';
      // 逆向き: 数字・引用のある言い切りに「念のため確認」を重ね、前の規則の語を混ぜる(10-15 dev v8)。
      return new RegExp(V.concrete).test(said) ? cfg.text('main/memory_clear_heard') + '\n\n' : '';
    } catch (_) { return ''; }
  }

  _takeMemoryNudgeInner() {
    const hit = this._memoryNudge;
    const streak = this._memoryNudgeStreak;
    const unsaved = this._memoryNudgeUnsaved;
    this._memoryNudge = null;
    this._memoryNudgeStreak = 0;
    this._memoryNudgeUnsaved = null;
    if (!hit && !streak && !unsaved) return '';
    try {
      const c = cfg.json('main/memory_nudge');
      if (unsaved) {
        console.log(`[nudge] ${this.name} 注入记忆提醒 (退回后没补存 ${unsaved.length} 条)`);
        const list = unsaved.map(([id, claim]) => `- ${id}: ${claim}`).join('\n');
        return String(c.unsaved_template || '').replace('{list}', list) + '\n\n';
      }
      if (hit) {
        console.log(`[nudge] ${this.name} 注入记忆提醒 (命中「${hit}」)`);
        return String(c.template || '').replace('{hit}', hit) + '\n\n';
      }
      // 送出去才清零 —— 否则下一轮计数仍在阈值上, 会每轮都发。
      this._turnsSinceMemoryOp = 0;
      console.log(`[nudge] ${this.name} 注入记忆提醒 (连续 ${streak} 轮一条没存)`);
      return String(c.streak_template || '').replace('{n}', String(streak)) + '\n\n';
    } catch (e) { console.error(`[nudge] ${this.name} 取模板失败: ${e && e.message}`); return ''; }
  }

  // 升级自检任务投递。装了新版本之后人格常常得对自己做点调整才算真跟上 —— 这一版是收拾
  // 快查表, 下一版可能是别的。返回这次派了几件(0 = 没什么要调整的)。
  //
  // 两个来源分工明确: 出厂包带的是"这版想让所有人格做的事"(改包不改代码); 引擎自检的是
  // "这个库现在的实际状态需要处理"(得先算一遍才知道要不要派, 条件只能写在代码里)。
  // 出厂知识同步 —— 冷启动就跑, 不等唤醒流程放行。
  // 🔴 它必须独立于 buildWakePayload: 那个函数由 main.js 三条件(全新人格/有未消费 ctx_last/
  // app 版本变了)决定调不调, 于是"改了出厂包但没动版本号"时同步根本没机会执行。2026-08-19
  // 解除版本绑定只改了同步器内部, 外面这道闸还锁着 —— 棒头收不到 15 条新知识就是这么来的。
  // 同步器幂等(没变的算 unchanged, 不写库不抬热度), 所以无条件跑一次是安全的。
  /* packs を明示的に受け取れるようにしてある: 行業版は **setOverlayPack より前に**
     ここを呼ぶ(boot.js は :279 で同期、:383 で注入)ので、既定値の this.overlayPacks に
     頼ると包の知識が毎回ゼロ件のまま素通りする —— しかもログは「未変 230」と出るだけで、
     何かが欠けたとは一言も言わない。実際 2026-08-31 にそれで一度取りこぼした。 */
  /* 热更新时用: 装机端定时拉到新版行业包后, 需要让 factory-sync 再跑一次把新记忆条目灌进去。
     直接 runFactorySync 会被下面那道"一次冷启动只跑一趟"的锁挡回来 —— 那锁是为冷启动服务的,
     不是给"店里正在营业, 平台推来了新知识"这条路准备的。所以显式解锁 + 重跑一次, 别悄悄改闸门。 */
  refreshFactoryFromPacks(packs) {
    this._factorySync = null;
    return this.runFactorySync(packs);
  }

  runFactorySync(packs = this.overlayPacks) {
    if (this._factorySync) return this._factorySync;                 // 一次冷启动只跑一趟
    const out = { stats: null, choreCount: 0 };
    if (typeof this.memory.setRedline !== 'function') return (this._factorySync = out);  // v1 引擎没有出厂节点表
    try {
      // 装着的行业包自己带的知识也从这里进库 —— 包想让 AI 知道的东西走记忆库, 不占常驻。
      out.stats = factory.syncFactory(this.memory,
        { name: this.name, isButler: this.isButler, packs });
      console.log(`[factory] ${this.name} 出厂同步: 新增 ${out.stats.created} · 更新 ${out.stats.updated}`
        + ` · 未变 ${out.stats.unchanged} · 归档 ${out.stats.archived}`
        + (out.stats.renamed ? ` · 改名 ${out.stats.renamed} (${out.stats.renamedSlugs.join(', ')})` : '')
        + (out.stats.skipped.length ? ` · 让位自生 ${out.stats.skipped.length}` : '')
        + (out.stats.reclaimed.length ? ` · 认领漏标 ${out.stats.reclaimed.length}` : ''));
      try { out.choreCount = this._enqueueUpgradeChores(out.stats, paths.appVersion()); }
      catch (e) { console.error(`[chores] ${this.name} 升级任务投递失败: ${e && e.message}`); }
    } catch (e) { console.error(`[factory] ${this.name} 出厂同步失败: ${e && e.message}`); }
    return (this._factorySync = out);
  }

  _enqueueUpgradeChores(fs2, version) {
    const st = this.memory && this.memory.store;
    if (!st || typeof st.enqueueChore !== 'function') return 0;
    const chores = factory.loadFactoryChores({ isButler: this.isButler, packs: this.overlayPacks })
      .map((c) => ({ ...c, version }));

    // 引擎自检 · 快查表超配额。判据是 audit.over 而不是"这次有没有条目被挡" —— 老库本来就
    // 超标的时候, 这一版恰好没带 pinned 类出厂条目就不派活, 等于永远轮不到收拾。
    try {
      const audit = typeof this.memory.pinnedAudit === 'function' ? this.memory.pinnedAudit() : null;
      if (audit && audit.over > 0) {
        const tpl = cfg.json('main/chores_builtin').pinned_over_quota;
        const blocked = (fs2 && fs2.pinnedBlocked) || [];
        const vars = {
          used: audit.used, quota: audit.quota, over: audit.over,
          blockedList: blocked.length
            ? blocked.map((b) => `- ${b.slug}${b.title ? ` — ${b.title}` : ''}`).join('\n')
            : '(none this time)',
        };
        chores.push({
          key: `pinned_over_quota@${version}`, version,
          title: cfg.fill(tpl.title, vars), detail: cfg.fill(tpl.detail, vars),
        });
      }
    } catch (e) { console.error(`[chores] ${this.name} pinned 自检失败: ${e && e.message}`); }

    // 引擎自检 · 命题卫生。**这一条必须是自检而不是出厂包里的静态清单**: 每个人格库里脏多少条
    // 完全不同(有的刚出生一条都没有), 静态文案没法写数字, 而"你有一些脏命题"这种说法没人会去动。
    // 判据取 datedHot 不取总数: 冷门节点的烂命题不影响检索, 把长尾算进来只会让人一看就放弃。
    try {
      const hy = typeof st.claimHygiene === 'function' ? st.claimHygiene() : null;
      if (hy && hy.datedHot > 0) {
        const tpl = cfg.json('main/chores_builtin').dirty_claims;
        const hot = this.memory.store.db.all(
          "SELECT slug, use_count FROM nodes WHERE status='active' AND use_count >= 5"
          + " AND claim GLOB '*20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' ORDER BY use_count DESC LIMIT 5");
        // 🔴 派的是**一小批(最多 5 条)**, 不是整个欠账。存量清洗的正路是"用到了顺手改 + 没用到的
        // 隔一段时间来一批"(v1→v2 迁移就是这么还的), 这条 chore 只负责教一次判据 + 带着做第一批。
        // 把 54 条甚至 738 条摆到眼前, 人格看一眼就放弃 —— 而做不动的清单会把整条轨道训成噪音。
        const batch = (hot || []).slice(0, 5);
        chores.push({
          key: `dirty_claims@${version}`, version,
          title: cfg.fill(tpl.title, { n: batch.length }),
          detail: cfg.fill(tpl.detail, {
            n: batch.length, hot: hy.datedHot, total: hy.dated, provisional: hy.provisional,
            sample: batch.map((r) => `- \`${r.slug}\`(用过 ${r.use_count} 次)`).join('\n'),
          }),
        });
      }
    } catch (e) { console.error(`[chores] ${this.name} 命题卫生自检失败: ${e && e.message}`); }

    let n = 0;
    for (const c of chores) { if (st.enqueueChore(c)) n += 1; }
    if (n) console.log(`[chores] ${this.name} 升级自检派了 ${n} 件`);
    return n;
  }

  // 唤醒引导加载器: 苏醒那刻由代码装唤醒消息正文。
  // 🔴 收录判据(2026-08-17 定案): 只装【这一刻才有、人格自己查不到】的东西 —— 关档前对话原话、交接便条、
  // 一次性事件(升级补课/迁移待办/冲突体检)、人格私有清单。凡是记忆库里查得到的(心法/pinned/热记忆),
  // 一律不装, 由 wake/preamble.md 的触发句引导人格自己去拉。往这里加段之前先过这一条。
  // v0.0.23 (2026-07-19): 最前面加"关档前 N 轮对话原话"节 · consumed_at 门防重复注入 · stale 48h 门防翻旧 ctx。
  buildWakePayload() {
    const parts = [];
    parts.push(cfg.text('wake/preamble').trim());
    // 关档前对话原话 (v0.0.23) · 放最前面: 语境比铁律/热记忆更紧急, 新我第一眼要接上"对方刚才说了啥"
    try {
      const ctxPath = path.join(this.memoryDir, 'ctx_last.json');
      if (fs.existsSync(ctxPath)) {
        const raw = JSON.parse(fs.readFileSync(ctxPath, 'utf8'));
        const CTX_STALE_MS = 48 * 3600 * 1000;   // 48h · 覆盖周末冷启动, 阻挡上上周旧 ctx
        const ageMs = Date.now() - (raw.captured_at || 0);
        if (raw.turns && raw.turns.length && ageMs < CTX_STALE_MS && !raw.consumed_at) {
          const ageLabel = ageMs < 60_000 ? '刚刚' : ageMs < 3600_000 ? `${Math.round(ageMs / 60000)} 分钟前` : `${Math.round(ageMs / 3600000)} 小时前`;
          const turnsBody = raw.turns.map((t) => {
            const who = t.role === 'user' ? '对方' : '我';
            // 本地日志给人看的时间戳用本地时区, 别用 toISOString()(那是 UTC, 时区敏感场景会把"几点"显示错)。作者 2026-08-15 钦定。
            const _d = t.ts ? new Date(t.ts) : null;
            const time = _d ? `${String(_d.getHours()).padStart(2, '0')}:${String(_d.getMinutes()).padStart(2, '0')}` : '';
            return `**[${who} · ${time}]**\n${t.text}`;
          }).join('\n\n---\n\n');
          parts.push(cfg.render('wake/ctx_last_heading', {
            n: raw.turns.length, ageLabel, reason: raw.captured_reason || '未标注',
          }) + turnsBody);
          // consumed_at 打戳: 防同一 ctx_last 被反复注入(关闭重开后如果不清空一直用同一 session, 冷启动 hook 每次都会走 wake)
          try {
            raw.consumed_at = Date.now();
            fs.writeFileSync(ctxPath, JSON.stringify(raw, null, 2));
          } catch (e) { console.error(`[wake] ${this.name} ctx_last consumed 打戳失败: ${e && e.message}`); }
        }
      }
    } catch (e) { console.error(`[wake] ${this.name} ctx_last 读失败: ${e && e.message}`); }
    // 手上还欠着的任务 —— 紧跟语境之后, 因为它和 ctx_last 回答的是同一个问题:「我刚才在干嘛」。
    //
    // 🔴 这一段是"清单活过压缩"(作者 2026-09-25) 的另一半。只把清单留在盘上是不够的: 清空之后
    // 新会话对这些任务毫无记忆, 那才是老代码宁可整份清掉的原因。念给它听, 那个理由就不成立了。
    // 顺带堵掉落盘引入的新风险 —— 万一混进一条连它自己都不认的任务, 老办法(重启清掉)已经失效,
    // 但它现在看得见, 也有 task(op='update') 可以自己删。看得见 = 清得掉。
    try {
      const alive = (this._tasks || []).filter((t) => t.status !== 'completed');
      if (alive.length) {
        const lines = alive.map((t) => {
          const mark = t.status === 'blocked' ? '⏸' : t.status === 'in_progress' ? '▶' : '○';
          const why = t.status === 'blocked' && t.blockedReason ? ` — blocked: ${t.blockedReason}` : '';
          return `- ${mark} [#${t.id}] ${t.subject}${why}`;
        }).join('\n');
        parts.push(`## 手上还欠着的任务(清单活过了这次清空)\n\n${lines}\n\n`
          + `⏸ = 你自己标了 blocked(卡在别人身上, 不会再催你), ▶ = 做到一半, ○ = 还没动。\n`
          + `**认不出来的条目直接 \`task(op='update', id=…, status='deleted')\` 删掉** —— 清单只该装真还欠着的事。\n`
          + `推不动的用 \`task(op='update', id=…, blocked='在等谁的什么')\`, 光在回话里说"我在等你"没有任何地方读得到。`);
      }
    } catch (e) { console.error(`[wake] ${this.name} 任务清单注入失败: ${e && e.message}`); }
    // 升级补课: 装的 butler 比这个人格知道的新 → 把中间每一版的"你多了什么"注进正文。
    // 放在铁律之前: 它是"这次开机才有的一次性事件", 错过就没了; 铁律天天有。
    try {
      const entry = registry.getByDir(this.homeDir);
      if (entry) {
        const cur = paths.appVersion();
        const seen = entry.capabilitySeenVersion || '';
        const appUpgraded = capUpdate.needsUpdate(seen, cur);
        {
          // 🔴 主力通道: 升级带来的出厂知识直接写进记忆库(作者 2026-08-17 定案)。
          // 老做法是把 <版本>.md 拼进正文让人格自己读了再 memory_upsert 抄一遍 —— 一次性,
          // 读完随上下文丢掉, 还得指望它真去抄。现在同步器按 slug 覆盖出厂那一组, 人格自生的不碰。
          //
          // 🔴 同步【不挂在 app 版本上】(作者 2026-08-19 拍 A 案)。原先闸门是 needsUpdate(seen,cur),
          // 看的是 package.json 版本 —— 可出厂包有它自己的版本, 改包不动 app 版本时闸门判"没升级",
          // 老人格一条新知识都收不到(棒头 seen=cur=0.0.58 正踩这个, 今天 15 条新知识全没同步到)。
          // 同步器本身幂等(未变的算 unchanged), 所以直接每次冷启动都跑, 不再有"版本号忘了动"这类漏同步。
          // 惊不惊动人格仍由 hasChanges 判, 用户侧说明仍按 app 版本走 —— 两者本来就不同源。
          try {
            // 同步本身已在 runFactorySync() 里做掉(冷启动无条件跑, 不受这里的三条件闸门管)。
            // 这里只把它的结果渲进唤醒正文 —— 拿缓存, 不重跑, 否则 unchanged 会被算两遍。
            // 升级自检任务同理: 投递在 runFactorySync 里, 这里只用它的条数。
            // 必须排在用户侧说明之前: 那份说明要顺带告诉用户"它还得自己调整几件事"。
            const { stats: fs2, choreCount } = this.runFactorySync();
            if (fs2) {
              if (factory.hasChanges(fs2)) {
                // 只报数字, 不铺 slug 清单。原来把 createdSlugs 全列出来 —— 一次升级 96 条,
                // 光这一段就 4785 字节, 占了整份唤醒正文的一半。而那串名字对人格是**不可读也不可操作**的:
                // 知识本身已经写进库了, 要用是 memory_query 查, 没有任何一步需要先知道 slug 叫什么。
                parts.push(cfg.render('wake/factory_synced', {
                  // 只有 app 真升了才写"旧 → 新"; 出厂包单独改动时 seen===cur, 写成「0.0.58 → 0.0.58」是假话。
                  versionsLine: (appUpgraded && seen) ? `${seen} → ${cur}` : `v${cur}`,
                  created: fs2.created, updated: fs2.updated, archived: fs2.archived,
                }));
              }
              // 用户侧说明: 与上面给 AI 看的出厂差异**不同源**。用户要的是"我能感觉到什么",
              // 出厂那上百条是 AI 的行为准则, 对用户是噪音(作者 2026-08-17)。所以这一路读
              // config/main/release_notes.json, 某版没写条目就不打扰用户 —— 哪怕出厂知识动了一堆。
              // 落盘 HTML 是完整版; 聊天里直接显示的是精简 md ——
              // 作者 2026-08-17「不用弹窗, 用我们的模板模式显示」: 只贴一行路径等于没说,
              // 那行还是纯文本(system 气泡不过 markdown 管线), 点都点不开。
              const notes = appUpgraded ? capUpdate.pickReleaseNotes(seen, cur) : [];
              if (notes.length) {
                this._updateNoteFile = capUpdate.writeUpdateNote(path.join(this.homeDir, 'updates'), {
                  version: cur, seenVersion: seen, personaName: this.name, notes,
                });
                // 🔴 renderL + localize: 这段是给用户看的升级气泡, 跟界面语言走。
                // (唤醒正文里其余只有模型读得到的段落仍是英文单份, 别把两类混起来。)
                const bits = cfg.json('main/update_note_bits');
                const L = (k, v) => cfg.fill(lang.localize(bits[k]), v);
                this._updateNoteMd = cfg.renderL('main/update_note', {
                  personaName: this.name,
                  versionsLine: L(seen ? 'versions_line' : 'versions_line_first', { cur, seen }),
                  changes: capUpdate.renderNotesMd(notes),
                  choresNote: choreCount ? L('chores_note', { name: this.name, n: choreCount }) : '',
                  htmlPath: this._updateNoteFile || L('no_file', {}),
                });
              }
            }
          } catch (e) { console.error(`[factory] ${this.name} 出厂同步失败: ${e && e.message}`); }
          // 打戳与注入同一时刻完成(同 ctx_last 的 consumed_at): 用户升到零变动的版本也照样推进,
          // 否则每次苏醒都会被反复问候。只在 app 真升级时推进 —— 出厂同步已不看这个戳。
          if (appUpgraded) registry.setCapabilitySeen(entry.id, cur);
        }
      }
    } catch (e) { console.error(`[wake] ${this.name} 升级补课失败: ${e && e.message}`); }
    // 迁移欠账【不再注进唤醒正文】(2026-08-17)。原先每次醒来都报一行"还欠 N 条", 通路是
    // review_queue 那张表; 作者拆表时定的口径:「必做的只有一个时机, 升级之后第一次打开。
    // 之后没机会的, 用户在干活呢, 你说停下来等你体检吗」—— 所以那批账改由空闲期的定期体检
    // (main.js CHECKUP 轨道)反复戳, 唤醒正文这一段整个撤掉, 起床payload 也跟着瘦一截。
    // 下面这张 chores 表才是那"唯一一次必做窗口": 升级后第一次打开, 必须做完的活。
    // 派在库里没人端上来就等于没派 —— 人格不会自己想起来去查有没有待办, 库看上去一切正常。
    // 所以没做完就一直注, 做完(队列空)自己消失。
    try {
      const st = this.memory && this.memory.store;
      if (st && typeof st.choresPending === 'function') {
        const pend = st.choresPending();
        if (pend.length) {
          parts.push(cfg.render('wake/chores', {
            total: pend.length,
            list: pend.map((c) => `### ${c.title}\n\n${c.detail}\n\n完成后：\`memory_admin(op='chore_done', key='${c.key}')\``).join('\n\n'),
          }));
        }
      }
    } catch (e) { console.error(`[wake] ${this.name} 升级任务注入失败: ${e && e.message}`); }
    // 🔴 这里【不注入记忆内容】(作者 2026-08-17 定案「醒来就塞上下文, 塞不起」)。
    // 砍掉的四段: 记忆心法全文 · pinned 快查表 · hot top-5 · recent top-5 —— 合计约 3.3k tok 常驻。
    // 它们不是没用, 是不该由代码每次硬塞: 心法/四层总览已随出厂知识包灌进人格自己的库
    // (config/onboarding/knowledge/leaf_core.json v4), 查得到。
    // 唤醒正文只保留【这一刻才有、库里查不到】的东西: 关档前对话 + 交接便条 + 一次性事件(升级/迁移/体检)。
    // 其余改为触发式 —— wake/preamble.md 里那句"第一个动作是 memory_hot"就是触发点。
    // pinned 不在唤醒正文里: 它是常驻层, 由 system-prompt.js 的 _pinnedBlock 每个会话注入。
    // 红线一如既往不进上下文: 走 PreToolUse 硬过滤 (见 reference_redline_hard_filter_via_pretooluse_hook)。
    // MEMORY.md 硬性封顶 (2026-08-13 作者定案「强制瘦身」)。它是交接便条不是记忆本体, 但会自己长胖:
    // 实测码上飞那份涨到 40.9KB ≈ 12.5k tok, 而它跟着上下文每轮重读一遍 —— 一周 3 万轮就是 587M cacheRead。
    // 光靠"抬头写着要短"管不住(已被砍过两次又长回来), 所以超了就截断 + 当场让人格自己收, 它有 memory_upsert 能把细节挪进节点。
    // 按整行切: 半个条目比没有更误导, 而且 UTF-8 从中间切会碎字。
    try {
      const idxPath = path.join(this.memoryDir, 'MEMORY.md');
      if (fs.existsSync(idxPath)) {
        const full = fs.readFileSync(idxPath, 'utf8');
        const rawBytes = Buffer.byteLength(full);
        let body = full;
        if (rawBytes > WAKE_MEMORY_INDEX_MAX_BYTES) {
          const lines = full.split('\n');
          const kept = [];
          let used = 0;
          for (const ln of lines) {
            const cost = Buffer.byteLength(ln) + 1;
            if (used + cost > WAKE_MEMORY_INDEX_MAX_BYTES) break;
            kept.push(ln); used += cost;
          }
          body = kept.join('\n') + cfg.render('wake/memory_index_overweight', {
            kb: (rawBytes / 1024).toFixed(1),
            maxKb: (WAKE_MEMORY_INDEX_MAX_BYTES / 1024).toFixed(0),
            droppedLines: lines.length - kept.length,
            path: idxPath,
          });
        }
        parts.push(cfg.text('wake/memory_index_heading') + body);
      }
    } catch (_) {}
    try {
      const wmPath = path.join(this.memoryDir, 'wake_manifest.md');
      if (fs.existsSync(wmPath)) {
        parts.push(cfg.text('wake/manifest_heading') + fs.readFileSync(wmPath, 'utf8'));
      }
    } catch (_) {}
    // 🔴 定期冲突体检【已挪走】(作者 2026-09-09): 原先在这里同步跑全库两两配对, 实测 1683 条节点
    // = 141 万对 = 3.4 秒把主进程占死, 而起床恰恰是最不该卡的时刻。现在归 idle-watcher 的 CHECKUP
    // 轨道: 空闲时分片跑, 扫出东西才戳人格。别再往起床路上挂重活。
    // chip 现状一行(作者 2026-08-08 点头): 看不见 = 永远想不起来调整。空池也注入 —— "一个都没了"正是该生成新的信号。
    try {
      const chips = (this.personaOps && this.personaOps.getChips) ? (this.personaOps.getChips() || []) : [];
      parts.push(cfg.render('wake/chips_heading', {
        count: chips.length,
        list: chips.length ? chips.map((c) => c.label).join(' · ') : '(空 · 想加就用 update_prompt_chips)',
      }).trimEnd());
    } catch (_) {}
    parts.push(...this._extraWakeParts('atEnd'));
    return parts.join('\n');
  }
}

module.exports = WakeMixin;
