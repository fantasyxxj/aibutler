-- memory-schema-v2.sql — 图记忆底座 v2 · 命题化 + DB 即真源 + 数字主键
--
-- 与 v1(memory-store.js 内嵌 SCHEMA)的根本差别有三条:
--   1. DB 是唯一真源。.md 不再存在, 所以没有 file_path/mtime/size 这三列。
--   2. 节点的核心是 claim(命题, 可判真假的主张), 不是 description(摘要)。
--      摘要判不了真假, 所以两条记忆矛盾时看不出来, 边也就只能表达"有关"。
--   3. 主键是数字。语义 id 不可变而命题会被修正, 必然脱节 ——
--      feedback_cross_persona_relay_via_butler_not_direct 正文写的是"一律直连", 骗过 4 次。
--
-- 一句话尺度约束(沿用 v1): 常驻内存的量正比于【节点数】, 不是【正文总量】。
-- 所以 body 永远按需查, allNodes() 不取它。

-- ⚠️ 这行只对【建库那一次连接】有效, 是文档性的, 不构成保证。
-- foreign_keys 是连接级开关且【标准 SQLite 默认 OFF】—— node-sqlite3-wasm 恰好默认 ON(实测),
-- 但依赖驱动默认 = 换驱动/换版本那天外键静默失效, 悬空边重新长出来(现行库 95 条就是这么来的)。
-- 🔴 存储层每次 new Database() 之后必须显式 run 一次这句。
PRAGMA foreign_keys = ON;

-- ── 主表: 命题 ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS nodes (
  id          INTEGER PRIMARY KEY,          -- 数字主键。边只存两个数字
  slug        TEXT UNIQUE,                  -- 人读别名(= 老 id)。可改名且不断边, 这是与 v1 的关键解耦
  title       TEXT NOT NULL,
  claim       TEXT NOT NULL,                -- 🔴 命题。不设字数上限, 约束在性质: 必须是可判真假的陈述
  claim_provisional INTEGER DEFAULT 0,      -- 1 = 这条命题是机械迁移拿旧摘要兜底的, 还没人判过真假

  keywords    TEXT DEFAULT '',              -- 空格分隔。数字主键抹掉的检索信号在这里补回来
  anchors     TEXT DEFAULT '',              -- 空格分隔的 path:line。命题关于代码时给出该核对哪一行
  -- 🔴 空格分隔的项目名, **多值**。它回答的是「这条在哪些项目里验过」, 不是「这条归谁管」——
  -- 实测 628 条有路径证据的记忆里 40% 横跨两个以上项目, 单值会逼这四成选一个, 而选错正好
  -- 制造它本来要防的那种误用(在 A 项目成立的结论被套到 B 项目上)。
  -- 空 = 没标过, 不是"通用"; 别拿它过滤检索, 只拿它提示。靠人填, 填多少算多少。
  projects    TEXT DEFAULT '',
  body        TEXT DEFAULT '',              -- 冷正文。确认有用才展开读

  -- 🔴 译文挂在【同一个数字主键】上, 不裂成多个 slug: 边只连主键、热度也挂主键。
  -- 裂开会同时坏三样 —— 边分裂成三套要各自维护 · 日文人格 touch 了中文那份不涨热度 ·
  -- 查重按文本相似度判, 译文对原文得分很低会被放行成新节点, 于是库里躺着三条互不相识的同义命题。
  -- 两列而不是一列, 是被本文件开头那条尺度约束逼的(常驻内存量正比于节点数):
  --   translations 进 NODE_COLS 常驻 —— 检索要逐语言打分, 不常驻等于没做;
  --   body_i18n 不进 —— 与 body 同档, 确认有用才展开读。
  -- 都是 JSON。缺哪一语就没那个键, 回落源语言 —— 不必等翻译齐了才能发。
  translations TEXT DEFAULT '',             -- {lang: {title, claim, keywords}}   热 · 参与检索
  body_i18n    TEXT DEFAULT '',             -- {lang: body}                       冷 · 只在展开正文时读
  type        TEXT,                         -- feedback / reference / project / user
  importance  TEXT DEFAULT 'med',           -- 🔴 只剩 high/med/low。pinned 已挪进扩展表
  status      TEXT DEFAULT 'active',        -- active / superseded / archived
  scope       TEXT DEFAULT '',              -- 规则适用范围。两条规则打架时窄者胜
  provenance  TEXT DEFAULT 'local',         -- platform / local / override  (行业版语义: 这条知识是谁的)
  is_factory  INTEGER DEFAULT 0,            -- 1 = 出生教育灌的出厂原样  (butler 旧 origin='birth')
  exit_criteria TEXT DEFAULT '',            -- 仅 project_*
  review_due  TEXT DEFAULT '',              -- 仅 project_*
  created     TEXT,
  last_used   TEXT,
  use_count   INTEGER DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_nodes_status ON nodes(status);
CREATE INDEX IF NOT EXISTS idx_nodes_type   ON nodes(type);
CREATE INDEX IF NOT EXISTS idx_nodes_hot    ON nodes(last_used, use_count);

-- ── 关系: 一等公民, 不再从正文 [[]] 正则抠 ──────────────────────
-- rel 存 TEXT 且【不做枚举】: 提前穷举关系类型 = 死板。用起来再收敛。
-- 初始约定值 relates / supersedes / refines / supports / contradicts / part_of,
-- 其中只有 supersedes 带引擎硬动作(召回 dst 时强制附带「已被 src 推翻」)。
CREATE TABLE IF NOT EXISTS edges (
  src     INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  dst     INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  rel     TEXT NOT NULL DEFAULT 'relates',
  made_by TEXT NOT NULL DEFAULT 'human',    -- human / engine(共现自动长)。自动边量大, 不分开会淹没手写边
  weight  REAL DEFAULT 1.0,
  created TEXT,
  PRIMARY KEY (src, dst, rel)               -- 同一对节点可并存多种关系
);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst);
CREATE INDEX IF NOT EXISTS idx_edges_rel ON edges(rel);

