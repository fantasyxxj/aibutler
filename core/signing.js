// signing.js — 下发物の署名検証。「これは我々が出した物で、途中で書き換わっていない」を**証明**する。
//
// なぜ token では足りないか: Bearer token が答えるのは「誰が繋いできたか」。
// 署名が答えるのは「中身が出荷時のままか」。運び屋(bus)が乗っ取られても、token が漏れても、
// 秘密鍵が手元にある限り相手は正しい包みを作れない —— そこが分かれ目。
//
// 🔴 公開鍵はソースに焼き込む。設定ファイルからも下発物からも読まない。
//    同じ経路で鍵まで差し替えられるなら、署名は何も証明しない。
'use strict';

const crypto = require('crypto');

// 署名アルゴリズムは ed25519 一択。包みの中の alg を見て切り替えては【いけない】——
// 攻撃者が alg を書き換えて検証を素通りさせる古典的な穴(JWT alg=none)がそこから開く。
const ALG = 'ed25519';

// 出荷鍵。key_id は鍵の入れ替え(鍵が漏れた時 / 定期交換)のためにある。
// 古い鍵をしばらく残せるので、入れ替えの日に古い包みが一斉に死ぬことはない。
const PUBLIC_KEYS = {
  'brk1': `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAxdW1Ywt352tS/NOU8Zj/FXZb1YrtRKO0yWh7wdBVtuc=
-----END PUBLIC KEY-----
`,
  // <KEYS_PLACEHOLDER>
};

const PACKAGE_KIND = 'butler.package.v1';

function knownKeyIds() {
  return Object.keys(PUBLIC_KEYS);
}

function publicKeyOf(keyId) {
  const pem = PUBLIC_KEYS[keyId];
  if (!pem) return null;
  return crypto.createPublicKey(pem);
}

/* 生バイト列に対する検証。包みの形式を知らない低層 —— 署名の対象は
   「JSON を解釈した結果」ではなく **バイト列そのもの**。
   直列化の揺れ(キー順・空白・Unicode 正規化)が署名を壊す余地を最初から作らない。 */
function verifyBytes(bytes, sigB64, keyId) {
  const key = publicKeyOf(keyId);
  if (!key) return false;
  let sig;
  try { sig = Buffer.from(String(sigB64 || ''), 'base64'); } catch (_) { return false; }
  if (sig.length !== 64) return false;   // ed25519 の署名は必ず 64 バイト
  try { return crypto.verify(null, bytes, key, sig); } catch (_) { return false; }
}

/* 包みを開ける。戻り値は必ず {ok, ...} —— 例外で落とさないのは、呼ぶ側に
   「検証に失敗した」と「壊れて読めない」を同じ一本の道で扱わせるため。
   どちらの場合も結果は同じ: **積まない**。 */
function openPackage(text) {
  let env;
  try { env = JSON.parse(String(text)); } catch (_) {
    return { ok: false, code: 'malformed', message: '包みが JSON として読めません' };
  }
  if (!env || typeof env !== 'object') {
    return { ok: false, code: 'malformed', message: '包みの形が違います' };
  }
  if (env.kind !== PACKAGE_KIND) {
    return { ok: false, code: 'unknown_kind', message: `未知の包み種別: ${env.kind}` };
  }
  // 包みが名乗る alg は「照合するだけ」。これを見て検証方法を選ぶことはしない。
  if (env.alg !== ALG) {
    return { ok: false, code: 'bad_alg', message: `署名方式が違います: ${env.alg}` };
  }
  if (!env.key_id || !PUBLIC_KEYS[env.key_id]) {
    return { ok: false, code: 'unknown_key', message: `未知の署名鍵: ${env.key_id}` };
  }
  if (!env.payload_b64 || !env.sig_b64) {
    return { ok: false, code: 'no_signature', message: '署名がありません' };
  }

  const payload = Buffer.from(env.payload_b64, 'base64');
  // base64 は壊れた入力を黙って途中まで解く。往復させて元と一致しなければ改竄/破損。
  if (payload.toString('base64') !== String(env.payload_b64).replace(/\s+/g, '')) {
    return { ok: false, code: 'malformed', message: '中身の符号化が壊れています' };
  }
  if (!verifyBytes(payload, env.sig_b64, env.key_id)) {
    return { ok: false, code: 'bad_signature', message: '署名が一致しません(我々が出した物ではないか、書き換えられています)' };
  }

  let data;
  try { data = JSON.parse(payload.toString('utf8')); } catch (_) {
    return { ok: false, code: 'malformed', message: '中身が JSON として読めません' };
  }
  return { ok: true, keyId: env.key_id, payload: data, bytes: payload };
}

module.exports = { ALG, PACKAGE_KIND, PUBLIC_KEYS, knownKeyIds, publicKeyOf, verifyBytes, openPackage };
