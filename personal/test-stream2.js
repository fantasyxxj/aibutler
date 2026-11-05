// test-stream2.js — 验证「持久流式 query」: 一个 query 连续跑多轮(不 close), 且中途可插话
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
function userMsg(text) { return { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null }; }

async function main() {
  const { query } = await loadSdk();
  const queue = makeMsgQueue();
  const q = query({ prompt: queue, options: { cwd: BUTLER_DIR, permissionMode: 'bypassPermissions', strictMcpConfig: true, allowedTools: ['Bash'] } });

  let turnResolve = null;
  const nextTurnDone = () => new Promise((r) => { turnResolve = r; });

  // 后台消费循环: 路由消息, result(非中断)时判定一轮结束
  const consumer = (async () => {
    let cur = '';
    for await (const msg of q) {
      if (msg.type === 'assistant') { for (const b of (msg.message?.content || [])) if (b.type === 'text' && b.text) { cur += b.text; } }
      else if (msg.type === 'result') {
        if (msg.subtype === 'interrupt' || msg.subtype === 'error_during_execution') {
          console.log('  [吞掉打断/错误 result:', msg.subtype, ']');
          continue; // 不结束整体循环, 等下一条被推入的消息
        }
        const done = turnResolve; turnResolve = null; const text = cur; cur = '';
        if (done) done(text);
      }
    }
  })();

  console.log('===== 轮1 =====');
  let p = nextTurnDone(); queue.push(userMsg('一句话: 1+1=?')); console.log('  答:', JSON.stringify((await p).slice(0, 50)));

  console.log('===== 轮2 (同一 query, 不 close) =====');
  p = nextTurnDone(); queue.push(userMsg('一句话: 天空通常什么颜色?')); console.log('  答:', JSON.stringify((await p).slice(0, 50)));

  console.log('===== 轮3: 长任务 + 中途插话打断 =====');
  p = nextTurnDone();
  queue.push(userMsg('用 Bash sleep 2 五次, 报数 1到5。'));
  await new Promise((r) => setTimeout(r, 3000));  // 等它跑起来
  console.log('  >>> interrupt + 插话: 改问"猫的英文"');
  await q.interrupt().catch(() => {});
  queue.push(userMsg('别管上面。一句话: 猫用英文怎么说?'));
  console.log('  答(插话后):', JSON.stringify((await p).slice(0, 60)));

  queue.close();
  await consumer;
  console.log('\n✅ 持久多轮 + 插话 全部跑通');
  process.exit(0);
}
main().catch((e) => { console.error('FATAL:', String(e).split('\n')[0]); process.exit(1); });
