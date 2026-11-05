#!/usr/bin/env node
'use strict';
// 把核心出厂记忆 leaf_core.json 打成货架上的下发包 pack.core.json。
//
// 为什么要这一步: leaf_core 随 app 出厂, 改了只能发版才到店里; 打成包放上货架后
// 就能和 common / restaurant 一样由服务端推 admin.pack 热灌, 不用发版。
//
// chores 刻意不带 —— 那是给开发者人格自己修记忆的功课, 店铺人格不该收到。

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'core/config/onboarding/knowledge/leaf_core.json');
const OUT_DIR = path.join(ROOT, 'industry/platform/shelf/core');
const OUT = path.join(OUT_DIR, 'pack.core.json');

const leaf = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : null;

const pack = {
  protocol: 2,
  id: 'core',
  version: String(leaf.version),
  core_compat: '>=0.0.1',
  display_name: '核心',
  _note: '核心出厂记忆(leaf_core)的下发副本, 由 scripts/build-core-pack.js 生成, 不要手改。'
       + ' 改知识请改 core/config/onboarding/knowledge/leaf_core.json 再重跑脚本。'
       + ' 它不是可选行业 —— 包里没有 persona 字段, list_packs 据此把它挡在行业下拉之外。',
  memory: {
    bundle_id: leaf.bundle_id,
    version: leaf.version,
    items: leaf.items,
  },
};

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(pack, null, 1) + '\n');

const same = prev && JSON.stringify(prev.memory) === JSON.stringify(pack.memory);
console.log(`[core-pack] ${pack.memory.items.length} 条 · bundle ${pack.memory.bundle_id} v${pack.version}`
  + ` · ${prev ? (same ? '内容未变' : `内容有变(上一份 v${prev.version})`) : '首次生成'}`);
console.log(`[core-pack] → ${path.relative(ROOT, OUT)}`);
if (prev && !same && String(prev.version) === String(pack.version)) {
  console.error('[core-pack] ⚠ 内容变了但 leaf_core.json 的 version 没动 —— 装机端靠 version 判断要不要取件, 不 bump 就收不到。');
  process.exit(1);
}
