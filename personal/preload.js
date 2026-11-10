// preload.js — 安全暴露 IPC 给渲染层。单窗口多标签: 所有请求带 sid(人格目录), 事件回调把 sid 一并回传。
const { contextBridge, ipcRenderer } = require('electron');

// 版本号由主进程通过 webPreferences.additionalArguments 递进来。
// 🔴 别改回 require('./package.json'): preload 在沙箱里 require JSON 会抛, 而 catch 只往 renderer 控制台写一行 ——
//    窗口标题于是长期显示「v?」, 谁都不会注意到。启动参数是同步可得的, 不用等 IPC。
const VER_FLAG = '--butler-version=';
const _pkgVersion = (process.argv.find((a) => a.startsWith(VER_FLAG)) || '').slice(VER_FLAG.length) || '?';

contextBridge.exposeInMainWorld('butler', {
  version: _pkgVersion,   // 版本号 (0.0.2 起), renderer 显示在窗口 title
  platform: process.platform,   // 'darwin'|'win32'|'linux' — renderer 侧路径识别/菜单文案按平台分叉
  listSessions: () => ipcRenderer.invoke('list-sessions'),            // { sessions:[{sid,persona,usage}], active }
  getHistory: (sid, limit) => ipcRenderer.invoke('get-history', { sid, limit }),   // 开标签: 只要最近 limit 条(默认 400)
  historyPage: (sid, before, limit) => ipcRenderer.invoke('history-page', { sid, before, limit }),  // 往上翻: 取比 before(时间戳游标)更早的 limit 条 → { messages }
  send: (sid, payload) => ipcRenderer.invoke('send-message', { sid, ...payload }),  // payload:{text,attachments}
  getAttachment: (sid, p) => ipcRenderer.invoke('get-attachment', { sid, path: p }),   // #9 拿磁盘上的图片附件 → { ok, base64 }
  compact: (sid) => ipcRenderer.invoke('compact', { sid }),
  triggerHeartbeat: (sid) => ipcRenderer.invoke('trigger-heartbeat', { sid }),   // A2 心跳手动触发 (spec §1.5, 待 idle_watcher 接管)
  cancelCurrent: (sid) => ipcRenderer.invoke('cancel-current', { sid }),   // 打断当前跑着的一轮(用户救援, 消息文本 renderer 侧回填草稿)
  openPersona: () => ipcRenderer.invoke('open-persona'),             // 选目录 → { ok, meta:{sid,persona,usage} }
  closeSession: (sid) => ipcRenderer.invoke('close-session', { sid }),
  openPath: (p, reveal) => ipcRenderer.invoke('open-path', { path: p, reveal: !!reveal }),  // 点文件路径→默认程序打开/Finder定位
  saveImage: (opt) => ipcRenderer.invoke('save-image', opt),   // 右键图片另存为: {bytes,ext,name} 或 {src,name} → { ok, path } | { canceled }
  openWithApp: (p, app) => ipcRenderer.invoke('open-with-app', { path: p, app }),           // 用指定 app 打开, app 传逻辑名 'chrome'|'vscode'(主进程按平台解析成命令)
  listOpeners: () => ipcRenderer.invoke('list-openers'),                                    // 本机装了哪些可选打开方式 → [{key,label}]
  listPersonas: () => ipcRenderer.invoke('list-personas'),                    // { personas:[{id,name,homeDir,isButler,open}] }
  openPersonaRef: (ref) => ipcRenderer.invoke('open-persona-ref', { ref }),   // 按名字/id/目录打开已登记人格
  modelVendors: () => ipcRenderer.invoke('model-vendors'),   // 按档选模型: 厂家卡片(id/名字/官方地址/有哪几档)
  pickModelForTier: (opt) => ipcRenderer.invoke('pick-model-for-tier', opt),   // {credentialId, tier, vendor?} → 真发一条试通的那一档型号, 或失败原因
  listModelOptions: (opt) => ipcRenderer.invoke('list-model-options', opt),   // opt:{useApi} = 该人格此刻选的接入方式 → {options, source:'live'|'fallback', from}: 走 key 问端点, 订阅问 SDK, 拉不到回落 config/models/list.json; source/from 供 UI 写清"这几个是哪来的"
  createPersonaUI: (spec) => ipcRenderer.invoke('create-persona-ui', spec),   // 管理 UI 建人格 { name, homeDir?, wakePhrase?, isButler? }
  updatePersona: (id, patch) => ipcRenderer.invoke('update-persona', { id, patch }),  // 改 name/wakePhrase/isButler
  // 改接入方式专用: 沉淀 → 拆流 → 才写盘 → 重开, 一次做完。patch 必须交给它写, 不能先 updatePersona
  // 再来调 —— 先写盘会把新模型热切进旧端点的会话, 沉淀当场报错(见 main.js 那处注释)
  restartPersona: (id, patch) => ipcRenderer.invoke('restart-persona', { id, patch }),
  deletePersona: (id) => ipcRenderer.invoke('delete-persona', { id }),        // 登记簿删除(不删目录/记忆, 只是不再列)
  exportPersona: (id) => ipcRenderer.invoke('export-persona', { id }),        // 整体导出成一个文件 → { ok, path, size, stripped[] }
  importPersona: (targetDir) => ipcRenderer.invoke('import-persona', { targetDir }),   // 从文件导入(targetDir 留空 = personas/<名字>) → { ok, id, name, memory, stripped[], exportedAt }
  openManagerWindow: (view) => ipcRenderer.invoke('open-manager-window', { view }),   // 开独立管理窗口; view='create' 进新建视图
  onManagerView: (cb) => ipcRenderer.on('manager-view', (_e, v) => cb(v)),   // 窗口已开着时切视图
  openSettingsWindow: (group) => ipcRenderer.invoke('open-settings-window', { group }),   // 开独立系统设置窗口; group=general|models|tools|adv 停在哪一页(不给 = 通用)
  onSettingsGroup: (cb) => ipcRenderer.on('settings-group', (_e, g) => cb(g)),          // 设置窗已开着时, 别处要它翻到某一页
  // 连公网 hub: 留一句话申请 → 作者点头 → 自己点「检查」把 token 取回来并配好通道
  hubState: (personaId) => ipcRenderer.invoke('hub-state', { personaId }),    // { applyId, status, asked, ownerName, shouldPrompt }
  hubApply: (opt) => ipcRenderer.invoke('hub-apply', opt),                    // { displayName, ownerName, message, personaId } → { ok, applyId, status }
  hubClaim: (personaId) => ipcRenderer.invoke('hub-claim', { personaId }),    // → { ok, granted, status, agent }
  channelTest: (spec, text) => ipcRenderer.invoke('channel-test', { spec, text }),   // 通道页「发一条测试」→ { ok, error? }
  hubDismiss: () => ipcRenderer.invoke('hub-dismiss'),                        // 「我不用」: 以后不再自动问
  getLocalApi: () => ipcRenderer.invoke('get-local-api'),                     // 本机戳醒 API 配置 { enabled, port, running }
  setLocalApi: (patch) => ipcRenderer.invoke('set-local-api', patch),         // 改开关/端口 → 立即重起服务
  getLocale: () => ipcRenderer.invoke('get-locale'),                          // 界面语言 { locale, strings, locales:[{id,label}] }
  setLocale: (locale) => ipcRenderer.invoke('set-locale', { locale }),        // 切界面语言 → { ok, locale, strings, locales }
  onLocaleChanged: (cb) => ipcRenderer.on('locale-changed', (_e, d) => cb(d)),  // 别的窗口切了语言 → 本窗口跟着重绘(两个窗口两种语言像坏了)
  getTheme: () => ipcRenderer.invoke('get-theme'),                            // 界面深浅 { theme: 'system'|'light'|'dark' }
  setTheme: (theme) => ipcRenderer.invoke('set-theme', { theme }),            // 切深浅: 主进程改 nativeTheme, 各窗口媒体查询当场跟着变
  getQuickSwitch: () => ipcRenderer.invoke('get-quick-switch'),               // 顶栏「key · 模型 ▾」开没开 { on }(默认关)
  setQuickSwitch: (on) => ipcRenderer.invoke('set-quick-switch', { on }),     // 开关它 → 所有窗口收 quick-switch-changed
  onQuickSwitchChanged: (cb) => ipcRenderer.on('quick-switch-changed', (_e, d) => cb(d)),
  getTips: () => ipcRenderer.invoke('get-tips'),                              // 启动小贴士 { on, seen } · on=打开时弹, seen=看过第一条
  setTips: (patch) => ipcRenderer.invoke('set-tips', patch),                  // { on?, seen? }
  showTips: () => ipcRenderer.invoke('show-tips'),                            // 主窗口当场弹一张(系统设置里点)
  onTipsShow: (cb) => ipcRenderer.on('tips-show', () => cb()),
  quickCreatePersona: (text) => ipcRenderer.invoke('quick-create-persona', { text }),   // 一句话建人格: 交给管家去建 { ok, butler?, error? }
  dataDirInfo: () => ipcRenderer.invoke('data-dir-info'),                     // 数据位置 { dir, canMove } · canMove=有指针可改(打包版)
  dataDirOpen: () => ipcRenderer.invoke('data-dir-open'),                     // 在访达 / 资源管理器里打开数据目录
  dataDirMove: () => ipcRenderer.invoke('data-dir-move'),                     // 选目录 → 确认 → 重启后搬; 返回 { ok, error? }
  getToolRows: () => ipcRenderer.invoke('get-tool-rows'),                     // 对话里显不显示工具调用条 { on }(默认关)
  setToolRows: (on) => ipcRenderer.invoke('set-tool-rows', { on }),           // 开关它 → 所有窗口收 tool-rows-changed
  onToolRowsChanged: (cb) => ipcRenderer.on('tool-rows-changed', (_e, d) => cb(d)),
  getSettings: () => ipcRenderer.invoke('get-settings'),                      // 用户设置 { proxy:{enabled,url,no_proxy}, _file }
  setSettings: (patch) => ipcRenderer.invoke('set-settings', patch),          // 存盘 + 立即应用代理
  testProxy: (patch) => ipcRenderer.invoke('test-proxy', patch),              // 用待验证的配置试连 → { ok, detail }
  // 凭据仓库(多条)。key 真值一律不回传, 只给 keyState: none/ok/stale
  listCredentials: () => ipcRenderer.invoke('list-credentials'),              // { credentials:[{id,name,base_url,vendor,keyState}], defaultCredentialId, subLoggedIn, keychain, ccAvailable }
  credentialUsers: (id) => ipcRenderer.invoke('credential-users', { id }),       // { users:[{id,name}] } 开着且正用这条的人格
  saveCredential: (patch) => ipcRenderer.invoke('save-credential', patch),    // { id?, name, base_url, vendor?, protocol?, apiKey, makeDefault } · vendor=厂家卡片的 id, 空=其他 · protocol: anthropic/compat…, 空=自动 · apiKey: 空=不动 / null=删 / 串=换
  deleteCredential: (id) => ipcRenderer.invoke('delete-credential', { id }),
  setDefaultCredential: (id) => ipcRenderer.invoke('set-default-credential', { id }),
  testCredential: (patch) => ipcRenderer.invoke('test-credential', patch),    // 拿这条凭据真发一次最小请求 → { ok, detail, protocol?, base_url? } · 自动档测出的协议/补过 /v1 的地址
  listSearchKeys: () => ipcRenderer.invoke('list-search-keys'),               // { engines:[{id,type,url?,key:none|ok|stale}], disabled, types, keychain }
  saveSearchKeys: (patch) => ipcRenderer.invoke('save-search-keys', patch),     // { engines:[{id?,type,url?,key?}], disabled } · 整表替换, 顺序即先后 · key: 空=不动 / null=删 / 串=换
  testSearchEngine: (eng) => ipcRenderer.invoke('test-search-engine', eng),     // { type, id?, url?, key? } → { ok, ms, count?, first?, error? }
  ccSdkStatus: () => ipcRenderer.invoke('cc-sdk-status'),                      // { applicable, installed, installing, version } · 开源包才 applicable
  ccSdkInstall: () => ipcRenderer.invoke('cc-sdk-install'),                    // 下载 Claude Agent SDK · { ok, error? }
  ccSdkDisable: (opts) => ipcRenderer.invoke('cc-sdk-disable', opts),        // 关闭订阅 { deleteFiles } · 删文件要用户在第二个框里确认
  ccSdkRelaunch: () => ipcRenderer.invoke('cc-sdk-relaunch'),                  // 装好 / 移除后重启 app
  onCcSdkProgress: (cb) => ipcRenderer.on('cc-sdk-progress', (_e, p) => cb(p)), // { step: sdk|bin|extract, pct }
  // 订阅长效 token(claude setup-token 产出): 存了就绕开 keychain 那条会偶发断裂的续期链, 根治周期性 401
  subTokenState: () => ipcRenderer.invoke('sub-token-state'),                 // → { state: none|ok|stale, keychain }
  saveSubToken: (token) => ipcRenderer.invoke('save-sub-token', { token }),   // 串=换 / null=删 / ''=不动 · 换完要重起人格才生效
  runSetupToken: () => ipcRenderer.invoke('run-setup-token'),                 // 替你跑 claude setup-token: 弹浏览器→你点授权→自动存好 → { ok, hint } · 十分钟超时
  chooseDirectory: () => ipcRenderer.invoke('choose-directory'),              // 建人格时选目录 → { ok, path, unsafe, inhabited, note }
  defaultPersonaDir: () => ipcRenderer.invoke('default-persona-dir'),         // 初始人格默认落哪(空状态屏显示) → 绝对路径
  probePersonaDir: (dir) => ipcRenderer.invoke('probe-persona-dir', { dir }), // 这个目录能不能放人格 → { ok, path, unsafe, inhabited }
  readPersonaMd: (id) => ipcRenderer.invoke('read-persona-md', { id }),       // 读某人格的 persona.md 全文
  writePersonaMd: (id, content) => ipcRenderer.invoke('write-persona-md', { id, content }),  // 写回并刷 Butler 身份
  commandCatalog: () => ipcRenderer.invoke('command-catalog'),               // 行内命令目录 { commands } — 画 {{cmd:}} 按钮前要
  runCommand: (name, args) => ipcRenderer.invoke('run-command', { name, args }),  // 执行 → { ok, message, render?, notifyAi }
  onRecordOp: (cb) => ipcRenderer.on('record-op', (_e, d) => cb(d)),         // record 原语: 主进程要宿主页录/停/放 → renderer/record-host.js
  recordReply: (d) => ipcRenderer.invoke('record-reply', d),                  // 宿主页回话 { rid, ok, wav?, code?, message? }
  uiPackages: () => ipcRenderer.invoke('ui-packages'),                        // 装了哪些界面包 { packages:[{id,version,title,html,css,js}] } — 画 {{ui:}} 沙箱前要
  onPackagesChanged: (cb) => ipcRenderer.on('packages-changed', () => cb()),  // 装了/换了包 → 本窗口重取界面包和命令目录(两份都是开窗时的缓存)
  uiStateRead: (id) => ipcRenderer.invoke('ui-state-read', { id }),           // 某个界面包上次存的东西 → { state }
  uiStateWrite: (id, state) => ipcRenderer.invoke('ui-state-write', { id, state }),  // 替它落盘 → { ok, message? }
  boardStateRead: (sid) => ipcRenderer.invoke('board-state-read', { sid }),          // 常驻板「已撤下槽位」黑名单 → { removed:[slot] }
  boardStateWrite: (sid, removed) => ipcRenderer.invoke('board-state-write', { sid, removed }),  // 撤下/钉上时持久化 → { ok }
  getChips: (sid) => ipcRenderer.invoke('get-chips', { sid }),                        // 输入框上方快捷按钮 { chips:[{id,icon,label,prompt}] }
  bumpChip: (sid, chipId) => ipcRenderer.invoke('chip-bump', { sid, chipId }),       // 点一下=计数+1, 按钮留在原地 → { ok, count, chips }
  onChipsChanged: (cb) => ipcRenderer.on('chips-changed', (_e, d) => cb(d.sid, d.chips)),  // AI 调 update_prompt_chips 后重渲
  onPersonaOpened: (cb) => ipcRenderer.on('persona-opened', (_e, d) => cb(d.meta, d.activate)),  // 加/刷标签; activate 才切过去
  onPluginRender: (cb) => ipcRenderer.on('plugin-render', (_e, d) => cb(d.sid, d.text)),  // plugin_open → 系统直接把界面画进气泡流(不经 AI 复读那行标记)
  onRegistryChanged: (cb) => ipcRenderer.on('registry-changed', () => cb()),  // 登记簿变了 → 列表刷新

  onUserEcho: (cb) => ipcRenderer.on('user-echo', (_e, d) => cb(d.sid, d.text)),  // 程序注入的消息(如出生教育)也显示成 user 气泡
  onChunk: (cb) => ipcRenderer.on('assistant-chunk', (_e, d) => cb(d.sid, d.text)),
  onTextDone: (cb) => ipcRenderer.on('assistant-text-done', (_e, d) => cb(d.sid)),
  onStep: (cb) => ipcRenderer.on('assistant-step', (_e, d) => cb(d.sid, d.phase)),   // start = 模型开始新的一步 · discard = 这一步断流要重发, 撤掉它流出的字   // 文本块收尾 → 气泡定稿渲染, 不等整轮结束
  onActivity: (cb) => ipcRenderer.on('activity', (_e, d) => cb(d.sid, d.text)),
  onTool: (cb) => ipcRenderer.on('tool-call', (_e, d) => cb(d.sid, d.tool)),   // { desc, name }
  onTasks: (cb) => ipcRenderer.on('tasks', (_e, d) => cb(d.sid, d.tasks)),    // AI 自己那份任务清单
  onToolDone: (cb) => ipcRenderer.on('tool-done', (_e, d) => cb(d.sid, d)),    // 工具完成 { name } → UI checkmark
  onCompacting: (cb) => ipcRenderer.on('compacting', (_e, d) => cb(d.sid, d)),  // { phase:'start'|'done', reason }
  onResult: (cb) => ipcRenderer.on('turn-result', (_e, d) => cb(d.sid, d)),           // { finalText, interrupted }
  onUsage: (cb) => ipcRenderer.on('usage', (_e, d) => cb(d.sid, d.usage)),
  onSediment: (cb) => ipcRenderer.on('sediment', (_e, d) => cb(d)),   // {phase:'show'|'progress'|'alive'|'notice'|'hide', personas?, sid?, status?, busy?}
  // 退出遮罩上那条通知的两个按钮。它不是拦路框: 后台写完会自己收掉, 这里没人点也不会卡住谁。
  quitNotice: (action) => ipcRenderer.send('quit-notice', action),   // 'force' | 'cancel'

  // 认证失效: 某人格吃到 401 → 挂常驻横幅; 用户点"重新登录"走 OAuth, 完成后 main 自动重建会话并回放暂存消息。
  onAuthExpired: (cb) => ipcRenderer.on('auth-expired', (_e, d) => cb(d)),   // { sid, name, kind, mode, raw } — kind 决定给哪个出口
  onAuthOk: (cb) => ipcRenderer.on('auth-ok', () => cb()),
  // 到点的提醒(主进程统一盯, 一行一条挂在顶上): 全量推送 / 要一份全量 / 人点了按钮
  onReminders: (cb) => ipcRenderer.on('reminders', (_e, d) => cb(d)),
  remindersGet: () => ipcRenderer.invoke('reminders-get'),
  reminderAct: (a) => ipcRenderer.invoke('reminder-act', a),   // {homeDir,id,action:'ignore'|'snooze'|'handle',minutes?,until?}
  onAuthPending: (cb) => ipcRenderer.on('auth-pending', (_e, d) => cb(d)),   // 首登授权在后台跑: { done, error? }
  relogin: () => ipcRenderer.invoke('relogin'),                              // { ok, error? }

  // AskUserQuestion: SDK 派 request_user_dialog → main 转发到这里. renderer 弹选项框, 用户答完/取消调 answerUserDialog 回填.
  // req.payload.questions[] 是 AskUserQuestionInput 的 questions 数组; answer=null 表示取消 → SDK 兜底.
  onUserDialog: (cb) => ipcRenderer.on('user-dialog', (_e, d) => cb(d)),   // { sid, dialogId, kind, payload, toolUseID }
  answerUserDialog: (sid, dialogId, answer) => ipcRenderer.invoke('answer-user-dialog', { sid, dialogId, answer }),

  // 语音: STT (whisper.cpp 本地) + 录音写入人格目录
  voiceStatus: () => ipcRenderer.invoke('voice-status'),                                    // { ok, cli, model, error?, hint?, canAutoInstall? } 首启检测
  voiceSetup: () => ipcRenderer.invoke('voice-setup'),                                      // 代下引擎+模型 → {ok, cli, model} | {ok:false, error}
  onVoiceSetupProgress: (cb) => ipcRenderer.on('voice-setup-progress', (_e, p) => cb(p)),   // { phase:'engine'|'model', pct, note }
  transcribeAudio: (wavBytes, lang) => ipcRenderer.invoke('transcribe-audio', { wavBytes, lang }),  // {ok, text, error?}
  saveAudio: (sid, wavBytes) => ipcRenderer.invoke('save-audio', { sid, wavBytes }),        // {ok, path, sec, error?}  写到 <homeDir>/audio_uploads/<ts>.wav
});
