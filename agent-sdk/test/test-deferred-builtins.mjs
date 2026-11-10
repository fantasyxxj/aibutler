// 冷门内置工具(Workflow/Monitor/TaskStop/SendMessage)走 ToolSearch 按需加载, 常用的照旧常驻。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../dist/tools/registry.js';
import { Agent, TaskStop, SendMessage } from '../dist/tools/agent.js';
import { Read, Workflow, Monitor } from '../dist/node/index.js';

const all = [Read, Agent, Workflow, Monitor, TaskStop, SendMessage];
const cold = ['Workflow', 'Monitor', 'TaskStop', 'SendMessage'];

test('开了 ToolSearch: 冷门内置工具只报名字, select 之后才带 schema', () => {
  const r = new ToolRegistry({ tools: ['ToolSearch', 'Read', 'Agent', ...cold] }, all, []);
  const sent = Object.keys(r.toolSet());
  for (const n of ['ToolSearch', 'Read', 'Agent']) assert.ok(sent.includes(n), n);
  for (const n of cold) assert.ok(!sent.includes(n), n);
  assert.deepEqual(r.deferredNames().sort(), [...cold].sort());
  assert.match(r.deferredNotice(), /Workflow/);
  r.search('select:Workflow', 5);
  assert.ok(Object.keys(r.toolSet()).includes('Workflow'));
});

test('没开 ToolSearch: 冷门内置工具照常全量发', () => {
  const r = new ToolRegistry({ tools: ['Read', ...cold] }, all, []);
  const sent = Object.keys(r.toolSet());
  for (const n of cold) assert.ok(sent.includes(n), n);
  assert.equal(r.deferredNotice(), '');
});
