'use strict';
// self-guard.js — 分发版专用: 把 butler 自己的程序与总控数据挡在人格够不着的地方。
//
// 与行业版 core/fs-guard.js 的关系: 那边取**白名单**(人格只能动自己家目录, Bash 整只禁掉),
// 因为客户机器上的人格没有"写别的代码"这项职责。个人版不能这么做 —— 作者明确要求
// 「写别的代码可以, 搞项目可以, 但是不能读和改 butler 自己」, 所以 Bash 必须留着,
// 边界只能反过来取**黑名单**: 除了 butler 自身, 哪都能去。
//
// 🔴 黑名单的代价必须写在明处: 白名单漏一条只是某功能不好使, 会被当场发现; 黑名单漏一条
// 就是一个洞。这里的洞是已知的、且不打算用静态检查去补的 —— 见下面 Bash 那段。
// 所以本守卫的定位是「挡住 AI 顺手去翻、顺手去改」, 不是「抵御刻意越狱」。
// 这个定位与项目一贯的假设一致(用户与人格都是良性的, 不做对抗性设计)。

const fs = require('fs');
const path = require('path');

// 工具名 → tool_input 里哪几个字段是路径。不在表里的工具(MCP 记忆工具/WebSearch 等)不碰
// 文件系统, 放行。
const PATH_FIELDS = {
  Read: ['file_path'],
  Write: ['file_path'],
  Edit: ['file_path'],
  NotebookEdit: ['notebook_path'],
  Glob: ['path'],
  Grep: ['path'],
};

// Bash 里出现这些就当成在碰 butler 自己。asar 单列: 打包后源码全在这个文件里, 而它的路径
// 未必以受保护根开头(用户可以把 .app 拷到别处再拆)。
const EXTRA_BASH_MARKERS = ['app.asar'];

