// 对齐 Claude Code 的后台工具: 后台 Bash 跑完通知 · Monitor 每行叫醒 · SendMessage 续聊子代理 · 嵌套 workflow() · isolation worktree
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { query } from '../dist/index.js';
import { Workflow, Bash, Monitor } from '../dist/node/index.js';
import { anthropicStep, userMsg, queue, collectUntilResults, GATEWAY_ENV } from './helpers.mjs';

const SUB = 'You are a sub-agent';
const sysText = (b) => (Array.isArray(b.system) ? b.system.map((x) => x.text).join('') : String(b.system || ''));
const flat = (c) => (typeof c === 'string' ? c : (c || []).map((x) => x.text || flat(x.content)).join('\n'));
const lastText = (b) => flat(b.messages.at(-1).content);
const allText = (b) => b.messages.map((m) => flat(m.content)).join('\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (text) => anthropicStep([{ text }]);
const use = (id, name, input) => anthropicStep([{ tool: { id, name, input } }]);

function router(route) {
  const calls = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    const isSub = sysText(body).includes(SUB);
    calls.push({ body, isSub });
    return new Response(await route(body, isSub), { headers: { 'content-type': 'text/event-stream' } });
  };
  fn.calls = calls;
  return fn;
}
const opts = (f, extra = {}) => ({ model: 'claude-opus-5-5', env: GATEWAY_ENV, fetch: f, systemPrompt: 'S',
  tools: ['Agent', 'Workflow', 'TaskStop', 'SendMessage', 'Bash', 'Monitor'], builtinTools: [Workflow, Bash, Monitor], ...extra });

test('后台 Bash: 立即回任务号, 命令退出后通知带退出码和输出尾巴, 开新一轮', async () => {
  const f = router(async (b) => {
    const t = lastText(b);
    if (t.includes('<task-notification>')) return say('看到了');
    if (t.includes('running in background')) return say('等着');
    return use('b1', 'Bash', { command: 'sleep 0.2; echo BG-DONE-77; exit 3', run_in_background: true, description: 'bg' });
  });
  const p = queue();
  const q = query({ prompt: p, options: opts(f) });
  p.push(userMsg('go'));
  const got = await collectUntilResults(q, 2);
  const started = got.find((m) => m.subtype === 'task_started');
  assert.equal(started.task_type, 'local_bash');
  const note = got.find((m) => m.subtype === 'task_notification');
  assert.equal(note.status, 'failed', '退出码非 0 记失败');
  assert.ok(note.output_file.endsWith('.log'));
  const wake = lastText(f.calls.at(-1).body);
  assert.match(wake, /Exit code 3/);
  assert.match(wake, /BG-DONE-77/);
  p.close(); await q.return();
});

test('Monitor: 每行输出投一条事件开新一轮, 命令退出再收尾通知', async () => {
  const f = router(async (b) => {
    const t = lastText(b);
    if (t.includes('<task-notification>')) return say('ok');
    if (t.includes('Monitor started')) return say('盯着');
    return use('m1', 'Monitor', { description: 'watch', timeout_ms: 10000, command: 'echo EV-ONE; sleep 0.6; echo EV-TWO' });
  });
  const p = queue();
  const q = query({ prompt: p, options: opts(f) });
  p.push(userMsg('go'));
  const got = await collectUntilResults(q, 3);
  const wakes = f.calls.map((c) => lastText(c.body)).filter((t) => t.includes('<task-notification>'));
  const all = wakes.join('\n');
  assert.match(all, /<status>event<\/status>[\s\S]*EV-ONE/);
  assert.match(all, /EV-TWO/);
  assert.ok(got.find((m) => m.subtype === 'task_started').task_type === 'monitor');
  // 收尾通知可能和最后一个事件同进一轮, 等它到
  for (let i = 0; i < 40 && !got.some((m) => m.subtype === 'task_notification'); i++) {
    const n = await q.next(); if (n.done) break; got.push(n.value);
  }
  assert.equal(got.find((m) => m.subtype === 'task_notification').status, 'completed');
  p.close(); await q.return();
});

