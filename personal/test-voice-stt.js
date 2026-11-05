// test-voice-stt.js — 语音引擎探测门禁。跑法: node test-voice-stt.js
//
// 2026-08-10 实机事故(作者 Windows): 他机器上叫 whisper-cli 的其实是 pip 版 openai-whisper。
// 两者 -f 含义正相反(cpp = 输入文件 / python = 输出格式), 于是探测一路绿灯, 到真转写才炸,
// 报错还是一屏 argparse usage —— 用户完全看不懂发生了什么。
// 旧代码在 isWhisperCpp 里靠**名字**判断(「whisper-cli / main 只有 cpp 版会叫」), 被实机证伪。
// 这条门禁盯的就是: 探测必须实跑认特征, 不许靠名字猜。

const fs = require('fs');
const os = require('os');
const path = require('path');
const stt = require('../core/voice-stt.js');

let pass = 0, fail = 0, skip = 0;
const ok = (cond, label) => {
  if (cond) { console.log(`  ✓ ${label}`); pass++; }
  else { console.log(`  ✗ ${label}`); fail++; }
};

console.log('\n[1] 认得出冒充的引擎(哪怕它就叫 whisper-cli)');
if (process.platform === 'win32') {
  console.log('  ⊘ 非 win32 才能用 shell 脚本假冒 CLI'); skip++;
} else {
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-fakecli-'));
  const writeFake = (name, help) => {
    const p = path.join(fakeDir, name);
    fs.writeFileSync(p, `#!/bin/sh\ncat <<'HELPEOF'\n${help}\nHELPEOF\n`);
    fs.chmodSync(p, 0o755);
    return p;
  };
  // 取自作者实机报错的真实输出
  const PY_HELP = 'usage: whisper [-h] [--model MODEL] [--model_dir MODEL_DIR]\n'
    + '               [--output_format {txt,vtt,srt,tsv,json,all}]\n'
    + '               [--clip_timestamps CLIP_TIMESTAMPS]\n               audio [audio ...]';
  const CPP_HELP = 'usage: ./main [options] file0.wav file1.wav ...\n'
    + '  -nt,       --no-timestamps     [false  ] do not print timestamps\n'
    + '  -otxt,     --output-txt        [false  ] output result in a text file';

  try {
    ok(stt.isWhisperCpp(writeFake('whisper-cli', PY_HELP)) === false,
      '名叫 whisper-cli 的 python 版被认出来 (旧代码在这里靠名字放行)');
    ok(stt.isWhisperCpp(writeFake('main', PY_HELP)) === false,
      '名叫 main 的 python 版也被认出来');
    ok(stt.isWhisperCpp(writeFake('whisper', PY_HELP)) === false,
      '名叫 whisper 的 python 版被认出来 (这条旧代码本来就过)');
    ok(stt.isWhisperCpp(writeFake('whisper-cli-cpp', CPP_HELP)) === true,
      '真 whisper.cpp 不被误杀');
  } finally {
    try { fs.rmSync(fakeDir, { recursive: true, force: true }); } catch (_) {}
  }
}

console.log('\n[2] 探测结果按路径缓存(每次录音都 spawn 一次 -h 的话, python 版要等 20s 超时)');
const t0 = Date.now();
const probe1 = stt.isWhisperCpp('/definitely/not/here/whisper-cli');
const t1 = Date.now();
const probe2 = stt.isWhisperCpp('/definitely/not/here/whisper-cli');
const t2 = Date.now();
ok(probe1 === probe2, '同一路径两次探测结论一致');
ok((t2 - t1) <= (t1 - t0), '第二次走缓存, 不再 spawn');

