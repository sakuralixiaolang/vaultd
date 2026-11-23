$ErrorActionPreference = 'Stop'
$sdk = "$env:LOCALAPPDATA\Android\Sdk"; $adb = "$sdk\platform-tools\adb.exe"
$repo = Split-Path -Parent $PSScriptRoot

$appPid = (& $adb shell pidof com.vaultd.app) -join ''
if (-not $appPid.Trim()) { throw "App 未运行" }
& $adb forward tcp:9222 "localabstract:webview_devtools_remote_$($appPid.Trim())" | Out-Null
Start-Sleep -Milliseconds 800

$pages = Invoke-RestMethod -Uri 'http://127.0.0.1:9222/json' -TimeoutSec 5
$page = $pages | Where-Object { $_.url -like 'http://127.0.0.1*' } | Select-Object -First 1
if (-not $page) { throw "没有找到页面: $($pages | ConvertTo-Json -Compress)" }
$wsUrl = $page.webSocketDebuggerUrl

function Send-Cmd($ws, $id, $method, $params) {
  $obj = @{ id = $id; method = $method; params = $params } | ConvertTo-Json -Depth 12 -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($obj)
  $ws.SendAsync([ArraySegment[byte]]::new($bytes), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).Wait()
  $buf = New-Object byte[] 131072
  $sb = New-Object System.Text.StringBuilder
  while ($true) {
    $r = $ws.ReceiveAsync([ArraySegment[byte]]::new($buf), [Threading.CancellationToken]::None).Result
    [void]$sb.Append([System.Text.Encoding]::UTF8.GetString($buf, 0, $r.Count))
    $txt = $sb.ToString()
    if ($r.EndOfMessage -and $txt -match ('"id":' + $id + '[,}]')) { return $txt }
  }
}

$ws = [System.Net.WebSockets.ClientWebSocket]::new()
$ws.ConnectAsync([Uri]$wsUrl, [Threading.CancellationToken]::None).Wait()

$before = Send-Cmd $ws 1 'Runtime.evaluate' @{ expression = 'JSON.stringify({btn: !!document.getElementById("btnNativeToggle"), hidden: document.getElementById("nativeForm").classList.contains("hidden")})'; returnByValue = $true }
"before: " + ($before | ConvertFrom-Json).result.result.value

$click = Send-Cmd $ws 2 'Runtime.evaluate' @{ expression = 'document.getElementById("btnNativeToggle").click(); "clicked"'; returnByValue = $true }
"click: " + ($click | ConvertFrom-Json).result.result.value

Start-Sleep -Milliseconds 600
$after = Send-Cmd $ws 3 'Runtime.evaluate' @{ expression = 'JSON.stringify({hidden: document.getElementById("nativeForm").classList.contains("hidden"), fields: [...document.querySelectorAll("#nativeForm input, #nativeForm textarea")].map(e => e.id)})'; returnByValue = $true }
"after: " + ($after | ConvertFrom-Json).result.result.value

$ws.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, 'bye', [Threading.CancellationToken]::None).Wait()
Start-Sleep -Seconds 1
& $adb exec-out screencap -p > "$repo\bin\android\native-setup7.png"
"截图完成"
