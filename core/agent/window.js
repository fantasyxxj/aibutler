// window.js — 上下文窗口(= 占用百分比的分母)这摊事, 从 agent.js 拆出来。
//
// 为什么独立成文件: 窗口不是"一个数", 是一场**多来源仲裁** —— 我们查准的值、CLI 算的值、
// 正则猜的值、兜底常量, 四五个来源先后到达, 谁该赢得有规矩。规矩本身有历史(见下), 挤在
// agent.js 里只会被当成赋值语句读过去。
//
// 🔴 这摊事最容易犯的错, 两次都犯过, 形式不同根子一样 —— **拿到达顺序当可信度**:
//   2026-07-21  Math.max 只增不减 → 1M 换 200k 降不下来 → 压缩永不触发 → 撞真实上限
//   2026-10-01  谁后到谁算       → 我们查准的值被 CLI 的兜死常量 200000 冲掉
// 所以现在的机制是**档位**(agent/util.js 的 W_TIER): 每个值带着它的来源可信度, 低档不许
// 覆盖高档, 完全不看先后。换模型时档位清零 —— 那是这套机制唯一的破口, 漏了就等于没改。
'use strict';

const { windowFor, W_TIER, tierName } = require('./util');

class WindowMixin {
  /* 窗口赋值的**唯一入口** —— 按来源档位决定能不能写, 不看先后顺序。

     🔴 别绕过它直接赋 `this.window`: 那就退回"谁后到谁算", 我们查准的值会被 CLI 的猜测冲掉
        —— CLI 对认不出的 model id 一律给写死的 200000, 它到得比我们的配置晚, 于是赢。

     🔴 **不取 max**: 换成小窗口模型时必须能降下来, 否则分母虚高、压缩永不触发, 一路撑到
        API 报 prompt too long, 那时已经没得救了(压缩本身也要发一次全文)。

     首次定值(from=0)不打日志: 每个人格构造时都要走一遍, 打了全是噪声。 */
  _setWindow(value, tier, why = '') {
    if (!(value > 0)) return false;
    if (this._windowTier != null && tier > this._windowTier) return false;   // 低档不许覆盖高档
    if (value === this.window && tier === this._windowTier) return false;
    const from = this.window;
    const fromTier = this._windowTier;
    this.window = value;
    this._windowTier = tier;
    if (from > 0) {
      // 值没变只升了档也要打 —— 升完低档就压不进来了, 那是有意义的状态变更。但得说成"升档"
      // 而不是 `1000000 → 1000000`, 否则看着像噪声, 下次有人就把这行日志删了。
      // fromTier 为 null = 刚被 _applyModelWindow 清零过, 这是换模型后的重算, 不是"从 null 档升上来"
      const what = (from !== value)
        ? `${from} → ${value} (tier=${tierName(tier)})`
        : (fromTier == null
            ? `${value} 重算档位 → ${tierName(tier)}`
            : `${value} 档位 ${tierName(fromTier)} → ${tierName(tier)}`);
      console.log(`[window] ${this.name} ${what}${why ? ' · ' + why : ''}`);
    }
    return true;
  }

  /* 换模型 → **档位清零**, 按新模型重走一轮决议。
     🔴 清零不能省: "确知"是对某个具体模型确知的, 换了模型就不再适用。不清零的话旧模型的
        certain 值会把新模型的一切(包括新模型自己的 certain 值)全挡在外面 —— 那就是 2026-08-17
        那个"降不下来"的 bug 换了身衣服又回来。
     调用点必须覆盖所有改 model 的地方: 构造 · setModel 两个分支 · consume 的 init 分支 · restore。 */
  _applyModelWindow(model) {
    this._windowTier = null;
    const w = windowFor(model, this._windowCredName());
    return this._setWindow(w.value, w.tier, w.why);
  }

  // 走 API key 的人格用的是哪条凭据(名字) —— windows.json 可以按凭据分开记上限。
  // 订阅、行业版网关都不归凭据仓库管, 回空串, 只按模型名查。
  _windowCredName() {
    if (this.accessMode !== 'api' || (this.gateway && this.gateway.token)) return '';
    try {
      const c = require('./env').pickCredential(require('../host').settings, this.credentialId);
      return (c && c.name) || '';
    } catch (_) { return ''; }
  }

  // CLI 在每个 result 的 modelUsage 里按模型名给出 contextWindow(还带 canonicalModel /
  // provider —— 第三方网关偷换模型时, 那两个字段能看穿)。
  //
  // ⚠️ 这**不是服务端真值**, 别再这么标(2026-10-01 之前的注释和日志都这么标, 害得同一个问题
  // 连答错三轮)。它是 Claude Code 本地算的: 认不出的 model id 一律给 200000, id 含 `[1m]`
  // 就给 1000000; 服务端下发的那份模型目录里压根没有窗口字段(实测 11 个模型全部没有)。
  // 所以它进 cli 档(第 3 档), 压不住我们自己查准的 certain 档。
  // 完整的七档瀑布见记忆 [[reference_claude_code_window_resolution_order_decoded]]。
  //
  // modelUsage 含子代理调用, 所以只认当前模型那一条; 只有一条时直接用(网关改名的情况)。
  _adoptRealWindow(modelUsage) {
    if (!modelUsage) return;
    const keys = Object.keys(modelUsage);
    const key = modelUsage[this.model] ? this.model : (keys.length === 1 ? keys[0] : null);
    const w = key ? modelUsage[key].contextWindow : 0;
    if (!(w > 0)) return;
    const u = modelUsage[key] || {};
    this._setWindow(w, W_TIER.cli, `model=${key}`
      + `${u.canonicalModel && u.canonicalModel !== key ? ` canonical=${u.canonicalModel}` : ''}`
      + `${u.provider ? ` provider=${u.provider}` : ''}`);
    /* 🔴 **不主动告诉 AI 新窗口值**。AI 想知道自己叩 `context_usage` 工具 —— 那个返回实时
       `this.usage()`, 是唯一的真源。主动 submit notice 是错方向: ① 换模型时也要告诉? 谁定啥
       时候值得告诉。② submit 触发新 turn → 新 init → consume 的 windowFor 会重覆盖
       this.window(除非那里有守卫) → 又不等 → 又 submit → 死循环 (2026-09-04 现场 62 次
       [window] 就是这个)。守卫在 consume.js 的 init 分支, 但即便有守卫, 主动喂也是设计上错。 */
  }

  // 占用。**分子是真数**(服务端每条 assistant 消息的 usage 回的), **分母是仲裁出来的**
  // —— 两者可信度完全不同, 看 pct 时要记着这件事。
  usage() {
    const pct = this.window ? Math.round((this.lastInput * 1000) / this.window) / 10 : 0;
    return { inTok: this.lastInput, window: this.window, pct, model: this.model, windowTier: this._windowTier };
  }
}

module.exports = WindowMixin;
