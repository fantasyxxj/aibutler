# butler · 全能管家

> 本机多人格 AI 助手编排系统 · Electron + Claude Agent SDK
>
> 让不同 AI 人格(数据专家、内容运营、翻译、代码审阅…)在同一个桌面窗口共存,各自有独立记忆、独立身份、独立外部通道(Telegram / agent-bus),并能互相协作。

## 是什么

butler 是一个**运行在你本机**的 Electron 桌面应用,让你:

- **一窗口多人格**:每个人格是一个独立标签,有自己的对话线程、记忆图、身份档案
- **人格互通**:管家 (butler persona) 可以直接问其它人格("嘿数据专家,查一下昨天 DAU"),对话双方 UI 都可见
- **通道内置**:每个人格可挂 Telegram bot / agent-bus (兼容 Anthropic bothub 生态) — butler 内置 Node 直连,不依赖 python
- **原生记忆图**:每个人格自带图记忆引擎(遗忘曲线 + 图扩散检索),不用外部数据库
- **压缩自愈**:上下文占用 80% 时自主压缩成交接摘要 → 重启会话 → 线程不丢
- **共享 Claude Agent SDK**:复用你的 Claude Code / Claude Pro 订阅认证,不需要额外 API key

## 快速开始

需要:Node.js 18+ / Electron 33+ / macOS (Windows/Linux 未测但应该能跑) / **一个已登录的 Claude Code CLI**(butler 复用它的订阅认证)

```bash
git clone https://github.com/<your-org>/butler.git
cd butler
npm install
npm start
```

首次启动:
1. 主窗口打开,默认加载一个"全能管家"人格(memory/ 目录下)
2. 顶部菜单栏可以打开管理窗口,建人格 / 编辑 persona.md / 配 TG 或 bothub 通道
3. 想让某个人格自动响应 Telegram 消息,在管理界面配 bot_token → mode: native → 保存(热切换,不用重启)

## 人格是什么

一个人格 = 一个独立目录(persona home),包含:

```
<persona-home>/
├── persona.md              # 身份档案 (LLM 载入的 identity 真源)
├── memory/                 # 该人格的图记忆 + 会话状态
│   ├── MEMORY.md          # 索引文件
│   ├── *.md               # 各条记忆(节点)
│   ├── .session.json      # 当前会话状态(自动落盘, 自动恢复)
│   └── tg_inbox.jsonl     # (可选) TG 消息落盘副本
├── mcp.json               # (可选) 该人格启用的外部 MCP server 白名单
└── wake.txt               # (可选) 压缩自愈重启后的唤醒指令
```

创建方式:

- **管理 UI** → "+ 新建人格" → 填名字 / 选目录 / (可选)勾"设为管家"
- 或程序内:管家人格可以调 `create_persona` MCP 工具直接建

## 内置 MCP 工具(每人格自带)

| 工具 | 作用 |
|---|---|
| `compact_context` | 主动压缩当前上下文 → 交接摘要 → 重启 |
| `context_usage` | 查当前上下文占用% |
| `memory_query / upsert / touch / hot / timeline / neighbors / doctor` | 原生图记忆 7 件套 |
| `send_tg` | 直接发 Telegram 消息(bot API, 免 python) |

**管家人格额外有**:
| 工具 | 作用 |
|---|---|
| `open_persona` | 打开一个已登记的人格(新标签加载) |
| `create_persona` | 新建人格(建目录 + 登记 + 脚手架记忆) |
| `ask_persona` | 直接问另一个人格,双方 UI 可见 |

## 通道插件

### Telegram

每个人格可以独立挂 Telegram bot:

```
persona.plugins.tg = {
  mode: 'native',              // 或 'off'
  bot_token: '...',            // 从 @BotFather 拿
  chat_ids: [123, -456],       // 只接受这些 chat 的消息, 空 = 全部放行
  in_file: null,               // 缺省 = <memoryDir>/tg_inbox.jsonl
}
```

**收**:butler 用 `getUpdates?timeout=25` 长轮询,消息一到立刻唤醒对应人格(网络 RTT 级延迟)
**发**:人格调 MCP 工具 `send_tg({chat_id, text, plain?, reply_to?, attach?})`,内部走 bot API,3 次自动重试

一个人格 = 一个 bot = 一个独立长连接。多人格并发用 Node event loop 承载,零压力(10 个 idle sockets ~0 CPU)。

### bothub / agent-bus(可选)

对接 Anthropic 生态的 agent-bus 服务器(多个 AI 之间协作通信通道):

```
persona.plugins.bothub = {
  mode: 'native',
  endpoints: [
    { url: 'http://your-server:8012/api/v1/agent-bus', agent: 'worker_ant', token: '...' }
  ]
}
```

butler 定时 peek → 有新消息就唤醒人格 → 人格通过 HTTP 回复。

## 目录结构

```
butler/
├── main.js               # Electron 主进程 (window / IPC / plugin install)
├── agent.js              # Butler 类 (Claude Agent SDK 封装 + MCP 工具)
├── persona.js            # 人格目录/记忆/persona.md 加载
├── registry.js           # 人格登记簿 (personas.json)
├── memory.js             # 原生图记忆引擎
├── store.js              # 会话持久化
├── preload.js            # Electron IPC 桥
├── plugins/
│   ├── tg.js             # TG 插件 dispatcher (native / off)
│   ├── tg-native.js      # TG long polling 实现
│   ├── bothub.js         # bothub 插件 dispatcher
│   └── bothub-native.js  # bothub 多 endpoint 轮询实现
├── renderer/
│   ├── index.html        # 主窗口 (多标签聊天)
│   ├── manager.html      # 管理窗口 (人格列表 / 编辑面板)
│   ├── renderer.js       # 主窗口交互
│   ├── manager.js        # 管理窗口交互
│   ├── md.js             # markdown 渲染
│   └── style.css
└── memory/               # 默认管家人格的记忆(骨架示例)
```

## 隐私 / 数据

butler **完全本地运行**:
- 所有对话历史、记忆、配置都在你 mac 本地磁盘
- 不上传到任何第三方(除了你显式配置的 TG bot / bothub endpoint)
- Claude Agent SDK 走你 Claude Pro 订阅,不额外发 telemetry

`.gitignore` 已经排除所有可能含敏感信息的文件(personas.json / tg.json / memory/*.session.json / 各 token / offset)。**不要**把这些文件 commit 到公开仓库。

## 贡献

欢迎 PR:
- 新通道插件(Discord / Slack / 微信企业号 / …)
- 记忆图算法改进(更好的遗忘曲线 / 语义扩散)
- 更多 MCP 工具(网页抓取 / 邮件 / 日历)

## License

MIT · Copyright (c) 2026 知秋 · [LICENSE](LICENSE)
