// test-widget-gate.js — the personal screen holds broken controls back and asks once for a rewrite;
// a question with nothing to tap asks for the buttons; either one reminds the next turns.
// 跑法: node personal/test-widget-gate.js
'use strict';
const assert = require('assert');
const host = require('./widget-gate-host');

let n = 0;
const ok = (label, fn) => { fn(); n++; console.log(`  ✓ ${label}`); };
const fakeButler = () => {
  const b = { name: 'T', submitted: [], lessons: [], _turnMetas: [] };
  b.submit = (text, _x, opts) => { b.submitted.push({ text, opts }); return Promise.resolve(); };
  b.noteWidgetMistake = (p, n) => b.lessons.push([p, n]);
  return b;
};
const render = (k, v) => `${k}::${JSON.stringify(v)}`;
const stream = (g, chunks) => chunks.map((c) => g.text(c)).join('') + g.blockDone();

ok('good buttons stream through; the turn result is kept as is', () => {
  const b = fakeButler(), g = host.attach(b, render);
  const t = '好了。{{btn:继续}} {{btn:先这样}}';
  assert.strictEqual(stream(g, ['好了。{{bt', 'n:继续}} {{btn:先这样}}']), t);
  assert.strictEqual(g.settle(t, { screen: true }), t);
  assert.strictEqual(b.submitted.length, 0);
});

ok('the four common errors are held back, taken out of history and sent back once', () => {
  for (const bad of ['{{in:t|type=clock}} {{btn:好}}', '{{in:t|value=21:00}} {{btn:用 21:00 最后一单}}', '```buttons\n[甲] [乙]\n```', '```json\n{"type":"buttons","options":["甲","乙"]}\n```', '{"type":"buttons","options":["甲","乙"]}', '{{pick:x}} {{btn:好}}', '```html\n<form>\n  <button name="c" value="甲">甲</button>\n</form>\n```', '要吗？ {{btn:要}}\n\n还有一件事。 {{btn:好}}']) {
    const b = fakeButler(), g = host.attach(b, render);
    const lead = '说明。' + bad.slice(0, bad.search(/[{<`]/));   // words before the first possible control stream on
    const shown = stream(g, ['说明。', bad]);
    assert.strictEqual(shown, lead, bad);
    const kept = g.settle('说明。' + bad, { screen: true });
    assert.strictEqual(kept, lead.trim(), bad);
    assert.strictEqual(b.submitted.length, 1);
    assert.ok(b.submitted[0].text.startsWith('main/widget_retry::'));
    assert.ok(b.submitted[0].opts.turnMeta.widgetRetry);
    assert.strictEqual(b.lessons.length, 1);
  }
});

ok('a control inside code is shown and only hinted once; inbox turns are not checked at all', () => {
  const b = fakeButler(), g = host.attach(b, render);
  assert.strictEqual(stream(g, ['写法是 `{{btn:确认}}`']), '写法是 `{{btn:确认}}`');
  g.settle('写法是 `{{btn:确认}}`', { screen: true });
  assert.ok(!b.submitted.some((x) => x.text.startsWith('main/widget_retry::')), 'never a rewrite');
  assert.strictEqual(b.lessons[0][1], 1, 'a one-turn hint');
  const c = fakeButler(); c._turnSourceKind = 'inbox';
  const h = host.attach(c, render);
  assert.strictEqual(stream(h, ['要吗？', '{{pick:x}}']), '要吗？{{pick:x}}');
  h.settle('要吗？{{pick:x}}', { screen: false });
  assert.strictEqual(c.submitted.length + c.lessons.length, 0);
});

ok('a form in a ```html fence beside real buttons is code being shown: hinted, not held; an svg fence is a picture', () => {
  const b = fakeButler(), g = host.attach(b, render);
  const t = '例子:\n```html\n<button>保存</button>\n```\n{{btn:好}}';
  assert.strictEqual(stream(g, [t]), t);
  g.settle(t, { screen: true });
  assert.ok(!b.submitted.some((x) => x.text.startsWith('main/widget_retry::')), 'never a rewrite');
  assert.strictEqual(b.lessons[0][1], 1, 'a one-turn hint');
  const gate = require('../core/widget-gate');
  const kinds = ['in', 'sel', 'pick', 'picks', 'btn', 'cmd'];
  assert.deepStrictEqual(gate.check('```svg\n<svg><text>button</text></svg>\n```', { kinds }), []);
  assert.deepStrictEqual(gate.check('```html\n<div>hi</div>\n```', { kinds }), []);
});

ok('personal markers may not carry a `}` inside (md.js:333) — that one is malformed', () => {
  const b = fakeButler(), g = host.attach(b, render);
  assert.strictEqual(stream(g, ['{{btn:a}b}}']), '');
});

ok('a question with nothing to tap on this screen asks for the buttons; not on other channels', () => {
  const b = fakeButler(), g = host.attach(b, render);
  g.settle('要我现在改吗？', { screen: true });
  assert.ok(b.submitted[0].text.startsWith('main/widget_buttons_retry::'));
  const c = fakeButler(), h = host.attach(c, render);
  h.settle('要我现在改吗？', { screen: false });
  assert.strictEqual(c.submitted.length, 0);
});

ok('the rewrite turn itself is never sent back again', () => {
  const b = fakeButler(); b._turnMetas = [{ widgetRetry: true }];
  const g = host.attach(b, render);
  stream(g, ['{{pick:x|a,b}}']);
  g.settle('{{pick:x|a,b}}', { screen: true });
  assert.strictEqual(b.submitted.length, 0);
});

ok('main.js wires the gate into the stream, the text-done, the discard and the result', () => {
  const main = require('fs').readFileSync(require('path').join(__dirname, 'main.js'), 'utf8');
  assert.ok(/widgetGate\.text\(stripSsmlTags\(s\.hiddenFilter\(t\)\)\)/.test(main));
  assert.ok(/s\.widgetGate\.blockDone\(\)/.test(main) && /s\.widgetGate\.discardBlock\(\)/.test(main));
  assert.ok(/s\.widgetGate\.settle\(/.test(main));
});

console.log(`\n✅ test-widget-gate: ${n} pass / 0 fail`);
