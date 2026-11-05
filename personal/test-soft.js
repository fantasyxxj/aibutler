// test-soft.js — 测「软插话」: 多步任务进行中 push 新消息但【不 interrupt】,
// 看模型是在步骤之间(间歇)读到它并改道, 还是要等整轮跑完才读。
const BUTLER_DIR = __dirname;
let _sdk = null;
async function loadSdk() { if (!_sdk) _sdk = await import('@anthropic-ai/claude-agent-sdk'); return _sdk; }
function makeMsgQueue() {
  const buf = []; let waiter = null; let closed = false;
  return {
    push(m) { if (closed) return; if (waiter) { const w = waiter; waiter = null; w({ value: m, done: false }); } else buf.push(m); },
    close() { closed = true; if (waiter) { const w = waiter; waiter = null; w({ value: undefined, done: true }); } },
    [Symbol.asyncIterator]() {
      return { next() {
        if (buf.length) return Promise.resolve({ value: buf.shift(), done: false });
        if (closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((res) => { waiter = res; });
      }, return() { closed = true; return Promise.resolve({ value: undefined, done: true }); } };
    },
  };
}
function userMsg(text, extra) { return Object.assign({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null }, extra || {}); }

const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

async function trial(label, pushExtra) {
  console.log(`\n===== ${label} =====`);
  const { query } = await loadSdk();
  const queue = makeMsgQueue();
  queue.push(userMsg('用 Bash 依次执行 sleep 1 共五次(每次单独一条命令), 每次完成后只输出一个数字, 从1数到5。不要一条命令搞定。'));
  const q = query({ prompt: queue, options: { cwd: BUTLER_DIR, permissionMode: 'bypassPermissions', strictMcpConfig: true, allowedTools: ['Bash'] } });

  let pushed = false;
  (async () => {
    await new Promise((r) => setTimeout(r, 2500));
    console.log(`  ${ts()} >>> push 插话(不 interrupt): "停! 改成只说 DOG"  extra=${JSON.stringify(pushExtra || {})}`);
    queue.push(userMsg('停! 忽略数数。只回一个词: DOG', pushExtra));
    pushed = true;
  })();

  let resultCount = 0;
  for await (const msg of q) {
    if (msg.type === 'assistant') {
      for (const b of (msg.message?.content || [])) {
        if (b.type === 'text' && b.text.trim()) console.log(`  ${ts()} [text] ${JSON.stringify(b.text.trim().slice(0, 40))}${pushed ? '  <-插话后' : ''}`);
        if (b.type === 'tool_use') console.log(`  ${ts()} [tool] ${b.name} ${JSON.stringify((b.input && b.input.command) || '').slice(0, 40)}`);
      }
    } else if (msg.type === 'result') {
      resultCount++;
      console.log(`  ${ts()} [result] ${msg.subtype}`);
      if (msg.subtype === 'interrupt' || msg.subtype === 'error_during_execution') continue;
      queue.close();
    }
  }
}

async function main() {
  await trial('A: 普通 push(无 priority)', null);
  await trial('B: push priority=now', { priority: 'now' });
  console.log('\n===== 结束 =====');
  process.exit(0);
}
main().catch((e) => { console.error('FATAL:', String(e).split('\n')[0]); process.exit(1); });
