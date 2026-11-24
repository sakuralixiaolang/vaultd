# 用 PC 端真实配置填一遍安卓的「内置直连」表单，验证保存链路（不在命令输出里打印任何密钥）
$ErrorActionPreference = 'Stop'
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
$cfg = Get-Content "$env:APPDATA\EncryptedVault\config.json" -Raw | ConvertFrom-Json

$expr = @'
(function(){
  const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event("input", {bubbles:true})); };
  set("fAuth", __AUTH__);
  set("fKey", __KEY__);
  set("fSalt", __SALT__);
  set("fRemoteN", __REMOTE__);
  document.getElementById("btnSaveCloud").click();
  return "filled";
})()
'@
$expr = $expr.Replace('__AUTH__', ($cfg.cloud_authorization | ConvertTo-Json -Compress))
$expr = $expr.Replace('__KEY__', ($cfg.master_key | ConvertTo-Json -Compress))
$expr = $expr.Replace('__SALT__', ($cfg.salt | ConvertTo-Json -Compress))
$expr = $expr.Replace('__REMOTE__', (($cfg.remote_path, 'vault' -ne $null)[0] | ConvertTo-Json -Compress))

& pwsh -File "$PSScriptRoot\cdp-eval.ps1" -Expression $expr | Out-Null
Start-Sleep -Seconds 4
& pwsh -File "$PSScriptRoot\cdp-eval.ps1" -Expression 'JSON.stringify({configured:state.configured, ready:state.vaultReady, backend:state.status.backend, key:state.status.key_fingerprint, mode:state.mode, err:document.getElementById("setupMsg").textContent, entries:(state.entries||[]).length})'

