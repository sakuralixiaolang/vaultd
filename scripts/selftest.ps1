# 全链路自测：不需要真实云盘。
# 用本地 WebDAV 冒充云端，跑一遍「加密上传 → 列表 → 90% 位置 Range 解密」，并校验字节内容。
#
# 用法：  .\scripts\selftest.ps1
#         .\scripts\selftest.ps1 -Keep      # 保留临时目录便于排查

param(
    [string]$Rclone = "",
    [switch]$Keep
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Exe = Join-Path $ProjectRoot 'bin\vaultd.exe'
if (-not (Test-Path $Exe)) { throw "先构建：go build -o bin\vaultd.exe .\cmd\vaultd" }

if (-not $Rclone) {
    $cmd = Get-Command rclone -ErrorAction SilentlyContinue
    if ($cmd) { $Rclone = $cmd.Source }
    else {
        $cand = Get-ChildItem "$env:LOCALAPPDATA\devtools" -Recurse -Filter rclone.exe -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($cand) { $Rclone = $cand.FullName }
    }
}
if (-not $Rclone -or -not (Test-Path $Rclone)) { throw "找不到 rclone.exe，请用 -Rclone 指定路径" }

function Get-FreePort {
    $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $l.Start(); $p = $l.LocalEndpoint.Port; $l.Stop(); $p
}

$DavPort = Get-FreePort
$AppPort = Get-FreePort
$Root = Join-Path $env:TEMP ("vaultd-selftest-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$Cloud = Join-Path $Root 'cloud'
$HomeDir = Join-Path $Root 'home'
$UrlFile = Join-Path $Root 'url.txt'
$LogFile = Join-Path $Root 'vaultd.log'
$BigFile = Join-Path $Root 'sample200.bin'
New-Item -ItemType Directory -Force -Path $Cloud, $HomeDir | Out-Null

$results = @()
function Check($name, $ok, $detail) {
    $script:results += [pscustomobject]@{ 项目 = $name; 结果 = $(if ($ok) { 'PASS' } else { 'FAIL' }); 说明 = $detail }
    Write-Host ("[{0}] {1} {2}" -f $(if ($ok) { 'PASS' } else { 'FAIL' }), $name, $detail)
}

$davProc = $null; $appProc = $null
try {
    # 1) 冒充云端：本地 WebDAV
    $davProc = Start-Process -FilePath $Rclone -WindowStyle Hidden -PassThru -ArgumentList @(
        'serve', 'webdav', $Cloud, '--addr', "127.0.0.1:$DavPort", '--user', 'test', '--pass', 'testpass', '--log-level', 'ERROR'
    )
    Start-Sleep -Seconds 2

    # 2) 起一份干净的 vaultd（独立配置目录 = 模拟“干净机器第一次运行”）
    $appProc = Start-Process -FilePath $Exe -WindowStyle Hidden -PassThru -Environment @{ VAULTD_HOME = $HomeDir } -RedirectStandardError $LogFile -ArgumentList @(
        '-listen', "127.0.0.1:$AppPort", '-open=false', '-writeurl', $UrlFile
    )
    $deadline = (Get-Date).AddSeconds(20)
    while (-not (Test-Path $UrlFile) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }
    if (-not (Test-Path $UrlFile)) { throw "vaultd 未在 20s 内启动，日志：`n$(Get-Content $LogFile -Raw)" }

    $url = (Get-Content $UrlFile -Raw).Trim()
    $base = ($url -split '\?')[0].TrimEnd('/')
    $token = ($url -split 't=')[1]
    $api = "$base/api"

    # 3) 首次运行是否自动生成了密钥
    $cfgPath = Join-Path $HomeDir 'config.json'
    $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
    Check '首次运行自动生成主密钥' ($cfg.master_key.Length -eq 64 -and $cfg.salt.Length -eq 64) "key=$($cfg.master_key.Substring(0,8))…"

    # 4) 接入（账号密码方式）
    $body = @{ url = "http://127.0.0.1:$DavPort"; user = 'test'; pass = 'testpass'; remote_path = 'vault'; chunk_size = '500Mi' } | ConvertTo-Json
    $setup = Invoke-RestMethod -Uri "$api/setup?t=$token" -Method Post -Body $body -ContentType 'application/json'
    Check 'WebDAV 接入成功' ($setup.ok -eq $true) ''

    # 5) 造 200MB 样本并流式上传
    if (-not (Test-Path $BigFile)) { & fsutil file createnew $BigFile 209715200 | Out-Null }
    $size = (Get-Item $BigFile).Length
    $up = & curl.exe -s -o NUL -w "%{http_code}" -X PUT --data-binary "@$BigFile" "$api/upload?path=sample200.bin&t=$token"
    Check '流式加密上传（200MB）' ($up -eq '200') "HTTP $up"

    # 6) 列表：应看到解密后的名字与真实大小
    $list = Invoke-RestMethod -Uri "$api/list?path=&t=$token"
    $entry = $list.entries | Where-Object { $_.name -eq 'sample200.bin' }
    Check '列表返回解密名与原始大小' ($entry -and $entry.size -eq $size) "size=$($entry.size)"

    # 7) 云端侧：只有乱码名、无扩展名
    $rawNames = (Get-ChildItem -LiteralPath (Join-Path $Cloud 'vault') -Force | Select-Object -ExpandProperty Name)
    $gibberish = ($rawNames | Where-Object { $_ -match '^[a-z0-9]{20,}$' }).Count
    Check '云端只落地乱码文件名' ($gibberish -eq $rawNames.Count) ($rawNames -join ',')

    # 8) 密文头部应是 rclone 魔数而不是视频头
    $cipher = (Get-ChildItem -LiteralPath (Join-Path $Cloud 'vault') -Force | Select-Object -First 1)
    $head = [System.IO.File]::ReadAllBytes($cipher.FullName)[0..7]
    $magic = [Text.Encoding]::ASCII.GetString($head[0..5])
    Check '密文头为 RCLONE 魔数（不可预览）' ($magic -eq 'RCLONE') "head=$magic"

    # 9) 90% 位置 Range：断言 206 + Content-Range + 只回一小段
    $start = [int64]([math]::Floor($size * 0.9))
    $want = 1048064
    $end = $start + $want - 1
    $rngFile = Join-Path $Root 'range.bin'
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $hdr = & curl.exe -s -D - -o $rngFile -H "Range: bytes=$start-$end" "$api/stream?path=/sample200.bin&t=$token"
    $sw.Stop()
    $status = ($hdr | Select-String -Pattern '^HTTP/\d\.\d (\d{3})').Matches[0].Groups[1].Value
    $cr = ($hdr | Select-String -Pattern '^Content-Range: (.*)').Matches[0].Groups[1].Value.Trim()
    $got = (Get-Item $rngFile).Length
    Check '90% 位置返回 206' ($status -eq '206') "HTTP $status"
    Check 'Content-Range 正确' ($cr -eq "bytes $start-$end/$size") $cr
    Check '只回请求的那一小段' ($got -eq $want) "$got bytes / 全文件 $size bytes，耗时 $($sw.ElapsedMilliseconds)ms"

    # 10) 字节级正确性：解密出来的切片必须与原文一致
    $sliceFile = Join-Path $Root 'slice.bin'
    $fs = [System.IO.File]::OpenRead($BigFile)
    $fs.Position = $start
    $buf = New-Object byte[] $want
    $read = 0
    while ($read -lt $want) { $n = $fs.Read($buf, $read, $want - $read); if ($n -le 0) { break }; $read += $n }
    $fs.Close()
    [System.IO.File]::WriteAllBytes($sliceFile, $buf)
    $h1 = (Get-FileHash $sliceFile).Hash
    $h2 = (Get-FileHash $rngFile).Hash
    Check '解密切片与原文一致（SHA256）' ($h1 -eq $h2) "$($h1.Substring(0,16))…"

    # 11) 重启后密钥不变（同一配置目录再起一次，换端口避免 TIME_WAIT）
    Stop-Process -Id $appProc.Id -Force; Start-Sleep -Milliseconds 800
    $AppPort2 = Get-FreePort
    $UrlFile2 = Join-Path $Root 'url2.txt'
    $app2 = Start-Process -FilePath $Exe -WindowStyle Hidden -PassThru -Environment @{ VAULTD_HOME = $HomeDir } `
        -RedirectStandardError (Join-Path $Root 'vaultd2.log') -ArgumentList @('-listen', "127.0.0.1:$AppPort2", '-open=false', '-writeurl', $UrlFile2)
    $deadline = (Get-Date).AddSeconds(20)
    while (-not (Test-Path $UrlFile2) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }
    $url2 = (Get-Content $UrlFile2 -Raw).Trim()
    $base2 = ($url2 -split '\?')[0].TrimEnd('/')
    $tok2 = ($url2 -split 't=')[1]
    $status2 = Invoke-RestMethod -Uri "$base2/api/status?t=$tok2"
    Check '重启后密钥指纹不变' ($status2.key_fingerprint -eq $cfg.master_key.Substring(0, 8).ToUpper()) "fp=$($status2.key_fingerprint)"
    Check '重启后密文库仍可用' ($status2.vault_ready -eq $true) "vault_ready=$($status2.vault_ready)"
    Stop-Process -Id $app2.Id -Force
}
finally {
    if ($appProc -and -not $appProc.HasExited) { Stop-Process -Id $appProc.Id -Force -ErrorAction SilentlyContinue }
    if ($davProc -and -not $davProc.HasExited) { Stop-Process -Id $davProc.Id -Force -ErrorAction SilentlyContinue }
}

Write-Host ''
$results | Format-Table -AutoSize | Out-String | Write-Host
$failed = ($results | Where-Object { $_.结果 -eq 'FAIL' }).Count
if ($Keep -or $failed -gt 0) {
    Write-Host "临时目录保留：$Root"
    if ($failed -gt 0) { Write-Host "日志：$LogFile" ; exit 1 }
} else {
    Remove-Item -Recurse -Force $Root -ErrorAction SilentlyContinue
    Write-Host '全部通过，临时目录已清理。'
}

