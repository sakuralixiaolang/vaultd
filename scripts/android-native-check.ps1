$ErrorActionPreference = 'Stop'
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
$emu = "$env:LOCALAPPDATA\Android\Sdk\emulator\emulator.exe"
$repo = Split-Path -Parent $PSScriptRoot

# 1) 模拟器
$devices = & $adb devices
if ($devices -notmatch 'emulator-') {
    Start-Process -FilePath $emu -ArgumentList '-avd','Medium_Phone_API_36.1','-no-window','-no-audio','-no-boot-anim','-gpu','off','-no-snapshot','-feature','-Vulkan'
    & $adb wait-for-device
    for ($i = 0; $i -lt 120; $i++) {
        $b = (& $adb shell getprop sys.boot_completed) -join ''
        if ($b.Trim() -eq '1') { break }
        Start-Sleep -Seconds 3
    }
}
"设备: " + ((& $adb devices) -join ' / ')

# 2) 安装
& $adb install -r "$repo\bin\android\vault-android-debug.apk" | Select-Object -Last 2

# 3) 写入 native 模式配置（与 PC 同一把主密钥 + 同一条云端授权）
$pc = Get-Content (Join-Path $env:APPDATA 'EncryptedVault\config.json') -Raw | ConvertFrom-Json
$dev = [ordered]@{
    backend             = 'native'
    cloud_provider      = '139'
    cloud_authorization = $pc.cloud_authorization
    webdav_url          = ''
    webdav_user         = ''
    webdav_pass         = ''
    remote_path         = $pc.remote_path
    master_key          = $pc.master_key
    salt                = $pc.salt
    chunk_size          = $pc.chunk_size
    listen              = '127.0.0.1:0'
}
$devJson = $dev | ConvertTo-Json
$tmp = "$env:TEMP\mob_native_cfg.json"
[System.IO.File]::WriteAllText($tmp, $devJson, (New-Object System.Text.UTF8Encoding($false)))
& $adb push $tmp /data/local/tmp/config.json | Out-Null
& $adb shell run-as com.vaultd.app mkdir -p files
& $adb shell "run-as com.vaultd.app cp /data/local/tmp/config.json files/config.json"
& $adb shell "run-as com.vaultd.app ls -l files"

# 4) 启动并截图
& $adb shell am force-stop com.vaultd.app
& $adb shell am start -n com.vaultd.app/.MainActivity | Out-Null
Start-Sleep -Seconds 14
& $adb exec-out screencap -p > "$repo\bin\android\native-list.png"
"截图已保存"
