// 工作流脚本的解析与执行环境: 拆出开头的 `export const meta = {...}`(必须是纯字面量), 剩下的正文
// 放进一个独立的 vm 上下文里当 async 函数跑, 只给 agent / parallel / pipeline / phase / log / args / budget。
// 上下文里没有 require / process / fetch, Date.now()、Math.random()、无参 new Date() 一调就抛(会破坏续跑) —— 同 CC。
// ⚠️ vm 不是安全边界: 注入进去的宿主函数顺着 constructor 能摸到外面。这里挡的是「写错」不是「作恶」——
//    写脚本的就是本人格的模型, 它本来就有 Bash; 子代理调工具照样过 PreToolUse 闸。

import vm from 'node:vm';

export interface WorkflowMeta { name: string; description: string; phases?: Array<{ title: string; detail?: string; model?: string }>; [k: string]: any }

export function parseScript(src: string): { meta: WorkflowMeta; body: string } {
  const text = String(src || '');
  const head = /^\s*(?:(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)\s*)*export\s+const\s+meta\s*=\s*/.exec(text);
  if (!head) throw new Error('the script must begin with `export const meta = { name, description, phases }`');
  const start = head[0].length;
  if (text[start] !== '{') throw new Error('meta must be an object literal');
  const end = matchBrace(text, start);
  const literal = text.slice(start, end + 1);
  let meta: any;
  try { meta = vm.runInNewContext(`(${literal})`, Object.create(null), { timeout: 200 }); } catch (e: any) {
    throw new Error(`meta must be a pure literal (no variables, calls or interpolation): ${e && e.message}`);
  }
  if (!meta || typeof meta.name !== 'string' || !meta.name || typeof meta.description !== 'string') {
    throw new Error('meta needs a non-empty string `name` and a string `description`');
  }
  const body = text.slice(end + 1).replace(/^\s*;/, '');
  return { meta, body };
}

// 从 text[i]=='{' 找到配对的 '}', 跳过字符串、模板串和注释
function matchBrace(text: string, i: number): number {
  let depth = 0;
  for (let k = i; k < text.length; k++) {
    const ch = text[k];
    if (ch === '"' || ch === "'" || ch === '`') {
      for (k++; k < text.length && text[k] !== ch; k++) if (text[k] === '\\') k++;
      continue;
    }
    if (ch === '/' && text[k + 1] === '/') { k = text.indexOf('\n', k); if (k < 0) break; continue; }
    if (ch === '/' && text[k + 1] === '*') { k = text.indexOf('*/', k + 2) + 1; if (k <= 0) break; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return k;
  }
  throw new Error('meta object literal is not closed');
}

const PRELUDE = `
(() => {
  const no = (what) => () => { throw new Error(what + ' is not available in workflow scripts (it would break resume); pass it in via args'); };
  const RealDate = Date;
  Date.now = no('Date.now()');
  Math.random = no('Math.random()');
  globalThis.Date = new Proxy(RealDate, {
    construct(t, a) { if (!a.length) no('new Date()')(); return new t(...a); },
    apply(t, self, a) { no('Date()')(); },
  });
})();`;

export type Hooks = Record<string, unknown>;

// 跑正文; 正文里的 return 就是整个工作流的返回值
export async function runBody(body: string, hooks: Hooks, filename: string): Promise<unknown> {
  const ctx = vm.createContext({ ...hooks });
  vm.runInContext(PRELUDE, ctx);
  let script: vm.Script;
  try {
    script = new vm.Script(`(async () => {\n${body}\n})()`, { filename });
  } catch (e: any) {
    throw new Error(`script syntax error: ${e && e.message} (scripts are plain JavaScript — no TypeScript annotations)`);
  }
  return await script.runInContext(ctx);
}
