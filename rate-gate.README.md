# rate-gate.js · 防幻觉 · Claude 4.x submit-time 限流 module

**版本**: v1 · 2026-07-13
**设计文档**: `/Users/arthur/Program/butler/workspace/anti_hallucination_rate_gate_design_20260713.md`
**作者**: 狂人(数据专家)· **集成**: 飞飞

---

## 一句话

Opus 4.x submit 前拦一下,让打不出去的请求在 butler 侧排队,别硬打进 Anthropic rate limit / 假设的降载层 → 触发幻觉/malformed/court 泄漏。

## 关键设计

- **Opus 4.x 组合桶**——Anthropic 官方 rate limit 就是 4.5/4.6/4.7/4.8 共享一个桶,module 尊重这一事实
- **双桶隔离**: `opus_user`(主动交互)/ `opus_auto`(bothub/tg/ask_persona/autonomous)· user 不被 auto 挤下去
- **submit-time 拦截**——只在 submit 那一瞬占 token · turn 内 tool loop 全免占 · 长 turn 不阻塞并发
- **Sonnet/Haiku 直通不 gate**——v1 只顾 Opus 4.x
- **ITPM 桶 v1 不加**——等抓一次响应头 `anthropic-ratelimit-input-tokens-remaining` 验证是否需要(Q7)

## 默认参数(v1)

| 桶 | capacity | refill | 稳态 RPM |
|---|---|---|---|
| `opus_user` | 30 | 1 token / 2000ms | 30 |
| `opus_auto` | 20 | 1 token / 3000ms | 20 |

参数可用 `configure()` **热调**——一周后按 log 调阈值不需要改 code 不需要重启。

## API

### `gateSubmit(opts)` — 主入口

```js
const { gateSubmit, CancelToken } = require('./rate-gate');

const ct = new CancelToken();
// 会话 kill/interrupt 时 → ct.cancel()

const r = await gateSubmit({
  model: session.model,                    // 'claude-opus-4-8' | 'claude-opus-4-7' | ...
  sourceKind: 'user',                      // 'user' | 'auto'
  cancelToken: ct,
  onQueueUpdate: (info) => {
    // 每 100ms 一次: info = { waitedMs, queuePos, queueLen, bucketName, tokensLeft }
    // 推给 renderer 显示 activity bar
    mainWindow.webContents.send('rate-gate:waiting', info);
  },
});

if (r.cancelled) return;                   // 会话被 kill,不 submit
if (r.gated && r.waitedMs > 500) {
  log.info(`[rate-gate] bucket=${r.bucketName} waited=${r.waitedMs}ms`);
}
// r.ok = true → 走 submit
await claudeAgent.sendMessage(...);
```

**返回**: `{ ok, cancelled, waitedMs, gated, bucketName }`
- `ok=true` = 拿到 token 可 submit(或非 Opus 4.x 直通)
- `cancelled=true` = 会话已 kill,别 submit
- `waitedMs` = 排队等了多少毫秒
- `gated` = 是否走了 gate(false = Sonnet/Haiku/未知 model 直通)
- `bucketName` = 走了哪个桶

### `configure(cfg)` — 热调参数

```js
const { configure, getStatus } = require('./rate-gate');

// Q6/Q7/Q8 参数调整不用改 code
configure({
  opus_user: { capacity: 40, refillIntervalMs: 1500 },   // 40 tok · 稳态 40 RPM
  opus_auto: { capacity: 30, refillIntervalMs: 2000 },
});

console.log(getStatus());
// {
//   opus_user: { name: 'opus-user', capacity: 40, tokens: 40, refillIntervalMs: 1500, waiterCount: 0 },
//   opus_auto: { name: 'opus-auto', capacity: 30, tokens: 30, refillIntervalMs: 2000, waiterCount: 0 },
// }
```

配置会**保连续性**——未 settle 的 waiter 迁移到新桶,不丢排队请求。

### `CancelToken`

极简取消令牌 · 接入方可自造只要有 `onCancel(fn)` 方法即可。

```js
const ct = new CancelToken();
// 触发时
ct.cancel();          // 所有 pending acquire 立即返回 cancelled=true
ct.cancelled;         // true
```

## 集成点(飞飞接手时看这里)

### 1. chat-runner submit 前置

伪码位置: `butler/main.js` 或 chat 相关模块 · submit API 前插入 gate 调用。

