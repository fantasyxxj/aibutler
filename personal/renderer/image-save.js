// image-save.js — 气泡里的图右键「另存为」。renderer.js 已过行数闸, 单开文件; 排在它之后加载(要用 t())。
//
// 认三类: AI 画的内联 SVG(.md-svg-wrap) · 流程图(.mermaid-block) · <img>(md 图片 / 附件 / 放大层)。
// SVG 在这儿画成 2 倍 png 再交主进程(另给一项存 svg 原文); <img> 只交 src, 由主进程按来源取字节。
// 包在 a.filepath 里的图不接 —— 那是本机文件, 路径菜单里已有「另存为」, 两个菜单叠着弹只会乱。
(() => {
  const SCALE = 2;

  // 放大层里的 svg 是从原位搬过去的, 所以那里也得认
  function pick(target) {
    if (!target || !target.closest) return null;
    if (target.closest('a.filepath')) return null;
    const wrap = target.closest('.md-svg-wrap, .mermaid-block, #lightbox .lb-svg');
    if (wrap) { const svg = wrap.querySelector('svg'); return svg ? { svg, kind: wrap.classList.contains('mermaid-block') ? 'flowchart' : 'image' } : null; }
    const img = target.closest('img');
    if (img && img.src && img.closest('.msg, #lightbox')) return { img };
    return null;
  }

  // 图本身多半没底色(深色主题下字是浅色), 存成透明 png 在别处一打开就看不见字 —— 垫上它在界面里的底色
  function bgOf(el) {
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const c = getComputedStyle(n).backgroundColor;
      if (c && c !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(c)) return c;
    }
    return getComputedStyle(document.body).backgroundColor || '#1e1e24';
  }

  function svgText(svg) {
    const rect = svg.getBoundingClientRect();
    const clone = svg.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', Math.round(rect.width));
    clone.setAttribute('height', Math.round(rect.height));
    clone.style.maxWidth = 'none';
    // 继承来的字色/字体在单独一个文件里就丢了, 落到根上
    const cs = getComputedStyle(svg);
    clone.style.color = cs.color;
    clone.style.fontFamily = cs.fontFamily;
    return { text: new XMLSerializer().serializeToString(clone), w: rect.width, h: rect.height };
  }

  async function svgToPng(svg) {
    const { text, w, h } = svgText(svg);
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text);
    await img.decode();
    const c = document.createElement('canvas');
    c.width = Math.ceil(w * SCALE); c.height = Math.ceil(h * SCALE);
    const g = c.getContext('2d');
    g.fillStyle = bgOf(svg); g.fillRect(0, 0, c.width, c.height);
    g.scale(SCALE, SCALE); g.drawImage(img, 0, 0, w, h);
    const blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob 为空'))), 'image/png'));
    return new Uint8Array(await blob.arrayBuffer());
  }

  const stamp = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };

  async function save(opt) {
    const r = await window.butler.saveImage(opt);
    if (r && !r.ok && !r.canceled) { console.error('[image-save] 失败:', r.error); alert(t('save_image_failed') + (r.error || '')); }
  }

  function imgName(img) {
    try { const u = new URL(img.src); if (u.protocol !== 'data:') return decodeURIComponent(u.pathname.split('/').pop() || '') || 'image-' + stamp(); }
    catch (_) {}
    return 'image-' + stamp();
  }

  function menuItems(hit) {
    if (hit.img) return [{ label: t('save_image_as'), act: () => save({ src: hit.img.src, name: imgName(hit.img) }) }];
    const name = `${hit.kind}-${stamp()}`;
    return [
      { label: t('save_image_as'), act: async () => {
        try { await save({ bytes: await svgToPng(hit.svg), ext: 'png', name }); }
        catch (e) { console.error('[image-save] svg 转 png 失败:', e); alert(t('save_image_failed') + (e.message || e)); }
      } },
      { label: t('save_svg_as'), act: () => save({ bytes: new TextEncoder().encode(svgText(hit.svg).text), ext: 'svg', name }) },
    ];
  }

  // 外观照抄路径菜单(.filepath-menu), 同一时间屏幕上只留一个
  function show(e, items) {
    document.querySelectorAll('.filepath-menu').forEach((el) => el.remove());
    const menu = document.createElement('div');
    menu.className = 'filepath-menu';
    Object.assign(menu.style, {
      position: 'fixed', left: e.clientX + 'px', top: e.clientY + 'px',
      background: '#2b2b36', border: '1px solid #444', borderRadius: '6px',
      padding: '4px 0', minWidth: '180px', zIndex: 100000,
      boxShadow: '0 4px 16px rgba(0,0,0,0.4)', fontSize: '13px', color: '#e0e0e0', userSelect: 'none',
    });
    for (const it of items) {
      const row = document.createElement('div');
      row.textContent = it.label;
      Object.assign(row.style, { padding: '6px 14px', cursor: 'pointer' });
      row.addEventListener('mouseenter', () => { row.style.background = '#3a3a48'; });
      row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });
      row.addEventListener('click', () => { menu.remove(); it.act(); });
      menu.appendChild(row);
    }
    document.body.appendChild(menu);
    const close = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', close); } };
    setTimeout(() => document.addEventListener('mousedown', close), 0);
  }

  document.addEventListener('contextmenu', (e) => {
    const hit = pick(e.target);
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    show(e, menuItems(hit));
  }, true);
})();
