// 写路径: upsert · 段级读写 · 推翻 · 连边
// 由 memory-v2.js 拆出(内核抽包第 2 步)。方法体逐字搬运, 经 mixin 挂回 MemoryGraphV2.prototype。
const { canon, todayLocal, addDays, localTimestampShort, TYPE_DEFAULT_IMP, REVIEW_DUE_DAYS } = require('../memory');
const { contentHash } = require('../memory-store-v2');
const { IMP_BASE_V2, checkBodyLimit, checkClaimLimit, bodyHardTokens, estTokens } = require('./consts');
// 报错与回执文案不写在这儿: AI 会把它们转述给店主, 所以得跟着显示语言换。见 messages.js 头注。
const { msg } = require('./messages');
const { pick, pickBody, getLang } = require('./lang');

// 只认 ISO 全日期, 与 doctor 的编年史判据同一把尺 —— 两处用不同的尺, 体检说脏、写入不提醒,
// 或者反过来, 都会让人搞不清到底什么算编年史。非全局: .test() 带 /g 会记住 lastIndex 隔次漏判。
const DATE_RE = /20\d\d-\d\d-\d\d/;

// 🔴 工具调用的参数标签漏进了字段值 —— 这是【静默失败】的一种, 必须硬拦。
// 形状: 调用方本想传 claim + body 两个参数, 但分隔符没写对, 于是 body 连同标签一起被
// 当成 claim 的值收下。工具照常返回成功、回执还把内容原样回显, 看着完全像写进去了,
// 而 claim 是检索唯一露出来的东西 —— 从此每次搜索都会看到一坨 XML 加一整篇正文。
// 实测两个不同人格、两种不同写法各踩一次(一次漏 antml: 前缀, 一次多写闭合标签),
// 所以这不是谁不小心, 是工具层该拦的。
// 只匹配【尖括号开头】的这几个特定词, 所以正文里写「parameter 这个参数」不会被误伤。
const TAG_LEAK_RE = /<\/?(?:antml:)?(?:parameter|claim|body|invoke|function_calls)\b/i;
function assertNoTagLeak(fields) {
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v !== 'string') continue;
    const m = v.match(TAG_LEAK_RE);
    if (!m) continue;
    throw new Error(msg('tag_leak', { field: k, tag: m[0] }));
  }
}

