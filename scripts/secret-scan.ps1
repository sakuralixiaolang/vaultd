# 提交前自检：扫一遍「入库的东西」里有没有凭据或私人标识。
# 用法：pwsh -File .\scripts\secret-scan.ps1   （有命中会以退出码 1 结束）
$ErrorActionPreference = 'Stop'
$env:PATH = "C:\Program Files\Git\cmd;$env:PATH"

$patterns = @(
  @{ name = '私钥块';        re = '-----BEGIN [A-Z ]*PRIVATE KEY-----' },
  @{ name = '常见令牌前缀';  re = '(?<![A-Za-z])(ghp_|gho_|github_pat_|sk-|xox[baprs]-|AKIA[0-9A-Z]{16})' },
  @{ name = '长 base64';     re = '[A-Za-z0-9+/=]{120,}' },
  @{ name = '64 位 hex';     re = '\b[0-9a-fA-F]{64}\b' },
  @{ name = '手机号';        re = '\b1[3-9][0-9]{9}\b' },
  @{ name = '邮箱';          re = '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' },
  @{ name = '本机用户目录';  re = 'C:\\Users\\|/home/[a-z]' },
  @{ name = '云盘对象名';    re = '`[0-9a-z]{20,}`' },
  @{ name = '密钥指纹写法';  re = '指纹[^|]*?\b[0-9A-F]{8}\b|`[0-9A-F]{8}`' }
)

# 白名单：测试里刻意用的假密钥、示例占位
$allow = @(
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
  'A1B2C3D4',
  'testSalt',
  'testKey'
)

$files = git ls-files
$hits = 0
foreach ($p in $patterns) {
  $out = git grep -n -I -E $p.re -- $files 2>$null
  if (-not $out) { continue }
  foreach ($line in ($out -split "`n")) {
    if (-not $line.Trim()) { continue }
    $skip = $false
    foreach ($a in $allow) { if ($line.Contains($a)) { $skip = $true; break } }
    if ($skip) { continue }
    # go.sum / go.mod 里的依赖哈希、许可证文本不算
    if ($line -match '^go\.(sum|mod):') { continue }
    if ($line -match 'LICENSE') { continue }
    Write-Host ("[{0}] {1}" -f $p.name, $line) -ForegroundColor Yellow
    $hits++
  }
}
if ($hits -gt 0) {
  Write-Host "共 $hits 处可疑内容，确认后再提交。" -ForegroundColor Red
  exit 1
}
Write-Host "没有发现凭据或私人标识。" -ForegroundColor Green
