// 有的网关(实测 gptproto)在一条流开头连发几个 id 不同、还没出内容的 message_start, 违反协议。
// Claude Code CLI 遇到就让后到的盖掉前一个接着走; @ai-sdk/anthropic 则直接抛 InvalidResponseDataError,
// 整步判成断流。这里对齐 CLI: 开头那几个只留最后一个, 第一个别的事件一到就原样放行, 之后不再管。

function eventType(block: string): string | null {
  const m = /^event:\s*(\S+)/m.exec(block);
  if (m) return m[1];
  const d = /^data:\s*(\{.*)$/m.exec(block);
  if (!d) return null;
  try { return JSON.parse(d[1]).type || null; } catch { return null; }
}

export function dedupeMessageStart(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let buf = '';
  let held: string | null = null;   // 还没放出去的最后一个 message_start
  let passthrough = false;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctl) {
      if (passthrough) { ctl.enqueue(chunk); return; }
      buf += dec.decode(chunk, { stream: true });
      let i: number;
      while (!passthrough && (i = buf.search(/\r?\n\r?\n/)) >= 0) {
        const sep = /\r?\n\r?\n/.exec(buf.slice(i))![0];
        const block = buf.slice(0, i + sep.length);
        buf = buf.slice(i + sep.length);
        if (eventType(block) === 'message_start') { held = block; continue; }
        if (eventType(block) === 'ping') { ctl.enqueue(enc.encode(block)); continue; }
        if (held) ctl.enqueue(enc.encode(held));
        held = null;
        ctl.enqueue(enc.encode(block));
        passthrough = true;
      }
      if (passthrough && buf) { ctl.enqueue(enc.encode(buf)); buf = ''; }
    },
    flush(ctl) {
      const rest = (held || '') + buf + dec.decode();
      if (rest) ctl.enqueue(enc.encode(rest));
    },
  }));
}

// 包一层 fetch: 只动流式(text/event-stream)的成功响应, 其余原样返回。
export function withMessageStartDedupe(base: typeof fetch = fetch): typeof fetch {
  return (async (url: any, init?: any) => {
    const r = await base(url, init);
    const ct = r.headers.get('content-type') || '';
    if (!r.ok || !r.body || !ct.includes('text/event-stream')) return r;
    return new Response(dedupeMessageStart(r.body), { status: r.status, statusText: r.statusText, headers: r.headers });
  }) as typeof fetch;
}
