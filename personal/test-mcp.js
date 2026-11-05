// 无头测: 一个放行 dc-platform 的人格, 让管家真调 dc-platform MCP 工具(db_list_connections)。
// 验"按人格放行外部 MCP"链路通: mcp.json → resolveExtMcp → SDK mcpServers → 模型能调到工具。
require('./host-wiring');   // 个人版宿主接线: 直接 require core 模块的进程都得先接
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Butler } = require('../core/agent');

(async () => {
  const dir = path.join(os.tmpdir(), 'butler-mcp-test-persona');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({ servers: ['dc-platform'] }), 'utf8');

  const b = new Butler(dir);
  console.log('extMcpNames:', b.extMcpNames);
  console.log('resolveExtMcp keys:', Object.keys(b.resolveExtMcp()));

  let text = '';
  const done = new Promise((resolve) => {
    b.setCallbacks({
      onText: (t) => { text += t; process.stdout.write(t); },
      onActivity: (a) => console.log('\n[activity]', a),
      onUsage: () => {},
      onResult: ({ finalText, interrupted }) => resolve({ finalText, interrupted }),
    });
  });

  await b.submit('用 dc-platform 的 db_list_connections 工具列出可用数据库连接, 只报连接名字, 别的不用说。');
  const r = await Promise.race([done, new Promise((res) => setTimeout(() => res({ timeout: true }), 90000))]);
  console.log('\n\n=== RESULT ===', JSON.stringify(r).slice(0, 300));
  await b.dispose();
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