class WriteMixin {
  // ⑦ 写入回执通则: 想约束"记忆该怎么写"的规矩, **优先做成写入回执, 其次才是提示词**。
  // 提示词是醒来读一遍、之后被整轮对话挤开的东西, 而回执在动作刚发生那一刻就在眼前, 且与
  // 那个动作绑死, 不需要谁主动想起来 —— 提示词那一路的失效是完全静默的(2026-08-26 一天四次
  // 提议造已经存在的东西, 每次那东西都写在提示词里)。
  //
  // 🔴 两条边界:
  //   ① 每条必须有触发条件, 不许常亮。常亮的提示两天就读成噪音, 到那时连该看的那条也一起废
  //      (与"974 条全打同一个标等于没标"是同一个失效)。
  //   ② 只提示不拦截。硬拒绝只留给形式问题(正文超硬闸 / 缺命题 / 传 body 没 base_hash) ——
  //      内容判断拦不得: 「8-11 之后 banto 这名字作废」里的日期就是命题本身。
  _writeNotes({ claim, body }) {
    const notes = [];
    if (claim && DATE_RE.test(claim)) {
      notes.push(msg('note_claim_has_date'));
    }
    if (body !== undefined) {
      const chars = String(body).length;
      const tokens = estTokens(body);
      const limit = bodyHardTokens();
      const dates = String(body).match(new RegExp(DATE_RE.source, 'g'));
      if (dates && dates.length >= 3) {
        notes.push(msg('note_body_many_dates', { n: dates.length }));
      }
      // 🔴 快满时点名"论证", 不泛泛说"太长了"。实测正文膨胀的主体既不是编年史也不是追加,
      // 而是"当初怎么说服自己这条为真"的推理链 —— 而写的人不会自己想到那部分可以删。
      if (tokens >= limit * 0.67) {
        notes.push(msg('note_body_near_limit', { tokens, limit }));
      }
      // 🔴 收紧口径之后冒出来的新失效模式: 不写论证了, 改成把命题换个说法再讲一遍。
      // 根因是 body 这个参数摆在那儿, 模型就觉得该填, 而没人说过"claim 说完了就该留空"。
      // 判据不判语义(试过字面重合率和向量余弦, 都分不开真复述与真用法), 只看【有没有用法的形态】:
      // 命令、路径、代码都带 ` 或 /。实测触发率 2/1392(0.14%), 所以不会常亮成噪音;
      // 而那 2 条误报本身也确实该精简(是「怎么撞上的」「原话是」这类叙事)。
      if (chars > 0 && chars < 300 && !/[`/]/.test(String(body))) {
        notes.push(msg('note_body_restates_claim'));
      }
    }
    return notes;
  }

  setImportance(ref, importance) {
    const imp = String(importance || '').toLowerCase();
    // pinned 不再是 importance 的一档 —— 它是扩展表。挡在这里而不是静默接受,
    // 否则调用方会以为自己置顶成功了, 实际只是把重要性设成了一个不存在的档。
    if (imp === 'pinned') throw new Error(msg('imp_is_not_pinned'));
    if (!(imp in IMP_BASE_V2)) throw new Error(msg('imp_bad', { got: importance }));
    const id = this.resolve(ref);
    if (!id) throw new Error(msg('node_not_found', { ref: ref }));
    // 不动 last_used: 降级是元数据维护, 不是"我用过它"。混进去会污染 recent 段。
    this.store.upsertNode({ id, importance: imp }, { op: 'set_importance' });
    return { id, importance: imp };
  }

  // 改名。主键是数字、边只连数字, 所以 slug 换掉不断边, 热度和 history 也原样留着。
  // 出厂知识改名必须走这里 —— 靠"建新的 + 归档旧的"会把一条知识裂成两条: 新的热度从 0 起,
  // 别人正文里的 [[旧名]] 全指向一条已退役的节点。
  renameSlug(oldSlug, newSlug) {
    const from = canon(oldSlug), to = canon(newSlug);
    if (!from || !to) throw new Error(msg('rename_needs_both'));
    if (from === to) return { renamed: false, reason: 'same' };
    const id = this.resolve(from);
    if (!id) return { renamed: false, reason: 'not_found' };
    // 目标名已被占: 硬拒。撞上去会违反 slug 的唯一约束, 而静默跳过会让调用方以为改成功了。
    if (this.resolve(to)) return { renamed: false, reason: 'target_exists' };
    this.store.upsertNode({ id, slug: to }, { op: 'rename' });
    // upsertNode 的 history 只盯 claim/body/importance/status, 改名不会自己留痕 —— 显式记一条,
    // 否则"这条什么时候换的名、原来叫什么"事后查不到。
    this.store.addHistory({ node_id: id, op: 'rename', field: 'slug', before: from, after: to, actor: 'rename' });
    return { renamed: true, id, from, to };
  }

  // —— 写入 ——
  // 🔴 type / keywords 刻意【不给默认值】。给了默认值等于"没传"也变成"传了默认值",
  // 于是二次 upsert 会把 keywords 清空、把 type 改回 project —— store 的 partial 保护在
  // 参数解构这一层就被绕过去了。默认值只在新建那一支现场兜底。
  // (v1 的 `type = 'project'` 一直带着这个病, 搬家时顺手治掉)
  // translations / body_i18n 走出厂同步那条路进来(见 factory-sync.js 的 OWNED), 人格自己
  // 沉的记忆不填它们 —— 换语言导致自沉记忆召回失灵是作者接受的代价, 引擎不替它翻译。
  upsert({ id, slug, title, type, importance, claim, keywords, anchors, projects, translations, body, body_i18n,
           base_hash, provisional,
           links = [], edges = [], status, scope, exit_criteria, review_due, requireExitCriteria = true,
           provenance, is_factory, seed_use_count, actor = '', force = false, force_overwrite = false }) {
    const ref = id || slug;
    if (!ref) throw new Error(msg('upsert_needs_ref'));
    // 0=判过了 · 1=迁移时机器垫的历史欠账 · 2=讨论中的临时命题。挡在这里而不是让它静默落库:
    // 写进一个没人认识的值, 显示层和体检层会各自当成"真"来处理, 于是全库多出一档看不懂的状态。
    if (provisional !== undefined && ![0, 1, 2].includes(Number(provisional))) {
      throw new Error(msg('provisional_bad', { got: provisional }));
    }
    // 标签泄漏挡在最前面: 它一旦落库, 脏的是 claim(检索唯一露出来的东西), 且没有任何报错。
    assertNoTagLeak({ claim, body, keywords, title, anchors, projects, scope });
    // 体积闸挡在最前: 挡门要在【写之前】判, 判在写之后就成了"写完再回滚", 历史表里会留下一条幽灵修订。
    if (body !== undefined) checkBodyLimit(body, { force, slug: slug || String(id || '') });
    // 命题行闸【不认 force】: force 是给整批搬运留的口, 而出厂包正是这个毛病的来源 ——
    // 给它开口子等于让唯一会犯这个错的路径绕过检查。
    if (claim !== undefined) checkClaimLimit(claim, { slug: slug || String(id || '') });
    const nSlug = slug ? canon(slug) : null;
    const existingId = id || (nSlug ? this.store.idOf(nSlug) : null);
    const isNew = !existingId;
    if (isNew && !claim) throw new Error(msg('new_needs_claim'));

    // 🔴 传 body 冲掉已有正文必须带 base_hash(只能从 memory_section 拿到)。
    // memory_query 只返回 claim 不返回 body, 所以"查到一条记忆"≠"知道它正文写了什么" ——
    // 2026-08-02 那次两个节点 87 行/80 行瞬间清空就是这么发生的: 以为在补充, 实际整体替换。
    // 有了这道闸, "读过全文"从自觉变成凭据, 顺带挡住并发无声覆盖。
    // 不传 body 完全不受影响(partial 语义, 只改 claim/keywords 一个字都不掉)。
    // force 归体积闸管, 这道闸单给 force_overwrite —— 一个 force 开关不能同时管两道闸(#926)。
    if (body !== undefined && !isNew) {
      const curBody = this.store.bodiesOf([existingId]).get(existingId) || '';
      // 正文本来就是空的 → 没东西可冲掉, 风险等同新建, 不该为它加一趟读。
      if (curBody.trim()) {
        const curHash = contentHash('', curBody.replace(/^\n+|\s+$/g, ''), '');
        if (force_overwrite) {
          console.warn(`[memory] 无凭据覆盖正文: ${nSlug || existingId} `
            + `(force_overwrite, actor=${actor || this.actor || '未知'}, 旧正文 ${curBody.length} 字符)`);
        } else if (base_hash === undefined) {
          throw new Error(msg('upsert_body_needs_hash',
            { ref: nSlug || existingId, chars: curBody.length }));
        } else if (base_hash !== curHash) {
          throw new Error(msg('hash_mismatch', { given: base_hash, current: curHash }));
        }
      }
    }

    const now = todayLocal();
    const prev = existingId ? this.store.node(existingId) : null;
    // 省了 type 就按 slug 前缀认(工具层 type 是选填, 省略是常态)。缺省落 'project' 会让每一次
    // 省略 type 的新建都撞上下面那道 exit_criteria 闸, 而报错谈的是"僵尸项目", 与调用方在做的事
    // 毫不相干; 前缀也认不出来时落 reference —— 认错成最轻的那档只是分类不准, 认错成 project
    // 会连门都进不去。
    const slugForType = nSlug || (prev && prev.slug) || '';
    const byPrefix = Object.keys(TYPE_DEFAULT_IMP).find((t) => slugForType.startsWith(`${t}_`));
    const effType = type !== undefined ? type : (prev ? prev.type : (byPrefix || 'reference'));
    const isProject = slugForType.startsWith('project_') || effType === 'project';
    let revDue = review_due !== undefined ? review_due : (prev && prev.review_due) || '';
    const exitC = exit_criteria !== undefined ? exit_criteria : (prev && prev.exit_criteria) || '';
    // 新建 project 强制定退出条件: 这是治僵尸项目的源头闸。存量更新不挡, 只挡新建。
    if (isNew && isProject && requireExitCriteria && !exitC) {
      throw new Error(msg('new_project_needs_exit'));
    }
    if (isProject && !revDue) revDue = addDays(prev ? (prev.created || now) : now, REVIEW_DUE_DAYS);

    // 没传 provenance = 人格自己在写。它改到平台下发的那条上, 这条就此脱离下发批次,
    // 否则下次知识包升级会拿出厂原文覆盖掉店里改出来的经验。butler 侧没有 platform 节点,
    // 走不到这个分支, 行为不变。
    const prov = provenance !== undefined ? provenance
      : (prev && prev.provenance === 'platform' ? 'override' : undefined);

    // auto-touch: 凡 upsert 皆一次"我用过"信号。新建首沉=1, 更新=旧值+1。
    // seed_use_count 只在【新建】时生效: 出厂知识 use_count 全 1 会让 hot 退化成字母序,
    // 给个冷启动初值排序才有意义。绝不覆盖存量 —— 人格自己积累的真实频次高于出厂估计。
    const use_count = prev ? ((prev.use_count || 1) + 1)
      : (seed_use_count > 0 ? seed_use_count : 1);
    const payload = {
      id: existingId || undefined, slug: nSlug || undefined, title, claim, keywords, anchors, projects, translations,
      body, body_i18n,
      // 新建才落推断出来的 type: store 那边 `n.type || ''`, 不落就是个空 type 节点。
      // 存量仍是 partial —— 没传就一个字不动。
      type: type !== undefined ? type : (prev ? undefined : effType),
      importance: importance || (prev ? undefined : (TYPE_DEFAULT_IMP[effType] || 'med')),
      status, scope, exit_criteria: exitC || undefined,
      review_due: revDue || undefined, provenance: prov, is_factory,
      created: prev ? undefined : now, last_used: now, use_count,
      claim_provisional: provisional !== undefined ? Number(provisional) : undefined,
    };
    // undefined 的字段由 store 的 partial 语义跳过 —— 不传就不动, 而不是被静默清空。
    for (const kk of Object.keys(payload)) if (payload[kk] === undefined) delete payload[kk];
    // actor 在引擎层兜底而不是靠每个调用点记得传: upsert 原先漏传, 结果所有 create/upsert
    // 的修订作者都是空的, 而 append/supersede 有 —— 同一份历史里一半记名一半匿名。
    const nid = this.store.upsertNode(payload, { actor: actor || this.actor || '', op: isNew ? 'create' : 'upsert' });

    // 边不再从正文正则抠。只整体替换【人写的 relates 边】, 引擎自动长出来的不受影响。
    if (links && links.length) {
      const dsts = links.map((l) => this.resolve(l)).filter((x) => x && x !== nid);
      this.store.replaceEdges(nid, dsts, 'relates', 'human');
    }
    // 有向的类型边。links 只能表达"有关", 而 part_of / supports / refines 是有方向的 ——
    // 拿 linkBidirectional 代替会写反(A part_of B 不等于 B part_of A)。
    // 按 rel 分组整体替换: 没提到的 rel 不受影响, 所以补一类边不会抹掉另一类。
    if (edges && edges.length) {
      const byRel = new Map();
      for (const e of edges) {
        if (!e || !e.to) continue;
        const dst = this.resolve(e.to);
        if (!dst || dst === nid) continue;
        const rel = e.rel || 'relates';
        if (!byRel.has(rel)) byRel.set(rel, []);
        byRel.get(rel).push(dst);
      }
      for (const [rel, dsts] of byRel) this.store.replaceEdges(nid, dsts, rel, 'human');
    }
    // 补算挂在写入点上, 不指望调用方记得调(v1 在 upsert/append 各挂一次, v2 一直漏着)。
    // 不挂的话新沉的记忆要等下一次人格启动才被 agent.js 那次全量 kick 捡起来 —— 期间它对
    // 语义检索是隐形的, 而刚沉下去的恰恰是最可能马上被查的。
    this.kickEmbed();
    return { id: nid, slug: this.store.slugOf(nid), is_new: isNew, use_count,
             notes: this._writeNotes({ claim, body }) };
  }

  // —— 正文读写 ——
  //
  // 🔴 段的概念已整个撤掉。理由不是"段没用", 而是【段正是让一个节点装得下多个命题的那个凭借】:
  // 只要 ## 标题还在, 一条记忆就能合法地长出第 2、第 3 个子命题, 而记忆的单位本来就该是一个命题。
  // 需要小标题, 就说明这里已经不止一个命题了 —— 那时该拆成原子节点用 [[边]] 连, 不是加个标题。
  //
  // 撤掉之后正文就是一坨字符串: 只装这条命题的说明和用法, 短到不需要内部标题。
  // 连带撤掉的还有 supersedeSection(段级失效) —— 没有段就没有"某一段的说法被推翻"这回事,
  // 那种情况现在的做法是把那句话从正文里删掉(history 全量留着, 捞得回来)。

  // 读整条正文 + 指纹。指纹拿去当 write / upsert(body) 的 base_hash ——
  // 「读过全文」从自觉变成凭据, 挡的是"以为在补充、实际整体冲掉"。
  // 显示语言有正文译文就给译文 —— 平台把知识译成四语, 读的这一口不认译文的话,
  // 日文店铺永远只能读到简体原文, 而且不报错。
  // 🔴 指纹永远算在**原文**上: 它是写回的凭据, 而 write/upsert 比对的也是原文。
  // 指纹跟着译文走就永远对不上, 表现成"读过全文了却总说没读过"。
  wholeBody(ref) {
    const id = this.resolve(ref);
    if (!id) throw new Error(msg('node_not_found', { ref: ref }));
    const row = this.store.bodyWithI18n(id);
    const body = row.body || '';
    const m = this.store.node(id) || {};
    const shown = pickBody({ body, body_i18n: row.body_i18n });
    // claim 一并给出: 自长节点大多正文为空, 规矩全在命题行里 —— 只回正文等于展开了个寂寞
    return { id, slug: m.slug || '', claim: pick(m).claim || '', content: shown,
             lang: shown !== body ? getLang() : '',
             hash: contentHash('', body.replace(/^\n+|\s+$/g, ''), '') };
  }

  // 🔴 改正文。两条约束, 各治一件事:
  //   ① base_hash 乐观锁 —— 传你读到的那份指纹, 对不上说明你读到之后它被改过 → 拒写。
  //   ② 新内容不得长于旧内容 —— write 是【改】, 不是【加】。
  //
  // ② 的由来是实测: write 262 次改已有正文, 其中 251 次(96%)让正文变长, 平均每次 +603 字符;
  // 同期全量 upsert 平均让正文缩 91 字符。同一批人格、同一个库 —— 便宜的口子只会被用来加,
  // 贵的口子才会做减法。所以不砍掉 write(它省 token 是真的), 而是把它钉死在"改"上:
  // 要加内容就去付 upsert 全量重写的钱, 并正面接受体积闸。
  //
  // claim 可选, 但**回执里一定把当前命题行印出来**: 改正文不会让命题行跟着变, 于是一条被正文
  // 推翻的说法仍以旧口径出现在每一次检索结果里继续误导。"我这次改动不影响命题"这个判断人做不准。
  write({ node, content, base_hash, force = false, actor, reason = '无说明', claim }) {
    if (!node) throw new Error(msg('write_needs_node'));
    if (content == null) throw new Error(msg('write_needs_content'));
    assertNoTagLeak({ content, claim });
    const id = this.resolve(node);
    if (!id) throw new Error(msg('node_not_found', { ref: node }));
    const who = actor || this.actor || '未知';
    const m = this.store.node(id);
    const ref = m.slug || String(id);
    const cur = (this.store.bodiesOf([id]).get(id) || '').replace(/^\n+|\s+$/g, '');
    const next = String(content).replace(/^\n+|\s+$/g, '');

    // 正文本来是空的 → 没有"改"可言, 也没东西可冲掉。首次写正文归 upsert。
    if (!cur) {
      throw new Error(msg('write_body_empty', { ref }));
    }

    if (!force) {
      const curHash = contentHash('', cur, '');
      if (base_hash === undefined) {
        throw new Error(msg('write_needs_hash', { ref, chars: cur.length }));
      }
      if (base_hash !== curHash) {
        // 🔴 报错不能预设"有第三方写入" —— 单人库里那个前提永远为假, 会把人推去查并发、查日志。
        // 实测: 一个错误方向的报错比没有报错更贵, 因为人会顺着它走。
        throw new Error(msg('hash_mismatch', { given: base_hash, current: curHash }));
      }
    }

    // 🔴 只许改不许加。force 不解这道闸 —— force 解的是乐观锁("我确知要盖掉"),
    // 与"这次可以变长"是两回事; 一个开关管两件事, 迟早有人为了绕前者顺手关掉后者。
    if (next.length > cur.length) {
      throw new Error(msg('write_is_edit_not_add',
        { next: next.length, cur: cur.length, limit: bodyHardTokens() }));
    }

    checkBodyLimit(next, { slug: ref });
    this.store.upsertNode({ id, body: next, last_used: todayLocal(), use_count: (m.use_count || 0) + 1 },
      { actor: who, op: 'write' });
    this.kickEmbed();   // 与 upsert 同理: 改了正文, 向量得跟着重算
    if (claim !== undefined) this.store.upsertNode({ id, claim }, { actor: who, op: 'write' });
    const curClaim = claim !== undefined ? claim : (this.store.node(id) || {}).claim || '';
    return { id, slug: m.slug, reason,
             // 落盘后的 hash, 口径与读取侧一致 —— 否则调用方拿它回来改会被乐观锁判成"别人改过",
             // 而且是永久对不上, 那条正文从此改不动。
             hash: contentHash('', next, ''),
             chars: next.length, shrank: cur.length - next.length,
             claim: curClaim,
             notes: [
               ...this._writeNotes({ claim: curClaim, body: next }),
               // 恒印, 因为它的触发条件就是"发生了一次正文改动" —— 不是常亮
               `📌 当前命题:「${curClaim}」\n   ⚠️ 这次改动之后, 这句还准吗? 不准就 memory_upsert(id, claim="…") 改掉`
                 + '(只传 claim 不传 body, 正文一个字都不会动)。',
             ] };
  }

  // ⚠️ 【已停用, 保留备查】没有暴露给 MCP 工具层, 人格调不到它。
  // 它依赖的「段」概念已经整个撤掉, 所以它往正文里插的 ## 标题与现行口径冲突 ——
  // 真要再启用, 得先把"往哪追加"改造成别的寻址方式, 不能原样复活。
  // 往指定 section 追加带签名头的正文。section 不存在则在末尾建。
  append({ parent_id, section, body, actor, reason = '无说明', touch = true, force = false }) {
    if (!parent_id) throw new Error(msg('append_needs_parent'));
    if (!section) throw new Error(msg('append_needs_section'));
    const id = this.resolve(parent_id);
    if (!id) throw new Error(msg('node_not_found', { ref: parent_id }));
    const who = actor || this.actor || '未知';
    const cur = this.store.bodiesOf([id]).get(id) || '';
    const head = `### ${localTimestampShort()} · ${who} · ${reason}`;
    const block = `${head}\n${body}`;
    const re = new RegExp(`^##\\s+${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'gm');
    const hits = [...cur.matchAll(re)];
    let next;
    let created = false;
    if (!hits.length) {
      next = `${cur.replace(/\s*$/, '')}\n\n## ${section}\n${block}\n`;
      created = true;
    } else {
      // 多个同名段选最后一个(追加式, 最新最相关): 找它的结束位置 = 下一个 ## 或文末
      const last = hits[hits.length - 1];
      const from = last.index + last[0].length;
      const rest = cur.slice(from);
      const nextH2 = rest.search(/^##\s+/m);
      const insertAt = nextH2 === -1 ? cur.length : from + nextH2;
      next = `${cur.slice(0, insertAt).replace(/\s*$/, '')}\n\n${block}\n\n${cur.slice(insertAt)}`.replace(/\n{4,}/g, '\n\n\n');
    }
    // ⚠️ 这里原先断言「append 才是体积失控的主路径, 不是 upsert」, 依据是 2026-08-16 那次
    // "226 条节点挂着 580 个补丁"。那个结论【已被推翻】: 实测 191 条 ≥3000 字符的节点里
    // 77% 从没被追加过, 平均 5358 字符中 5029 是首次写入就自带的。病根是【一次就写这么长】。
    // 保留的只有这一条: 闸要判【写入之后】的总量, 判增量等于没闸。
    checkBodyLimit(next, { force, slug: this.store.slugOf(id) || String(id) });
    const m = this.store.node(id);
    this.store.upsertNode({ id, body: next,
      ...(touch ? { last_used: todayLocal(), use_count: (m.use_count || 0) + 1 } : {}) },
      { actor: who, op: 'append' });
    return { id, slug: m.slug, section, section_created: created, touched: touch };
  }

  linkBidirectional({ from_id, to_id, rel = 'relates', touch = true }) {
    const a = this.resolve(from_id), b = this.resolve(to_id);
    if (!a) throw new Error(msg('node_not_found', { ref: from_id }));
    if (!b) throw new Error(msg('node_not_found', { ref: to_id }));
    if (a === b) throw new Error(msg('link_self'));
    this.store.addEdge(a, b, rel, 'human');
    this.store.addEdge(b, a, rel, 'human');
    // cooccur:false —— 这一对刚刚已经手写了一条边, 再自动长一条共现边纯属重复计数。
    if (touch) this.touch([a, b], { cooccur: false });
    return { from: a, to: b, rel };
  }

  addEdge(from_id, to_id, rel = 'relates', madeBy = 'human') {
    const a = this.resolve(from_id), b = this.resolve(to_id);
    if (!a || !b) throw new Error(msg('endpoint_missing'));
    this.store.addEdge(a, b, rel, madeBy);
    return { from: a, to: b, rel, made_by: madeBy };
  }

  // 标记推翻关系。这是 v1 superseded_by 字段的替代, 差别在于边有执行力:
  // 召回被推翻方时 query() 会强制附带推翻者的命题。
  supersede({ winner, loser, actor }) {
    const w = this.resolve(winner), l = this.resolve(loser);
    if (!w || !l) throw new Error(msg('endpoint_missing'));
    this.store.addEdge(w, l, 'supersedes', 'human');
    this.store.upsertNode({ id: l, status: 'superseded' }, { actor: actor || this.actor || '', op: 'arbitrate' });
    return { winner: w, loser: l };
  }

  // —— 矛盾与僵尸 ——
  // 复用 memory-arbitration.js 的纯算法(jaccard 疑似对 / 僵尸项目判定), 只把 v2 的节点形状
  // 适配成它期望的样子。不复制一份算法过来 —— 两版并存期最怕的就是同一套判定各改各的。
  // 真正被 v2 取代掉的只有【写入侧】: arbitrate 写 .md frontmatter 那段, 换成了 supersedes 边。
  // idAsSlug: 老算法里有一类隐含假设 ——「id 是带语义前缀的字符串」(如 zombies 用
  // id.startsWith('project_') 判类型)。数字主键把这个假设整个打破, 数字上没有 startsWith。
  // 不吃 links 的算法可以安全地喂 slug 当 id; 吃 links 的必须喂数字, 否则和边对不上。
  _asLegacyNodes(idx, { idAsSlug = false } = {}) {
    const supBy = new Map();
    for (const e of idx.edges) if (e.rel === 'supersedes') supBy.set(e.dst, e.src);
    const out = {};
    for (const m of Object.values(idx.nodes)) {
      const key = idAsSlug ? (m.slug || String(m.id)) : m.id;
      out[key] = {
        ...m,
        id: key,
        description: m.claim || '',                                   // 老算法认 description
        superseded_by: supBy.has(m.id) ? supBy.get(m.id) : '',        // 老算法认字段, v2 存的是边
        importance: idx.pinned.has(m.id) ? 'pinned' : m.importance,   // 老算法把 pinned 当一档重要性
      };
    }
    return out;
  }

}

module.exports = WriteMixin;
