'use strict';
// plugin-tools.js — 插件三件工具: plugin_find(查装了什么、开放了哪些命令) · plugin_open(摆到眼前) ·
// plugin_call(跑插件开放给人格的命令)。从 mcp-tools.js 拆出, 那边只负责登记。
const pluginCatalog = require('../plugin-catalog');
const { looseShape, paramsField, gather } = require('./flat-args');
const commands = require('../commands');
const { getLang: displayLang } = require('../memory-v2/lang');

function registerPluginTools(agent, { tool, z, D }) {
  // —— 插件: 常驻只留「有这回事」一句, 装了哪些**只在要用那一刻查** ——
  // plugin_call 只在宿主给了命令执行器时才有(个人版); 没有的版本 plugin_find 也不列命令。
  const canCall = !!(agent.personaOps && typeof agent.personaOps.runPluginCommand === 'function');
  const pluginFind = tool(
    'plugin_find',
    D.plugin_find,
    { keyword: z.string().optional().describe('what you want to do, e.g. "LINE", "calculator". Leave empty = list all') },
    async ({ keyword }) => {
      /* 🔴 表示言語を渡す。目録の側は locale を受け取れるのに、ここが渡していなかった ——
         結果、包の名前だけが日本語のまま回答に混ざる(中国語の店主の画面に「LINE をつなぐ」)。
         名前はそのまま `{{cmd:…|label=…}}` の字になるので、ボタンの文字まで日本語になる。 */
      const loc = displayLang();
      const hits = pluginCatalog.find(keyword, loc);
      if (!hits.length) {
        const total = pluginCatalog.list(loc).length;
        return { content: [{ type: 'text', text: total
          ? `(no plugin matching "${keyword}" · this machine has ${total} installed; leave keyword empty to list all)`
          : '(no plugins installed on this machine)' }] };
      }
      // 带参数的条目(视图/行内命令)给"照抄就能用"的写法 —— plugin_open 渲染的是无参模板,
      // 塞不进 date 这类实参, 那种只能由 AI 自己写进回复。其余照旧走 plugin_open, 标记不过模型的嘴。
      // 包自带的说明: 每条带一句 summary; 完整 usage 只在查的就是这个插件时(关键词 = id, 或只命中它一个)整段给出。
      const kw = String(keyword || '').trim();
      const full = hits.find((p) => p.id === kw && p.usage) || (hits.length === 1 && hits[0].usage ? hits[0] : null);
      const about = (p) => `${p.summary ? ` — ${p.summary}` : ''}${p.usage && p !== full ? `　(full usage: plugin_find(keyword='${p.id}'))` : ''}`;
      const txt = hits.map((p) => (p.write
        ? `- ${p.id}　${p.title}${p.params ? `　(${p.params})` : ''}　→ write: ${p.write}`
        : `- ${p.id}　${p.title}　[${p.kind === 'ui' ? 'single-page' : `${p.pages} screens`}]`) + about(p)).join('\n')
        + (full ? `\n\nHow to use ${full.id}:\n${full.usage}` : '');
      const hint = hits.some((p) => !p.write) ? '\n\nFor the ones without a "write:" line, call the plugin_open tool with that id yourself — it is a tool call, not a marker to write in your reply.' : '';
      // 包开放给人格的命令: 不用打开界面, 直接 plugin_call 调。
      const callable = canCall ? hits.filter((p) => p.commands && p.commands.length) : [];
      const calls = callable.length ? '\n\nCommands you can run yourself with plugin_call (no UI needed):\n'
        + callable.map((p) => p.commands.map((c) => {
          const ps = Object.entries(c.params || {}).map(([k, v]) => `${k}${v && v.required ? '' : '?'}`).join(', ');
          return `- plugin_call(id='${p.id}', command='${c.command}'${ps ? `, ${ps}` : ''})${c.summary ? ` — ${c.summary}` : ''}`;
        }).join('\n')).join('\n') : '';
      return { content: [{ type: 'text', text: `Found ${hits.length}:\n${txt}${hint}${calls}` }] };
    }
  );
  const pluginOpen = tool(
    'plugin_open',
    D.plugin_open,
    looseShape(z, { id: z.string().describe('plugin id (from plugin_find). A single-page plugin\'s starting field values go right after it, e.g. plugin_open(id=…, name=…, price=…) — the person sees them filled in and can edit them'),
      pin: z.boolean().optional().describe('override where it goes: true = pin to the always-on board, false = inline in the conversation. Omit to use the plugin\'s own default.'),
      params: paramsField(z) }),
    async (input) => {
      const { id, pin } = input;
      const args = gather(input, ['id', 'pin']);
      const p = pluginCatalog.get(id, displayLang());
      if (!p) return { content: [{ type: 'text', text: `⚠️ No plugin with id "${id}" is installed · run plugin_find first` }] };
      // 摆法默认由包自己声明(display), 显式 pin 压过它 —— 用户开口要求钉/不钉时不必去改包。
      // 手顺包(workflow)没有第二种摆法, 显式参数对它无效。
      let entry = (pin === undefined || p.kind !== 'ui') ? p.entry
        : (pin ? `{{pin:${p.id}|ui=${p.id}}}` : `{{ui:${p.id}}}`);
      if (args) entry = pluginCatalog.withOpenArgs(entry, p.kind, args);
      const tail = `(${p.title} · ${p.kind === 'ui' ? 'single-page, runs in sandbox' : `${p.pages} screens, screen transitions bypass you so pressing it any number of times costs nothing`})`;
      // 渲染这一步不经过模型的嘴: 复读一行机器生成的标记要花一轮 token, 而且拦不住它顺手"优化"措辞 ——
      // 标记被改一个字, 按钮就烂成一段死文字。没接 UI 的人格(TG / 本机 API 投递)回落原路。
      if (agent.personaOps && agent.personaOps.renderPlugin && agent.personaOps.renderPlugin(entry)) {
        return { content: [{ type: 'text', text:
          `✅ The UI for "${p.title}" has been ${entry.startsWith('{{pin:') ? 'pinned to the always-on board' : 'rendered into the conversation'} — the user can see it right now.\n`
          + `🔴 Do NOT copy \`${entry}\` into your reply — every copy creates one more identical UI panel.\n`
          + `Just tell the user it is ready in one sentence, or say nothing at all.\n\n${tail}` }] };
      }
      return { content: [{ type: 'text', text:
        `Copy the following line **exactly** into your reply — the user clicks it to enter. Do not rewrite or manually assemble the syntax:\n\n${entry}\n\n${tail}` }] };
    }
  );
  // 跑一个插件开放给人格的命令(包声明 ai:true)。走的是按钮那同一个执行器, 能做的不比按钮多。
  const pluginCall = canCall ? tool(
    'plugin_call',
    D.plugin_call,
    looseShape(z, { id: z.string().describe('plugin id (from plugin_find)'),
      command: z.string().describe('command name listed under that plugin by plugin_find; its parameters go right after, e.g. plugin_call(id=…, command=…, q=…)'),
      params: paramsField(z) }),
    async (input) => {
      const { id, command } = input;
      const args = gather(input, ['id', 'command']);
      const offered = commands.aiCommands(String(id || ''));
      const c = offered.find((x) => x.command === command);
      if (!c) {
        return { content: [{ type: 'text', text: offered.length
          ? `⚠️ Plugin "${id}" has no command "${command}" you can run. It offers: ${offered.map((x) => x.command).join(', ')}.`
          : `⚠️ Plugin "${id}" offers no commands you can run · plugin_find shows which plugins do.` }] };
      }
      const r = await agent.personaOps.runPluginCommand(`${id}.${command}`, args || {});
      if (!r || !r.ok) {
        return { content: [{ type: 'text', text: `⚠️ ${id}.${command} failed: ${(r && (r.message || r.code)) || 'no result'}` }] };
      }
      const data = r.rows !== undefined ? r.rows : r.data;
      // web 命令回的是整份接口 JSON(一个 GitHub 仓库就六七千字): 上限放宽, 截了要说, 否则人格以为字段不存在
      const json = data !== undefined ? JSON.stringify(data) : '';
      const CAP = 20000;
      const body = data !== undefined ? `\n${json.slice(0, CAP)}${json.length > CAP ? `\n…[truncated: first ${CAP} of ${json.length} characters]` : ''}` : '';
      const changed = r.changes !== undefined ? ` (${r.changes} changed)` : '';
      return { content: [{ type: 'text', text: `✅ ${id}.${command} done${changed}${r.message ? ` · ${r.message}` : ''}${body}` }] };
    }
  ) : null;
  return { pluginFind, pluginOpen, pluginCall };
}

module.exports = { registerPluginTools };
