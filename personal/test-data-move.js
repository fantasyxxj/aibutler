// test-data-move.js — 系统设置「数据位置 → 搬到别处」(personal/data-move.js)。
// 用 BUTLER_SIMULATE_INSTALL=1 + 临时 BUTLER_DATA_DIR 造一个「打包版」: 引导位里放指针指向旧目录、放一张搬家单,
// 真跑 applyPending, 看 ① 复制到位 ② 登记簿 / 标签 / persona.md 里的旧路径换成新的 ③ 指针改了 ④ 旧目录原样留着
// ⑤ 失败时指针不动、新目录里半截的删掉 ⑥ 选目录的几条拒绝规则 ⑦ 清理旧数据: 搬成功才记、只移复制过的条目、
// 留指针和 main.log、跟搬家单互斥、旧目录没数据了记录作废。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'data-move-'));
const BOOT = path.join(ROOT, 'boot');
const OLD = path.join(ROOT, 'old data');
const NEW = path.join(ROOT, 'new', 'ButlerData');
process.env.BUTLER_SIMULATE_INSTALL = '1';
process.env.BUTLER_DATA_DIR = BOOT;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const w = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };

// 一份像样的旧数据目录
const home = path.join(OLD, 'personas', '管家');
w(path.join(OLD, 'app', 'personas.json'), JSON.stringify({ personas: [{ id: 'a', homeDir: home }] }, null, 2));
w(path.join(OLD, 'app', '.opentabs.json'), JSON.stringify({ dirs: [home] }));
w(path.join(home, '.claude', 'memory', 'persona.md'), `- My memory graph: \`${home}/.claude/memory\`\n`);
w(path.join(home, '.claude', 'memory', 'memory.v2.db'), 'db');
w(path.join(OLD, 'Cache', 'x'), 'chromium cache');
w(path.join(BOOT, 'data-location.json'), JSON.stringify({ dataDir: OLD }));
w(path.join(BOOT, 'data-move.json'), JSON.stringify({ from: OLD, to: NEW }));

const paths = require('./paths');
const dm = require('./data-move');
const { strings } = require('./i18n-datadir');
const said = [];

console.log('[启动时执行搬家单]');
{
  ok(paths.dataDir() === OLD, '搬之前指针指着旧目录');
  const r = dm.applyPending({ say: (o) => said.push(o) });
  ok(r === true, 'applyPending 报成功');
  ok(!fs.existsSync(path.join(BOOT, 'data-move.json')), '单子撕掉了(下次启动不会再搬)');
  ok(JSON.parse(fs.readFileSync(path.join(BOOT, 'data-location.json'))).dataDir === NEW, '指针改成新目录');
  ok(paths.dataDir() === NEW, 'dataDir() 当场就是新目录');
  const nhome = path.join(NEW, 'personas', '管家');
  ok(fs.readFileSync(path.join(nhome, '.claude', 'memory', 'memory.v2.db'), 'utf8') === 'db', '人格记忆库复制过去了');
  ok(JSON.parse(fs.readFileSync(path.join(NEW, 'app', 'personas.json'))).personas[0].homeDir === nhome, '登记簿 homeDir 换成新路径');
  ok(JSON.parse(fs.readFileSync(path.join(NEW, 'app', '.opentabs.json'))).dirs[0] === nhome, '开着的标签换成新路径');
  ok(fs.readFileSync(path.join(nhome, '.claude', 'memory', 'persona.md'), 'utf8').includes(nhome), 'persona.md 里的路径换成新的');
  ok(!fs.existsSync(path.join(NEW, 'Cache')), 'Chromium 缓存没跟着搬');
  ok(JSON.parse(fs.readFileSync(path.join(OLD, 'app', 'personas.json'))).personas[0].homeDir === home, '旧目录原样留着');
  ok(said.length === 1 && said[0].type === 'info' && said[0].message.includes(NEW), '告诉用户搬到了哪');
  ok(dm.pendingOld() === OLD, '记下了待清理的旧目录');
}

console.log('[单子对不上当前目录 → 不搬]');
{
  w(path.join(BOOT, 'data-move.json'), JSON.stringify({ from: OLD, to: path.join(ROOT, 'elsewhere') }));
  ok(dm.applyPending({ say: () => {} }) === undefined, '当前已是新目录, 旧单子不执行');
  ok(!fs.existsSync(path.join(ROOT, 'elsewhere')), '没有建出目录');
  ok(paths.dataDir() === NEW, '指针没动');
}

console.log('[复制失败 → 指针不动、半截删掉]');
{
  const bad = path.join(ROOT, 'bad');
  w(path.join(BOOT, 'data-move.json'), JSON.stringify({ from: NEW, to: bad }));
  const real = fs.cpSync;
  fs.cpSync = (a, b) => { fs.mkdirSync(b, { recursive: true }); fs.writeFileSync(path.join(b, 'half'), 'x'); throw new Error('ENOSPC: no space left'); };
  const s2 = [];
  const r = dm.applyPending({ say: (o) => s2.push(o) });
  fs.cpSync = real;
  ok(r === false, 'applyPending 报失败');
  ok(paths.dataDir() === NEW && JSON.parse(fs.readFileSync(path.join(BOOT, 'data-location.json'))).dataDir === NEW, '指针还指着原目录');
  ok(!fs.existsSync(bad), '半截的新目录删掉了');
  ok(s2[0] && s2[0].type === 'warning' && s2[0].detail.includes('ENOSPC'), '把出错原因告诉用户');
}

