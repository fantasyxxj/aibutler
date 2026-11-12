'use strict';
// 红线硬过滤 · 动作侧(PreToolUse) —— 「做事情前程序硬过滤」那一半。
//
// 为什么不能靠过 AI 的输出: agent.js 的 `for await` 是被动读流, 等 tool_use 出现在 butler
// 代码里时 Bash 已经跑完了 ——「我把进程杀了」被过滤出来时进程已经死了。
//
// 为什么命中之后是【打回】而不是【程序自动改】: 打回是给 AI 的激励信号, 自动改会消灭学习信号,
// AI 永远不知道自己漏了, 下次照漏。且真实对照不是"打回 vs 不打回"(那笔 token 本来就要烧),
// 而是"程序打回 vs 用户打回" —— 用户不知道正确做法, 只会反复试, 更贵还惹人烦。
//
// 🔴 打回必须配错误日志同批: 否则"我被打回过"只活在当前上下文, 清空一次就归零, 永远练不成经验。

// 输出侧的保留伪工具名。写成一个"工具"是为了两条通路共用一套 trigger_pattern 语法,
// 不必再造第二个字段; 真实 tool_name 永远不会等于它, 所以动作侧天然不会误吃输出侧的红线。
const OUTPUT_TOOL = 'output';

// trigger_pattern 语法: `工具名[,工具名…]:正则`
//   Bash:\brm\s+-rf                 只在 Bash 上匹配
//   Write,Edit:\.env$               多个工具共用一个正则
//   *:secret                        任意工具(仅动作侧 —— `*` 是"任意工具", 不含输出)
//   output:我是 Claude              输出侧: 过完整 assistant 文本
// 冒号后面整段都是正则(正则里可以有冒号), 所以只在第一个冒号处切。
// 记忆写法辅导开关(main/memory_coaching.json)。延迟取 host: 门禁里会单独 require 本文件, 那时宿主可能没接线。
const memoryCoachingOn = () => {
  try { return require('./host').cfg.json('main/memory_coaching').enabled !== false; } catch (_) { return true; }
};

function parseTrigger(pattern) {
  const raw = String(pattern || '').trim();
  if (!raw) return null;
  const cut = raw.indexOf(':');
  if (cut < 0) return null;
  const toolPart = raw.slice(0, cut).trim();
  const rePart = raw.slice(cut + 1);
  if (!rePart) return null;
  let re;
  // 正则写错不该让整个守卫崩掉 —— 崩了等于所有红线一起失效, 比漏一条严重得多。
  try { re = new RegExp(rePart, 'i'); } catch { return null; }
  const tools = toolPart === '*' ? null
    : new Set(toolPart.split(',').map((t) => t.trim()).filter(Boolean));
  return { tools, re };
}

// 立红线那一刻校验它能不能真的触发。不校验的代价是【静默】: 写成自然语言或漏了冒号,
// parseTrigger 返回 null, 动作侧和输出侧双双跳过 —— 红线安安静静地永不生效, 没有任何报错。
// 那比没有红线更坏: 以为程序兜着, 于是不再自己留神。
// 2026-08-26 实测库里三条红线全是这么死的(两条写 `memory_upsert`, 一条写中文句子)。
// 返回 { ok, enforced, reason }:
//   ok=false     写错了 —— 拒收(写错和不写是两回事, 写错的人以为自己写对了)
//   enforced=false 没写 —— 收, 但这条只是【标了严重性】, 程序不会拦它
//   enforced=true  能拦
// 🔴 不写 ≠ 不该立: 不是所有命题都能正则表达(典型是违反形态为"遗漏"的, 比如"哪里来哪里回" ——
// 一个没发生的工具调用不产生任何可匹配的东西)。拿"能不能正则"去否决一条命题, 是让机制阉割内容。
// 但也不能假装拦得住: 所以这里如实返回 enforced=false, 由调用方把话说明白。
function validateTrigger(pattern) {
  const raw = String(pattern || '').trim();
  if (!raw) {
    return { ok: true, enforced: false,
      reason: '没写触发模式 —— 程序拦不住它, 只是给这条标了"违反会出事故"。要靠自己记得, 或用 memory_admin(op="redlines") 查' };
  }
  if (!raw.includes(':')) {
    return { ok: false, enforced: false, reason: '缺冒号。格式是 `工具名[,工具名…]:正则`，例如 `Bash:\\brm\\s+-rf` / `output:我是 Claude` / `*:secret`。真表达不成正则就【整个留空】，别写人话' };
  }
  if (!parseTrigger(raw)) return { ok: false, enforced: false, reason: '冒号后面的正则为空或语法错误' };
  return { ok: true, enforced: true };
}

