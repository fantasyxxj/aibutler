// test-peer-cc-log.js — 无头验证 peer_talk 抄送日志 helpers (spec §2)
// 跑法: node test-peer-cc-log.js
// 不启 electron, 只跑纯函数 + 文件写盘.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');

// —— 复制 main.js 里的 helpers (保持逐字一致) ——
function localIsoTimestamp() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const tzMin = -d.getTimezoneOffset();
  const sign = tzMin >= 0 ? '+' : '-';
  const oh = pad(Math.floor(Math.abs(tzMin) / 60));
  const om = pad(Math.abs(tzMin) % 60);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
         `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
         `.${pad(d.getMilliseconds(), 3)}${sign}${oh}:${om}`;
}
function localDateStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const PEER_LOG_ROTATE_SIZE = 10 * 1024 * 1024;

// 测试用 base dir (临时目录, 跑完清)
const TEST_BASE = path.join(os.tmpdir(), 'butler-test-peer-cc-' + Date.now());
function peerLogDir() { return path.join(TEST_BASE, 'logs', 'peer_talk'); }

function currentPeerLogPath() {
  const dir = peerLogDir();
  fs.mkdirSync(dir, { recursive: true });
  const today = localDateStr();
  let idx = 0;
  let p = path.join(dir, `peer_talk_${today}.jsonl`);
  while (fs.existsSync(p) && fs.statSync(p).size >= PEER_LOG_ROTATE_SIZE) {
    idx++;
    p = path.join(dir, `peer_talk_${today}.${String(idx).padStart(3, '0')}.jsonl`);
  }
  return p;
}

function ccButler({ channel, from, to, message, wrapperMeta }) {
  const body = String(message == null ? '' : message);
  const hash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);
  const summary = body.length > 200 ? body.slice(0, 200) + '...' : body;
  const entry = {
    ts: localIsoTimestamp(),
    channel,
    from,
    to,
    direction: 'relay',
    msg_len: body.length,
    msg_summary: summary,
    msg_hash: hash,
    wrapper_meta: wrapperMeta || null,
  };
  fs.appendFileSync(currentPeerLogPath(), JSON.stringify(entry) + '\n');
  return entry;
}

// —— 用例 ——
let pass = 0, fail = 0;
const assert = (cond, name) => {
  if (cond) { console.log('  ✓', name); pass++; }
  else { console.log('  ✗', name); fail++; }
};

console.log('\n[1] localIsoTimestamp() 格式');
const ts = localIsoTimestamp();
console.log('  → ' + ts);
assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/.test(ts), '匹配 ISO8601 本地时区 offset');
assert(!ts.endsWith('Z'), '不以 Z 结尾 (禁用 UTC)');

console.log('\n[2] localDateStr() 格式');
const ds = localDateStr();
console.log('  → ' + ds);
assert(/^\d{4}-\d{2}-\d{2}$/.test(ds), '匹配 YYYY-MM-DD');
assert(ds === new Date().toLocaleDateString('sv-SE'), '与本地日期一致');

console.log('\n[3] ccButler 短消息 (< 200 字)');
const short = ccButler({
  channel: 'talk_peer', from: '码上飞', to: '狂人',
  message: '你好', wrapperMeta: { tag: '· 单向异步', reply_hint: 'talk_peer 回码上飞' },
});
assert(short.msg_len === 2, 'msg_len 正确 (2 字符 "你好")');
assert(short.msg_summary === '你好', '短消息不截断');
assert(short.msg_hash.length === 16, 'hash 16 位');
assert(short.direction === 'relay', 'direction relay');
assert(short.wrapper_meta.tag === '· 单向异步', 'wrapper_meta 保留');

console.log('\n[4] ccButler 长消息 (> 200 字截断)');
const longMsg = '长'.repeat(300);
const long = ccButler({ channel: 'ask_persona', from: '唐伯虎', to: '码上飞', message: longMsg });
assert(long.msg_len === 300, 'msg_len 是完整长度');
assert(long.msg_summary.endsWith('...'), '截断后加 ...');
assert(long.msg_summary.length === 203, '截断后 200 + "..." = 203');

console.log('\n[5] 相同 body hash 一致 (关联能力)');
const a = ccButler({ channel: 'talk_peer', from: 'A', to: 'B', message: 'hello' });
const b = ccButler({ channel: 'talk_peer', from: 'X', to: 'Y', message: 'hello' });
assert(a.msg_hash === b.msg_hash, '同 body 同 hash');

console.log('\n[6] JSONL 落盘 + 读回');
const logPath = currentPeerLogPath();
console.log('  logPath: ' + logPath);
assert(fs.existsSync(logPath), '日志文件存在');
const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
assert(lines.length === 4, '4 条记录 (前 4 次 ccButler 调用: short + long + a + b)');
const parsed = lines.map((l) => JSON.parse(l));
assert(parsed.every((p) => p.ts && p.channel && p.msg_hash), '每条 JSON 结构完整');

console.log('\n[7] Rotate 逻辑 (模拟单文件超限)');
// 手动灌一个 10MB+ 文件, 验证下条走 .001 分片
const bigFile = path.join(peerLogDir(), `peer_talk_${localDateStr()}.jsonl`);
fs.writeFileSync(bigFile, 'x'.repeat(11 * 1024 * 1024));
const nextPath = currentPeerLogPath();
console.log('  nextPath: ' + nextPath);
assert(nextPath.includes('.001.jsonl'), '切到 .001 分片');
assert(nextPath !== bigFile, '新路径不等于超限文件');

console.log('\n[8] 清理临时目录');
fs.rmSync(TEST_BASE, { recursive: true, force: true });
assert(!fs.existsSync(TEST_BASE), '临时目录已清理');

console.log(`\n结果: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
