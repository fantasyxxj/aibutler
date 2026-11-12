// board.js — 常驻板。对话会往下滚, 但钉在这里的东西不会。
//
// 为什么要有这一层(行业版同款, 作者 2026-08-14): 一个界面包(插件)如果只是画在气泡里,
// 它随对话滚上去以后就够不着了 —— 想点的时候得先滚回老远。钉到屏幕上方一块
// 不随对话滚动的区域, 它才是一个"出しっぱなし"的常驻工具, 而不是一条被冲走的消息。
//
// 三个写法, 和行业版同一套心智:
//   {{pin:槽名|ui=包id}}   → 把一个装好的界面包钉到常驻板(沙箱就长在那上面)
//   {{pin:槽名|title=…}}   → 把这条回复的正文整段钉上去(没有现成界面包时的临时内容)
//   {{pin:槽名}}           → 撤下这块。用户点 ✕ 走的也是同一条路 —— 挂上和摘下不搞两套机制
//
// 🔴 与气泡里的控件不同, 板上的控件【不锁】。表单是一次性的, 常驻板是一整天都在按的 ——
//    widgets.js 的 lockForm 不会落到这里, 所以按钮可以连点。
(function () {
  'use strict';

  const CARD = 'board-card';

  // "槽位|ui=x|title=y" → { slot, opts }。值里的 = 只按第一个切(和 widgets.parseSpec 同一个约定)
  function parsePin(spec) {
    const parts = String(spec || '').split('|').map((s) => s.trim()).filter(Boolean);
    const slot = parts.shift() || '';
    const opts = {};
    for (const p of parts) {
      const eq = p.indexOf('=');
      if (eq < 0) { opts[p] = true; continue; }
      opts[p.slice(0, eq).trim()] = p.slice(eq + 1).trim();
    }
    return { slot, opts };
  }

  // 挑语言只有 core/i18n-pick.js 那一份实现: renderer 里由 <script> 挂上 window, 测试在 Node 里 require。
  const pickLang = (dict, loc) => ((typeof window !== 'undefined' && window.I18nPick)
    ? window.I18nPick.pickLang(dict, loc)
    : require('../../core/i18n-pick.js').pickLang(dict, loc));

  // 槽位 id 是 AI 写的, 塞进 querySelector 之前先杀掉引号/反斜杠, 不素直地信它。
  function CSS_escape(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  // deps = { document, strings(), host(), locale(), uiPackage(id), mountUi(node, pkg), persistRemoved([slot]) }
  function create(deps) {
    const doc = () => deps.document || document;
    const S = () => deps.strings() || {};
    const host = () => deps.host();

    // 用户主动撤下的槽位。钉上({{pin:槽名|ui/title}})会从这里拿掉, 撤下(✕ / {{pin:槽名}})会加进来。
    // 🔴 必须持久化: 历史里的 {{pin:...}} 印不会消失, 下次开窗 loadHistory 重放时 harvest 会照着它
    //    再把撤掉的东西钉回来 —— 没有这份黑名单, 用户点多少回 ✕ 都等于没点。
    let removed = new Set();
    // 重放历史时的闸: 重放时只按快照跳过已撤的槽位, 不再往黑名单里写/删 —— 否则重放自己的
    //   撤下动作会污染快照, 把后面本该钉回的槽位也一并跳掉(见 loadHistory 里 setReplaying 的用法)。
    let replaying = false;

    function persistRemoved() {
      if (typeof deps.persistRemoved === 'function') deps.persistRemoved(Array.from(removed));
    }
    function markRemoved(slot) {
      if (!slot || replaying) return;
      removed.add(slot);
      persistRemoved();
    }
    function unmarkRemoved(slot) {
      if (!slot || replaying || !removed.has(slot)) return;
      removed.delete(slot);
      persistRemoved();
    }

    const cardOf = (slot) => host().querySelector(`.${CARD}[data-slot="${CSS_escape(slot)}"]`);

    function syncEmpty() {
      const h = host();
      if (h) h.classList.toggle('on', h.querySelectorAll(`.${CARD}`).length > 0);
    }

    function remove(slot) {
      const c = cardOf(slot);
      if (c) c.remove();
      syncEmpty();
      markRemoved(slot);
    }

    function shell(slot, title) {
      let card = cardOf(slot);
      if (!card) {
        card = doc().createElement('section');
        card.className = CARD;
        card.dataset.slot = slot;
        host().appendChild(card);
      }
      card.innerHTML = '';   // 同一个槽位再贴一次 = 整体替换, 不往下叠
      const head = doc().createElement('div');
      head.className = 'board-head';
      const h = doc().createElement('span');
      h.className = 'board-title';
      h.textContent = title || slot;
      head.appendChild(h);
      const tools = doc().createElement('span');
      tools.className = 'board-tools';
      head.appendChild(tools);
      // ✕ 是用户自己撤的口。AI 的 {{pin:槽名}} 和它走同一个 remove。
      const x = doc().createElement('button');
      x.className = 'board-x';
      x.type = 'button';
      x.textContent = '✕';
      x.title = S().board_close || '';
      x.addEventListener('click', () => remove(slot));
      tools.appendChild(x);
      card.appendChild(head);
      const bodyEl = doc().createElement('div');
      bodyEl.className = 'board-body';
      card.appendChild(bodyEl);
      syncEmpty();
      return { card, bodyEl, tools };
    }

    function note(el, msg, isErr) {
      const p = doc().createElement('div');
      p.className = `board-note ${isErr ? 'err' : ''}`;
      p.textContent = msg;
      el.appendChild(p);
    }

    /* 把一个界面包钉上去。包还是跑在沙箱里(renderer/sandbox.js), 只是宿主从气泡换成了板上的一个框 ——
       能做的事没有变多, 仍是那几扇窗。 */
    function paintUi(slot, pkgId, title, openArgs) {
      unmarkRemoved(slot);
      const pkg = typeof deps.uiPackage === 'function' ? deps.uiPackage(pkgId) : null;
      // 标题: 显式 title= > 包自带的 title > 槽名。槽名是 AI 取的人话, 比机器 id 更该给人看。
      // 包自带的 title 可能是多语对象 —— 直接贴会得到 [object Object]。挑法走 core/i18n-pick.js。
      const loc = typeof deps.locale === 'function' ? deps.locale() : '';
      const own = pickLang(pkg && pkg.title, loc);
      const label = title || own || slot;
      const { bodyEl } = shell(slot, label);
      if (!pkg) {
        note(bodyEl, `${S().ui_unknown || 'unknown interface package'}: ${pkgId}`, true);
        return;
      }
      if (typeof deps.mountUi !== 'function') {
        note(bodyEl, `${S().ui_unsupported || 'this build has no sandbox'}: ${pkgId}`, true);
        return;
      }
      const holder = doc().createElement('div');
      holder.className = 'board-ui';
      bodyEl.appendChild(holder);
      deps.mountUi(holder, pkg, openArgs);
    }

    /* 没有现成界面包的临时内容 —— 整段正文原样搬上去, 不另学一种写法。 */
    function paintFree(slot, title, sourceBody) {
      unmarkRemoved(slot);
      const { bodyEl } = shell(slot, title);
      if (sourceBody) bodyEl.appendChild(sourceBody.cloneNode(true));
    }

    function pin(spec, sourceBody) {
      const { slot, opts } = parsePin(spec);
      if (!slot) return null;
      // ui / title 之外的键是打开时的初始值(plugin_open 的参数, 同 {{ui:id|k=v}}), 照样交给沙箱
      if (opts.ui) {
        const { ui, title, ...openArgs } = opts;
        paintUi(slot, ui, title, openArgs);
      }
      else if (opts.title) paintFree(slot, opts.title, sourceBody);
      else remove(slot);
      return { slot, opts };
    }

    /* 气泡描完之后调。pin 的印从原地抹掉、中身搬到板上 —— 印留着会在会話里和板上各出一份。
       🔴 重放历史(replaying)时印只摘不钉 —— 作者 2026-08-27 定: "关掉窗口或 butler 重新打开,
          不准自己出现在窗口, 要用户重新钉才出来"。往上翻旧对话同理, 半年前钉过的东西不该蹦出来。
          印仍然要 remove: 留着会在正文里显示成一个没人看得懂的标记。 */
    function harvest(body) {
      const marks = Array.from(body.querySelectorAll('.md-widget[data-kind="pin"]'));
      if (!marks.length) return [];
      const specs = [];
      for (const n of marks) {
        const spec = n.dataset.spec || '';
        n.remove();
        if (replaying) continue;
        specs.push(spec);
      }
      // 先全部摘掉再搬 —— 先搬的话印会跟着一起贴上去。
      return specs.map((s) => pin(s, body)).filter(Boolean);
    }

    return { harvest, pin, paintUi, paintFree, remove, parsePin,
             setRemoved, getRemoved, setReplaying };

    function setRemoved(list) { removed = new Set(Array.isArray(list) ? list : []); }
    function getRemoved() { return Array.from(removed); }
    function setReplaying(v) { replaying = !!v; }
  }

  const api = { create, parsePin };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.Board = api;
})();
