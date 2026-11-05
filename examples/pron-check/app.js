// pron-check — 口语练习: 朗读评分 / 自由回答 / 雅思 Part 2。录音和评分都由宿主做(record · pron 原语),
// 这里只管界面、把逐词结果对回原文、评完把结果作为一条消息交给打开它的人格(report → message 原语)。
var P = 'pron-check.';
var LANGS = [['en-GB', '英语(英)'], ['en-US', '英语(美)'], ['ja-JP', '日语'], ['zh-CN', '中文'], ['ko-KR', '韩语'], ['fr-FR', '法语'], ['de-DE', '德语'], ['es-ES', '西班牙语']];
var REGION_NAMES = { japaneast: '日本东', japanwest: '日本西', eastasia: '东亚(香港)', southeastasia: '东南亚(新加坡)', koreacentral: '韩国中部', centralindia: '印度中部', australiaeast: '澳大利亚东', eastus: '美国东部', eastus2: '美国东部2', westus: '美国西部', westus2: '美国西部2', westus3: '美国西部3', centralus: '美国中部', northcentralus: '美国中北', southcentralus: '美国中南', westcentralus: '美国中西', canadacentral: '加拿大中部', brazilsouth: '巴西南部', northeurope: '北欧(爱尔兰)', westeurope: '西欧(荷兰)', uksouth: '英国南部', francecentral: '法国中部', germanywestcentral: '德国中西', switzerlandnorth: '瑞士北部', swedencentral: '瑞典中部', norwayeast: '挪威东部', italynorth: '意大利北部', uaenorth: '阿联酋北部', qatarcentral: '卡塔尔中部', southafricanorth: '南非北部' };
var MODE_NAMES = { read: '朗读', free: '自由回答', part2: 'Part 2' };
var FILLERS = { um: 1, uh: 1, er: 1, erm: 1, ah: 1, hmm: 1, mm: 1, 'えー': 1, 'えーと': 1, 'えっと': 1, 'あの': 1, 'あのー': 1, 'うーん': 1 };
var PREP_SEC = 60, ANSWER_SEC = 120;

