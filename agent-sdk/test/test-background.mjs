// 后台子代理 · 收尾通知开新一轮 · TaskStop · Workflow(并行 / 流水线 / 结构化结果 / 续跑 / 禁用 Date.now)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../dist/index.js';
import { Workflow } from '../dist/node/index.js';
import { anthropicStep, userMsg, queue, collectUntilResults, GATEWAY_ENV } from './helpers.mjs';

const SUB = 'You are a sub-agent';
const sysText = (b) => (Array.isArray(b.system) ? b.system.map((x) => x.text).join('') : String(b.system || ''));
const flat = (c) => (typeof c === 'string' ? c : (c || []).map((x) => x.text || flat(x.content)).join('\n'));
const lastText = (b) => flat(b.messages.at(-1).content);
const allText = (b) => b.messages.map((m) => flat(m.content)).join('\n');

// 按请求内容回话的假网关: route(body, isSub) → SSE 文本 | { hang: true }
function router(route) {
  const calls = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    const isSub = sysText(body).includes(SUB);
    calls.push({ body, isSub });
    const r = await route(body, isSub);
    if (r && r.hang) return new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    return new Response(r, { headers: { 'content-type': 'text/event-stream' } });
  };
  fn.calls = calls;
  return fn;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (text) => anthropicStep([{ text }]);
const use = (id, name, input) => anthropicStep([{ tool: { id, name, input } }]);
const opts = (f) => ({ model: 'claude-opus-5-5', env: GATEWAY_ENV, fetch: f, systemPrompt: 'S', tools: ['Agent', 'Workflow', 'TaskStop'], builtinTools: [Workflow] });

test('后台子代理: 立即回任务号、这一轮先结束; 跑完发 task_notification 并自己开新一轮读到结果', async () => {
  const f = router(async (b, isSub) => {
    if (isSub) { await sleep(80); return say('SUB-REPORT-42'); }
    const t = lastText(b);
    if (t.includes('<task-notification>')) return say('收到');
    if (t.includes('Async agent launched')) return say('已派出');
    return use('ag1', 'Agent', { description: 'dig', prompt: 'dig it', run_in_background: true });
  });
  const p = queue();
  const q = query({ prompt: p, options: opts(f) });
  p.push(userMsg('go'));
  const got = await collectUntilResults(q, 2);
  const kinds = got.map((m) => (m.type === 'system' ? m.subtype : m.type));
  const firstResult = kinds.indexOf('result');
  assert.ok(firstResult < kinds.indexOf('task_notification'), '第一轮没等子代理就结束了');
  const started = got.find((m) => m.subtype === 'task_started');
  const note = got.find((m) => m.subtype === 'task_notification');
  assert.equal(started.tool_use_id, 'ag1');
  assert.equal(started.is_backgrounded, true);
  assert.equal(note.status, 'completed');
  assert.equal(note.task_id, started.task_id);
  const wake = f.calls.filter((c) => !c.isSub).at(-1).body;
  assert.ok(lastText(wake).includes('SUB-REPORT-42'), '新一轮的请求里带着子代理的报告');
  assert.ok(!got.some((m) => m.isReplay), '引擎自己投的通知不回放给宿主');
  p.close(); await q.return();
});

test('TaskStop: 叫停后台子代理, 收到 status=stopped 的通知', async () => {
  let taskId = '';
  const f = router(async (b, isSub) => {
    if (isSub) return { hang: true };
    const t = lastText(b);
    if (t.includes('<task-notification>')) return say('停了');
    if (t.includes('Stopping task')) return say('在停');
    const m = /task_id: (\S+)/.exec(t);
    if (m) { taskId = m[1]; return use('st1', 'TaskStop', { task_id: taskId }); }
    return use('ag1', 'Agent', { description: 'slow', prompt: 'forever', run_in_background: true });
  });
  const p = queue();
  const q = query({ prompt: p, options: opts(f) });
  p.push(userMsg('go'));
  const got = await collectUntilResults(q, 2);
  const note = got.find((m) => m.subtype === 'task_notification');
  assert.equal(note.task_id, taskId);
  assert.equal(note.status, 'stopped');
  p.close(); await q.return();
});

const SCRIPT = `export const meta = { name: 'wf-test', description: 'test workflow', phases: [{ title: 'Fan' }] }
phase('Fan')
const xs = await parallel(['x1', 'x2', 'x3'].map((k) => () => agent('ITEM ' + k)))
const ys = await pipeline(['p1', 'p2'], (v) => agent('STAGE1 ' + v), (v, item) => agent('STAGE2 ' + item + ' got ' + v))
const s = await agent('STRUCT', { schema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] } })
log('almost')
return { xs, ys, n: s.n }`;

