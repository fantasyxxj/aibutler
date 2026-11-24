// commands.js — 行内命令的目录和执行(个人版)。
//
// AI 能做的只有「从目录里挑」。语法里没有『去处』这一项, 所以「把东西发到任意地方」的
// 界面在文法上就写不出来。真去哪由这里的处理函数定。
//
// 目录里没有的名字、缺必填参数, 一律【红字摆到台面上】。静默吞掉就会变成
// 「以为发出去了, 其实什么都没发生」—— 跟 JSON 列拿 200 收下拼错的键是同一种事故。
'use strict';

const { cfg } = require('./host');
const workflow = require('./workflow.js');
const netFetch = require('./net-fetch.js');

/* ── 包带来的命令 ──
   下发包要能**增量提升能力**, 不能加点东西就让用户重装(作者 2026-08-13)。
   于是命令目录可以随包热更。这件事之所以安全, 不靠审核, 靠三条结构:

   1. 认识名字但没实现 → not_implemented 红字。包最多把宿主**已有的**东西开放出来,
      变不出新能力 —— 天然封顶。
   2. **内置优先**。同名一律以源码为准。按钮上的字是包写的、干的事是宿主的,
      让包重定义内置命令 = 它能把 wf_go 的按钮文字改成「保存草稿」, 或者把
      notify_ai 翻成 true(每翻一页烧一次模型钱)。这叫标签欺骗, 是钓鱼界面的形状。
   3. **channel 不从包读**。channel 决定数据去哪个平台, 包能改它就等于能把一条命令的
      去处换掉。个人版只有 local 一条路所以看着没事, 行业版是真的权限跨越 ——
      两边都按同一条规矩来, 免得哪天抄过去就漏了。

   还有一条形状上的: 包的命令**强制带包 id 前缀**(geo.flip)。多包并存必然撞名,
   而撞名之后谁覆盖谁是没法自诊断的。 */
const PKG_COMMANDS = new Map();

const PKG_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

// 包声明里**只有这些字段会被采纳**。channel / handler 这类不在表上的一律丢掉 ——
// 用白名单而不是黑名单: 以后加了新字段, 忘了更新这里也只是它不生效, 而不是它偷偷生效。
// `http` 是 bus 原语专用 —— 这条命令要叩的端点 {method, path}, 包自己写在声明里。
// **它跟 channel 不一样, 可以从包读**: 声明随包一起签名, 而参数是界面现填的; 出口(channel)
// 照旧由源码定。path 只许 /bus/v1/ 开头 —— 那道笼子在 registerPackageCommands 里, 拦的是
// 「包借这条路当任意代理」。
// `op` は mail 原語専用 —— http と同じ扱い(出口そのものではなく、その原語の中でどれをするか)。
// 白名単に足し忘れると、宣言に書いても静かに落ちて `bad_decl` になる(2026-09-02 に踏んだ)。
// 🔴 **白名单**。ここに無い欄は登記の時に落ちる —— 宣言に書いたのに効かない、という形で。
//    `idempotency` と `termbase_fill` は宿主が読む欄なので、増やす時はこの表も一緒に。
const PKG_DECL_FIELDS = ['summary', 'params', 'label_default', 'notify_ai', 'primitive', 'http', 'op',
                        'idempotency', 'termbase_fill', 'ai', 'sql', 'max_sec', 'kinds'];

// 端点の笼: /bus/v1/ 以外は装填の時点で弾く。呼ぶ時ではなく**登記の時**に弾くのが肝 ——
// 押されるまで気付かない不備は、実機で店主が押した時に初めて出る。
const BUS_PATH_PREFIX = '/bus/v1/';
function badBusDecl(decl) {
  if (String(decl.primitive || '') !== 'bus') return null;
  const h = decl.http;
  if (!h || typeof h !== 'object' || !h.path) return 'bus 原语要声明 http.path';
  if (!String(h.path).startsWith(BUS_PATH_PREFIX)) {
    return `path 必须以 ${BUS_PATH_PREFIX} 开头 (安全笼: 禁任意代理)`;
  }
  return null;
}

function pkgCommandsReset() { PKG_COMMANDS.clear(); SETUP_DONE.clear(); }

