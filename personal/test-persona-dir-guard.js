// test-persona-dir-guard.js — 人格目录的两道闸: 安装根拒绝 · 已住人则接管。
//
// 为什么要有这道门禁: 2026-09-22 作者那台 win 把数据目录设成了安装目录, 覆盖安装后人格全没。
// 补闸时先只补在"数据目录"上, 他当场指出**用户全程只意识到自己选过两个目录**: NSIS 的安装目录,
// 和空状态屏那个「人格资料放在」—— 数据目录那个框他毫无印象。所以闸必须也长在人格目录这条路上。
//
// dev 模式下 `paths.installRoot()` 恒为 null(没有"安装根"这回事), 真机流程验不了这一段,
// 只能注入一个假的 paths。接管那一段是真跑的: 造一个已住人的目录, 看它有没有被当成新生儿。

const fs = require('fs');
const os = require('os');
const path = require('path');
const fp = require('./first-persona');
const corePersona = require('../core/persona');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

const INSTALL = path.join(os.tmpdir(), 'fake-install-root');
const fakePaths = { isUnderInstallRoot: (p) => p === INSTALL || String(p).startsWith(INSTALL + path.sep) };
const emptyPersona = { resolveMemoryDir: () => path.join(os.tmpdir(), 'no-such-dir-' + Date.now()) };

console.log('[安装根拒绝]');
{
  const r = fp.rejectInstallRoot(path.join(INSTALL, 'personas', 'x'), fakePaths, 'zh-CN');
  ok(r && r.ok === false, '安装根里的目录 → 拒绝');
  ok(r && /安装目录/.test(r.error), '给的是人话不是堆栈');
  ok(fp.rejectInstallRoot(path.join(os.tmpdir(), 'safe-place'), fakePaths, 'zh-CN') === null, '安装根外 → 放行(null)');
  const ja = fp.rejectInstallRoot(path.join(INSTALL, 'x'), fakePaths, 'ja');
  ok(ja && /インストール/.test(ja.error), '四语取词通到 i18n-datadir');
}

console.log('[beforeCreate · 闸排在建目录之前]');
{
  const target = path.join(INSTALL, 'personas', 'should-not-exist');
  const r = fp.beforeCreate({ homeDir: target, registry: null, persona: emptyPersona, paths: fakePaths, locale: 'zh-CN' });
  ok(r && r.ok === false, '返回拒绝');
  // 🔴 这条最要紧: mkdirSync 一旦排在闸前面, 就会在安装目录里留下一个空人格目录
  ok(!fs.existsSync(target), '目录没有被建出来');
}

console.log('[probeDir · 界面拿它当场给说法]');
{
  const un = fp.probeDir(path.join(INSTALL, 'x'), fakePaths, emptyPersona, 'zh-CN');
  ok(un.unsafe === true && un.inhabited === false, '安装根 → unsafe');
  ok(/安装目录/.test(un.note), 'note 可直接显示');
  const plain = fp.probeDir(path.join(os.tmpdir(), 'plain-' + Date.now()), fakePaths, emptyPersona, 'zh-CN');
  ok(plain.unsafe === false && plain.inhabited === false && plain.note === '', '干净目录 → 两个 false, 不说废话');
}

console.log('[接管 · 已经住着人格的目录]');
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'takeover-'));
  const mem = path.join(home, '.claude', 'memory');
  fs.mkdirSync(mem, { recursive: true });
  const MARK = '# 我是 老管家原件\n这一行不该被出生礼物覆盖。\n';
  fs.writeFileSync(path.join(mem, 'persona.md'), MARK, 'utf8');
  fs.writeFileSync(path.join(mem, 'MEMORY.md'), MARK, 'utf8');

  ok(fp.looksInhabited(corePersona.resolveMemoryDir(home)) === true, '认得出这个目录住着人');
  ok(fp.probeDir(home, fakePaths, corePersona, 'zh-CN').inhabited === true, 'probeDir 也认得出');

  // 假登记簿: 只要 ensureEntry / upsert 两个方法
  const store = [];
  const registry = {
    ensureEntry(dir, opts = {}) {
      const hit = store.find((e) => e.homeDir === dir);
      if (hit) return hit;
      const e = { id: opts.name || path.basename(dir), name: opts.name || path.basename(dir), homeDir: dir, isButler: !!opts.isButler };
      store.push(e); return e;
    },
    upsert(e) {
      const i = store.findIndex((x) => x.homeDir === e.homeDir);
      if (i >= 0) store[i] = e; else store.push(e);
      return e;
    },
  };
  let opened = null;
  const open = (d) => { opened = d; return { sid: 'sid-1' }; };

  const r = fp.beforeCreate({
    homeDir: home, spec: { name: '管家', isButler: true, model: 'm1', accessMode: 'subscription' },
    registry, persona: corePersona, paths: fakePaths, locale: 'zh-CN', open,
  });
  ok(r && r.ok === true && r.takenOver === true, '走的是接管这条路, 不是新建');
  ok(opened === home, '把这个目录开起来了');
  ok(fs.readFileSync(path.join(mem, 'persona.md'), 'utf8') === MARK, '🔴 persona.md 原样, 没被出生礼物覆盖');
  ok(fs.readFileSync(path.join(mem, 'MEMORY.md'), 'utf8') === MARK, '🔴 MEMORY.md 原样');
  ok(r.name === '管家' && store[0].isButler === true, '创建屏填的名字与"是管家"落进了新条目(不给就只剩目录名)');
  ok(store[0].model === 'm1' && store[0].accessMode === 'subscription', '接入方式与模型补上了');

  // 再接管一次: 已有条目一个字都不许改
  store[0].name = '它自己改过的名字'; store[0].model = 'm-own';
  const r2 = fp.beforeCreate({
    homeDir: home, spec: { name: '管家', isButler: true, model: 'm2' },
    registry, persona: corePersona, paths: fakePaths, locale: 'zh-CN', open,
  });
  ok(r2.name === '它自己改过的名字' && store[0].model === 'm-own', '已有条目不被创建屏的值覆盖');

  fs.rmSync(home, { recursive: true, force: true });
}

// 🔴 main.js 只留了一个薄壳 `firstPersona.create(...)`, 导出漏一个名字它就在点下"创建"的那一刻
// 才炸(2026-09-23 真机撞到: `firstPersona.create is not a function`)。所以这里逐个点名。
console.log('[对外的名字都在]');
for (const k of ['planStartup', 'birth', 'create', 'looksInhabited', 'takeOver', 'beforeCreate', 'rejectInstallRoot', 'probeDir']) {
  ok(typeof fp[k] === 'function', `导出了 ${k}`);
}

console.log('[空目录 · 照常走新建]');
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-'));
  const r = fp.beforeCreate({ homeDir: home, registry: null, persona: corePersona, paths: fakePaths, locale: 'zh-CN' });
  ok(r === null, '返回 null = 调用方照常往下建');
  ok(fs.existsSync(home), '目录建好了(建目录这一步也在 beforeCreate 里)');
  fs.rmSync(home, { recursive: true, force: true });
}

console.log(fail ? `\n❌ test-persona-dir-guard: ${pass} 过 / ${fail} 败` : `\n✅ test-persona-dir-guard: ${pass} 过 / 0 败`);
process.exit(fail ? 1 : 0);
