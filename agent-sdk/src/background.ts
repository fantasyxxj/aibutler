// 后台任务: 后台子代理(Agent run_in_background)、工作流(Workflow)、后台命令(Bash run_in_background)和盯梢(Monitor)都挂在这里。
// 消息照 Claude Agent SDK: 开跑发 system/task_started, 过程中发 system/task_progress, 收尾发 system/task_notification;
// 同时往会话收件箱投一条 <task-notification> 用户消息 —— 主代理空着就由它开新的一轮, 正忙就在工具间歇读到(同 CC)。
// 后台任务不随这一轮结束, 只随整个会话关闭而中止。

import { uuid } from './loop.js';

export interface BgRun {
  text: string;
  isError: boolean;
}

export interface BgStart {
  description: string;
  kind: 'local_agent' | 'local_workflow' | 'local_bash' | 'monitor';
  toolUseId?: string;
  prompt?: string;
  workflowName?: string;
  // progress(一行状态, 刚用过的工具名) —— 进任务面板的那一行; event(正文) —— 跑着的时候就投一条通知开新一轮(Monitor 用)
  run(signal: AbortSignal, progress: (summary: string, lastTool?: string) => void, event: (text: string) => void): Promise<BgRun>;
  outputFile?: string;
}

interface Live { ac: AbortController; started: number; toolUses: number }

const RESULT_CAP = 30_000;
const PREFIX: Record<BgStart['kind'], string> = { local_agent: 'a', local_workflow: 'w', local_bash: 'b', monitor: 'm' };
const LABEL: Record<BgStart['kind'], string> = { local_agent: 'Agent', local_workflow: 'Workflow', local_bash: 'Background command', monitor: 'Monitor' };

export class Background {
  private live = new Map<string, Live>();
  private seq = 0;
  private idleWaiters: Array<() => void> = [];
  private closed = false;

  constructor(
    private emit: (m: any) => void,
    private notify: (text: string) => void,
    private sessionId: () => string,
    private log: (s: string) => void,
  ) {}

  get running(): number { return this.live.size; }

  start(o: BgStart): string {
    const id = `${PREFIX[o.kind]}${(++this.seq).toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const ac = new AbortController();
    const rec: Live = { ac, started: Date.now(), toolUses: 0 };
    this.live.set(id, rec);
    const base = () => ({ task_id: id, ...(o.toolUseId ? { tool_use_id: o.toolUseId } : {}), session_id: this.sessionId(), uuid: uuid() });
    this.emit({ type: 'system', subtype: 'task_started', ...base(), description: o.description, task_type: o.kind, is_backgrounded: true,
      ...(o.workflowName ? { workflow_name: o.workflowName } : {}), ...(o.prompt ? { prompt: o.prompt } : {}) });
    const usage = () => ({ total_tokens: 0, tool_uses: rec.toolUses, duration_ms: Date.now() - rec.started });
    const progress = (summary: string, lastTool?: string) => {
      if (lastTool) rec.toolUses++;
      this.emit({ type: 'system', subtype: 'task_progress', ...base(), description: o.description, usage: usage(), summary, ...(lastTool ? { last_tool_name: lastTool } : {}) });
    };
    const event = (text: string) => {
      if (this.closed || ac.signal.aborted) return;
      this.notify(`<task-notification>\n<task-id>${id}</task-id>\n<status>event</status>\n<summary>${LABEL[o.kind]} "${o.description}" event</summary>\n<event>\n${text}\n</event>\n</task-notification>`);
    };
    (async () => {
      let r: BgRun;
      try { r = await o.run(ac.signal, progress, event); } catch (e: any) { r = { text: String(e && e.message ? e.message : e), isError: true }; }
      const status = ac.signal.aborted ? 'stopped' : r.isError ? 'failed' : 'completed';
      const summary = `${LABEL[o.kind]} "${o.description}" ${status}`;
      this.emit({ type: 'system', subtype: 'task_notification', ...base(), status, output_file: o.outputFile || '', summary, usage: usage() });
      // 会话关了就没人收, 不投通知; 单个被叫停的照样告诉主代理
      if (!this.closed) {
        const body = r.text.length > RESULT_CAP ? `${r.text.slice(0, RESULT_CAP)}\n…[truncated: first ${RESULT_CAP} of ${r.text.length} characters]` : r.text;
        this.notify(`<task-notification>\n<task-id>${id}</task-id>\n${o.toolUseId ? `<tool-use-id>${o.toolUseId}</tool-use-id>\n` : ''}`
          + `<status>${status}</status>\n${o.outputFile ? `<output-file>${o.outputFile}</output-file>\n` : ''}<summary>${summary}</summary>\n<result>\n${body}\n</result>\n</task-notification>`);
      }
      // 通知先进收件箱再放行等 idle 的人, 不然它醒来看到的是空收件箱
      this.live.delete(id);
      if (!this.live.size) { const ws = this.idleWaiters; this.idleWaiters = []; for (const w of ws) w(); }
    })().catch((e) => this.log(`[background] ${id} 收尾出错: ${e && e.message}`));
    return id;
  }

  // 全部后台任务收尾(通知已投进收件箱)之后才 resolve; 宿主的输入流结束了也要等它们交完差
  idle(): Promise<void> { return this.live.size ? new Promise((res) => this.idleWaiters.push(res)) : Promise.resolve(); }

  stop(id: string): boolean {
    const r = this.live.get(id);
    if (!r) return false;
    r.ac.abort();
    return true;
  }

  stopAll(): void { this.closed = true; for (const r of this.live.values()) r.ac.abort(); }
}
