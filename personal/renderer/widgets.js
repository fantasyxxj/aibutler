// widgets.js — 行内ウィジェット(入力・選択・ボタン・コマンド)を本物の控件に建てる層。
//
// md.js が {{in:…}} {{sel:…}} {{btn:…}} {{cmd:…}} を空の <span class="md-widget"> にして残す。
// ここで【createElement で】建てる —— innerHTML では建てない(onclick が書けてしまえば IPC に手が届く)。
//
// 行き先は二つだけ、しかもどちらも構文に「宛先」という項目が無い:
//   btn → 同じ吹き出しの入力値を集めて【AI へ】(ただの発言として)
//   cmd → 目録が決めたプラットフォームへ(AI にも呼び出し側にも選ばせない)
// つまり「どこへでも送信できる画面」は文法上そもそも書けない —— 検証で防いでいるのではなく、
// 書けないから防げている。
//
// 目録に無い名前・引数不足・選択肢ゼロは赤字でそのまま表に出す。黙って消すと、AI も店長も
// 「押したのに何も起きない」理由が永久に分からない(JSON 列がスペル違いのキーを 200 で
// 受けていた事故と同じ形)。
(function () {
  'use strict';

  // type=file は入れない: 端末のファイルを掴む入口になる。写真は「貼る→cmd で送る」道が既にあり、
  // そちらは AI がバイト列に触れない。ここに file を足すとその設計を裏口から壊す。
  const IN_TYPES = new Set(['text', 'number', 'tel', 'date', 'time', 'email', 'password', 'range', 'area']);   // area = 多行文本框

  // 選択肢のカンマ区切り。括弧の中のカンマは区切りにしない —— 座標「A (3,2)」や範囲「(1,5]」を
  // そのまま書けるようにするため。エスケープ方式にしなかったのは、書く側が毎回この落とし穴を
  // 思い出す必要があるから(実際に忘れて壊れた)。
  // 括弧が閉じていない時だけ素の split に落ちる: 深さが戻らないと以降の選択肢を丸ごと飲み込む。
  function splitOpts(s) {
    const str = String(s == null ? '' : s);
    const tidy = (a) => a.map((x) => x.trim()).filter(Boolean);
    let depth = 0;
    for (const ch of str) {
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') { depth--; if (depth < 0) break; }
    }
    if (depth !== 0) return tidy(str.split(','));
    const out = [];
    let buf = '';
    depth = 0;
    for (const ch of str) {
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      if (ch === ',' && depth === 0) { out.push(buf); buf = ''; continue; }
      buf += ch;
    }
    out.push(buf);
    return tidy(out);
  }

  // "head|k=v|フラグ" — 値の中の = は割らない(URL や日本語の文をそのまま置ける)
  function parseSpec(spec) {
    const parts = String(spec == null ? '' : spec).split('|').map((s) => s.trim()).filter(Boolean);
    const head = parts.shift() || '';
    const args = {};
    const bare = [];
    let label = '';
    for (const p of parts) {
      const eq = p.indexOf('=');
      if (eq < 0) { bare.push(p); continue; }
      const k = p.slice(0, eq).trim(), v = p.slice(eq + 1).trim();
      if (k === 'label') label = v; else args[k] = v;
    }
    return { head, args, label, bare };
  }

  // 按钮外观 = 三个**枚举**维度, 不是自由 CSS。AI 写 style=danger 就得到危险色, 写别的一律落回默认 ——
  // 之所以不开自由样式: 能自由定样式就能把按钮打扮成系统提示的样子, 那是钓鱼界面的第一块砖。
  // 可选项写死在这里、样式写死在 CSS 里, AI 只能在给定的几种之间挑。
  const LOOK_KEYS = ['style', 'shape', 'size', 'icon'];
  const BTN_STYLES = new Set(['primary', 'normal', 'ghost', 'danger', 'success', 'warn']);
  const BTN_SHAPES = new Set(['pill', 'square', 'round']);
  const BTN_SIZES = new Set(['sm', 'md', 'lg']);

  // 图标只收很短的一小段(emoji / 一两个字), 且只当文本用 —— 不进 innerHTML, 写不出标签。
  function pickIcon(v) {
    const s = String(v == null ? '' : v).trim();
    return s && Array.from(s).length <= 2 ? s : '';
  }

  function applyLook(btn, args, doc) {
    const cls = [];
    if (BTN_STYLES.has(args.style)) cls.push('bs-' + args.style);
    if (BTN_SHAPES.has(args.shape)) cls.push('bh-' + args.shape);
    if (BTN_SIZES.has(args.size)) cls.push('bz-' + args.size);
    for (const c of cls) btn.classList.add(c);
    const icon = pickIcon(args.icon);
    if (icon) {
      const i = doc.createElement('span');
      i.className = 'btn-icon';
      i.textContent = icon;                 // textContent: 图标位塞标签也只会显示成字
      btn.insertBefore(i, btn.firstChild);
    }
    return cls;
  }

  const fieldNodes = (body) => body.querySelectorAll('.md-in, .md-sel, .md-chk');
  const fieldKeys = (body) => Array.from(fieldNodes(body)).map((e) => e.dataset.key || '').filter(Boolean);

  function collectFields(body) {
    const out = [];
    fieldNodes(body).forEach((e) => {
      const k = e.dataset.key || '', v = String(e.value == null ? '' : e.value).trim();
      if (k && v) out.push({ key: k, value: v });
    });
    return out;
  }

  // 出したフォームは一度きり。二度押しで同じ内容がもう一通飛ぶのを止める。
  function lockForm(body) {
    body.querySelectorAll('.md-in, .md-sel, .md-chk, .md-btn').forEach((e) => { e.disabled = true; });
  }

  function composeReply(text, fields) {
    if (!fields.length) return text;
    // 多行的值(type=area)续行缩进两格, 仍算这一条列表项
    return [text].concat(fields.map((f) => `- ${f.key}: ${f.value.replace(/\n/g, '\n  ')}`)).join('\n');
  }

  // 再描画で入力途中の値を消さない。renderMd は innerHTML ごと建て直すので、割り込み中に
  // 流式気泡を描き直すと、店長が打ちかけた文字が黙って消える。
  function snapshotFields(body) {
    const snap = {};
    fieldNodes(body).forEach((e) => { if (e.dataset.key) snap[e.dataset.key] = e.value; });
    return snap;
  }

  function restoreFields(body, snap) {
    if (!snap) return;
    fieldNodes(body).forEach((e) => {
      const v = snap[e.dataset.key];
      if (v !== undefined && v !== '') e.value = v;
      // 拉杆的读数是 input 事件画出来的, 直接赋 value 不触发 → 不补这一下, 重绘后
      // 滑块停在 70 而旁边的数字还写着 50。
      if (e.type === 'range') {
        try { e.dispatchEvent(new (e.ownerDocument.defaultView.Event)('input')); } catch (_) {}
      }
    });
  }

  // deps = { strings(), catalog(), runCommand(name, args), sendToAI(text, body), renderInto?(node, md),
  //          uiPackage?(id), mountUi?(node, pkg) }   ← 後の二つが {{ui:}} の沙箱側(無ければ赤字)
  // sendToAI の第二引数は押されたボタンのいる吹き出し。個人版は人格ごとにタブが分かれていて、
  // 裏のタブのボタンを押されても正しい相手に届かないといけない(業務版は一人格なので無視して良い)。
  function create(deps) {
    const S = () => deps.strings() || {};
    const doc = () => deps.document || document;

    function widgetError(n, msg) {
      n.className = 'cmd-error';
      n.textContent = `⚠️ ${msg}`;
    }

    /* コマンドが「次の画面」を返してきたら、その場で差し替える。
       これが会話で「次へ」と言わなくて済むようになった一点 —— 押した所で画面が変わるので、
       手順を一枚めくるのに AI を呼ばなくて良い(18 歩なら 18 回の呼び出しが 0 回になる)。

       🔴 吹き出しごと差し替えない。手順の枠だけを差し替える —— 吹き出しには
       ここへ辿り着くまでの AI の説明が入っていて、それを消すと店主は
       「何の話だったか」を失う。枠が無い初回だけ、ボタンの居た場所に枠を作る。
       枠は span(display:block) —— div を <p> の中に入れると DOM が不正になる。 */
    function swapPanel(btn, md) {
      let panel = typeof btn.closest === 'function' ? btn.closest('.wf-panel') : null;
      if (!panel) {
        panel = doc().createElement('span');
        panel.className = 'wf-panel';
        btn.replaceWith(panel);
      }
      deps.renderInto(panel, md);
    }

    /* 拉杆(type=range)。教学场景要的是"边拉边看"—— 调比例、调语速这类值, 用户心里没有确切数字,
       是拖到"听着舒服"为止。所以拉杆必须自带读数, 否则拉完不知道拉到了几。
       读数只是显示, 收集时仍走 input.value(纯数字, 不带单位)—— AI 拿到的是干净的数。 */
    function paintRange(n, args, head) {
      const num = (v, d) => (v !== undefined && v !== '' && isFinite(Number(v)) ? Number(v) : d);
      const min = num(args.min, 0);
      const max = num(args.max, 100);
      const el = doc().createElement('input');
      el.className = 'md-in';
      el.type = 'range';
      el.dataset.key = head;
      el.min = String(min);
      el.max = String(max);
      el.step = String(num(args.step, 1));
      el.value = String(num(args.value, Math.round((min + max) / 2)));
      const unit = String(args.unit || '').slice(0, 4);
      const out = doc().createElement('output');
      out.className = 'md-range-val';
      const paint = () => { out.textContent = el.value + unit; };
      paint();
      el.addEventListener('input', paint);
      const wrap = doc().createElement('span');
      wrap.className = 'md-range';
      wrap.appendChild(el);
      wrap.appendChild(out);
      n.replaceWith(wrap);
    }

    function paintInput(n) {
      const { head, args } = parseSpec(n.dataset.spec);
      if (!head) return widgetError(n, `in: ${S().widget_no_key || 'no field name'}`);
      if (args.type === 'range') return paintRange(n, args, head);
      if (args.type === 'area') {   // 多行: 占满一行宽, rows 定高度(2-12, 默认 3)
        const ta = doc().createElement('textarea');
        ta.className = 'md-in md-area';
        ta.dataset.key = head;
        ta.rows = Math.min(12, Math.max(2, Number(args.rows) || 3));
        if (args.placeholder) ta.placeholder = args.placeholder;
        if (args.value) ta.value = args.value;
        return n.replaceWith(ta);
      }
      const el = doc().createElement('input');
      el.className = 'md-in';
      el.type = IN_TYPES.has(args.type) ? args.type : 'text';
      el.dataset.key = head;
      if (args.placeholder) el.placeholder = args.placeholder;
      if (args.value) el.value = args.value;
      if (args.size) el.style.width = `${Math.min(40, Math.max(3, Number(args.size) || 0))}ch`;
      n.replaceWith(el);
    }

    function paintSelect(n) {
      const { head, args, bare } = parseSpec(n.dataset.spec);
      if (!head) return widgetError(n, `sel: ${S().widget_no_key || 'no field name'}`);
      const opts = args.options ? splitOpts(args.options) : bare.flatMap(splitOpts);   // 竖线分隔的选项也收: {{pick:k|甲|乙|丙}} 原先只剩「甲」(10-14 dev)
      // 選択肢ゼロの select は「開いても何も無い」箱になる。黙って出すより赤字の方がまだ直せる。
      if (!opts.length) return widgetError(n, `sel ${head}: ${S().widget_no_options || 'no options'}`);
      const el = doc().createElement('select');
      el.className = 'md-sel';
      el.dataset.key = head;
      for (const o of opts) {
        const opt = doc().createElement('option');
        opt.value = o; opt.textContent = o;
        if (args.value && args.value === o) opt.selected = true;
        el.appendChild(opt);
      }
      n.replaceWith(el);
    }

    /* {{pick:key|甲,乙,丙}} 単一選択 · {{picks:key|甲,乙,丙}} 複数選択。
       選択肢が全部見えている点が select との違い —— 3〜5 個なら開かせるより並べた方が速い。
       値は `.value` 一本で出入りする(複数選択はカンマ区切り)ので、collectFields も
       snapshotFields も lockForm も既存のまま動く。 */
    function paintChoice(n, multi) {
      const tag = multi ? 'picks' : 'pick';
      const { head, args, bare } = parseSpec(n.dataset.spec);
      if (!head) return widgetError(n, `${tag}: ${S().widget_no_key || 'no field name'}`);
      const opts = args.options ? splitOpts(args.options) : bare.flatMap(splitOpts);   // 竖线分隔的选项也收: {{pick:k|甲|乙|丙}} 原先只剩「甲」(10-14 dev)
      if (!opts.length) return widgetError(n, `${tag} ${head}: ${S().widget_no_options || 'no options'}`);
      const d = doc();
      const wrap = d.createElement('span');
      wrap.className = 'md-chk' + (multi ? ' is-multi' : '');
      wrap.dataset.key = head;
      // ラジオはグループ名が要る。同じ吹き出しに二組あると、名前が被った瞬間
      // 片方を選ぶともう片方の選択が外れる。
      const group = `${head}-${Math.random().toString(36).slice(2, 9)}`;
      const preset = new Set(splitOpts(args.value));
      for (const o of opts) {
        const lab = d.createElement('label');
        lab.className = 'md-chk-item';
        const box = d.createElement('input');
        box.type = multi ? 'checkbox' : 'radio';
        box.name = group;
        box.value = o;
        if (preset.has(o)) box.checked = true;
        const txt = d.createElement('span');
        txt.textContent = o;
        lab.appendChild(box);
        lab.appendChild(txt);
        wrap.appendChild(lab);
      }
      const boxes = () => wrap.querySelectorAll('input');
      Object.defineProperty(wrap, 'value', {
        get() {
          return Array.from(boxes()).filter((b) => b.checked).map((b) => b.value).join(', ');
        },
        set(v) {
          const want = new Set(splitOpts(v));
          boxes().forEach((b) => { b.checked = want.has(b.value); });
        },
      });
      Object.defineProperty(wrap, 'disabled', {
        get() { return wrap.classList.contains('is-locked'); },
        set(v) {
          boxes().forEach((b) => { b.disabled = !!v; });
          wrap.classList.toggle('is-locked', !!v);
        },
      });
      n.replaceWith(wrap);
    }

    /* ボタン = この吹き出しのフォームを AI に送る。
       🔴 送る中身は「画面に見えている文字 + 入力された値」だけ。ボタンの裏に隠し文を持たせない
       —— 押した人が何を送ったか分からない画面は作らない。 */
    function paintButton(n, body) {
      const { head, args, label } = parseSpec(n.dataset.spec);
      if (!head) return widgetError(n, `btn: ${S().widget_no_label || 'button has no text'}`);
      const btn = doc().createElement('button');
      btn.className = 'cmd-btn md-btn';
      btn.textContent = label || head;
      applyLook(btn, args, doc());
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        const fields = collectFields(body);
        lockForm(body);
        btn.classList.add('done');
        deps.sendToAI(composeReply(head, fields), body);
      });
      n.replaceWith(btn);
    }

    function paintCommand(n, body) {
      const { head: name, args, label } = parseSpec(n.dataset.spec);
      const decl = (deps.catalog() || {})[name];
      if (!decl) return widgetError(n, `${S().cmd_unknown || 'unknown command'}: ${name}`);
      // 同じ吹き出しに同名の入力欄があるなら、その引数は押した時点で埋まる。ここで欠落扱いにしない。
      const formKeys = new Set(fieldKeys(body));
      const missing = Object.entries(decl.params || {})
        .filter(([k, p]) => p.required && !args[k] && !formKeys.has(k)).map(([k]) => k);
      if (missing.length) {
        return widgetError(n, `${name}: ${S().cmd_missing_param || 'missing'} ${missing.join(', ')}`);
      }
      const btn = doc().createElement('button');
      btn.className = 'cmd-btn';
      btn.textContent = label || decl.label_default || name;
      applyLook(btn, args, doc());
      btn.addEventListener('click', async () => {
        if (btn.disabled) return;
        btn.disabled = true;
        // 目録が要ると言っている引数だけをフォームから補う。明示された値が優先 ——
        // AI が書いたものを画面が黙って上書きしない。関係ない入力値は混ぜない。
        // 外观键只管长相, 不能混进发往平台的参数里。
        const filled = Object.assign({}, args);
        for (const k of LOOK_KEYS) delete filled[k];
        const fields = collectFields(body);
        for (const k of Object.keys(decl.params || {})) {
          if (filled[k] === undefined || filled[k] === '') {
            const f = fields.find((x) => x.key === k);
            if (f) filled[k] = f.value;
          }
        }
        const r = await deps.runCommand(name, filled);
        // 次の画面が返ってきた時だけ差し替える。失敗した時は差し替えず、押したボタンの所に
        // 理由を出す —— 画面が変わらないことが「進んでいない」ことの一番分かりやすい合図。
        if (r && r.ok && r.render && typeof deps.renderInto === 'function') {
          swapPanel(btn, r.render);
          return;
        }
        btn.textContent = (r && r.ok ? '✓ ' : '⚠️ ') + (r && r.message ? r.message : '');
        btn.classList.add(r && r.ok ? 'done' : 'failed');
      });
      n.replaceWith(btn);
    }

    /* {{ui:包id}} — 把一个装好的界面包摆在这儿, 跑进沙箱(renderer/sandbox.js)。
       🔴 去处照旧没有变多: 沙箱里的代码能做的唯一一件有副作用的事, 是隔着窄缝请求
       目录里的一条命令 —— 跟这个吹き出し里的 {{cmd:}} 走的是同一个 runCommand。
       它画得再复杂, 也还是只能敲那几扇窗。
       宿主没接沙箱(旧版本 / 另一个版本还没接线) → 红字说清楚, 不留一块空白。 */
    function paintUi(n) {
      // `{{ui:包id|k=v}}` 的 k=v 是打开时的初始值(人格 plugin_open 传的 args, 如要读的那段文字) —— 进沙箱的 init。
      const { head: id, args } = parseSpec(n.dataset.spec);
      if (!id) return widgetError(n, `ui: ${S().widget_no_key || 'no package id'}`);
      if (typeof deps.mountUi !== 'function') {
        return widgetError(n, `${S().ui_unsupported || 'this build has no sandbox'}: ${id}`);
      }
      const pkg = typeof deps.uiPackage === 'function' ? deps.uiPackage(id) : null;
      if (!pkg) return widgetError(n, `${S().ui_unknown || 'unknown interface package'}: ${id}`);
      deps.mountUi(n, pkg, args);
    }

    /* SVG 里带 data-btn / data-cmd 的元素接上点击。
       🔴 去处没有变多: data-btn 走的就是 btn 那条(→AI), data-cmd 走的就是 cmd 那条(→目录定的平台)。
       图能点了, 但"点了以后能去哪儿"仍然是原来那两处 —— 语法里依旧没有"宛先"这一项。
       消毒在 md.js 那侧: 到这里时元素上只可能剩白名单属性, on* 早就没了。 */
    function bindSvg(body) {
      body.querySelectorAll('svg [data-btn]').forEach((el) => {
        const text = String(el.getAttribute('data-btn') || '').trim();
        if (!text) return;
        el.classList.add('svg-hit');
        el.addEventListener('click', () => {
          if (el.classList.contains('done')) return;
          const fields = collectFields(body);
          lockForm(body);
          el.classList.add('done');
          deps.sendToAI(composeReply(text, fields), body);
        });
      });
      body.querySelectorAll('svg [data-cmd]').forEach((el) => {
        const { head: name, args } = parseSpec(el.getAttribute('data-cmd'));
        const decl = (deps.catalog() || {})[name];
        // 图里没法在原地显红字, 但也不能装作可点 —— 不认识的命令就不给它挂事件, 保持成一张死图。
        if (!decl) { el.classList.add('svg-dead'); return; }
        el.classList.add('svg-hit');
        el.addEventListener('click', async () => {
          if (el.classList.contains('done')) return;
          el.classList.add('done');
          const filled = Object.assign({}, args);
          for (const k of LOOK_KEYS) delete filled[k];
          const r = await deps.runCommand(name, filled);
          el.classList.add(r && r.ok ? 'ok' : 'failed');
        });
      });
    }

    // 2 周する。入力・選択が先に建っていないと、ボタン側が同じ吹き出しのフォームを見られない。
    function paint(body) {
      body.querySelectorAll('.md-widget').forEach((n) => {
        const kind = n.dataset.kind;
        if (kind === 'in') paintInput(n);
        else if (kind === 'sel') paintSelect(n);
        else if (kind === 'pick') paintChoice(n, false);
        else if (kind === 'picks') paintChoice(n, true);
      });
      body.querySelectorAll('.md-widget').forEach((n) => {
        const kind = n.dataset.kind;
        if (kind === 'btn') paintButton(n, body);
        else if (kind === 'cmd') paintCommand(n, body);
        else if (kind === 'ui') paintUi(n);
      });
      bindSvg(body);
    }

    return { paint };
  }

  const api = { create, parseSpec, collectFields, composeReply, snapshotFields, restoreFields, lockForm,
                IN_TYPES, BTN_STYLES, BTN_SHAPES, BTN_SIZES, LOOK_KEYS, pickIcon };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.MdWidgets = api;
})();
