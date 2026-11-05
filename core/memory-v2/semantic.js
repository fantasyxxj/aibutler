// 语义检索: embedder 注入 · 向量补算 · 融合开关
// 由 memory-v2.js 拆出(内核抽包第 2 步)。方法体逐字搬运, 经 mixin 挂回 MemoryGraphV2.prototype。
const { nowLocalISO, VECTOR_TAG } = require('../memory');
const { cosine } = require('../memory-vector');

class SemanticMixin {
  // —— 语义层(与 v1 同构: 同步路只用已算好的查询向量, 异步由调用方先算) ——
  // 接算子的同时把模型标签落库。v1 是构造函数里写死的, v2 改成读 meta 之后一直没人写过它 ——
  // 后果不是功能坏(取向量时空标签会回落成"全取"), 而是 embedStats().model 恒空, 对外显示成
  // 「模型 (未装)」, 而模型文件其实好端端在。排查时这句假话会把人引向完全错误的方向。
  setEmbedder(fn) {
    this._embed = fn;
    if (!this.embedModel) { try { this.setEmbedModel(VECTOR_TAG); } catch (_) {} }
    return this;
  }
  hasEmbedder() { return typeof this._embed === 'function'; }
  setQueryVector(v) { this._queryVec = v; return this; }
  semanticFusionOn() { return this.store.getMeta('semantic_fusion') !== '0'; }
  setSemanticFusion(on) { this.store.setMeta('semantic_fusion', on ? '1' : '0'); }

