// @butler/agent-sdk —— 多模型 agent SDK。
// 导出面与 @anthropic-ai/claude-agent-sdk 中 butler 用到的那部分同名同签名, 换包即可切换。
// 本入口只用 fetch 与标准 JS, 不碰 Node API; 桌面专用工具在 '@butler/agent-sdk/node'。

export { query, Query } from './query.js';
export { tool, createSdkMcpServer } from './mcp/sdk-server.js';
export type { BuiltinTool, ToolOutput, ToolContext } from './tools/registry.js';
export { modelInfo } from './providers/models.js';
export { WebFetch, WebSearch, webTools, htmlToText } from './tools/web.js';

export const SDK_KIND = 'butler-agent-sdk';