/* 把一个包声明的命令收进来。宿主这侧加前缀, 不信包自报的全名。 */
/* 包级 db_setup: 第一次跑这个包的 db 命令前执行一次的建表语句。只收 CREATE … IF NOT EXISTS ——
   重复跑无害, 也改不了已有的表。人格可能在界面一次都没打开过时就先 plugin_call 写库, 表得先在。 */
const SETUP_RE = /^\s*create\s+(?:unique\s+)?(?:table|index)\s+if\s+not\s+exists\b/i;
const SETUP_DONE = new Set();
function checkDbSetup(list) {
  if (list === undefined) return null;
  if (!Array.isArray(list) || !list.every((x) => typeof x === 'string' && SETUP_RE.test(x))) return 'db_setup 只收 CREATE TABLE/INDEX IF NOT EXISTS 语句的数组';
  return null;
}

function registerPackageCommands(pkgId, decls, { dbSetup, net } = {}) {
  const id = String(pkgId || '');
  if (!PKG_NAME.test(id)) return { ok: false, code: 'bad_pkg_id', message: `包 id 不合法: ${pkgId}` };
  if (!decls || typeof decls !== 'object') return { ok: true, added: [] };

  const added = [], rejected = [];
  const setupBad = checkDbSetup(dbSetup);
  if (setupBad) console.warn(`[commands] ${id}: ${setupBad}, 已忽略`);
  const setup = setupBad || !dbSetup ? null : dbSetup.slice();
  // 包级 net: 这个包的 web 命令能去的地址名单。认不出的项告警后丢掉, 不拿它当「任意」
  const netParsed = netFetch.parseNet(net);
  if (netParsed.bad.length) console.warn(`[commands] ${id}: net 里这些项认不出, 已忽略: ${netParsed.bad.join(', ')}`);
  for (const [rawName, rawDecl] of Object.entries(decls)) {
    if (!PKG_NAME.test(rawName)) { rejected.push({ name: rawName, why: '名字不合法' }); continue; }
    if (!rawDecl || typeof rawDecl !== 'object') { rejected.push({ name: rawName, why: '声明不是对象' }); continue; }
    const prim = String(rawDecl.primitive || '');
    // 原语是能力的真实上限, 只有源码里有的那几个。包挑一个用, 挑不出新的。
    if (!PRIMITIVES[prim]) { rejected.push({ name: rawName, why: `没有这个原语: ${prim || '(空)'}` }); continue; }

    const decl = {};
    for (const k of PKG_DECL_FIELDS) if (rawDecl[k] !== undefined) decl[k] = rawDecl[k];
    /* 🔴 白名单に無い欄は落ちる。**落ちた事を言う** —— 黙って落とすと「宣言に書いたのに
       効かない」を一時間追う事になる(2026-09-28 termbase_fill で実際にそうなった)。
       弾くのではなく警告だけ: 未知の欄で命令ごと拒むと、新しい欄を足した版の包が
       古い版の宿主で丸ごと動かなくなる。 */
    const unknown = Object.keys(rawDecl).filter((k) => !PKG_DECL_FIELDS.includes(k) && k !== 'channel');
    if (unknown.length) {
      console.warn(`[commands] ${id}.${rawName}: 宣言の欄 ${unknown.join(', ')} は登記されない`
                   + `(PKG_DECL_FIELDS に無い) —— 宿主がこの欄を読む筈なら、そちらに足す`);
    }
    const why = badBusDecl({ primitive: prim, http: decl.http })
      || (prim === 'web' ? netFetch.badWebDecl(decl.http, netParsed.list) : null);
    if (why) { rejected.push({ name: rawName, why }); continue; }
    if (prim === 'web') decl.netList = netParsed.list;
    /* ai:true = 人格也能用 plugin_call 调这条(默认只给人按)。db 命令开放给人格时 SQL 必须写死在声明里,
       参数只填空 —— 否则调用方现填整句 SQL, 「只给人点的删除」就成了空话。没写 sql 的不开放。 */
    if (decl.ai === true && prim === 'db' && !String(decl.sql || '').trim()) {
      console.warn(`[commands] ${id}.${rawName}: ai:true 的 db 命令要在声明里写死 sql, 未开放给人格`);
      decl.ai = false;
    }
    // 录音只给人按: 让人格能开麦克风, 等于它想什么时候听就什么时候听。
    // 录音的开停也不叫醒 AI(行业版的 notifyAi 只看 notify_ai, 不看原语默认值), 包显式写了才听它的。
    // 评测也只给人按: 每评一次花的是用户自己那把 key 的额度。
    if (prim === 'record' || prim === 'pron') { decl.ai = false; if (decl.notify_ai == null) decl.notify_ai = false; }
    // 弹选择框只给人按: 让人格去挑用户的文件没有意义, 授权得是人亲手点的。
    if (prim === 'asset' && decl.op === 'pick') decl.ai = false;
    if (prim === 'db' && setup) decl.setup = setup;
    decl.channel = 'local';   // 🔴 源码定。包写什么都不算数。
    decl.pkg = id;
    PKG_COMMANDS.set(`${id}.${rawName}`, decl);
    added.push(`${id}.${rawName}`);
  }
  return { ok: true, added, rejected };
}

