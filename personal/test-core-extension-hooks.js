require('./host-wiring');   // 个人版宿主接线: 直接 require core 模块的进程都得先接
// core 的版本扩展面 —— 行业版靠这几个钩子挂自己那半边, 不改 core 一个字。
//
// 这条测试守的是"接口还在不在", 不是"行业版功能对不对"。它存在的理由很直接:
// 行业版的子类在【另一个仓】, core 这边改坏了钩子, 门禁一声不吭, 要等行业版打包才炸。
// 有了它, 谁把调用点删了、把 slot 名改了、把 buildAllowedTools 又内联回去, 当场判红。
const assert = require('assert');
const { Butler } = require('../core/agent');
const { BusRegistry } = require('../core/bus');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); console.log('  ✓', name); pass++; }
  catch (e) { console.log('  ✗', name, '—', e.message); fail++; }
};

// 不起真会话: 拿原型造一个壳, 只填被测方法用得到的字段。
// (真 new 一个 Butler 要连 SDK 与记忆库, 那些跟"钩子还在不在"无关。)
function stub(extra = {}) {
  const b = Object.create(Butler.prototype);
  Object.assign(b, {
    name: '测试人格', homeDir: '/tmp/x', memoryDir: '/tmp/x/.claude/memory',
    model: 'claude-x', tgBotToken: null, buses: new BusRegistry([]),
    isButler: false, overlayPacks: [], overlayConn: null, voiceOn: false,
    usage: () => ({ window: 1000000, pct: 0, inTok: 0 }),
    _voiceSystemPromptBlock: () => [],
  }, extra);
  return b;
}

console.log('\n[1] 六个钩子的默认实现(个人版: 全空, 行为一个字不变)');
ok('默认 _extraSystemBlocks / _extraAllowedTools / _extraMcpServers / _extraWakeParts / _droppedCoreTools 都是空', () => {
  const b = stub();
  assert.deepStrictEqual(b._extraSystemBlocks('atEnd'), []);
  assert.deepStrictEqual(b._extraAllowedTools(), []);
  assert.deepStrictEqual(b._extraMcpServers(), {});
  assert.deepStrictEqual(b._extraWakeParts('atEnd'), []);
  assert.deepStrictEqual(b._droppedCoreTools(), []);
});

// 个人版接在 claude_code 预设后面(那份预设讲写代码/git/PR, 对开发帮手成立), 行业版整份替换。
// 传纯字符串 = 预设一个字都不进(sdk.d.ts:2094)。这条守的是**两版走的是不同分支**:
// 谁把 stream.js 的调用点写回硬编码 preset, 行业版就会不声不响地每轮多付约 8950 字符。
console.log('\n[1a] _systemPromptOption: 个人版带预设, 宿主可整份替换');
ok('默认带 claude_code 预设, 身份指令走 append', () => {
  const b = stub({ appendSystemPrompt: () => '我是测试人格' });
  const o = b._systemPromptOption();
  assert.strictEqual(o.preset, 'claude_code');
  assert.strictEqual(o.append, '我是测试人格');
});
ok('宿主覆盖成纯字符串时, 调用点原样交给 SDK(不再包 preset)', () => {
  const b = stub({ appendSystemPrompt: () => '我是店小二', _systemPromptOption() { return this.appendSystemPrompt(); } });
  assert.strictEqual(b._systemPromptOption(), '我是店小二');
});
// 内置工具的 schema 每轮都随请求发出去 —— allowedTools 摘掉不等于不发(行业版实测: Bash 早就
// 不在白名单里, schema 却照发, 而 fs_boundary.md 还写着"这台机器上没有 Bash")。真要不发得走 tools。
ok('_toolsOption 默认读 config 名单(个人版也不再吃 CLI 全量), 宿主可覆盖', () => {
  const d = stub()._toolsOption();
  assert.ok(Array.isArray(d), '默认应是 config/main/builtin_tools 那份名单');
  for (const t of ['ToolSearch', 'Read', 'Bash', 'Agent', 'Skill']) {
    assert.ok(d.includes(t), `名单里少了在用的 ${t}`);
  }
  assert.ok(!d.includes('Workflow'), '用不上的内置工具不该留在名单里(schema 每轮照发)');
  const b = stub({ _toolsOption: () => ['Read'] });
  assert.deepStrictEqual(b._toolsOption(), ['Read']);
});
ok('stream.js 的调用点走钩子, 没把 preset 写死回去', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'core', 'agent', 'stream.js'), 'utf8');
  assert.ok(/systemPrompt:\s*this\._systemPromptOption\(\)/.test(src), '调用点应为 this._systemPromptOption()');
  assert.ok(!/systemPrompt:\s*\{\s*type:\s*'preset'/.test(src), 'preset 不该再硬编码在调用点上');
  assert.ok(/tools:\s*this\._toolsOption\(\)/.test(src), 'tools 也要走钩子, 不给就不传(SDK 默认全给)');
});

