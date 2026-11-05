#!/usr/bin/env node
// sign-package.js — 我々の側の道具。下発物に署名して一枚の包みにする。
//
// 秘密鍵は **リポジトリの外**(既定 ~/.butler-signing/) に置く。中に置けば、いつか必ず
// 誰かが git add . で出荷してしまう —— .gitignore は「入れない」ではなく「見逃す」設定でしかない。
//
//   node scripts/sign-package.js keygen [--id brk1]      鍵を作る(公開鍵は signing.js に自動で焼き込む)
//   node scripts/sign-package.js sign <payload.json> [-o out.pkg.json] [--id brk1]
//   node scripts/sign-package.js verify <pkg.json>       出荷前の自己確認(装機端と同じ検証器を通す)
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// 門禁が本物の keygen を走らせても本物の signing.js を汚さないように、差し込み先を差し替えられる。
const SIGNING_JS = process.env.BUTLER_SIGNING_JS || path.join(__dirname, '..', 'core', 'signing.js');
const KEY_DIR = process.env.BUTLER_SIGNING_KEY_DIR || path.join(os.homedir(), '.butler-signing');
const PLACEHOLDER = '  // <KEYS_PLACEHOLDER>';

function die(msg) { console.error(`✗ ${msg}`); process.exit(1); }

function argOf(argv, name, dflt) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}

function privateKeyPath(keyId) { return path.join(KEY_DIR, `${keyId}.key.pem`); }

function keygen(argv) {
  const keyId = argOf(argv, '--id', 'brk1');
  if (!/^[a-z0-9_-]+$/.test(keyId)) die('鍵 id は英小文字/数字/-/_ のみ');

  const keyPath = privateKeyPath(keyId);
  // 上書きは絶対にさせない。既存の秘密鍵を潰すと、その鍵で署名済みの包みが全部検証不能になる。
  if (fs.existsSync(keyPath)) die(`秘密鍵が既にあります(上書きしません): ${keyPath}`);

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });

  fs.mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyPath, privPem, { mode: 0o600 });

  embedPublicKey(keyId, pubPem);

  console.log(`✓ 鍵を作りました  id=${keyId}`);
  console.log(`  秘密鍵(このマシンの外に出さない): ${keyPath}`);
  console.log(`  公開鍵は signing.js に焼き込み済み。バックアップを取ってください —— この鍵を失うと`);
  console.log(`  既に配った butler が受け取れる包みを二度と作れません(新しい鍵は既存の装機端が知らない)。`);
}

// 公開鍵をソースへ。手で貼らせない = 貼り間違いで「誰の包みも通らない」事故を起こさない。
function embedPublicKey(keyId, pubPem) {
  const src = fs.readFileSync(SIGNING_JS, 'utf8');
  if (src.includes(`'${keyId}':`) || src.includes(`"${keyId}":`)) {
    die(`signing.js に既に鍵 ${keyId} があります。別の --id を使ってください`);
  }
  const entry = `  '${keyId}': \`${pubPem.trim()}\n\`,`;
  let out;
  if (src.includes(PLACEHOLDER)) out = src.replace(PLACEHOLDER, `${entry}\n${PLACEHOLDER}`);
  else die('signing.js に鍵の差し込み位置(<KEYS_PLACEHOLDER>)が見つかりません');
  fs.writeFileSync(SIGNING_JS, out);
}

function sign(argv) {
  const input = argv[1];
  if (!input) die('署名する payload の json を指定してください');
  const keyId = argOf(argv, '--id', 'brk1');
  const outPath = argOf(argv, '-o', input.replace(/\.json$/, '') + '.pkg.json');

  const keyPath = privateKeyPath(keyId);
  if (!fs.existsSync(keyPath)) die(`秘密鍵がありません: ${keyPath}  (先に keygen)`);

  if (!fs.existsSync(input)) die(`payload がありません: ${input}`);
  const raw = fs.readFileSync(input, 'utf8');
  try { JSON.parse(raw); } catch (_) { die(`payload が JSON として読めません: ${input}`); }

  // 署名対象は【ファイルのバイト列そのもの】。読み直して整形し直すと、その時点で
  // 「署名した物」と「配る物」が別になる。ここは絶対に加工しない。
  const payload = Buffer.from(raw, 'utf8');
  const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath));
  const sigB64 = crypto.sign(null, payload, privateKey).toString('base64');

  const envelope = {
    kind: 'butler.package.v1',
    alg: 'ed25519',
    key_id: keyId,
    payload_b64: payload.toString('base64'),
    sig_b64: sigB64,
  };
  fs.writeFileSync(outPath, JSON.stringify(envelope, null, 2) + '\n');

  const r = require(SIGNING_JS).openPackage(fs.readFileSync(outPath, 'utf8'));
  if (!r.ok) die(`作った包みが自分の検証器を通りません(${r.code}): ${r.message}`);

  console.log(`✓ 署名しました  ${outPath}`);
  console.log(`  鍵 ${keyId} / ${payload.length} バイト / 自己検証 通過`);
}

function verify(argv) {
  const input = argv[1];
  if (!input) die('検証する包みを指定してください');
  if (!fs.existsSync(input)) die(`包みがありません: ${input}`);
  const r = require(SIGNING_JS).openPackage(fs.readFileSync(input, 'utf8'));
  if (!r.ok) die(`検証 不合格 (${r.code}): ${r.message}`);
  console.log(`✓ 検証 合格  鍵=${r.keyId}  type=${r.payload && r.payload.type}  id=${r.payload && r.payload.id}`);
}

const argv = process.argv.slice(2);
const cmd = argv[0];
if (cmd === 'keygen') keygen(argv);
else if (cmd === 'sign') sign(argv);
else if (cmd === 'verify') verify(argv);
else {
  console.log('使い方:');
  console.log('  node scripts/sign-package.js keygen [--id brk1]');
  console.log('  node scripts/sign-package.js sign <payload.json> [-o out.pkg.json] [--id brk1]');
  console.log('  node scripts/sign-package.js verify <pkg.json>');
  process.exit(cmd ? 1 : 0);
}
