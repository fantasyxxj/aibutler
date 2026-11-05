'use strict';
// primitives-media.js — 插件原语里碰声音和本地媒体的三个: record(录音) · pron(发音评测) · asset(读本地资源)。
// 从 commands.js 拆出来(那边到了行数上限), 由它的 PRIMITIVES 展开收进去; 约定与那边相同:
// 做什么只从声明读, 真正碰外界的动作由 ctx 注入, 本文件在纯 node 下跑得动。
const pronAssess = require('./pron-assess.js');

module.exports = {
  /* 录音。插件沙箱里没有麦克风(不是安全上下文, navigator.mediaDevices 不存在),
     所以由宿主页代录, 录好的 wav 落在**这个包自己的**录音目录, 只交回 { id, path, duration_sec }。
     🔴 做什么只从声明的 op 读(warm / start / stop / cancel / play), 包里一条命令只干一件事。
        warm = 界面一显示就调: 窗口在前台时先把麦克风开着、只在内存里留最近 0.5 秒, start 时接在最前面
        (人一按下就开口, 而开麦要时间); stop 后宿主再多收 0.5 秒才停。
     🔴 时长上限 max_sec 写在声明里(默认 60, 最多 300), 到点宿主自己停 —— 包忘了 stop 麦克风也会关。
     🔴 play 只认 id, 不收路径: 读得到的只有本包录过的那几段。 */
  async record(args, ctx, decl) {
    const op = String((decl && decl.op) || '').trim();
    if (!['warm', 'start', 'stop', 'cancel', 'play'].includes(op)) {
      return { ok: false, code: 'bad_decl', message: 'record: op 只能是 warm / start / stop / cancel / play' };
    }
    if (typeof ctx.record !== 'function') {
      return { ok: false, code: 'no_record', message: 'record: 这个版本录不了音' };
    }
    const n = Number(decl.max_sec);
    const maxSec = Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), 300) : 60;
    const id = String((args && args.id) || '').trim();
    if (op === 'play' && !/^[0-9a-z-]{1,40}$/.test(id)) {
      return { ok: false, code: 'bad_param', message: 'record: play 要给 stop 交回的 id' };
    }
    const r = await ctx.record(op, { pkg: decl.pkg, maxSec, id });
    if (!r || !r.ok) {
      return { ok: false, code: (r && r.code) || 'record_failed', message: (r && r.message) || '没录成' };
    }
    return { ok: true, message: '', data: r.data };
  },

  /* 发音评测: 本包录的一段(record 原语交回的 id) + 原文 + 语言 → 整段分和逐词分(core/pron-assess.js 连续识别)。
     原文不给 = 自由回答(只评发音和流利, 回听到的文字); 另回时长、语速、长停顿、填充词。
     key 是用户自己的 Azure key, 跟 secret 原语同一个金库、按包存, **没有读出原文的 op**;
     区不是秘密, status 照实回。op 从声明读: status / key_set / key_clear / assess。
     key_set 不给区就拿 key 去各区试(不计费), 认出来的区一起存; 哪个区都不认就不存, 说清楚。 */
  async pron(args, ctx, decl) {
    const op = String((decl && decl.op) || '').trim();
    if (!['status', 'key_set', 'key_clear', 'assess'].includes(op)) {
      return { ok: false, code: 'bad_decl', message: 'pron: op 只能是 status / key_set / key_clear / assess' };
    }
    const vault = ctx.pkgSecrets;
    if (!vault) return { ok: false, code: 'no_secret_store', message: 'pron: 这个版本没有存密钥的地方' };
    const pkg = decl.pkg;
    const region = () => vault.get(pkg, 'azure_region') || '';
    if (op === 'status') return { ok: true, message: '', data: { set: !!vault.get(pkg, 'azure_key'), region: region(), regions: pronAssess.REGIONS } };
    if (op === 'key_clear') {
      vault.handle(pkg, 'clear', { name: 'azure_key' }); vault.handle(pkg, 'clear', { name: 'azure_region' });
      return { ok: true, message: '', data: { set: false } };
    }
    if (op === 'key_set') {
      const key = String((args && args.key) || '').trim();
      if (!key) return { ok: false, code: 'missing_param', message: 'pron: 没有 key' };
      let rg = String((args && args.region) || '').trim();
      if (rg && rg !== 'auto') {
        if (!pronAssess.REGIONS.includes(rg)) return { ok: false, code: 'bad_param', message: `pron: 不认识的区 ${rg}` };
        const okIn = await pronAssess.keyWorksIn(key, rg, ctx.fetch);
        if (okIn === false) return { ok: false, code: 'bad_key', message: `pron: 这把 key 在 ${rg} 不认` };
      } else {
        rg = await pronAssess.detectRegion(key, ctx.fetch);
        if (!rg) return { ok: false, code: 'bad_key', message: 'pron: 哪个区都不认这把 key, 请检查 key 或手动选区' };
      }
      const a = vault.handle(pkg, 'set', { name: 'azure_key', value: key });
      if (!a.ok) return a;
      vault.handle(pkg, 'set', { name: 'azure_region', value: rg });
      return { ok: true, message: '', data: { set: true, region: rg } };
    }
    // assess
    const id = String((args && args.id) || '').trim();
    const text = String((args && args.text) || '').trim();
    const lang = String((args && args.lang) || 'en-US').trim();
    if (!/^[0-9a-z-]{1,40}$/.test(id)) return { ok: false, code: 'bad_param', message: 'pron: 要给 record stop 交回的 id' };
    if (!/^[a-z]{2,3}-[A-Z]{2}$/.test(lang)) return { ok: false, code: 'bad_param', message: `pron: 语言写成 en-US 这种形状(收到 ${lang})` };
    if (typeof ctx.recordFile !== 'function') return { ok: false, code: 'no_record', message: 'pron: 这个版本没有录音' };
    const wav = ctx.recordFile(pkg, id);
    if (!wav) return { ok: false, code: 'recording_not_found', message: `pron: 没有这段录音 ${id}` };
    const key = vault.get(pkg, 'azure_key');
    if (!key) return { ok: false, code: 'no_key', message: 'pron: 还没填 Azure key' };
    try {
      const engine = ctx.pronEngine || pronAssess.assessStream;   // 门禁注入假引擎, 不花额度
      const r = await engine({ wav, reference: text, lang, key, region: region() });
      return { ok: true, message: '', data: r };
    } catch (e) {
      return { ok: false, code: e.code || 'assess_failed', message: `pron: ${e.message}` };
    }
  },

  /* 读本地图片 / 音频 / 视频(core/asset-bridge.js)。op 从声明读: list / url / pick / forget。
     能读的只有包自己的素材目录和用户在打开框里挑过的文件; 交回的是地址, 包拿不到路径。
     pick 要弹框, 只给人按(登记时已定)。 */
  async asset(args, ctx, decl) {
    const op = String((decl && decl.op) || '').trim();
    if (typeof ctx.asset !== 'function') return { ok: false, code: 'no_asset', message: 'asset: 这个版本读不了本地资源' };
    const r = await ctx.asset(decl.pkg, op, args || {}, decl);
    if (!r || !r.ok) return { ok: false, code: (r && r.code) || 'asset_failed', message: (r && r.message) || '没读成' };
    return { ok: true, message: '', data: r.data };
  },
};