console.log('\n[1b] _droppedCoreTools: 宿主点名不要的 core 自带工具, 白名单里也要跟着消失');
ok('摘掉的工具不留在白名单里(名单上挂一个不存在的工具名, AI 调了必失败)', () => {
  const b = stub({ buses: new BusRegistry([{ id: 'x', kind: 'v1', base_url: 'http://x', token: 't' }]) });
  assert.ok(b.buildAllowedTools(false).includes('mcp__butler__bus_exec'), '前提: 配了 v1 bus 就该有 bus_exec');
  const dropped = stub({
    buses: new BusRegistry([{ id: 'x', kind: 'v1', base_url: 'http://x', token: 't' }]),
    _droppedCoreTools: () => ['bus_exec'],
  });
  assert.ok(!dropped.buildAllowedTools(false).includes('mcp__butler__bus_exec'));
});

console.log('\n[1c] bus 目标表驱动通道工具的放行(配了才给, 没配不给)');
ok('一条 bus 都没配 → bus_admin / bus_exec 都不放行', () => {
  const list = stub().buildAllowedTools(false);
  assert.ok(!list.includes('mcp__butler__bus_exec'));
  assert.ok(!list.includes('mcp__butler__bus_admin'));
});
ok('bothub 协议那条只放 bus_admin, v1 那条只放 bus_exec', () => {
  const bh = stub({ buses: new BusRegistry([{ id: 'h', kind: 'bothub', base_url: 'http://h', token: 't', agent: 'me' }]) });
  assert.ok(bh.buildAllowedTools(false).includes('mcp__butler__bus_admin'));
  assert.ok(!bh.buildAllowedTools(false).includes('mcp__butler__bus_exec'));
});
// send_bothub / bus_put_file / bus_get_file 三件已并进 bus_admin(op) —— 旧名不许再出现在白名单里
ok('🔴 合并掉的三个旧通道工具名一个都不许留在白名单', () => {
  const bh = stub({ buses: new BusRegistry([{ id: 'h', kind: 'bothub', base_url: 'http://h', token: 't', agent: 'me' }]) });
  const list = bh.buildAllowedTools(false);
  for (const gone of ['send_bothub', 'bus_put_file', 'bus_get_file', 'ask_persona']) {
    assert.ok(!list.includes(`mcp__butler__${gone}`), `白名单里还留着已删的 ${gone}`);
  }
});
ok('🔴 send_line 那一族已经不存在了(发 LINE 是 bus 上的一个 command)', () => {
  const b = stub({ buses: new BusRegistry([{ id: 'x', kind: 'v1', base_url: 'http://x', token: 't' }]) });
  const list = b.buildAllowedTools(false);
  assert.ok(!list.some((n) => n.includes('send_line')), '白名单里不该再有 send_line*');
});

console.log('\n[2] 系统提示: 两个 slot 都要真的被拼进去');
ok('afterRuntimeEnv 与 atEnd 的内容都出现在 systemPrompt 里', () => {
  const b = stub({
    _extraSystemBlocks: (slot) => (slot === 'afterRuntimeEnv' ? ['<<槽位A>>'] : ['<<槽位B>>']),
  });
  const s = b.appendSystemPrompt();
  assert.ok(s.includes('<<槽位A>>'), 'afterRuntimeEnv 没被拼进去');
  assert.ok(s.includes('<<槽位B>>'), 'atEnd 没被拼进去');
  // 顺序也要对: 运行时环境之后、收尾之前
  assert.ok(s.indexOf('<<槽位A>>') < s.indexOf('<<槽位B>>'), '两个 slot 的先后顺序反了');
});

console.log('\n[3] 工具白名单: 行业版要能在个人版这份基础上加, 而不是抄一份');
ok('buildAllowedTools 是个方法(内联在建流里的话子类只能整段抄)', () => {
  assert.strictEqual(typeof Butler.prototype.buildAllowedTools, 'function');
});
ok('有外部 MCP → 返回 null(不限制)', () => {
  assert.strictEqual(stub().buildAllowedTools(true), null);
});
ok('无外部 MCP → 给出白名单, 且 _extraAllowedTools 的项在里面', () => {
  const b = stub({ _extraAllowedTools: () => ['mcp__butler__行业版专用'] });
  const list = b.buildAllowedTools(false);
  assert.ok(Array.isArray(list) && list.length > 10, '白名单没出来');
  assert.ok(list.includes('mcp__butler__memory_query'), '基础记忆工具丢了');
  assert.ok(list.includes('mcp__butler__行业版专用'), '扩展项没被加进去');
});
ok('super 调得动: 子类拿到个人版那份再往上加', () => {
  class 行业版 extends Butler {
    _extraAllowedTools() { return []; }
    buildAllowedTools(hasExt, opts) {
      const base = super.buildAllowedTools(hasExt, opts);
      return base ? [...base, 'mcp__butler__店铺专用'] : base;
    }
  }
  const b = Object.assign(Object.create(行业版.prototype), stub());
  const list = b.buildAllowedTools(false);
  assert.ok(list.includes('mcp__butler__memory_query'), 'super 那份没拿到');
  assert.ok(list.includes('mcp__butler__店铺专用'), '子类自己加的没进去');
});

