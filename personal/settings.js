// settings.js — app 级设置(用户可改), 落在数据目录 app/settings.json。
//
// 与 config.local.json 的区别: 那个是**开发部署**配置(wakeloop 用, 不打包);
// 这个是**用户**配置, 装机版用户在设置面板里改, 跟着数据目录走。
//
// 代理: 国内用户 claude / GitHub / HuggingFace 基本都要过代理,
// 而代理地址每台机器都不一样 —— 只能让用户自己填, 程序读配置, 不许猜。
//
// language: 界面语言。'' = 还没选过 → 跟 OS 语言走(读不出来就 zh-CN)。
// 存 '' 而不是直接存 'zh-CN', 是为了区分"用户明确选了中文"和"从没选过" ——
// 后者应该跟着系统走, 前者不许被系统语言覆盖。
'use strict';

const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const DEFAULTS = {
  // 任务没做完就自动接着做(见 main.js maybeContinueTasks)。默认开 ——
  // "做完一步就停下等人推"是模型的稳定行为, 靠提示语叮嘱治不好, 只能由程序推。
  autoContinueTasks: true,
  proxy: {
    enabled: false,
    url: '',                              // 例: http://127.0.0.1:7890 (Clash/V2Ray 的 HTTP 端口)
    no_proxy: 'localhost,127.0.0.1,::1',  // 逗号分隔; 这些地址直连不过代理
  },
  // 接入方式: 订阅(复用 claude CLI 的 OAuth 登录态) 还是 API key。
  // 这是装机时定下的一件事, 不是运行时来回切的开关。
  //
  // 🔴 这里**只管"AI 从哪儿来"**(端点 + 凭据), 不含模型名 —— 用哪个模型是人格自己的字段,
  //    两者正交。曾经在这里放过一个 model 字段去压人格偏好, 那是错的: 换网关不该动人格
  //    选的模型。网关能提供哪些模型 → 由模型下拉去网关现拉(见 main.js list-model-options)。
  //
  // api_key 不在这里(明文), 走 secrets.js 加密存 —— 一条凭据一把: secrets['anthropic_api_key:<id>']。
  //
  // 🔴 多条而不是一条(作者 2026-09-09): 备用通道要能随时切, 所以一条条命名着放,
  //    人格按 credentialId 认领其中一条。老的单把 access 只留给迁移读一次, 见 main.js migrateCredentials。
  credentials: [],                        // [{ id, name, base_url }] · base_url 空 = 官方端点
  defaultCredentialId: '',                // 人格没指定时用哪条; 空 = 列表第一条
  access: {
    mode: 'subscription',                 // 'subscription' | 'api'
    base_url: '',                         // 空 = 官方 api.anthropic.com; 填了 = 第三方网关
  },
  language: '',
  theme: 'system',                      // 'system' | 'light' | 'dark' —— 界面深浅, 由 theme-ipc.js 落到 nativeTheme
};

function file() { return path.join(paths.controlDir(), 'settings.json'); }

function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return { ...DEFAULTS, ...raw,
      proxy: { ...DEFAULTS.proxy, ...(raw.proxy || {}) },
      // 整条替换而不是并集: 凭据是一张表, 删掉一条就该真的没了
      credentials: Array.isArray(raw.credentials) ? raw.credentials : [],
      access: { ...DEFAULTS.access, ...(raw.access || {}) } };
  } catch (_) {
    return JSON.parse(JSON.stringify(DEFAULTS));
  }
}

function write(patch) {
  const cur = read();
  const next = { ...cur, ...patch,
    proxy: { ...cur.proxy, ...(patch.proxy || {}) },
    access: { ...cur.access, ...(patch.access || {}) } };
  const f = file();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

module.exports = { read, write, file, DEFAULTS };
