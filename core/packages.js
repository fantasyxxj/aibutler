// packages.js — 下発物の受け入れ口。経路(手渡しのファイル / bus)を問わず**ここだけ**を通す。
//
// 設計の要は一つ: 受け入れた物は【封筒のまま】置く。中身だけ取り出して置くと、置いた後に
// ディスク上で書き換えられた時に誰も気付けない —— 検証が「一度きりの儀式」になってしまう。
// 封筒のまま残せば読む度に検証し直せて、改竄は次に読んだ瞬間に落ちる。
//
// 検証に落ちた物は【積まない】。古い版があるならそれが残る。半端に読み込んで
// 「動いてはいるが何が入っているか分からない」状態を作らない。
'use strict';

const fs = require('fs');
const path = require('path');
const signing = require('./signing');

const DIR_NAME = 'packages';

// 自分で書いた物を自分で使う為の置き場。ここだけは**署名を見ない**。
//
// 何故穴にならないか: bus から来た包みは package-inbox → install → `packages/` の一本道しかなく、
// この階には**到達する経路が無い**。ここに物を置けるのは既にこのマシンのデータ領域へ
// 書き込める者だけ —— その者は鍵束も設定も好きにできるので、署名を要求しても何も守れない。
// 守れる物と守れない物の境目をディレクトリとして目に見える形にしてある。
const LOCAL_DIR_NAME = 'packages.local';

// id / type はファイル名になる。`../` や区切り文字が混ざれば書き込み先が外へ逃げる ——
// 署名を通った包みでも、ここは形として塞いでおく(鍵を失くした日に効く最後の一枚)。
const SAFE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// 宿主版本依存。包は「最低どの版の客體が要るか」を `min_host` で名乗れる ——
// op ファイルが `ctx.fillI18n` を呼ぶのに、古い客體にはその手が無い。何も言わずに積めば
// **店主がボタンを押したその瞬間に**落ちる。装填時に撥ねれば、落ちるのは此処で済んで
// 古い版が其のまま働き続ける(既存の規矩と同じ: 検証に落ちた物は積まない)。
const VERSION_RE = /^\d+\.\d+\.\d+$/;

/* 三段の数字だけ。prerelease は見ない —— 此の仕組みの版號に一度も現れていない物の為に
   semver を引き込むと、依存が一つ増えた事の方が高く付く。 */
function cmpVersion(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1;
  }
  return 0;
}

/* hostVersion を渡さない呼び手は**一切判定しない**。個人版の呼び口は一行も変わらず、
   振る舞いも一バイト変わらない —— 此の形を選んだ理由は其れ一つ。 */
function checkHost(p, hostVersion) {
  const min = p && p.min_host;
  if (!min || !hostVersion) return null;
  if (cmpVersion(hostVersion, min) >= 0) return null;
  return `この包みは客體 ${min} 以上が要ります(此の機は ${hostVersion})`;
}

function dirOf(dataDir) { return path.join(dataDir, DIR_NAME); }
function localDirOf(dataDir) { return path.join(dataDir, LOCAL_DIR_NAME); }
function fileOf(dataDir, type, id) { return path.join(dirOf(dataDir), `${type}.${id}.json`); }

function checkPayload(p) {
  if (!p || typeof p !== 'object') return '中身が空です';
  if (!SAFE_NAME.test(String(p.type || ''))) return `type が不正です: ${p.type}`;
  if (!SAFE_NAME.test(String(p.id || ''))) return `id が不正です: ${p.id}`;
  if (!p.version) return 'version がありません';
  // 名乗るなら形も合っていないと困る: `>=1.0.3` の様な書き方を黙って通すと
  // cmpVersion が NaN を噛んで**常に通る**門になる(閉めた筈の門が開いている方が悪い)。
  if (p.min_host !== undefined && !VERSION_RE.test(String(p.min_host))) {
    return `min_host が不正です(x.y.z の三段で): ${p.min_host}`;
  }
  return null;
}

