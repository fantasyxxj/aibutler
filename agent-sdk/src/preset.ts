// 替代 Claude Code 的 claude_code 预设。宿主传 {type:'preset', preset:'claude_code', append} 时,
// 用这一段打底再接 append; 传字符串则原样使用(butler 行业版 / 教育版就是这样)。
// 只写环境事实和通用的工具用法, 身份、口吻、规矩一律由宿主的 append 决定。

function envFacts(cwd: string | undefined): string {
  const proc: any = (globalThis as any).process;
  const platform = proc && proc.platform ? proc.platform : 'unknown';
  const lines = [
    `- Working directory: ${cwd || '(none)'}`,
    `- Platform: ${platform}`,
    `- Today's date: ${new Date().toISOString().slice(0, 10)}`,
  ];
  return lines.join('\n');
}

const BASE = `You are an agent that works with the user through the tools you are given.

# Doing the work
- Use tools to look things up and to act; do not guess at file contents, dates or system state you can check.
- When several tool calls do not depend on each other, issue them in the same step.
- Prefer the dedicated file tools (Read / Write / Edit / Grep / Glob) over shell commands when one fits.
- Before editing a file, read it. Keep changes in the style of the surrounding code.
- Report outcomes faithfully: if something failed or was skipped, say so.

# Tools
- Tool results may include notes added by the host after the result itself; treat them as guidance from the host.
- Some tools are deferred: only their names are listed. Load a deferred tool's schema with ToolSearch before calling it.`;

export function buildSystemPrompt(opt: any, cwd: string | undefined): string {
  if (typeof opt === 'string') return opt;
  if (opt && typeof opt === 'object' && opt.type === 'preset') {
    const head = `${BASE}\n\n# Environment\n${envFacts(cwd)}`;
    return opt.append ? `${head}\n\n${opt.append}` : head;
  }
  return '';
}
