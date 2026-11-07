'use strict';
// first-persona.js — 第一个人格从哪来: 开机开谁 · 没接 AI 就一个都不建 · 空状态屏点「创建」之后的落地。
//
// 从 personal/main.js 搬出来的(那份 2637 行, 门禁只许改不许长)。作者 2026-09-20 定的规矩是
// 「碰到改哪里, 就把那个函数迁出去」—— 不专门排一轮大重构, 每次碰哪块就带走哪块。
//
// 🔴 没接 AI 就**一个人格都不建**, 而不是"建了但先不上课"。一旦写下 persona.md, 判新生儿的
// 依据(MEMORY.md 与 persona.md 都不存在)就永远为假, 那门出生教育再也补不上 —— 于是又得发明
// 一个"欠课"标记。不建, 就什么标记都不需要: 用户接上 AI 再点创建, 那一刻它本来就是新生儿。
//
// 🔴 所有路径都经过「创建初始人格」那一屏, 有没有 AI 只决定按钮灰不灰。不给"已登录"开捷径,
// 否则订阅用户又选不了人格目录 —— 那正是作者报的第三个问题。

const fs = require('fs');
const path = require('path');

// 这个目录里是不是已经住着一个人格了(拿来区分"新建"和"接管别处搬来的目录")
//
// 🔴 后两样才是不可替代的真身: 前两个 md 是 ensureMemory / ensurePersonaFile 会自动补写的骨架,
// 谁都可能把它们删掉或从没生成过, 而只剩 memory.v2.db 的目录一旦被判空, 出生礼物就会把
// self_identity 覆盖进它已有的记忆库 —— 那是真丢东西, 不像补骨架只是补文件。
const INHABITED_MARKS = ['MEMORY.md', 'persona.md', 'memory.v2.db', '.session.json'];
function looksInhabited(memDir) {
  try {
    return INHABITED_MARKS.some((f) => fs.existsSync(path.join(memDir, f)));
  } catch (_) { return false; }
}

/**
 * 开机要开哪些人格, 顺带把登记簿与新生儿脚手架都备好。
 * 返回 { toOpen, entry, memDir, newborn } —— **toOpen 为空 = 渲染层显示空状态屏**。
 * tabDirs: 上次开着的标签(调用方已过滤掉不存在的目录)
 *
 * 与老逻辑的唯一区别: 老代码在这里兜底 `[butlerSelfHome()]`, 于是干净机器上必然凭空
 * 冒出一个管家 —— 哪怕还没接 AI、哪怕用户根本没说要建。现在一个都不兜底。
 */
function planStartup({ tabDirs = [], registry, paths, persona, appVersion }) {
  let toOpen = tabDirs;
  if (!toOpen.length) {
    const known = registry.list() || [];
    // 标签状态丢了(换机器/清过缓存)但登记簿还在 → 开管家那个; 认不出就开第一个
    const selfHome = path.resolve(paths.butlerSelfHome());
    const pick = known.find((p) => p.homeDir && path.resolve(p.homeDir) === selfHome) || known[0];
    toOpen = pick && pick.homeDir ? [pick.homeDir] : [];
  }
  if (!toOpen.length) return { toOpen: [], entry: null, memDir: null, newborn: false };

  // 登记簿: 每个要开的目录都得有条目; 默认那个给个像样的名字"管家"而非目录名
  const selfHome = path.resolve(paths.butlerSelfHome());
  for (const d of toOpen) registry.ensureEntry(d, path.resolve(d) === selfHome ? { name: '管家' } : {});
  const entry = registry.ensureButler(toOpen[0]);
  const memDir = persona.resolveMemoryDir(entry.homeDir);
  // 老用户升级不会命中(他们的记忆目录早就有东西); 命中的是手动删过档案这类边缘情况
  const newborn = !looksInhabited(memDir);
  if (newborn) {
    persona.ensureMemory(memDir, entry.name || '管家');
    persona.ensurePersonaFile(entry.homeDir, memDir, entry.name || '管家', entry.wakePhrase);
    registry.setCapabilitySeen(entry.id, appVersion);
  }
  return { toOpen, entry, memDir, newborn };
}

// 空状态屏点「创建初始人格」走的是现成的 `create-persona-ui` IPC(main.js 的 createPersona):
// 它已经把建目录 · 登记 · 出生礼物 · openPersona · 出生教育全串起来了, 这里不另造一份。

// 选完目录当场探一次, 判断连同现成的说法一起递给界面 —— 不要等用户点了创建才告诉他不行。
// note 在这儿取词而不是丢给渲染层, 是因为四语字典在主进程这边(渲染层那份是另一套)。
function probeDir(dir, paths, persona, locale) {
  const s = require('./i18n-datadir').strings(locale);
  const unsafe = paths.isUnderInstallRoot(dir);
  const inhabited = looksInhabited(persona.resolveMemoryDir(dir));
  return {
    ok: true, path: dir, unsafe, inhabited,
    note: unsafe ? s.persona_in_install_root : (inhabited ? s.persona_dir_taken_over : ''),
  };
}