/* 装上所有已落地的包带的命令。all = packages.loadAll() 的结果。 */
function loadFromPackages(all) {
  const loaded = [], failed = [];
  for (const p of (all && all.accepted) || []) {
    if (!p.commands) continue;
    const r = registerPackageCommands(p.id, p.commands, { dbSetup: p.db_setup, net: p.net });
    if (!r.ok) { failed.push({ id: p.id, code: r.code, message: r.message }); continue; }
    if (r.added.length) loaded.push({ id: p.id, added: r.added });
    for (const x of r.rejected || []) failed.push({ id: p.id, code: 'bad_command', message: `${x.name}: ${x.why}` });
  }
  return { loaded, failed };
}

/* 目录 = 内置 + 包的。**内置写在后面** —— 同名时以源码为准, 这一行就是"防标签欺骗"落地的地方。 */
function catalog() {
  const builtin = cfg.json('commands').commands || {};
  const out = {};
  for (const [k, v] of PKG_COMMANDS) out[k] = v;
  return Object.assign(out, builtin);
}

/* 执行完要不要告诉 AI。判据是【AI 不知道的话, 它下一句会不会说错】, 不是「这事重不重要」。

   🔴 默认值长在**原语**身上, 不是一个全局 true。能到 AI 那儿的只有这条命令返回的 message,
   而 speak / state 返回的是空串 —— 通知过去只是一个光秃秃的 [包id.命令名], AI 收了也不知道
   发生过什么, 白唤醒一次白计一次费。把这个判断丢给写包的人是丢错了地方: 他看不见 message
   是空的(作者 2026-08-21 就是这么撞上的 —— 以为 speak 能把录入的内容带给 AI, 实际连念了
   什么都没告诉它)。约束长在原语自己身上, 跟 PRIMITIVES 是同一条规矩。 */
const PRIMITIVE_NOTIFY = {
  speak: false,       // message 是空串; 而且"念一段给用户听"不改变 AI 下一句说什么
  state: false,       // message 是空串; 往包自己的抽屉记一格, AI 不需要知道
  save_file: true,    // message 是「已存到 <路径>」—— 后面用户问"存哪了", AI 答得上来
  message: true,      // 这条原语的全部意义就是把内容交给 AI, 见下面的强制
  bus: false,         // 取回的数据是给**界面**画的; 三十行预约表塞进对话是白烧一轮
  mail: false,        // 同上: 收件箱是画给店主看的, 不是念给 AI 听的
  ai_access: false,   // 接入设置是画给店主看的; 而且**结果里带着端点地址, 更不该念给 AI**
  web: false,         // 跟 bus 同理: 取回的是给界面画的
  secret: false,      // 只回「设没设」, AI 不需要知道
  record: false,      // 交回的是录音编号和路径, 给界面接着用(回放、送去评分)
  pron: false,        // 分数是画给练的人看的
  asset: false,       // 交回的是给界面用的地址和文件清单
};