test('SendMessage: 子代理跑完带 agentId; 按 name 续聊, 带着原来的上下文后台再跑一轮并通知', async () => {
  const subBodies = [];
  const f = router(async (b, isSub) => {
    if (isSub) { subBodies.push(allText(b)); return say(allText(b).includes('SECOND') ? 'REPLY-2' : 'REPLY-1'); }
    const t = lastText(b);
    if (t.includes('<task-notification>')) return say('续上了');
    if (t.includes('resumed in the background')) return say('等它');
    if (t.includes('REPLY-1')) {
      assert.match(t, /agentId: ag\w+ \(name: helper\)/);
      return use('sm1', 'SendMessage', { to: 'helper', message: 'SECOND ask' });
    }
    return use('ag1', 'Agent', { description: 'first', prompt: 'FIRST ask', name: 'helper', run_in_background: false });
  });
  const p = queue();
  const q = query({ prompt: p, options: opts(f) });
  p.push(userMsg('go'));
  await collectUntilResults(q, 2);
  assert.equal(subBodies.length, 2);
  assert.ok(subBodies[1].includes('FIRST ask') && subBodies[1].includes('REPLY-1'), '第二轮带着第一轮的上下文');
  assert.match(lastText(f.calls.at(-1).body), /REPLY-2/);
  p.close(); await q.return();
});

test('SendMessage: 找不到的名字当场报错', async () => {
  const f = router(async (b) => (lastText(b).includes('no agent named') ? say('没有') : use('sm1', 'SendMessage', { to: 'ghost', message: 'hi' })));
  const p = queue();
  const q = query({ prompt: p, options: opts(f) });
  p.push(userMsg('go'));
  await collectUntilResults(q, 1);
  assert.match(lastText(f.calls.at(-1).body), /no agent named or with id "ghost"/);
  p.close(); await q.return();
});

test('Workflow: 脚本里 workflow() 嵌套跑内联子工作流和 .claude/workflows 里的命名工作流', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-nest-'));
  fs.mkdirSync(path.join(cwd, '.claude', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.claude', 'workflows', 'named.js'), "export const meta = { name: 'named', description: 'n' }\nreturn await agent('NAMED ' + args.k)");
  const inner = "export const meta = { name: 'inner', description: 'i' }\nreturn await agent('INNER ' + args)";
  const script = `export const meta = { name: 'outer', description: 'o' }\nconst a = await workflow(${JSON.stringify(inner)}, 'z')\nconst b = await workflow('named', { k: 'q' })\nreturn a + '|' + b`;
  const f = router(async (b, isSub) => {
    if (isSub) { const t = allText(b); return say(t.includes('INNER z') ? 'IN-OK' : t.includes('NAMED q') ? 'NM-OK' : '?'); }
    const t = lastText(b);
    if (t.includes('<task-notification>')) return say('完');
    if (t.includes('launched in the background')) return say('跑');
    return use('w1', 'Workflow', { script });
  });
  const p = queue();
  const q = query({ prompt: p, options: opts(f, { cwd }) });
  p.push(userMsg('go'));
  const got = await collectUntilResults(q, 2);
  assert.equal(got.find((m) => m.subtype === 'task_notification').status, 'completed', lastText(f.calls.at(-1).body));
  assert.match(lastText(f.calls.at(-1).body), /IN-OK\|NM-OK/);
  p.close(); await q.return();
});

test('Agent isolation worktree: 子代理在临时 worktree 里干活; 没改动就删掉 worktree 和分支', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-repo-'));
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q'); git('-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '--allow-empty', '-qm', 'init');
  let wtPath = '';
  const f = router(async (b, isSub) => {
    if (isSub) { wtPath = /isolated git worktree at (\S+)/.exec(allText(b))[1]; return say('nothing to do'); }
    return lastText(b).includes('nothing to do') ? say('好') : use('ag1', 'Agent', { description: 'iso', prompt: 'look', isolation: 'worktree', run_in_background: false });
  });
  const p = queue();
  const q = query({ prompt: p, options: opts(f, { cwd: repo }) });
  p.push(userMsg('go'));
  await collectUntilResults(q, 1);
  assert.ok(wtPath && !wtPath.startsWith(repo), '子代理拿到的是另一份目录');
  assert.match(lastText(f.calls.at(-1).body), /no changes; its worktree was removed/);
  assert.ok(!fs.existsSync(wtPath), 'worktree 已删');
  assert.ok(!git('branch', '--list', 'agent/*'), '分支已删');
  p.close(); await q.return();
});