```js
// 提交前
const gate = await gateSubmit({
  model: session.model,
  sourceKind: submitCtx.sourceKind || 'user',
  cancelToken: session.cancelToken,
  onQueueUpdate: (info) => session.emit('rate-gate:waiting', info),
});
if (gate.cancelled) return;    // 会话已 kill
// 正常 submit
```

### 2. sourceKind 分类

| 触发源 | sourceKind |
|---|---|
| 命令行/UI 主动输入 | `'user'` |
| bothub polling(agent-bus 消息) | `'auto'` |
| tg-native onMessage | `'auto'` |
| ask_persona RPC | `'auto'` |
| autonomous_loop / ScheduleWakeup / cron | `'auto'` |

在 submit 入口按调用方给标签 · 别推断。

### 3. cancelToken 联动

- session.kill() / session.interrupt() → session.cancelToken.cancel()
- 桶内 pending acquire 立即返回 `{ ok: false, cancelled: true }` · 不占坑

如果现有 session 对象没有 cancelToken,给它加一个 · 或用 `new CancelToken()` 挂到 session 上。

### 4. UX activity bar(可选,建议加)

- IPC channel: `rate-gate:waiting`
- payload: `{ waitedMs, queuePos, queueLen, bucketName, tokensLeft }`
- renderer 显示"⏳ 排队 · 桶=user-4.x · 位置 3/12 · 已等 1200ms"
- 拿到 token 后停发即消失

### 5. 观察 log(必加,便于调参)

```js
if (gate.gated && gate.waitedMs > 500) {
  log.info(`[rate-gate] session=${sid} bucket=${gate.bucketName} waited=${gate.waitedMs}ms`);
}
```

## v2 打点(不 block v1)

- **ITPM 桶**——大 context 会话是主要风险 · 需抓 `anthropic-ratelimit-input-tokens-remaining` 建模
- **ask_persona 独立桶**——若 auto 桶被 ask_persona 挤爆则拆
- **4.7 vs 4.8 分层容量**——若发现 4.7 触发降载假设较少,可给 4.7 单独更松的 sub-桶(现在共享 Opus 4.x)
- **Fast mode 独立桶**——4.8/4.7 fast mode 是独立 rate limit,若使用需另设桶

## 单测

```bash
cd /Users/arthur/Program/butler
node rate-gate.js
```

10 个测试 · 覆盖:
1. pickBucket · Opus 4.8 user → opus_user
2. pickBucket · Opus 4.7 auto → opus_auto(组合桶验证)
3. pickBucket · Opus 4.6/4.5 也算组合桶
4. pickBucket · Sonnet 直通不 gate
5. pickBucket · Haiku 直通不 gate
6. pickBucket · 未知 model 直通
7. TokenBucket · 满桶立即拿 token
8. TokenBucket · 桶空排队 · refill 后依序放行
9. TokenBucket · cancelToken 立即释放不占坑
10. TokenBucket · onQueueUpdate 排队期间收到 update
11. gateSubmit · Sonnet 直通 gated=false
12. gateSubmit · Opus 4.8 user 满桶立取 gated=true
13. gateSubmit · user 桶排队时 auto 桶不受影响
14. configure · 热调容量 · getStatus 反映新值
15. gateSubmit · cancelToken 中断排队

**注**: 狂人本机无 node · self-test 未在本地跑一次 · 飞飞集成时先 `node rate-gate.js` 跑通再接。

## 挂着的开放问题(v1 用默认先跑 · 一周后 log 数据回来调)

- **Q6**: 4.7 桶容量是否要单独? v1 共享 Opus 4.x 桶 · v2 可拆
- **Q7**: 是否加 ITPM 桶? 需先抓响应头验证
- **Q8**: 我们组织的官方 tier(Start/Build/Scale)· 用 [Rate Limits API](https://platform.claude.com/docs/en/manage-claude/rate-limits-api) 查 · 决定桶容量绝对值

## Sources

- Anthropic Rate limits doc: <https://platform.claude.com/docs/en/api/rate-limits>
- Wikipedia Token bucket: <https://en.wikipedia.org/wiki/Token_bucket>
- 详细引文见设计文档 §12.1

## 变更日志

- **v1.0** 2026-07-13 · 狂人初写 · module + 单测 + README

---

**交接给飞飞**: 3 件套齐全(module `rate-gate.js` + self-test 在同文件底部 + 本 README)· 集成点见"集成点"节 5 条 · 有问题 ask_persona 回狂人。
