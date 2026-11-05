// 登录流程回归。跑: node test-auth-login.js
//
// 病根(2026-08-20 作者 Windows 实测): 授权完浏览器跳回 http://localhost:PORT/callback,
// 那个端口已经没人在听。CLI 起的回调服务器是被 butler 自己杀掉的 —— 首次登录那条路
// 每 2.5 秒问一次 isClaudeLoggedIn(), 为真就 child.kill(); 而这个函数只看凭证在不在,
// 用户还在浏览器里点的时候它就可能为真。同一个坑在"凭证失效自愈"那条路上早就修过并
// 写了注释, 首次登录这条漏了 —— 两条路各写一套判据是复发的根源。
//
// 第二件(同次实测): 明明是登录状态却弹登录框。退出码分不出"确实没登录"和"探测失败"
// —— 未登录时 CLI 也是 exit=1 + 合法 JSON。原代码 status!==0 就 return false, 于是
// Windows 上探测一超时就把能用的 app 拿登录框挡住。
require('./host-wiring');   // 个人版宿主接线: 直接 require core 模块的进程都得先接
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)); };
const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

console.log('\n=== 登录完成的判据只有一套 ===');
{
  const at = src.indexOf('async function ensureClaudeAuth');
  const seg = src.slice(at, at + 2600);
  ok(at !== -1, '找得到 ensureClaudeAuth');
  ok(/reloginAndRecover\(\)|runClaudeLogin\(/.test(seg),
    '🔴 首次登录复用自愈那条路(reloginAndRecover → runClaudeLogin, 只有一套判据)');
  ok(/pendingLoginFlight = reloginAndRecover\(\)/.test(seg) && !/await runClaudeLogin/.test(seg),
    '🔴 首登授权不阻塞启动(阻塞的话 createWindow 还没跑, 那 10 分钟里连个能点的界面都没有)');
  ok(!/setInterval[\s\S]{0,200}isClaudeLoggedIn[\s\S]{0,200}kill\(/.test(seg),
    '🔴 没有"轮询 isClaudeLoggedIn 为真就 kill CLI"(会在用户还在浏览器里点时杀掉回调服务器)');
  ok(!/function waitForLogin/.test(src),
    '🔴 那套另造的 waitForLogin 已删除(留着就会有人再接回去)');
}
{
  // 自愈那条路的判据本身别被改坏。2026-08-26 日志实测: 拿"凭证指纹变了"当完成信号是假阳性
  // —— CLI 一启动就用 refreshToken 自刷 token, 开浏览器后 1.1 秒指纹就变、CLI 被 kill,
  // 回调服务器跟着死。完成信号只能是 CLI 自己退出之后再看指纹。
  const at = src.indexOf('function runClaudeLogin');
  const seg = src.slice(at, at + 1800);
  ok(/child\.on\('exit'/.test(seg) && /now !== before/.test(seg),
    '🔴 runClaudeLogin 等 CLI 自己退出后再看凭证指纹, 才算登录成功');
  ok(!/setInterval/.test(seg),
    '🔴 runClaudeLogin 里没有任何轮询(轮询凭证侧状态必然在用户还在授权时误判成功)');
  ok(!/setInterval[\s\S]{0,300}kill\(/.test(src),
    '🔴 全文件都没有"轮询到某个状态就 kill 登录 CLI"(这个坑栽过两次: isClaudeLoggedIn、凭证指纹)');
}

console.log('\n=== 接入故障分类: 同一句"请重新登录"在四类里有三类是错的 ===');
{
  // 2026-08-21 实测(隔离配置目录跑 bundled claude -p): 未登录时 CLI 回的是
  // subtype:"success" + is_error:true + result:"Not logged in · Please run /login"。
  const { classifyAccessError } = require('../core/agent');
  const kindOf = (s, mode) => { const r = classifyAccessError(s, mode); return r && r.kind; };

  ok(kindOf('Not logged in · Please run /login') === 'oauth_expired',
    '🔴 从没登录过那句(CLI 实测原文)归 oauth_expired');
  ok(kindOf('Failed to authenticate. Please run /login') === 'oauth_expired', '凭证坏了那条归 oauth_expired');
  ok(kindOf('API Error: 401 OAuth access token expired') === 'oauth_expired', '401 + token 过期归 oauth_expired');

  // 🔴 这三条是这次分类的全部意义: 它们过去全被当成"登录失效", 而重登一次都修不了。
  ok(kindOf('API Error: 429 rate_limit_error') === 'quota', '🔴 429 限流归 quota, 不是"登录失效"');
  ok(kindOf('Your credit balance is too low to access the API') === 'quota', '余额不足归 quota');
  ok(kindOf('请求失败: 余额不足，请充值后重试') === 'quota', '🔴 第三方网关的中文额度报错也归 quota');
  ok(kindOf('API Error: 403 Unable to verify organization membership') === 'org_forbidden',
    '🔴 403 组织校验归 org_forbidden(2026-08-26 实撞: 它被吞成"登录失效", 狂人反复重登永远修不好)');
  ok(kindOf('API Error: 401 Missing API key') === 'key_bad',
    '🔴 缺 key 归 key_bad 而不是 oauth_expired(2026-08-22 网关实撞)');

  ok(classifyAccessError('这一轮我把手顺包装上了, 没有任何报错') === null, '正常回复分不出类 → 返回 null');
  ok(classifyAccessError('') === null && classifyAccessError(null) === null, '空输入返回 null');

  // 🔴 接入故障这四类**全是确定性错误, 一个都不重试**。
  // 401 曾被当成"抖动"放行重试, 那是错的: 它是本机 token 过期, 重试用的还是同一把过期 token;
  // 何况 CLI 自己已经重试过 14 次以上才把错误交给宿主, 宿主再试是第 15 次。
  ok(classifyAccessError('Not logged in').retryable === false,
    '🔴 oauth_expired 不重试(token 过期是确定性的, 且 CLI 已经替你重试过十几次了)');
  ok(classifyAccessError('API Error: 429 rate_limit_error').retryable === false,
    '🔴 quota 不重试(重试必然再撞, 还白烧一次额度)');
  ok(classifyAccessError('403 organization membership').retryable === false, '🔴 org_forbidden 不重试');
  ok(classifyAccessError('Invalid API key').retryable === false, '🔴 key_bad 不重试');
  ok(/const RETRYABLE_KINDS = new Set\(\)/.test(fs.readFileSync(path.join(__dirname, '..', 'core', 'agent', 'env.js'), 'utf8')),
    '🔴 重试名单必须是空的 —— 往里加任何一类之前先问: 这个错重试一次结果会不一样吗');

  // 分类顺序不能乱: 具体的在前, 兜底的 401 在最后。
  // "429 ... 401" 这种同时含两个数字的, 必须归更具体的那一类。
  ok(kindOf('API Error: 429 too many requests (was 401 earlier)') === 'quota',
    '🔴 兜底的 401 绝不能抢在 quota 前面命中');
}

console.log('\n=== 判「是不是故障」只用结构信号, 不看文本长相 ===');
{
  const consumeSrc = fs.readFileSync(path.join(__dirname, '..', 'core', 'agent', 'consume.js'), 'utf8');
  ok(/msg\.is_error === true \|\| !streamed/.test(consumeSrc),
    '🔴 用 msg.is_error(CLI 自己标的) 和 !streamed 两条结构信号并联判定, 不靠正则猜"是不是"');
  ok(/cliFault \? classifyAccessError/.test(consumeSrc),
    '🔴 先结构判定是故障, 才拿正文去分类 —— 顺序反了就又变回"文本长得像就算"');
  // SDK 的 error 枚举是 CLI 从 HTTP 响应里读出来的事实, 正则原理上分不开"真 401"和"在谈论 401"。
  // 有事实就不许再猜: 枚举认不出(overloaded 这类本就不是接入故障)也【不】回落正则。
  ok(/subtype === 'api_retry'/.test(consumeSrc),
    '🔴 消费循环必须接住 system/api_retry —— error_status 与 error 枚举只挂在这条消息上');
  ok(/classifySdkError\(fault\.sdkErr/.test(consumeSrc),
    '🔴 本回合有过 api_retry 就按 SDK 枚举判, 正则只在 SDK 全程没说话时兜底');
  // CLI 取凭证的顺序是"有 CLAUDE_CODE_OAUTH_TOKEN 就用它, 没有才读 keychain"。长效 token 过期后
  // 不丢掉的话, OAuth 重登把新凭证写进 keychain 也够不着 —— 表现为"点多少次重新登录都没用",
  // 而且界面上看不出原因。两个定罪出口(result 那条与消费循环抛出那条)都要丢。
  ok((consumeSrc.match(/dropSubscriptionToken\(this\.name\)/g) || []).length === 2,
    '🔴 两个定罪出口都要丢掉失效的长效 token, 否则「重新登录」会变成死路');
  ok(!/length > 600|length > \d{3}/.test(consumeSrc + fs.readFileSync(path.join(__dirname, '..', 'core', 'agent', 'env.js'), 'utf8')),
    '🔴 那道赌"讨论必是长文"的长度门已删除(模型简短引用一句报错就会被它误伤)');
}

console.log('\n=== setup-token 的 token 会被终端折行, 必须拼回来 ===');
{
  // 🔴 这一组来自 2026-09-18 真跑一次 `claude setup-token` 的实际输出形状。
  // 当时代码里是单条正则 /sk-ant-[A-Za-z0-9_-]{20,}/, 只捞到第一段 78 字符 —— 半截 token
  // 长得挺像真的, 存进去要等到下次用才莫名 401。门禁守的就是"别再退回单条正则"。
  const { pickSetupToken } = require('../core/credentials');
  const head = 'sk-ant-oat01-' + 'A'.repeat(65);
  const tail = 'ffdnB_dgXiN7AK8JalCQ-85Gq1wAA';
  const real = [
    'Your OAuth token (valid for 1 year):',
    ' ' + head,                 // 第一段(行宽处断开)
    ' ' + tail,                 // 第二段, 行首带缩进空格
    "Store this token securely. You won't be able to see it again.",
    'Use this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>',
  ].join('\r\n');
  const got = pickSetupToken(real);
  ok(got === head + tail, '🔴 折成两行的 token 要拼回完整(半截 token 会在下次使用时才暴露)');
  ok(!/securely/i.test(got || ''), '🔴 不许把后面的说明句吃进来(删光空白再匹配就会犯这个错)');
  ok(pickSetupToken('x\n sk-ant-oat01-XYZ123abc\nStore this token securely.') === 'sk-ant-oat01-XYZ123abc',
     '不折行的情形照样取得到');
  ok(pickSetupToken('nothing here') === null, '认不出就返回 null, 不硬凑');
}

console.log('\n=== 真实 pty 原始输出(含 ink 重绘)也要拼得出来 ===');
{
  // 🔴 这份固件是 2026-09-19 真跑一次 `claude setup-token` 抓下来的**原始字节**, token 字符
  // 已等长脱敏, ANSI 控制符一个没动。上面那组手捏样本全绿、真机却 401, 差别就在这里:
  // 真输出里两段 token 之间没有任何换行符, 靠 ESC[1B / ESC[15G 摆位置。
  const { pickSetupToken } = require('../core/credentials');
  const raw = fs.readFileSync(path.join(__dirname, 'test', 'fixtures', 'setup-token-raw.txt'), 'latin1');
  const got = pickSetupToken(raw);
  ok(got === 'sk-ant-oat01-' + 'A'.repeat(66) + 'B'.repeat(12) + 'J' + 'C'.repeat(16),
    '🔴 原始输出要回放成屏幕再读 —— strip 掉控制符按行拼只能拿到 105 字符的半截货');
  ok((got || '').length === 108, `完整 token 是 108 字符(实得 ${(got || '').length})`);
  // 那个 J 是 ink 上一帧留在该列、这一帧没重写的字符。它夹在两段之间, 任何"删掉控制符再
  // 按行拼"的写法都必然漏掉它 —— 漏一个字符的 token 长得跟真的一样, 要到下次用才 401。
  ok(/B{12}JC{16}$/.test(got || ''), '🔴 上一帧残留在该列的字符也要捞回来(少一个字符就是坏 token)');
  ok(!/securely|Store/i.test(got || ''), '不许把后面的说明句吃进来');
}

console.log('\n=== 抖动: 先重试一次再定罪, 且限一次 ===');
{
  const consumeSrc = fs.readFileSync(path.join(__dirname, '..', 'core', 'agent', 'consume.js'), 'utf8');
  const streamSrc = fs.readFileSync(path.join(__dirname, '..', 'core', 'agent', 'stream.js'), 'utf8');
  ok(/access\.retryable && !this\._authRetried/.test(consumeSrc),
    '🔴 只有 retryable 的那类才重试, 且 _authRetried 限一次(不限就是无限打转)');
  ok(/_retryAfterTransientFault/.test(consumeSrc) && /async _retryAfterTransientFault/.test(streamSrc),
    '重试走 _retryAfterTransientFault');
  ok(/if \(!opts\._authRetry\) this\._authRetried = false;/.test(streamSrc),
    '🔴 重试轮不清 _authRetried, 否则"错→重试→又错→再重试"无限打转');
  ok(/_teardownStream\(\)[\s\S]{0,400}_lastSubmitPayload/.test(streamSrc.slice(streamSrc.indexOf('async _retryAfterTransientFault'))),
    '🔴 重试前必须拆流(子进程只在启动那刻读一次 keychain, 不拆就还是那个坏进程在答)');
  const fnSeg = streamSrc.slice(streamSrc.indexOf('async _retryAfterTransientFault'), streamSrc.indexOf('async _teardownStream'));
  ok(!/_lastSubmitPayload = null/.test(fnSeg),
    '🔴 重试【不】清 _lastSubmitPayload(重试又失败的话, 那条消息还得留给重登后回放)');
}

console.log('\n=== 横幅按 kind 给出口: 只有 oauth_expired 配重登按钮 ===');
{
  const rSrc = fs.readFileSync(path.join(__dirname, 'renderer', 'renderer.js'), 'utf8');
  ok(/ACCESS_BANNER_TEXT/.test(rSrc) && /quota: 'access_quota_named'/.test(rSrc),
    '横幅文案按 kind 分表');
  ok(/if \(kind === 'oauth_expired'\)[\s\S]{0,200}authReloginBtn\.classList\.remove\('hidden'\)[\s\S]{0,200}else[\s\S]{0,120}authReloginBtn\.classList\.add\('hidden'\)/.test(rSrc),
    '🔴 重登按钮只给 oauth_expired, 其余类隐藏(给了就是把人往死路上指)');
  ok(/d\.raw && kind !== 'oauth_expired'/.test(rSrc),
    '🔴 非重登类要显示报错原文, 让用户看得见真因');
  const i18nSrc = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf8');
  for (const k of ['access_quota_named', 'access_org_forbidden_named', 'access_key_bad_named', 'access_raw_detail']) {
    const n = i18nSrc.split(k + ':').length - 1;
    ok(n === 3, `${k} 三语齐全(实际 ${n} 份)`);
  }
  ok(/重新登录没用/.test(i18nSrc),
    '🔴 中文文案必须明说"重新登录没用"(否则用户还是会去重登, 那正是这次要治的病)');
}

console.log('\n=== 订阅不是唯一通路 ===');
{
  const at = src.indexOf('async function ensureClaudeAuth');
  const seg = src.slice(at, at + 2200);
  ok(/hasAnyKey\([\s\S]{0,160}return true/.test(seg),
    '🔴 凭据仓库有任何一把 API key 就不弹登录框(只用 key 的机器不需要 OAuth)');
  ok(/buttons: \['连接 Claude', '先进去', '退出'\]/.test(seg),
    '🔴 登录框有第三个出口"先进去"(否则干净机器上填 key 是死锁: 填 key 要进设置, 进设置要开窗)');
  ok(/if \(choice === 1\)[\s\S]{0,200}return false;/.test(seg) && /if \(choice === 2\) \{ app\.quit\(\)/.test(seg),
    '🔴 "先进去"往下走而不是 quit, 退出挪到 choice===2');
}

console.log('\n=== 探测失败 ≠ 没登录 ===');
{
  const at = src.indexOf('function isClaudeLoggedIn');
  const seg = src.slice(at, src.indexOf('function hasUsableCredential'));
  ok(at !== -1, '找得到 isClaudeLoggedIn');
  ok(!/if \(r\.status !== 0\) return false;/.test(seg),
    '🔴 不拿退出码直接判未登录(未登录时 CLI 也是 exit=1 + 合法 JSON, 分不出探测失败)');
  ok(/typeof j\.loggedIn === 'boolean'/.test(seg),
    '🔴 解析得出 loggedIn 字段才算 CLI 真的回答了');
  ok(/hasUsableCredential\(\)/.test(seg),
    '🔴 CLI 没给出可信答案时回退看凭证, 而不是把能用的 app 拿登录框挡住');
  ok(/function hasUsableCredential/.test(src) && /exp > Date\.now\(\)/.test(src),
    '兜底判据看的是凭证有没有过期, 不只是文件在不在');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
