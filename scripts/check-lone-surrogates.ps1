# 检查 butler 人格记忆里有没有「半个 emoji」(孤立代理项)。只读, 不改任何文件。
# 这种坏字符会让 DeepSeek 报 400「unexpected end of hex escape」、智谱报 500「surrogates not allowed」。
#
# 用法(app 开着也能跑):
#   powershell -ExecutionPolicy Bypass -File check-lone-surrogates.ps1
#   powershell -ExecutionPolicy Bypass -File check-lone-surrogates.ps1 -DataDir E:\butler-data
# 结果打印在屏幕上, 同时存到桌面 butler-surrogate-report.txt, 把这个文件发回来即可。

param([string]$DataDir = '')

$ErrorActionPreference = 'Continue'
$latin1 = [System.Text.Encoding]::GetEncoding(28591)
$utf8 = New-Object System.Text.UTF8Encoding($false)
$out = New-Object System.Collections.Generic.List[string]
function Say([string]$s) { Write-Host $s; $out.Add($s) }

# ── 1. 找数据目录: 参数 > %APPDATA%\butler\data-location.json > %APPDATA%\butler
if (-not $DataDir) {
  $boot = if ($env:APPDATA) { Join-Path $env:APPDATA 'butler' } else { '' }
  $ptr = if ($boot) { Join-Path $boot 'data-location.json' } else { '' }
  if ($ptr -and (Test-Path -LiteralPath $ptr)) {
    try { $DataDir = (Get-Content -LiteralPath $ptr -Raw -Encoding UTF8 | ConvertFrom-Json).dataDir } catch {}
  }
  if (-not $DataDir) { $DataDir = $boot }
}
Say "数据目录: $DataDir"
if (-not $DataDir -or -not (Test-Path -LiteralPath $DataDir)) { Say '找不到数据目录, 请用 -DataDir 指定'; exit 1 }

# ── 2. 列出各人格的记忆目录: 登记簿 app\personas.json 里的 homeDir, 再补 personas\* 下的
$dirs = [ordered]@{}
$reg = Join-Path $DataDir 'app\personas.json'
if (Test-Path -LiteralPath $reg) {
  try {
    foreach ($p in (Get-Content -LiteralPath $reg -Raw -Encoding UTF8 | ConvertFrom-Json).personas) {
      if ($p.homeDir) { $dirs[(Join-Path $p.homeDir '.claude\memory')] = "$($p.name)" }
    }
  } catch { Say "读登记簿失败: $_" }
}
$pd = Join-Path $DataDir 'personas'
if (Test-Path -LiteralPath $pd) {
  foreach ($d in Get-ChildItem -LiteralPath $pd -Directory) {
    $m = Join-Path $d.FullName '.claude\memory'
    if (-not $dirs.Contains($m)) { $dirs[$m] = $d.Name }
  }
}

# 读文件, app 正在写也能读
function ReadBytes([string]$f) {
  $fs = [System.IO.File]::Open($f, 'Open', 'Read', 'ReadWrite,Delete')
  try { $buf = New-Object byte[] $fs.Length; [void]$fs.Read($buf, 0, $buf.Length); return ,$buf } finally { $fs.Close() }
}

