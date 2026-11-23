param(
    [string]$Name = 'native40m.bin'
)
$ErrorActionPreference = 'Stop'
$u = Get-Content "$env:TEMP\vaultd_url.txt" -Raw
$base = ($u -split '/\?t=')[0]
$t = ($u -split '/\?t=')[1]

$src = "$env:TEMP\native40m.bin"
if (-not (Test-Path $src)) {
    $fs = [System.IO.File]::Create($src)
    $buf = New-Object byte[] (4MB)
    $rnd = [System.Random]::new(7)
    for ($i = 0; $i -lt 10; $i++) {
        $rnd.NextBytes($buf)
        $fs.Write($buf, 0, $buf.Length)
    }
    $fs.Dispose()
}
$size = (Get-Item $src).Length
Write-Output "源文件 $size 字节"

# 1) 上传（40MB 密文 → chunker 1 片 → crypt → 内置 DAV → 云端 1 个分片）
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$code = & "$env:SystemRoot\System32\curl.exe" -s -o "$env:TEMP\native_up.json" -w "%{http_code}" `
    -X PUT -H "Content-Type: application/octet-stream" --data-binary "@$src" `
    "$base/api/upload?path=/$Name&t=$t"
$sw.Stop()
Write-Output ("上传 HTTP $code 用时 " + [math]::Round($sw.Elapsed.TotalSeconds, 2) + "s")
Get-Content "$env:TEMP\native_up.json" -Raw | Write-Output

# 2) 列表确认
$list = Invoke-RestMethod -Uri "$base/api/list?path=/&t=$t" -TimeoutSec 120
$item = $list.entries | Where-Object { $_.name -eq $Name }
Write-Output ("列表大小 " + $item.size)

# 3) 90% 位置 Range 读 1MiB
$off = [int64]($size * 0.9)
$len = 1MB
$out = "$env:TEMP\native_slice.bin"
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$resp = & "$env:SystemRoot\System32\curl.exe" -s -D "$env:TEMP\native_hdr.txt" -o $out `
    -H "Range: bytes=$off-$($off + $len - 1)" "$base/api/stream?path=/$Name&t=$t"
$sw.Stop()
Write-Output ("Range 请求总耗时 " + [math]::Round($sw.Elapsed.TotalSeconds, 2) + "s，落盘 " + (Get-Item $out).Length + " 字节")
Get-Content "$env:TEMP\native_hdr.txt" | Where-Object { $_ -match 'HTTP/|Content-Range|Content-Length|Accept-Ranges' }

# 4) 切片一致性
$fs = [System.IO.File]::OpenRead($src)
$fs.Position = $off
$want = New-Object byte[] $len
$read = $fs.Read($want, 0, $len)
$fs.Dispose()
$h1 = (Get-FileHash -LiteralPath $out -Algorithm SHA256).Hash
$ms = New-Object System.IO.MemoryStream
$ms.Write($want, 0, $read); $ms.Position = 0
$h2 = (Get-FileHash -InputStream $ms -Algorithm SHA256).Hash
$ms.Dispose()
Write-Output "本地切片 $h2"
Write-Output "服务端切片 $h1"
Write-Output ("切片一致: " + ($h1 -eq $h2))

# 5) 首字节时间（100KB 前缀）
$sw = [System.Diagnostics.Stopwatch]::StartNew()
& "$env:SystemRoot\System32\curl.exe" -s -o NUL -H "Range: bytes=0-102399" "$base/api/stream?path=/$Name&t=$t"
$sw.Stop()
Write-Output ("首 100KB 耗时 " + [math]::Round($sw.Elapsed.TotalSeconds, 2) + "s")

