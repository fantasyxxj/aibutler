// v1 写路径: upsert · append · 双向连边
// 由 memory.js 拆出(内核抽包第 2 步)。方法体逐字搬运, 经 mixin 挂回 MemoryGraph.prototype。
const fs = require('fs');
const path = require('path');
const rev = require('../memory-revisions');
const {
  canon, today, localTimestampShort, addDays, parseFrontmatter, TYPE_DEFAULT_IMP, REVIEW_DUE_DAYS,
} = require('./primitives');

class V1WriteMixin {
  // 建/更新一个记忆节点 .md(把「事情」放进图的原语): 写 frontmatter + body + [[links]], 重建索引
  upsert({ id, title, type = 'project', importance, description = '', body = '', links = [],
           status, superseded_by, scope, exit_criteria, review_due, requireExitCriteria = true,
           origin = '', revReason = '', revBasis = [], revAuto = true, revAsked = false }) {
    if (!id) throw new Error('upsert 需要 id');
    const nid = canon(id);
    const fname = path.join(this.dir, nid + '.md');
    const now = today();
    // 🔴 upsert 整体重写 frontmatter, 生命周期字段不显式继承就会被静默抹掉。
    // 同类病见 feedback_memory_upsert_overwrites_body_read_merge_first(那次丢的是 body)。
    // 以文件为准而不是 index: 文件是真相, index 可能还没重建。
    const isNew = !fs.existsSync(fname);
    let prevFm = {}, prevBody = '';
    if (!isNew) {
      try { const [f0, b0] = parseFrontmatter(fs.readFileSync(fname, 'utf8')); prevFm = f0 || {}; prevBody = b0 || ''; }
      catch (_) {}
    }
    const keep = (given, prev, dflt = '') => (given !== undefined ? given : (prev || dflt));
    // spec §2.1 auto-touch: init 0, 结尾 +=1 → 新建首沉=1 (等价手动 touch), update=existing+1.
    // 语义"凡 upsert 皆一次'我用过'signal", 跟 memory_touch 收紧后语义闭环.
    // fallback ||1 三处 (build line 82 / touch line 216 / update 老值兜底) 保守不动.
    let created = now, last_used = now;
    let use_count = 0;
    const existing = this._readIndex();
    if (existing && existing.nodes[nid]) {
      created = existing.nodes[nid].created || now;
      last_used = now; use_count = (existing.nodes[nid].use_count || 1);
    }
    use_count += 1;
    const imp = importance || TYPE_DEFAULT_IMP[type] || 'med';

    const st = String(keep(status, prevFm.status, 'active')).toLowerCase();
    const rawSup = keep(superseded_by, prevFm.superseded_by);
    const supBy = rawSup ? canon(rawSup) : '';
    const scp = keep(scope, prevFm.scope);
    const exitC = keep(exit_criteria, prevFm.exit_criteria);
    let revDue = keep(review_due, prevFm.review_due);
    // 判定用 id 前缀而非 type 参数: upsert 的 type 默认值就是 'project', 拿 type 判会把所有
    // 省略 type 的调用(reference_*/feedback_*)全部误伤。命名约定 project_* 才是硬信号。
    const isProject = nid.startsWith('project_');
    // 只在没值时兜底 —— 已填过的不覆盖, 否则每次 upsert 都把到期日推远 30 天, 永远不到期。
    if (isProject && !revDue) revDue = addDays(created, REVIEW_DUE_DAYS);
    // 新建 project 强制定退出条件: 这是治僵尸项目的源头闸。靠自觉不行(Belief-R 已实证 LLM 不会自发
    // 修正旧结论), 所以在引擎层挡。存量节点更新不挡(isNew=false), 只挡新建。
    if (isNew && isProject && requireExitCriteria && !exitC) {
      throw new Error(
        `新建 project 节点必须填 exit_criteria(什么条件算做完), 否则它会变成永远显示「在办」的僵尸项目。\n` +
        `  例: exit_criteria: "build 28 通过 App 审核并上架"`);
    }

    const linkBlock = (links && links.length)
      ? '\n\n## 关联\n' + links.map((l) => `[[${canon(l)}]]`).join(' · ') : '';
    const fmLines = [
      '---', `name: ${title || nid}`, `description: "${String(description).replace(/"/g, "'").slice(0, 480)}"`,
      'metadata:', '  node_type: memory', `  type: ${type}`, `  importance: ${imp}`,
      `  created: ${created}`, `  last_used: ${last_used}`, `  use_count: ${use_count}`,
      `  status: ${st}`,
    ];
    // 空值不写盘: parseFrontmatter 本来就跳过空值, 写了也读不出来, 徒增噪音。
    // origin: 这条是谁写的("birth"=出生时灌进来的出厂知识, 空=人格自己写的)。
    // 🔴 **刻意不继承**: 别的生命周期字段都从旧 frontmatter 继承, 只有它不。人格自己 upsert 一条
    // 出厂知识时不会传 origin, 于是标记自然消失 —— 语义正好是"这条已经被我改过, 不再是出厂原样"。
    // 冲突体检据此跳过"两条都还是出厂原样"的对: 它们是一起下发、彼此早就校对过的, 每周端上来
    // 让新人格审自己的出厂知识, 是纯粹的浪费。有一条被改过, 就恢复互审。
    if (origin) fmLines.push(`  origin: ${origin}`);
    if (supBy) fmLines.push(`  superseded_by: ${supBy}`);
    if (scp) fmLines.push(`  scope: ${scp}`);
    if (exitC) fmLines.push(`  exit_criteria: ${exitC}`);
    if (revDue) fmLines.push(`  review_due: ${revDue}`);
    fmLines.push('---', '');
    const fm = fmLines.join('\n');
    fs.writeFileSync(fname, fm + body + linkBlock + '\n', 'utf8');
    // 修订日志: upsert 是两个真内容写入点之一。放在写盘成功之后 —— 没写成的不该留痕。
    rev.logRevision(this.dir, {
      op: isNew ? 'create' : 'update', node_id: nid,
      old_body: prevBody, new_body: body,
      reason: revReason || (isNew ? '新建' : '更新'),
      basis: revBasis, auto: revAuto, asked: revAsked,
    });
    const stats = this.build();
    this.kickEmbed();
    return { id: nid, file_path: fname, ...stats };
  }

