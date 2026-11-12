// store-v2/lone-heal.js — 查出并删掉库里已经存着的半个 emoji(孤立代理项)。
// 写入口(schema.js _trackWrites)从 1.1.4 起已经挡住新的; 这里收拾挡住之前存进去的。
// 打开库时自动跑一次(meta lone_heal 记过就不再跑), doctor 每次都跑一遍并报修了几处。
//
// 判法: 本驱动把孤立代理项存成 3 字节 ED A0..BF xx。合法 UTF-8 里 ED 字节只出现在韩文(U+D000..D7FF)的开头,
// 所以 SQL 只筛「文本列里有 ED 字节」(一次 instr, 便宜), 再在 JS 里逐字节认 ED A0..BF。BLOB 列不扫。
// 🔴 修要按字节删, 不能读成字符串再删: 本驱动读 16 字节以上的文字走 TextDecoder, 那 3 字节会变成 3 个 U+FFFD,
// 字符串层面已经认不出它了(16 字节以内才读出真的半个 emoji)。
const stripBytes = (b) => {
  const out = [];
  for (let i = 0; i < b.length; i++) {
    if (b[i] === 0xED && b[i + 1] >= 0xA0 && b[i + 1] <= 0xBF && b[i + 2] >= 0x80 && b[i + 2] <= 0xBF) { i += 2; continue; }
    out.push(b[i]);
  }
  return Buffer.from(out).toString('utf8');
};

const BAD_BYTES = /\xED[\xA0-\xBF][\x80-\xBF]/;
const hit = (c) => `(typeof("${c}") = 'text' AND instr(CAST("${c}" AS BLOB), X'ED') > 0)`;

class LoneHealMixin {
  // → { found, fixed, where: [{ table, column, rowid, slug }] }
  loneSurrogateScan({ fix = false } = {}) {
    const db = this.db;
    const where = [];
    const tables = db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").map((r) => r.name);
    for (const t of tables) {
      const cols = db.all(`PRAGMA table_info("${t}")`).filter((c) => !/BLOB/i.test(c.type || '')).map((c) => c.name);
      if (!cols.length) continue;
      // 一张表扫一遍: 任一文本列中招就取出整行各列字节, 再逐列认
      const sel = cols.map((c, i) => `CAST("${c}" AS BLOB) AS c${i}`).join(', ');
      const rows = db.all(`SELECT rowid AS rid, ${sel}${t === 'nodes' ? ', slug' : ''} FROM "${t}" WHERE ${cols.map(hit).join(' OR ')}`);
      for (const r of rows) {
        cols.forEach((c, i) => {
          const b = r[`c${i}`];
          if (!b || !BAD_BYTES.test(Buffer.from(b).toString('latin1'))) return;
          where.push({ table: t, column: c, rowid: r.rid, slug: r.slug || null });
          if (fix) db.run(`UPDATE "${t}" SET "${c}" = ? WHERE rowid = ?`, [stripBytes(b), r.rid]);
        });
      }
    }
    return { found: where.length, fixed: fix ? where.length : 0, where };
  }

  // 打开库时调: 每个库只跑一次
  _healLoneOnce() {
    if (this.getMeta('lone_heal') === '1') return;
    try {
      const r = this.loneSurrogateScan({ fix: true });
      if (r.found) console.log(`[mem-selfcheck] 删掉半个 emoji ${r.fixed} 处: ${r.where.slice(0, 10).map((w) => w.slug || `${w.table}.${w.column}#${w.rowid}`).join(' ')}`);
      this.setMeta('lone_heal', '1');
    } catch (e) { console.log('[mem-selfcheck] 半个 emoji 体检失败:', e.message); }
  }
}

module.exports = LoneHealMixin;