-- ── 扩展表 ①: pinned = 最常用的快查集(不是最重要) ───────────────
-- 独立成表而不是 importance 的取值, 因为它与"重要性"正交:
-- 一条 low 的东西可以极常查, 一条 high 的东西可以半年不用。配额 30 由引擎管。
CREATE TABLE IF NOT EXISTS pinned (
  node_id  INTEGER PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  added_at TEXT,
  reason   TEXT DEFAULT ''
);

-- ── 扩展表 ②: 红线 = 一旦用到必须遵守 ───────────────────────────
-- 与 pinned 平级且可重叠。有自己的属性(触发/正确做法/档位/违反次数), importance 是标量装不下 ——
-- 这正是"想标红线就得占掉 pinned 30 个配额"的根因。
CREATE TABLE IF NOT EXISTS redlines (
  node_id        INTEGER PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  trigger_pattern TEXT DEFAULT '',          -- 供 PreToolUse hook 做硬过滤
  correct_action TEXT DEFAULT '',           -- 🔴 v1 没地方放"那正确做法是什么"
  level          TEXT DEFAULT 'block',      -- block / warn
  violations     INTEGER DEFAULT 0,
  last_violated  TEXT
);

-- ── 扩展表 ③: 错误日志(囤败方) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS error_log (
  id      INTEGER PRIMARY KEY,
  node_id INTEGER REFERENCES nodes(id) ON DELETE SET NULL,
  at      TEXT,
  raw     TEXT,
  count   INTEGER DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_errlog_node ON error_log(node_id);

-- ── 修订历史: 取代 _revisions/*.jsonl 351 个分片 ─────────────────
CREATE TABLE IF NOT EXISTS history (
  id      INTEGER PRIMARY KEY,
  node_id INTEGER REFERENCES nodes(id) ON DELETE CASCADE,
  at      TEXT NOT NULL,
  op      TEXT NOT NULL,                    -- upsert / append / set_importance / arbitrate / delete
  field   TEXT DEFAULT '',
  before  TEXT,
  after   TEXT,
  actor   TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_history_node ON history(node_id, at);

-- ── 向量(不变, 只是主键跟着换数字) ───────────────────────────────
-- 喂 embedder 的配方是 title+claim+keywords, 不喂 body: 长正文毒化向量(hubness), 真库实测。
CREATE TABLE IF NOT EXISTS vectors (
  node_id     INTEGER PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  dim         INTEGER NOT NULL,
  vec         BLOB NOT NULL,
  model       TEXT NOT NULL,
  src_hash    TEXT NOT NULL,
  embedded_at TEXT
);

-- ── 原话流水: 一切的底片 ────────────────────────────────────────
-- 节点里的 claim 全是我对原话的【加工】—— 会加工错、会漏、会带上当时的误解。底片在, 就永远
-- 能回去重洗一遍; 底片没了, 加工错的地方永远查不出来, 而且我不会知道自己错过。
--
-- 为什么现有的东西都不算底片: ctx_last.json 只留最后 6 轮且每次关档覆盖; SDK 的 jsonl 是
-- 它的私有格式(随版本变), 且 v3 起已经不 resume 它了, 等于没人保证它还在。
--
-- 🔴 一字不改、不截断。截断过的底片不是底片。
CREATE TABLE IF NOT EXISTS utterances (
  id     INTEGER PRIMARY KEY,
  at     TEXT NOT NULL,
  role   TEXT NOT NULL,                    -- user / assistant
  source TEXT DEFAULT '',                  -- ui/tg/line/peer/auto — 不标就看不出这轮为什么突然冒出来
  text   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_utter_at ON utterances(at);

-- ── 召回日志: 唯一的尺子 ────────────────────────────────────────
-- 记忆系统好不好, 不能靠我自己感觉。这张表是【确定性】的度量: 每次检索记下查了什么、
-- 命中几条、最高分多少, 以及**随后有没有 touch 命中的节点**。
--
-- 🔴 "查了但一条都没 touch" 就是召回失败的最强信号 —— 按铁律 4, touch 意味着"真靠它做了决策"。
-- 查了 5 条一条没用上, 说明这次检索没帮上忙。这个信号不需要 AI 自己承认失败(它不会),
-- 也不需要人打分, 是代码直接看得见的事实。
CREATE TABLE IF NOT EXISTS recall_log (
  id       INTEGER PRIMARY KEY,
  at       TEXT NOT NULL,
  q        TEXT NOT NULL,
  kind     TEXT DEFAULT 'query',           -- query / hot / neighbors / semantic
  hits     INTEGER DEFAULT 0,
  top_score REAL DEFAULT 0,                -- 存【把握度 0~1】不是 combined 绝对分: 绝对分随词数/语料平移, 横向不可比
  top_ids  TEXT DEFAULT '',                -- 逗号分隔; 判"有没有被 touch"要知道当时给了哪几条
  used     INTEGER DEFAULT 0,              -- 事后回填: 这批里有几条真被 touch 了
  filtered INTEGER DEFAULT 0               -- 被三分档挡掉几条。缺了它, "零命中"分不出是库里没有(补内容)还是筛太严(松阈值)
);
CREATE INDEX IF NOT EXISTS idx_recall_at ON recall_log(at);

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);

-- ── 迁移欠账为什么【没有】一张队列表 ──────────────────────────────
-- 曾经有过 review_queue(node_id 主键 · pending/done · skips), 装机械迁完还欠 AI 判的那批账。
-- 2026-08-17 作者拆掉:「那个 review 的合并了吧, 这样简单, 不用特殊做一个事务了」。
-- 根因是那张表在解一个不存在的问题 —— 欠账是【当前库的状态】, 不是【发生过的事件】:
-- 命题兜底没兜底、正文肥不肥、有没有 type、边断没断, 每次体检重新扫一遍就全知道了。
-- 预先记一份清单于是只带来坏处: 要标 done、要防复活、跳过算不算还完、人格标了 done 却没真做。
-- 现在这批账并进定期体检的 legacy_backlog 一条信号(checkup-gate.js), 无状态:
-- 问题还在就再戳一次, 收拾干净了自己消失。唯一需要落在库里的是 nodes.claim_provisional ——
-- 「这条命题是拿旧摘要兜底的」光看内容判不出来, 那是一个位, 不是一张队列表。

-- ── 升级自检任务 ──────────────────────────────────────────────
-- 装了新版本之后, 人格常常得对自己做点调整才算真正跟上: 这一版是整理迁移欠账、把 pinned
-- 压回配额, 下一版可能是别的。这类活【不是】库状态能重算出来的(上面那段说的体检就够了),
-- 而"把你的 pinned 收拾到 30 条以内"这种一次性的活有明确终点, 所以它才配有一张带 done 的表。
-- 🔴 作者 2026-08-17:「必做的只有一个时机, 升级之后第一次打开。之后没机会的, 用户在干活呢」——
--    这张表是那唯一一次强制窗口, 体检是之后的常态软戳, 两者口径相反不要混用。
-- 两个来源: 引擎升级时自检算出来的(如 pinned 超配额), 和出厂包里直接带的(加新任务不用改代码)。
-- 幂等靠 key: 同一件事重开机不会堆成两条, 已经 done 的也不会被重新派。
CREATE TABLE IF NOT EXISTS chores (
  key       TEXT PRIMARY KEY,          -- 幂等键, 形如 pinned_over_quota@0.0.58
  version   TEXT DEFAULT '',           -- 哪一版带来的
  title     TEXT NOT NULL,             -- 一句话说要干什么
  detail    TEXT DEFAULT '',           -- 怎么做 + 什么算做完
  status    TEXT DEFAULT 'pending',    -- pending / done
  queued_at TEXT,
  done_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_chores_status ON chores(status);
