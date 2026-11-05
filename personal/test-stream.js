// test-stream.js — 隔离验证 SDK streaming-input + interrupt(不碰 app)
// 目标: 搞清 1)流式输入正确消息格式 2)interrupt 能否打断 3)打断后能否接住新消息
// 跑: node test-stream.js
const path = require('path');
const BUTLER_DIR = __dirname;

let _sdk = null;
async function loadSdk() { if (!_sdk) _sdk = await import('@anthropic-ai/claude-agent-sdk'); return _sdk; }

// 可推送异步消息队列
function makeMsgQueue() {
  const buf = []; let waiter = null; let closed = false;
  return {
    push(m) { if (closed) return; if (waiter) { const w = waiter; waiter = null; w({ value: m, done: false }); } else buf.push(m); },
    close() { closed = true; if (waiter) { const w = waiter; waiter = null; w({ value: undefined, done: true }); } },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (buf.length) return Promise.resolve({ value: buf.shift(), done: false });
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((res) => { waiter = res; });
        },
        return() { closed = true; return Promise.resolve({ value: undefined, done: true }); },
      };
    },
  };
}

// 用 text-block 数组作 content(而非字符串) —— 怀疑上次报错就是 content 用了字符串
function userMsg(text) {
  return { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null };
}

async function main() {
  const { query } = await loadSdk();
  const baseOpts = {
    cwd: BUTLER_DIR, permissionMode: 'bypassPermissions', strictMcpConfig: true,
    allowedTools: ['Bash'],
  };

  // ===== 测试 1: 流式输入跑通一轮 =====
  console.log('\n===== TEST 1: streaming-input 基础一轮 =====');
  {
    const queue = makeMsgQueue();
    queue.push(userMsg('用一句话说你在。'));
    const q = query({ prompt: queue, options: baseOpts });
    let got = '';
    try {
      for await (const msg of q) {
        console.log('  <msg>', msg.type, msg.subtype || '');
        if (msg.type === 'assistant') for (const b of (msg.message?.content || [])) if (b.type === 'text') got += b.text;
        if (msg.type === 'result') { queue.close(); }
      }
      console.log('  ✅ TEST1 完成, 回复:', JSON.stringify(got.slice(0, 60)));
    } catch (e) { console.log('  ❌ TEST1 报错:', String(e).split('\n')[0]); }
  }

  // ===== 测试 2: interrupt 打断一个多步任务 =====
  console.log('\n===== TEST 2: interrupt 打断多步任务 =====');
  {
    const queue = makeMsgQueue();
    queue.push(userMsg('用 Bash 依次 sleep 2 五次(每次单独一条命令), 每次完说一个数字 1到5。'));
    const q = query({ prompt: queue, options: baseOpts });
    let steps = 0; let interrupted = false; let sawInterruptResult = false;
    try {
      for await (const msg of q) {
        console.log('  <msg>', msg.type, msg.subtype || '');
        if (msg.type === 'assistant') {
          steps++;
          if (steps === 1 && !interrupted) {   // 第一步后打断
            interrupted = true;
            console.log('  >>> 调用 interrupt()');
            q.interrupt().then(() => console.log('  >>> interrupt() resolved')).catch((e) => console.log('  >>> interrupt err', String(e).split('\n')[0]));
          }
        }
        if (msg.type === 'result') {
          if (msg.subtype === 'interrupt') sawInterruptResult = true;
          queue.close();
        }
      }
      console.log(`  ${sawInterruptResult ? '✅' : '⚠️'} TEST2 结束, 收到 interrupt result: ${sawInterruptResult}, 步数: ${steps}`);
    } catch (e) { console.log('  ❌ TEST2 报错:', String(e).split('\n')[0]); }
  }

  // ===== 测试 3: 打断后同一 query 接住新消息 =====
  console.log('\n===== TEST 3: 打断后推入新消息, 看能否被处理 =====');
  {
    const queue = makeMsgQueue();
    queue.push(userMsg('用 Bash sleep 2 三次, 报数 1到3。'));
    const q = query({ prompt: queue, options: baseOpts });
    let steps = 0; let pushed = false; let secondAnswered = false;
    try {
      for await (const msg of q) {
        console.log('  <msg>', msg.type, msg.subtype || '');
        if (msg.type === 'assistant') {
          steps++;
          for (const b of (msg.message?.content || [])) if (b.type === 'text' && b.text) {
            if (pushed && /改道|狗|dog|插话/i.test(b.text)) secondAnswered = true;
          }
          if (steps === 1 && !pushed) {
            pushed = true;
            console.log('  >>> interrupt + push 新消息(问: 一句话说"狗"用英文)');
            await q.interrupt().catch(() => {});
            queue.push(userMsg('别管上面了。一句话: 狗用英文怎么说?'));
          }
        }
        if (msg.type === 'result') {
          // 不立即 close: 打断后还想让第二条被处理; 若已答第二条或再次 result 就 close
          if (msg.subtype === 'interrupt') { console.log('  >>> (interrupt result, 继续等第二条被处理)'); }
          else { queue.close(); }
        }
      }
      console.log(`  ${secondAnswered ? '✅' : '⚠️'} TEST3 结束, 第二条被处理: ${secondAnswered}, 步数: ${steps}`);
    } catch (e) { console.log('  ❌ TEST3 报错:', String(e).split('\n')[0]); }
  }

  console.log('\n===== 全部测试结束 =====');
  process.exit(0);
}
main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
