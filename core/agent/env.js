// 接入方式(订阅 / 官方 key / 第三方网关)的环境变量拼装与认证失效判据。
// 由 agent.js 拆出(内核抽包第 1 步), 逐字搬运。

// 走网关要摆平的环境变量。切回订阅模式时按这份清单**逐个删** ——
// 删的清单必须是设的超集, 否则"从网关改回官方"会留下半套配置, 那是最难查的一种坏。
const GATEWAY_MODEL_KEYS = [
  'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_REASONING_MODEL',
];
const GATEWAY_ENV_KEYS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  ...GATEWAY_MODEL_KEYS,
];

// 订阅模式的长效 token(`claude setup-token` 产出)。CLI 认这个环境变量, 认到就不再读 keychain。
// 它是 keychain 那条 refreshToken 续期链的替代品, 不是网关凭据, 所以不混进 GATEWAY_ENV_KEYS。
const SUBSCRIPTION_TOKEN_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';
const SUBSCRIPTION_TOKEN_KEY = 'claude_subscription_token';

// 🔴 系统设置那套 key+地址 **只是凭据仓库, 存了不代表启用**(作者 2026-08-18 定案)。
//    真正"这个人格走订阅还是走那把 key"由人格自己的 accessMode 决定, 所以这里要 useApi 参数 ——
//    没有它就又变回一个全局开关去管每个人格的事, 那正是之前"怎么这么别扭"的来源。
// 模型同样是人格字段, 与接入方式正交(行业版一直这么分: persona.model / persona.gateway)。
// 惰性取: secrets 要 electron 的 safeStorage, 宿主没注入(测试进程)时整段走 catch 退回订阅。
// gateway = 宿主直接给的网关(行业版由服务端下发, 存在 agent.gateway)。
// 它优先于本机凭据仓库, 且**与 accessMode 无关** —— 行业版没有"人格自选接入方式"这回事,
// 服务端发了网关就是走网关, 让它去看个人版那个 settings/secrets 只会永远拿到 null。
// 凭据仓库里挑出人格认领的那一条。指定的那条没了(被删/改名重建)就回落到默认那条 ——
// 硬认 id 的话, 用户在设置里删掉一条就会让若干人格突然起不来, 而报错只是"没存 key"。
function pickCredential(settings, credentialId) {
  const s = settings.read();
  const list = Array.isArray(s.credentials) ? s.credentials : [];
  if (!list.length) return null;
  return list.find((c) => c && c.id === credentialId)
      || list.find((c) => c && c.id === s.defaultCredentialId)
      || list[0];
}

function accessConfig(useApi, gateway, credentialId) {
  if (gateway && gateway.base_url && gateway.token) {
    return { base_url: String(gateway.base_url).trim(), key: gateway.token };
  }
  if (!useApi) return null;        // 人格选了订阅 → 凭据仓库里有 key 也不碰
  try {
    const { settings, secrets } = require('../host');
    const c = pickCredential(settings, credentialId);
    if (!c) return null;
    const key = secrets.get(`anthropic_api_key:${c.id}`);
    if (!key) return null;         // 选了 API 却没存 key: 退回订阅继续能用, 不让人格整个起不来
    // 🔴 别去尾斜杠。2026-08-17 我按"`//v1/messages` 会返回网页 HTML"的推断顺手去了一次,
    // 结果作者实测: 带斜杠(去之前)api+重启可用, 去掉之后连重启都起不来。推断没验证过, 实测说了算。
    return { base_url: String(c.base_url || '').trim(), key };
  } catch (_) { return null; }
}

