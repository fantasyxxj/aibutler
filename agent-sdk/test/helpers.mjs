// 测试共用: 假的 Anthropic 流式服务端(按脚本逐次回 SSE), 以及消息收集器。

export function sse(events) {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

// 一步的 SSE: parts = [{text}] | [{thinking}] | [{tool:{id,name,input}}], 可混排
export function anthropicStep(parts, { stop = null, usage = { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 0 } } = {}) {
  const ev = [{ type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [], usage: { ...usage, output_tokens: 1 } } }];
  parts.forEach((p, i) => {
    if (p.text != null) {
      ev.push({ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } });
      ev.push({ type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: p.text } });
      ev.push({ type: 'content_block_stop', index: i });
    } else if (p.thinking != null) {
      ev.push({ type: 'content_block_start', index: i, content_block: { type: 'thinking', thinking: '', signature: '' } });
      ev.push({ type: 'content_block_delta', index: i, delta: { type: 'thinking_delta', thinking: p.thinking } });
      ev.push({ type: 'content_block_delta', index: i, delta: { type: 'signature_delta', signature: 'sig' } });
      ev.push({ type: 'content_block_stop', index: i });
    } else if (p.tool) {
      ev.push({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: p.tool.id, name: p.tool.name, input: {} } });
      ev.push({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(p.tool.input) } });
      ev.push({ type: 'content_block_stop', index: i });
    }
  });
  const hasTool = parts.some((p) => p.tool);
  ev.push({ type: 'message_delta', delta: { stop_reason: stop || (hasTool ? 'tool_use' : 'end_turn') }, usage: { output_tokens: 20 } });
  ev.push({ type: 'message_stop' });
  return sse(ev);
}

// 按脚本依次回应; 脚本项是 SSE 文本, 或 {status, body} 表示出错, 或函数(拿到请求体自己决定)
export function fakeFetch(script) {
  const calls = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body, headers: init.headers });
    let item = script.shift();
    if (typeof item === 'function') item = await item(body, init);
    if (item == null) throw new Error('fakeFetch: script exhausted');
    if (typeof item === 'object' && item.status) {
      return new Response(JSON.stringify(item.body || { type: 'error', error: { type: 'x', message: 'boom' } }), { status: item.status, headers: { 'content-type': 'application/json' } });
    }
    if (typeof item === 'object' && item.hang) {
      // 挂起直到被中止
      return new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    }
    return new Response(item, { headers: { 'content-type': 'text/event-stream' } });
  };
  fn.calls = calls;
  return fn;
}

export function userMsg(text, uuid = `u-${Math.random().toString(36).slice(2, 8)}`) {
  return { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null, uuid };
}

// 推送式 prompt(同 butler 的 makeMsgQueue)
export function queue() {
  const buf = []; let waiter = null; let closed = false;
  return {
    push(m) { if (waiter) { const w = waiter; waiter = null; w({ value: m, done: false }); } else buf.push(m); },
    close() { closed = true; if (waiter) { const w = waiter; waiter = null; w({ value: undefined, done: true }); } },
    [Symbol.asyncIterator]() {
      return { next() {
        if (buf.length) return Promise.resolve({ value: buf.shift(), done: false });
        if (closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((r) => { waiter = r; });
      }, return() { closed = true; return Promise.resolve({ done: true }); } };
    },
  };
}

// 收消息直到第 n 个 result
export async function collectUntilResults(q, n) {
  const out = [];
  let seen = 0;
  for await (const m of q) {
    out.push(m);
    if (m.type === 'result' && ++seen >= n) break;
  }
  return out;
}

export const GATEWAY_ENV = { ANTHROPIC_BASE_URL: 'http://gw.test', ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_API_KEY: 'tok' };