/* 受け入れる。text は包み(封筒 JSON)そのもの。 */
function install(text, { dataDir, hostVersion } = {}) {
  const r = signing.openPackage(text);
  if (!r.ok) return r;

  const bad = checkPayload(r.payload);
  if (bad) return { ok: false, code: 'bad_payload', message: bad };

  const tooOld = checkHost(r.payload, hostVersion);
  if (tooOld) return { ok: false, code: 'host_too_old', message: tooOld, min_host: r.payload.min_host };

  const { type, id, version } = r.payload;
  fs.mkdirSync(dirOf(dataDir), { recursive: true });
  fs.writeFileSync(fileOf(dataDir, type, id), text);
  return { ok: true, type, id, version, payload: r.payload };
}

/* 置いてある物を全部読む。一つ壊れていても他は生かす —— 一枚の腐りで
   全部の手順が消えると、店主は何が起きたのか永久に分からない。 */
function loadAll({ dataDir, hostVersion } = {}) {
  const dir = dirOf(dataDir);
  const accepted = [], rejected = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { names = []; }

  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
      rejected.push({ file, code: 'unreadable', message: e.message }); continue;
    }
    const r = signing.openPackage(text);
    if (!r.ok) { rejected.push({ file, code: r.code, message: r.message }); continue; }
    const bad = checkPayload(r.payload);
    if (bad) { rejected.push({ file, code: 'bad_payload', message: bad }); continue; }
    const tooOld = checkHost(r.payload, hostVersion);
    if (tooOld) {
      rejected.push({ file, code: 'host_too_old', message: tooOld, id: r.payload.id,
                      type: r.payload.type, min_host: r.payload.min_host }); continue;
    }
    accepted.push({ file, ...r.payload });
  }

  // 自作の物は封筒無しの payload そのまま。**署名済みの後に読む** ——
  // 同じ type.id がぶつかったら手元の物が勝つ。それが開発中に欲しい挙動そのもの
  // (配られた版を差し替えて試す)。
  loadLocal(localDirOf(dataDir), accepted, rejected, hostVersion);
  return { accepted, rejected };
}

/* 空でも作っておく。無ければ「自作の物はどこに置くのか」が
   ソースを読まないと分からない —— 置き場が見えていること自体が説明書。 */
function ensureLocalDir(dataDir) {
  const dir = localDirOf(dataDir);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}

/* 出厂示例。新装的机器 packages.local/ 是空的, 于是 plugin_find 只会回一句
   「这台机器一个插件都没装」—— 人格没有任何实物可参照, 用户也看不出"插件"到底长什么样。
   所以随包带一个能跑的最小示例(计数器), 首次开机播进去。

   🔴 **只在缺席时播, 绝不覆盖**: 这个目录是"自己写的东西"的地盘, 用户/人格随时会改它。
   每次开机重播等于把人家的改动静默按回出厂状态。
   删掉它也是一种表态(不想要), 所以删了不该自己长回来 —— 靠 .seeded.json 台账记住播过了。 */
const FACTORY_PLUGIN_DIR = path.join(__dirname, 'config', 'plugins');
function seedFactoryPlugins(dataDir, log = () => {}) {
  const dir = ensureLocalDir(dataDir);
  // 🔴 台账放 dataDir 根, **不能**放进 packages.local/ —— loadLocal 会把那个目录下
  // 每一个 .json 都当插件读, 台账会被当成畸形包拒收, 于是每次开机白刷一条错误日志。
  // (2026-08-25 就是这么写错的, test-factory-plugin-seed [2] 的 rejected=0 那条断言守着它。)
  const ledger = path.join(dataDir, '.plugin-seed.json');
  let seeded = {};
  try { seeded = JSON.parse(fs.readFileSync(ledger, 'utf8')) || {}; } catch (_) { seeded = {}; }
  let names = [];
  try { names = fs.readdirSync(FACTORY_PLUGIN_DIR); } catch (_) { return { seeded: [], skipped: [] }; }
  const out = { seeded: [], skipped: [] };
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    if (seeded[name]) { out.skipped.push(name); continue; }          // 播过了(哪怕此刻已被删)
    const dest = path.join(dir, name);
    if (fs.existsSync(dest)) { seeded[name] = 'existed'; out.skipped.push(name); continue; }
    try {
      fs.copyFileSync(path.join(FACTORY_PLUGIN_DIR, name), dest);
      seeded[name] = 'seeded';
      out.seeded.push(name);
    } catch (e) { log(`[pkg] 出厂示例播种失败 ${name}: ${e.message}`); }
  }
  try { fs.writeFileSync(ledger, JSON.stringify(seeded, null, 2)); } catch (_) {}
  return out;
}

