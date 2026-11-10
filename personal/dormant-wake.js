// dormant-wake.js — 没打开的人格守着自己的收件通道, 来了消息就把它唤醒(作者 2026-11-10 定)。
//
// 以前 TG / 统一通道 / bothub 都只在 installPlugins 里起, 人格标签没开就谁也不收, 消息堆在平台端。
// 这里给每个没打开的人格挂一个守候, 来消息 → wake(homeDir) 让 main.js openPersona, 消息一条不丢:
//   · TG: 只看不确认 —— getUpdates 不带新 offset 再拉, 正式的 tg-native 从 in_file 水位线起会把同一批原样拿到。
//   · 统一通道(飞书/钉钉/Discord/Slack): 长连接上的消息到手就算收走, 所以守候起的就是正式的 ChannelHost,
//     消息先攒在 buf; 打开人格时 wire.js 用 takeChannelHost 接手同一条连接并补交 buf。
//   · bothub: 拉到的先落人格目录 .bothub_inbox.json; 守候不 ack, 停掉后正式插件 start() 就把没交出去的补交。
// 开关在人格配置 wakeOnMessage: { channels, bothub }, 缺省都开; bothub 单独一个, 因为那是 AI 之间的往来。
'use strict';
const path = require('path');
const fs = require('fs');
const persona = require('../core/persona');
const { ChannelHost, TYPES } = require('./channels');
const { BothubPlugin } = require('./plugins/bothub');

const wakeFlags = (e) => {
  const w = (e && e.wakeOnMessage) || {};
  return { channels: w.channels !== false, bothub: w.bothub !== false };
};

// 这个人格该守哪些: 与 installPlugins 起插件的条件一致
function planOf(entry, registry) {
  const f = wakeFlags(entry);
  const plugins = entry.plugins || {};
  const plan = {};
  const tg = plugins.tg || {};
  if (f.channels && tg.bot_token && (tg.mode || (tg.enabled ? 'native' : 'off')) === 'native') plan.tg = tg;
  const specs = (plugins.channels || []).filter((c) => c && c.id && c.enabled !== false && TYPES[c.type]);
  if (f.channels && specs.some((c) => TYPES[c.type].dir === 'two')) plan.channels = specs;
  if (f.bothub) {
    const buses = (registry.ensureBuses ? registry.ensureBuses(entry.id) : plugins.buses) || [];
    const eps = buses.filter((b) => b.kind === 'bothub' && b.inbox === 'bothub' && b.base_url && b.agent)
      .map((b) => ({ id: b.id, url: b.base_url, agent: b.agent, token: b.token, poll_interval: b.poll_interval }));
    if (eps.length) plan.bothub = eps;
  }
  return plan;
}

const maxUpdateId = (file) => {
  let n = 0;
  try {
    for (const ln of fs.readFileSync(file, 'utf8').split('\n')) {
      try { const m = JSON.parse(ln); if (m && m.update_id > n) n = m.update_id; } catch (_) {}
    }
  } catch (_) {}
  return n;
};

// 跟 tg-native._appendMessage 同一套白名单: 过不了的消息正式插件也会丢, 不值得为它叫醒人格
const tgPasses = (tg, u) => {
  const m = u.message || u.channel_post || u.edited_message;
  if (!m || !m.chat) return false;
  if (Array.isArray(tg.chat_ids) && tg.chat_ids.length && !tg.chat_ids.some((id) => String(id) === String(m.chat.id))) return false;
  if (Array.isArray(tg.allow_from) && tg.allow_from.length && m.from && !tg.allow_from.some((id) => String(id) === String(m.from.id))) return false;
  return true;
};

