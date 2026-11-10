// quick-create-ui.js — 人格管理「新建」顶上的一句话建人格。跟 manager.js 同页加载, 用它的 t() / toast()。
// 点「让管家去建」→ 主进程(personal/quick-create.js)把这句话递进管家的对话并切到主窗口, 管家建好后在对话里回话。
(() => {
  const input = document.getElementById('qc-text');
  const go = document.getElementById('qc-go');
  const submit = async () => {
    const text = input.value.trim();
    if (!text) { toast(t('mgr_quick_empty')); input.focus(); return; }
    go.disabled = true;
    const r = await window.butler.quickCreatePersona(text).catch((e) => ({ ok: false, error: e && e.message }));
    go.disabled = false;
    if (!r || !r.ok) { toast((r && r.error) || ''); return; }
    input.value = '';
    toast(t('mgr_quick_sent', { name: r.butler }));
  };
  go.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) submit(); });
})();
