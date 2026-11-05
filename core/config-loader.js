// 配置加载器的内核 —— 只管解析 / 缓存 / 热读 / 回落顺序, **不知道来源是什么**。
//
// 来源链由宿主注入, 先命中先用。两版的差别全部落在这一处:
//   个人版  [用户目录覆盖, 出厂默认]        —— 用户自己改得动
//   行业版  [服务端下发, 出厂默认]          —— 彻底下发, 店主改不动
// 内核不认识 Electron, 不认识"用户目录"这种概念, 只认一个有序的目录数组。
//
// 缺失: 硬报错, 别静默(提示词丢失 = 行为大变, 要立刻炸出来)。
const fs = require('fs');
const path = require('path');
const lang = require('./memory-v2/lang');

function createConfigLoader({ sources = [] } = {}) {
  const roots = sources.filter(Boolean);
  if (!roots.length) throw new Error('createConfigLoader: sources 不能为空');
  // 🔴 第 0 位是覆盖层, 其余全是出厂层 —— 出厂**可以有多层**(如个人版的 personal/config + core/config),
  // 所以"出厂"不能按位置猜成最末位那一个: 猜错的样子是凡命中非末位出厂层的 key 全被判成"已被覆盖",
  // 覆盖层诊断整片失真。这也是先前不敢给个人版挂 core 兜底的唯一原因。
  const factoryRoots = roots.slice(1);
  const lastRoot = roots[roots.length - 1];
  const cache = new Map();
  const optCache = new Map();   // jsonOptional 专用, 按 mtime 失效(理由见那边)

  // 🔴 覆盖必须留痕。一份忘了删的旧覆盖会把新版出厂提示语悄悄挡掉, 那是升级完"改动没生效"里
  // 最难查的一种 —— 代码是新的、包是新的、装也装了, 只有提示语还是老的。所以每个 key 首次
  // 命中非出厂来源时打一行日志, 让它在启动日志里看得见。
  const logged = new Set();

  function pick(key, ext) {
    for (let i = 0; i < roots.length; i++) {
      const p = path.join(roots[i], key + ext);
      if (!fs.existsSync(p)) continue;
      if (i === 0 && roots.length > 1 && !logged.has(key)) {
        logged.add(key);
        console.log(`[config-loader] 覆盖生效: ${key} ← ${p}`);
      }
      return p;
    }
    return path.join(lastRoot, key + ext);   // 让报错指向出厂那份, 那才是"本该存在"的位置
  }

  // 出厂层里这个 key 落在哪一份(跳过覆盖层往下找)。多层出厂时先命中先算。
  function factoryOf(key, ext) {
    for (const r of factoryRoots) {
      const p = path.join(r, key + ext);
      if (fs.existsSync(p)) return p;
    }
    return path.join(lastRoot, key + ext);
  }

  function text(key) {
    if (cache.has(key)) return cache.get(key);
    const p = pick(key, '.md');
    if (!fs.existsSync(p)) throw new Error('config 缺失: ' + p);
    const v = fs.readFileSync(p, 'utf8');
    cache.set(key, v);
    return v;
  }

  // 🔴 只给【用户在聊天窗里看得见】的那几段用(起床语 / 出生教育): 找 `<key>.<语言>.md`,
  // 按 lang 的回落链挑第一份存在的。喂给模型而用户看不见的文本不走这里 —— 那些一律英文单份,
  // 见 [[feedback_system_to_ai_text_is_always_english]]。
  function textL(key) {
    for (const code of lang.fallbackChain()) {
      // 🔴 英文那一格认两种文件名, 按这个顺序: 先 `<key>.en.md`(四语并列命名, 出生教育
      // 那几段是这种), 没有再回落裸 `<key>.md`(config/ 的老约定"单份文案就是裸 .md 且它
      // 是英文")。两种都没有才 continue 到链上下一格。
      // 只认裸 .md 的后果(2026-09-26 与 2026-09-30 两次实地踩到): 链是 ['en','zh-CN'],
      // 四语并列的那几个 key 没有裸 .md, en 格直接 continue, 下一格 `.zh-CN.md` 存在 →
      // **英文界面拿到中文文案**, 而链尾那句 `return text(key)` 的兜底永远轮不到。
      if (code === 'en') {
        for (const ck of [`${key}.en`, key]) {
          if (cache.has(ck)) return cache.get(ck);
          const pe = pick(ck, '.md');
          if (!fs.existsSync(pe)) continue;
          const ve = fs.readFileSync(pe, 'utf8');
          cache.set(ck, ve);
          return ve;
        }
        continue;
      }
      const k = `${key}.${code}`;
      if (cache.has(k)) return cache.get(k);
      const p = pick(k, '.md');
      if (!fs.existsSync(p)) continue;
      const v = fs.readFileSync(p, 'utf8');
      cache.set(k, v);
      return v;
    }
    return text(key);
  }

  function json(key) {
    if (cache.has(key)) return cache.get(key);
    const p = pick(key, '.json');
    if (!fs.existsSync(p)) throw new Error('config 缺失: ' + p);
    const v = JSON.parse(fs.readFileSync(p, 'utf8'));
    cache.set(key, v);
    return v;
  }

  // 可选 json —— 文件不存在就返回 fallback, 不报错。
  //
  // 🔴 与 json() 的"缺失硬报错"刻意相反, 判据是**出厂带不带这个文件**:
  //   出厂带默认 → json()         缺失说明包坏了/覆盖写错了, 要立刻炸(提示语丢失 = 行为大变)
  //   出厂不带   → jsonOptional() 只存在于数据目录的本机知识, 不存在是正常状态, 报错才是错的
  // 第一个用它的是确知窗口表 models/windows.json(AI 查准某个模型的真实上下文窗口才写一条,
  // 多数机器上一辈子不存在)。
  //
  // 坏 JSON 仍然炸: 那是人写错了, 静默回落会让他以为改生效了, 比报错难查得多。
  function jsonOptional(key, fallback = null) {
    // 不走 fs.watch 那套缓存: 文件(连同子目录)在 app 启动后才被建、或被整个删掉时, watch 清不掉
    // 这个 key —— 2026-11-05 实测人格首次写 models/windows.json、或删掉它, 重开人格都还是旧值。
    // 改成每次看一眼文件在不在、改没改(mtime), 调用点都是低频的(开人格/换模型)。
    const p = pick(key, '.json');
    if (!fs.existsSync(p)) return fallback;
    const mtime = fs.statSync(p).mtimeMs;
    const hit = optCache.get(key);
    if (hit && hit.p === p && hit.mtime === mtime) return hit.v;
    const v = JSON.parse(fs.readFileSync(p, 'utf8'));
    optCache.set(key, { p, mtime, v });
    return v;
  }

  // 把 {{变量}} 填进一段已经拿到手的模板。给 json 配置里的模板串用 —— 那些不是整份文件,
  // render 取不到, 但同样不该退回代码里拼字符串。
  function fill(tpl, vars = {}) {
    let v = String(tpl == null ? '' : tpl);
    for (const [k, val] of Object.entries(vars)) v = v.replaceAll('{{' + k + '}}', String(val ?? ''));
    return v;
  }

  const render = (key, vars = {}) => fill(text(key), vars);
  const renderL = (key, vars = {}) => fill(textL(key), vars);

  // 这个 key 现在用的是哪份 / 覆盖文件该放哪。给"改提示语"这件事一个不用猜的入口。
  function whichFile(key, ext = '.md') {
    const active = pick(key, ext);
    const factoryPath = factoryOf(key, ext);
    const overridePath = roots.length > 1 ? path.join(roots[0], key + ext) : null;
    return { active, overridden: active !== factoryPath, overridePath, factoryPath };
  }

  // —— 热读: fs.watch 各来源目录树, 变动 debounce 100ms 清对应 key ——
  let debounceT = null;
  const pending = new Set();
  const flush = () => { for (const k of pending) cache.delete(k); pending.clear(); debounceT = null; };
  function onChange(_evt, filename) {
    if (!filename) return;
    pending.add(filename.replace(/\\/g, '/').replace(/\.(md|json)$/, ''));
    if (debounceT) clearTimeout(debounceT);
    debounceT = setTimeout(flush, 100);
  }

  const watchers = [];
  function watchDir(dir, label) {
    try {
      const w = fs.watch(dir, { recursive: true }, onChange);
      w.on('error', (e) => console.error(`[config-loader] watch error(${label}):`, e && e.message));
      // 不 unref 的话, 任何"require 一下跑完就退出"的纯 node 脚本都会挂死在结尾。
      // Electron 自有事件循环, 加了也不影响。
      if (typeof w.unref === 'function') w.unref();
      watchers.push(w);
    } catch (e) {
      console.error(`[config-loader] watch 启动失败(${label}, 非致命, 但配置不热读):`, e && e.message);
    }
  }

  for (let i = 0; i < roots.length; i++) {
    const isFactory = i === roots.length - 1;
    // 覆盖目录先建出来再监听 —— 目录不存在 fs.watch 会抛, 而且不建的话"该往哪放"要靠猜。
    // 装机版里出厂 config 在 app.asar 内, fs.watch 监听不到(只读且非真实目录),
    // 覆盖层才是热读真正生效的那一层。
    try { fs.mkdirSync(roots[i], { recursive: true }); } catch (e) {
      if (!isFactory) console.error('[config-loader] 覆盖目录不可用(退回只读出厂默认):', e && e.message);
      continue;
    }
    watchDir(roots[i], isFactory ? '出厂' : `来源${i + 1}`);
  }

  return {
    text, textL, render, renderL, fill, json, jsonOptional, whichFile,
    sources: () => roots.slice(),
    overrideRoot: () => (roots.length > 1 ? roots[0] : null),
    _clearCache: () => cache.clear(),
    _cachedKeys: () => [...cache.keys()],
  };
}

// core 自带的出厂默认配置 —— core 读的那 42 个 key 在这里都有一份能跑的默认值。
// 🔴 必须排在每条来源链的【最末位】: 产品的 config 是覆盖层, core 只兜底。
//
// 为什么要有它: 此前 core 读的默认文案散在个人版 config/ 下, 于是每加一个产品都要
// 重新回答一次"这些 key 谁提供" —— 行业版当时的答案是把 `../personal/config` 排进来源链,
// **dev 能跑而打包必炸**(personal 目录不在包里; 实测 asar 里 config/main 只有 5 个文件, 缺 13 个)。
// 一个库依赖宿主提供自己的默认值, 这笔债每加一个壳就要再还一次。
const FACTORY_CONFIG_DIR = path.join(__dirname, 'config');

module.exports = { createConfigLoader, FACTORY_CONFIG_DIR };
