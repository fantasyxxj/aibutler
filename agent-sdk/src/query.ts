// query({ prompt, options }) → Query: 一个 async iterator, 外加 interrupt() / getContextUsage()。
// 与 Claude Agent SDK 一样是长连接: prompt 是持续推消息的 async iterable, 一条(或攒着的几条)
// 消息跑完一轮发一个 result, 然后等下一条; prompt 结束或 abortController 中止才退出。

import { Inbox } from './channel.js';
import { runTurn } from './loop.js';
import { Session } from './session.js';
import { estimateContext } from './context.js';

export interface QueryArgs { prompt: AsyncIterable<any> | string; options?: any }

export class Query implements AsyncIterableIterator<any> {
  private s: Session;
  private outer = new AbortController();
  private turnAc: AbortController | null = null;
  private turnDone: Promise<void> | null = null;
  private ready: Promise<void>;
  private finished: Promise<void>;

  constructor(args: QueryArgs) {
    const opts = args.options || {};
    this.s = new Session(opts);
    const ext: AbortController | undefined = opts.abortController;
    if (ext) {
      if (ext.signal.aborted) this.outer.abort();
      else ext.signal.addEventListener('abort', () => this.outer.abort(), { once: true });
    }
    this.outer.signal.addEventListener('abort', () => { this.turnAc?.abort(); }, { once: true });
    const src = typeof args.prompt === 'string' ? oneShot(args.prompt) : args.prompt;
    this.ready = this.s.setup();
    this.finished = this.run(src);
  }

  private async run(src: AsyncIterable<any>): Promise<void> {
    try {
      await this.ready;
      this.s.inbox = new Inbox(src, (e) => this.s.log(`[query] prompt 迭代出错: ${(e as any)?.message}`));
      const oneShotMode = !!(src as any).__oneShot;
      while (!this.outer.signal.aborted) {
        const first = await this.s.inbox.take(this.outer.signal);
        if (first == null) {
          // 宿主不再发话了, 但还有后台任务在跑: 等它们交差, 通知进来再跑一轮
          if (this.s.bg.running && !oneShotMode && !this.outer.signal.aborted) { await this.s.bg.idle(); continue; }
          break;
        }
        const batch = [first, ...this.s.inbox.drain()];
        this.turnAc = new AbortController();
        const turnSignal = this.turnAc.signal;
        if (this.outer.signal.aborted) this.turnAc.abort();
        this.turnDone = runTurn(this.s, batch, turnSignal).catch((e) => {
          this.s.log(`[query] 回合异常: ${e && e.stack ? e.stack : e}`);
          this.s.emit({ type: 'result', subtype: 'error_during_execution', is_error: true, result: String(e && e.message ? e.message : e), session_id: this.s.sessionId, num_turns: 0, duration_ms: 0, duration_api_ms: 0, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [] });
        });
        await this.turnDone;
        this.turnAc = null;
        this.turnDone = null;
        if (oneShotMode) break;
      }
    } catch (e: any) {
      this.s.log(`[query] 启动失败: ${e && e.stack ? e.stack : e}`);
    } finally {
      await this.s.close();
    }
  }

  // 打断当前这一轮(不结束会话): 这一轮发 result(error_during_execution), 之后照常等下一条消息
  async interrupt(): Promise<void> {
    if (!this.turnAc) return;
    const done = this.turnDone;
    this.turnAc.abort();
    if (done) await done;
  }

  async getContextUsage(): Promise<any> {
    await this.ready;
    return estimateContext(this.s);
  }

  // —— async iterator ——
  next(): Promise<IteratorResult<any>> { return this.s.out.next(); }

  async return(): Promise<IteratorResult<any>> {
    this.outer.abort();
    this.s.out.close();
    await this.finished.catch(() => {});
    return { value: undefined, done: true };
  }

  async throw(e?: any): Promise<IteratorResult<any>> {
    await this.return();
    throw e;
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<any> { return this; }
}

function oneShot(text: string): AsyncIterable<any> {
  const it = {
    __oneShot: true,
    async *[Symbol.asyncIterator]() {
      yield { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
    },
  };
  return it;
}

export function query(args: QueryArgs): Query {
  return new Query(args);
}
