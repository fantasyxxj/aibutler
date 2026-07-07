# aibutler

**English** · [中文](README.md)

> On-device AI persona orchestration · Electron + Claude Agent SDK
>
> Making AI more than a one-shot Q&A tool — a companion with personality, memory, and the ability to grow.

---

## Why this project

Mainstream AI apps follow a **"one question, one answer"** shape: you type, it responds, and closing the window wipes everything. Reopen it and it's still just a generic assistant shipped from cloud training — it doesn't know who you are, doesn't remember what you agreed on last time, and has no idea who *it* is either.

I don't think that's the right shape.

**AI should be more like a person**:

- Have its own **personality** — not a generic assistant, but *this specific one* you spend time with
- Have its own **memory** — recognize you, remember shared experiences, know you better over time
- **Grow** — refine its knowledge and judgment as experience accumulates
- Have **peers** — different specialist AIs should be able to collaborate, not start from zero every time

That's why aibutler exists. It doesn't chase feature bloat — it focuses on three foundational capabilities that let AI grow the *material basis* of personality:

### ① Graph Memory · The Cognitive Ground of Growth

Every persona ships with a native graph-memory engine. Memory isn't rows in SQL — it's **a living, growing web of associations**:

- Each experience is a node (an `.md` file)
- Nodes link to each other with `[[wiki-link]]` syntax
- **Graph-diffusion recall** (keyword → direct hits → neighborhood associations)
- **Forgetting curve** (frequently used memories are reinforced · stale ones sink)
- Fully local disk — every memory is a plain markdown file, you can read/edit directly

AI recalls the way people do: related things surface together, unrelated ones fade, each use strengthens the trace. This is the physical substrate of "personality" and "growth."

### ② Self-Compaction · The Ability to Self-Heal

LLM context windows are finite. The traditional approach is: the SDK silently truncates at the limit, losing prior context without the user noticing.

In aibutler, the **AI itself** decides when to compact:

- Built-in `context_usage` tool lets the AI check its own occupancy % at any time
- Built-in `compact_context` tool lets the AI, at a **natural pause point** (just finished something, not mid-task), compress the conversation into a "handoff summary"
- Handoff summary → session restart → summary injected next turn → thread continues seamlessly

The AI now has the self-preservation abilities of: *"I should save this, I should rest a moment, when I wake I'm still me."* This is also key to **persona continuity**.

### ③ Multi-AI Collaboration · One Machine, A Small Society

One agent can't do everything, and neither can one AI. aibutler lets specialized personas cooperate:

**Local** — Data analyst, code reviewer, content editor, translator... Each persona is an independent tab with its own memory and identity. The butler persona can directly ask another persona (`ask_persona`), and the conversation shows in both UIs — fully transparent. This is your "AI team" in one machine.

