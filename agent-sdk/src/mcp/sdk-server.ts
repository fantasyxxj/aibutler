// tool() / createSdkMcpServer(): 与 @anthropic-ai/claude-agent-sdk 同名同签名。
// 内部真建一个官方 McpServer —— butler 的 guardEmptyArgs 会伸进 instance.server._requestHandlers
// 拦空参调用, 调用方走的也是这条处理链, 所以那道保护原样生效。

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export const TOOL_META = Symbol.for('butler.agent-sdk.toolMeta');

export interface ToolExtras {
  annotations?: Record<string, unknown>;
  searchHint?: string;
  alwaysLoad?: boolean;
}

export interface SdkMcpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, any>;   // zod raw shape
  handler: (args: any, extra: unknown) => Promise<any>;
  annotations?: Record<string, unknown>;
  searchHint?: string;
  alwaysLoad?: boolean;
}

export interface ToolMeta { alwaysLoad: boolean; searchHint?: string }

export interface McpSdkServerConfigWithInstance {
  type: 'sdk';
  name: string;
  instance: McpServer;
  [TOOL_META]?: Map<string, ToolMeta>;
}

export function tool(
  name: string,
  description: string,
  inputSchema: Record<string, any>,
  handler: (args: any, extra: unknown) => Promise<any>,
  extras?: ToolExtras,
): SdkMcpToolDefinition {
  return { name, description, inputSchema, handler, ...(extras || {}) };
}

export function createSdkMcpServer(opts: {
  name: string;
  version?: string;
  instructions?: string;
  tools?: SdkMcpToolDefinition[];
}): McpSdkServerConfigWithInstance {
  const instance = new McpServer(
    { name: opts.name, version: opts.version || '1.0.0' },
    { capabilities: { tools: {} }, ...(opts.instructions ? { instructions: opts.instructions } : {}) },
  );
  const meta = new Map<string, ToolMeta>();
  for (const t of opts.tools || []) {
    instance.registerTool(
      t.name,
      { description: t.description, inputSchema: t.inputSchema as any, ...(t.annotations ? { annotations: t.annotations as any } : {}) },
      t.handler as any,
    );
    meta.set(t.name, { alwaysLoad: !!t.alwaysLoad, searchHint: t.searchHint });
  }
  return { type: 'sdk', name: opts.name, instance, [TOOL_META]: meta };
}
