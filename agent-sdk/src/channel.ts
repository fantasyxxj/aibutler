// 单生产者 / 单消费者的异步队列。query() 往里推消息, 调用方 for-await 取。
// 关掉之后再推的直接丢; 取空且已关 = 迭代结束。

export class Channel<T> implements AsyncIterable<T> {
  private buf: T[] = [];
  private waiter: ((r: IteratorResult<T>) => void) | null = null;
  private closed = false;

  push(v: T): void {
    if (this.closed) return;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: v, done: false });
    } else {
      this.buf.push(v);
    }
  }

  close(): void {
    this.closed = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: undefined as any, done: true });
    }
  }

  get isClosed(): boolean { return this.closed; }

  next(): Promise<IteratorResult<T>> {
    if (this.buf.length) return Promise.resolve({ value: this.buf.shift() as T, done: false });
    if (this.closed) return Promise.resolve({ value: undefined as any, done: true });
    return new Promise((res) => { this.waiter = res; });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => this.next(),
      return: () => { this.close(); return Promise.resolve({ value: undefined as any, done: true }); },
    };
  }
}

// 用户消息收件箱: 后台把 prompt 迭代器抽干到这里, 循环既能「等下一条」也能「顺手捞走已到的」(软插话)。
export class Inbox<T> {
  private buf: T[] = [];
  private waiters: Array<() => void> = [];
  ended = false;

  constructor(src: AsyncIterable<T>, onError: (e: unknown) => void) {
    (async () => {
      try {
        for await (const m of src) { this.buf.push(m); this.wake(); }
      } catch (e) { onError(e); }
      this.ended = true;
      this.wake();
    })();
  }

  private wake(): void {
    const ws = this.waiters; this.waiters = [];
    for (const w of ws) w();
  }

  // 等到有消息或输入结束; 返回 null = 输入已结束且没有剩余。
  async take(signal?: AbortSignal): Promise<T | null> {
    while (!this.buf.length && !this.ended) {
      if (signal?.aborted) return null;
      await new Promise<void>((res) => {
        this.waiters.push(res);
        signal?.addEventListener('abort', () => res(), { once: true });
      });
    }
    return this.buf.length ? (this.buf.shift() as T) : null;
  }

  drain(): T[] { const out = this.buf; this.buf = []; return out; }

  get pending(): number { return this.buf.length; }
}
