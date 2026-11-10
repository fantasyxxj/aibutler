// 把 mcpServers 里的每个服务连上, 列出工具, 给出统一的 call()。
// 进程内(type:'sdk')走 InMemoryTransport; stdio / http 这类外部服务要宿主给 transport 工厂
// (Node 下由 @butler/agent-sdk/node 的 nodeMcpTransport 提供), 核心层不碰子进程。

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { TOOL_META, type ToolMeta } from './sdk-server.js';

export interface McpToolInfo {
  server: string;
  name: string;            // 服务内的原名
  fullName: string;        // mcp__<server>__<name>, 模型看到的名字
  description: string;
  inputSchema: Record<string, any>;   // JSON Schema
  alwaysLoad: boolean;
  searchHint?: string;
  readOnly: boolean;       // 服务声明了 annotations.readOnlyHint —— 同一步里可以和别的只读调用一起跑
}

export interface McpConnection {
  server: string;
  tools: McpToolInfo[];
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ content: any[]; isError?: boolean }>;
  close(): Promise<void>;
}

export type McpTransportFactory = (name: string, cfg: Record<string, any>) => Promise<any> | any;

export async function connectServers(
  servers: Record<string, any> | undefined,
  transportFactory: McpTransportFactory | undefined,
  log: (s: string) => void,
): Promise<McpConnection[]> {
  const out: McpConnection[] = [];
  for (const [key, cfg] of Object.entries(servers || {})) {
    try {
      let transport: any;
      let meta: Map<string, ToolMeta> | undefined;
      if (cfg && cfg.type === 'sdk' && cfg.instance) {
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        await cfg.instance.connect(serverSide);
        transport = clientSide;
        meta = cfg[TOOL_META];
      } else if (transportFactory) {
        transport = await transportFactory(key, cfg);
      } else {
        log(`[mcp] ${key}: 外部 MCP 需要宿主提供 transport 工厂, 已跳过`);
        continue;
      }
      const client = new Client({ name: 'butler-agent-sdk', version: '0.1.0' });
      await client.connect(transport);
      const listed = await client.listTools();
      const tools: McpToolInfo[] = (listed.tools || []).map((t: any) => ({
        server: key,
        name: t.name,
        fullName: `mcp__${key}__${t.name}`,
        description: t.description || '',
        inputSchema: t.inputSchema || { type: 'object', properties: {} },
        alwaysLoad: !!(meta && meta.get(t.name)?.alwaysLoad),
        searchHint: meta && meta.get(t.name)?.searchHint,
        readOnly: !!(t.annotations && t.annotations.readOnlyHint),
      }));
      out.push({
        server: key,
        tools,
        async call(name, args, signal) {
          const r: any = await client.callTool({ name, arguments: args }, undefined, { signal, timeout: 30 * 60 * 1000 });
          return { content: Array.isArray(r.content) ? r.content : [], isError: !!r.isError };
        },
        async close() { try { await client.close(); } catch (_) { /* 关不动也不影响退出 */ } },
      });
    } catch (e: any) {
      log(`[mcp] ${key}: 连接失败 ${e && e.message}`);
    }
  }
  return out;
}
