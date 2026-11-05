// 门禁: 跑全部 test-*.js, 每个带超时。
// 为什么要自带超时: macOS 没有 GNU 的 timeout 命令, 而这里确实有会挂死的测试
// (test-approval-form 就是一个) —— 没有超时的话一个挂死就把整轮拖住, 看起来像"跑得慢"。
// 用法: node tools/gate.js [--timeout 秒] [--only 子串] [--root 目录]
// --root 默认 personal; 行业版是 --root industry/test。
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const ROOT = path.resolve(__dirname, '..', arg('--root', 'personal'));
const TIMEOUT = Number(arg('--timeout', 60)) * 1000;
const ONLY = arg('--only', '');

const files = fs.readdirSync(ROOT)
  .filter((f) => /^test-.*\.js$/.test(f))
  .filter((f) => !ONLY || f.includes(ONLY))
  .sort();

const run = (f) => new Promise((resolve) => {
  const t0 = Date.now();
  const p = spawn(process.execPath, [f], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  const timer = setTimeout(() => { p.kill('SIGKILL'); }, TIMEOUT);
  p.on('close', (code, sig) => {
    clearTimeout(timer);
    const ms = Date.now() - t0;
    const status = sig === 'SIGKILL' ? 'TIMEOUT' : (code === 0 ? 'PASS' : 'FAIL');
    fs.writeFileSync(path.join('/tmp', `gate-${f}.log`), out);
    resolve({ f, status, ms });
  });
});

(async () => {
  const results = [];
  for (const f of files) {
    const r = await run(f);
    results.push(r);
    const mark = r.status === 'PASS' ? 'ok  ' : (r.status === 'TIMEOUT' ? '⏱   ' : 'FAIL');
    if (r.status !== 'PASS') console.log(`  ${mark} ${r.f}  (${(r.ms / 1000).toFixed(1)}s)`);
  }
  const by = (s) => results.filter((r) => r.status === s);
  console.log(`\nPASS=${by('PASS').length} FAIL=${by('FAIL').length} TIMEOUT=${by('TIMEOUT').length}  共 ${results.length}`);
  const slow = results.filter((r) => r.ms > 10000).sort((a, b) => b.ms - a.ms).slice(0, 5);
  if (slow.length) console.log('最慢:', slow.map((r) => `${r.f} ${(r.ms / 1000).toFixed(0)}s`).join(' · '));
})();