// 每次 spawn 现拼一个新 env, 绝不写 process.env —— 写了的话开过网关再关, 变量赖在进程里,
// "改回官方"就是假的。
//
// 订阅模式**也显式清**那 8 个键, 不是"不设=随缘": 机器上本来就有 ANTHROPIC_API_KEY 的话
// 会静默劫持, 走了谁的 key 我们发现不了。
function buildEnv(preferredModel, useApi, gateway, credentialId) {
  const env = applyAccessEnv({ ...process.env }, accessConfig(useApi, gateway, credentialId), preferredModel, subscriptionToken());
  // 🔴 关掉 harness 自带的那套任务清单: `CLAUDE_CODE_ENABLE_TASKS` 是 CLI 的 tasks 功能位,
  //    它同时是 TaskCreate/TaskGet/TaskList/TaskUpdate 四件套的 isEnabled() **和**每轮那条
  //    "The task tools haven't been used recently" 提醒的闸(源码 `if(!E5())return[]`)。
  //    清单归自家 `task` 工具管(consume.js 的 taskOp) —— 两套并存时 id 各自发号、同号不同事,
  //    那是「面板条目清不掉 · 会话里删了盘上还在 · Task not found」三个 bug 的共同根。
  //    顺带省掉那条提醒每轮几十 token 的固定开销(乘几千轮不是小数)。
  // ⚠️ 传字符串 'false' 是对的, 不是笔误: CLI 把这个变量按 triBool 解析, 0/false/no/off
  //    统一归成布尔 false, 源码那句 `=== !1` 的严格比较才成立。
  // ⚠️ 不放在 applyAccessEnv 里: 那个函数只管接入方式(凭据/端点/模型), 这是功能位, 两码事。
  //    留着 `Task`(派子代理)和 `TaskStop`(停后台任务) —— 它们跟任务清单无关, 不受这个开关影响。
  env.CLAUDE_CODE_ENABLE_TASKS = 'false';
  // 用户自加的联网搜索引擎(只有 Butler 引擎的本机 WebSearch 读), 见 core/search-keys.js
  return require('../search-keys').applyEnv(env);
}

// 订阅模式下的长效 token(`claude setup-token` 产出)。没配返回 null, 一切照旧走 keychain。
// 存在 secrets 而不是明文配置: 它等价于账号凭证, 拿到就能用掉订阅额度。
function subscriptionToken() {
  try { return require('../host').secrets.get(SUBSCRIPTION_TOKEN_KEY) || null; } catch (_) { return null; }
}

// 长效 token 已经不好使了 → 就地丢掉, 让下一次 spawn 回落到 keychain。
// 不丢的话「点重新登录」永远救不回来: CLI 优先认环境变量, 新写进 keychain 的凭证够不着。
// 返回 true = 确实丢掉了一张(调用方据此决定要不要告诉用户"它过期了, 已改回走登录")。
function dropSubscriptionToken(who) {
  try {
    const { secrets } = require('../host');
    if (!secrets.get(SUBSCRIPTION_TOKEN_KEY)) return false;
    secrets.set(SUBSCRIPTION_TOKEN_KEY, '');
    console.error(`[access] ${who || ''} 长效 token 已失效 → 丢弃, 下次起子进程改回读 keychain(重新登录才救得回来)`);
    return true;
  } catch (_) { return false; }
}

// buildEnv 的纯函数内核(env 和 access 都由外面给)。拆出来是为了能不起 electron 就测 ——
// accessConfig 要 safeStorage, 在测试进程里必然拿不到。
// 非 Anthropic 协议的直连(只有自建 SDK 认): 人格模型写成 `deepseek/…` `openai/…` `compat/…` 时,
// 选中那条凭据的 base_url / key 交给对应厂商的变量, 不再装成 Anthropic 网关。见 agent-sdk/README.md。
const PROVIDER_ENV = {
  deepseek: ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL'],
  openai: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'],
  compat: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'],
};
const PROVIDER_ENV_KEYS = [...new Set(Object.values(PROVIDER_ENV).flat())];

