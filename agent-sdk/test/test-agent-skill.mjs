// Agent 子代理与 Skill 文件技能。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { query } from '../dist/index.js';
import { Skill } from '../dist/node/index.js';
import { anthropicStep, fakeFetch, userMsg, queue, GATEWAY_ENV } from './helpers.mjs';

async function untilResult(q) {
  const got = [];
  for (;;) { const { value, done } = await q.next(); if (done) return got; got.push(value); if (value.type === 'result') return got; }
}

test('Agent: 子代理空白历史跑完, 只把最终答复交回; 子代理自己不能再起子代理; 子代理的流不转发', async () => {
  const f = fakeFetch([
    anthropicStep([{ tool: { id: 'ag', name: 'Agent', input: { description: 'look up', prompt: 'find the menu' } } }]),
    anthropicStep([{ text: 'SUB-REPORT: 3 items' }]),     // 子代理那一步
    anthropicStep([{ text: 'done: 3 items' }]),
  ]);
  const p = queue();
  const q = query({ prompt: p, options: { model: 'm', env: GATEWAY_ENV, fetch: f, systemPrompt: 'MAIN', tools: ['Agent'] } });
  p.push(userMsg('go'));
  const msgs = await untilResult(q);
  const sub = f.calls[1].body;
  assert.doesNotMatch(JSON.stringify(sub.system), /MAIN/);
  assert.match(JSON.stringify(sub.system), /sub-agent/);
  assert.ok(!(sub.tools || []).some((t) => t.name === 'Agent'), '子代理拿不到 Agent');
  assert.match(JSON.stringify(sub.messages), /find the menu/);
  assert.doesNotMatch(JSON.stringify(sub.messages), /"go"/);
  assert.match(JSON.stringify(f.calls[2].body.messages), /SUB-REPORT: 3 items/);
  assert.equal(msgs.filter((m) => m.type === 'assistant').length, 2, '宿主只看到主代理的两步');
  assert.equal(msgs.at(-1).result, 'done: 3 items');
  p.close(); await q.return();
});

test('Agent: 宿主 tools 名单里没列就不露出来', async () => {
  const f = fakeFetch([anthropicStep([{ text: 'x' }])]);
  const p = queue();
  const q = query({ prompt: p, options: { model: 'm', env: GATEWAY_ENV, fetch: f, tools: ['ToolSearch'] } });
  p.push(userMsg('a'));
  await untilResult(q);
  assert.ok(!(f.calls[0].body.tools || []).some((t) => t.name === 'Agent'));
  p.close(); await q.return();
});

test('Skill: 按 cwd/.claude/skills 现找, 描述里列出, 调用拿到 SKILL.md; options.skills 名单过滤', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sdk-skill-'));
  for (const [name, desc] of [['menu-check', 'Check the menu for typos'], ['other', 'Not allowed']]) {
    fs.mkdirSync(path.join(cwd, '.claude', 'skills', name), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.claude', 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}\nStep 1: read the menu.\n`);
  }
  const f = fakeFetch([
    anthropicStep([{ tool: { id: 'sk', name: 'Skill', input: { skill: 'menu-check', args: 'today' } } }]),
    anthropicStep([{ text: 'ok' }]),
  ]);
  const p = queue();
  const q = query({ prompt: p, options: { model: 'm', env: GATEWAY_ENV, fetch: f, cwd, builtinTools: [Skill], tools: ['Skill'], skills: ['menu-check'] } });
  p.push(userMsg('check'));
  await untilResult(q);
  const desc = f.calls[0].body.tools.find((t) => t.name === 'Skill').description;
  assert.match(desc, /menu-check: Check the menu for typos/);
  assert.doesNotMatch(desc, /other/);
  const sent = JSON.stringify(f.calls[1].body.messages);
  assert.match(sent, /Step 1: read the menu/);
  assert.match(sent, /ARGUMENTS: today/);
  p.close(); await q.return();
});

test('Skill: 一个技能都没有就不开这个工具', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sdk-noskill-'));
  const f = fakeFetch([anthropicStep([{ text: 'x' }])]);
  const p = queue();
  const q = query({ prompt: p, options: { model: 'm', env: { ...GATEWAY_ENV, HOME: cwd }, fetch: f, cwd, builtinTools: [Skill], tools: ['Skill'], skills: ['nope'] } });
  p.push(userMsg('a'));
  await untilResult(q);
  assert.ok(!(f.calls[0].body.tools || []).some((t) => t.name === 'Skill'));
  p.close(); await q.return();
});
