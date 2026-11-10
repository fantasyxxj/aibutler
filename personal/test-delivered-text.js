// test-delivered-text.js — the reply handed out is only the last step's words, like the Claude Code CLI result
// 运行: node test-delivered-text.js
require('./host-wiring');
const { deliveredText } = require('../core/agent/util');

let pass = 0, fail = 0;
const t = (name, ok, extra = '') => { if (ok) { pass++; console.log(`  ✅ ${name}${extra ? ' · ' + extra : ''}`); } else { fail++; console.error(`  ❌ ${name}${extra ? ' · ' + extra : ''}`); } };

const narr = '让我先查一下。';
const cur = `${narr}\n\n本周有 1 件预约。`;
t('有工具调用: 只交最后一步', deliveredText(cur, narr.length, 0) === '本周有 1 件预约。', JSON.stringify(deliveredText(cur, narr.length, 0)));
t('没有工具调用: 整段交, 去掉开头空白', deliveredText('\n\n\n只有一段', 0, 0) === '只有一段');
const hint = '接下来要用手机收验证码。';
t('最后一步只有按钮: 带上前一步的说明', deliveredText(`${hint}\n\n{{btn:接入 LINE}}`, hint.length, 0) === `${hint}\n\n{{btn:接入 LINE}}`);
const three = 'A 过程。B 说明。{{btn:x}}';
t('只带前一步, 不带更早的', deliveredText(three, 'A 过程。B 说明。'.length, 'A 过程。'.length) === 'B 说明。\n\n{{btn:x}}', JSON.stringify(deliveredText(three, 'A 过程。B 说明。'.length, 'A 过程。'.length)));
t('重试撤回后边界越界: 不交空回复', deliveredText('abc', 10, 5) === 'abc');
t('最后以工具调用收尾、没有新话: 交出过程那句, 不交空', deliveredText(narr, narr.length, 0) === narr);

console.log(`\n${fail ? '❌' : '✅'} test-delivered-text: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
