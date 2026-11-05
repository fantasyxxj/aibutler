// index-guard-test.js — 4.2 索引类知识挂懒路径
// 治的病: 环境清单/部署脚本/代码映射记忆里有, AI 却去翻代码。钩子挂动作那一刻。
// 运行: node scripts/index-guard-test.js
//
// 🔴 这里一律用**自测自己写的钩子**, 不拿出厂 hooks 的具体内容当断言 ——
// 出厂那份只剩"教人格怎么改自己"的元钩子, 领域钩子归各人格自己的 hooks.json。
// 测试绑死出厂内容, 就等于把"配置只写通道"这条(T5 自己在测的那条)在测试里破掉。
const fs = require('fs');
const os = require('os');
const path = require('path');
const cfg = require('../personal/config-loader');
const { IndexGuard } = require('../core/index-guard');
const { MemoryGraphV2 } = require('../core/memory-v2');

let pass = 0, fail = 0;
const t = (name, ok, extra = '') => { if (ok) { pass++; console.log(`  ✅ ${name}${extra ? ' · ' + extra : ''}`); } else { fail++; console.error(`  ❌ ${name}${extra ? ' · ' + extra : ''}`); } };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'index-guard-'));
const g = new MemoryGraphV2(dir);
// 🔴 检索词一律写进 keywords, 不写进 body —— body **完全不进检索索引**(实测: 只有
// claim/keywords/title/slug 进)。钩子的 query 与记忆的 keywords 对不上, 钩子就永远空转。
g.upsert({ slug: 'reference_db_env_list', title: '数据库环境清单', type: 'reference',
  claim: '所有数据库的连接方式和账号都记在环境清单里, 不必翻代码找',
  keywords: '数据库 连接 环境清单 账号 主机 端口 database connection environment credentials host port' });
g.upsert({ slug: 'reference_deploy_script', title: '部署脚本', type: 'reference',
  claim: '部署走 git push + 服务器一键脚本, 不手动 rsync',
  keywords: '部署 脚本 一键 服务器 git push deploy script one-click server' });
g.upsert({ slug: 'reference_how_to_edit_persona', title: '怎么改身份档案', type: 'reference',
  claim: 'persona.md 每轮进系统提示, 所以只放治第一轮的, 其余进记忆',
  keywords: 'persona.md 身份档案 常驻 什么时候该改 怎么写 identity profile' });

// 人格自己的钩子文件
const writeMine = (hooks) => {
  fs.writeFileSync(path.join(dir, 'hooks.json'), typeof hooks === 'string' ? hooks : JSON.stringify({ hooks }), 'utf8');
};
const quiet = () => {};
// 主用例走"人格自定义钩子"这条路: 既测机制, 又不依赖出厂内容
writeMine([
  { key: 'db_connect', trigger: 'Bash:\\b(psql|mysql|bq)\\b', query: 'database connection environment credentials' },
  { key: 'manual_deploy', trigger: 'Bash:\\b(rsync|scp)\\b', query: 'deploy script one-click server' },
]);
const guard = new IndexGuard(g, { cfg, log: quiet, memoryDir: dir });

console.log('\n=== T1: 挂在动作上, 不挂在用户的话上 ===');
t('要连库 → 附上环境清单', (guard.decide('Bash', { command: 'psql -h db01 -c "select 1"' }) || '').includes('reference_db_env_list'));
guard.resetTurn();
t('要手动 rsync → 附上部署脚本', (guard.decide('Bash', { command: 'rsync -av ./dist server:/srv' }) || '').includes('reference_deploy_script'));
guard.resetTurn();
t('普通命令 → 什么都不说', guard.decide('Bash', { command: 'ls -la' }) === null);

console.log('\n=== T2: 失败完全静默 ===');
const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'index-guard-empty-'));
const g2 = new MemoryGraphV2(emptyDir);
const guard2 = new IndexGuard(g2, { cfg, log: quiet, memoryDir: dir });
t('库里没有索引 → 一个字不说', guard2.decide('Bash', { command: 'psql -h db01' }) === null);
const broken = new IndexGuard({ query() { throw new Error('库炸了'); } }, { cfg, log: quiet, memoryDir: dir });
t('引擎抛异常 → 一个字不说', broken.decide('Bash', { command: 'psql -h db01' }) === null);
t('没有记忆引擎 → 整个关掉', new IndexGuard(null, { cfg }).enabled === false);
t('没有 cfg → 整个关掉', new IndexGuard(g, { cfg: null }).enabled === false);

console.log('\n=== T3: 一轮只提一次(别每条命令都念一遍) ===');
guard.resetTurn();
t('第一次提', guard.decide('Bash', { command: 'psql -h db01' }) !== null);
t('同轮第二次不提', guard.decide('Bash', { command: 'psql -h db02' }) === null);
guard.resetTurn();
t('下一轮又提', guard.decide('Bash', { command: 'psql -h db03' }) !== null);