  // §2.3 memory_append: 往指定 section 追加带签名头的 body. section 不存在则在文件末尾建.
  // 多个同名 section 选最后一个 (追加式, 最新最相关). touch=true (默认) 呼应 §2.1 auto-touch 语义.
  // 签名头统一: ### YYYY-MM-DD HH:MM · <actor 人格名> · <reason 一句话>  (本地时区 · butler 编码约定)
  append({ parent_id, section, body, actor = '未知', reason = '无说明', touch = true }) {
    if (!parent_id) throw new Error('append 需要 parent_id');
    if (!section) throw new Error('append 需要 section');
    const nid = canon(parent_id);
    const fpath = path.join(this.dir, nid + '.md');
    if (!fs.existsSync(fpath)) throw new Error(`节点不存在: ${nid}`);

    const text = fs.readFileSync(fpath, 'utf8');
    const stampHead = `### ${localTimestampShort()} · ${actor} · ${reason}`;
    const insertBlock = `\n${stampHead}\n${body}\n`;

    // 找 ## <section> 的最后一次出现 (追加式选最新)
    const secEsc = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const secPattern = new RegExp(`^##\\s+${secEsc}\\s*$`, 'gm');
    let m, lastMatch = null;
    while ((m = secPattern.exec(text)) !== null) lastMatch = m;

    let newText;
    if (lastMatch) {
      const secContentStart = lastMatch.index + lastMatch[0].length;
      const nextSecPat = /^##\s+/gm;
      nextSecPat.lastIndex = secContentStart;
      const nextM = nextSecPat.exec(text);
      const secEnd = nextM ? nextM.index : text.length;
      newText = text.slice(0, secEnd).trimEnd() + insertBlock + '\n' + text.slice(secEnd);
    } else {
      newText = text.trimEnd() + `\n\n## ${section}\n${insertBlock}`;
    }

    // §2.1 auto-touch 呼应: append 也是"我用过"signal, 同步更新 frontmatter 里 use_count/last_used.
    // 用正则替换 fm 字段, 避免 build 时被 fm 老值覆盖 index bump (memory_touch 有同类问题, 但 touch 不 build 故绕开).
    if (touch) {
      const ucMatch = newText.match(/^(\s*use_count:\s*)(\d+)/m);
      const currentUc = ucMatch ? parseInt(ucMatch[2], 10) : 1;
      newText = newText.replace(/^(\s*use_count:\s*)\d+/m, `$1${currentUc + 1}`);
      newText = newText.replace(/^(\s*last_used:\s*).*$/m, `$1${today()}`);
    }
    fs.writeFileSync(fpath, newText, 'utf8');
    // append 是第二个真内容写入点。old_body 留空是刻意的: 追加不覆盖任何原文,
    // 记 new_body=这次追加的块, 才是"这次到底改了什么"最直接的答案(存全文反而看不出增量)。
    rev.logRevision(this.dir, {
      op: 'update', node_id: nid, old_body: '', new_body: body,
      reason: `append §${section} · ${reason}`, basis: ['append'], auto: true,
    });

    const stats = this.build();
    this.kickEmbed();
    return { id: nid, file_path: fpath, section, sectionCreated: !lastMatch, touched: touch, ...stats };
  }

