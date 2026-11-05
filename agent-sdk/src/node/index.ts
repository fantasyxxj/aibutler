// @butler/agent-sdk/node —— 桌面(Node / Electron)专用: 文件与 shell 内置工具, 外部 MCP 的 transport。
// 用法: query({ prompt, options: { ...options, builtinTools: nodeTools(), mcpTransport: nodeMcpTransport } })

import { Read, Write, Edit, Glob } from './files.js';
import { Bash, Grep } from './shell.js';
import { WebFetch, WebSearch } from '../tools/web.js';
import { Skill } from './skills.js';
import type { BuiltinTool } from '../tools/registry.js';

export { Read, Write, Edit, Glob, Bash, Grep, Skill };

export function nodeTools(): BuiltinTool[] {
  return [Read, Write, Edit, Glob, Grep, Bash, WebFetch, WebSearch, Skill];
}

// 外部 MCP: stdio(command/args/env) · http(type:'http', url, headers) · sse(type:'sse', url, headers)
export async function nodeMcpTransport(_name: string, cfg: Record<string, any>): Promise<any> {
  const type = cfg.type || (cfg.command ? 'stdio' : cfg.url ? 'http' : '');
  if (type === 'stdio') {
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...process.env, ...(cfg.env || {}) })) if (typeof v === 'string') env[k] = v;
    return new StdioClientTransport({ command: cfg.command, args: cfg.args || [], env, ...(cfg.cwd ? { cwd: cfg.cwd } : {}) });
  }
  if (type === 'http') {
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    return new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers || {} } });
  }
  if (type === 'sse') {
    const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
    return new SSEClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers || {} } });
  }
  throw new Error(`unsupported MCP server config (type=${type || 'unknown'})`);
}