console.log('\n[3b] settingSources: 行业版靠它掐掉"继承装机者本机能力"这条路');
ok('默认不传(个人版行为不变), 传了就带上', () => {
  assert.strictEqual(stub().settingSources, undefined, '壳里没设 = 默认没有');
  const src2 = require('./kernel-src').kernelSource();
  assert.ok(/settingSources: this\.settingSources/.test(src2),
    '建流没把 settingSources 传给 SDK —— 行业版会继承装机那个人的 ~/.claude 技能/命令/插件');
  assert.ok(/this\.settingSources = opts\.settingSources/.test(src2), '构造里没接这个选项');
});

// settingSources 掐的只是 `~/.claude` 那批; CLI 二进制内置的 code-review/verify/run 那十几条
// 归 skills 管, 是另一把刀。⚠️ 别拿 SDK init 消息去验它: init 报的是"发现的"不是"启用的",
// 传 [] 之后照样列 17 条 —— 只有问模型本人才看得出清单真的空了(2026-09-08 三态实测)。
console.log('\n[3c] skills 白名单: 只管技能清单, 不碰 permissions/hooks/CLAUDE.md');
ok('默认不传(省略 ≠ 关闭, CLI 仍全开), 传了就带上', () => {
  assert.strictEqual(stub().skills, undefined, '壳里没设 = 默认没有');
  const s3 = require('./kernel-src').kernelSource();
  assert.ok(/skills: this\.skills/.test(s3),
    '建流没把 skills 传给 SDK —— 每个人格都会背着十几条写代码专用技能, 每轮约 2500 字符');
  assert.ok(/this\.skills = Array\.isArray\(opts\.skills\)/.test(s3), '构造里没接这个选项');
});
ok('tune 改得动 skills, 且替别人改要管家身份', () => {
  const s3 = require('./kernel-src').kernelSource();
  assert.ok(/'skills',\s+\/\//.test(s3), 'TUNABLE_FIELDS 里没有 skills → 人格改不动自己的技能清单');
  assert.ok(/isSkills && !this\.isButler/.test(s3), '非管家也能替别人关技能, 而对方无从察觉');
  // 分档常量住在 registry: 界面建人格那条路(create-persona-ui)读的是同一份, 定义两处必然漂开,
  // 而漂开的表现是"从哪建的决定了它会什么" —— 所以这里要守单源, 不只是守常量存在。
  assert.ok(/\{ BASE_SKILLS, DEV_SKILLS \} = registry/.test(s3), '技能分档没走 registry 单源');
  const reg = require('./kernel-src').readSrc('registry.js');
  assert.ok(/const BASE_SKILLS = \[/.test(reg) && /const DEV_SKILLS = \[/.test(reg),
    'registry 里没有技能分档常量 → create 的 dev 选项失去依据');
  assert.ok(/BASE_SKILLS, DEV_SKILLS,/.test(reg), 'registry 没把分档常量导出去');
});

console.log('\n[4] 调用点还在不在(删掉调用点 = 钩子形同虚设, 而且悄无声息)');
const src = require('./kernel-src').kernelSource();
ok('systemPrompt 两处 slot 都在调', () => {
  assert.ok(/_extraSystemBlocks\('afterRuntimeEnv'\)/.test(src));
  assert.ok(/_extraSystemBlocks\('atEnd'\)/.test(src));
});
ok('buildMcp 在收工具, 建流在收 mcpServers 与 allowedTools', () => {
  assert.ok(/_extraMcpTools\(/.test(src), 'buildMcp 没收扩展工具');
  assert.ok(/_extraMcpServers\(\)/.test(src), 'mcpServers 没收扩展 server');
  assert.ok(/buildAllowedTools\(hasExt/.test(src), '建流没走 buildAllowedTools');
});
ok('唤醒正文在收 _extraWakeParts', () => {
  assert.ok(/_extraWakeParts\('atEnd'\)/.test(src));
});

console.log(`\n结果: ${pass} pass, ${fail} fail`);
// 显式收尾: 实测 `voice-say` 的语言枚举会把纯 node 进程吊住(它去问本机有哪些嗓子, 起子进程),
// 于是这个测试打完结果也不退, 在门禁里表现成 TIMEOUT。与 fs.watch 那两处同一类存量毛病,
// 根治要动 voice-say, 不在本次范围内 —— 先在这里收尾, 别让它把门禁拖成假红。
process.exit(fail ? 1 : 0);
