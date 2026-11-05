// 模型表: 窗口大小与单次最大输出。按 id 正则匹配, 先中先得; 认不出的走最后一条兜底。
// 这里的窗口会作为 result.modelUsage[model].contextWindow 报给宿主 —— butler 把它当「SDK 档」,
// 宿主配置里写死的窗口仍然优先(见 butler core/agent/window.js)。
// 只写官方明确公布的值: 中转站可能把同一个模型限得更小, 那由用户在宿主的 windows.json 按凭据写。

export interface ModelInfo { contextWindow: number; maxOutput: number }

// 数值逐条取自各家官方文档(2026-11-05 核): 窗口照抄; 输出上限取官方值与 32K 中较小的那个 ——
// 有的服务商把输出算进窗口(max_tokens 设大了, 长对话会被拒), 32K 是够用又稳妥的单次上限。
// 官方没写清的型号不收, 认不出的走最后的兜底。正则不锚开头, 网关常加 `openai/` 之类前缀。
const D = '(-\\d{4}-\\d{2}-\\d{2})?$';   // 可选的日期快照后缀
const TABLE: Array<[RegExp, ModelInfo]> = [
  // Anthropic
  [/\[1m\]$/i,                                        { contextWindow: 1_000_000, maxOutput: 32_000 }],
  [/claude-(opus-4-[78]|opus-5|sonnet-5|fable-5)/i,   { contextWindow: 1_000_000, maxOutput: 32_000 }],
  [/claude-(opus|sonnet)/i,                           { contextWindow: 200_000,   maxOutput: 32_000 }],
  [/claude-haiku/i,                                   { contextWindow: 200_000,   maxOutput: 32_000 }],
  // OpenAI  developers.openai.com/api/docs/models/<id>
  [new RegExp('gpt-5(\\.1)?(-mini|-nano|-pro)?' + D, 'i'), { contextWindow: 400_000, maxOutput: 32_000 }],
  [new RegExp('gpt-4\\.1(-mini|-nano)?' + D, 'i'),      { contextWindow: 1_047_576, maxOutput: 32_000 }],
  [new RegExp('gpt-4o' + D, 'i'),                       { contextWindow: 128_000,   maxOutput: 16_384 }],
  [new RegExp('(^|/)(o3|o4-mini)' + D, 'i'),            { contextWindow: 200_000,   maxOutput: 32_000 }],
  // Google  aistudio.google.com/docs/models/<id>
  [/gemini-(2\.5|3(\.\d+)?)-/i,                        { contextWindow: 1_048_576, maxOutput: 32_000 }],
  // DeepSeek  api-docs.deepseek.com/quick_start/pricing
  [/deepseek-(flash|v4-flash|v4\.1-flash|v4-pro)/i,   { contextWindow: 1_000_000, maxOutput: 32_000 }],
  // 阿里 Qwen  alibabacloud.com/help/en/model-studio/<id>
  [/qwen-plus-2025-0[1-7]/i,                          { contextWindow: 131_072,   maxOutput: 8_192 }],
  [/qwen-max/i,                                       { contextWindow: 32_768,    maxOutput: 8_192 }],
  [/qwen-(plus|flash)|qwen3-coder-flash|qwen3\.[78]-(max|plus|flash)/i, { contextWindow: 1_000_000, maxOutput: 32_000 }],
  // 智谱 GLM  docs.bigmodel.cn/cn/guide/models/text/<id>
  [/glm-5\.3/i,                                       { contextWindow: 1_000_000, maxOutput: 32_000 }],
  [/glm-(5(\.1)?|4\.[67])($|[^.\d])/i,                { contextWindow: 200_000,   maxOutput: 32_000 }],
  [/glm-4\.5/i,                                       { contextWindow: 128_000,   maxOutput: 32_000 }],
  [/glm-4-long/i,                                     { contextWindow: 1_000_000, maxOutput: 4_096 }],
  [/glm-4-airx/i,                                     { contextWindow: 8_000,     maxOutput: 4_096 }],
  [/glm-4-plus/i,                                     { contextWindow: 128_000,   maxOutput: 4_096 }],
  [/glm-4-(air|flash)/i,                              { contextWindow: 128_000,   maxOutput: 16_384 }],
  // Moonshot Kimi  platform.kimi.ai/docs/pricing/chat
  [/kimi-k3/i,                                        { contextWindow: 1_048_576, maxOutput: 32_000 }],
  [/kimi-k2\.[67]/i,                                  { contextWindow: 262_144,   maxOutput: 32_000 }],
  // MiniMax  platform.minimax.io/docs/guides/models-intro
  [/minimax-m3/i,                                     { contextWindow: 1_000_000, maxOutput: 32_000 }],
  // 字节豆包  docs.volcengine.com/docs/82379/1330310 —— 窗口按官方的「最大输入」写(2.0 系窗口 256K、最大输入 224K)
  [/doubao-seed-evolving|doubao-seed-2-1-(pro|lite)-260915/i, { contextWindow: 1_000_000, maxOutput: 32_000 }],
  [/doubao-seed-2-1-/i,                               { contextWindow: 256_000,   maxOutput: 32_000 }],
  [/doubao-seed-2-0-/i,                               { contextWindow: 224_000,   maxOutput: 32_000 }],
  [/doubao-seed-character/i,                          { contextWindow: 96_000,    maxOutput: 32_000 }],
  // xAI  docs.x.ai/developers/models/<id>
  [/grok-4\.7/i,                                      { contextWindow: 500_000,   maxOutput: 32_000 }],
  // Mistral  docs.mistral.ai/models
  [/mistral-large-4/i,                                { contextWindow: 1_000_000, maxOutput: 32_000 }],
];

const FALLBACK: ModelInfo = { contextWindow: 200_000, maxOutput: 16_384 };

export function modelInfo(id: string): ModelInfo {
  for (const [re, info] of TABLE) if (re.test(id)) return info;
  return FALLBACK;
}

// 发给服务端时去掉 butler 的 [1m] 后缀 —— 那是 Claude Code 的本地约定, 不是 API 认的型号名。
export function apiModelId(id: string): string {
  return id.replace(/\[1m\]$/i, '');
}