/* 界面包的配色体检。**不拒包**, 只把问题跟着包带出去, 由 plugin_open 在回执里说给写它的人听。
   为什么放这儿而不是常驻提示: 写插件不是天天干的事, 挂进每轮系统提示是纯浪费
   (作者 2026-08-25:「常驻个屁啊, 又不是总做插件」)。而这里是**它写完、打开看的那一刻** ——
   要用时一定撞得到, 平时零成本。
   为什么不能只靠记忆库: 2026-08-25 实测, 库里三条写得清清楚楚(用 token / 底色文字色成对 /
   有范本可拷), 人格自己写插件时一条都没用上, 照样写了 `border:1px solid #ddd`。
   沙箱是深色底(--bg:#1e1e28)且已注入整套 token, 自编颜色的结果就是白底白字 —— 不报错, 只有肉眼看得见。 */
const TOKEN_HEX = /^#(1e1e28|262633|2c2c3c|15151d|34344a|e6e6ef|8a8aa5|3b5bdb|4a6bff|f0b000|4ade80|f87171)$/i;
function lintPluginCss(css) {
  const out = [];
  const s = String(css || '');
  if (!s) return out;
  const hard = (s.match(/#[0-9a-fA-F]{3,8}\b/g) || []).filter((c) => !TOKEN_HEX.test(c));
  if (hard.length) {
    out.push(`自己编了颜色(${[...new Set(hard)].slice(0, 6).join(' ')}) —— 沙箱是深色底且已注入整套 token,`
      + ` 改成 var(--text) / var(--panel) / var(--line) / var(--brand) / var(--muted) / var(--danger)。`);
  }
  const unpaired = [];
  for (const m of s.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const sel = m[1].trim(); const body = m[2];
    if (!/(^|;|\s)background\s*:/.test(body)) continue;
    if (/(^|;|\s)color\s*:/.test(body)) continue;
    if (/:hover|:active|:focus/.test(sel)) continue;
    unpaired.push(sel);
  }
  if (unpaired.length) {
    out.push(`这些规则设了背景色却没设文字色(${unpaired.slice(0, 4).join(' / ')}) ——`
      + ` 另一半会继承一个你看不见也控制不了的值, 十有八九是"看不清"。两个一起给。`);
  }
  return out;
}

function loadLocal(dir, accepted, rejected, hostVersion) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return; }
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    let payload;
    try { payload = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
      rejected.push({ file, local: true, code: 'malformed', message: e.message }); continue;
    }
    const bad = checkPayload(payload);
    if (bad) { rejected.push({ file, local: true, code: 'bad_payload', message: bad }); continue; }
    // 署名は見ない地盤だが版は見る。見逃すと「門が効くか手元で試せない」が付いて来る。
    const tooOld = checkHost(payload, hostVersion);
    if (tooOld) {
      rejected.push({ file, local: true, code: 'host_too_old', message: tooOld,
                      id: payload.id, type: payload.type, min_host: payload.min_host }); continue;
    }
    // 第三档: 装得上但配色有毛病。不拒收(它确实能跑), 但要在**刚写完这一刻**说出来。
    // 为什么非在这儿不可: 记忆库里那三条规矩写得清清楚楚, 实测两次(08-25 / 08-27)人格自己写
    // 插件时一条都没用上 —— 它是从常驻那行「插件地盘」知道自己能写的, 拿到路径就动手了,
    // 没有任何理由先去查记忆。规矩放对了位置也没用, 得在它动手之后立刻撞它一下。
    accepted.push({ file, local: true, ...payload, lint: lintPluginCss(payload.css) });
  }
}

function remove(type, id, { dataDir }) {
  try { fs.unlinkSync(fileOf(dataDir, type, id)); return true; } catch (_) { return false; }
}

module.exports = { DIR_NAME, LOCAL_DIR_NAME, dirOf, localDirOf, ensureLocalDir, fileOf, install, loadAll, remove, SAFE_NAME,
                   FACTORY_PLUGIN_DIR, seedFactoryPlugins, lintPluginCss,
                   cmpVersion, checkHost, VERSION_RE };