// 匹配对象是【代码】(命令行/路径/参数), 不是自然语言 —— 所以用正则, 语义模型对代码没用。
function haystackOf(toolName, toolInput) {
  if (toolInput == null) return String(toolName || '');
  if (typeof toolInput === 'string') return `${toolName} ${toolInput}`;
  let flat;
  try { flat = JSON.stringify(toolInput); } catch { flat = String(toolInput); }
  return `${toolName} ${flat}`;
}

function matchRedlines(redlines, toolName, toolInput) {
  const hay = haystackOf(toolName, toolInput);
  const hit = [];
  for (const r of redlines || []) {
    const t = parseTrigger(r.trigger_pattern);
    if (!t) continue;                                   // 没写触发模式的红线走输出侧, 不在这里拦
    if (t.tools && !t.tools.has(toolName)) continue;
    if (!t.re.test(hay)) continue;
    hit.push(r);
  }
  // 硬拒优先于硬提醒: 同一个动作既撞 block 又撞 warn 时, 按严的那条处理。
  return hit.sort((a, b) => (a.level === 'block' ? -1 : 1) - (b.level === 'block' ? -1 : 1));
}

class RedlineGuard {
  // maxBlocks: 同一条红线在同一个动作上最多打回几次。到顶还犯就放行 + 记错误日志 ——
  // 防的是无限打回把 token 烧干, 而不是纵容(放行那次进的是错误日志, 比拦下更该被看见)。
  constructor(graph, { maxBlocks = 2, log = console.error } = {}) {
    this.graph = graph;
    this.maxBlocks = maxBlocks;
    this.log = log;
    this._blocks = new Map();   // key -> 已打回次数
  }

  // v1 引擎没有铁律表。用能力判版本比读环境变量准(测试可以直接 new 一个 V2 进来)。
  get enabled() { return !!this.graph && typeof this.graph.redlines === 'function'; }

  _key(nodeId, toolName, toolInput) {
    return `${nodeId}|${toolName}|${haystackOf(toolName, toolInput).slice(0, 400)}`;
  }

  // 返回 null = 放行; 返回 {reason, redline} = 该拦。
  // 单独抽出来是为了能脱开 SDK 直接测 —— 挂上 SDK 才能测的东西等于测不了。
  decide(toolName, toolInput) {
    if (!this.enabled) return null;
    let all;
    try { all = this.graph.redlines(); } catch (e) { this.log('[redline] 读铁律表失败:', e.message); return null; }
    const hits = matchRedlines(all, toolName, toolInput);
    if (!hits.length) return null;
    const r = hits[0];

    // warn 只提醒不拦 —— 拦是 block 的语义。混作一谈的代价不是多拦几次, 而是 warn 这一档
    // 事实上不存在: 立红线的人以为选了轻的那档, 拿到的却是硬拒。
    if (r.level !== 'block') {
      const wkey = `warn|${r.node_id}`;
      if (this._blocks.has(wkey)) return null;          // 同一轮同一条只提醒一次
      this._blocks.set(wkey, 1);
      this._note(r, toolName, toolInput, '提醒(warn, 未拦)');
      return { level: 'warn', reason: this._reason(r, '这次没拦你, 动作照常执行 —— 但下手前照正确做法核一眼。', '⚠️ 提醒'), redline: r };
    }

    const key = this._key(r.node_id, toolName, toolInput);
    const seen = this._blocks.get(key) || 0;
    if (seen >= this.maxBlocks) {
      // 到顶放行。这一条**必须**落错误日志: 它是"红线拦了两次都没纠正过来"的现场,
      // 比被拦下的那两次更值得回头看。
      this._note(r, toolName, toolInput, `打回 ${seen} 次仍未纠正, 已放行`);
      return null;
    }
    this._blocks.set(key, seen + 1);
    this._note(r, toolName, toolInput, `第 ${seen + 1} 次打回`);

    return { level: 'block', reason: this._reason(r, '这次动作已被拦下。按正确做法重来; 确实需要这么做就先问用户。'), redline: r };
  }

