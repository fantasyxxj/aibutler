// secrets.js — 个人版的加密凭据(API key 等), 存 数据目录 app/secrets.json。
// 实现在 core/secrets-store.js(教育版共用); 加密不可用时拒绝保存, 不悄悄退回明文。
'use strict';

const path = require('path');
const paths = require('./paths');

module.exports = require('../core/secrets-store').create(() => path.join(paths.controlDir(), 'secrets.json'));
