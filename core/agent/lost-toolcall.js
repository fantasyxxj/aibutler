// 「工具调用被当成正文吐出来」的判定 —— 纯函数, 无状态, 拿历史样本直接灌得动。
//
// 症状: 模型想调工具, 但那次调用没变成 tool_use 结构块, 整段 XML 当普通文本流了出来。
// 后果不是难看 —— **那次调用等于没发出, 而模型以为自己调过了**, 后面的话都建在空气上。
// 两个互不相干的根因同一症状: ① 网关翻译失败(实测粘一个自己的脚手架碎片 `count`)
// ② 模型自己把标签前缀写坏(实测 claude-haiku 在正确前缀前多粘了 `an`)。
//
// 🔴 判据一个字都不看那个坏掉的词 —— 词是随机的, 只看结构。
// 🔴 宁漏勿误: 漏检最坏是维持现状, 误伤会让模型把一件已经做成的带副作用的事再做一遍。
//    全历史 5579 份 transcript 只 3 例真泄漏, 而"我正在正文里讨论这些标签"有 5 例 —— 也就是说
//    判据松一格, 多数命中都是误伤。所以三条硬条件缺一不可:
//    ① invoke 标签**紧跟着** parameter 标签(连续的完整调用体, 不是文中各自出现)
//    ② 工具名在本轮真实注册的工具表里
//    ③ 不在反引号 / ``` 代码块里(讨论它必然带反引号)

'use strict';

// 命名空间前缀可有可无、可以坏掉, 所以只要求它长得像个前缀, 不认具体是哪个词。
// 两个标签之间只允许空白 —— 中间一旦插进人话, 那就是在讨论而不是在调用。
const CALL_BODY = /<(?:[A-Za-z][\w.-]*:)?invoke\s+name\s*=\s*"([^"\n]{1,120})"\s*>\s*<(?:[A-Za-z][\w.-]*:)?parameter\s+name\s*=/g;

// 成对的 ``` 块和行内反引号整段挖掉; 剩下一个落单的 ``` 说明后面整段都在未闭合的块里。
function stripCode(text) {
  let s = String(text).replace(/```[\s\S]*?```/g, ' ');
  const open = s.indexOf('```');
  if (open >= 0) s = s.slice(0, open);
  return s.replace(/`[^`\n]*`/g, ' ');
}

// 命中返回 { name }(第一个能对上注册表的工具名), 否则 null。
// knownTools 传不进来(建流前/测试桩)就一律不判 —— 没有注册表就没有条件②。
function detectLostToolCall(text, knownTools) {
  if (!text || !knownTools || !knownTools.size) return null;
  const body = stripCode(text);
  CALL_BODY.lastIndex = 0;
  let m;
  while ((m = CALL_BODY.exec(body))) {
    const name = m[1].trim();
    if (knownTools.has(name)) return { name };
  }
  return null;
}

module.exports = { detectLostToolCall };
