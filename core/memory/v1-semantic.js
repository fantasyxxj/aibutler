// v1 语义检索: embedder 注入 · 向量补算 · 融合开关
// 由 memory.js 拆出(内核抽包第 2 步)。方法体逐字搬运, 经 mixin 挂回 MemoryGraph.prototype。
const { cosine, normalize } = require('../memory-vector');
const {
  nowLocalISO,
} = require('./primitives');

class V1SemanticMixin {
  // —— 语义检索 ——
  // 🔴 query() 必须保持同步: agent.js、出生教育、37 个门禁套件全部同步调它, 改成 async 等于
  // 让所有调用方一起改。而算查询向量必然是异步的(要跨进程去渲染进程跑 wasm 推理)。
  // 所以拆成两条路: 同步路只用【已经算好】的查询向量(调用方给), 异步路 queryAsync 负责先算再调同步路。
  // 没给向量也没 embedder 时语义层静默跳过 —— 语义是增强, 不是前置条件, 缺了不该让检索失败。
  setEmbedder(fn) { this._embed = fn; return this; }
  hasEmbedder() { return typeof this._embed === 'function'; }

  // 语义那一路的完整排名(全库按余弦降序), 不设任何门槛。
  //
  // 🔴 这里原先有个显著性门槛(z = (score-p50)/(p90-p50) ≥ 2.8)。2026-08-13 删掉, 两条理由:
  //   ① 那个 2.8 是照【中文】的分数分布标的, 在英语库上把 8 条真命中里的 7 条挡在门外 ——
  //      一个照单一语种标定的常数, 放在多语种的库里必然歧视另一边。
  //   ② 它存在的唯一理由是"别让噪音挤掉关键词的席位"。换成 RRF 之后这个理由消失了:
  //      只有一路认的条目自然排在两路都认的之后, 噪音沉底, 不需要提前枪毙。
  // 「库里根本没有答案的问句会不会被硬塞噪音」这一问, 作者 2026-08-13 消解了: 检索的调用方是
  // AI 自己带着任务来查, 记忆也是它自己写的, 捞回来用不用它自己判断 —— 不是随口闲聊的搜索框。
  _semanticRanking() {
    const vec = this._pendingQueryVec;
    if (!vec) return [];
    const entries = this._vecCache || (this._vecCache = this.store.allVectors(this.embedModel));
    if (!entries.length) return [];
    const { cosine } = require('../memory-vector');
    return entries.map((e) => ({ id: e.id, score: cosine(vec, e.vec) }))
      .sort((a, b) => b.score - a.score);
  }

  // 给同步检索备好查询向量, 返回一个"用完请归还"的清理函数。
  // 这个形状是为了 queryWithSuspects 这类【内部会调 query()】的同步方法也能吃到语义层,
  // 而不必把它们统统改成 async(那会一路波及到所有调用方)。
  // 语义模型没装/算失败 → 静默降级成纯关键词, 绝不让检索因为增强功能失败而失败。
  // 默认【开】。当初默认关是因为老的"占坑式"融合在真库上打不过关键词 —— 那是机制的问题不是语义的问题。
  // 换成锁头+RRF 之后: 英语 top-8 命中 62.5%→91.7%, 中文逐项持平零丢失, 已经没有理由默认关着。
  // 留 off 只当逃生口(memory_semantic(action="off"))。真正的准入关口不在这个开关, 而在"有没有向量":
  // 145MB 模型 + 全库补齐是用户点头的那一步, 没点过头 semAll 为空 → 结果与纯关键词逐字节一致。
  semanticFusionOn() { return this.store.getMeta('semantic_fusion') !== '0'; }
  setSemanticFusion(on) { this.store.setMeta('semantic_fusion', on ? '1' : '0'); }

  async prepareSemantic(q, { semantic = true } = {}) {
    // 没 opt-in(库里一条向量都没有)就别去算查询向量 —— 那是一次白等的 wasm 推理, 且结果注定用不上。
    if (!semantic || !this._embed || !q || !this.semanticFusionOn() || !this.semanticOptedIn()) return () => {};
    try {
      // e5 系列要求查询侧带 query: 前缀、文档侧带 passage: —— 少了前缀不报错, 只是变得不准。
      const vecs = await this._embed([`query: ${q}`]);
      this._pendingQueryVec = (vecs && vecs[0]) || null;
    } catch (_) { this._pendingQueryVec = null; }
    return () => { this._pendingQueryVec = null; };
  }