/** 解析到最近一层真实存在的祖先再拼回去 —— 否则家目录里放个软链指向 butler 就绕过去了。 */
function realish(p) {
  const abs = path.resolve(p);
  const tail = [];
  let cur = abs;
  for (;;) {
    try {
      const real = fs.realpathSync(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch (_) {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;          // 一路到根都不存在, 用字面值判
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

function inside(child, root) {
  const rel = path.relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Glob/Grep 的 pattern 会跟 path 一起解析, `../../*.js` 能直接跨出去。取 pattern 里第一个
// 通配符之前的那段字面前缀参与判定 —— 后面的通配符只会让范围更小, 不会更大。
function literalPrefix(pattern) {
  const segs = String(pattern).split('/');
  const out = [];
  for (const s of segs) {
    if (/[*?[\]{}]/.test(s)) break;
    out.push(s);
  }
  return out.join('/');
}

// 从一段 shell 命令里粗略挑出"看起来是路径"的 token。引号、= 号、管道都切开。
// 这是启发式, 不是解析器 —— 它的作用是把常见写法拦下来, 不是穷尽所有写法。
function pathTokens(cmd) {
  return String(cmd)
    .split(/[\s;|&<>()"'`]+/)
    .filter((t) => t && (t.startsWith('/') || t.startsWith('./') || t.startsWith('../') || t.startsWith('~/')));
}

/**
 * roots = 受保护目录(butler 自己的程序 + 总控数据)
 * cwd   = 会话工作目录, 用来解析相对路径
 * allow = 无论如何都放行的目录(人格自己的家和记忆库)
 *
 * 🔴 allow 压过 roots, 因为**人格的家可能落在受保护根里面**: 首启那个框让用户自选数据目录,
 * 选进安装目录就成了 `<安装根>/personas/<id>`(作者 2026-09-20 实装撞到)。不豁免的话人格连
 * 自己的 persona.md 都读不了, 报的还是"那是全能管家自己的程序文件" —— 用户根本猜不到是自己
 * 选目录选出来的。豁免是精确子树: 放行 `…/personas/小明` 不会顺带放开它的父目录, app.asar
 * 与总控目录照旧锁死。
 */
function createSelfGuard({ roots, cwd, homedir, allow } = {}) {
  const list = (Array.isArray(roots) ? roots : []).filter(Boolean);
  if (!list.length) {
    throw new Error('self-guard: roots 不能为空 —— 空黑名单会无声地放行一切');
  }
  const realRoots = list.map(realish);
  const realAllow = (Array.isArray(allow) ? allow : []).filter(Boolean).map(realish);
  const base = realish(cwd || process.cwd());
  const home = homedir || require('os').homedir();

  function hits(target) {
    if (realAllow.some((a) => inside(target, a))) return false;
    return realRoots.some((r) => inside(target, r));
  }

  function denyMsg(what) {
    return `拒绝访问 ${what} —— 那是全能管家自己的程序文件。`
      + ' 本版本里, 人格不能读也不能改 butler 自身的源代码、配置与凭据。'
      + ' 别的项目、别的代码随便写, 只有这一块是锁死的。';
  }

  function resolveFrom(raw) {
    let s = String(raw);
    if (s.startsWith('~/')) s = path.join(home, s.slice(2));
    return realish(path.isAbsolute(s) ? s : path.join(base, s));
  }

  // 返回 null = 放行; 返回字符串 = 拦下的理由。
  function check(toolName, toolInput) {
    const input = toolInput && typeof toolInput === 'object' ? toolInput : {};

    // Bash 单独一条路: 它的参数不是路径字段, 是一整段 shell。
    //
    // 🔴 这里是本守卫唯一的已知洞, 且是刻意不去补的。`cat $(echo ...)`、变量拼接、
    // base64、解释器内联脚本 —— 任何静态检查都是筛子。行业版的做法是整只禁掉 Bash,
    // 个人版禁不了(要能跑 npm/git/测试)。所以这里只做字面扫描: 把"直接写出路径"这种
    // 绝大多数情况拦掉。想靠拼接绕过去的模型能绕过去, 这一点必须让人知道, 不能假装是墙。
    if (toolName === 'Bash' || toolName === 'BashOutput') {
      const cmd = typeof input.command === 'string' ? input.command : '';
      if (!cmd) return null;
      for (const m of EXTRA_BASH_MARKERS) {
        if (cmd.includes(m)) return denyMsg(m);
      }
      // 受保护根的绝对路径直接出现在命令里。
      // 🔴 扫之前先把豁免目录从串里抹掉: 人格的家可能就落在受保护根底下, 那样 `ls <家目录>`
      // 这条命令天然含着安装根的字面前缀, 不抹就会把"人格读自己家"判成越界。抹掉之后
      // `cat <安装根>/resources/app.asar` 照样命中 —— 那一段不在任何豁免子树里。
      let scan = cmd;
      for (const a of realAllow) scan = scan.split(a).join(' ');
      for (const r of realRoots) {
        if (scan.includes(r)) return denyMsg(r);
      }
      // 相对写法(`../butler/agent.js`)解析后再判一次
      for (const t of pathTokens(cmd)) {
        if (hits(resolveFrom(t))) return denyMsg(t);
      }
      return null;
    }

    const fields = PATH_FIELDS[toolName];
    if (!fields) return null;                    // 不碰文件系统的工具

    for (const field of fields) {
      const raw = input[field];
      if (raw === undefined || raw === null || raw === '') continue;   // 缺省 = cwd
      if (typeof raw !== 'string') continue;                            // 形状不对交给 SDK 自己报
      if (hits(resolveFrom(raw))) return denyMsg(raw);
    }

    // Glob/Grep: path 本身合法, 但 pattern 可能把范围拐出去
    if ((toolName === 'Glob' || toolName === 'Grep') && typeof input.pattern === 'string') {
      const prefix = literalPrefix(input.pattern);
      if (prefix && (prefix.includes('..') || path.isAbsolute(prefix))) {
        const anchor = typeof input.path === 'string' && input.path ? resolveFrom(input.path) : base;
        const target = realish(path.isAbsolute(prefix) ? prefix : path.join(anchor, prefix));
        if (hits(target)) return denyMsg(input.pattern);
      }
    }
    return null;
  }

  // SDK PreToolUse 回调。返回 {} = 不干预, 交回正常权限流程。
  async function hook(input) {
    let reason = null;
    // 🔴 守卫自己抛异常绝不能挡住工具调用 —— 那会让用户干不了活, 比漏拦更糟。
    try { reason = check(input && input.tool_name, input && input.tool_input); }
    catch (_) { return {}; }
    if (!reason) return {};
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    };
  }

  return { hook, check, roots: realRoots, cwd: base };
}

module.exports = { createSelfGuard, realish, literalPrefix, pathTokens, PATH_FIELDS };
