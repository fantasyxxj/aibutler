// 桌面内置工具 + 「核心层不碰 Node API」这条边界。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Read, Write, Edit, Glob, Grep, Bash } from '../dist/node/index.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sdk-tools-'));
const ctx = { cwd: dir, signal: new AbortController().signal, env: process.env };
const text = (o) => o.content.map((c) => c.text).join('\n');

test('Write → Read: cat -n 格式, offset/limit', async () => {
  const p = path.join(dir, 'sub', 'a.txt');
  const w = await Write.run({ file_path: p, content: 'one\n二\nthree\n' }, ctx);
  assert.match(text(w), /File created successfully/);
  const r = await Read.run({ file_path: p }, ctx);
  assert.match(text(r), /^\s+1\tone\n\s+2\t二\n\s+3\tthree$/);
  const r2 = await Read.run({ file_path: p, offset: 2, limit: 1 }, ctx);
  assert.match(text(r2), /^\s+2\t二/);
  assert.match(text(r2), /1 more lines/);
  const miss = await Read.run({ file_path: path.join(dir, 'nope') }, ctx);
  assert.equal(miss.isError, true);
});

test('Edit: 唯一匹配才改, 多处要 replace_all, 找不到报错', async () => {
  const p = path.join(dir, 'e.txt');
  fs.writeFileSync(p, 'x=1\ny=1\n');
  assert.equal((await Edit.run({ file_path: p, old_string: '=1', new_string: '=2' }, ctx)).isError, true);
  await Edit.run({ file_path: p, old_string: '=1', new_string: '=2', replace_all: true }, ctx);
  assert.equal(fs.readFileSync(p, 'utf8'), 'x=2\ny=2\n');
  await Edit.run({ file_path: p, old_string: 'x=2', new_string: 'x=$&' }, ctx);
  assert.equal(fs.readFileSync(p, 'utf8'), 'x=$&\ny=2\n');   // $& 不被当成替换模式
  assert.equal((await Edit.run({ file_path: p, old_string: 'zzz', new_string: 'q' }, ctx)).isError, true);
});

test('Glob / Grep', async () => {
  fs.mkdirSync(path.join(dir, 'g', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'g', 'a.js'), 'const 店 = 1;\n');
  fs.writeFileSync(path.join(dir, 'g', 'deep', 'b.js'), 'let x;\nconst y = 2;\n');
  fs.writeFileSync(path.join(dir, 'g', 'c.md'), 'const not js\n');
  const g = text(await Glob.run({ pattern: '**/*.js', path: path.join(dir, 'g') }, ctx));
  assert.match(g, /a\.js/); assert.match(g, /b\.js/); assert.doesNotMatch(g, /c\.md/);
  const top = text(await Glob.run({ pattern: '*.js', path: path.join(dir, 'g') }, ctx));
  assert.doesNotMatch(top, /b\.js/);
  const files = text(await Grep.run({ pattern: 'const', path: path.join(dir, 'g'), glob: '*.js' }, ctx));
  assert.match(files, /Found 2 files/);
  const content = text(await Grep.run({ pattern: 'const y', path: path.join(dir, 'g'), output_mode: 'content', '-B': 1 }, ctx));
  assert.match(content, /b\.js-1-let x;/);
  assert.match(content, /b\.js:2:const y = 2;/);
});

test('Bash: 输出、退出码、超时', async () => {
  const r = await Bash.run({ command: 'echo hi && echo err 1>&2' }, ctx);
  assert.match(text(r), /hi/); assert.match(text(r), /err/);
  const bad = await Bash.run({ command: 'exit 3' }, ctx);
  assert.equal(bad.isError, true); assert.match(text(bad), /Exit code 3/);
  const slow = await Bash.run({ command: 'sleep 5', timeout: 300 }, ctx);
  assert.match(text(slow), /timed out/);
  const pwd = await Bash.run({ command: 'pwd' }, ctx);
  assert.equal(fs.realpathSync(text(pwd).trim()), fs.realpathSync(dir));
});

test('核心层(dist 下除 node/ 以外)不 import 任何 node: 模块', () => {
  const root = new URL('../dist/', import.meta.url).pathname;
  const bad = [];
  const scan = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node') scan(p); continue; }
      if (!p.endsWith('.js')) continue;
      const src = fs.readFileSync(p, 'utf8');
      if (/from ['"]node:|require\(['"]node:|from ['"](fs|path|child_process|os)['"]/.test(src)) bad.push(path.relative(root, p));
    }
  };
  scan(root);
  assert.deepEqual(bad, []);
});

test('Bash: 孙进程攥着管道也能收尾; 打断时整组杀掉', async () => {
  const t0 = Date.now();
  const r = await Bash.run({ command: 'sleep 30 & echo started' }, ctx);
  assert.match(text(r), /started/);
  assert.ok(Date.now() - t0 < 3000, `应在几秒内返回, 实际 ${Date.now() - t0}ms`);
  const ac = new AbortController();
  const t1 = Date.now();
  const p = Bash.run({ command: 'bash -c "sleep 30; echo never"' }, { ...ctx, signal: ac.signal });
  setTimeout(() => ac.abort(), 200);
  const r2 = await p;
  assert.match(text(r2), /interrupted/);
  assert.ok(Date.now() - t1 < 5000, `打断后应在几秒内返回, 实际 ${Date.now() - t1}ms`);
});