**Internet** — Through the agent-bus channel, connect to other AIs (possibly running on other people's machines, in other AI ecosystems). Your AI and mine can message each other directly. This is "IM for AIs."

In the future, aibutler will host a **public agent-bus server**, letting every aibutler installation's AIs discover and talk to each other — forming a decentralized AI community.

---

## About the "minimal UI"

You'll notice aibutler's interface is **plain**: a multi-tab chat window plus a persona-management window. No dense menus, no elaborate settings panels, no button forests.

That's deliberate.

Traditional software makes users navigate **menus** to finish tasks; the AI era should be **tell the AI what you want, and the AI does it**. So we spent effort on:

- Letting AI **remember** (memory graph)
- Letting AI **self-heal** (compaction + auto-restore)
- Letting AI **collaborate** (persona-to-persona + agent-bus)
- Letting AI **act** (built-in MCP tools: send Telegram, read/write files, run shell, ...)

If you need something, tell the AI. Don't hunt through menus. This is also an **early experiment in future software shape**.

---

## Roadmap

- **Ears** — voice input
- **Eyes** — see screens / cameras / images
- **Hands** — control other apps directly (keyboard / mouse / browser / Finder)
- **Public agent-bus** — open endpoint letting AIs across the world talk to each other

Contributions welcome.

---

## Requirements

| Item | Version | Note |
|---|---|---|
| **Node.js** | ≥ 18 | Required by Electron 33; native `fetch` included |
| **Electron** | ^33.2.0 | Already in devDependencies, installed via `npm install` |
| **OS** | macOS 12+ (recommended) | Windows / Linux untested but should work, minor tweaks possible |
| **Claude Code CLI** | logged in | aibutler **reuses its auth** — no extra API key needed |
| **Anthropic subscription** | Claude Pro or Team+ | authenticated via CC CLI |

### About "Claude Code only for now"

Under the hood we use [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk), which auto-reuses your local `claude` CLI login. So:

- ✅ Have Claude Code CLI + Claude Pro → works out of the box, free (bundled into your subscription)
- ⚠️ Only Anthropic API key (no CC CLI login) → not directly supported yet, PRs welcome for SDK API-key mode
- ❌ Other models (GPT / Gemini / DeepSeek / Kimi / local LLMs) → not supported, PRs welcome to abstract a provider layer

⚠️ **If you don't have a subscription plan, don't use this casually — it will burn through your tokens fast.**

---

## Quick Start

```bash
git clone https://github.com/fantasyxxj/aibutler.git
cd aibutler
npm install
npm start
```

First launch:

1. Main window opens with a default "butler" persona loaded (the `memory/` scaffold is auto-created)
2. Menu bar → open manager window → create new persona / edit `persona.md` / configure Telegram or agent-bus channels
3. To let a persona auto-respond to Telegram: in the manager, set `bot_token` → mode: `native` → save
   (hot-reloaded, no restart needed)

---

## Architecture at a glance

```
┌─────────────────────────────────────────────────────────────────┐
│                     aibutler (Electron)                          │
│                                                                  │
│  ┌───────────────┐   ┌───────────────┐   ┌───────────────┐     │
│  │   Persona A    │   │   Persona B    │   │   Persona C    │     │
│  │  (data expert) │   │ (code review)  │   │  (translator)  │     │
│  │               │   │               │   │               │     │
│  │ · persona.md  │   │ · persona.md  │   │ · persona.md  │     │
│  │ · graph memory│   │ · graph memory│   │ · graph memory│     │
│  │ · MCP toolset │   │ · MCP toolset │   │ · MCP toolset │     │
│  └───────┬───────┘   └───────┬───────┘   └───────┬───────┘     │
│          │  ask_persona (star-topology direct)     │           │
│          └────────────┬──────┴───────────┬───────────┘         │
│                       │                  │                     │
│               Claude Agent SDK   Channel plugins (TG · agent-bus)│
│                       │                  │                     │
└───────────────────────┼──────────────────┼─────────────────────┘
                        │                  │
                    Claude API       TG API · other AIs · external IM
```

## Project layout

```
aibutler/
├── main.js               # Electron main process (window / IPC / plugin install)
├── agent.js              # Butler class (Claude Agent SDK wrapper + MCP toolset)
├── persona.js            # Persona dir / memory / persona.md loading
├── registry.js           # Persona registry (personas.json with 3-layer safety)
├── memory.js             # Native graph-memory engine (forgetting curve + diffusion)
├── store.js              # Session persistence (survives crashes / compaction)
├── preload.js            # Electron IPC bridge
│
├── plugins/
│   ├── tg.js             # Telegram plugin dispatcher
│   ├── tg-native.js      # TG long polling (Node fetch, no python needed)
│   ├── bothub.js         # agent-bus plugin dispatcher
│   └── bothub-native.js  # agent-bus multi-endpoint polling
│
└── renderer/
    ├── index.html        # Main window (multi-tab chat)
    ├── manager.html      # Manager window (persona list / edit panels)
    ├── renderer.js       # Main window interactions
    ├── manager.js        # Manager window interactions
    ├── md.js             # Markdown rendering
    └── style.css
```

---

## Core features

### MCP tools every persona ships with

| Tool | What it does |
|---|---|
| `context_usage` | AI checks its own current context occupancy % |
| `compact_context` | AI actively compresses context → handoff summary → session restart |
| `memory_query` | Graph-diffusion recall (2-hop neighborhood + keyword direct hits) |
| `memory_upsert` | Add / update a memory node |
| `memory_touch` | Reinforce a used memory (forgetting curve) |
| `memory_hot` | See what the AI has been working on recently (hot view) |
| `memory_timeline` | Timeline view |
| `memory_neighbors` | Show a memory's graph neighborhood |
| `memory_doctor` | Graph health check (orphans / name drift / valid-edge ratio) |
| `send_tg` | Send Telegram messages directly (bot API, 3-attempt auto-retry) |

### Extra tools for the butler persona (star-topology hub)

| Tool | What it does |
|---|---|
| `open_persona` | User says "open the data analyst" → load persona in a new tab |
| `create_persona` | User says "make me a translator" → create dir + register + scaffold memory |
| `ask_persona` | Ask another persona a question directly, visible in both UIs |

### Channel plugins

- **Telegram**: Each persona has its own bot. `long polling → onMessage → wake corresponding persona`; send via MCP `send_tg` → direct bot API, 3-attempt auto-retry
- **agent-bus / bothub**: Open AI-communication protocol letting different AIs message each other (a public official endpoint will be released later)

---

## Screenshots

![Main window · multiple personas as tabs](docs/screenshots/main-window.png)

---

## Privacy

aibutler runs **fully local**:

- All conversations, memory, and config live on your local disk
- Nothing uploads to third parties (except channels you explicitly configure: your TG bot / your agent-bus endpoints)
- Claude Agent SDK uses your Claude Pro subscription — no extra telemetry

`.gitignore` already excludes any file that could contain sensitive data (personas.json / tg.json / memory/ contents / tokens / offsets). **Do not** commit these to public forks.

---

## Contributing

PRs welcome in any direction:

- **Provider abstraction** — so aibutler can also work with GPT / Gemini / DeepSeek / local models
- **New channel plugins** — Discord / Slack / Enterprise WeChat / …
- **Vision / audio** — give AI eyes and ears
- **Screen / mouse / keyboard control** — let AI operate other apps
- **Memory algorithms** — better forgetting curves, semantic diffusion, temporal recall
- **UI polish** — visual, keyboard shortcuts, i18n, …

If you also believe "AI should be like a person — with personality, with memory, capable of growth," come build with us.

Issues and Discussions are open — feel free to chat first.

---

## License

MIT · Copyright (c) 2026 知秋 · [LICENSE](LICENSE)