function notifyAi(name) {
  const decl = catalog()[name];
  if (!decl) return true;
  // 🔴 message 强制通知: 它除了"把内容送到 AI 那儿"没有别的作用, 声明成 false 等于白调一次
  // 且不报错 —— 静默陷阱在这儿堵死, 比指望写包的人不写错可靠。
  if (decl.primitive === 'message') return true;
  if (decl.notify_ai != null) return decl.notify_ai !== false;   // 显式写了就听它的
  if (decl.primitive) return PRIMITIVE_NOTIFY[decl.primitive] !== false;
  return true;   // 内置命令(wf_go 这些)在 commands.json 里自己写死了, 走不到这
}

// "name|k=v|label=文字" → { name, args, label }
// 值里有 = 也只按第一个 = 切(好让 URL、整句话能原样放进去)。
function parseSpec(spec) {
  const parts = String(spec || '').split('|').map((s) => s.trim()).filter(Boolean);
  const name = parts.shift() || '';
  const args = {};
  let label = '';
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    const k = p.slice(0, eq).trim();
    const v = p.slice(eq + 1).trim();
    if (k === 'label') label = v; else args[k] = v;
  }
  return { name, args, label };
}

// 跟目录对一遍。返回 null = 没问题。
function validate(name, args) {
  const decl = catalog()[name];
  if (!decl) return { code: 'unknown_command', message: `未知命令: ${name}` };
  for (const [k, p] of Object.entries(decl.params || {})) {
    const v = args[k];
    if (p.required && (v === undefined || v === '')) {
      return { code: 'missing_param', message: `${name}: 缺少参数 ${k}` };
    }
    if (v !== undefined && p.type === 'int' && !/^\d+$/.test(String(v))) {
      return { code: 'bad_param', message: `${name}: ${k} 要填数字(收到的是: ${v})` };
    }
  }
  return null;
}

// handlers: (args, ctx) => { ok, message, render? }
const HANDLERS = {
  /* 翻一屏。**返回的 render 会原地换掉那一屏** ——
     这就是「不用在对话里说下一步」的由来, AI 一次都没被叫到。 */
  async wf_go(args, ctx) {
    return workflow.go(args.wf, { to: args.to, from: args.from, mark: args.mark },
                       { locale: ctx.locale });
  },

  // 最后一屏。
  async wf_finish(args, ctx) {
    return workflow.finish(args.wf, { from: args.from }, ctx, { locale: ctx.locale });
  },
};

/* ── 原语 ──
   包只能从这张表里挑, 挑不出新的 —— 这张表就是**能力的真实上限**, 改它要发版。
   收敛成原语的好处: 「把这张图当店铺横幅」「记下他选了哪个套餐」这类新需求以后零发版。
   代价是原语越通用包能干的越多, 所以**每个原语自己带死约束**, 而不是指望调用方守规矩。

   真正碰外界的动作(出声、写盘)由 ctx 注入 —— 这个文件保持能在纯 node 下跑起来,
   门禁才测得动。 */
