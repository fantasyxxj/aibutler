// md.js — 极简、无依赖、XSS 安全的 Markdown → HTML 渲染器。
// 安全策略: 先把整段文本 HTML 转义(&<>), 之后只注入我们自己生成的白名单标签
// (p/strong/em/code/pre/ul/ol/li/h1-6/a/blockquote/table/hr/del/br)。
// 因源文本里的 < > 已变实体, 模型输出的 <script> 之类永远不会成为真标签 → 无 XSS。
// 暴露: window.renderMarkdown(text) -> html 字符串。
(function () {
  const SOH = String.fromCharCode(1), STX = String.fromCharCode(2);   // 不可打印占位包围符, 避开用户正文里的 M1/C3 等
  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  // 只允许 http/https/mailto/file/data:image/相对路径, 其余(javascript: data:text 等)→ '#'
  function safeUrl(url) {
    const u = String(url).trim();
    if (/^(https?:|mailto:|file:)/i.test(u)) return u;
    if (/^data:image\//i.test(u)) return u;
    if (/^(\/|\.\.?\/|#)/.test(u)) return u;
    return '#';
  }

  // 行内: 传入的 s 已 HTML 转义。顺序: 保护行内代码 → 图片/链接/路径/URL 占位(L) → 粗 → 斜 → 删除线 → 还原 L → 还原代码
  function inline(s) {
    const codes = [];
    const links = [];   // 图片/markdown链接/文件路径/裸URL 的最终 HTML: 先占位保护, 避开粗/斜/删除线对标签里 _ * ~ 的误伤
    // 占位必须用 SOH/STX 包围: 裸"空格+数字+空格"会和正文"第 8 课"撞车 → 还原成 codes[8]=undefined
    s = s.replace(/`([^`]+)`/g, (_m, c) => { codes.push(c); return SOH + 'I' + (codes.length - 1) + STX; });
    // 日语注音 ruby: 白名单式还原被转义的 <ruby>/<rt>/<rp>(仅认无属性的裸标签, 其余 HTML 仍是转义明文, 无 XSS)
    s = s.replace(/&lt;ruby&gt;([\s\S]*?)&lt;\/ruby&gt;/g, (_m, inner) =>
      '<ruby>' + inner
        .replace(/&lt;rt&gt;([\s\S]*?)&lt;\/rt&gt;/g, '<rt>$1</rt>')
        .replace(/&lt;rp&gt;([\s\S]*?)&lt;\/rp&gt;/g, '<rp>$1</rp>') + '</ruby>');
    // 图片(必须在链接前, ![alt](url) 是链接的超集; alt 只作 attr 用, 需转义 " )
    // url 允许空格 (Mac 截图文件名 "Screenshot 2026... at ..." 带空格, 卡到 ) 为止)
    s = s.replace(/!\[([^\]]*)\]\(([^)\n]+)\)/g,
      (_m, alt, u) => {
        links.push(`<img src="${safeUrl(u)}" alt="${String(alt).replace(/"/g,'&quot;')}" loading="lazy" class="md-img">`);
        return SOH + 'L' + (links.length - 1) + STX;
      });
    s = s.replace(/\[([^\]]+)\]\(([^)\n]+)\)/g,
      (_m, t, u) => {
        links.push(`<a href="${safeUrl(u)}" target="_blank" rel="noopener noreferrer">${t}</a>`);
        return SOH + 'L' + (links.length - 1) + STX;
      });
    // 文件路径→可点链接: 家目录(~/…)或锚定已知根目录的绝对路径(避免把 /regex/ 之类误当路径)。
    // Windows: 盘符(C:\ 或 C:/)与 UNC(\\server\share) —— 形状本身够独特, 无需根目录白名单。
    // 单字母盘符要求前缀是 起始/空白/标点, 故 https:// 里的 "s:/" 不会误命中(其前是 p)。
    // 前缀限 起始/空白/中英标点 → 天然避开标签属性(href=" 前是引号不匹配)
    // 🔴 先占位(SOH..L..STX)别直接吐 <a>: 中文路径/文件名里的下划线(如 工作报告_L2_周报)会被后面的
    //    斜体 _.._ 正则误当 markdown 斜体吃掉, 把路径打成 报告<em>L2</em>周报 → 链接在 <em> 处截断。
    //    占位符不含 _ * ~, 粗/斜/删除线都碰不到; 全部行内格式处理完再统一还原成 <a>。
    // 前缀含 * 且路径不吃 *: **/Users/…** 这种加粗写法里星号既非空白也非标点, 不放行就整条不匹配,
    // 等 ** → <strong> 一跑就成了点不动的黑体死链(裸 URL 那条早修过, 路径这条漏了)。
    // pre 必须留在正文里(不能进 links) —— 塞进占位符的话 ** 只剩单星, 后面的粗体正则就配不成对了。
    s = s.replace(/(^|[\s(:：,,、*])((?:~\/|\/(?:Users|home|tmp|opt|etc|var|private|Applications|data|Volumes|Library|System|usr|mnt|srv|root)\/|[A-Za-z]:[\\\/]|\\\\[^\s\\\/<>"']+\\)[^\s<>"'`),。;;:*]*)/g,
      (_m, pre, p) => {
        // 裸路径指向图片文件 → 内联显图(包在 filepath 链接里, 点击/右键行为全保留);
        // ~/ 与 Windows 路径 img src 解析不了(需 file:///C:/… 形式), 只给链接
        const html = /^\//.test(p) && /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(p)
          ? `<a href="#" class="filepath" data-path="${p}" title="点击打开 ${p}"><img src="${p}" alt="${p}" loading="lazy" class="md-img"></a>`
          : `<a href="#" class="filepath" data-path="${p}" title="点击打开 ${p}">${p}</a>`;
        links.push(html);
        return pre + SOH + 'L' + (links.length - 1) + STX;
      });
    // 裸 URL → 可点链接。排在 markdown 链接之后: 那时 [文字](url) 已是 <a href="…">,
    // 而前缀限 起始/空白/标点 —— 属性里的 url 前是引号, 锚文本前是 '>', 都不命中, 不会重复包。
    // 前缀含 * 且 URL 不吃 *: AI 爱写 **https://…**, 星号既非空白也非标点, 不放行就整条不匹配,
    // 等 ** → <strong> 一跑就成了点不动的黑体死链。pre 必须留在正文里(不能进 links) ——
    // 塞进占位符的话 `**` 只剩单星, 后面的粗体正则就配不成对了。
    s = s.replace(/(^|[\s(（:：,，、*])(https?:\/\/[^\s<>"'`)）*]+)/g, (_m, pre, raw) => {
      // 句读常紧跟在 URL 后面(…/console/。), 尾随标点要吐回正文, 否则被吃进链接就打不开
      const tail = (raw.match(/[,，。;；:：!！?？、]+$/) || [''])[0];
      const u = tail ? raw.slice(0, -tail.length) : raw;
      links.push(`<a href="${safeUrl(u)}" target="_blank" rel="noopener noreferrer">${u}</a>${tail}`);
      return pre + SOH + 'L' + (links.length - 1) + STX;
    });
    // 🔴 粗体/斜体只认星号, 不认下划线(作者 2026-08-17)。CommonMark 里 __粗__ / _斜_ 是合法写法,
    // 但我们的正文遍地是 memory_upsert · feedback_xxx_yyy · update-0.0.58.html 这类标识符和文件名,
    // 下划线一旦参与强调, "_一段_" 就会被吃成 <em> —— 标识符断成两截, 而且下划线本身不见了。
    // 代价只是不能用 _x_ 写斜体(*x* 照常有效), 换来所有 slug/文件名/变量名原样显示。
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    s = s.replace(/\x01L(\d+)\x02/g, (_m, i) => links[+i] != null ? links[+i] : _m);
    s = s.replace(/\x01I(\d+)\x02/g, (_m, i) => { const c = codes[+i];
        return /^(?:~\/|\/(?:Users|home|tmp|opt|etc|var|private|Applications|data|Volumes|Library|System|usr|mnt|srv|root)\/|[A-Za-z]:[\\\/]|\\\\[^\s\\\/<>"']+\\)[^\s`]*$/.test(c)   // 行内代码整体是一条路径 → 包成可点链接(仍保留 code 样式)
          ? `<a href="#" class="filepath" data-path="${c}" title="点击打开 ${c}"><code>${c}</code></a>`
          : `<code>${c}</code>`; });
    return s;
  }

  const splitRow = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

  // —— SVG 消毒白名单 ——
  // 老做法是塞进 data: URL 的 <img>: 绝对安全(图片上下文里 script/foreignObject 不执行), 但**点不动** ——
  // img 里的 SVG 是一张死图, 拿不到点击。要让 AI 画的图能点, 只能内联进 DOM, 于是消毒变成硬要求。
  //
  // 消毒方式是**重建而不是过滤**: 白名单外的标签整个丢掉, 保留的标签也只按白名单逐个属性重新拼出来。
  // 过滤(挑坏的删)永远漏得掉一种写法; 重建(只放好的过)漏掉的顶多是一个显示效果。
  const SVG_TAGS = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
    'text', 'tspan', 'defs', 'lineargradient', 'radialgradient', 'stop', 'title', 'desc',
    'clippath', 'mask', 'pattern', 'marker', 'symbol',
    // SMIL: 动画是 SVG 自己的能力, 删掉它等于宣布"这里只能画死图"。
    // 危险的从来不是动画本身, 而是 attributeName 能指向 on* —— 那一条在下面单独卡死。
    'animate', 'animatetransform', 'animatemotion', 'mpath', 'set']);
  // 几何 + 描边填充 + 文字。style 属性一律不收 —— 它能塞 url(javascript:), 而颜色用 fill/stroke 就够了。
  // href / xlink:href 也不收: 那是外链和 javascript: 的入口, 图里根本不需要。
  const SVG_ATTRS = new Set(['d', 'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity',
    'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset',
    'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy', 'fr',
    'width', 'height', 'points', 'transform', 'viewbox', 'xmlns', 'preserveaspectratio',
    'opacity', 'font-size', 'font-family', 'font-weight', 'text-anchor', 'dominant-baseline',
    'offset', 'stop-color', 'stop-opacity', 'gradientunits', 'gradienttransform',
    'patternunits', 'markerwidth', 'markerheight', 'refx', 'refy', 'orient',
    'clip-path', 'mask', 'id', 'class', 'marker-end', 'marker-start',
    'visibility', 'display', 'cursor', 'pointer-events', 'overflow', 'stroke-miterlimit',
    // 交互只认这两个, 而且它们不带"去哪儿"这一项 —— 落点仍然只有 btn(→AI) 和 cmd(→平台) 两处,
    // 与行内控件同一套。SVG 能点, 但点了以后的去处并没有变多。
    'data-btn', 'data-cmd',
    // SMIL 动画自己的参数。begin/end 收 "playBtn.click" 这种事件引用 —— 按钮控制启停靠的就是它。
    'attributename', 'attributetype', 'from', 'to', 'by', 'dur', 'begin', 'end',
    'repeatcount', 'repeatdur', 'values', 'keytimes', 'keysplines', 'keypoints',
    'calcmode', 'additive', 'accumulate', 'restart', 'type', 'path', 'rotate']);
  // 属性值里出现这些就整条丢: 事件处理器和伪协议。
  const ATTR_VALUE_BAD = /javascript:|data:text\/html|vbscript:|<script/i;

  // animate/set 能改**任意**属性 —— <set attributeName="onclick" to="alert(1)"/> 就是一条完整的 XSS。
  // 所以动画只准指向"画出来长什么样"的属性: 白名单里去掉 id/class/data-* 这些身份与落点。
  const ANIMATABLE_BAN = new Set(['id', 'class', 'data-btn', 'data-cmd', 'attributename']);
  function animatableOk(v) {
    const k = String(v || '').toLowerCase().trim();
    if (!k || ANIMATABLE_BAN.has(k)) return false;
    return SVG_ATTRS.has(k) || k === 'transform' || k === 'opacity';
  }

  // —— <style> 的 CSS 消毒 + 作用域化 ——
  // SVG 内联进 DOM 后, 里面的 <style> 是**整个文档的全局样式**(SVG 不是 shadow DOM)。
  // 原样放行 = AI 写个 `.card{display:none}` 就能把聊天界面本身弄没。所以每条选择器都要钉死在这张图上。
  let svgScopeSeq = 0;

  function matchBrace(css, open) {   // open 指向 '{', 返回配对 '}' 的下标(找不到 = 到结尾)
    let depth = 0;
    for (let i = open; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) return i;
    }
    return css.length;
  }

  function scopeSelectors(css, scope) {
    let out = '', i = 0;
    while (i < css.length) {
      const brace = css.indexOf('{', i);
      if (brace < 0) break;                       // 剩下的没有规则体 = 残句, 丢掉
      const head = css.slice(i, brace).trim();
      const close = matchBrace(css, brace);
      const body = css.slice(brace + 1, close);
      if (head.startsWith('@')) {
        // @keyframes 的 `0%/from/to` 不是选择器, 不能加前缀; @media 之类内部才是真选择器。
        out += /^@(-[\w]+-)?keyframes\b/i.test(head) ? `${head}{${body}}` : `${head}{${scopeSelectors(body, scope)}}`;
      } else if (head) {
        const sel = head.split(',').map((x) => x.trim()).filter(Boolean)
          .map((x) => (/^svg\b/i.test(x) ? `.${scope}${x.slice(3)}` : `.${scope} ${x}`)).join(', ');
        if (sel) out += `${sel}{${body}}`;
      }
      i = close + 1;
    }
    return out;
  }

  function scopeCss(css, scope, rid) {
    let s = String(css || '');
    if (rid) s = s.replace(/#([A-Za-z_][\w-]*)/g, (m, v) => `#${rid(v)}`);   // 选择器里的 #id 跟着改名
    s = s.replace(/<[^>]*>/g, '');                                  // style 里出现标签 = 想逃出去
    s = s.replace(/\/\*[\s\S]*?\*\//g, '');                         // 注释里能藏半个 </style>
    s = s.replace(/@import[^;]*;?/gi, '');                          // 外部样式表 = 一次出网请求
    s = s.replace(/expression\s*\(/gi, '(');                        // 老 IE 的执行入口
    s = s.replace(/(javascript|vbscript)\s*:/gi, '');
    // 外链 url() 会把"这台机器打开过这张图"发给第三方; 内嵌 data:image 无所谓。
    s = s.replace(/url\s*\(([^)]*)\)/gi, (m, inner) => (/^\s*['"]?\s*data:image\//i.test(inner) ? m : 'none'));
    // @keyframes 名字也得隔离, 否则两张图用同名动画会互相顶掉。
    const names = [];
    s = s.replace(/@(-[\w]+-)?keyframes\s+([\w-]+)/gi, (m, pre, name) => {
      names.push(name);
      return `@${pre || ''}keyframes ${scope}_${name}`;
    });
    for (const n of names) {
      const esc = n.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
      s = s.replace(new RegExp(`(animation(?:-name)?\\s*:[^;}]*?)\\b${esc}\\b`, 'gi'), `$1${scope}_${n}`);
    }
    return scopeSelectors(s, scope);
  }

  function sanitizeSvg(src) {
    let s = String(src || '');
    const scope = `svgsc${++svgScopeSeq}`;
    // 🔴 id 也必须隔离。聊天界面是**一条不断变长的 DOM**, 每条历史消息里的图都还在里面 ——
    //    AI 每次都把按钮叫 playBtn, 于是第二张图开始 `begin="playBtn.click"` 指向的是**上一张图**的按钮,
    //    点自己的按钮毫无反应。CSS 作用域解决不了这个, 引用型属性(begin/end/url(#…))得跟着一起改名。
    const ids = new Set();
    s.replace(/\sid\s*=\s*["']([^"'<>]+)["']/gi, (_m, v) => { ids.add(v); return _m; });
    const rid = (v) => (ids.has(v) ? `${scope}_${v}` : v);
    // 被 begin/end 引用的元素 = 这张图里的按钮。它们得像按钮: 鼠标移上去是只小手。
    // 靠 AI 每次记得写 cursor 是不现实的, 而"看不出能点"就等于不能点。
    const clickable = new Set();
    s.replace(/\s(?:begin|end)\s*=\s*["']([^"']*)["']/gi, (_m, v) => {
      String(v).replace(/([A-Za-z_][\w-]*)\.(click|mousedown|mouseup|mouseover)/g, (mm, id) => { clickable.add(id); return mm; });
      return _m;
    });
    const fixRefs = (val) => String(val)
      .replace(/url\(\s*#([^)\s]+)\s*\)/g, (m, v) => (ids.has(v) ? `url(#${scope}_${v})` : m))
      .replace(/(^|[\s;+])([A-Za-z_][\w-]*)\.(click|mousedown|mouseup|mouseover|mouseout|begin|end|repeat)\b/g,
        (m, pre, v, ev) => (ids.has(v) ? `${pre}${scope}_${v}.${ev}` : m));
    // <style> 先摘出来单独处理 —— 直接删掉的话, AI 用 class 上色的图会全部回落成默认黑填充。
    const sheets = [];
    s = s.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_m, css) => { sheets.push(css); return ''; });
    // 剩下这几类连内容一起删干净 —— 只删开闭标签会把里面的 JS 源码留成可见文本。
    s = s.replace(/<(script|foreignobject|iframe|style|handler)\b[\s\S]*?<\/\1>/gi, '');
    s = s.replace(/<(script|foreignobject|iframe|style|handler|use|image|a)\b[^>]*\/?>/gi, '');
    const body = s.replace(/<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g, (_m, slash, tag, attrs) => {
      const name = tag.toLowerCase();
      if (!SVG_TAGS.has(name)) return '';
      if (slash) return `</${tag}>`;      // clipPath/linearGradient 这些标签名同样分大小写
      // 🔴 自闭合必须原样带出去: rect/circle 这些在 HTML 解析里不是 void 元素,
      //    丢了 "/" 它们就变成容器, 把后面**所有**兄弟节点吞成自己的子元素 —— 而非容器的子元素不渲染。
      //    症状是整张图一片空白, 且完全无声。
      const selfClose = /\/\s*$/.test(attrs);
      let out = '';
      const re = /([a-zA-Z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
      let m;
      const isAnim = name === 'animate' || name === 'set' || name === 'animatetransform' || name === 'animatemotion';
      while ((m = re.exec(attrs))) {
        const key = m[1].toLowerCase();
        const val = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : (m[4] || ''));
        if (!SVG_ATTRS.has(key)) continue;              // on* / href / style 全部在这一句里落地
        if (ATTR_VALUE_BAD.test(val)) continue;
        if (isAnim && key === 'attributename' && !animatableOk(val)) return '';   // 指向 on* 的动画整条丢
        const fixed = key === 'id' ? rid(val) : fixRefs(val);
        // 白名单用小写比对, 但**写出去用原名**: attributeName/viewBox/repeatCount 这些 SVG 属性是分大小写的。
        // HTML 解析器确实有一张修正表能救回来, 可一旦这段 SVG 走了别的路(XML/data: URL), 小写就是死的。
        out += ` ${m[1]}="${fixed.replace(/"/g, '&quot;').replace(/</g, '&lt;')}"`;
      }
      // 🔴 按钮几乎总是 <rect> + 压在上面的 <text>。点击目标是最上面那层 —— 点在"▶ 开"这几个字上,
      //    事件目标是 text, 而 begin="playBtn.click" 监听的是 rect, 于是**点按钮的正中央反而没反应**。
      //    纯装饰的文字一律让点击穿过去; 文字自己带 id / data-btn 时说明它就是要被点的, 不动它。
      //    判据是"它自己是不是点击目标", 不是"它有没有 id" —— 给文字加 id 最常见的动机是 CSS
      //    选择器和动画引用, 跟要不要被点无关。按有没有 id 判, 等于"给图配张样式表就把底下的
      //    按钮点没了", 且完全静默。点击目标只有三种: 带 data-btn/data-cmd · 被某个 begin/end
      //    的 id.click 引用(clickable) · 自己写死了 pointer-events。
      if (name === 'text' || name === 'tspan') {
        const tid = /\sid\s*=\s*["']([^"'<>]+)["']/i.exec(attrs);
        const isTarget = /\s(data-btn|data-cmd|pointer-events)\s*=/i.test(attrs)
          || (tid && clickable.has(tid[1]));
        if (!isTarget) out += ' pointer-events="none"';
      }
      const idm = /\sid\s*=\s*["']([^"'<>]+)["']/i.exec(attrs);
      if (idm && clickable.has(idm[1]) && !/\scursor\s*=/i.test(attrs)) out += ' cursor="pointer"';
      return `<${tag}${out}${selfClose ? '/' : ''}>`;
    });
    const css = sheets.length ? scopeCss(sheets.join('\n'), scope, rid) : '';
    // 作用域 class 挂到根 svg 上, 样式表插进它内部 —— 出了这张图不生效。
    return body.replace(/^(\s*<svg\b)([^>]*)>/i, (_m, head, attrs) => {
      let a = attrs;
      if (sheets.length) {
        a = /\sclass\s*=\s*"/i.test(a) ? a.replace(/(\sclass\s*=\s*")/i, `$1${scope} `) : `${a} class="${scope}"`;
      }
      // 🔴 没有 width/height 的 <svg> 在"按内容收缩"的气泡里会塌成一丁点 ——
      //    气泡问它多宽, 它说随便; 气泡于是给了它最小的那个宽度, 图小得什么都看不清。
      //    viewBox 的单位不是 AI 的显示意图, 只是坐标系, 所以按它给个能看清的实际尺寸(封顶 480)。
      const vb = /\sviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(a);
      if (vb && !/\swidth\s*=/i.test(a) && !/\sheight\s*=/i.test(a)) {
        const w = parseFloat(vb[1]), h = parseFloat(vb[2]);
        if (w > 0 && h > 0) {
          const k = Math.min(2, 480 / w);
          a += ` width="${Math.round(w * k)}" height="${Math.round(h * k)}"`;
        }
      }
      return `${head}${a}>${css ? `<style>${css}</style>` : ''}`;
    });
  }

  // 内联渲染: 消毒后原样进 DOM, 带 data-btn / data-cmd 的元素由 widgets 层接上点击。
  function svgImg(src) {
    const clean = sanitizeSvg(src);
    // 消毒后连根标签都没了 = 整段是伪装。原先返回空串, 于是整块图人间蒸发, 模型和读者都不知道发生过什么
    // —— 跟 mermaid 那个"永远渲染中"是同一类毛病: 失败得静悄悄。宁可显示源码, 也不要凭空消失。
    if (!/^\s*<svg\b/i.test(clean)) {
      console.error('[md] SVG 被消毒器判为不安全, 已降级为源码显示');
      return `<pre><code>${escapeHtml(src)}</code></pre>`;
    }
    return `<span class="md-svg-wrap">${clean}</span>`;
  }

  // 模型写围栏时未必老老实实写 ```svg —— xml / html / svg+xml 都见过; <svg 前面还可能多一行
  // XML 声明或注释。原先这些一律掉进普通代码块, 表现就是"图变成了源码", 而且没有任何报错。
  const SVG_FENCE_LANGS = new Set(['svg', 'xml', 'html', 'svgxml']);
  function looksLikeSvg(lang, src) {
    if (!SVG_FENCE_LANGS.has(String(lang).toLowerCase().replace(/[^a-z]/g, ''))) return false;
    return /^\s*(?:<\?xml[^>]*\?>\s*|<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg\b/i.test(src);
  }

  // 提 $$...$$ (块) 与 $...$ (行内) tex 公式, 跳过 ``` 代码块与 `code` 行内代码, 用不可打印字符包围的占位符
  // (SOH...STX) 替换, 待整段 md 渲染完再把占位换成 <div/span data-tex="...">, 由 renderer.js 用 KaTeX 二次渲染。
  // 占位用 M\d+ / C\d+ 而非明文 M1/C1, 是为了避开用户正文 "章节 M1" / "C3 汽车" 撞车。
  function protectMath(md, mathTable, svgTable, widgetTable) {
    const lines = md.split('\n');
    const parts = [];
    let i = 0;
    while (i < lines.length) {
      if (/^```/.test(lines[i])) {
        const buf = [lines[i]]; i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        if (i < lines.length) { buf.push(lines[i]); i++; }
        parts.push({ code: true, text: buf.join('\n') });
      } else {
        const buf = [];
        while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
        parts.push({ code: false, text: buf.join('\n') });
      }
    }
    return parts.map(p => {
      if (p.code) return p.text;
      let s = p.text;
      const codes = [];
      s = s.replace(/`[^`\n]+`/g, (m) => { codes.push(m); return SOH + 'C' + (codes.length - 1) + STX; });
      // 裸 <svg>...</svg>(不在代码块/行内代码里的) → 占位, 渲染完换成 data: URL img (作者: 模型直接吐 SVG 要出图不出源码)
      s = s.replace(/<svg\b[\s\S]*?<\/svg>/gi, (m) => { svgTable.push(m); return SOH + 'G' + (svgTable.length - 1) + STX; });
      // 行内控件 {{in:…}} {{sel:…}} {{btn:…}} {{cmd:…}} → 占位。在这儿抠是为了躲开表格的 | 切列
      // 和行内 markdown。渲染完由 renderer.js 建真控件(createElement, 永不 innerHTML —— 写得出
      // onclick 就摸得到 IPC)。
      // in/sel 只收集值, btn 把收集到的值送【AI】, cmd 送【平台】。两种语法里都没有"宛先"这一项,
      // 所以"往任意地方提交的界面"在文法上根本写不出来。
      // ui 是第三种: 把一个装好的界面包摆在这儿。它跑在沙箱里(renderer/sandbox.js),
      // 想画多复杂画多复杂, 但能往外做的事仍旧只有 cmd 那一条 —— 去处依然没有变多。
      s = s.replace(/\{\{(cmd|in|sel|btn|ui|pin|mark|picks|pick):([^}\n]*)\}\}/g, (_m, kind, spec) => {
        widgetTable.push({ kind, spec: spec.trim() });
        return SOH + 'W' + (widgetTable.length - 1) + STX;
      });
      s = s.replace(/\$\$([\s\S]+?)\$\$/g,
        (_m, tex) => { mathTable.push({ display: true, tex: tex.trim() }); return SOH + 'M' + (mathTable.length - 1) + STX; });
      s = s.replace(/\$([^$\n]+?)\$/g,
        (_m, tex) => { mathTable.push({ display: false, tex }); return SOH + 'M' + (mathTable.length - 1) + STX; });
      s = s.replace(/C(\d+)/g, (_m, n) => codes[+n]);
      return s;
    }).join('\n');
  }

  function render(md) {
    if (!md) return '';
    const mathTable = [];
    const svgTable = [];
    const widgetTable = [];
    md = protectMath(String(md).replace(/\r\n?/g, '\n'), mathTable, svgTable, widgetTable);
    const lines = md.split('\n');
    let html = '';
    let i = 0;
    let listType = null;
    const closeList = () => { if (listType) { html += `</${listType}>`; listType = null; } };

    while (i < lines.length) {
      const line = lines[i];

      /* 围栏代码块 ```lang  (lang=mermaid 走 mermaid 占位, 由 renderer.js 二次渲染)
         🔴 An opening fence counts even when what follows is not a language name: models pack
         the first line of content onto the fence line, `^```(\w*)$` misses it, and the backticks
         then reach the screen as literal characters. Anything that does not look like a language
         is kept as the first line — CommonMark drops it as an info string, and dropping eats
         a line of content. */
      const fence = line.match(/^```([^`]*)$/);
      if (fence) {
        closeList();
        const info = fence[1].trim();
        const isLang = /^[\w+-]+$/.test(info);
        const buf = isLang || !info ? [] : [info];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++; // 跳过收尾围栏
        const lang = isLang ? info : '';
        const src = buf.join('\n');
        if (lang === 'mermaid') {
          const t = src.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          html += `<div class="mermaid-block" data-src="${t}"><span class="mermaid-pending">流程图渲染中…</span></div>`;
        } else if (looksLikeSvg(lang, src)) {
          // 消毒器认根标签, 所以 XML 声明/注释/DOCTYPE 这些前言先削掉再交给它
          html += svgImg(src.trim().replace(/^[\s\S]*?(?=<svg\b)/i, ''));
        } else if (lang === 'record') {
          // 教师人格 fence: 内容首行可写 lang: xx (en/ja/zh/auto), 其余当"要跟读/回答的提示"
          // renderer.js renderMd 里 querySelectorAll('.record-block') 生成 RecordButton widget
          const t = src.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          html += `<div class="record-block" data-src="${t}"><span class="record-pending">录音组件加载中…</span></div>`;
        } else {
          html += `<pre><code>${escapeHtml(src)}</code></pre>`;
        }
        continue;
      }
      // 标题
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) { closeList(); html += `<h${h[1].length}>${inline(escapeHtml(h[2]))}</h${h[1].length}>`; i++; continue; }
      // 引用
      if (/^>\s?/.test(line)) {
        closeList();
        const buf = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
        html += `<blockquote>${inline(escapeHtml(buf.join('\n'))).replace(/\n/g, '<br>')}</blockquote>`;
        continue;
      }
      // 表格 (GFM: 表头行含 | + 下一行分隔 |---|)
      if (line.includes('|') && i + 1 < lines.length &&
          /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
        closeList();
        const header = splitRow(line);
        i += 2;
        let rows = '';
        while (i < lines.length && lines[i].includes('|') && !/^\s*$/.test(lines[i])) {
          rows += '<tr>' + splitRow(lines[i]).map((c) => `<td>${inline(escapeHtml(c))}</td>`).join('') + '</tr>';
          i++;
        }
        html += '<table><thead><tr>' + header.map((c) => `<th>${inline(escapeHtml(c))}</th>`).join('') +
                '</tr></thead><tbody>' + rows + '</tbody></table>';
        continue;
      }
      // 分割线
      if (/^(---|\*\*\*|___)\s*$/.test(line)) { closeList(); html += '<hr>'; i++; continue; }
      // 无序列表
      const ul = line.match(/^[-*+]\s+(.*)$/);
      if (ul) {
        if (listType !== 'ul') { closeList(); html += '<ul>'; listType = 'ul'; }
        html += `<li>${inline(escapeHtml(ul[1]))}</li>`; i++; continue;
      }
      // 有序列表
      const ol = line.match(/^(\d+)\.\s+(.*)$/);
      if (ol) {
        if (listType !== 'ol') { closeList(); html += '<ol>'; listType = 'ol'; }
        // 保留原始序号: 空行会 closeList 拆成多个 <ol>, 不带 value 会各自从 1 重数
        html += `<li value="${parseInt(ol[1], 10)}">${inline(escapeHtml(ol[2]))}</li>`; i++; continue;
      }
      // 空行
      if (/^\s*$/.test(line)) { closeList(); i++; continue; }
      // 段落: 聚合连续普通行
      closeList();
      const buf = [line];
      i++;
      while (i < lines.length && !/^\s*$/.test(lines[i]) &&
             !/^(#{1,6}\s|>|```|[-*+]\s|\d+\.\s|(---|\*\*\*|___)\s*$)/.test(lines[i])) {
        buf.push(lines[i]); i++;
      }
      html += `<p>${inline(escapeHtml(buf.join('\n'))).replace(/\n/g, '<br>')}</p>`;
    }
    closeList();
    // 把 M<N> tex 占位换成节点, 供 renderer.js 用 KaTeX 二次渲染 (tex 原文经 attr-escape 存 data-tex)
    html = html.replace(/M(\d+)/g, (_m, n) => {
      const item = mathTable[+n];
      if (!item) return _m;
      const t = String(item.tex).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return item.display
        ? `<div class="math-block" data-tex="${t}"></div>`
        : `<span class="math-inline" data-tex="${t}"></span>`;
    });
    // 把 G<N> svg 占位换成 data: URL img
    html = html.replace(/\x01G(\d+)\x02/g, (_m, n) => svgTable[+n] != null ? svgImg(svgTable[+n]) : _m);
    // 把 W<N> 占位换成空壳, 由 renderer.js 建真控件(未知命令/参数不足在那边出红字)
    html = html.replace(/\x01W(\d+)\x02/g, (_m, n) => {
      const w = widgetTable[+n];
      if (w == null) return _m;
      const t = String(w.spec).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `<span class="md-widget" data-kind="${w.kind}" data-spec="${t}"></span>`;
    });
    return html;
  }

  window.renderMarkdown = render;
  window.sanitizeSvg = sanitizeSvg;     // 门禁直接拿它验白名单, 免得只能隔着渲染结果猜
})();
