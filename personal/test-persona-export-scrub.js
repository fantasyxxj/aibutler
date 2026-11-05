// test-persona-export-scrub.js — 导出人格时凭据必须剥干净.
// 由来(2026-08-25 作者问「导出/导入人格这些功能都没动过吧」): 一查, persona-transfer.js 的
// scrub 今天刚被改成**递归**剥离(原先只剥一层, 而 plugins.buses 是张表, 每条自带 token —— 只看
// 最外层的话每条的 token 会原样进包), 而整条导出路径**零测试**。安全边界 + 刚改过 + 没门禁。
//
// 🔴 判据取【最终包的字节里搜不搜得到凭据原文】, 不是 scrub() 的返回值:
//    只测函数返回值的话, "剥干净了但又从 header 别处漏出去" 这类错照样漏网。
require('./host-wiring');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const T = require('./persona-transfer');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); } };

// 每个哨兵值都独一无二, 在包里搜到任何一个都算泄漏。
const S = {
  topToken: 'SENTINEL_TOP_TOKEN_a1b2c3',
  nestedSecret: 'SENTINEL_NESTED_SECRET_d4e5f6',
  arrToken0: 'SENTINEL_ARR0_TOKEN_g7h8i9',
  arrToken1: 'SENTINEL_ARR1_TOKEN_j1k2l3',
  deepPassword: 'SENTINEL_DEEP_PASSWORD_m4n5o6',
  apiKey: 'SENTINEL_API_KEY_p7q8r9',
  credential: 'SENTINEL_CREDENTIAL_s1t2u3',
};

const entry = {
  name: '测试人格', avatar: '', model: 'x',
  plugins: {
    tg: { enabled: true, token: S.topToken, chatId: '123' },
    bothub: { enabled: true, conf: { secret: S.nestedSecret, url: 'https://example.com' } },
    // 🔴 这张表是本次改动的直接动因: 数组里每一条都自带凭据
    line: {
      buses: [
        { name: 'a', token: S.arrToken0, base: 'https://a' },
        { name: 'b', token: S.arrToken1, deep: { password: S.deepPassword } },
      ],
      apiKey: S.apiKey,
    },
    other: { credential: S.credential, keepMe: 'PLAIN_VALUE_should_survive' },
  },
};

const mkHome = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-export-'));
  fs.writeFileSync(path.join(d, 'persona.md'), '我是测试人格');
  return d;
};

console.log('[1] stripCredentials: 每一层、包括数组元素里的凭据都要被剥掉');
{
  const { persona, stripped } = T.stripCredentials(entry);
  const dump = JSON.stringify(persona);
  for (const [k, v] of Object.entries(S)) {
    ok(!dump.includes(v), `剥掉了 ${k}`);
  }
  ok(dump.includes('PLAIN_VALUE_should_survive'), '非凭据字段原样保留(不是把整块删了了事)');
  ok(stripped.length >= Object.keys(S).length,
     `剥掉的项都记了账(${stripped.length} 条) —— 导入端要靠它告诉用户哪些得重配`);
  ok(stripped.some((s) => /\[\d\]/.test(s)), '账目里带数组下标, 定位得到是哪一条');
}

console.log('\n[2] 🔴 端到端: 最终包的【字节】里搜不到任何凭据原文');
{
  const home = mkHome();
  const buf = T.packPersona(home, entry, { butlerVersion: '0.1.17-test' });
  // 包是 gzip 的, 必须解开再搜 —— 直接搜压缩字节等于没搜。
  const raw = zlib.gunzipSync(buf).toString('binary');
  for (const [k, v] of Object.entries(S)) {
    ok(!raw.includes(v), `包里搜不到 ${k}`);
  }
  const pkg = T.readPackage(buf);
  ok(!!pkg && !!pkg.header, '包能被正常解析(剥凭据没把包搞坏)');
  ok(Array.isArray(pkg.header.strippedCredentials) && pkg.header.strippedCredentials.length > 0,
     'header 里带着"哪些被剥了"的清单');
  fs.rmSync(home, { recursive: true, force: true });
}

console.log('\n[3] 源码守卫: 按字段名判, 不许退回白名单');
{
  const src = fs.readFileSync(path.join(__dirname, 'persona-transfer.js'), 'utf8');
  ok(/token\|secret\|key\|password\|credential/i.test(src),
     '仍按字段名正则判 —— 白名单式(只剥列出来的)会在新插件加字段时静默漏');
  ok(/Array\.isArray\(v\)/.test(src.slice(src.indexOf('function scrub'), src.indexOf('function stripCredentials'))),
     'scrub 会走进数组 —— plugins.buses 那种表每条都带凭据');
}

console.log(`\n${fail ? '❌' : '✅'} test-persona-export-scrub: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