const PRIMITIVES = {
  /* 念一段。教学场景最实在的一个: 课件让它念单词, 而不是让 AI 生成一遍再念。
     🔴 只念**看得见的那段文字**。不接受 SSML —— 能写 SSML 就能塞 <hidden>,
        那就成了"念出来的和屏幕上写的不是一回事"。 */
  async speak(args, ctx) {
    const text = String(args.text || '').trim();
    if (!text) return { ok: false, code: 'missing_param', message: 'speak: 没有要念的内容' };
    if (text.length > 2000) return { ok: false, code: 'too_long', message: 'speak: 一次念不了这么长' };
    if (/[<>]/.test(text)) return { ok: false, code: 'bad_param', message: 'speak: 只念纯文字, 不收标签' };
    if (typeof ctx.speak !== 'function') {
      return { ok: false, code: 'no_voice', message: 'speak: 这台机器上没有朗读' };
    }
    // lang(可选, 如 en-GB / ja-JP): 用这种语言的声音念 —— 人格自己的声音念外语单词, 学的人听不到标准读音
    const lang = String(args.lang || '').trim();
    if (lang && !/^[a-z]{2,3}(-[A-Z]{2})?$/.test(lang)) return { ok: false, code: 'bad_param', message: `speak: lang 写成 en-GB 这种形状(收到 ${lang})` };
    await ctx.speak(text, lang ? { lang } : undefined);
    return { ok: true, message: '' };
  },

  /* 存一份东西下来(练习结果、课件导出的图…)。
     🔴 存哪儿由**用户在系统的保存框里**定, 不由包定 —— 包给不出路径这一项,
        所以"悄悄写到某个目录"在形状上就做不到。 */
  async save_file(args, ctx) {
    const name = String(args.filename || '').trim();
    const content = String(args.content == null ? '' : args.content);
    if (!name) return { ok: false, code: 'missing_param', message: 'save_file: 没有文件名' };
    // 文件名里出现路径分隔符 = 想指定存哪儿。名字就该只是名字。
    if (/[/\\]/.test(name) || name.includes('..')) {
      return { ok: false, code: 'bad_param', message: 'save_file: 文件名里不能有路径' };
    }
    if (content.length > 2 * 1024 * 1024) {
      return { ok: false, code: 'too_big', message: 'save_file: 内容太大(超过 2MB)' };
    }
    if (typeof ctx.saveFile !== 'function') {
      return { ok: false, code: 'no_save', message: 'save_file: 这个版本存不了文件' };
    }
    const r = await ctx.saveFile(name, content);
    if (!r || !r.ok) return { ok: false, code: 'save_failed', message: (r && r.message) || '没存成' };
    return { ok: true, message: r.path ? `已存到 ${r.path}` : '已保存' };
  },

  /* 改包自己那个抽屉里的一格。沙箱里有 setState 走的是另一条路(整份覆盖),
     这条是给 markdown 里的 {{cmd:}} 按钮用的 —— 不进沙箱也能记一笔。
     🔴 抽屉是**按声明这条命令的包**认的, 不看参数里写的是谁。 */
  async state(args, ctx, decl) {
    const key = String(args.key || '').trim();
    if (!key) return { ok: false, code: 'missing_param', message: 'state: 没有 key' };
    if (typeof ctx.uiState !== 'function') {
      return { ok: false, code: 'no_state', message: 'state: 这个版本存不了状态' };
    }
    const r = ctx.uiState(decl.pkg, key, String(args.value == null ? '' : args.value));
    if (!r || !r.ok) return { ok: false, code: 'state_failed', message: (r && r.message) || '没记上' };
    return { ok: true, message: '' };
  },

  /* 把一段内容交给 AI(不朗读)。表单提交、数据上报走这条。
     🔴 在它之前, 沙箱里**没有任何一条路**能把内容送到模型那儿 —— 往外只发得出
        call / state / resize / ready / beat 五种消息, 而能到模型的只有命令返回的 message,
        speak 和 state 返回的都是空串。于是"把表单内容发给 AI"在形状上做不到, 且它失败的
        样子是【念了一段, 但 AI 什么都没收到】, 不报错(作者 2026-08-21 实撞)。
     🔴 只收纯文字: 收标签的话包就能往对话里塞 HTML/SSML, 那又成了"屏幕上写的和送出去的
        不是一回事" —— 跟 speak 拒绝 SSML 是同一个理由。
     不碰外界, 所以不需要 ctx。 */
  async message(args) {
    const text = String(args.text || '').trim();
    if (!text) return { ok: false, code: 'missing_param', message: 'message: 没有要发的内容' };
    if (text.length > 4000) return { ok: false, code: 'too_long', message: 'message: 内容太长' };
    if (/[<>]/.test(text)) return { ok: false, code: 'bad_param', message: 'message: 只收纯文字, 不收标签' };
    return { ok: true, message: text };
  },

  /* 读写这个包自己的数据库。op = query(查, 返 rows) | run(增删改, 返 changes/lastInsertId)。
     🔴 连哪个库由 decl.pkg 认 —— 包只能碰到自己声明的那份连接配置, 碰不到别的包的库。
     sql 走 ctx.db 的 prepared statement, 参数化堵注入; 配额(行数/写频)在宿主层。 */
  async db(args, ctx, decl) {
    const op = String(args.op || 'query');
    if (op !== 'query' && op !== 'run') {
      return { ok: false, code: 'bad_param', message: 'db: op 要 query 或 run' };
    }
    if (typeof ctx.db !== 'function') {
      return { ok: false, code: 'no_db', message: 'db: 这个版本没有数据库口子' };
    }
    if (decl && decl.setup && !SETUP_DONE.has(decl.pkg)) {
      for (const stmt of decl.setup) {
        const r = await ctx.db(decl.pkg, 'run', stmt, []);
        if (!r || !r.ok) return r || { ok: false, code: 'db_setup_failed', message: 'db_setup 没跑成' };
      }
      SETUP_DONE.add(decl.pkg);
    }
    // 声明里写死了 sql: 只用它, 参数按 params 声明的顺序从 args 取 —— 调用方改不了语句本身。
    if (decl && String(decl.sql || '').trim()) {
      const fixed = String(decl.sql).trim();
      const fixedOp = decl.op === 'query' || decl.op === 'run' ? decl.op : (/^select\b/i.test(fixed) ? 'query' : 'run');
      const vals = Object.keys(decl.params || {}).map((k) => (args[k] === undefined ? null : args[k]));
      return ctx.db(decl.pkg, fixedOp, fixed, vals);
    }
    const sql = String(args.sql || '').trim();
    if (!sql) return { ok: false, code: 'missing_param', message: 'db: 没有 sql' };
    const params = Array.isArray(args.params) ? args.params : [];
    return ctx.db(decl && decl.pkg, op, sql, params);
  },

  /* 店的邮箱。**在这台机器里收, 从这台机器发** —— 凭据不上服务器
     (作者 2026-09-02:「敏感信息放服务端才是他们忌讳的」)。
     🔴 做什么只从**声明的 op** 读, 不从调用参数读: list / read / send 三个。
        让参数决定操作, 等于把「这个包能干什么」交给包自己现填。 */
  async mail(args, ctx, decl) {
    const op = String((decl && decl.op) || '').trim();
    if (!['status', 'config', 'list', 'read', 'send'].includes(op)) {
      return { ok: false, code: 'bad_decl', message: 'mail: op 只能是 status / config / list / read / send' };
    }
    if (typeof ctx.mail !== 'function') {
      return { ok: false, code: 'no_mail', message: 'mail: 这个版本没有邮件的口子' };
    }
    const r = await ctx.mail(op, args || {});
    if (!r || !r.ok) {
      return { ok: false, code: (r && r.code) || 'mail_failed',
               message: (r && r.message) || '邮箱没应' };
    }
    return { ok: true, message: r.message || '', data: r.data };
  },

  /* AI へ繋ぐ鍵の設定。店主が自分で買った鍵はこの機械の金庫に置き、サーバへは上げない。
     🔴 **鍵を読み出す op は無い**(status / config / clear / test の四つだけ) —— 画面へ返せる
        時点で、包みのコードからも AI からも取れるという事なので。 */
  async ai_access(args, ctx, decl) {
    const op = String((decl && decl.op) || '').trim();
    if (!['status', 'config', 'clear', 'test'].includes(op)) {
      return { ok: false, code: 'bad_decl', message: 'ai_access: op 只能是 status / config / clear / test' };
    }
    if (typeof ctx.aiAccess !== 'function') {
      return { ok: false, code: 'no_ai_access', message: 'ai_access: 这个版本没有接入设置的口子' };
    }
    const r = await ctx.aiAccess(op, args || {});
    if (!r || !r.ok) {
      return { ok: false, code: (r && r.code) || 'ai_access_failed',
               message: (r && r.message) || '接入设置没应' };
    }
    return { ok: true, message: r.message || '', data: r.data };
  },

  /* 叩包自己声明过的外部地址(包级 net 名单 + 命令声明 http.url), 结果走 data 给界面。
     去哪儿、带哪把密钥都只从声明读; 界面能填的只有 url 里的 {} 空、query、body。
     名单和跳转的检查都在 net-fetch.js, 登记时查一遍, 这里发之前再查一遍。 */
  async web(args, ctx, decl) {
    const getSecret = ctx.pkgSecrets ? (name) => ctx.pkgSecrets.get(decl.pkg, name) : null;
    return netFetch.request(decl || {}, args || {}, { getSecret, fetchImpl: ctx.fetch });
  },

  /* web 命令要带的密钥: 存 / 查有没有 / 清。**没有读出原文的 op**。包认 decl.pkg。 */
  async secret(args, ctx, decl) {
    const op = String((decl && decl.op) || '').trim();
    if (!['status', 'set', 'clear'].includes(op)) {
      return { ok: false, code: 'bad_decl', message: 'secret: op 只能是 status / set / clear' };
    }
    if (!ctx.pkgSecrets) return { ok: false, code: 'no_secret_store', message: 'secret: 这个版本没有存密钥的地方' };
    return ctx.pkgSecrets.handle(decl.pkg, op, args || {});
  },

  // 录音 / 发音评测 / 读本地资源: 实现在 primitives-media.js
  ...require('./primitives-media.js'),

  /* 叩这条命令自己声明的端点, 把业务数据取回给界面。
     🔴 **端点只从声明里读(decl.http), 绝不从调用参数读** —— 参数是界面传的, 而界面里跑的
        正是包自己的代码; 让它现填 path, 等于把一个任意出口交到包手上。声明是随包签名的,
        参数不是, 这就是两者的全部区别。参数只能填 path 里 {} 括起来的那几个空。
     🔴 通路(channel)照旧由源码定, 包写什么都不算数; path 的前缀笼在登记那一刻已经查过。
     🔴 取回的数据走 `data` 给界面, **不进 message** —— message 是通往 AI 的那条路,
        把三十行预约表塞进去就是白烧一轮(而且 notify_ai 默认已经是 false)。 */
  async bus(args, ctx, decl) {
    const why = badBusDecl(decl || {});
    if (why) return { ok: false, code: 'bad_decl', message: `bus: ${why}` };
    if (typeof ctx.bus !== 'function') {
      return { ok: false, code: 'no_bus', message: 'bus: 这个版本没有通往平台的路' };
    }
    const r = await ctx.bus(decl.pkg, decl.http, args || {});
    if (!r || !r.ok) {
      return { ok: false, code: (r && r.code) || 'bus_failed',
               message: (r && (r.message || r.detail)) || '没叩通' };
    }
    return { ok: true, message: '', data: r.data };
  },
};

