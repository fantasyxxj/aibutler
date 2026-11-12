// test-marks.js — 重要输出区: 主进程那份存储(side-state.js)与渲染层的纯函数(marks.js)。
// 跑: node personal/test-marks.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const side = require('./side-state');
const marks = require('./renderer/marks');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marks-'));
const s = side.create(() => dir);
const A = '/tmp/persona-a', B = '/tmp/persona-b';

ok(s.read(A).layout === 'tb' && s.read(A).items.length === 0, '没存过 = 上下布局、空清单');
const it = s.add(A, { title: '结论', text: '正文第一行\n第二行', ts: 1000 });
ok(it && it.id && it.title === '结论' && it.text.includes('第二行'), '加一条: 标题和正文原文都存下');
ok(it.seen === false, '上下布局下新挂的算没看过(给角标数)');
ok(s.read(B).items.length === 0, '人格之间互不串');
ok(s.add(A, { title: '  ', text: 'x' }) === null, '没标题不收');
s.add(A, { title: '方案', text: 'y' });
ok(s.setLayout(A, 'lr').items.every((x) => x.seen), '切到左右 = 全部看过');
ok(s.add(A, { title: '路径', text: 'z' }).seen === true, '左右布局下新挂的直接算看过');
ok(s.setLayout(A, 'weird').layout === 'lr', '不认识的布局值不写');
ok(s.remove(A, it.id).items.every((x) => x.id !== it.id), '删一条只删那条');
ok(fs.existsSync(s.fileOf(A)) && path.basename(s.fileOf(A)).length === 21, '一个人格一个文件, 文件名是哈希不是路径');
for (let i = 0; i < side.MAX_ITEMS + 5; i++) s.add(B, { title: `t${i}`, text: '' });
const bi = s.read(B).items;
ok(bi.length === side.MAX_ITEMS && bi[0].title === 't5', `超过 ${side.MAX_ITEMS} 条从最老的丢`);

const pv = marks.preview('# 结论\n\n- 第一条 **重点**\n|---|---|\n第三行\n第四行 {{btn:好}}');
ok(pv === '结论\n第一条 重点\n第三行', '预览: 去掉 markdown 符号和控件印, 取开头三行');
ok(marks.preview('a'.repeat(300)).endsWith('…'), '预览超长截断');
ok('看这个 {{mark:结论}}\n正文'.replace(marks.MARK_TOKEN, '') === '看这个 正文', '存正文时把 {{mark:}} 印抹掉');

const items = [{ id: 'a', title: 'X', ts: 100 }, { id: 'b', title: 'X', ts: 900 }, { id: 'c', title: 'Y', ts: 950 }];
ok(marks.pickForReplay(items, 'X', 880, new Set()).id === 'b', '回放认领: 同标题挑时刻最近的');
ok(marks.pickForReplay(items, 'X', 880, new Set(['b'])).id === 'a', '回放认领: 已被认走的不再认');
ok(marks.pickForReplay(items, 'Z', 880, new Set()) === null, '回放认领: 没有同标题就不认');

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail ? '❌' : '✅'} test-marks: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