// 安装根拒绝。null = 安全。单独一个函数是因为**导入人格**那条路也要过同一道闸:
// `import-persona` 的 targetDir 跟创建屏一个口径, 同样是用户自己选的目录。
function rejectInstallRoot(homeDir, paths, locale) {
  if (!paths.isUnderInstallRoot(homeDir)) return null;
  return { ok: false, error: require('./i18n-datadir').strings(locale).persona_in_install_root };
}

/**
 * 建人格之前的两道闸。返回 null = 这是一次真正的新建, 调用方照常往下走;
 * 返回对象 = 已经有结论了(拒绝, 或已接管完成), 调用方直接把它 return 出去。
 *
 * 闸① 安装根: 人格目录是用户在整个流程里唯一意识到自己在选的目录(另一个是安装目录),
 *      所以这道闸必须拦在这里 —— data-dir-guard 那三道拦的是数据目录, 拦不到它。
 *      落在 `$INSTDIR` 里的人格, 下次覆盖安装会被安装程序当成上一版的垃圾整份清空。
 * 闸② 已住人: 目录里已经有 MEMORY.md / persona.md → 接管, 不是新建。
 *
 * 建目录这一步也搬进来了(原本在 createPersona 里), 好让调用方只留一行。
 */
function beforeCreate({ homeDir, spec = {}, registry, persona, paths, locale, open, onOpened }) {
  const bad = rejectInstallRoot(homeDir, paths, locale);
  if (bad) return bad;
  fs.mkdirSync(homeDir, { recursive: true });
  if (!looksInhabited(persona.resolveMemoryDir(homeDir))) return null;
  const t = takeOver({ homeDir, spec, registry, open });
  if (onOpened) onOpened(t.session);
  return { ok: true, id: t.entry.id, name: t.entry.name, homeDir: t.entry.homeDir, sid: t.session.sid, takenOver: true };
}

/**
 * 接管一个已经住着人格的目录: 只登记 + 打开, 不碰目录里任何东西。
 *
 * 🔴 走这条路的前提是 looksInhabited 为真, 所以**一件出生的事都不能做**: 出生礼物会把
 * self_identity 节点连同 pinned 一起写进它已有的记忆库(那是真覆盖, 不像 ensureMemory /
 * ensurePersonaFile 只在文件缺失时才写), 出生教育则会让它把自己当新生儿重学一遍身份。
 * 名字一律以目录里已有的身份为准, 不采用用户在创建屏填的那个。
 *
 * open 由 main.js 注入(openPersona 牵着会话与 UI)。
 */
function takeOver({ homeDir, spec = {}, registry, open }) {
  // 登记簿里还没有这条时, 创建屏填的名字和"是不是管家"要带上 —— ensureEntry 只拿 opts 建新条目,
  // 已有条目原样返回, 所以不存在"接管把人家名字改了"。不给名字的话它只会取目录名(butler-self)。
  const entry = registry.ensureEntry(homeDir, { name: spec.name, isButler: spec.isButler });
  // 登记簿里是新条目(目录从别处搬来/登记簿丢过)时, 创建屏上选的接入方式与模型要落上去;
  // 已经有值的一概不动 —— 那是这个人格自己的既定配置。
  const patch = {};
  for (const k of ['model', 'accessMode', 'credentialId']) {
    if (!entry[k] && spec[k]) patch[k] = spec[k];
  }
  const e = Object.keys(patch).length ? registry.upsert({ ...entry, ...patch }) : entry;
  return { entry: e, session: open(e.homeDir) };
}

/**
 * 建一个人格: 两道闸 → 登记 → 出生礼物落盘 → 开人格 → 出生教育。
 * 从 main.js 搬出来的(碰到改哪里就把那块带走)。牵着会话与 UI 的那几样由调用方注入:
 * open / sendUI / metaOf / broadcast / gift / onboard。
 *
 * 🔴 registry.upsert 的 model 与 accessMode 必须在这一刻就位, 不能建完再改: 两者都在 SDK spawn
 * 那刻定死(agent.js preferredModel/accessMode), 建完再改要关标签重开才生效; 更要紧的是下面
 * openPersona 之后立刻跑一整套出生教育 —— 建完再改的话, 这个人格最长的一次学习已经烧在别的模型上了。
 */