console.log('[清理旧数据]');
{
  const s = strings('zh-CN');
  ok(fs.existsSync(path.join(BOOT, 'data-move-old.json')), '复制失败那次没把记录冲掉, 旧目录记录还在');
  // 搬家单在等着执行 → 不许清
  w(path.join(BOOT, 'data-move.json'), JSON.stringify({ from: NEW, to: path.join(ROOT, 'x') }));
  (async () => {
    const r0 = await dm.cleanOld(async () => { throw new Error('不该被调'); }, s);
    ok(!r0.ok && r0.error === s.old_busy_move, '搬家单未执行 → 拒绝清理');
    fs.unlinkSync(path.join(BOOT, 'data-move.json'));
    // 有一项移不走 → 记录留着、按钮还在
    const r1 = await dm.cleanOld(async (f) => { if (f.endsWith('app')) throw new Error('EBUSY'); }, s);
    ok(!r1.ok && r1.failed.length === 1 && r1.failed[0] === path.join(OLD, 'app'), '移不走的那项报出来');
    ok(dm.pendingOld() === OLD, '没清完 → 记录还在');
    // 旧目录里混着不归数据管的: 指针 · Chromium 缓存(不是引导位, main.log 就是旧数据, 一起清)
    w(path.join(OLD, 'data-location.json'), '{}'); w(path.join(OLD, 'main.log'), 'log');
    const bootList = (w(path.join(BOOT, 'logs', 'x.log'), 'x'), dm.oldEntries(BOOT).map((f) => path.basename(f)));
    ok(!bootList.includes('logs') && !bootList.includes('data-location.json') && !bootList.includes('data-move-old.json'), `旧目录是引导位时留下指针 · 记录 · 正在写的日志(${bootList.join(',')})`);
    const trashed = [];
    const r2 = await dm.cleanOld(async (f) => { trashed.push(path.basename(f)); fs.rmSync(f, { recursive: true, force: true }); }, s);
    ok(r2.ok, '全移走 → 报成功');
    ok(trashed.sort().join(',') === 'app,main.log,personas', `只移复制过的条目(${trashed.join(',')})`);
    ok(fs.existsSync(path.join(OLD, 'data-location.json')) && fs.existsSync(path.join(OLD, 'Cache')), '指针 · 缓存留着');
    ok(!fs.existsSync(path.join(BOOT, 'data-move-old.json')) && dm.pendingOld() === null, '清完撕掉记录');
    ok(paths.dataDir() === NEW && fs.existsSync(path.join(NEW, 'app', 'personas.json')), '当前数据目录一个字没动');
    // 记录指向的目录已经没数据 / 跟当前目录重叠 → 作废
    w(path.join(BOOT, 'data-move-old.json'), JSON.stringify({ dir: NEW }));
    ok(dm.pendingOld() === null && !fs.existsSync(path.join(BOOT, 'data-move-old.json')), '记录指着当前目录 → 作废, 不会去清当前数据');
    const r3 = await dm.cleanOld(async () => { throw new Error('不该被调'); }, s);
    ok(!r3.ok && r3.error === s.old_gone, '没有待清的 → 什么都不动');
    rest();
  })();
}

function rest() {
console.log('[选目录的规则]');
{
  const s = strings('zh-CN');
  const empty = path.join(ROOT, 'empty'); fs.mkdirSync(empty);
  const r1 = dm.resolveDest(empty, NEW, s);
  ok(r1.ok && r1.dest === empty, '空文件夹 → 直接用');
  const busy = path.join(ROOT, 'busy'); w(path.join(busy, 'photo.jpg'), 'x');
  const r2 = dm.resolveDest(busy, NEW, s);
  ok(r2.ok && r2.dest === path.join(busy, 'ButlerData'), '有别的文件 → 在里面建 ButlerData');
  const full = path.join(ROOT, 'full'); w(path.join(full, 'app', 'personas.json'), '{}');   // OLD 已被上一段清掉
  ok(!dm.resolveDest(full, NEW, s).ok, '已经是一份人格数据 → 拒绝');
  ok(!dm.resolveDest(NEW, NEW, s).ok, '就是当前目录 → 拒绝');
  ok(!dm.resolveDest(path.join(NEW, 'sub'), NEW, s).ok, '在当前目录里面 → 拒绝');
  const r3 = dm.resolveDest(path.join(ROOT, 'new'), NEW, s);
  ok(!r3.ok, '包着当前目录 → 拒绝');
}

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${fail ? '❌' : '✅'} test-data-move: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
}
