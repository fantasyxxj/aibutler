// Skill 工具: 文件形式的技能。每个技能是一个目录, 里面一份 SKILL.md(开头 YAML frontmatter 带 name / description)。
// 找的位置: <cwd>/.claude/skills/*  与  ~/.claude/skills/*(前者优先)。options.skills 给了名单就只开名单里的。
// 模型调 Skill(skill=名字) 拿到整份 SKILL.md, 照着做; 技能目录里的其它文件它可以再用 Read 去读。
// Claude Code 程序里内置的那批技能(schedule / loop / code-review …)不在文件里, 这里没有。

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BuiltinTool, ToolOutput } from '../tools/registry.js';

interface SkillInfo { name: string; description: string; file: string; dir: string }

function parseFrontmatter(src: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src);
  const out: Record<string, string> = {};
  if (!m) return out;
  let key = '';
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) { key = kv[1]; out[key] = kv[2].replace(/^["']|["']$/g, ''); }
    else if (key && /^\s+\S/.test(line)) out[key] += ` ${line.trim()}`;   // 折行续写
  }
  return out;
}

export function findSkills(cwd: string | undefined, allow: string[] | null): SkillInfo[] {
  const roots = [cwd && path.join(cwd, '.claude', 'skills'), process.env.HOME && path.join(process.env.HOME, '.claude', 'skills')].filter(Boolean) as string[];
  const seen = new Map<string, SkillInfo>();
  for (const root of roots) {
    let ents: fs.Dirent[];
    try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of ents) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      const dir = path.join(root, e.name);
      const file = path.join(dir, 'SKILL.md');
      let src: string;
      try { src = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
      const fm = parseFrontmatter(src);
      const name = fm.name || e.name;
      if (seen.has(name) || (allow && !allow.includes(name))) continue;
      seen.set(name, { name, description: (fm.description || '').slice(0, 400), file, dir });
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export const Skill: BuiltinTool = {
  name: 'Skill',
  description: 'Invoke a skill (a packaged set of instructions).',
  inputSchema: {
    type: 'object',
    properties: {
      skill: { type: 'string', description: 'The skill name' },
      args: { type: 'string', description: 'Optional arguments for the skill' },
    },
    required: ['skill'],
  },
  // 没经过 prepare 就被调到 = 这个会话找不到任何技能
  async run(): Promise<ToolOutput> {
    return { content: [{ type: 'text', text: '<tool_use_error>No skills are installed.</tool_use_error>' }], isError: true };
  },
  // 每个会话按它的 cwd 和 options.skills 现找一遍, 把清单写进工具描述; 一个都没有就不开这个工具
  prepare(opts) {
    const skills = findSkills(opts.cwd, Array.isArray(opts.skills) ? opts.skills : null);
    if (!skills.length) return null;
    const list = skills.map((s) => `- ${s.name}: ${s.description}`).join('\n');
    return {
      ...Skill,
      prepare: undefined,
      description: `Invoke a skill (a packaged set of instructions). When the task matches a skill below, call this tool first and follow the returned instructions.\n\nAvailable skills:\n${list}`,
      async run(input): Promise<ToolOutput> {
        const want = String(input.skill || '').replace(/^\//, '');
        const s = skills.find((x) => x.name === want);
        if (!s) return { content: [{ type: 'text', text: `<tool_use_error>Unknown skill: ${want}. Available: ${skills.map((x) => x.name).join(', ')}</tool_use_error>` }], isError: true };
        const body = fs.readFileSync(s.file, 'utf8');
        const args = input.args ? `\n\nARGUMENTS: ${input.args}` : '';
        return { content: [{ type: 'text', text: `Base directory for this skill: ${s.dir}\n\n${body}${args}` }] };
      },
    };
  },
};
