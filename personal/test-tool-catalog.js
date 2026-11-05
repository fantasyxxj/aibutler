// test-tool-catalog.js — 提示词点名的工具必须真实存在 · 防漂
//
// 2026-08-20 之前这里测的是"系统提示里的工具清单 = 真正注册进 MCP 的那批"。
// 那份清单已整个删除: 模型通过 MCP 协议本来就拿得到全部工具名和 description,
// 常驻再拼一遍是第二份副本(渲染后约 2000 字节/轮)。删清单 → 防漂的对象也没了。
//
// 但漂移风险没消失, 只是换了形态: 提示词里现在只剩【点名】(memory_query / list_personas …),
// 工具一改名, 点名就变成一个不存在的幽灵, AI 照着调必然失败。这个测试专抓那个。
// 运行: node test-tool-catalog.js
require('./host-wiring');   // 个人版宿主接线: 直接 require core 模块的进程都得先接
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Butler } = require('../core/agent');

let pass = 0, fail = 0;
const t = (name, ok, extra = '') => { if (ok) { pass++; console.log(`  ✅ ${name}${extra ? ' · ' + extra : ''}`); } else { fail++; console.error(`  ❌ ${name}${extra ? ' · ' + extra : ''}`); } };

(async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-catalog-'));
  const butler = new Butler(tmpHome, { name: '测试飞飞', isButler: true });
  const server = await butler.buildMcp();
  // 私有字段, 但它是"这台机器上真注册了什么"的唯一权威。生产代码不该为了被测而多留一份副本 ——
  // 那正是上一版 _toolCatalog 的下场(留着留着就被拼进提示词了)。
  const names = Object.keys(server.instance._registeredTools);
  const sp = butler.appendSystemPrompt();

  console.log('\n=== T1: 常驻侧不许再出现工具清单 ===');
  t('注册表非空(测试前提成立)', names.length > 0, `${names.length} 件`);
  t('系统提示里没有逐件罗列', !sp.includes('本机实测清单'));
  const listed = names.filter((n) => sp.includes(n));
  // 少量点名是对的(memory_query 这种被行为铁律点到的); 但凡过半工具都出现在提示词里,
  // 就说明有人又把清单拼回去了。
  t('没有把注册表整个拼回提示词', listed.length < names.length / 2,
    `${listed.length}/${names.length} 件被点名: ${listed.join(',')}`);

  console.log('\n=== T2: 提示词模板里不许出现不存在的工具名 ===');
  const known = new Set(names);
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : (e.name.endsWith('.md') ? [p] : []);
  });
  const bad = [];
  for (const f of walk(path.join(__dirname, '../core/config'))) {
    const body = fs.readFileSync(f, 'utf8');
    // 跟着 .md / 前面带 / 的是配置文件路径(如 wake/memory_disciplines.md), 不是工具名。
    for (const m of body.matchAll(/(\/?)\b(?:memory|send|persona|update_prompt|compact|context)_[a-z_]+(\.md)?/g)) {
      if (m[1] || m[2]) continue;
      const nm = m[0];
      if (!known.has(nm)) bad.push(`${path.basename(f)}:${nm}`);
    }
  }
  t('模板点名的工具全都真实存在', bad.length === 0, [...new Set(bad)].join(' '));

  console.log('\n=== T3: 注册了却没有任何描述的: 无 ===');
  // 清单没了之后, 工具的一句话说明只剩 MCP description 这一份 —— 它现在是 AI 唯一的信息源, 不能空。
  const noDesc = names.filter((n) => {
    const d = server.instance._registeredTools[n];
    return !d || !d.description || String(d.description).trim().length < 4;
  });
  t('每件注册工具都有 description', noDesc.length === 0, noDesc.join(','));

  console.log('\n=== T4: 四件记忆工具必须常驻(不许被 tool search 藏起来) ===');
  // SDK 默认把所有 MCP 工具的 schema 藏在 tool search 后面, 用到才拉。这四件是铁律
  // "动手前先查记忆""发现新东西就先存"的入口, 藏了就等于给最高频的动作加一跳 ——
  // 人格会因此少查少沉, 而这种退化**不报错**: 工具还在、名字还在、测试还绿, 只是没人再去查了。
  // 所以只能靠断言守。⚠️ 记忆工具注册在两处(v2 走 memory-tools-v2.js, v1 走 agent.js),
  // 只改一处会静默失效 —— 2026-08-20 实测踩过, 5 个只中 1 个。
  const MUST_RESIDENT = ['memory_query', 'memory_hot', 'memory_upsert', 'memory_touch'];
  const isResident = (n) => {
    const d = server.instance._registeredTools[n];
    return !!(d && d._meta && d._meta['anthropic/alwaysLoad']);
  };
  const missing = MUST_RESIDENT.filter((n) => !isResident(n));
  t('四件记忆工具都标了 alwaysLoad', missing.length === 0,
    missing.length ? `掉了: ${missing.join(',')}` : MUST_RESIDENT.join(','));
  // 反向也要守: 名额是有代价的(每轮都注入), 不能谁都往里塞。compact_context 是低频动作,
  // 刻意排除在外 —— 它要是哪天被加回来, 说明判据又漂回"反正占比小"了。
  const extra = names.filter((n) => isResident(n) && !MUST_RESIDENT.includes(n));
  t('没有多余的常驻工具', extra.length === 0, extra.length ? `多了: ${extra.join(',')}` : '仅此四件');

  console.log('\n=== T5: 空参保护(入参整体丢成 {} 时给人话, 不给 zod 原文) ===');
  // 这条守的是 agent.js guardEmptyArgs 那个钩子点。它扎在 MCP SDK 的私有 _requestHandlers 上,
  // SDK 一升级就可能挂不上 —— 而挂不上是**静默**的(应用照跑, 只是保护没了), 只能靠断言抓。
  const handlers = server.instance.server && server.instance.server._requestHandlers;
  t('tools/call 钩子点还在', !!(handlers && handlers.get('tools/call')));
  const call = (n, args) => handlers.get('tools/call')(
    { method: 'tools/call', params: { name: n, arguments: args } }, { signal: new AbortController().signal });
  const said = String(((await call('memory_upsert', {})).content || [{}])[0].text || '');
  t('空参被截住, 没落到 zod', said.includes('空对象'), said.slice(0, 30));
  t('说清了是"一个都没收到"而非"缺某个"', said.includes('不是缺某个字段'));
  // 反向断言: 病因和处方一个字都不许写进报错。我们并没查清病因(丢参率 upsert 2.2% > touch 0.8% >
  // Read 0.03%, payload 形态多半有份), 写进去就是拿没验过的话当依据喂给 AI。
  t('不夹带病因/处方', !/概率|无关|重发|拆短|别改/.test(said));
  t('第 1 次不提连击(单次分不清偶发, 提了是噪音)', !said.includes('连续第'));
  // 🔴 反向: 全可选参数的工具**不许**被这道保护拦住。
  // 2026-08-25 实测: plugin_find 只有一个可选 keyword, 描述还写着"留空 = 全列出来",
  // 结果不传参就被拒, 人格得改成显式传 keyword="" 才走得通 —— 当时判据看的是"schema 空不空",
  // 而不是"有没有必填字段"。同一个结论本文件上方注释里早写过(按 input 空不空筛有 7.7% 假阳性)。
  const optSaid = String(((await call('plugin_find', {})).content || [{}])[0].text || '');
  t('全可选参数的工具留空调用不被拦(plugin_find)', !optSaid.includes('空对象'), optSaid.slice(0, 40));
  const hotSaid = String(((await call('memory_hot', {})).content || [{}])[0].text || '');
  t('memory_hot 同理(k 可选)', !hotSaid.includes('空对象'), hotSaid.slice(0, 40));
  // 丢参 51.9% 成串(2026-08-21 普查 86683 次调用, 最长连丢 8 次)。只报"第几次"这个事实,
  // 让 AI 自己判断该不该换形态 —— 不报的话它看每次都一样, 会一直原样重试。
  const said2 = String(((await call('memory_upsert', {})).content || [{}])[0].text || '');
  t('连续第 2 次带上连击计数', said2.includes('连续第 2 次'), said2.slice(-16));
  t('连击提示同样不夹带病因/处方', !/概率|无关|重发|拆短|别改/.test(said2));
  // 无参工具(context_usage 这种)本来就收空对象, 不能被误伤。
  // 🔴 挑的那个必须**真注册着**: 工具名写错时返回的是 "MCP error -32602 工具不存在", 那句话
  //    同样不含"空对象", 断言照样绿 —— 2026-09-07 memory_doctor 并进 memory_admin 后就是这么假绿的。
  t('选的无参工具确实注册着', !!server.instance._registeredTools.context_usage);
  const dtxt = String(((await call('context_usage', {})).content || [{}])[0].text || '');
  t('无参工具不受影响', !dtxt.includes('空对象'), dtxt.slice(0, 30));

  console.log(`\n${fail ? '❌' : '✅'} ${pass} 绿 ${fail} 红`);
  process.exit(fail ? 1 : 0);
})();
