// Agent isolation:"worktree" —— 给子代理开一份临时 git worktree(新分支), 它在那份副本里改, 不碰主目录。
// 收尾: 没改动就删掉 worktree 和分支; 有改动就留着, 把路径和分支名报给主代理, 由它决定合不合。
// 只在 Node 下可用: 用到时才 import, 别的运行时调到就报不支持。

export interface Worktree { path: string; branch: string; finish(): Promise<string> }

export async function createWorktree(cwd: string | undefined): Promise<Worktree> {
  const cp: any = await import('node:child_process');
  const os: any = await import('node:os');
  const path: any = await import('node:path');
  const git = (args: string[], at?: string): Promise<string> => new Promise((res, rej) => {
    cp.execFile('git', args, { cwd: at || cwd, maxBuffer: 4 * 1024 * 1024 }, (e: any, out: string, err: string) => (e ? rej(new Error((err || e.message).trim())) : res(String(out).trim())));
  });
  const root = await git(['rev-parse', '--show-toplevel']).catch(() => { throw new Error('isolation "worktree" needs the working directory to be inside a git repository'); });
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const branch = `agent/${tag}`;
  const dir = path.join(os.tmpdir(), 'agent-worktrees', tag);
  const base = await git(['rev-parse', 'HEAD'], root);
  await git(['worktree', 'add', '-b', branch, dir, base], root);
  // 子代理在仓库里的相对位置跟主代理一致
  const rel = cwd ? path.relative(root, cwd) : '';
  const wt = rel && !rel.startsWith('..') ? path.join(dir, rel) : dir;
  return {
    path: wt,
    branch,
    async finish() {
      const dirty = await git(['status', '--porcelain'], dir).catch(() => '');
      const ahead = await git(['rev-list', '--count', `${base}..HEAD`], dir).catch(() => '0');
      if (!dirty && ahead === '0') {
        await git(['worktree', 'remove', '--force', dir], root).catch(() => {});
        await git(['branch', '-D', branch], root).catch(() => {});
        return 'The agent made no changes; its worktree was removed.';
      }
      return `The agent's changes are in worktree ${dir} on branch ${branch}${dirty ? ' (uncommitted changes present)' : ''}. `
        + `Review and merge them from there, then remove it with: git worktree remove --force ${dir} && git branch -D ${branch}`;
    },
  };
}