/* 执行。界面那边也会照着目录挡一遍, 这里再挡一次 —— 界面不是防线。
   个人版只有 local 一条路: 什么都不出这台机器, 所以断网照样能翻手顺。
   声明成别的 channel 的一律拒掉并说清楚, 别装作能送出去 ——
   从行业版整段抄来的命令声明会栽在这儿, 而这正是我们要的。 */
async function run(name, args, ctx = {}) {
  const bad = validate(name, args);
  if (bad) return { ok: false, ...bad };
  const decl = catalog()[name];
  const channel = decl.channel || 'local';
  if (channel !== 'local') {
    return { ok: false, code: 'no_channel',
             message: `${name}: 个人版只有本机命令, 没有通往 ${channel} 平台的路` };
  }
  // 内置的走自己的实现; 包声明的走它挑中的那个原语。两条都在源码里, 包都够不着。
  const handler = HANDLERS[name] || (decl.primitive ? PRIMITIVES[decl.primitive] : null);
  if (!handler) return { ok: false, code: 'not_implemented', message: `${name} 还没实现` };
  try {
    return await handler(args, ctx, decl);
  } catch (e) {
    return { ok: false, code: 'command_failed', message: e.message || String(e) };
  }
}

/* 一个包开放给人格的命令(ai:true), 给 plugin_find 列、给 plugin_call 认。 */
function aiCommands(pkgId) {
  const out = [];
  for (const [full, d] of PKG_COMMANDS) {
    if (d.pkg !== pkgId || d.ai !== true) continue;
    out.push({ command: full.slice(pkgId.length + 1), summary: d.summary || '', params: d.params || {} });
  }
  return out;
}

module.exports = { catalog, parseSpec, validate, run, notifyAi, aiCommands,
                   registerPackageCommands, loadFromPackages, pkgCommandsReset,
                   PRIMITIVES, PKG_DECL_FIELDS, _PKG_COMMANDS: PKG_COMMANDS };
