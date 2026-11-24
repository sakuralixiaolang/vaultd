param([Parameter(Mandatory = $true)][string]$Expression, [int]$WaitMs = 0, [string]$Shot = '')
$ErrorActionPreference = 'Stop'
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"

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
$res = Send-Cmd $ws 1 'Runtime.evaluate' @{ expression = $Expression; returnByValue = $true; awaitPromise = $true }
$val = ($res | ConvertFrom-Json).result.result.value
if ($Shot) {
  [void](Send-Cmd $ws 2 'Page.enable' @{})
  $cap = Send-Cmd $ws 3 'Page.captureScreenshot' @{ format = 'png'; captureBeyondViewport = $false }
  $b64 = ($cap | ConvertFrom-Json).result.data
  if ($b64) { [IO.File]::WriteAllBytes($Shot, [Convert]::FromBase64String($b64)); "shot -> $Shot" } else { "shot failed" }
}
$val
$ws.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, 'bye', [Threading.CancellationToken]::None).Wait()
if ($WaitMs -gt 0) { Start-Sleep -Milliseconds $WaitMs }
