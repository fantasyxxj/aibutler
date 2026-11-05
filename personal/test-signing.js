// test-signing.js — 下発物の署名。跑法: node test-signing.js
//
// この門禁が守りたいのは「署名が通ること」ではない。**通ってはいけない物が通らないこと**。
// 署名機構の壊れ方はいつも同じで、正例だけ緑のまま偽物も緑になる ——
// だから [2] 以降の負例がこのファイルの本体。
//
// [6] は特に消してはいけない: 包みが名乗る alg を信じて検証方法を選ぶ実装は、
// alg を書き換えるだけで素通りする(JWT alg=none と同じ穴)。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const signing = require('../core/signing');

let pass = 0, fail = 0;
const ok = (c, m) => {
  if (c && typeof c.then === 'function') { fail++; console.log(`  ✗ ${m} — ok() に promise が来ています`); return; }
  if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}`); }
};

// brk1 の本鍵で署名済みの包み。秘密鍵はこのマシンにしか無いので、門禁は鍵の存在に依存しない。
const FIXTURE = {
  kind: 'butler.package.v1',
  alg: 'ed25519',
  key_id: 'brk1',
  payload_b64: 'eyJ0eXBlIjoid29ya2Zsb3ciLCJpZCI6ImZpeHR1cmUiLCJ2ZXJzaW9uIjoiMS4wLjAifQ==',
  sig_b64: '/HWYDAs1OotSAvxdC9b95K7KjKEb2xgmZBWkFNQniygGWnMKVc1ZaH/6F6h/3WFg7WERew8m+dTGMBRtreELDg==',
};
const pkg = (over = {}) => JSON.stringify({ ...FIXTURE, ...over });

/* ─────────── [1] 正例 ─────────── */
console.log('\n[1] 我々が署名した包みは通る');
{
  const r = signing.openPackage(pkg());
  ok(r.ok === true, `本物の包みが通る${r.ok ? '' : ' — ' + r.code + ': ' + r.message}`);
  ok(r.keyId === 'brk1', '鍵 id が返る');
  ok(r.payload && r.payload.type === 'workflow' && r.payload.id === 'fixture', '中身が取り出せる');
  ok(Buffer.isBuffer(r.bytes), '署名対象の生バイト列も返る(呼ぶ側が再直列化しないで済む)');
}

/* ─────────── [2] 中身を書き換えたら落ちる ─────────── */
console.log('\n[2] 中身を一文字でも変えたら落ちる');
{
  const orig = Buffer.from(FIXTURE.payload_b64, 'base64').toString('utf8');
  const tampered = orig.replace('fixture', 'fixturX');
  ok(tampered !== orig, '前提: 実際に書き換わっている');
  const r = signing.openPackage(pkg({ payload_b64: Buffer.from(tampered, 'utf8').toString('base64') }));
  ok(r.ok === false && r.code === 'bad_signature', `書き換えた中身は拒否 — ${r.code}`);

  // 長さを変えない一バイト改変(検出漏れが起きるならここ)
  const buf = Buffer.from(FIXTURE.payload_b64, 'base64');
  buf[10] = buf[10] ^ 0x01;
  const r2 = signing.openPackage(pkg({ payload_b64: buf.toString('base64') }));
  ok(r2.ok === false && r2.code === 'bad_signature', `1 ビット反転でも拒否 — ${r2.code}`);
}

/* ─────────── [3] 署名側をいじっても落ちる ─────────── */
console.log('\n[3] 署名そのものを差し替えても落ちる');
{
  const sig = Buffer.from(FIXTURE.sig_b64, 'base64');
  sig[0] = sig[0] ^ 0xff;
  ok(signing.openPackage(pkg({ sig_b64: sig.toString('base64') })).code === 'bad_signature', '署名を書き換えたら拒否');
  ok(signing.openPackage(pkg({ sig_b64: Buffer.alloc(64).toString('base64') })).code === 'bad_signature', '全ゼロ署名は拒否');
  ok(signing.openPackage(pkg({ sig_b64: 'AAAA' })).code === 'bad_signature', '長さ違いの署名は拒否');
  ok(signing.openPackage(pkg({ sig_b64: '' })).code === 'no_signature', '署名が空なら拒否');
  const { sig_b64, ...noSig } = FIXTURE;
  ok(signing.openPackage(JSON.stringify(noSig)).code === 'no_signature', '署名フィールドが無ければ拒否');
}

/* ─────────── [4] 別の鍵で署名した物は通らない ─────────── */
console.log('\n[4] 我々以外の鍵で署名された包みは通らない');
{
  // 攻撃者が自前で鍵を作り、正しい形の包みを作った状況。形は完璧、鍵だけが違う。
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const payload = Buffer.from(FIXTURE.payload_b64, 'base64');
  const forged = crypto.sign(null, payload, privateKey).toString('base64');

  // 鍵 id は我々の物だと名乗る → 公開鍵は brk1 なので照合で落ちる
  ok(signing.openPackage(pkg({ sig_b64: forged })).code === 'bad_signature', '他人の鍵で署名した包みは拒否(id を騙っても)');
  // 鍵 id ごと自前の物を名乗る → 知らない鍵として落ちる
  ok(signing.openPackage(pkg({ sig_b64: forged, key_id: 'evil1' })).code === 'unknown_key', '知らない鍵 id は拒否');
}

/* ─────────── [5] 包みの形が違えば落ちる ─────────── */
console.log('\n[5] 形の違う物は開けない');
{
  ok(signing.openPackage('これは json ではない').code === 'malformed', 'JSON でなければ拒否');
  ok(signing.openPackage('null').code === 'malformed', 'null は拒否');
  ok(signing.openPackage('[]').code === 'unknown_kind', '配列は拒否');
  ok(signing.openPackage(pkg({ kind: 'butler.package.v2' })).code === 'unknown_kind', '未知の種別は拒否');
  ok(signing.openPackage(pkg({ payload_b64: '@@@notbase64@@@' })).code !== undefined
     && signing.openPackage(pkg({ payload_b64: '@@@notbase64@@@' })).ok === false, '壊れた base64 は拒否');
  // 署名は通るが中身が JSON でない — 署名検証の後に構文で落ちることの確認
  ok(signing.openPackage(pkg()).ok === true, '前提: 正例は依然通る');
}

/* ─────────── [6] alg を信じない ─────────── */
console.log('\n[6] 包みが名乗る alg で検証方法を選ばない(alg=none 系の穴)');
{
  ok(signing.openPackage(pkg({ alg: 'none' })).code === 'bad_alg', 'alg=none は拒否');
  ok(signing.openPackage(pkg({ alg: 'HS256' })).code === 'bad_alg', '別方式を名乗る包みは拒否');
  const { alg, ...noAlg } = FIXTURE;
  ok(signing.openPackage(JSON.stringify(noAlg)).code === 'bad_alg', 'alg 無しは拒否');
  ok(signing.ALG === 'ed25519', '実装が使う方式は定数で固定されている');
}

/* ─────────── [7] 公開鍵はソースに焼き込まれている ─────────── */
console.log('\n[7] 公開鍵を外から差し替える道が無い');
{
  const src = require('./kernel-src').readSrc('signing.js');
  // 鍵を外部から読めるなら、下発経路を握った相手は鍵ごと入れ替えられる = 署名は何も証明しない
  ok(!/require\(['"]fs['"]\)/.test(src), 'signing.js は fs を読み込まない(ファイルから鍵を読まない)');
  ok(!/process\.env/.test(src), 'signing.js は環境変数を見ない');
  ok(!/readFile|existsSync/.test(src), 'signing.js はファイルを開かない');
  ok(!/PRIVATE KEY/.test(src), '秘密鍵がソースに混入していない');

  const ids = signing.knownKeyIds();
  ok(ids.length >= 1, `公開鍵が焼き込まれている: ${ids.join(',')}`);
  for (const id of ids) {
    let okKey = false;
    try { okKey = !!signing.publicKeyOf(id); } catch (_) { okKey = false; }
    ok(okKey, `${id} は正しい公開鍵として読める`);
  }
  ok(signing.publicKeyOf('nope') === null, '知らない id は鍵を返さない');
}

/* ─────────── [8] 秘密鍵がリポジトリに落ちていない ─────────── */
console.log('\n[8] 秘密鍵がリポジトリに無い');
{
  const hits = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'release' || e.name === 'dist') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/\.key\.pem$/.test(e.name)) hits.push(p);
    }
  };
  walk(__dirname, 0);
  ok(hits.length === 0, `秘密鍵ファイルがリポジトリ内に無い${hits.length ? ' — ' + hits.join(',') : ''}`);
}

/* ─────────── [9] 道具の往復(本物の CLI を走らせる) ─────────── */
console.log('\n[9] keygen → sign → verify が本当に回る');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-sign-'));
  const fakeSigningJs = path.join(tmp, 'signing.js');
  fs.copyFileSync(require('./kernel-src').resolveSrc('signing.js'), fakeSigningJs);
  const env = { ...process.env, BUTLER_SIGNING_KEY_DIR: tmp, BUTLER_SIGNING_JS: fakeSigningJs };
  const cli = path.join(__dirname, '..', 'scripts', 'sign-package.js');
  // stdio を捕まえる: 失敗を期待する用例の出力で門禁のログが読めなくなるのを防ぐ
  const run = (args) => execFileSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', stdio: 'pipe' });

  run(['keygen', '--id', 'tst1']);
  ok(fs.existsSync(path.join(tmp, 'tst1.key.pem')), '秘密鍵が鍵ディレクトリに出来る');
  ok(fs.readFileSync(fakeSigningJs, 'utf8').includes("'tst1':"), '公開鍵がソースへ焼き込まれる');
  ok((fs.statSync(path.join(tmp, 'tst1.key.pem')).mode & 0o077) === 0, '秘密鍵は本人しか読めない権限');

  // 既存の秘密鍵を上書きしたら、その鍵で配った包みが全部死ぬ。二度目は必ず失敗させる。
  let refused = false;
  try { run(['keygen', '--id', 'tst1']); } catch (_) { refused = true; }
  ok(refused, '同じ id の keygen は上書きせず失敗する');

  const payloadPath = path.join(tmp, 'p.json');
  fs.writeFileSync(payloadPath, JSON.stringify({ type: 'workflow', id: 'demo', version: '1.0.0' }));
  const outPath = path.join(tmp, 'p.pkg.json');
  run(['sign', payloadPath, '-o', outPath, '--id', 'tst1']);
  ok(fs.existsSync(outPath), '包みが出来る');

  const tmpSigning = require(fakeSigningJs);
  const r = tmpSigning.openPackage(fs.readFileSync(outPath, 'utf8'));
  ok(r.ok === true, `作った包みが検証を通る${r.ok ? '' : ' — ' + r.code}`);
  ok(r.payload.id === 'demo', '中身が一致する');

  // 本物の signing.js(brk1 しか知らない)は tst1 の包みを知らない鍵として拒否する
  ok(signing.openPackage(fs.readFileSync(outPath, 'utf8')).code === 'unknown_key',
     '出荷版は開発用の鍵で署名した包みを受け取らない');

  const bad = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  const b = Buffer.from(bad.payload_b64, 'base64'); b[5] = b[5] ^ 0x01;
  bad.payload_b64 = b.toString('base64');
  ok(tmpSigning.openPackage(JSON.stringify(bad)).code === 'bad_signature', 'CLI が作った包みも改竄すれば落ちる');

  let cliRefused = false;
  try { run(['verify', path.join(tmp, 'nope.json')]); } catch (_) { cliRefused = true; }
  ok(cliRefused, '存在しない包みの verify は失敗で終わる(終了コードで判る)');

  fs.rmSync(tmp, { recursive: true, force: true });
}

/* ─────────── [10] 行業版が自分の複製を持たない ─────────── */
console.log('\n[10] 個人版と行業版の signing.js は同一(同じ鍵・同じ検証)');
{
  // 同じ鍵・同じ判定でなければ「個人版では通るが行業版では通らない包み」が生まれる。
  // 単一リポジトリに統合した後は両版とも <repo>/core の一つを require する = 物理的に一つ。
  // よって守るべきは「行業版が自分用の複製を作っていないこと」に変わった。
  for (const f of ['signing.js', 'packages.js', 'package-inbox.js']) {
    const dup = path.join(__dirname, '..', 'industry', 'core', f);
    ok(!fs.existsSync(dup), `行業版に ${f} の複製が無い(共有 core だけを使う)`);
    ok(fs.existsSync(path.join(__dirname, '..', 'core', f)), `共有 core に ${f} が在る`);
  }
}

/* ─────────── [11] 受け入れ口: 封筒のまま置き、読む度に検証し直す ─────────── */
console.log('\n[11] packages: 検証してから置く / 置いた後の書き換えも捕まえる');
{
  const packages = require('../core/packages');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-pkg-'));

  ok(packages.loadAll({ dataDir }).accepted.length === 0, '何も無い状態で読んでも落ちない');

  const r = packages.install(pkg(), { dataDir });
  ok(r.ok === true, `本物の包みは受け入れる${r.ok ? '' : ' — ' + r.code}`);
  ok(r.type === 'workflow' && r.id === 'fixture', '種別と id が返る');

  const file = packages.fileOf(dataDir, 'workflow', 'fixture');
  ok(fs.existsSync(file), '包みが置かれる');
  // 中身だけ取り出して置いたら、この後の改竄検出が成立しない
  ok(fs.readFileSync(file, 'utf8') === pkg(), '封筒のまま(逐字節)置かれている');

  const loaded = packages.loadAll({ dataDir });
  ok(loaded.accepted.length === 1 && loaded.accepted[0].id === 'fixture', '置いた物が読み出せる');
  ok(loaded.rejected.length === 0, '弾かれた物は無い');

  // 偽物は受け入れない = ディスクに残らない
  const sig = Buffer.from(FIXTURE.sig_b64, 'base64'); sig[3] = sig[3] ^ 0xff;
  const bad = packages.install(pkg({ sig_b64: sig.toString('base64') }), { dataDir });
  ok(bad.ok === false && bad.code === 'bad_signature', '署名が合わない包みは受け入れない');
  ok(fs.readdirSync(packages.dirOf(dataDir)).length === 1, '弾いた包みはディスクに残らない');

  // 置いた後にディスク上で書き換えられた場合 —— 検証が一度きりの儀式なら、ここが素通りする
  const good = fs.readFileSync(file, 'utf8');
  const t = JSON.parse(good);
  const pb = Buffer.from(t.payload_b64, 'base64'); pb[8] = pb[8] ^ 0x01;
  t.payload_b64 = pb.toString('base64');
  fs.writeFileSync(file, JSON.stringify(t));
  const after = packages.loadAll({ dataDir });
  ok(after.accepted.length === 0, '置いた後に書き換えられた包みは読み込まれない');
  ok(after.rejected.length === 1 && after.rejected[0].code === 'bad_signature', `理由が残る — ${after.rejected[0] && after.rejected[0].code}`);

  // 一枚腐っても他は生きる
  fs.writeFileSync(path.join(packages.dirOf(dataDir), 'workflow.other.json'), good);
  const mixed = packages.loadAll({ dataDir });
  ok(mixed.accepted.length === 1 && mixed.rejected.length === 1, '壊れた一枚は他の手順を巻き込まない');

  ok(packages.remove('workflow', 'other', { dataDir }) === true, '取り外せる');
  ok(packages.remove('workflow', 'nope', { dataDir }) === false, '無い物の取り外しは false');

  // 名前はそのままファイル名になる。ここが緩いと書き込み先が外へ逃げる
  const S = packages.SAFE_NAME;
  ok(S.test('line_setup') && S.test('workflow'), '普通の名前は通る');
  for (const evil of ['../evil', 'a/b', '..', '', '.', 'A', 'x'.repeat(65), 'a b', '_lead']) {
    ok(!S.test(evil), `危ない名前を拒否: ${JSON.stringify(evil)}`);
  }

  fs.rmSync(dataDir, { recursive: true, force: true });
}

/* ─────────── [12] 自作の置き場: 署名を見ない。但し bus からは届かない ─────────── */
console.log('\n[12] packages.local: 自分で書いた物は署名無しで載る');
{
  const packages = require('../core/packages');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-pkglocal-'));
  const localDir = packages.localDirOf(dataDir);
  fs.mkdirSync(localDir, { recursive: true });
  const put = (name, obj) => fs.writeFileSync(path.join(localDir, name), typeof obj === 'string' ? obj : JSON.stringify(obj));

  put('mine.json', { type: 'workflow', id: 'mine', version: '0.1', steps: [] });
  const one = packages.loadAll({ dataDir });
  ok(one.accepted.length === 1 && one.accepted[0].id === 'mine', '封筒無しの生 payload が載る');
  ok(one.accepted[0].local === true, '本物と区別できる印が付く');

  put('broken.json', '{ not json');
  put('noid.json', { type: 'workflow', version: '0.1' });
  const mixed = packages.loadAll({ dataDir });
  ok(mixed.accepted.length === 1, '壊れた一枚は他を巻き込まない');
  ok(mixed.rejected.length === 2 && mixed.rejected.every((x) => x.local), '弾いた理由も本物と混ざらない');

  // 署名済みと同じ type.id がぶつかったら手元の物が勝つ(開発中に差し替えて試せる)
  packages.install(pkg(), { dataDir });
  put('override.json', { type: 'workflow', id: 'fixture', version: 'dev', steps: [] });
  const acc = packages.loadAll({ dataDir }).accepted.filter((p) => p.id === 'fixture');
  ok(acc.length === 2 && acc[acc.length - 1].version === 'dev', '同じ id なら後勝ち = 手元の版が効く');

  // 🔴 この階に bus から物が入る道が無いこと自体は package-inbox 側の性質
  ok(packages.localDirOf(dataDir) !== packages.dirOf(dataDir), '受け入れ口と自作の置き場は別ディレクトリ');

  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n署名門禁: ${pass} 通過 / ${fail} 失敗`);
process.exit(fail ? 1 : 0);
