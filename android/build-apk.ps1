param(
  [string]$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [string]$OutDir = ''
)
if (-not $OutDir) { $OutDir = Join-Path $Repo 'bin\android' }
$ErrorActionPreference = 'Stop'

$sdk   = "$env:LOCALAPPDATA\Android\Sdk"
$bt    = Join-Path $sdk 'build-tools\36.1.0'
$platJ = Join-Path $sdk 'platforms\android-36\android.jar'
$jdk   = "$env:PROGRAMFILES\Android\Android Studio\jbr"
$aar   = Join-Path $Repo 'android\app\libs\vaultd.aar'
$man   = Join-Path $Repo 'android\app\src\main\AndroidManifest.xml'
$src   = Join-Path $Repo 'android\app\src\main\java\com\vaultd\app\MainActivity.java'
$build = Join-Path $Repo 'android\build'
$out   = $OutDir

foreach ($p in @($bt, $platJ, $jdk, $aar, $man, $src)) {
  if (-not (Test-Path $p)) { throw "缺少依赖: $p" }
}
New-Item -ItemType Directory -Force -Path $build, $out | Out-Null
$env:JAVA_HOME = $jdk
$env:PATH = "$jdk\bin;$env:PATH"

# 1) 解包 AAR：classes.jar + jni 库
$aarX = Join-Path $build 'aar'
if (Test-Path $aarX) { Remove-Item $aarX -Recurse -Force }
New-Item -ItemType Directory -Force -Path $aarX | Out-Null
Copy-Item $aar (Join-Path $build 'vaultd.zip') -Force
Expand-Archive -Path (Join-Path $build 'vaultd.zip') -DestinationPath $aarX -Force
$aarClasses = Join-Path $aarX 'classes.jar'
if (-not (Test-Path $aarClasses)) { throw "AAR 里没有 classes.jar" }
$jni = Get-ChildItem $aarX -Recurse -Filter *.so | Select-Object -First 10
"jni 库: " + (($jni | ForEach-Object { $_.FullName.Substring($aarX.Length + 1) }) -join ', ')

# 2) 资源链接（无 res，只有 manifest）
$baseApk = Join-Path $build 'base.apk'
if (Test-Path $baseApk) { Remove-Item $baseApk -Force }
& "$bt\aapt2.exe" link -o $baseApk -I $platJ --manifest $man --min-sdk-version 24 --target-sdk-version 36
if ($LASTEXITCODE -ne 0) { throw "aapt2 link 失败" }
"aapt2 link OK: $((Get-Item $baseApk).Length) 字节"

# 3) 编译 Java
$objDir = Join-Path $build 'obj'
if (Test-Path $objDir) { Remove-Item $objDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $objDir | Out-Null
& "$jdk\bin\javac.exe" -encoding UTF-8 -source 11 -target 11 -nowarn -Xlint:-options `
   -classpath "$platJ;$aarClasses" -d $objDir $src
if ($LASTEXITCODE -ne 0) { throw "javac 失败" }
"javac OK"

# 4) dex
$dexDir = Join-Path $build 'dex'
if (Test-Path $dexDir) { Remove-Item $dexDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $dexDir | Out-Null
$classFiles = Get-ChildItem $objDir -Recurse -Filter *.class | ForEach-Object { $_.FullName }
& "$bt\d8.bat" --lib $platJ --min-api 24 --output $dexDir $aarClasses @classFiles
if ($LASTEXITCODE -ne 0) { throw "d8 失败" }
"d8 OK: " + ((Get-ChildItem $dexDir | ForEach-Object { "$($_.Name)($($_.Length))" }) -join ', ')

# 5) 组装 APK（classes.dex + so）
$unsigned = Join-Path $build 'unsigned.apk'
Copy-Item $baseApk $unsigned -Force
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::Open($unsigned, 'Update')
foreach ($f in Get-ChildItem $dexDir -Filter *.dex) {
  $entry = $zip.GetEntry($f.Name)
  if ($entry) { $entry.Delete() }
  [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, $f.Name, 'NoCompression')
}
foreach ($so in $jni) {
  $rel = 'lib/' + $so.Directory.Name + '/' + $so.Name
  $entry = $zip.GetEntry($rel)
  if ($entry) { $entry.Delete() }
  [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $so.FullName, $rel, 'NoCompression')
}
$zip.Dispose()
"组装 OK"

# 6) 对齐 + 签名
$aligned = Join-Path $build 'aligned.apk'
if (Test-Path $aligned) { Remove-Item $aligned -Force }
& "$bt\zipalign.exe" -f -p 4 $unsigned $aligned
if ($LASTEXITCODE -ne 0) { throw "zipalign 失败" }

$ks = Join-Path $build 'debug.keystore'
if (-not (Test-Path $ks)) {
  & "$jdk\bin\keytool.exe" -genkeypair -v -keystore $ks -storepass android -keypass android `
     -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 `
     -dname "CN=Android Debug,O=Android,C=US" 2>&1 | Select-Object -Last 2
}
$final = Join-Path $out 'vault-android-debug.apk'
if (Test-Path $final) { Remove-Item $final -Force }
& "$bt\apksigner.bat" sign --ks $ks --ks-pass pass:android --key-pass pass:android --out $final $aligned
if ($LASTEXITCODE -ne 0) { throw "apksigner 失败" }
& "$bt\apksigner.bat" verify --print-certs $final | Select-Object -First 4
"APK: $final  {0:N1} MB" -f ((Get-Item $final).Length / 1MB)