console.log('\n=== T4: 只附一眼, 绝不拦人 ===');
(async () => {
  guard.resetTurn();
  const out = await guard.hook()({ tool_name: 'Bash', tool_input: { command: 'psql -h db01' } });
  t('走的是 additionalContext', !!(out.hookSpecificOutput && out.hookSpecificOutput.additionalContext));
  t('没有 permissionDecision(不干预放行)', !('permissionDecision' in (out.hookSpecificOutput || {})));
  const conf = cfg.json('main/index_hooks');
  t('附上了出厂 footer(声明不拦)', out.hookSpecificOutput.additionalContext.includes(conf.footer));
  guard.resetTurn();
  const none = await guard.hook()({ tool_name: 'Bash', tool_input: { command: 'echo hi' } });
  t('没命中就返回空对象', JSON.stringify(none) === '{}');
  const boom = await new IndexGuard({ get query() { throw new Error('炸'); } }, { cfg, log: quiet }).hook()({ tool_name: 'Bash', tool_input: {} });
  t('守卫异常也放行', JSON.stringify(boom) === '{}');

  console.log('\n=== T5: 配置里只写通道, 不写内容 ===');
  const c = cfg.json('main/index_hooks');
  t('每个钩子都是 动作→检索词', (c.hooks || []).every((h) => h.trigger && h.query && h.key));
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'index-guard.js'), 'utf8');
  t('话术不硬编码在 js 里', !src.includes(c.header));
  t('触发模式不硬编码在 js 里', !src.includes('psql'));

  console.log('\n=== T6: 出厂只留"教人格改自己"的元钩子 ===');
  const keys = (c.hooks || []).map((h) => h.key);
  t('有 edit_persona_md', keys.includes('edit_persona_md'));
  t('有 edit_persona_hooks', keys.includes('edit_persona_hooks'));
  // 🔴 这条是这次改动的命根子: 出厂那份全机器共用, 谁也不该替所有人定领域钩子。
  t('出厂不再夹带领域钩子', !keys.includes('db_connect') && !keys.includes('manual_deploy'));
  const metaGuard = new IndexGuard(g, { cfg, log: quiet });   // 不给 memoryDir = 只有出厂钩子
  const hitPersona = metaGuard.decide('Edit', { file_path: '/x/.claude/memory/persona.md', old_string: 'a', new_string: 'b' });
  t('要改 persona.md → 拍规矩上来', (hitPersona || '').includes('reference_how_to_edit_persona'));
  t('元钩子用自己的 header(不是"省你一次搜索")', (hitPersona || '').includes('identity profile'));
  metaGuard.resetTurn();
  t('改别的 md 不触发', metaGuard.decide('Edit', { file_path: '/x/README.md', old_string: 'a', new_string: 'b' }) === null);

  console.log('\n=== T7: 人格自己的钩子(个性化归人格, 不归出厂) ===');
  // T1~T4 全程走的就是人格 hooks.json —— 领域钩子从出厂挪进人格目录后依旧照常命中。
  // 同 key 压过出厂那条
  writeMine([{ key: 'edit_persona_md', trigger: 'Bash:\\bmyown\\b', query: 'database connection environment credentials' }]);
  const gOverride = new IndexGuard(g, { cfg, log: quiet, memoryDir: dir });
  t('同 key 压过出厂', (gOverride.decide('Bash', { command: 'myown thing' }) || '').includes('reference_db_env_list'));
  gOverride.resetTurn();
  t('被压掉的出厂钩子不再触发', gOverride.decide('Edit', { file_path: '/x/persona.md', old_string: 'a', new_string: 'b' }) === null);

  // 写歪的自定义钩子不许把出厂那两条一起带走
  writeMine('{ this is not json');
  const gBad = new IndexGuard(g, { cfg, log: quiet, memoryDir: dir });
  t('hooks.json 是坏 JSON → 出厂钩子照常工作',
    (gBad.decide('Edit', { file_path: '/x/persona.md', old_string: 'a', new_string: 'b' }) || '').includes('reference_how_to_edit_persona'));
  writeMine([{ key: 'no_colon', trigger: 'memory_upsert', query: 'database connection environment credentials' }]);
  const gNoColon = new IndexGuard(g, { cfg, log: quiet, memoryDir: dir });
  t('trigger 漏冒号 → 跳过这条, 不影响其余',
    (gNoColon.decide('Edit', { file_path: '/x/persona.md', old_string: 'a', new_string: 'b' }) || '').includes('reference_how_to_edit_persona'));

  // 改完文件下次调用就重读(mtime 缓存)
  const gReload = new IndexGuard(g, { cfg, log: quiet, memoryDir: dir });
  writeMine([{ key: 'v1', trigger: 'Bash:\\bversionone\\b', query: 'database connection environment credentials' }]);
  fs.utimesSync(path.join(dir, 'hooks.json'), new Date(), new Date(Date.now() + 1000));
  t('改完 hooks.json 不用重启', (gReload.decide('Bash', { command: 'versionone' }) || '').includes('reference_db_env_list'));

  fs.rmSync(path.join(dir, 'hooks.json'), { force: true });
  const gGone = new IndexGuard(g, { cfg, log: quiet, memoryDir: dir });
  t('没有 hooks.json → 只用出厂钩子, 不报错',
    (gGone.decide('Edit', { file_path: '/x/persona.md', old_string: 'a', new_string: 'b' }) || '').includes('reference_how_to_edit_persona'));

  g.close(); g2.close();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(emptyDir, { recursive: true, force: true });
  console.log(`\n${fail ? '❌' : '✅'} ${pass} 绿 ${fail} 红`);
  process.exit(fail ? 1 : 0);
})();
