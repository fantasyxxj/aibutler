// sandbox.js — 下发包的界面代码跑的那个「什么都没有的世界」。
//
// 为什么要有这一层: 包要能增量提升 butler 的能力, 不能加点东西就让用户重装。
// 但「能带代码」和「能碰宿主」必须拆开 —— 老口径用「包里只能是数据」来防, 代价是
// 能力永远不能增量, 于是下发机制本身失去了意义(作者 2026-08-13 推翻)。
// 正确的手段不是禁止, 是隔离: 包的界面逻辑随便写多复杂, 但跑在一个
// 没有 require / fs / fetch / 宿主 DOM / IPC / preload 的世界里。
// 它唯一能做的事是隔着一条窄缝喊一句「我想干这个」, 宿主对着目录核一遍, 认识才做。
//
// 🔴 四条命门(漏一条这层就是摆设):
//   1. CSP 必须 default-src 'none' —— **sandbox 属性不挡 fetch**。只靠 sandbox 的话,
//      包能把用户屏幕上的东西往外发。这是最容易漏的一条。
//   2. allow-same-origin 绝对不能加 —— 加了当场失效, 跟没有一样。
//   3. 收消息认 source 不认 origin —— 无 same-origin 的 iframe origin 是 "null",
//      拿它做判断等于谁都能冒充。要比对 contentWindow 本身。
//   4. init 里放什么是白名单 —— 只给这个界面画自己用得着的, 不给「顺便给它用着」的。
//      沙箱里的代码靠 CSP 出不去, 但 CSP 哪天配漏了, 传进去的就全出去了。
(function () {
  'use strict';

  // 包能存多少自己的状态。没有上限的话, 一个 while(true) 里 setState 就能把用户磁盘写满。
  const MAX_STATE_BYTES = 64 * 1024;
  // 一个结构参数(web 的 query / body)最多多大
  const MAX_STRUCT_ARG = 16 * 1024;
  // 打开时的初始值(`{{ui:id|k=v}}`): 只收扁平短串。个人版放到 2000 字 —— 跟读 / 评测要整段原文
  const MAX_OPEN_ARGS = 12;
  const MAX_OPEN_ARG_LEN = 2000;
  function cleanOpenArgs(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const k of Object.keys(raw).slice(0, MAX_OPEN_ARGS)) {
      const v = raw[k];
      if (!/^[a-z][a-z0-9_]{0,31}$/.test(k) || v == null || typeof v === 'object') continue;
      out[k] = String(v).slice(0, MAX_OPEN_ARG_LEN);
    }
    return out;
  }
  // 装上多久没喊 ready = 这个界面根本没起来(写错了/被 CSP 拦了)。
  const READY_TIMEOUT_MS = 4000;
  // 心跳。iframe 与主页面共享事件循环, 包里一个死循环能把整个窗口卡住 ——
  // 卡住就拆掉它, 保住宿主。
  const BEAT_INTERVAL_MS = 2000;
  const BEAT_MISS_LIMIT = 3;

  /* 沙箱世界的 CSP。
     'unsafe-inline' 是要的 —— 包的 html/css/js 就是内联进来的, 没有别的来源可给。
     但**没有 'unsafe-eval'**: 包不需要 eval, 而 eval 是把一段从别处拿来的字符串
     变成代码的唯一入口, 留着它等于给「二次下发」开了个不受签名管的后门。
     connect-src / img-src 里没有 http —— 出网这件事整条不给, 要联网就交给 AI。
     butler-asset: 是 asset 原语交回的本地资源地址: 只放给 img / media, 能显示能播,
     fetch 走 connect-src(回落 'none')读不到原始字节。 */
  const CSP = [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src data: butler-asset:",
    "media-src butler-asset:",
    "font-src data:",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');

  // 沙箱里那一小段桥。包的代码只看得见 window.butlerUI 这一个对象。
  // 🔴 这段是**宿主写的**, 不是包写的 —— 包覆盖 window.butlerUI 只能骗到它自己,
  //    真正决定往外发什么的是宿主那侧的 onmessage。
  const BRIDGE = `
(function(){
  'use strict';
  var seq = 0, waiting = {}, initCb = null, pushCb = null;
  function post(m){ parent.postMessage(m, '*'); }

  // 🔴 音频通道由这段桥统一回收, **不靠包自觉** —— 包连"你要被关掉了"这种回调都拿不到
  // (butlerUI 只有 onInit/onPush/call/setState/resize 五个), 所以它想还也没地方写。
  // 实撞过一次: 15 个听力包各开一个 AudioContext, 播完不放, 面板还在板上就一直霸占,
  // 攥住 12 个音频输出设备整整一天, 那个渲染进程白烧 132 分钟 CPU。
  // 这段必须排在包的 js 之前 —— buildDoc 的拼装顺序保证了这一点, 别调。
  var audios = [];
  var RealAC = window.AudioContext || window.webkitAudioContext;
  function track(ctx){
    audios.push(ctx);
    var live = 0;
    var realCBS = ctx.createBufferSource.bind(ctx);
    ctx.createBufferSource = function(){
      var s = realCBS();
      var realStart = s.start.bind(s);
      s.start = function(){
        live++;
        // 🔴 挂起后自己唤回来, 不依赖包写 resume。包里有没有那句
        // if(ctx.state==='suspended') ctx.resume() 都照样出声 —— 否则这层挂起就变成了
        // "包不写 resume 就再也放不出声", 那是把回收资源的代价转嫁给了包作者。
        if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
        return realStart.apply(null, arguments);
      };
      // 🔴 用 addEventListener 而不是 onended: 包自己要设 onended(实测 15 个包全设了),
      //    赋值式会被它整个盖掉, 这层就白做了。
      s.addEventListener('ended', function(){
        live--;
        if (live > 0) return;     // 还有别的源在放, 不能动
        live = 0;
        // 🔴 播完**立刻**还设备, 不留延迟。用设备的东西就该播完就还、下次用再申请。
        // 曾经写成"闲置 1.5 秒后再还", 理由是"逐句连放时别反复折腾" —— 那个理由不成立, 实测:
        //   suspend() 之后该进程 AudioOutputDevice 线程 1 → 0(设备是真还给系统了, 不是只停时钟)
        //   连完全重建一个 AudioContext 并播完一段 0.15s 也只要 28ms, 光 resume 更快
        // 所以推迟释放换不来任何听得出来的好处, 只是让设备白占着。
        try { ctx.suspend(); } catch (e) {}
      });
      return s;
    };
  }
  if (RealAC) {
    // 构造函数里 return 对象 → new Patched() 拿到的就是这个原生 ctx;
    // prototype 指回去, 所以包里 instanceof 照样成立。
    var Patched = function(opts){ var ctx = new RealAC(opts); try { track(ctx); } catch (e) {} return ctx; };
    Patched.prototype = RealAC.prototype;
    window.AudioContext = Patched;
    window.webkitAudioContext = Patched;
  }
  window.addEventListener('message', function(e){
    var m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.t === 'init') { if (initCb) initCb(m.data); }
    else if (m.t === 'push') { if (pushCb) pushCb(m.data); }
    else if (m.t === 'result') { var w = waiting[m.id]; if (w) { delete waiting[m.id]; w(m.result); } }
    else if (m.t === 'beat') { post({ t: 'beat' }); }
  });
  window.butlerUI = {
    onInit: function(fn){ initCb = fn; },
    onPush: function(fn){ pushCb = fn; },
    // 一条命令。回来的是宿主执行的结果, 不是包自己说了算的。
    call: function(name, args){
      return new Promise(function(res){
        var id = ++seq;
        waiting[id] = res;
        post({ t: 'call', id: id, name: String(name), args: args || {} });
      });
    },
    // 自己要记住的东西。宿主替它落盘, 下次 init 带回来。
    setState: function(obj){ post({ t: 'state', state: obj }); },
    // 高度自适应。不喊的话这就是个死高度的框。
    resize: function(h){ post({ t: 'resize', h: Number(h) || 0 }); },
  };
  function ready(){
    post({ t: 'ready' });
    // 内容变了自己长高, 省得每个包都要记着喊 resize
    try {
      new ResizeObserver(function(){
        // 🔴 量正文(body)的高度, 不是 documentElement 的。iframe 的高度是被宿主按上次内容撑出来的,
        //    documentElement.scrollHeight = max(视口高度, 内容高度), 视口一高它就永远等于旧高度 ——
        //    内容删掉以后回缩不了。body 的高度只由内容决定, 删了就会矮下去。
        post({ t: 'resize', h: document.body.scrollHeight });
      }).observe(document.body);
    } catch (_) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
  else ready();
})();`;

  /* 拼出沙箱世界的整份文档。**纯函数** —— 门禁靠它直接验 CSP 和拼装顺序,
     不用隔着真 iframe 猜。
     顺序是硬要求: CSP 在最前(晚一步就有一段内容不受它管), 桥在包的脚本之前
     (否则包一开跑就找不到 butlerUI)。 */
  function buildDoc(pkg) {
    const p = pkg || {};
    // 包写坏了自己的界面是它自己的事(在沙箱里看得见), 但不能让它拆掉 CSP ——
    // meta 在最前面, 而 CSP 只能叠加收紧不能放宽, 所以包里再写一个 meta 也没用。
    return [
      '<!doctype html><html><head><meta charset="utf-8">',
      `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
      // 🔴 主题 token 注进沙箱, 且**底色与文字色成对给**。
      // 原先这里只有 `color:#222` —— 给了文字色却没给背景: iframe 背景透明 → 露出深色气泡底
      // → 深底深字几乎看不见; 包若自己补个浅底, 又跟周围深色界面割裂。**颜色只给一半就是坑。**
      // 这套值与 renderer/style.css 的 :root 同源, 包直接 var(--text)/var(--brand) 就跟主题一致,
      // 不必自己编颜色 —— 自己编正是"白底白字"那类事故的来源。
      '<style>'
        + ':root{--bg:#1e1e28;--panel:#262633;--panel-2:#2c2c3c;--line:#34344a;--field:#15151d;'
        + '--text:#e6e6ef;--muted:#8a8aa5;--brand:#3b5bdb;--brand-hi:#4a6bff;--accent:#f0b000;'
        + '--ok:#4ade80;--warn:#f0b000;--danger:#f87171;--radius:12px;--radius-sm:8px}'
        + 'html,body{margin:0;padding:0;font:14px/1.6 system-ui,sans-serif;'
        + 'background:var(--panel-2);color:var(--text)}'
        + 'a{color:var(--brand-hi)}hr{border:0;border-top:1px solid var(--line)}'
        + 'input,select,textarea{background:var(--field);color:var(--text);border:1px solid var(--line);'
        + 'border-radius:var(--radius-sm);padding:6px 8px;font:inherit}'
        + 'button{background:var(--brand);color:#fff;border:0;border-radius:var(--radius-sm);'
        + 'padding:8px 14px;font:inherit;cursor:pointer}button:hover{background:var(--brand-hi)}'
        + '</style>',
      p.css ? `<style>${p.css}</style>` : '',
      '</head><body>',
      p.html || '',
      `<script>${BRIDGE}<\/script>`,
      p.js ? `<script>${p.js}<\/script>` : '',
      '</body></html>',
    ].join('');
  }

  /* 装进 iframe 之前的形状检查。签过名的包走到这儿内容一定是我们出的,
     所以形状错了一定是我们自己写错了 —— 越早在屏幕上喊出来越省事。 */
  function checkUiPayload(p) {
    if (!p || typeof p !== 'object') return '包是空的';
    if (typeof p.html !== 'string' || !p.html.trim()) return '没有 html';
    for (const k of ['css', 'js']) {
      if (p[k] != null && typeof p[k] !== 'string') return `${k} 不是一段文字`;
    }
    return null;
  }

  // 存进去的状态: 只收能 JSON 化的, 且有上限。
  function checkState(obj) {
    let text;
    try { text = JSON.stringify(obj); } catch (_) { return { bad: '状态存不成 JSON' }; }
    if (text == null) return { bad: '状态是空的' };
    if (text.length > MAX_STATE_BYTES) {
      return { bad: `状态太大(${text.length} > ${MAX_STATE_BYTES})` };
    }
    return { text };
  }

  /* 从沙箱来的一条消息该怎么处理 —— **纯判断**, 不碰 DOM, 门禁直接喂假消息试。
     返回 { act, ... }: 'call' | 'state' | 'resize' | 'ready' | 'beat' | null(不认识就丢) */
  function route(msg) {
    if (!msg || typeof msg !== 'object') return null;
    switch (msg.t) {
      case 'ready': return { act: 'ready' };
      case 'beat': return { act: 'beat' };
      case 'resize': {
        const h = Number(msg.h);
        if (!isFinite(h) || h <= 0) return null;
        // 一个包把自己撑到十万像素高就等于霸占整个窗口。留个上限。
        return { act: 'resize', h: Math.min(4000, Math.max(40, Math.round(h))) };
      }
      case 'call': {
        const id = Number(msg.id);
        const name = String(msg.name || '');
        if (!isFinite(id) || !name) return null;
        // args 收扁平键值, 外加能安全誊写一份的结构值(≤ MAX_STRUCT_ARG): web 原语的 query / body
        // 天生是对象, 丢掉的后果是「按了没反应」—— 参数过桥时静默消失。跟行业版同一套。
        const args = {};
        const raw = msg.args && typeof msg.args === 'object' ? msg.args : {};
        for (const k of Object.keys(raw)) {
          const v = raw[k];
          if (v == null) continue;
          // db 原语的 params 是 prepared statement 的一等参数, 必须是标量数组。
          // 元素只收标量(数字/字符串/布尔/null), 再往深里嵌套仍 String 化 —— 不引入深拷贝/循环引用面。
          if (k === 'params' && Array.isArray(v)) {
            args[k] = v.map((x) => (x == null ? null : (typeof x === 'object' ? String(x) : x)));
            continue;
          }
          // 誊写走 JSON —— 循环引用在这里抛错被跳过(不传引用); 太大的也不收
          if (typeof v === 'object') {
            let copy;
            try { copy = JSON.stringify(v); } catch (_) { continue; }
            if (copy.length > MAX_STRUCT_ARG) continue;
            args[k] = JSON.parse(copy);
            continue;
          }
          args[k] = String(v);
        }
        return { act: 'call', id, name, args };
      }
      case 'state': return { act: 'state', state: msg.state };
      default: return null;
    }
  }

  /* deps = {
       document, runCommand(name, args, from) -> Promise<result>,   // from = { pkgId, title, node }
       readState(pkgId) -> obj, writeState(pkgId, obj),
       locale() -> 'zh-CN', strings() -> {}, commandNames() -> ['wf_go', …],
       onError?(msg)
     } */
  function create(deps) {
    const doc = () => deps.document || document;
    const S = () => (typeof deps.strings === 'function' && deps.strings()) || {};

    function fail(node, msg) {
      const box = doc().createElement('span');
      box.className = 'cmd-error';
      box.textContent = `⚠️ ${msg}`;
      node.replaceWith(box);
      if (typeof deps.onError === 'function') deps.onError(msg);
      return null;
    }

    /* node 那个位置换成一个跑着这个包的沙箱。返回把手(destroy 用)。 */
    function mount(node, pkg, openArgs) {
      const bad = checkUiPayload(pkg);
      if (bad) return fail(node, `${(pkg && pkg.id) || 'ui'}: ${bad}`);

      const d = doc();
      const wrap = d.createElement('span');
      wrap.className = 'ui-sandbox';
      wrap.dataset.pkg = pkg.id;   // record-host.js 认「这个包的面板还在不在屏幕上」, 不在就关麦

      const frame = d.createElement('iframe');
      // 🔴 allow-scripts 只此一项。**allow-same-origin 绝不能加** —— 加上以后
      //    里面的代码和宿主同源, 能直接摸到 parent 的 DOM 和 localStorage, 这层就白做了。
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.className = 'ui-frame';
      frame.style.width = '100%';
      frame.style.border = '0';
      frame.style.height = '60px';
      frame.srcdoc = buildDoc(pkg);
      wrap.appendChild(frame);
      node.replaceWith(wrap);

      let alive = true, ready = false, missed = 0;
      let readyTimer = null, beatTimer = null;

      const send = (m) => {
        // targetOrigin 只能是 '*': 没有 same-origin 的 iframe 其 origin 是不透明的 "null",
        // 写死任何具体值都发不进去。收的那侧靠比对 window 本身把关, 不靠这个。
        try { if (frame.contentWindow) frame.contentWindow.postMessage(m, '*'); } catch (_) {}
      };

      function destroy(reason) {
        if (!alive) return;
        alive = false;
        clearTimeout(readyTimer);
        clearInterval(beatTimer);
        try { window.removeEventListener('message', onMessage); } catch (_) {}
        try { frame.remove(); } catch (_) {}
        if (reason) {
          const note = d.createElement('span');
          note.className = 'cmd-error';
          note.textContent = `⚠️ ${reason}`;
          wrap.appendChild(note);
        }
      }

      function onMessage(e) {
        // 🔴 认 source 不认 origin。这个 iframe 的 origin 是 "null", 而**任何**
        //    不透明来源都是 "null" —— 拿它当身份等于谁都能冒充。
        if (!alive || !frame.contentWindow || e.source !== frame.contentWindow) return;
        const r = route(e.data);
        if (!r) return;

        if (r.act === 'ready') {
          ready = true;
          clearTimeout(readyTimer);
          // init 是白名单: 语言 / 它自己存过的东西 / 它能调哪些命令。到此为止。
          send({
            t: 'init',
            data: {
              id: pkg.id,
              version: pkg.version || '',
              locale: (typeof deps.locale === 'function' && deps.locale()) || 'zh-CN',
              state: (typeof deps.readState === 'function' && deps.readState(pkg.id)) || null,
              commands: (typeof deps.commandNames === 'function' && deps.commandNames()) || [],
              args: cleanOpenArgs(openArgs),
            },
          });
          beatTimer = setInterval(() => {
            if (missed >= BEAT_MISS_LIMIT) {
              destroy(S().ui_frozen || '这个界面卡住了, 已经把它停掉');
              return;
            }
            missed++;
            send({ t: 'beat' });
          }, BEAT_INTERVAL_MS);
          return;
        }
        if (r.act === 'beat') { missed = 0; return; }
        if (r.act === 'resize') { frame.style.height = `${r.h}px`; return; }
        if (r.act === 'state') {
          const c = checkState(r.state);
          // 存不下就告诉它, 别假装存了 —— 下次 init 拿不到东西时它才知道原因。
          if (c.bad) { send({ t: 'push', data: { error: c.bad } }); return; }
          if (typeof deps.writeState === 'function') deps.writeState(pkg.id, r.state);
          return;
        }
        if (r.act === 'call') {
          Promise.resolve()
            .then(() => deps.runCommand(r.name, r.args, { pkgId: pkg.id, title: pkg.title, node: wrap }))
            .then((result) => send({ t: 'result', id: r.id, result: result || { ok: false } }))
            .catch((err) => send({
              t: 'result', id: r.id,
              result: { ok: false, code: 'command_failed', message: (err && err.message) || String(err) },
            }));
          return;
        }
      }

      window.addEventListener('message', onMessage);
      readyTimer = setTimeout(() => {
        if (!ready) destroy(S().ui_no_start || '这个界面没能起来');
      }, READY_TIMEOUT_MS);

      return { destroy, frame, wrap, isReady: () => ready };
    }

    return { mount };
  }

  const api = { create, buildDoc, route, checkUiPayload, checkState,
                CSP, BRIDGE, MAX_STATE_BYTES, MAX_STRUCT_ARG, READY_TIMEOUT_MS, BEAT_INTERVAL_MS, BEAT_MISS_LIMIT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.UiSandbox = api;
})();
