// db.js — 插件数据库口子(宿主侧)。驱动全局共享、连接跟插件走。
//
// 设计(host_capability_bus_v1.md §4.1, 定案 2026-08-22):
//   - 驱动不打包进宿主。SQLite 用已在依赖里的 node-sqlite3-wasm(零动作);
//     别的(MySQL/PG/…)由人格装进【共享驱动目录】(dataDir/drivers, 不是人格目录), 这里 require。
//   - 连接跟插件走: 一个插件一份库。配置放 controlDir/plugin-db/<pkgId>.json,
//     不进签名包本体 —— 凭据不随包分发。
//   - 沙箱只能传 {op, sql, params}, 这里 prepared statement 执行, SQL 注入从根上堵死。
'use strict';

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const MAX_ROWS = 5000;   // 单次 query 最多带回的行数, 防一把拉爆内存

// 行业库的 DDL 闸。行业库的表结构只能由行业包的 migration 改, 沙箱递来的 SQL 一律拦。
// 只判开头一个词 —— 防的是我们自己写错和助手误操作, 不是防人: 店主自己拿 sqlite 工具
// 去改他那个文件, 后果归用户协议(作者 2026-09-17 定的口径)。
const DDL_HEAD = /^\s*(?:create|alter|drop|truncate|rename|attach|detach|vacuum|reindex)\b/i;

// 🔴 一个 controlDir 一个实例, 进程级复用。
// 行业版每执行一次命令就 commandCtx.create() 一次(industry/app/main.js:364), 每次都走到这里;
// 不缓存的话每按一次按钮就多一条永不释放的 sqlite 连接, 而「按文件路径分桶」只在单个实例内
// 生效 —— 跨实例照样对同一个行业库开出 N 条连接, 并发写回到 SQLITE_BUSY。
const INSTANCES = new Map();   // resolved controlDir -> instance

function create(opts) {
  const key = path.resolve(String(
    typeof opts.controlDir === 'function' ? opts.controlDir() : opts.controlDir));
  const hit = INSTANCES.get(key);
  if (hit) return hit;
  const inst = build(opts, key);
  INSTANCES.set(key, inst);
  return inst;
}

