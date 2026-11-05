#!/usr/bin/env node
// test-model-switch.js — 切模型之后, 上下文上限不许乱。
//
// 病根(作者 2026-08-17 21:47 一句话问出来的):「切换之后, 上下文上限会不会乱?」——会。
// 原先 init 分支写的是 `this.window = Math.max(this.window, windowFor(msg.model))`, 只增不减
// (2026-07-21 为"1M bug"止血加的), 于是:
//   1M 的模型换成 200k 的 → 分母仍停在 1M → 占用只显示实际的 1/5 → 自动压缩永远够不着阈值
//   → 一路撞上真实的 200k 上限报错。
// 而且 window 会被 exportState/restore 持久化, 关标签重开也救不回来(读回旧值又被 max 保住)。
//
// 修法: window 永远是 model 的函数, 不是一个自己累积的状态。
'use strict';

require('./host-wiring');   // 个人版宿主接线: 直接 require core 模块的进程都得先接
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Butler } = require('../core/agent');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}`); } };
const eq = (a, b, m) => ok(a === b, `${m}${a === b ? '' : ` — 期望 ${b}, 实得 ${a}`}`);

const HOME = path.join(os.tmpdir(), 'model-switch-test');
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });

const mk = (opts) => new Butler(HOME, { name: '测试', ...opts });

console.log('\n[窗口是模型的函数]');
{
  const b = mk();
  // 走 restore 这条路验 windowFor 的取值(它不导出, 但 restore 是它唯一的公开入口)
  b.restore({ model: 'claude-opus-5[1m]' });
  eq(b.window, 1000000, 'Opus 5 [1m] → 1M');
  b.restore({ model: 'claude-sonnet-4-6' });
  eq(b.window, 200000, 'Sonnet 4.6 → 200k');
  b.restore({ model: 'claude-haiku-4-5-20251001' });
  eq(b.window, 200000, 'Haiku 4.5 → 200k');
}

console.log('\n[🔴 大窗口换小窗口: 分母必须跟着降]');
{
  const b = mk();
  b.restore({ model: 'claude-opus-5[1m]' });
  eq(b.window, 1000000, '先在 1M 模型上');
  // 关标签重开 = exportState 存下来, 新实例 restore 回去
  const saved = b.exportState();
  eq(saved.window, 1000000, '存下来的确实是 1M');
  const b2 = mk();
  b2.restore({ ...saved, model: 'claude-sonnet-4-6' });   // 用户切成了 200k 的模型
  eq(b2.window, 200000,
    '🔴 存的是 1M 但模型已换成 200k → 按模型算, 不能把旧的 1M 读回来');
}

console.log('\n[小窗口换大窗口: 也要跟着涨(不然白白省着不用)]');
{
  const b = mk();
  b.restore({ model: 'claude-sonnet-4-6', window: 200000 });
  b.restore({ model: 'claude-opus-5[1m]', window: 200000 });
  eq(b.window, 1000000, '模型说 1M 就是 1M, 不受存下来的 200k 拖累');
}

console.log('\n[没有模型名时: 保持不动, 别乱降]');
{
  const b = mk();
  b.restore({ window: 777000 });
  eq(b.window, 777000, '没模型名 → 沿用存下来的值');
  const b2 = mk();
  b2.restore({});
  eq(b2.window, 1000000, '什么都没有 → 默认 1M(探测失败时 1M 比 200k 更保守, 不会误触压缩)');
}

console.log('\n[占用百分比: 分母错了这里就全错]');
{
  const b = mk();
  b.restore({ model: 'claude-sonnet-4-6', lastInput: 100000 });
  const u = b.usage();
  eq(u.window, 200000, '窗口 200k');
  eq(u.pct, 50, '10 万 tok 在 200k 窗口里是 50%(若分母残留 1M 会显示成 10%, 压缩就永远不触发)');
}

console.log('\n[🔴 防回归: 改 model 的地方必须走 _applyModelWindow]');
{
  // 为什么守这个而不是守"不含 Math.max": 换模型时**档位必须清零**, 而清零只发生在
  // _applyModelWindow 里。谁要是图省事写回 `this.window = ...` 或 `this._setWindow(...)`,
  // 旧模型的 certain 档就会把新模型的值全挡住 —— 那就是 2026-08-17「降不下来」换身衣服回来。
  const src = require('./kernel-src').kernelSource();
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//'));
  const initLine = code.find((l) => l.includes('this.model = msg.model'));
  ok(!!initLine, '找得到 init 里认新模型那行');
  const nextIdx = code.indexOf(initLine) + 1;
  ok(/_applyModelWindow\(msg\.model\)/.test(code[nextIdx] || ''),
    '🔴 紧接着就调 _applyModelWindow(msg.model) —— 档位清零靠它, 直接赋 window 就是回归');
  // 所有改 this.model 的地方都得配一次清零, 一处不漏
  const setsModel = code.filter((l) => /this\.model = (next|msg\.model)\b/.test(l)).length;
  const applies = code.filter((l) => /_applyModelWindow\(/.test(l)).length;
  ok(applies >= setsModel,
    `🔴 改 model 的地方(${setsModel} 处)每处都有 _applyModelWindow(共 ${applies} 处调用) —— 漏一处那条路径上的档位就不清零`);
  ok(!code.some((l) => /this\.window = windowFor\(/.test(l)),
    '🔴 没有任何地方再绕过档位直接 `this.window = windowFor(...)`');
}

console.log('\n[🔴 档位: 低档不许覆盖高档]');
{
  const { W_TIER } = require('../core/agent/util');

  // cli 档(3) 压得住 guess 档(4) —— 网关模型名一条规则都匹配不上, 猜的让位给 CLI
  const b = mk();
  b.restore({ model: 'deepseek-v4-pro' });
  eq(b.usage().windowTier, W_TIER.default, '一条规则都不匹配 → 落 defaultWindow, 档位是 default');
  b._adoptRealWindow({ 'deepseek-v4-pro': { contextWindow: 128000 } });
  eq(b.window, 128000, 'cli 档压得住猜的');
  eq(b.usage().windowTier, W_TIER.cli, '档位跟着一起变成 cli');

  // 🔴 certain 档(1) 压得住 cli 档(3) —— 这就是本次改动要解决的那个 bug:
  // 以前 CLI 对认不出的 model id 一律给写死的 200000, 它到得晚, 于是把我们查准的值冲掉。
  const b2 = mk();
  b2.restore({ model: 'whatever-gw-model' });
  b2._setWindow(131072, W_TIER.certain, '测试·确知');
  eq(b2.window, 131072, '确知值先写进去');
  b2._adoptRealWindow({ 'whatever-gw-model': { contextWindow: 200000 } });
  eq(b2.window, 131072, '🔴 CLI 那个 200000 压不住确知值 —— 这正是以前被冲掉的地方');
  eq(b2.usage().windowTier, W_TIER.certain, '档位仍是 certain, 没被降级');

  // 同档可以互相覆盖(后一个 cli 值取代前一个, 否则换会话拿不到新窗口)
  const b3 = mk();
  b3.restore({ model: 'gw-x' });
  b3._adoptRealWindow({ 'gw-x': { contextWindow: 200000 } });
  b3._adoptRealWindow({ 'gw-x': { contextWindow: 64000 } });
  eq(b3.window, 64000, '同档后到的覆盖先到的');

  // 非法值不许写坏已有的
  const b4 = mk();
  b4.restore({ model: 'claude-opus-5[1m]' });
  ok(b4._setWindow(0, W_TIER.certain) === false, '0 不许写');
  ok(b4._setWindow(-1, W_TIER.certain) === false, '负数不许写');
  eq(b4.window, 1000000, '非法值被挡住, 原值不动');
}

console.log('\n[🔴 换模型: 档位必须清零, 否则旧模型的确知值挡住新模型]');
{
  const { W_TIER } = require('../core/agent/util');
  const b = mk();
  b.restore({ model: 'old-gw-model' });
  b._setWindow(131072, W_TIER.certain, '对 old-gw-model 确知');
  eq(b.window, 131072, '旧模型上是确知档');
  // 换到一个 1M 的模型 —— 不清零的话 certain(1) 会把 guess(4) 的 1M 挡在外面
  b._applyModelWindow('claude-opus-5[1m]');
  eq(b.window, 1000000, '🔴 换模型后拿到新模型该有的 1M, 不被旧模型的 certain 挡住');
  eq(b.usage().windowTier, W_TIER.guess, '档位也重新按新模型算');
}

console.log('\n[🔴 确知表 models/windows.json: 不存在是正常状态, 存在就压倒一切]');
{
  const { W_TIER } = require('../core/agent/util');
  const cfg = require('./config-loader');
  const overrideRoot = cfg.overrideRoot();
  const wpath = overrideRoot ? path.join(overrideRoot, 'models', 'windows.json') : null;
  const had = wpath && fs.existsSync(wpath);
  const backup = had ? fs.readFileSync(wpath, 'utf8') : null;

  // 不存在 → 不许抛, 走正常的 guess/default
  if (had) fs.rmSync(wpath, { force: true });
  cfg._clearCache();
  let threw = null;
  try { const b = mk(); b.restore({ model: 'claude-opus-5[1m]' }); eq(b.window, 1000000, '表不存在 → 照常走正则猜'); }
  catch (e) { threw = e; }
  ok(!threw, `🔴 确知表缺失不许抛异常(多数机器上它一辈子不存在)${threw ? ' — ' + threw.message : ''}`);

  // 存在 → certain 档, 连 CLI 都压不住
  if (wpath) {
    fs.mkdirSync(path.dirname(wpath), { recursive: true });
    fs.writeFileSync(wpath, JSON.stringify({ 'deepseek-v4-pro': 131072 }));
    cfg._clearCache();
    const b = mk();
    b.restore({ model: 'deepseek-v4-pro' });
    eq(b.window, 131072, '表里有这个模型 → 用表里的值');
    eq(b.usage().windowTier, W_TIER.certain, '档位是 certain');
    b._adoptRealWindow({ 'deepseek-v4-pro': { contextWindow: 200000 } });
    eq(b.window, 131072, '🔴 CLI 的 200000 压不住表里的确知值');

    // 精确模型名匹配, 不做前缀/正则 —— 用正则就又变成猜了
    const b2 = mk();
    b2.restore({ model: 'deepseek-v4-pro-plus' });
    ok(b2.window !== 131072, '🔴 不是精确同名就不命中(表用精确匹配, 不是正则)');

    // 复原
    fs.rmSync(wpath, { force: true });
    if (backup != null) fs.writeFileSync(wpath, backup);
    cfg._clearCache();
  }
}

console.log('\n[CLI 给的 contextWindow: 它是 cli 档, 不是"服务端真值"]');
{
  const b = mk();
  b.restore({ model: 'deepseek-v4-pro' });
  eq(b.window, 1000000, '网关模型名没有一条 windowRule 匹配得上 → 先落 1M 兜底(这就是分母虚高的来源)');
  b._adoptRealWindow({ 'deepseek-v4-pro': { contextWindow: 128000 } });
  eq(b.window, 128000, '🔴 result 一到就用 CLI 给的值覆盖掉猜的那个(它压得住 guess 档)');

  // 只有一条时直接用: 网关挂 claude 名卖别的货, 回报的键名跟我们请求的对不上
  const b2 = mk();
  b2.restore({ model: 'claude-sonnet-4.5' });
  b2._adoptRealWindow({ 'agnes-2.5-flash': { contextWindow: 64000, canonicalModel: 'agnes-2.5-flash', provider: 'gateway' } });
  eq(b2.window, 64000, '只有一条记录 → 即使键名对不上也认(网关偷换模型的情况)');

  // 多条(带子代理)且没有当前模型那条 → 认不出来就别乱动
  const b3 = mk();
  b3.restore({ model: 'claude-opus-5[1m]' });
  b3._adoptRealWindow({ 'a-model': { contextWindow: 1000 }, 'b-model': { contextWindow: 2000 } });
  eq(b3.window, 1000000, '多条且认不出当前模型 → 保持不动, 不瞎猜');
}

console.log('\n[🔴 接入方式只管端点凭据, 不碰模型]');
{
  const { applyAccessEnv, GATEWAY_MODEL_KEYS } = require('../core/agent');

  // 订阅态: 机器上本来就有的 ANTHROPIC_* 必须被清掉, 否则静默劫持走别人的 key
  const sub = applyAccessEnv({ ANTHROPIC_API_KEY: 'leaked', ANTHROPIC_BASE_URL: 'http://x', PATH: '/bin' }, null, 'claude-opus-5[1m]');
  eq(sub.ANTHROPIC_API_KEY, undefined, '🔴 订阅态显式清掉外部 ANTHROPIC_API_KEY(不清=静默劫持)');
  eq(sub.ANTHROPIC_BASE_URL, undefined, '订阅态也清掉外部端点');
  eq(sub.PATH, '/bin', '其余环境变量原样留着(白名单式传会缺 PATH 之类)');

  // 官方 API
  const off = applyAccessEnv({}, { base_url: '', key: 'sk-ant-x' }, 'claude-opus-5[1m]');
  eq(off.ANTHROPIC_API_KEY, 'sk-ant-x', '官方端点走 x-api-key 那套');
  eq(off.ANTHROPIC_BASE_URL, undefined, '官方端点不设 BASE_URL');
  eq(off.ANTHROPIC_MODEL, undefined, '🔴 官方端点不往 env 里塞模型名 —— 模型由人格显式传给 SDK');

  // 第三方网关
  const gw = applyAccessEnv({}, { base_url: 'https://newapi.example/v1', key: 'tok' }, 'deepseek-v4-pro');
  eq(gw.ANTHROPIC_BASE_URL, 'https://newapi.example/v1', '网关端点');
  eq(gw.ANTHROPIC_AUTH_TOKEN, 'tok', '网关认 Bearer 那套');
  for (const k of GATEWAY_MODEL_KEYS) {
    eq(gw[k], 'deepseek-v4-pro', `🔴 ${k} 也指到同一个模型(少设一个, 内部小活就去要官方名, 主对话看着好好的半路才炸)`);
  }
  eq(gw.API_TIMEOUT_MS, '600000', '网关慢, 超时放宽');

  // 人格没选模型 → 宁可不设, 也不猜一个名字(猜错是静默跑在别的模型上)
  const gw0 = applyAccessEnv({}, { base_url: 'https://newapi.example/v1', key: 'tok' }, null);
  eq(gw0.ANTHROPIC_MODEL, undefined, '没选模型 → 不猜, 让它当场失败而不是静默跑错模型');

  // 从网关切回订阅: 变量不许赖着
  const back = applyAccessEnv({ ...gw }, null, null);
  eq(back.ANTHROPIC_BASE_URL, undefined, '🔴 切回订阅要清干净, 否则"改回官方"是假的');
  eq(back.ANTHROPIC_MODEL, undefined, '删的清单必须是设的超集');
}

console.log('\n[🔴 宿主下发的网关必须真的走到 env —— 2026-08-29 这条线整段是死的]');
{
  const { buildEnv } = require('../core/agent/env.js');
  const fs = require('fs');

  // 行业版没有"人格自选接入方式"这回事: 服务端发了网关就得走网关, useApi 一直是 false。
  // 老代码只认个人版那个凭据仓库, 于是 agent.gateway 存了却没人读, 模型名被发去官方端点,
  // 报错是"这个模型不存在或你没权限" —— 指向模型, 完全看不出真因在接入方式。
  const gw = { base_url: 'https://opencode.ai/zen/go', token: 'tok' };
  const e = buildEnv('deepseek-v4-flash', false, gw);
  eq(e.ANTHROPIC_BASE_URL, 'https://opencode.ai/zen/go', '🔴 宿主给的网关地址要进 env(订阅态也算数)');
  eq(e.ANTHROPIC_AUTH_TOKEN, 'tok', '网关 token 进 env');
  eq(e.ANTHROPIC_MODEL, 'deepseek-v4-flash', '网关模型名进 env');
  eq(buildEnv('claude-opus-5[1m]', false, null).ANTHROPIC_BASE_URL, undefined, '没给网关就不设端点');

  // 存下来才读得到: 构造时丢掉 opts.gateway 的话, 冷启动永远没网关,
  // 只有服务端**事后**推一次 config.update 才偶然变好 —— 那种坏法最难查。
  const src = fs.readFileSync(require.resolve('../core/agent.js'), 'utf8');
  ok(/this\.gateway\s*=\s*opts\.gateway/.test(src), '🔴 构造函数要把 opts.gateway 存下来');
  const st = fs.readFileSync(require.resolve('../core/agent/stream.js'), 'utf8');
  ok(/buildEnv\([^)]*this\.gateway[,)]/.test(st), '🔴 建流时要把 this.gateway 传给 buildEnv');
  // 凭据 id 同理: 漏传的话人格选的那条凭据不生效, 会静默回落到默认那条 —— 不报错, 只是烧错了 key
  ok(/buildEnv\([^)]*this\.credentialId[,)]/.test(st), '🔴 建流时要把 this.credentialId 传给 buildEnv');
}

console.log('\n[🔴 防回归: 建 query 时模型只认人格偏好]');
{
  const src = require('./kernel-src').kernelSource();
  const line = src.split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .find((l) => /const model = /.test(l) && l.includes('preferredModel'));
  ok(!!line, '找得到建 query 时取模型那行');
  ok(line && !/access/.test(line),
    '🔴 那行不掺 access —— 接入方式(端点/凭据)和模型选择是正交的两件事');
}

console.log('\n[setModel: 切不动的时候必须如实回报, 不许装成功]');
{
  const b = mk();
  b.preferredModel = null;
  // 流还没起(_q 不存在): 只更新偏好, 明说没切成
  const r = b.setModel('claude-sonnet-4-6');
  ok(r instanceof Promise, 'setModel 是异步的');
  return r.then((res) => {
    eq(res.applied, false, '没有活跃的流 → applied=false');
    eq(res.reason, 'no_stream', '说得出为什么没切成');
    eq(b.preferredModel, 'claude-sonnet-4-6', '偏好仍然记下了(下次会话启动会用)');
  }).then(deferredWhileBusy).then(branchCoverage).then(finish);
}

// 后台换了模型, 通知随时会降下来 —— 可能正落在助手说到一半的时候。
function deferredWhileBusy() {
  console.log('\n[说到一半不换: 正在产出时降下来的换模型指令, 等这一轮说完再兑现]');
  const b = mk();
  b.preferredModel = 'claude-opus-5[1m]';
  b.window = 1000000;
  b._busy = true;                 // 模型正在产出
  return b.setModel('claude-haiku-4-5-20251001').then((res) => {
    eq(res.applied, false, '正在说话 → 本轮不切');
    eq(res.reason, 'deferred_busy', '说得出是"排队等本轮", 不是"切失败"(两者给用户的交代完全不同)');
    eq(b.preferredModel, 'claude-haiku-4-5-20251001', '偏好当场记下 —— 万一先发生压缩重建流, 拿到的也是新模型');
    eq(b.window, 1000000, '🔴 窗口不当场改小: 1M 换 200k 会让本轮占用率当场翻五倍, 可能直接触发压缩把话截断');
    ok(b._pendingModel && b._pendingModel.model === 'claude-haiku-4-5-20251001',
      '挂起的切换记在 _pendingModel 上, 等回合结束兑现');

    // 兑现点必须真的在 result 分支里 —— 只挂不兑现, 表现就是"永远不换模型"
    const consume = fs.readFileSync(path.join(__dirname, '../core/agent/consume.js'), 'utf8');
    ok(/_pendingModel/.test(consume), '🔴 consume 的回合收尾处有兑现代码(只挂不兑现 = 永远换不过去)');
    const idxResult = consume.indexOf("_emit('onResult'");
    const idxPend = consume.indexOf('this._pendingModel');
    ok(idxResult > 0 && idxPend > idxResult, '🔴 兑现在 onResult 之后 —— 本轮先完整交付, 再换模型');
  });
}

// ——— 窗口档位机制: 把这次改动碰到的每条分支都走一遍 ———
// 上面那几节验的是主路径。这一节是**分支清单**: windowFor 六条出口 · _setWindow 五种判定 ·
// _applyModelWindow 的全部调用点(构造/setModel 两个分支/consume init/restore) · jsonOptional
// 坏 JSON · 持久化不恢复档位。少走一条, 那条路上的档位就可能不清零而没人知道。
async function branchCoverage() {
  const { W_TIER } = require('../core/agent/util');
  const cfg = require('./config-loader');
  const overrideRoot = cfg.overrideRoot();

  console.log('\n[分支 · windowFor: 带 certain 标记的 windowRules 进确知档]');
  {
    // 出厂表里一条 certain 都没标(Sonnet 4.6 实际是 1M, 标了反而把正确值挡在外面),
    // 所以这条分支只能靠覆盖层造一份来验 —— 顺带也验了"覆盖是整文件替换"这件事。
    const lp = overrideRoot ? path.join(overrideRoot, 'models', 'list.json') : null;
    if (lp) {
      fs.mkdirSync(path.dirname(lp), { recursive: true });
      fs.writeFileSync(lp, JSON.stringify({
        defaultWindow: 1000000,
        windowRules: [
          { pattern: 'certain-model', window: 333000, certain: true },
          { pattern: 'guess-model', window: 222000 },
        ],
      }));
      cfg._clearCache();

      const b = mk();
      b.restore({ model: 'certain-model-x' });
      eq(b.window, 333000, 'certain 规则命中 → 用它的值');
      eq(b.usage().windowTier, W_TIER.certain, '🔴 标了 certain 的规则进确知档');
      b._adoptRealWindow({ 'certain-model-x': { contextWindow: 999 } });
      eq(b.window, 333000, '🔴 CLI 压不住标了 certain 的规则');

      const b2 = mk();
      b2.restore({ model: 'guess-model-y' });
      eq(b2.usage().windowTier, W_TIER.guess, '没标 certain → 猜档');
      b2._adoptRealWindow({ 'guess-model-y': { contextWindow: 111000 } });
      eq(b2.window, 111000, '猜档让位给 CLI');

      fs.rmSync(lp, { force: true });
      cfg._clearCache();
    }
  }

  console.log('\n[分支 · _setWindow 的五种判定]');
  {
    const b = mk();
    b.restore({ model: 'claude-opus-5[1m]' });        // guess 档 1M
    ok(b._setWindow(1000000, W_TIER.guess) === false, '同档同值 → 不写(避免刷日志)');
    ok(b._setWindow(1000000, W_TIER.cli, 'same-value-upgrade') === true,
      '🔴 值相同但档位更高 → 要写进去(升完档低档就压不进来了)');
    eq(b.usage().windowTier, W_TIER.cli, '档位确实升到了 cli');
    ok(b._setWindow(500000, W_TIER.guess) === false, '升档之后低档再来 → 挡住');
    eq(b.window, 1000000, '被挡住后值不变');
    ok(b._setWindow(500000, W_TIER.certain) === true, '更高档可以改值');
    eq(b.window, 500000, '确知档写进去了');
  }

  console.log('\n[分支 · _applyModelWindow 的调用点: setModel 两个分支都要真走到]');
  {
    // ① 有网关 → restream 分支(accessConfig 只看 gateway 有没有值, 不用真接网关)
    const b = mk({ gateway: { base_url: 'https://gw.example/v1', token: 'tok' } });
    b.restore({ model: 'claude-sonnet-4-6' });
    eq(b.window, 200000, '先在 200k 模型上');
    b._setWindow(200000, W_TIER.certain, '假装对旧模型确知');   // 制造"旧模型的 certain 挡路"
    const res = await b.setModel('claude-opus-5[1m]');
    eq(res.via, 'restream', '确认走的是 restream 分支(有网关那条)');
    eq(b.window, 1000000, '🔴 restream 分支也清零了档位 —— 否则旧模型的 certain 会挡住新模型');
    eq(b.usage().windowTier, W_TIER.guess, '档位按新模型重算');

    // ② 无网关 + 有流 → _q.setModel 分支
    const b2 = mk();
    b2.restore({ model: 'claude-sonnet-4-6' });
    b2._setWindow(200000, W_TIER.certain, '假装对旧模型确知');
    b2._q = { setModel: async () => {} };            // 最小假流: 只要有 setModel 就走这条
    b2.submit = async () => {};                      // 吞掉切换通知, 别真去建流
    const res2 = await b2.setModel('claude-opus-5[1m]');
    eq(res2.applied, true, '确认走的是 _q.setModel 分支');
    eq(b2.window, 1000000, '🔴 这条分支也清零了档位');
  }

  console.log('\n[分支 · _applyModelWindow 的调用点: consume 的 init]');
  {
    const b = mk();
    b.restore({ model: 'claude-sonnet-4-6' });
    b._setWindow(200000, W_TIER.certain, '假装对旧模型确知');
    // 直接喂一个没挂上去的 async iterable —— 真实路径是 ensureStream 先 this._q=q 再消费
    const q = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sess-test', model: 'claude-opus-5[1m]' };
    })();
    try { await b._consume(q); } catch (e) { ok(false, 'init 分支消费炸了: ' + e.message); }
    eq(b.model, 'claude-opus-5[1m]', 'init 里认了新模型');
    eq(b.window, 1000000, '🔴 consume 的 init 分支也清零了档位');
  }

  console.log('\n[分支 · jsonOptional: 坏 JSON 要炸, 不许静默回落]');
  {
    const wp = overrideRoot ? path.join(overrideRoot, 'models', 'windows.json') : null;
    if (wp) {
      fs.mkdirSync(path.dirname(wp), { recursive: true });
      fs.writeFileSync(wp, '{ 这不是 json');
      cfg._clearCache();
      let threw = false;
      try { cfg.jsonOptional('models/windows', {}); } catch (_) { threw = true; }
      ok(threw, '🔴 坏 JSON 抛异常 —— 静默回落会让人以为改生效了, 比报错难查得多');
      fs.rmSync(wp, { force: true });
      cfg._clearCache();
      let v = null, threw2 = false;
      try { v = cfg.jsonOptional('models/windows', { fallback: 1 }); } catch (_) { threw2 = true; }
      ok(!threw2, '文件不存在不抛');
      ok(v && v.fallback === 1, '文件不存在 → 返回传进去的 fallback');
    }
  }

  console.log('\n[分支 · 持久化: 存档位但不恢复它]');
  {
    const b = mk();
    b.restore({ model: 'claude-sonnet-4-6' });
    b._setWindow(123000, W_TIER.certain, '测试');
    const saved = b.exportState();
    eq(saved.windowTier, W_TIER.certain, 'exportState 把档位一起存下来(给诊断看)');
    const b2 = mk();
    b2.restore(saved);
    eq(b2.window, 200000, '🔴 重开按模型重算, 不读回存下的 123000');
    eq(b2.usage().windowTier, W_TIER.guess,
      '🔴 档位也不读回 —— 一份过期的 certain 会把这次启动该走的决议整个挡住');
  }
}

function finish() {
  fs.rmSync(HOME, { recursive: true, force: true });
  console.log(`\n${fail ? '❌' : '✅'} test-model-switch: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
}
