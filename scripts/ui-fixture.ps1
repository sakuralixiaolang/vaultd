$ErrorActionPreference = 'Stop'
# 本机没有外网的老模拟器也能验收 UI：用本机 rclone serve webdav 冒充云端，
# 设备通过 10.0.2.2 访问宿主机的 DAV 端口，加解密仍在设备进程内完成。
$sdk = "$env:LOCALAPPDATA\Android\Sdk"; $adb = "$sdk\platform-tools\adb.exe"
$repo = Split-Path -Parent $PSScriptRoot
$rclone = "$env:LOCALAPPDATA\devtools\rclone-v1.76.0-windows-amd64\rclone.exe"
$root = "$env:TEMP\vdg"
$davPort = 5299
$appPort = 5300
$user = 'dev'; $pass = 'devpass'

Get-Process rclone, vaultd -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500
Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path "$root\cloud", "$root\home", "$root\samples" | Out-Null

# 1) 云端替身
Start-Process -FilePath $rclone -WindowStyle Hidden -ArgumentList @(
  'serve', 'webdav', "$root\cloud", '--addr', "127.0.0.1:$davPort", '--user', $user, '--pass', $pass, '--log-level', 'ERROR'
) | Out-Null
Start-Sleep -Seconds 2

# 2) PC 端 vaultd（第一次运行自己生成 master_key / salt），把样本加密传上去
$env:VAULTD_HOME = "$root\home"
$seed = [ordered]@{
  webdav_url  = "http://127.0.0.1:$davPort/dav"
  webdav_user = $user
  webdav_pass = $pass
  remote_path = 'vault'
  chunk_size  = '500Mi'
}
Set-Content -Path "$root\home\config.json" -Value ($seed | ConvertTo-Json) -Encoding utf8 -NoNewline
$p = Start-Process -FilePath "$repo\bin\vaultd.exe" -WindowStyle Hidden -PassThru -RedirectStandardOutput "$root\pc.log" -RedirectStandardError "$root\pc.err" -ArgumentList @(
  '-listen', "127.0.0.1:$appPort", '-open=false', '-writeurl', "$root\url.txt"
) -Environment @{ VAULTD_HOME = "$root\home" }
Start-Sleep -Seconds 3
if (-not (Test-Path "$root\url.txt")) { throw ("vaultd 没起来: " + (Get-Content "$root\pc.err" -Raw)) }
$urlFull = (Get-Content "$root\url.txt" -Raw).Trim()
"url=$urlFull"

# 3) 造样本图片（尺寸差异大，专门看缩略图缩放与网格排布）
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap 3000, 2000
$g = [System.Drawing.Graphics]::FromImage($bmp)
$br = New-Object System.Drawing.Drawing2D.LinearGradientBrush ([System.Drawing.Point]::new(0, 0)), ([System.Drawing.Point]::new(3000, 2000)), ([System.Drawing.Color]::FromArgb(20, 120, 140)), ([System.Drawing.Color]::FromArgb(240, 180, 90))
$g.FillRectangle($br, 0, 0, 3000, 2000)
$g.Dispose()
$bmp.Save("$root\samples\大图_3000x2000.jpg", [System.Drawing.Imaging.ImageFormat]::Jpeg)
$bmp.Dispose()

$bmp2 = New-Object System.Drawing.Bitmap 400, 400
$g2 = [System.Drawing.Graphics]::FromImage($bmp2)
$g2.Clear([System.Drawing.Color]::FromArgb(20, 184, 166))
$font = New-Object System.Drawing.Font 'Microsoft YaHei', 48
$g2.DrawString('密文相册', $font, [System.Drawing.Brushes]::White, 60, 160)
$g2.Dispose()
$bmp2.Save("$root\samples\竖版封面.png", [System.Drawing.Imaging.ImageFormat]::Png)
$bmp2.Dispose()

$bmp3 = New-Object System.Drawing.Bitmap 160, 90
$g3 = [System.Drawing.Graphics]::FromImage($bmp3)
$g3.Clear([System.Drawing.Color]::FromArgb(40, 40, 60))
$g3.Dispose()
$bmp3.Save("$root\samples\小缩略图.gif", [System.Drawing.Imaging.ImageFormat]::Gif)
$bmp3.Dispose()

# 4) 上传（带 cookie 走 /api/upload）
$jar = "$root\cookie.txt"
& "$env:SystemRoot\System32\curl.exe" -s -o NUL -c $jar $urlFull
foreach ($f in Get-ChildItem "$root\samples") {
  $t = '/' + $f.Name
  $code = & "$env:SystemRoot\System32\curl.exe" -s -b $jar -o NUL -w '%{http_code}' -X PUT --data-binary "@$($f.FullName)" -H 'Content-Type: application/octet-stream' ($urlFull.Split('?')[0] + "api/upload?path=" + [uri]::EscapeDataString($t))
  "upload $($f.Name) -> $code"
}

# 5) 设备配置：同一把钥匙 + 指向宿主机 DAV
$cfg = Get-Content "$root\home\config.json" -Raw | ConvertFrom-Json
$dev = [ordered]@{
  webdav_url  = "http://10.0.2.2:$davPort/dav"
  webdav_user = $user
  webdav_pass = $pass
  remote_path = $cfg.remote_path
  master_key  = $cfg.master_key
  salt        = $cfg.salt
  chunk_size  = '500Mi'
}
$json = $dev | ConvertTo-Json
Set-Content -Path "$root\dev_config.json" -Value $json -Encoding utf8 -NoNewline
& $adb push "$root\dev_config.json" /data/local/tmp/config.json | Out-Null
& $adb shell am force-stop com.vaultd.app
& $adb shell "run-as com.vaultd.app cp /data/local/tmp/config.json files/config.json"
& $adb shell am start -n com.vaultd.app/.MainActivity | Out-Null
Start-Sleep -Seconds 8
"fixture ready: dav=$davPort app=$appPort"