function create({ registry, isOpen, wake, log }) {
  log = log || (() => {});
  const watch = new Map();     // homeDir → { sig, name, stopped, tgAbort, host, buf, bothub, waking }
  const handoff = new Map();   // homeDir → { host, buf } 等 wire.js 接手

  async function peekTg(w, tg, memDir) {
    let offset = maxUpdateId(tg.in_file || path.join(memDir, 'tg_inbox.jsonl'));
    let backoff = 1000;
    while (!w.stopped) {
      try {
        const ac = new AbortController(); w.tgAbort = ac;
        const t = setTimeout(() => ac.abort(), 35000);
        const resp = await fetch(`https://api.telegram.org/bot${tg.bot_token}/getUpdates?offset=${offset + 1}&timeout=25`, { signal: ac.signal })
          .finally(() => clearTimeout(t));
        if (resp.status === 401 || resp.status === 404) { log(`[dormant:${w.name}] TG token 无效 (HTTP ${resp.status}), 不守了`); return; }
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const j = await resp.json();
        if (!j.ok) throw new Error(j.description || 'TG API error');
        const res = j.result || [];
        if (res.some((u) => tgPasses(tg, u))) return trigger(w, 'Telegram');
        if (res.length) offset = res[res.length - 1].update_id;   // 全是白名单外的: 跳过去, 正式插件反正也丢
        backoff = 1000;
      } catch (e) {
        if (w.stopped) return;
        log(`[dormant:${w.name}] TG ${e && e.message} · 退避 ${backoff}ms`);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 60000);
      }
    }
  }

  function start(entry, plan, sig) {
    const homeDir = path.resolve(entry.homeDir);
    const memDir = persona.resolveMemoryDir(homeDir);
    const w = { sig, name: entry.name || path.basename(homeDir), homeDir, stopped: false, buf: [] };
    watch.set(homeDir, w);
    const kinds = Object.keys(plan);
    log(`[dormant:${w.name}] 守候 ${kinds.join(' · ')}`);
    if (plan.tg) peekTg(w, plan.tg, memDir).catch((e) => log(`[dormant:${w.name}] TG 守候崩溃: ${e && e.message}`));
    if (plan.channels) {
      w.host = new ChannelHost({
        personaName: w.name, log, stateFile: path.join(memDir, 'channels_state.json'),
        onMessage: (rec) => { w.buf.push(rec); trigger(w, rec.typeName || 'channel'); },
      });
      w.host.install(plan.channels).catch((e) => log(`[dormant:${w.name}] 通道起不来: ${e && e.message}`));
    }
    if (plan.bothub) {
      // 不 ack: 消息已在收件箱里标着没交出去, 正式插件一起来就补交。扫尾(sweep)只是心跳计数, 不叫醒。
      w.bothub = new BothubPlugin({ mode: 'native', endpoints: plan.bothub, _offsetDir: memDir }, w.name, log,
        (evt) => { if (evt.kind !== 'sweep') trigger(w, 'bothub'); });
      w.bothub.start(homeDir);
    }
  }

  // 停守候。keepHost: 统一通道的连接留给 wire.js 接手(不断线, 也就不丢断线那一下的消息)
  function stop(w, { keepHost = false } = {}) {
    w.stopped = true;
    watch.delete(w.homeDir);
    try { w.tgAbort && w.tgAbort.abort(); } catch (_) {}
    const p = w.bothub ? w.bothub.stop().catch(() => {}) : Promise.resolve();
    if (w.host) {
      if (keepHost) handoff.set(w.homeDir, { host: w.host, buf: w.buf });
      else w.host.stopAll().catch(() => {});
    }
    return p;
  }

  async function trigger(w, why) {
    if (w.waking || w.stopped) return;
    w.waking = true;
    log(`[dormant:${w.name}] ${why} 来消息 → 唤醒人格`);
    await stop(w, { keepHost: true });   // bothub 等停稳再开, 免得新旧两个循环同时写收件箱
    try { wake(w.homeDir, why); } catch (e) { log(`[dormant:${w.name}] 唤醒失败: ${e && e.message}`); }
  }

  // 对账: 没打开的人格按当前配置守候, 打开的 / 删掉的 / 关了开关的不守。配置变了就重起。
  function sync() {
    const seen = new Set();
    for (const e of registry.list()) {
      if (!e || !e.homeDir || isOpen(e.homeDir)) continue;
      const key = path.resolve(e.homeDir);
      try { if (!fs.existsSync(e.homeDir)) continue; } catch (_) { continue; }
      const plan = planOf(e, registry);
      const sig = JSON.stringify(plan);
      const cur = watch.get(key);
      if (cur && cur.sig === sig) { seen.add(key); continue; }
      if (cur) stop(cur);
      if (Object.keys(plan).length) { start(e, plan, sig); seen.add(key); }
    }
    for (const w of [...watch.values()]) if (!seen.has(w.homeDir)) stop(w);
  }

  // openPersona 一进门就调: 守候让位给正式插件(同步打停, 统一通道的连接交给 wire.js)
  function release(homeDir) {
    const w = watch.get(path.resolve(homeDir));
    if (w) stop(w, { keepHost: true });
  }

  function takeChannelHost(homeDir) {
    const h = handoff.get(path.resolve(homeDir));
    handoff.delete(path.resolve(homeDir));
    return h || null;
  }

  function stopAll() {
    for (const w of [...watch.values()]) stop(w);
    for (const { host } of handoff.values()) host.stopAll().catch(() => {});
    handoff.clear();
  }

  const status = () => [...watch.values()].map((w) => ({ name: w.name, homeDir: w.homeDir, kinds: Object.keys(JSON.parse(w.sig)) }));

  return { sync, release, takeChannelHost, stopAll, status };
}

module.exports = { create, planOf, wakeFlags };