function $(i) { return document.getElementById(i); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
function call(name, args) { return butlerUI.call(P + name, args || {}); }
function say(s) { $('note').textContent = s; }

var mode = 'read', keySet = false, recId = '', recPath = '', recSec = 0;
var attempts = {};          // 同一题的每次结果: key = 模式 + 题目/原文
var timer = null;           // Part 2 计时
var p2 = null;              // Part 2 阶段: null | 'prep' | 'answer'

/* ── 注音: 青空文库写法 ｜漢字《かな》, 《》前的连续汉字自动当被注的字 ──
   → { plain: 去掉注音的纯文字(交给评分), units: [{t: 字或被注的那串, rt?, s: 起点, e: 终点}] } */
var KANJI = /[㐀-鿿豈-﫿々〆ヵヶ]/;
function parseRuby(src) {
  var units = [], plain = '', i = 0, s = String(src || '');
  while (i < s.length) {
    var c = s[i];
    if (c === '｜') {
      var open = s.indexOf('《', i + 1), close = open < 0 ? -1 : s.indexOf('》', open);
      if (open > i + 1 && close > open) {
        var base = s.slice(i + 1, open);
        units.push({ t: base, rt: s.slice(open + 1, close), s: plain.length, e: plain.length + base.length });
        plain += base; i = close + 1; continue;
      }
      i++; continue;
    }
    if (c === '《') {
      var cl = s.indexOf('》', i);
      if (cl > i) {
        // 往回收连续的汉字, 合成一个被注的单位
        var k = units.length;
        while (k > 0 && !units[k - 1].rt && units[k - 1].t.length === 1 && KANJI.test(units[k - 1].t)) k--;
        if (k < units.length) {
          var b = units.splice(k).map(function (u) { return u.t; }).join('');
          units.push({ t: b, rt: s.slice(i + 1, cl), s: plain.length - b.length, e: plain.length });
        }
        i = cl + 1; continue;
      }
    }
    units.push({ t: c, s: plain.length, e: plain.length + 1 });
    plain += c; i++;
  }
  return { plain: plain, units: units };
}
function rubyHtml(units) {
  return units.map(function (u) { return u.rt ? '<ruby>' + esc(u.t) + '<rt>' + esc(u.rt) + '</rt></ruby>' : esc(u.t); }).join('');
}
// 一段原文里 [s,e) 的读音: 注了音的用注音, 没注的原样
function readingOf(units, s, e) {
  var out = '', any = false;
  units.forEach(function (u) { if (u.e > s && u.s < e) { out += u.rt || u.t; if (u.rt) any = true; } });
  return any ? out : '';
}

/* ── 把评分回来的词对回原文 ──
   按顺序在原文里找每个词(英文认词边界、忽略大小写; 日文直接找字), 找到的那段记上这个词;
   原文里该读却没被任何词覆盖的字母/汉字/假名 = 漏读。多读的词原文里没有, 单独列。 */
var WORDCH = /[A-Za-z0-9À-ɏ぀-ヿ㐀-鿿豈-﫿々〆ヵヶー']/;
function align(plain, words, lang) {
  var lower = plain.toLowerCase(), owner = new Array(plain.length), cur = 0, extra = [];
  var latin = !/^(ja|zh|ko)/.test(lang);
  words.forEach(function (w, wi) {
    if (w.error === 'Insertion' || w.error === 'Omission') { if (w.error === 'Insertion') extra.push(w); return; }
    var needle = String(w.word || '').toLowerCase();
    if (!needle) return;
    var at = -1, from = cur;
    while (true) {
      at = lower.indexOf(needle, from);
      if (at < 0) break;
      if (!latin) break;
      var before = at > 0 ? lower[at - 1] : ' ', after = lower[at + needle.length] || ' ';
      if (!/[a-z0-9']/.test(before) && !/[a-z0-9']/.test(after)) break;
      from = at + 1;
    }
    // 跳得太远多半是认错了(别处有同一个词), 当它是多读
    if (at < 0 || (at - cur > Math.max(40, needle.length * 6))) { extra.push(w); return; }
    for (var k = at; k < at + needle.length; k++) owner[k] = wi;
    w._s = at; w._e = at + needle.length; cur = at + needle.length;
  });
  return { owner: owner, extra: extra };
}
function cls(w) {
  if (!w) return 'w omit';
  if (w.error === 'Insertion') return 'w ins';
  return 'w ' + (w.score >= 80 ? 'ok' : w.score >= 60 ? 'mid' : 'bad');
}
var ERR = { None: '', Mispronunciation: ' · 读错', Omission: ' · 漏读', Insertion: ' · 多读', UnexpectedBreak: ' · 不该停顿', MissingBreak: ' · 该停顿', Monotone: ' · 语调平' };
function tip(w) { return w ? w.word + ' ' + w.score + (ERR[w.error] == null ? ' · ' + w.error : ERR[w.error]) : '漏读'; }

/* ── 日语: 评分按语素切(あり / まし / た), 学员对不上原文 —— 把活用词尾并回前一个词, 显示整词 ──
   并起来的词: 分数取最低的那段, part = 最低那段(报告里说清问题在哪一截)。 */
var JA_TAIL = { 'た': 1, 'だ': 1, 'て': 1, 'で': 1, 'ば': 1, 'ます': 1, 'まし': 1, 'ませ': 1, 'ん': 1, 'う': 1, 'よう': 1,
  'ない': 1, 'なかっ': 1, 'なく': 1, 'たい': 1, 'たく': 1, 'たかっ': 1, 'れる': 1, 'れ': 1, 'られ': 1, 'られる': 1,
  'せ': 1, 'せる': 1, 'させ': 1, 'させる': 1, 'ず': 1, 'ぬ': 1, 'たら': 1, 'たり': 1, 'ちゃ': 1, 'じゃ': 1 };
function groupWords(words, lang) {
  var list = (words || []).filter(function (w) { return w.error !== 'Insertion' && w.error !== 'Omission'; });
  if (!/^ja/.test(lang)) return list.map(function (w) { return { word: w.word, score: w.score, error: w.error, _s: w._s, _e: w._e, parts: [w] }; });
  var out = [];
  list.forEach(function (w) {
    var g = out[out.length - 1];
    if (g && JA_TAIL[w.word]) { g.parts.push(w); g.word += w.word; if (w._e != null) g._e = w._e; }
    else out.push({ word: w.word, _s: w._s, _e: w._e, parts: [w] });
  });
  out.forEach(function (g) {
    var lo = g.parts.slice().sort(function (a, b) { return a.score - b.score; })[0];
    g.score = lo.score; g.error = lo.error; g.part = g.parts.length > 1 ? lo.word : '';
    g.devoiced = devoiceSuspect(g, lo);
  });
  return out;
}
/* し/す 夹在清辅音前或在句末(です・ました・します)时, 标准发音里元音会清化, 评分常把它判低。
   只标出来不改分: 分数是 Azure 的, 宽容体现在「最该改的」里排到后面、报告里注明。 */
var VOICELESS_NEXT = /^[かきくけこさしすせそたちつてとはひふへほぱぴぷぺぽっ]/;
function devoiceSuspect(g, lo) {
  var i = g.parts.indexOf(lo), next = g.parts[i + 1] ? g.parts[i + 1].word : '';
  var t = lo.word;
  for (var k = 0; k < t.length; k++) {
    if (t[k] !== 'し' && t[k] !== 'す') continue;
    var after = k + 1 < t.length ? t.slice(k + 1) : next;
    if (!after || VOICELESS_NEXT.test(after)) return true;
  }
  return false;
}
function groupNote(g) {
  return (g.part ? '问题在「' + g.part + '」' : '') + (g.devoiced ? (g.part ? ', ' : '') + 'し/す 可能是元音清化, 不一定读错' : '');
}

// 朗读模式: 原文(带注音)逐段上色。注音那一串当一个整体, 颜色跟它第一个字走
function paintRef(parsed, words, owner) {
  var html = '', group = null, buf = '';
  function flush() { if (group !== null) html += group.open + buf + '</span>'; else html += buf; buf = ''; }
  parsed.units.forEach(function (u) {
    var wi = owner[u.s], isWord = WORDCH.test(u.t);
    var key = wi != null ? 'w' + wi : (isWord ? 'omit' : null);
    var open = key == null ? null : (wi != null ? '<span class="' + cls(words[wi]) + '" title="' + esc(tip(words[wi])) + '">' : '<span class="w omit" title="漏读">');
    var gkey = group && group.key;
    if (key !== gkey) { flush(); group = key == null ? null : { key: key, open: open }; }
    buf += u.rt ? '<ruby>' + esc(u.t) + '<rt>' + esc(u.rt) + '</rt></ruby>' : esc(u.t);
  });
  flush();
  return html;
}

/* ── 界面 ── */
LANGS.forEach(function (l) { var o = document.createElement('option'); o.value = l[0]; o.textContent = l[1]; $('lang').appendChild(o); });
$('lang').value = 'en-GB';

function setMode(m) {
  mode = m; stopTimer(); p2 = null;
  [].forEach.call($('tabs').children, function (b) { b.classList.toggle('on', b.dataset.mode === m); });
  $('readrow').classList.toggle('hide', m !== 'read');
  $('qrow').classList.toggle('hide', m === 'read' || !$('qedit').value.trim());
  $('qedit').classList.toggle('hide', m === 'read' || !!$('qedit').value.trim());
  $('prep').classList.add('hide');
  $('talk').textContent = m === 'part2' ? '开始准备(1 分钟)' : '按住说话';
  say(m === 'read' ? '按住按钮朗读上面的文字, 松开自动评分'
    : m === 'free' ? '按住按钮回答, 松开自动评分(最长 2 分钟)'
    : '点开始: 先 1 分钟准备(可记笔记), 再 2 分钟作答, 到时间自动停');
  showQuestion();
}
[].forEach.call($('tabs').children, function (b) { b.onclick = function () { setMode(b.dataset.mode); }; });

function showQuestion() {
  var q = $('qedit').value.trim();
  $('qtext').textContent = q;
  $('qrow').classList.toggle('hide', mode === 'read' || !q);
}
function showRef() {
  var parsed = parseRuby($('text').value);
  $('ref').innerHTML = parsed.plain ? rubyHtml(parsed.units) : '<span class="muted">(还没有原文, 点「编辑原文」填)</span>';
}
$('edit').onclick = function () {
  var t = $('text'); t.classList.toggle('hide');
  $('edit').textContent = t.classList.contains('hide') ? '编辑原文' : '收起';
  if (!t.classList.contains('hide')) t.focus();
};
$('text').addEventListener('input', showRef);
$('qsay').onclick = function () { var q = $('qedit').value.trim(); if (q) call('say', { text: q.slice(0, 1900), lang: $('lang').value }); };
$('qtext').ondblclick = function () { $('qrow').classList.add('hide'); $('qedit').classList.remove('hide'); $('qedit').focus(); };
$('qedit').addEventListener('change', function () { if ($('qedit').value.trim()) { $('qedit').classList.add('hide'); showQuestion(); } });

/* ── key ── */
function fillRegions(regions, cur) {
  var r = $('region'); r.innerHTML = '';
  var a = document.createElement('option'); a.value = 'auto'; a.textContent = '自动识别区域'; r.appendChild(a);
  (regions || []).forEach(function (x) { var o = document.createElement('option'); o.value = x; o.textContent = (REGION_NAMES[x] || x) + ' · ' + x; r.appendChild(o); });
  r.value = cur || 'auto';
}
function showKey(on) { $('keybox').classList.toggle('hide', !on); }
function status() {
  return call('status').then(function (r) {
    if (!r || !r.ok) return;
    keySet = r.data.set; fillRegions(r.data.regions, r.data.region);
    $('keynote').textContent = keySet ? '已保存 · ' + (REGION_NAMES[r.data.region] || r.data.region) : '还没有 key';
    if (!keySet) showKey(true);
  });
}
$('gear').onclick = function () { showKey($('keybox').classList.contains('hide')); };
$('save').onclick = function () {
  var k = $('key').value.trim(); if (!k) { $('keynote').textContent = '先粘贴 key'; return; }
  $('keynote').textContent = $('region').value === 'auto' ? '正在识别区域…' : '正在验证…';
  call('key_set', { key: k, region: $('region').value }).then(function (r) {
    $('key').value = '';
    if (r && r.ok) { keySet = true; $('region').value = r.data.region; $('keynote').textContent = '已保存 · ' + (REGION_NAMES[r.data.region] || r.data.region); setTimeout(function () { showKey(false); }, 1200); }
    else $('keynote').textContent = '没保存: ' + ((r && r.message) || '未知');
  });
};
$('clear').onclick = function () { call('key_clear').then(function () { keySet = false; $('keynote').textContent = '已清除'; $('region').value = 'auto'; }); };

/* ── 录音: 朗读 / 自由回答按住说话; Part 2 点一下开始准备, 到点自动开录、到点自动停 ── */
var talk = $('talk'), held = false, starting = null, t0 = 0, tick = null;
function stopUi() { held = false; clearInterval(tick); talk.classList.remove('on'); talk.textContent = mode === 'part2' ? '开始准备(1 分钟)' : '按住说话'; }
function beginRec(label) {
  talk.classList.add('on'); talk.textContent = label; t0 = Date.now();
  tick = setInterval(function () { if (mode !== 'part2') say('录音中 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's'); }, 100);
  starting = call('start').then(function (r) { if (!r || !r.ok) { stopUi(); say('录不了: ' + ((r && r.message) || '未知')); } return r; });
}
function endRec() {
  stopUi(); var s = starting; starting = null;
  Promise.resolve(s).then(function (r) {
    if (!r || !r.ok) return;
    return call('stop').then(function (x) {
      if (x && x.ok && x.data.duration_sec < 0.8) { say('太短了, 按住按钮再说'); return; }
      if (!x || !x.ok) { say('没录上: ' + ((x && x.message) || '未知')); return; }
      recId = x.data.id; recPath = x.data.path; recSec = x.data.duration_sec;
      $('play').disabled = false; assess();
    });
  });
}
talk.addEventListener('pointerdown', function (e) {
  if (mode === 'part2') return;
  e.preventDefault(); if (held) return; held = true;
  try { talk.setPointerCapture(e.pointerId); } catch (_) {}
  beginRec('录音中… 松开结束');
});
function up() { if (mode === 'part2' || !held) return; endRec(); }
talk.addEventListener('pointerup', up); talk.addEventListener('pointercancel', up); talk.addEventListener('lostpointercapture', up);

function stopTimer() { clearInterval(timer); timer = null; $('clock').classList.remove('go'); }
function clock(sec) { $('clock').textContent = Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0'); }
talk.addEventListener('click', function () {
  if (mode !== 'part2') return;
  if (p2 === null) {                      // 开始准备
    p2 = 'prep'; $('prep').classList.remove('hide'); var left = PREP_SEC; clock(left);
    talk.textContent = '跳过准备, 现在开始答';
    say('准备时间, 可以在下面记笔记');
    timer = setInterval(function () { left--; clock(Math.max(0, left)); if (left <= 0) startAnswer(); }, 1000);
  } else if (p2 === 'prep') startAnswer();
  else if (p2 === 'answer') finishAnswer();
});
function startAnswer() {
  stopTimer(); p2 = 'answer'; var left = ANSWER_SEC; clock(left); $('clock').classList.add('go');
  beginRec('提前结束');
  say('作答中, 2 分钟到会自动停');
  timer = setInterval(function () { left--; clock(Math.max(0, left)); if (left <= 0) finishAnswer(); }, 1000);
}
function finishAnswer() { stopTimer(); p2 = null; endRec(); }

$('play').onclick = function () { if (recId) call('play', { id: recId }); };
$('again').onclick = assess;

/* ── 评分 + 显示 + 回传 ── */
function histKey() { return mode + '|' + (mode === 'read' ? parseRuby($('text').value).plain : $('qedit').value.trim()); }
function assess() {
  if (!recId) return;
  if (!keySet) { showKey(true); say('先在上面填 Azure key'); return; }
  var parsed = parseRuby($('text').value);
  if (mode === 'read' && !parsed.plain.trim()) { say('朗读模式要先有原文'); return; }
  say('评分中…'); $('again').disabled = true;
  var lang = $('lang').value;
  call('assess', { id: recId, text: mode === 'read' ? parsed.plain : '', lang: lang }).then(function (r) {
    $('again').disabled = false;
    if (!r || !r.ok) { say('评分失败: ' + ((r && r.message) || '未知')); return; }
    var d = r.data, k = histKey();
    var list = attempts[k] || (attempts[k] = []);
    var prev = list[list.length - 1];
    list.push(d);
    show(d, parsed, lang, prev);
    say(d.words && d.words.length ? '评完了, 结果已发给老师' : '没听到能对上的内容, 再说一次?');
    if (d.words && d.words.length) report(d, parsed, lang, list.length, prev);
  });
}

function worstOf(d, lang) {
  // 疑似清化的排到后面: 真读错的先给学员看
  return groupWords(d.words, lang).filter(function (w) { return !FILLERS[String(w.word).toLowerCase()]; })
    .sort(function (a, b) { return (a.devoiced - b.devoiced) || (a.score - b.score); }).filter(function (w) { return w.score < 90; }).slice(0, 3);
}
function shortPart2(d) { return mode === 'part2' && d.duration_sec != null && d.duration_sec < 60; }
function show(d, parsed, lang, prev) {
  var h = '';
  var al = mode === 'read' ? align(parsed.plain, d.words || [], lang) : null;
  var worst = worstOf(d, lang);
  if (worst.length) {
    h += '<div class="worst"><b>最该改的：</b>' + worst.map(function (w, i) {
      var rd = al && w._s != null ? readingOf(parsed.units, w._s, w._e) : '';
      return '<button class="chip" data-i="' + i + '"' + (groupNote(w) ? ' title="' + esc(groupNote(w)) + '"' : '') + '>🔊 ' + esc(w.word) + (rd ? '（' + esc(rd) + '）' : '') + '<i>' + w.score + (w.devoiced ? '?' : '') + '</i></button>';
    }).join('') + '</div>';
  }
  var t = [['总分', d.score], ['准确', d.accuracy], ['流利', d.fluency]];
  if (mode === 'read') t.push(['完整', d.completeness]);
  if (d.prosody != null) t.push(['韵律', d.prosody]);
  h += '<div class="scores">' + t.map(function (x) { return '<div class="tile"><b>' + (x[1] == null ? '-' : x[1]) + '</b><span>' + x[0] + '</span></div>'; }).join('') + '</div>';
  if (shortPart2(d)) h += '<div class="warn">⚠ 时长不足: 只说了 ' + d.duration_sec + ' 秒, Part 2 要说满 1–2 分钟, 真考会影响流利度评分</div>';
  h += '<div class="stats">时长 ' + d.duration_sec + ' 秒 · 语速 ' + d.wpm + ' 词/分 · 长停顿(>2 秒) ' + d.long_pauses + ' 次 · 填充词 ' + d.fillers + ' 次</div>';
  if (al) {
    h += '<div class="words">' + paintRef(parsed, d.words, al.owner) + '</div>';
    if (al.extra.length) h += '<div class="words">多读: ' + al.extra.map(function (w) { return '<span class="w ins" title="' + esc(tip(w)) + '">[' + esc(w.word) + ']</span>'; }).join(' ') + '</div>';
    h += '<div class="legend">绿 ≥80 · 黄 60–79 · 红 &lt;60 · 划线 = 漏读 · [方括号] = 多读 · 鼠标停在词上看分数</div>';
  } else {
    h += '<div class="words">' + (d.words || []).map(function (w) { return '<span class="' + cls(w) + '" title="' + esc(tip(w)) + '">' + esc(w.word) + '</span>'; }).join(' ') + '</div>';
    h += '<div class="legend">绿 ≥80 · 黄 60–79 · 红 &lt;60 · 鼠标停在词上看分数</div>';
  }
  if (d.heard) h += '<div class="heard">听到的：' + esc(d.heard) + '</div>';
  if (prev) {
    var rows = [['总分', 'score'], ['准确', 'accuracy'], ['流利', 'fluency'], ['韵律', 'prosody'], ['语速', 'wpm'], ['长停顿', 'long_pauses'], ['填充词', 'fillers']];
    var lowerBetter = { long_pauses: 1, fillers: 1 };
    h += '<table class="cmp"><tr><th></th><th>上一次</th><th>这一次</th><th>变化</th></tr>' + rows.filter(function (r) { return d[r[1]] != null && prev[r[1]] != null; }).map(function (r) {
      var a = prev[r[1]], b = d[r[1]], diff = b - a, good = lowerBetter[r[1]] ? diff < 0 : diff > 0;
      return '<tr><td>' + r[0] + '</td><td>' + a + '</td><td>' + b + '</td><td class="' + (diff === 0 || r[1] === 'wpm' ? '' : good ? 'up' : 'down') + '">' + (diff > 0 ? '+' : '') + diff + '</td></tr>';
    }).join('') + '</table>';
  }
  $('result').innerHTML = h;
  [].forEach.call($('result').querySelectorAll('.chip'), function (b) {
    b.onclick = function () { var w = worst[+b.dataset.i]; if (w) call('say', { text: w.word, lang: lang }); };
  });
}

// 交给老师的那条消息: 纯文字(message 原语不收尖括号), 一行一项
function report(d, parsed, lang, nth, prev) {
  var al = mode === 'read' ? align(parsed.plain, d.words || [], lang) : null;
  var low = groupWords(d.words, lang).filter(function (w) { return w.score < 60; }).map(function (w) {
    var rd = al && w._s != null ? readingOf(parsed.units, w._s, w._e) : '';
    var note = groupNote(w);
    return w.word + (rd ? '(' + rd + ')' : '') + ' ' + w.score + (w.error && w.error !== 'None' ? ' ' + (ERR[w.error] || w.error).replace(' · ', '') : '') + (note ? ' [' + note + ']' : '');
  });
  var omitted = al ? parsed.plain.split('').filter(function (c, i) { return al.owner[i] == null && WORDCH.test(c); }).length : 0;
  var L = ['[pron-check.report]', '模式: ' + MODE_NAMES[mode], '语言: ' + lang];
  var q = $('qedit').value.trim(); if (mode !== 'read' && q) L.push('题目: ' + q);
  if (mode === 'read') L.push('原文: ' + parsed.plain);
  L.push('听到的: ' + (d.heard || '(没听到)'));
  L.push('分数: 总分 ' + d.score + ' · 准确 ' + d.accuracy + ' · 流利 ' + d.fluency + (mode === 'read' ? ' · 完整 ' + d.completeness : '') + (d.prosody != null ? ' · 韵律 ' + d.prosody : ''));
  L.push('低于 60 分的词: ' + (low.length ? low.join('; ') : '无'));
  if (al && (al.extra.length || omitted)) L.push('漏读字数: ' + omitted + (al.extra.length ? ' · 多读: ' + al.extra.map(function (w) { return w.word; }).join(' ') : ''));
  if (shortPart2(d)) L.push('⚠ 时长不足: Part 2 只说了 ' + d.duration_sec + ' 秒(不足 1 分钟), 真考会影响流利度评分');
  L.push('时长: ' + d.duration_sec + ' 秒 · 语速: ' + d.wpm + ' 词/分 · 长停顿(>2 秒): ' + d.long_pauses + ' 次 · 填充词: ' + d.fillers + ' 次');
  L.push('第 ' + nth + ' 次作答' + (prev ? ' · 上一次总分 ' + prev.score : ''));
  L.push('录音: ' + recPath);
  var text = L.join('\n').replace(/[<>]/g, '');
  if (text.length > 3900) text = text.slice(0, 3900) + '…';
  call('report', { text: text });
}

butlerUI.onInit(function (d) {
  var a = (d && d.args) || {};
  if (a.lang && LANGS.some(function (l) { return l[0] === a.lang; })) $('lang').value = a.lang;
  if (a.text) { $('text').value = a.text; }
  if (a.question) $('qedit').value = a.question;
  showRef();
  setMode(String(a.part) === '2' ? 'part2' : a.text ? 'read' : a.question ? 'free' : 'read');
  status();
  call('warm').then(function (r) { if (!r || !r.ok) say('麦克风打不开: ' + ((r && r.message) || '未知')); });
});
