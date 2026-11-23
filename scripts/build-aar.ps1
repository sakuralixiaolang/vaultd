$ErrorActionPreference = 'Stop'
$env:GOPROXY = 'https://goproxy.cn,direct'
$env:GOSUMDB = 'sum.golang.google.cn'
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:ANDROID_NDK_HOME = "$env:LOCALAPPDATA\devtools\android-ndk\android-ndk-r27c"
$env:ANDROID_NDK_ROOT = $env:ANDROID_NDK_HOME
$env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
$env:PATH = "$env:JAVA_HOME\bin;C:\Program Files\Git\cmd;$env:LOCALAPPDATA\devtools\go\bin;$env:PATH"

$gomobile = "$env:LOCALAPPDATA\devtools\go\bin\gomobile.exe"
$repo = Split-Path -Parent $PSScriptRoot
Push-Location $repo
try {
    & $gomobile bind '-target=android/arm64,android/amd64' '-androidapi' '24' '-o' 'android\app\libs\vaultd.aar' '.\mobile'
    if ($LASTEXITCODE -ne 0) { throw "gomobile bind 失败: $LASTEXITCODE" }
    $aar = Get-Item 'android\app\libs\vaultd.aar'
    "AAR 已生成 $($aar.Length) 字节"
} finally {
    Pop-Location
}