  _semanticRanking() {
    if (!this._queryVec || !this.semanticFusionOn()) return [];
    const vecs = this._allVectors();
    if (!vecs.length) return [];
    const out = [];
    for (const v of vecs) {
      if (!v.vec || v.vec.length !== this._queryVec.length) continue;
      out.push({ id: v.id, score: cosine(this._queryVec, v.vec) });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  // 全库向量常驻内存。🔴 不缓存时每次检索都从 SQLite 整表重读: 3629 条实测 107ms 且随条数线性涨,
  // 而拿一条查询向量跟全库比余弦只要 2ms(10.9 万条也才 49ms) —— 慢的是读, 不是算。
  // 失效靠 store.vectorRev(): 本连接写向量 / 图变了 / 别的连接提交过, 任一变了就整份重读。
  // ⚠️ 返回共享数组, 调用方只读不改。
  _allVectors() {
    const model = this.store.getMeta('embed_model') || '';
    const rev = `${model}|${this.store.vectorRev()}`;
    if (this._vecSnap && this._vecSnap.rev === rev) return this._vecSnap.vecs;
    const vecs = this.store.allVectors(model || undefined);
    this._vecSnap = { rev, vecs };
    return vecs;
  }

  // 拿一段文本跟全库向量比, 返回余弦 ≥ min 的有效节点(按余弦降序, 最多 k 条)。
  // 用途是新建时的「像不像已有的哪条」—— 文档侧编码, 跟库里向量同一配方(passage: title claim keywords)。
  // 没算子 / 没开语义 / 推理失败一律返回空: 这是提示, 不能挡保存。
  async similarTo(text, { min = 0.96, k = 2, exclude = null } = {}) {
    if (!text || !this._embed || !this.semanticOptedIn()) return [];
    let q;
    try { q = ((await this._embed([`passage: ${text}`])) || [])[0]; } catch (_) { return []; }
    if (!q) return [];
    const { normalize } = require('../memory-vector');
    q = normalize(q);
    const out = [];
    for (const v of this._allVectors()) {
      if (v.id === exclude || !v.vec || v.vec.length !== q.length) continue;
      const c = cosine(q, v.vec);
      if (c < min) continue;
      const m = this.store.node(v.id);
      if (!m || (m.status || 'active') !== 'active') continue;
      out.push({ id: v.id, slug: m.slug, claim: m.claim || '', cos: Math.round(c * 1000) / 1000 });
    }
    return out.sort((a, b) => b.cos - a.cos).slice(0, k);
  }

  get embedModel() { return this._embedModel || this.store.getMeta('embed_model') || ''; }
  setEmbedModel(m) { this._embedModel = m; this.store.setMeta('embed_model', m); return this; }

  // 库里已经有向量 = 当然是开着的(本标记之前补齐过的老库没有 meta, 不能因此被当成没开)。
  semanticOptedIn() {
    if (this.store.getMeta('semantic_optin')) return true;
    return this.embedModel ? this.store.vectorCount(this.embedModel) > 0 : false;
  }
  markSemanticOptIn() { this.store.setMeta('semantic_optin', nowLocalISO()); }

  async prepareSemantic(q, { semantic = true } = {}) {
    // 没 opt-in(库里一条向量都没有)就别去算查询向量 —— 那是一次白等的 wasm 推理, 结果注定用不上。
    if (!semantic || !this._embed || !q || !this.semanticFusionOn() || !this.semanticOptedIn()) return () => {};
    try {
      // e5 要求查询侧带 query: 前缀、文档侧带 passage: —— 少了不报错, 只是变得不准。
      const vecs = await this._embed([`query: ${q}`]);
      this._queryVec = (vecs && vecs[0]) || null;
    } catch (_) { this._queryVec = null; }
    return () => { this._queryVec = null; };
  }

  async queryAsync(q, opts = {}) {
    const release = await this.prepareSemantic(q, opts);
    try { return this.query(q, opts); } finally { release(); }
  }

  // 写入后顺手补新节点的向量。故意不 await: 沉记忆的回执不该等推理。
  kickEmbed({ limit = 32 } = {}) {
    if (this._embedKicking || !this._embed || !this.semanticOptedIn()) return;
    this._embedKicking = true;
    Promise.resolve()
      .then(() => this.embedPending({ limit }))
      .then((r) => {
        this._embedKicking = false;
        // 补算期间又写入是常态(连着沉两条), 那条新节点不在本轮快照里, 所以跑完再看一眼。
        if (r && r.embedded > 0 && this.embedStats().pending > 0) this.kickEmbed({ limit });
      })
      .catch(() => { this._embedKicking = false; });
  }

  async embedPending({ model, batch = 16, limit = 0, onProgress } = {}) {
    if (!this._embed) return { embedded: 0, remaining: 0, skipped: 'no-embedder' };
    const mdl = model || this.embedModel;
    if (!mdl) return { embedded: 0, remaining: 0, skipped: 'no-model' };
    // 🔴 用【显示语言那一份译文】去编码, 不是简体原文 —— 日本の店では質問も日本語で来る。
    // 跨语言で比べると類似度が全体的に低く、しかも互いに開かないので順位がつかない
    // (実測: 上位が軒並み 0.78〜0.82 に固まる)。pick は訳文が無ければ源語に落ちる。
    const { pick } = require('./lang');
    const pending = this.store.pendingEmbed(mdl, limit, (r) => pick(r));
    const { normalize } = require('../memory-vector');
    let done = 0;
    for (let i = 0; i < pending.length; i += batch) {
      const slice = pending.slice(i, i + batch);
      // 🔴 这三段必须与 contentHash 的配方【逐字一致】, 否则指纹说"没变"而实际编码内容变了。
      // v1 就是不一致的: 指纹算 title+description+body, 编码只喂 title+description ——
      // 后果是改一次正文触发全条重算, 而算出来的向量和原来一模一样。白烧一次推理。
      const texts = slice.map((r) => `passage: ${r.title || ''} ${r.claim || ''} ${r.keywords || ''}`.trim());
      let vecs;
      // 🔴 吞掉这里的错, 等于让「模型没装好」长成「语义检索没结果」—— 功能看着在、就是不准,
      // 正是 embed-host.js 开头那段注释点名要避免的那类故障。只报第一次: 整批会连着失败,
      // 刷屏对诊断没有增量。
      try { vecs = await this._embed(texts); }
      catch (e) {
        if (!this._embedErrShown) {
          this._embedErrShown = true;
          console.error('[embed] 推理失败, 语义检索退回纯字面:', (e && e.message) || e);
        }
        break;
      }
      if (!vecs || !vecs.length) break;
      this.store.transaction(() => {
        for (let j = 0; j < slice.length && j < vecs.length; j++) {
          const v = normalize(vecs[j]);
          this.store.putVector(slice[j].id, { dim: v.length, vec: v, model: mdl, srcHash: slice[j].srcHash });
          done++;
        }
      });
      if (onProgress) { try { onProgress({ done, total: pending.length }); } catch (_) {} }
    }
    return { embedded: done, remaining: Math.max(0, pending.length - done), model: mdl };
  }

  embedStats() {
    const mdl = this.embedModel;
    const total = Object.keys(this.store.allNodes()).length;
    const have = mdl ? this.store.vectorCount(mdl) : this.store.vectorCount();
    return { total, embedded: have, done: have, pending: Math.max(0, total - have), model: mdl || null };
  }

}

module.exports = SemanticMixin;