  // 输出侧: 过完整 assistant 文本。管的是动作侧拦不住的那半 —— 自称 Claude、给文件不给绝对路径、
  // 默认包 speak。只能打回重说(输出类不能弹窗问用户: 那是说话中间, 每句弹一次是灾难)。
  //
  // 计数刻意按【红线】记而不按【文本】记: 打回后模型会换一种说法重说, 按文本记数等于永远记不满,
  // 会无限打回。动作侧按文本记是对的(同一条命令才算同一次犯), 两侧语义本来就不同。
  decideOutput(text) {
    if (!this.enabled) return null;
    const body = String(text || '');
    if (!body.trim()) return null;
    let all;
    try { all = this.graph.redlines(); } catch (e) { this.log('[redline] 读铁律表失败:', e.message); return null; }

    const hits = [];
    for (const r of all || []) {
      const t = parseTrigger(r.trigger_pattern);
      // 要求显式写 output —— `*` 是"任意工具"的意思, 不该顺带把输出也吃掉
      if (!t || !t.tools || !t.tools.has(OUTPUT_TOOL)) continue;
      if (!t.re.test(body)) continue;
      hits.push(r);
    }
    if (!hits.length) return null;
    const r = hits.sort((a, b) => (a.level === 'block' ? -1 : 1) - (b.level === 'block' ? -1 : 1))[0];

    // 输出侧没有"放行并附一句提示"的口子(additionalContext 是 PreToolUse 才有的),
    // 所以 warn 在这边只能记账放行 —— 把话说出去, 但留下现场。
    if (r.level !== 'block') {
      const wkey = `warn|out|${r.node_id}`;
      if (!this._blocks.has(wkey)) {
        this._blocks.set(wkey, 1);
        this._note(r, OUTPUT_TOOL, body, '提醒(warn, 未打回)');
      }
      return null;
    }

    const key = `${r.node_id}|${OUTPUT_TOOL}`;
    const seen = this._blocks.get(key) || 0;
    if (seen >= this.maxBlocks) {
      this._note(r, OUTPUT_TOOL, body, `打回 ${seen} 次仍未纠正, 已放行`);
      return null;
    }
    this._blocks.set(key, seen + 1);
    this._note(r, OUTPUT_TOOL, body, `第 ${seen + 1} 次打回`);
    /* 输出红线是在流式之后才判的: 打回的那一刻, 这条回复其实**已经显示在对方屏幕上**了。
       说「没有发出去」会让人格整段重说一遍, 对方看到两份(2026-11-02 老师人格实撞)。 */
    return { reason: this._reason(r, '这条回复已经显示在对方屏幕上。只把撞线的那一处按正确做法改对, 补一句即可, 其余内容不要重复(别道歉别解释过程)。'), redline: r };
  }

  // 「正确做法」是必填字段: 填不出来说明这条红线本身没写清楚, 那它不该进表。
  // 所以这里可以直接把它当成打回话术的主体。
  // header 分档: warn 没拦人却说"撞到红线", 读的人会以为动作没发生出去 —— 那比不提示更坏。
  _reason(r, tail, header = '🔴 撞到红线') {
    return [
      `${header}: ${r.title || r.slug || ''}`,
      r.claim ? `规矩: ${r.claim}` : '',
      r.correct_action ? `正确做法: ${r.correct_action}` : '',
      tail,
    ].filter(Boolean).join('\n');
  }

  _note(r, toolName, toolInput, note) {
    const raw = `[${toolName}] ${require('./lone-surrogate').head(haystackOf(toolName, toolInput), 500)} — ${note}`;   // 截断不切开 emoji
    try {
      if (typeof this.graph.noteViolation === 'function') this.graph.noteViolation(r.node_id);
      if (typeof this.graph.logError === 'function') this.graph.logError({ node_id: r.node_id, raw });
    } catch (e) { this.log('[redline] 记账失败:', e.message); }
  }

  // 挂到 SDK options.hooks.PreToolUse。签名与返回形状按 sdk.d.ts:
  //   HookCallback = (input, toolUseID, {signal}) => Promise<HookJSONOutput>
  //   deny 走 hookSpecificOutput.permissionDecision, 且 sdk.d.ts 明写
  //   「PreToolUse hook denies bypass canUseTool」→ 与 permissionMode:'bypassPermissions' 不冲突。
  hook() {
    return async (input) => {
      let verdict = null;
      // 🔴 守卫自己抛异常绝不能挡住工具调用: 记忆坏了是我的问题, 不该让用户干不了活。
      try { verdict = this.decide(input && input.tool_name, input && input.tool_input); }
      catch (e) { this.log('[redline] 守卫异常, 放行:', e.message); return {}; }
      // 放行返回 {} 而不是 {continue:true}: 前者是行业版 fs-guard 真会话验证过的形状,
      // 语义是"不干预, 交回正常权限流程"。
      if (!verdict) return {};
      // warn 走 index-guard 那条路: 不给 permissionDecision = 不干预权限流程, 只顺路把话带到。
      if (verdict.level !== 'block') {
        // 记忆写法辅导关着时(行业版), memory_* 的 warn 只记账不递话 —— 递过去会被当成店主的话回给店主。
        if (/memory_/.test(String(input && input.tool_name)) && !memoryCoachingOn()) return {};
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: verdict.reason } };
      }
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: verdict.reason,
        },
      };
    };
  }

  // 每轮开始清计数: 上限是"这一轮别无限打回", 不是"这条红线一辈子只拦两次"。
  resetTurn() { this._blocks.clear(); }
}

module.exports = { RedlineGuard, matchRedlines, parseTrigger, validateTrigger, haystackOf, OUTPUT_TOOL };