  // §2.3 memory_link_bidirectional: 双向链. from/to.md body 各追加 [[对方id]] 到 "## 关联" section.
  // 幂等: 已有 link 不重复添加. touch=true (默认) 双 touch.
  linkBidirectional({ from_id, to_id, touch = true }) {
    if (!from_id || !to_id) throw new Error('linkBidirectional 需要 from_id 和 to_id');
    const a = canon(from_id), b = canon(to_id);
    if (a === b) throw new Error('自链无意义');

    const addLinkTo = (nid, targetId, doTouch) => {
      const fpath = path.join(this.dir, nid + '.md');
      if (!fs.existsSync(fpath)) throw new Error(`节点不存在: ${nid}`);
      let text = fs.readFileSync(fpath, 'utf8');
      const linkStr = `[[${targetId}]]`;
      const added = !text.includes(linkStr);
      if (added) {
        if (/^##\s+关联\s*$/m.test(text)) {
          text = text.trimEnd() + ` · ${linkStr}\n`;
        } else {
          text = text.trimEnd() + `\n\n## 关联\n${linkStr}\n`;
        }
      }
      // §2.1 auto-touch 呼应: 同步更新 fm.use_count/last_used, 免 build 覆盖 index bump.
      if (doTouch) {
        const ucMatch = text.match(/^(\s*use_count:\s*)(\d+)/m);
        const currentUc = ucMatch ? parseInt(ucMatch[2], 10) : 1;
        text = text.replace(/^(\s*use_count:\s*)\d+/m, `$1${currentUc + 1}`);
        text = text.replace(/^(\s*last_used:\s*).*$/m, `$1${today()}`);
      }
      if (added || doTouch) fs.writeFileSync(fpath, text, 'utf8');
      return added;
    };

    const addedA = addLinkTo(a, b, touch);
    const addedB = addLinkTo(b, a, touch);

    const stats = this.build();
    return { from: a, to: b, added: { from: addedA, to: addedB }, touched: touch, ...stats };
  }
}

module.exports = V1WriteMixin;