function build({ controlDir, dataDir }, instanceKey) {
  const ctrl = () => (typeof controlDir === 'function' ? controlDir() : controlDir);
  const data = () => (typeof dataDir === 'function' ? dataDir() : dataDir);
  // 🔴 按【解析后的库文件路径】分桶, 不按 pkgId —— 行业库是多个包共用一个文件的,
  // 按包分桶会对同一个 sqlite 开出 N 个 Database 实例, 并发写触发 SQLITE_BUSY。
  const conns = new Map();   // connKey -> { driver, db, file, managed }

  function dbDir() { return path.join(ctrl(), 'plugin-db'); }
  function industryDir() { return path.join(ctrl(), 'industry-db'); }
  function configFile(pkgId) { return path.join(dbDir(), `${pkgId}.json`); }
  function industryFile(industryId) { return path.join(industryDir(), `${industryId}.sqlite`); }

  // 连接配置: 插件目录旁(机器级、persona-neutral)一份 JSON。没有就 null → 走 SQLite 兜底。
  function loadConfig(pkgId) {
    try {
      const j = JSON.parse(fs.readFileSync(configFile(pkgId), 'utf8'));
      return (j && typeof j === 'object') ? j : null;
    } catch (_) { return null; }
  }

  // SQLite 兜底: 没配置、或配置了 driver:sqlite 都走这条。文件落在 plugin-db/<id>.sqlite。
  function sqliteFile(pkgId, cfg) {
    const f = (cfg && cfg.file) || path.join(dbDir(), `${pkgId}.sqlite`);
    return f === ':memory:' ? f : path.resolve(f);
  }

  function openSqlite(file) {
    if (file !== ':memory:') {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      healWalHeader(file);
    }
    const { Database } = require('node-sqlite3-wasm');
    return new Database(file);
  }

  // 被别的客户端切成 WAL 的库, 本驱动怎么都打不开 —— 而且 new Database() 不报错,
  // 其后每次读写才抛 unable to open database file; journal_mode 持久化在文件头,
  // 所以重启进程无效。打开前把文件头第 18/19 字节扳回 1 并删掉 sidecar。
  // 同 core/store-v2/schema.js 的 _healWalHeader(), 记忆库那边已实测有效。
  function healWalHeader(file) {
    try {
      if (!fs.existsSync(file)) return;
      const fd = fs.openSync(file, 'r+');
      const head = Buffer.alloc(2);
      fs.readSync(fd, head, 0, 2, 18);
      if (head[0] !== 2 && head[1] !== 2) { fs.closeSync(fd); return; }
      // 🔴 -wal 里还有没并回主库的事务时绝不硬扳: 那等于丢掉最后那批写入。
      const wal = `${file}-wal`;
      if (fs.existsSync(wal) && fs.statSync(wal).size > 0) {
        fs.closeSync(fd);
        console.error(`[db] 库是 WAL 模式且 -wal 中尚有未回放数据, 不敢硬改(会丢那批写入)。`
          + ` 请先跑: sqlite3 "${file}" "PRAGMA journal_mode=DELETE"`);
        return;
      }
      fs.writeSync(fd, Buffer.from([1, 1]), 0, 2, 18);
      fs.closeSync(fd);
      for (const s of ['-wal', '-shm']) { try { fs.unlinkSync(file + s); } catch (_) {} }
      console.error(`[db] 库被别的客户端切成过 WAL, 已扳回 rollback: ${file}`);
    } catch (e) {
      console.error(`[db] WAL 自愈没做成(库可能仍打不开): ${e && e.message}`);
    }
  }

  // 共享驱动目录: dataDir/drivers。人格在这下面 npm install mysql2 / pg / … 装一次人人共用。
  function driverDir() { return path.join(data(), 'drivers'); }

  function requireDriver(driverName) {
    // 共享驱动目录优先; 宿主自己 node_modules 兜底(只有 node-sqlite3-wasm 会走这条)。
    try {
      const req = createRequire(path.join(driverDir(), '_require.js'));
      return req(driverName);
    } catch (_) {}
    try { return require(driverName); } catch (_) { return null; }
  }

  // 落在 industry-db/ 下的就是行业库 —— 路径即语义, 不另设配置字段。
  function isIndustryFile(file) {
    return file !== ':memory:' && path.dirname(file) === path.resolve(industryDir());
  }

  function openDriver(pkgId, cfg) {
    const driver = String((cfg && cfg.driver) || 'sqlite').trim();
    if (driver === 'sqlite') {
      const file = sqliteFile(pkgId, cfg);
      return { driver, db: openSqlite(file), file, managed: isIndustryFile(file) };
    }
    const mod = requireDriver(driver);
    if (!mod) {
      return { driver, db: null, err: `驱动 ${driver} 没装 —— 到 ${driverDir()} 下 npm install ${driver}` };
    }
    // 非 SQLite 是接口占位: P1 只通了 SQLite, 别的驱动接了连接串再往下走。
    return { driver, db: null, err: `驱动 ${driver} 的宿主连接还没接好(留接口)` };
  }

  function connKey(pkgId, cfg) {
    const driver = String((cfg && cfg.driver) || 'sqlite').trim();
    // 非 sqlite 还没接通, 维持按包分桶; 通了之后这里要换成按连接串分桶。
    if (driver !== 'sqlite') return `${driver}#${pkgId}`;
    return `sqlite#${sqliteFile(pkgId, cfg)}`;
  }

  const keyOf = new Map();   // pkgId -> connKey, 免得每次操作都去读一遍配置文件
  function conn(pkgId) {
    const cached = keyOf.get(pkgId);
    if (cached && conns.has(cached)) return conns.get(cached);
    const cfg = loadConfig(pkgId) || {};
    const key = connKey(pkgId, cfg);
    keyOf.set(pkgId, key);
    if (conns.has(key)) return conns.get(key);
    const c = openDriver(pkgId, cfg);
    conns.set(key, c);
    return c;
  }

  // 给 migration runner 用的内部口: 直接按行业 id 开库, 不经沙箱、不过 DDL 闸。
  // 行业库的建表与加列只能从这条路进来。
  function openIndustry(industryId) {
    const file = path.resolve(industryFile(industryId));
    const key = `sqlite#${file}`;
    if (conns.has(key)) return conns.get(key);
    const c = { driver: 'sqlite', db: openSqlite(file), file, managed: true };
    conns.set(key, c);
    return c;
  }

  // 沙箱侧 ctx.db 的落点。op = query|run, 都走 prepared statement(params)。
  function runOp(pkgId, op, sql, params) {
    if (!pkgId) return { ok: false, code: 'missing_pkg', message: 'db: 认不出是哪个包在连库' };
    const c = conn(pkgId);
    if (!c.db) return { ok: false, code: 'no_driver', message: c.err };
    // 行业库的结构只认行业包的 migration。私有库不拦 —— 插件自己的库自己建表, 一直如此。
    if (c.managed && DDL_HEAD.test(String(sql || ''))) return ddlRefusal();
    return execOn(c, op, sql, params);
  }

  function ddlRefusal() {
    return { ok: false, code: 'ddl_forbidden',
             message: '行业库的表结构只能随行业包升级改动, 这里不接受建表/改表语句。'
                      + '要加字段请在行业包的 schema migration 里加一版。' };
  }

  /* 助手自己查行业库的口。它不是插件, 没有 pkgId, 但一样过 DDL 闸 ——
     「不提供修改内置表结构的能力」对助手和对插件是同一句话。 */
  function runIndustry(industryId, op, sql, params) {
    if (!industryId) return { ok: false, code: 'missing_industry', message: '没说是哪个行业的库' };
    let c;
    try { c = openIndustry(industryId); }
    catch (e) { return { ok: false, code: 'db_failed', message: (e && e.message) || String(e) }; }
    if (!c.db) return { ok: false, code: 'no_driver', message: c.err || '行业库打不开' };
    if (DDL_HEAD.test(String(sql || ''))) return ddlRefusal();
    return execOn(c, op, sql, params);
  }

  /* 行业库里有什么表、每张表有哪些列。给助手用时不常驻 —— 它问一次才列一次。 */
  function describeIndustry(industryId) {
    let c;
    try { c = openIndustry(industryId); }
    catch (e) { return { ok: false, code: 'db_failed', message: (e && e.message) || String(e) }; }
    if (!c.db) return { ok: false, code: 'no_driver', message: c.err || '行业库打不开' };
    try {
      let version = 0;
      try { const v = c.db.all('SELECT version FROM _schema_version WHERE id = 1');
            version = v.length ? Number(v[0].version) || 0 : 0; } catch (_) {}
      const names = c.db.all("SELECT name FROM sqlite_master WHERE type = 'table'"
                             + " AND name NOT LIKE 'sqlite_%' AND name <> '_schema_version'"
                             + ' ORDER BY name').map((x) => x.name);
      const tables = names.map((name) => ({
        table: name,
        // 表名来自 sqlite_master, 但仍然转义双引号 —— 拼字符串进 SQL 的地方一律不赌。
        columns: c.db.all(`PRAGMA table_info("${String(name).replace(/"/g, '""')}")`)
          .map((x) => `${x.name} ${x.type || ''}`.trim() + (x.notnull ? ' NOT NULL' : '')
                      + (x.pk ? ' PK' : '')),
      }));
      return { ok: true, industry: industryId, schema_version: version, tables };
    } catch (e) {
      return { ok: false, code: 'db_failed', message: (e && e.message) || String(e) };
    }
  }

  /* 行业库をまるごと一つのファイルへ書き出す。店主が自分で持って行く為の口 ——
     「自分のデータは自分の責任」と言う以上、持ち出す道具は此方が用意する。
     VACUUM INTO は原子的で、接続を閉じる必要が無い(コピーと違い書きかけを掴まない)。
     🔴 既に在るファイルは上書きしない —— 上書きで消えるのは店主の前回の控え。 */
  function exportIndustry(industryId, destPath) {
    if (!destPath) return { ok: false, code: 'no_dest', message: '書き出し先が指定されていません' };
    const dest = path.resolve(String(destPath));
    if (fs.existsSync(dest)) {
      return { ok: false, code: 'dest_exists', message: `既にファイルが在ります: ${dest}` };
    }
    let c;
    try { c = openIndustry(industryId); }
    catch (e) { return { ok: false, code: 'db_failed', message: (e && e.message) || String(e) }; }
    if (!c.db) return { ok: false, code: 'no_driver', message: c.err || '行業庫が開けません' };
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      c.db.run('VACUUM INTO ?', [dest]);
      return { ok: true, file: dest, bytes: fs.statSync(dest).size };
    } catch (e) {
      return { ok: false, code: 'export_failed', message: (e && e.message) || String(e) };
    }
  }

  /* 行業庫を消す。壊れた時に作り直す為の口 —— 消した後は schema 包が
     _schema_version ごと v1 から積み直すので、空の状態から普通に使い始められる。
     🔴 消す前に接続を閉じる: 開いたままファイルだけ消すと、その接続は
     「在るはずの無いファイル」を掴んだまま生き続ける。 */
  function dropIndustry(industryId) {
    const file = path.resolve(industryFile(industryId));
    const key = `sqlite#${file}`;
    const c = conns.get(key);
    if (c) {
      try { if (c.db && typeof c.db.close === 'function') c.db.close(); } catch (_) {}
      conns.delete(key);
      for (const [pkg, k] of keyOf.entries()) if (k === key) keyOf.delete(pkg);
    }
    let removed = false;
    try { fs.unlinkSync(file); removed = true; } catch (_) {}
    for (const s of ['-wal', '-shm']) { try { fs.unlinkSync(file + s); } catch (_) {} }
    return { ok: true, file, removed };
  }

  function execOn(c, op, sql, params) {
    try {
      // 🔴 成功也必须给 message —— 送到模型那侧的**只有 message**, 不给等于没通知:
      // AI 收到的是光秃秃一句「已收到 [包id.命令名]」, 答不出写了几行、id 是多少,
      // 而给 db 设 notify_ai=true 的全部理由就是"执行完 AI 要答得出写库了没"。
      // 2026-08-25 真机撞上: 连点三个 db 命令, AI 侧三条回执全是空的, 看不出成功还是失败。
      if (op === 'run') {
        const r = c.db.run(sql, params);
        const changes = r && r.changes;
        const lastInsertId = r && r.lastInsertRowid;
        return { ok: true, changes, lastInsertId,
                 message: `write ok: ${changes == null ? 0 : changes} row(s) affected`
                          + (lastInsertId ? `, new row id=${lastInsertId}` : '') };
      }
      const rows = c.db.all(sql, params);
      const kept = rows.slice(0, MAX_ROWS);
      const cut = rows.length > kept.length ? ` (truncated at ${MAX_ROWS})` : '';
      return { ok: true, rows: kept,
               message: `${kept.length} row(s) found${cut}`
                        + (kept.length ? `, first few: ${JSON.stringify(kept.slice(0, 3))}` : '') };
    } catch (e) {
      return { ok: false, code: 'db_failed', message: e && e.message ? e.message : String(e) };
    }
  }

  function close() {
    for (const c of conns.values()) {
      try { if (c.db && typeof c.db.close === 'function') c.db.close(); } catch (_) {}
    }
    conns.clear();
    keyOf.clear();
    // 关掉就从实例表里摘掉 —— 否则下一次 create 拿回这个已关闭的壳, 语义含糊。
    if (instanceKey) INSTANCES.delete(instanceKey);
  }

  return { runOp, runIndustry, describeIndustry, exportIndustry, dropIndustry,
           close, configFile, openIndustry, industryFile, industryDir };
}

module.exports = { create, MAX_ROWS };