  // 异步检索: 先算查询向量, 再走同步主路。语义层缺席时结果与 query() 完全一致。
  async queryAsync(q, opts = {}) {
    const release = await this.prepareSemantic(q, opts);
    try { return this.query(q, opts); }
    finally { release(); }
  }

  // 这张图有没有启用语义检索。触发者是【模型已经在本机】, 不是用户点头 ——
  // 2026-08-13 定案默认开, 模型由 app 首启后台自己装(见 main.js kickSemanticModel)。
  // 之后的增量必须自动跟上 ——
  // 2026-08-13 真机测出的失败模式: 补齐后每条新记忆都没有向量且不报错, 语义覆盖率随使用逐日下降,
  // 用户只会觉得"这功能越来越不准", 查不出原因。开闸一次, 此后引擎自己维持。
  // 库里已经有向量 = 当然是开着的(本标记之前就补齐过的老库没有 meta, 不能因此被当成没开)。
  semanticOptedIn() {
    if (this.store.getMeta('semantic_optin')) return true;
    return this.embedModel ? this.store.vectorCount(this.embedModel) > 0 : false;
  }
  markSemanticOptIn() { this.store.setMeta('semantic_optin', nowLocalISO()); }

  // 写入后顺手补上新节点的向量。故意不 await: 沉记忆的回执不该等推理。
  // 只在已 opt-in 时动作 —— 没点过头的库在这里一动不动, 免得变相绕过"首次要用户同意"。
  // 补算期间又来一次写入是常态(连着沉两条), 而那条新节点不在本轮的待补快照里 ——
  // 所以跑完要再看一眼, 有剩就再来一轮, 否则它得等到下次写入才补上。
  kickEmbed({ limit = 32 } = {}) {
    if (this._embedKicking || !this._embed || !this.semanticOptedIn()) return;
    this._embedKicking = true;
    Promise.resolve()
      .then(() => this.embedPending({ limit }))
      .then((r) => {
        this._embedKicking = false;
        if (r && r.embedded > 0 && this.embedStats().pending > 0) this.kickEmbed({ limit });
      })
      .catch(() => { this._embedKicking = false; });
  }

  // 把待补向量的节点交给 embedder 算完入库。窗口在时被调用(渲染进程才有 wasm 推理),
  // 所以必须可中断可重入 —— 人格随时可能被关掉, 下次起来接着补。
  async embedPending({ model, batch = 16, limit = 0, onProgress } = {}) {
    if (!this._embed) return { embedded: 0, remaining: 0, skipped: 'no-embedder' };
    const mdl = model || this.embedModel;
    if (!mdl) return { embedded: 0, remaining: 0, skipped: 'no-model' };
    this._fresh();
    const pending = this.store.pendingEmbed(mdl, limit);
    let done = 0;
    const { normalize } = require('../memory-vector');
    for (let i = 0; i < pending.length; i += batch) {
      const slice = pending.slice(i, i + batch);
      // e5 系列要求给文档加 passage: 前缀, 查询加 query: —— 少了这个前缀检索质量明显下降,
      // 而且失败方式是"结果看起来还行但就是不准", 不会报错。
      const texts = slice.map((r) => `passage: ${r.title || ''} ${r.description || ''}`.trim());
      let vecs;
      try { vecs = await this._embed(texts); } catch (_) { break; }
      if (!vecs || !vecs.length) break;
      this.store.transaction(() => {
        for (let j = 0; j < slice.length && j < vecs.length; j++) {
          const v = normalize(vecs[j]);
          this.store.putVector(slice[j].id, { dim: v.length, vec: v, model: mdl, srcHash: slice[j].srcHash });
          done++;
        }
      });
      this._vecCache = null;
      if (onProgress) { try { onProgress({ done, total: pending.length }); } catch (_) {} }
    }
    return { embedded: done, remaining: Math.max(0, pending.length - done), model: mdl };
  }

  embedStats() {
    this._fresh();
    const mdl = this.embedModel;
    const total = Object.keys(this._idx().nodes).length;
    const have = mdl ? this.store.vectorCount(mdl) : this.store.vectorCount();
    return { total, embedded: have, pending: Math.max(0, total - have), model: mdl || null };
  }

}

module.exports = V1SemanticMixin;