# 坏字符旁边是不是正常文字: 是就算文字里的坏字符; 不是, 就是向量等二进制数据碰巧撞上同样字节。
# 截断最常见的是坏字符正好在一段文字末尾、后面紧跟库的记录头, 所以只看截口那一侧
function Clean([string]$t) {
  $t = $t.Trim([char]0xFFFD)     # 切口落在多字节字符中间会多出一个替换符, 不算
  # 只认常见文字: ASCII · 拉丁补充 · 标点符号 · 中日韩 · 全角; 向量字节解出来总会夹进别的
  $t.Length -ge 8 -and $t -match '[A-Za-z]{3}|[\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]{2}' -and $t -match '^[\x20-\x7E\t\r\n\u00A0-\u00FF\u2000-\u27BF\u3000-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF\uFF00-\uFFEF]+$'
}
function Around([byte[]]$b, [int]$at) {
  $s = [Math]::Max(0, $at - 90); $e = [Math]::Min($b.Length, $at + 3 + 90)
  $txt = $utf8.GetString($b, $s, $e - $s) -replace '[\x00-\x08\x0B\x0C\x0E-\x1F]', ' ' -replace '\s+', ' '
  $l = [Math]::Max(0, $at - 30)
  $left = $utf8.GetString($b, $l, $at - $l)
  $right = $utf8.GetString($b, $at + 3, [Math]::Min(30, $b.Length - $at - 3))
  # 前半个字(高位 ED A0-AF)是文字被从后面截断留下的, 看它左边; 后半个字(低位 ED B0-BF)看右边
  # 向量表每行是「向量字节 + 模型名#哈希」, 向量末尾撞上低位时右边正好是模型名, 不算
  $ok = if ($b[$at + 1] -lt 0xB0) { Clean $left } else { (Clean $right) -and $right -notmatch '[\w.-]+/[\w.-]+(#|$)' }
  return @{ text = $txt.Trim(); isText = $ok }
}

$total = 0; $binary = 0
# 原始字节: 合法 UTF-8 里从不出现 ED A0..ED BF, 出现就是 UTF-16 代理项被直接编成了字节
$rxBytes = New-Object regex '\xED[\xA0-\xBF][\x80-\xBF]'
# JSON 文本: 转义写法 \udXXX 落单(高位后面没跟低位, 或低位前面没有高位)
# 前面的反斜杠要是偶数个(含 0 个)才是真转义; 奇数个说明是正文里写着「\\ud83d」这几个字, 不算
$rxEsc = New-Object regex '(?i)(?<=(?<!\\)(?:\\\\)*)(?:\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f][0-9a-f]{2})|(?<!\\ud[89ab][0-9a-f]{2})\\ud[c-f][0-9a-f]{2})'

foreach ($dir in $dirs.Keys) {
  if (-not (Test-Path -LiteralPath $dir)) { continue }
  Say ''
  Say "== 人格「$($dirs[$dir])」 $dir"
  $files = Get-ChildItem -LiteralPath $dir -Recurse -File -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '\.(db|db-wal|json|jsonl|md)$' -and $_.Length -gt 0 }
  $hit = 0
  foreach ($f in $files) {
    try { $b = ReadBytes $f.FullName } catch { Say "  读不了 $($f.Name): $_"; continue }
    $s = $latin1.GetString($b)
    $seen = @{}
    foreach ($m in $rxBytes.Matches($s)) {
      $a = Around $b $m.Index
      if (-not $a.isText) { $binary++; continue }
      if ($seen.ContainsKey($a.text)) { continue }; $seen[$a.text] = 1
      $total++; $hit++
      Say ("  [字节] {0} @{1}" -f $f.FullName.Substring($dir.Length).TrimStart('\', '/'), $m.Index)
      Say "         …$($a.text)…"
    }
    if ($f.Name -match '\.(json|jsonl)$') {
      foreach ($m in $rxEsc.Matches($s)) {
        $a = Around $b $m.Index
        if ($seen.ContainsKey($a.text)) { continue }; $seen[$a.text] = 1
        $total++; $hit++
        Say ("  [转义 {0}] {1} @{2}" -f $m.Value, $f.FullName.Substring($dir.Length).TrimStart('\', '/'), $m.Index)
        Say "         …$($a.text)…"
      }
    }
  }
  if (-not $hit) { Say '  干净' }
}

Say ''
Say ("合计: 文字里的半个 emoji $total 处" + $(if ($binary) { " (另有 $binary 处在二进制数据里, 是向量碰巧撞上同样字节, 不用管)" } else { '' }))
$desk = [Environment]::GetFolderPath('Desktop')
if (-not $desk) { $desk = $DataDir }
$rep = Join-Path $desk 'butler-surrogate-report.txt'
[System.IO.File]::WriteAllLines($rep, $out, (New-Object System.Text.UTF8Encoding($true)))
Say "报告已存: $rep"