function create(spec = {}, deps = {}) {
  const { paths, registry, persona, open, sendUI, metaOf, broadcast, gift, onboard, locale } = deps;
  try {
    const name = String(spec.name || '').trim();
    if (!name) return { ok: false, error: '缺人格名' };
    let homeDir = spec.homeDir && String(spec.homeDir).trim();
    if (!homeDir) homeDir = path.join(paths.personasParent(), registry.slug(name));
    homeDir = path.resolve(homeDir);
    const pre = beforeCreate({ homeDir, spec, registry, persona, paths, locale, open,
      onOpened: (s) => { sendUI('persona-opened', { meta: metaOf(s), activate: true }); broadcast(); } });
    if (pre) return pre;   // 安装根拒绝 · 已住人则接管 · 建目录也在里面
    const entry = registry.upsert({
      id: registry.slug(name), name, homeDir,
      wakePhrase: spec.wakePhrase || undefined,
      isButler: !!spec.isButler,
      avatar: spec.avatar || undefined,
      model: spec.model || undefined, skills: spec.skills || registry.BASE_SKILLS,   // 两条建人格的路同一默认
      accessMode: spec.accessMode || undefined, credentialId: spec.credentialId || undefined,
      sdk: spec.sdk || require('../core/agent/util').sdkForNewPersona(spec.accessMode) || undefined,
      // 出生教育教的就是当前版本的能力 → 直接记成已补课, 免得它出生完立刻被补一遍刚学的东西。
      capabilitySeenVersion: paths.appVersion(),
    });
    // 出生礼物落磁盘: MEMORY.md 骨架 + persona.md 身份骨架 (wakePhrase 只入 registry, 不再落 wake.txt)
    const memoryDir = persona.resolveMemoryDir(homeDir);
    persona.ensureMemory(memoryDir, name);
    persona.ensurePersonaFile(homeDir, memoryDir, name, spec.wakePhrase);
    const s = open(homeDir, { newborn: !spec.skipOnboarding });
    gift(s, name, homeDir, memoryDir, spec.wakePhrase, spec.created_by);   // 图记忆自我认知起步节点(pinned)
    sendUI('persona-opened', { meta: metaOf(s), activate: true });   // 刚建出来的人格, 要让人当场看见
    broadcast();
    // 出生教育: butler 主动对新人格说话(第一条对话), 教它记忆/压缩/续线程/做事品格。
    // 管家新生儿走管家版课程(星型职责); 普通新生儿走叶子版(通信课+领域课)。skipOnboarding 可跳过。
    try {
      if (!spec.skipOnboarding) {
        // 🔴 上面 open 传了 newborn=true 把冷启动唤醒关掉了: 1 秒前才出生的人格没有"压缩前的线程"
        // 可续, 而两条只隔 800ms 会被队列并成一条(实测 9882 字符), 出生教育被埋在整屏脚手架后面。
        s._birthRunning = true;   // 排队这 800ms 里巡检器就当它在出生, 不先开口(实测「每天主动开口」抢在出生教育前)
        setTimeout(() => {
          Promise.resolve(onboard(s, name, spec.onboardingExtra, { isButler: !!spec.isButler }))
            .catch((e) => console.error('[create] 出生教育串行喂失败:', e && e.message));
        }, 800);  // 略等 stream 就绪
      }
    } catch (e) { console.error('[create] 出生教育触发失败:', e && e.message); }
    return { ok: true, id: entry.id, name: entry.name, homeDir: entry.homeDir, sid: s.sid };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

/**
 * 新生儿的出生礼物 + 出生教育。接管已有目录时 newborn=false, 调用方不该调到这里。
 * gift / onboard 由 main.js 注入(它们还牵着会话与 UI, 暂时留在那边)。
 */
function birth({ session, entry, memDir, gift, onboard, delayMs = 1200 }) {
  if (!session) return;
  const name = (entry && entry.name) || '管家';
  gift(session, name, entry.homeDir, memDir, entry.wakePhrase, 'butler 首启脚手架');
  session._birthRunning = true;   // 同上: 等的这段里不让「每天主动开口」抢先
  setTimeout(() => {
    Promise.resolve(onboard(session, name, undefined, { isButler: true }))
      .catch((e) => console.error('[first-persona] 出生教育失败:', e && e.message));
  }, delayMs);   // 略等窗口/stream 就绪
}

// 空状态屏要显示"人格资料默认放哪", 得问主进程要。IPC 在这儿**自注册** —— main.js 撞着
// 行数闸(2617 行, 只许改不许长), 同仓里 hub-ipc.js 也是这么做的。
// 非 electron 环境(门禁直接 require 这个文件)拿不到 ipcMain, 静默跳过。
try {
  const { ipcMain } = require('electron');
  if (ipcMain && !ipcMain.listenerCount('default-persona-dir')) {
    ipcMain.handle('default-persona-dir', () => {
      try { return require('./paths').butlerSelfHome(); } catch (_) { return ''; }
    });
  }
  // 界面在"选完目录"和"刚打开这一屏"两个时刻都要探一次: 登记簿丢了而人格目录还在时,
  // 默认那个路径本身就已经住着人 —— 不探的话用户看到的仍是一句"创建", 心里以为要从零开始。
  if (ipcMain && !ipcMain.listenerCount('probe-persona-dir')) {
    ipcMain.handle('probe-persona-dir', (_e, { dir } = {}) => {
      try {
        const paths = require('./paths');
        const abs = path.resolve(String(dir || ''));
        return { ok: true, path: abs, unsafe: paths.isUnderInstallRoot(abs),
          inhabited: looksInhabited(require('../core/persona').resolveMemoryDir(abs)) };
      } catch (_) { return { ok: false }; }
    });
  }
} catch (_) { /* 门禁/CLI 环境, 不需要 IPC */ }

module.exports = { planStartup, birth, create, looksInhabited, takeOver, beforeCreate, rejectInstallRoot, probeDir };