console.log('\n[3] 转写报错要带上实际用的是哪个 CLI(不然排障只能靠猜)');
const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'voice-stt.js'), 'utf8');
ok(!/`whisper-cli exit \$\{code\}/.test(src), '报错不再硬编码 whisper-cli 这个名字');
ok(/\$\{d\.cli\} exit \$\{code\}/.test(src), '报错带实际 cli 绝对路径');

// 2026-08-13: 语义模型(118MB)改成 app 首启后台自己装, 装不上会退避重试 ——
// 没有续传的话弱网用户就是"下到八成断线、重来又断在八成", 永远装不上还一直在烧流量。
console.log('\n[4] 下载断点续传(百兆级文件断一次不能从头来)');
(async () => {
  const http = require('http');
  const BODY = Buffer.alloc(200 * 1024, 7);
  let mode = 'cut';          // cut=中途掐线 / range=支持续传 / norange=服务端不认 Range
  let lastRange = null;
  const srv = http.createServer((req, res) => {
    lastRange = req.headers.range || null;
    const m = /bytes=(\d+)-/.exec(req.headers.range || '');
    const from = m ? Number(m[1]) : 0;
    if (mode === 'cut') {
      res.writeHead(200, { 'Content-Length': String(BODY.length) });
      res.write(BODY.subarray(0, 50 * 1024));
      setTimeout(() => res.destroy(), 20);
      return;
    }
    if (mode === 'range' && from) {
      res.writeHead(206, {
        'Content-Range': `bytes ${from}-${BODY.length - 1}/${BODY.length}`,
        'Content-Length': String(BODY.length - from),
      });
      res.end(BODY.subarray(from));
      return;
    }
    res.writeHead(200, { 'Content-Length': String(BODY.length) });
    res.end(BODY);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/model.bin`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-dl-'));
  const dest = path.join(dir, 'model.bin');

  let threw = false;
  try { await stt.download(url, dest, () => {}); } catch (_) { threw = true; }
  ok(threw, '连接被掐断要抛错');
  const partSize = fs.existsSync(dest + '.part') ? fs.statSync(dest + '.part').size : 0;
  ok(partSize > 0, '半成品要留着当续传起点(旧实现在这里把它删了)');
  ok(!fs.existsSync(dest), '没下完不许落正式名');

  mode = 'range';
  await stt.download(url, dest, () => {});
  ok(lastRange === `bytes=${partSize}-`, `第二次要带上断点位置(实际 ${lastRange})`);
  ok(fs.readFileSync(dest).equals(BODY), '续传拼出来的要和原件逐字节相同');
  ok(!fs.existsSync(dest + '.part'), '下完要清掉半成品');

  // 服务端不认 Range 就会拿 200 从头给。此时若还按追加写, 拼出来的是个大小不对
  // 却没人报错的坏文件 —— 要到加载模型时才炸, 报错完全看不出根因。
  mode = 'norange';
  fs.unlinkSync(dest);
  fs.writeFileSync(dest + '.part', Buffer.alloc(1024, 3));
  await stt.download(url, dest, () => {});
  ok(fs.readFileSync(dest).equals(BODY), '服务端不认续传时要丢掉半成品从头写, 不能拼');

  // 2026-09-23: 国内直连 huggingface.co / github.com 双双不通, 而失败是静默的(没模型
  // 就没向量, 检索退化成纯词面匹配却不报错)。所以下载必须自己换源, 不能指望用户去配代理
  // —— 真机实测代理配好了 curl 仍在 TLS 握手阶段报 schannel 失败。
  console.log('\n[5] 下载源换源兜底');
  ok(/hf-mirror\.com/.test(src), 'HF 有镜像兜底');
  ok(/gh-proxy\.com/.test(src), 'GitHub 有镜像兜底(引擎 zip 不在 HF 上, 只改 HF 等于语音仍是死的)');
  ok(stt.HF_BASES[0] === 'https://huggingface.co', '🔴 官方源必须排第一, 镜像只是兜底');

  const dead = 'http://127.0.0.1:1/';          // 必然连不上的源
  const dest2 = path.join(dir, 'fallback.bin');
  mode = 'norange';
  await stt.downloadFrom([dead, `http://127.0.0.1:${srv.address().port}`], '/model.bin', dest2, () => {});
  ok(fs.readFileSync(dest2).equals(BODY), '头一个源不通要自动换下一个, 且拿到的是完整文件');

  let allFailed = false;
  try {
    await stt.downloadFrom([dead, 'http://127.0.0.1:2/'], '/model.bin', path.join(dir, 'x.bin'), () => {});
  } catch (_) { allFailed = true; }
  ok(allFailed, '所有源都不通才抛错(不能静默返回一个空文件)');

  srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
})().then(() => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} test-voice-stt: ${pass} pass / ${fail} fail${skip ? ` / ${skip} skip` : ''}`);
  process.exit(fail === 0 ? 0 : 1);
}).catch((e) => {
  console.log('  ✗ [4] 这一段自己炸了 —', e && e.message);
  console.log(`\n❌ test-voice-stt: ${pass} pass / ${fail + 1} fail`);
  process.exit(1);
});