function applyAccessEnv(env, a, preferredModel, subToken) {
  for (const k of GATEWAY_ENV_KEYS) delete env[k];
  for (const k of PROVIDER_ENV_KEYS) delete env[k];
  // 🔴 跟那 8 个键同一条原则: 显式清, 不继承机器上本来就有的。继承的话谁的订阅在付钱都说不清,
  // 而且"在 butler 里取消配置"会变成假的 —— 变量还在 process.env 里赖着。
  delete env[SUBSCRIPTION_TOKEN_ENV];
  if (!a) {
    // 订阅模式。配了长效 token 就注入 —— CLI 取凭证的顺序是"有这个变量就直接用, 没有才读 keychain",
    // 于是整条 refreshToken 续期链被绕开: 不需要续, 就不会续失败(那正是周期性 401 的来源)。
    if (subToken) env[SUBSCRIPTION_TOKEN_ENV] = subToken;
    return env;
  }
  const prov = PROVIDER_ENV[(/^([a-z]+)\//.exec(preferredModel || '') || [])[1]];
  if (prov) {
    env[prov[0]] = a.key;
    if (a.base_url) env[prov[1]] = a.base_url;
    return env;
  }
  if (!a.base_url) { env.ANTHROPIC_API_KEY = a.key; return env; }   // 官方端点: x-api-key 那套

  // 第三方网关
  env.ANTHROPIC_BASE_URL = a.base_url;
  // 两个都设 = 两种鉴权头都带(AUTH_TOKEN→Bearer, API_KEY→x-api-key), 与 modelsFromEndpoint 同口径。
  // 只带 Bearer 的话, 认 x-api-key 的网关会回 401 Missing API key, 被判成"认证失效"
  // 而弹重新登录横幅 —— 用户找不到真因(2026-08-22 opencode zen/go 实撞)。
  env.ANTHROPIC_AUTH_TOKEN = a.key;
  env.ANTHROPIC_API_KEY = a.key;
  // CLI 内部按用途分档取模型(标题生成、工具检索这类小活走 haiku 档), 只设主模型的话
  // 那些内部调用会去要一个网关根本没有的官方模型名 → 半路报错, 而主对话看着是好的。
  // 所以五个档位全指到同一个模型。空 = 人格没选模型, 这时**宁可不设**让它去打官方名当场
  // 失败, 也不猜一个名字 —— 猜错了是静默跑在别的模型上。
  if (preferredModel) { for (const k of GATEWAY_MODEL_KEYS) env[k] = preferredModel; }
  else console.error('[gateway] ⚠ 走网关但人格没选模型, 内部小任务会去要官方模型名');
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  // 网关比官方慢一截, 用官方的超时会在长回合中途被判死
  env.API_TIMEOUT_MS = '600000';
  env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = '1800000';
  return env;
}

// ── 接入类故障的分类 ────────────────────────────────────────────────────────
// 🔴 这里【只做分类, 不判断是不是故障】。"是不是故障"由调用方用结构信号定死(见 consume.js):
//    ① `msg.is_error === true` —— CLI 自己标的, 2026-08-21 实测未登录时它回
//       subtype:"success" + is_error:true, 字段一直在, 只是以前没人读;
//    ② 没经过 text_delta 逐字流 —— 模型开口必然逐字流出, CLI 注入的是整块塞进来的。
//    所以"AI 正在跟用户讨论 401"永远进不到这个函数, 老代码那道赌博式长度门(赌讨论必是长文)
//    连同它一起删了 —— 那道门在"模型简短引用一句报错"时必然误伤。
//
// 分类的意义: **同一句"认证失效"的处方在四类里有三类是错的。**
// 重登修不了额度满, 修不了 key 写错, 修不了 403 组织校验(2026-08-26 坐实: 狂人反复重登永远
// 修不好)。给错的行动指引比不给更坏 —— 用户会一直重登, 然后认定软件坏了。
//
// 顺序从具体到宽泛, 最后那条 401 是兜底, 绝不能提前。
const ACCESS_ERR_KINDS = [
  // 人格没选模型: Butler 引擎没有默认模型(Claude Code 才有), 空着就是这句。换 key、重登都没用, 只能去选一个。
  ['no_model', /no model configured/i],
  // 额度/限流: 重登毫无用处, 只能等窗口重置、换通道或充值。第三方网关多半回中文。
  ['quota', /\b429\b|rate[_\s-]?limit|too many requests|insufficient (?:quota|credit|balance)|credit balance is too low|quota exceeded|余额不足|额度(?:已)?(?:用完|不足|超)|欠费/i],
  // 组织/权限: 凭证完全正常, 是这个账号没资格。2026-08-26 bug① 就是它被吞进了 oauth_expired。
  ['org_forbidden', /\b403\b|organization membership|unable to verify organization|not authorized|permission denied/i],
  // key 本身不对: 只可能出现在 API 态。订阅态出现即是别处泄漏了 key 进来。
  ['key_bad', /invalid[_\s-]?(?:api[_\s-]?)?key|missing api key|x-api-key|authentication[_\s-]?error/i],
  // 凭证过期/没登录: 唯一一类"重登真能修"的。Claude Code 上游缺陷 —— 存了 refreshToken 却不
  // 可靠地续期(anthropics/claude-code #31095/#12447/#42904), 每隔几天突然全局 401 且**不自愈**
  // (实测连挂 1.5 小时直到人工重登; 重启 app 也修不好, 因为 `claude auth status` 只看凭证在不在)。
  ['oauth_expired', /Failed to authenticate|Not logged in\b|OAuth|access token|\b401\b/i],
];

// 🔴 这四类**全是确定性错误, 一个都不重试**。
// 401 曾经在这个名单里, 理由写的是"服务端偶发 401 过一会儿自己就好" —— 那是错的:
// 401 是本机 token 过期, 重试用的还是同一把过期 token, 必然再撞。而且 CLI 自己对 401/429
// 已经重试过 14 次以上、耗两分多钟才把错误交给宿主, 宿主再试是第 15 次。
// 实测坐实: 2026-09-18 每 3.5 秒一轮连转近 4 小时约 4000 次, 零次自愈, 最终靠人工登录恢复。
// 当初之所以要这层重试, 是因为判据是正则、误报多, 拿重试当兜底 —— 判据换成 SDK 枚举之后
// 这个理由也没了。重试意愿由真人再发话表达(stream.js 的挂起闸放行真消息)。
// 真正该重试的是过载/5xx 那种服务端临时故障, 它们不属于"接入故障", 见 classifySdkError 注释。
const RETRYABLE_KINDS = new Set();

// SDK 自己分好的故障类型(`SDKAssistantMessageError` 枚举, 随 system/api_retry 消息下发)。
// 这是【CLI 从 HTTP 响应里读出来的事实】, 不是从文本猜的 —— 有它就不该再动正则:
// 正则永远分不开"模型在谈论 401"和"请求真的返回了 401", 而这份映射天生分得开。
// 枚举里没列进来的(overloaded/server_error/model_not_found/max_output_tokens)不是接入故障, 返回 null 放行。
const SDK_ERR_KIND = {
  authentication_failed: 'oauth_expired',
  oauth_org_not_allowed: 'org_forbidden',
  billing_error: 'quota',
  rate_limit: 'quota',
  // Butler 引擎独有(Claude Code 有自带默认模型): 人格没选模型。换 key、重登都修不了, 只能去选。
  model_not_configured: 'no_model',
  // invalid_request(400)不在这里: 它是这一次请求本身不合法(思考块签名失效、上下文超长、工具 schema 不对),
  // 换 key 修不了。key 写错网关回的是 401/authentication_error, 走 authentication_failed 或正文正则。
};

// SDK 枚举 → 接入故障判定。认不出返回 null(交给调用方走正则兜底)。
// 🔴 状态码优先于枚举: 5xx 是服务端临时故障, 不论 CLI 把它标成哪个枚举都不算接入故障。
// 上游没有 `overloaded` 这个枚举 —— 2026-09-22 实测 529 Overloaded 上报的是 error=rate_limit,
// 于是被映射成 quota、按不可重试定罪挂起, 屏幕上显示"额度用完", 而原文明写 server-side issue。
function classifySdkError(sdkErr, mode, status) {
  if (status != null && Number(status) >= 500) return null;
  let kind = SDK_ERR_KIND[String(sdkErr || '')];
  if (!kind) return null;
  // 走 key 的人格认证失败 = key 不对, 不是登录过期: 给它「重新登录」是指错路
  if (kind === 'oauth_expired' && mode === 'api') kind = 'key_bad';
  return { kind, retryable: RETRYABLE_KINDS.has(kind), mode: mode || 'subscription', source: 'sdk' };
}

// 返回 null = 认不出来。认不出来就【别给结论】, 原样把报错显示给用户 ——
// 硬凑一个 kind 出来就是在重犯"所有故障都翻译成同一句话"那个错。
function classifyAccessError(s, mode) {
  const t = String(s || '').trim();
  if (!t) return null;
  const head = t.slice(0, 500);
  for (const [kind, sig] of ACCESS_ERR_KINDS) {
    if (!sig.test(head)) continue;
    return { kind, retryable: RETRYABLE_KINDS.has(kind), mode: mode || 'subscription' };
  }
  return null;
}

module.exports = {
  GATEWAY_MODEL_KEYS, GATEWAY_ENV_KEYS, accessConfig, pickCredential, buildEnv, applyAccessEnv,
  ACCESS_ERR_KINDS, classifyAccessError, SDK_ERR_KIND, classifySdkError,
  SUBSCRIPTION_TOKEN_ENV, SUBSCRIPTION_TOKEN_KEY, subscriptionToken, dropSubscriptionToken,
};
