// PreToolUse 钩子: 与 Claude Agent SDK 同签名 (input, toolUseID, {signal}) => HookJSONOutput。
// options.hooks.PreToolUse = [{ matcher?: '正则', hooks: [fn, ...] }, ...], 按序串行调用:
//   permissionDecision 'deny'(或旧写法 decision 'block') → 拦下, 理由作为错误结果给模型, 后面的钩子不再调
//   updatedInput → 换掉入参, 后面的钩子看到的是新入参
//   additionalContext → 放行, 这句话接在工具结果后面带给模型

export interface HookVerdict {
  denied: string | null;
  input: any;
  notes: string[];
}

type HookFn = (input: any, toolUseID: string | undefined, opts: { signal: AbortSignal }) => Promise<any> | any;

export function collectPreToolUse(hooks: any): Array<{ matcher?: string; fn: HookFn }> {
  const groups = hooks && Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  const out: Array<{ matcher?: string; fn: HookFn }> = [];
  for (const g of groups) for (const fn of (g && g.hooks) || []) if (typeof fn === 'function') out.push({ matcher: g.matcher, fn });
  return out;
}

function matches(matcher: string | undefined, name: string): boolean {
  if (!matcher || matcher === '*') return true;
  try { return new RegExp(`^(?:${matcher})$`).test(name); } catch (_) { return matcher === name; }
}

export async function runPreToolUse(
  list: Array<{ matcher?: string; fn: HookFn }>,
  base: { session_id: string; cwd?: string; permission_mode?: string },
  call: { id: string; name: string; input: any },
  signal: AbortSignal,
  log: (s: string) => void,
): Promise<HookVerdict> {
  let input = call.input;
  const notes: string[] = [];
  for (const h of list) {
    if (!matches(h.matcher, call.name)) continue;
    let out: any;
    try {
      out = await h.fn({
        hook_event_name: 'PreToolUse', session_id: base.session_id, transcript_path: '', cwd: base.cwd,
        permission_mode: base.permission_mode, tool_name: call.name, tool_input: input, tool_use_id: call.id,
      }, call.id, { signal });
    } catch (e: any) {
      // 钩子自己抛错不拦工具 —— 与 CLI 一致, 只记一笔
      log(`[hook] PreToolUse 抛错(${call.name}): ${e && e.message}`);
      continue;
    }
    if (!out || typeof out !== 'object') continue;
    const hso = out.hookSpecificOutput || {};
    if (hso.permissionDecision === 'deny' || out.decision === 'block') {
      const reason = hso.permissionDecisionReason || out.reason || 'Blocked by PreToolUse hook';
      return { denied: String(reason), input, notes };
    }
    if (hso.updatedInput && typeof hso.updatedInput === 'object') input = hso.updatedInput;
    if (hso.additionalContext) notes.push(String(hso.additionalContext));
  }
  return { denied: null, input, notes };
}
