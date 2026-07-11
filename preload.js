// preload.js — 安全暴露 IPC 给渲染层。单窗口多标签: 所有请求带 sid(人格目录), 事件回调把 sid 一并回传。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('butler', {
  listSessions: () => ipcRenderer.invoke('list-sessions'),            // { sessions:[{sid,persona,usage}], active }
  getHistory: (sid) => ipcRenderer.invoke('get-history', { sid }),
  send: (sid, payload) => ipcRenderer.invoke('send-message', { sid, ...payload }),  // payload:{text,attachments}
  compact: (sid) => ipcRenderer.invoke('compact', { sid }),
  cancelCurrent: (sid) => ipcRenderer.invoke('cancel-current', { sid }),   // 打断当前跑着的一轮(用户救援, 消息文本 renderer 侧回填草稿)
  openPersona: () => ipcRenderer.invoke('open-persona'),             // 选目录 → { ok, meta:{sid,persona,usage} }
  closeSession: (sid) => ipcRenderer.invoke('close-session', { sid }),
  openPath: (p, reveal) => ipcRenderer.invoke('open-path', { path: p, reveal: !!reveal }),  // 点文件路径→默认程序打开/Finder定位
  openWithApp: (p, app) => ipcRenderer.invoke('open-with-app', { path: p, app }),           // 用指定 app 打开(如 "Visual Studio Code" / "Google Chrome")
  listPersonas: () => ipcRenderer.invoke('list-personas'),                    // { personas:[{id,name,homeDir,isButler,open}] }
  openPersonaRef: (ref) => ipcRenderer.invoke('open-persona-ref', { ref }),   // 按名字/id/目录打开已登记人格
  createPersonaUI: (spec) => ipcRenderer.invoke('create-persona-ui', spec),   // 管理 UI 建人格 { name, homeDir?, wakePhrase?, isButler? }
  updatePersona: (id, patch) => ipcRenderer.invoke('update-persona', { id, patch }),  // 改 name/wakePhrase/isButler
  deletePersona: (id) => ipcRenderer.invoke('delete-persona', { id }),        // 登记簿删除(不删目录/记忆, 只是不再列)
  openManagerWindow: () => ipcRenderer.invoke('open-manager-window'),         // 开独立管理窗口
  chooseDirectory: () => ipcRenderer.invoke('choose-directory'),              // 建人格时选目录 → { ok, path }
  readPersonaMd: (id) => ipcRenderer.invoke('read-persona-md', { id }),       // 读某人格的 persona.md 全文
  writePersonaMd: (id, content) => ipcRenderer.invoke('write-persona-md', { id, content }),  // 写回并刷 Butler 身份
  onPersonaOpened: (cb) => ipcRenderer.on('persona-opened', (_e, d) => cb(d.meta)),  // 管家开/建人格 → 主动加标签
  onRegistryChanged: (cb) => ipcRenderer.on('registry-changed', () => cb()),  // 登记簿变了 → 列表刷新

  onUserEcho: (cb) => ipcRenderer.on('user-echo', (_e, d) => cb(d.sid, d.text)),  // 程序注入的消息(如出生教育)也显示成 user 气泡
  onChunk: (cb) => ipcRenderer.on('assistant-chunk', (_e, d) => cb(d.sid, d.text)),
  onActivity: (cb) => ipcRenderer.on('activity', (_e, d) => cb(d.sid, d.text)),
  onTool: (cb) => ipcRenderer.on('tool-call', (_e, d) => cb(d.sid, d.tool)),   // { desc, name }
  onCompacting: (cb) => ipcRenderer.on('compacting', (_e, d) => cb(d.sid, d)),  // { phase:'start'|'done', reason }
  onResult: (cb) => ipcRenderer.on('turn-result', (_e, d) => cb(d.sid, d)),           // { finalText, interrupted, compacted }
  onUsage: (cb) => ipcRenderer.on('usage', (_e, d) => cb(d.sid, d.usage)),
});