function workflowRoute(subLog, mainNext) {
  let active = 0;
  return async (b, isSub) => {
    if (isSub) {
      const t = allText(b);
      subLog.push(t.split('\n')[0]);
      active++; subLog.maxActive = Math.max(subLog.maxActive || 0, active);
      await sleep(30);
      active--;
      if (t.includes('STRUCT')) return b.messages.length > 1 ? say('ok') : use('so1', 'StructuredOutput', { n: 7 });
      const item = /ITEM (\w+)/.exec(t); if (item) return say(`R-${item[1]}`);
      const s2 = /STAGE2 (\w+) got (\S+)/.exec(t); if (s2) return say(`S2-${s2[1]}-${s2[2]}`);
      const s1 = /STAGE1 (\w+)/.exec(t); if (s1) return say(`S1-${s1[1]}`);
      return say('?');
    }
    return mainNext(b);
  };
}

test('Workflow: 后台跑脚本, parallel / pipeline / schema 结果拼好后通知主代理; 再带 resumeFromRunId 重跑全部命中缓存', async () => {
  const subLog = [];
  let round = 0;
  const f = router(workflowRoute(subLog, (b) => {
    const t = lastText(b);
    if (t.includes('launched in the background')) return say('跑着了');
    if (t.includes('<task-notification>')) {
      round++;
      if (round === 1) {
        const all = allText(b);
        const runId = /runId: (wf_\w+)/.exec(all)[1];
        const scriptPath = /scriptPath: (\S+)/.exec(all)[1];
        return use('wf2', 'Workflow', { scriptPath, resumeFromRunId: runId });
      }
      return say('两次都完了');
    }
    return use('wf1', 'Workflow', { script: SCRIPT });
  }));
  const p = queue();
  const q = query({ prompt: p, options: opts(f) });
  p.push(userMsg('go'));
  const got = await collectUntilResults(q, 3);
  const notes = got.filter((m) => m.subtype === 'task_notification');
  assert.equal(notes.length, 2);
  assert.ok(notes.every((n) => n.status === 'completed'), JSON.stringify(notes));
  const wakes = f.calls.filter((c) => !c.isSub && lastText(c.body).includes('<task-notification>'));
  const first = lastText(wakes[0].body);
  assert.match(first, /"n": 7/, 'schema 结果是对象');
  for (const s of ['R-x1', 'R-x2', 'R-x3', 'S2-p1-S1-p1', 'S2-p2-S1-p2']) assert.ok(first.includes(s), `结果里有 ${s}`);
  assert.equal(subLog.length, 9, '第一次 9 次子代理请求(3 并行 + 2×2 流水线 + 结构化那个两步)');
  assert.ok(subLog.maxActive <= 4, `同时在跑的不超过 4 个(实际 ${subLog.maxActive})`);
  const second = lastText(wakes[1].body);
  assert.match(second, /8 from cache/, '续跑: 8 个 agent() 全部用上次结果');
  assert.equal(subLog.length, 9, '续跑没有再发子代理请求');
  const started = got.filter((m) => m.subtype === 'task_started');
  assert.equal(started[0].task_type, 'local_workflow');
  assert.equal(started[0].workflow_name, 'wf-test');
  assert.ok(got.some((m) => m.subtype === 'task_progress' && /almost/.test(m.summary)), 'log() 进了进度行');
  p.close(); await q.return();
});

test('Workflow: 脚本调 Date.now() 就失败, 通知里说清原因; meta 不是字面量当场拒', async () => {
  const f = router(async (b) => {
    const t = lastText(b);
    if (t.includes('<task-notification>')) return say('知道了');
    if (t.includes('launched in the background')) return say('跑着');
    if (t.includes('must begin with')) return use('wf2', 'Workflow', { script: "export const meta = { name: 'd', description: 'd' }\nreturn Date.now()" });
    return use('wf1', 'Workflow', { script: "const N = 'x'\nexport const meta = { name: N }\nreturn 1" });
  });
  const p = queue();
  const q = query({ prompt: p, options: opts(f) });
  p.push(userMsg('go'));
  const got = await collectUntilResults(q, 2);
  const firstTool = got.find((m) => m.type === 'user' && !m.isReplay);
  assert.match(JSON.stringify(firstTool.message.content), /must begin with/, '开头不是 meta 当场拒');
  const note = got.find((m) => m.subtype === 'task_notification');
  assert.equal(note.status, 'failed');
  const wake = f.calls.at(-1).body;
  assert.match(lastText(wake), /Date\.now\(\) is not available/);
  p.close(); await q.return();
});
