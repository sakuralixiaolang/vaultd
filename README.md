# 密文相册（自用）

把本地照片/视频加密后放进个人云盘，云端只存密文；本机点开就能播，进度条随便拖。

- **加密格式**：直接用 rclone 的 `crypt` 格式（64 KiB 一块，**每块独立 nonce + 独立 Poly1305 tag**），文件名/目录名用 AES-256-EME 加密。本仓库**不含任何密码学实现**。
- **大文件**：rclone `chunker` 分片（默认 500 MiB），叠加在 crypt 之下，云端看到的是纯乱码名，没有工具指纹。
- **播放**：本地 Range 网关把 HTTP Range 精确换算成密文偏移，只请求需要的那一小段，浏览器边解边播。
- **密钥**：首次运行自动生成，落在本机配置里；没有密码、没有解锁、没有恢复码。

## 首次运行会自动生成密钥

第一次启动时，若本机没有密钥，程序会生成 32 字节随机主密钥与盐，写入：

```
Windows: %APPDATA%\EncryptedVault\config.json
其他平台: 用户配置目录下的 EncryptedVault/config.json
```

安卓端对应 `App 私有目录/files/config.json`（同样首次运行自动生成，用户无需任何操作）。

**该文件不可外传。** 它同时保存主密钥和云端接入凭据；丢了它，云端密文再也解不开；泄露它，等于把库交出去。
界面上显示的「密钥指纹」是主密钥的 SHA-256 前 8 位，只用来核对两台设备是不是同一把钥匙，不含密钥本身、也不可反推。
仓库里只有 `config.example.json`（纯占位符，不含任何凭据、域名或密钥），`.gitignore` 已覆盖 `config.json`、`key.json`、`rclone.conf`、`.env` 等。

## 目录结构

```
cmd/vaultd/            程序入口：监听 127.0.0.1，打印带 token 的地址
mobile/                Go 移动绑定：把同一个网关跑在 App 进程里
internal/localcfg/     本机配置 + 主密钥引导（首启生成、原子落盘）
internal/vault/        chunker→crypt→webdav 三层组装，List/Upload/OpenRange
internal/server/       Range 网关、上传、错误分类
internal/webui/        内嵌前端（列表 / 相册 / 播放器）
android/               单 Activity + WebView 壳、手工打包脚本（不依赖 Gradle）
scripts/selftest.ps1   无需真实云盘的全链路自测
docs/选型结论.md        阶段 0 的检索与选型依据
```

## 构建与运行

需要 Go 1.26+（只用于构建）。

```powershell
go build -o bin\vaultd.exe .\cmd\vaultd
.\bin\vaultd.exe
```

启动后控制台会打印形如 `http://127.0.0.1:53211/?t=<token>` 的地址，浏览器打开即可。
token 只用于挡住本机其它进程，不是你的密码；每次启动都重新生成。

## 接入要求（关键）

MVP 走本机 AList / OpenList 暴露的 WebDAV：

1. 目标存储**必须开启「Web 代理 / WebDAV 本地代理」**。不开启时上游只给 302 直链，WebDAV 层拿不到 206，视频就拖不动。
2. 用 **账号密码**（WebDAV Basic Auth）接入，不要只填抓包得到的 token——token 会过期，账号密码不会。
3. 页面里填：WebDAV 地址、用户名、密码、密文根目录（默认 `vault`）、分片大小（默认 `500Mi`）。

## 验收用例

| 用例 | 怎么验 |
|---|---|
| 云端只有乱码与密文 | 云盘网页端打开 `vault` 目录：文件名为 base32 乱码、无扩展名、无缩略图、无法预览 |
| 干净机器开局 | 删掉本机配置目录后重新 build 并启动：自动生成新密钥、可连上、可列目录 |
| 4 GB 拖到 90% | 播放器里点「跳到 90%」，页面会显示「起播耗时 xxx ms」；同时看网关日志只有小段 Range |
| restart 保持 | 杀进程重启，密钥指纹不变、已上传文件仍可播 |
| 仓库干净 | `git status` 干净；`scripts/secret-scan.ps1` 不报凭据、私人路径、真实对象名与身份信息 |

## 自测（不需要真实云盘）

```powershell
.\scripts\selftest.ps1
```

它会：起一个本地 WebDAV 冒充云端 → 用临时目录跑一份 vaultd → 传 200 MB → 请求 90% 位置的 1 MB → 断言 `206`、`Content-Range`、以及**解密出的字节与原文 SHA256 一致**，最后验证重启后密钥指纹不变。

### 本机实测（2026-11-22，本地 WebDAV 作为云端替身）

| 项目 | 结果 |
|---|---|
| 200 MB 上传 → 列表显示原始大小 | 通过 |
| 云端落地文件名 | 一串 base32 乱码（无扩展名、无缩略图） |
| 密文头部 | `RCLONE`（8 字节魔数 + 24 字节 nonce） |
| 90% 位置取 1 MiB | **206**，`Content-Range: bytes 188743680-<终点>/<总长>`，**76 ms** |
| 该 1 MiB 与原文 SHA256 | **一致**（证明偏移换算没跑偏） |
| 4 GB 上传 | **48.8 s**（≈88 MB/s），云端落地 8×500 MiB + 1 尾片 + 1 个 128 字节元数据对象 |
| 4 GB 跳到 90% 取 8 MiB | **207 ms**，只回 `Content-Range: bytes <起点>-<终点>/<总长>` |
| 浏览器式请求（`bytes=0-` / 后缀 `bytes=-16384` / 中段） | 全部 206，尾部 16 KiB 与原文一致 |
| HEAD | 200 + `Accept-Ranges: bytes` + `Content-Type: video/mp4` |
| 杀进程重启 | 密钥指纹不变，密文库仍可用 |

> 以上是**本地模拟云端**的结果，链路语义与真实 WebDAV 一致。

### 真实云盘实测（2026-11-22，云盘经本机 OpenList 的 WebDAV 驱动）

| 项目 | 结果 |
|---|---|
| 40 MB 加密上传 | HTTP 200，耗时取决于上行带宽 |
| 90% 位置取 1 MiB | **206**，`Content-Range: bytes <起点>-<终点>/<总长>`，首字节数百毫秒级 |
| 该切片与源文件同区间 SHA256 | **一致** |
| 云端落地对象 | 约 40 MB，前 8 字节 = `RCLONE` 魔数（云端只能看到密文） |
| 列表 | 返回解密后的原名与原始大小 |

## 安卓端（同一套内核）

安卓端不是另写一套，而是把**同一个 Go 网关**跑在 App 进程里，WebView 加载同一个前端：

```
mobile/mobile.go               导出 start/stop/fingerprint/configured/saveWebDAV
android/app/.../MainActivity   单 Activity + WebView；文件选择走 onShowFileChooser
android/build-apk.ps1          不依赖 Gradle：aapt2 → javac → d8 → 塞 dex 与 lib/*.so → zipalign → apksigner
```

构建（先把 Go 侧绑定成 AAR，再打 APK）：

```powershell
$env:ANDROID_HOME      = "$env:LOCALAPPDATA\Android\Sdk"
$env:ANDROID_NDK_HOME  = "C:\path\to\android-ndk-r27c"
$env:JAVA_HOME         = "C:\Program Files\Android\Android Studio\jbr"
go install golang.org/x/mobile/cmd/gobind@<go.mod 里的 x/mobile 版本>
$t = 'android/arm64,android/amd64'
gomobile bind -v -target $t -androidapi 24 -o android\app\libs\vaultd.aar .\mobile
.\android\build-apk.ps1
```

产物：`bin/android/vault-android-debug.apk`（含 `arm64-v8a` 与 `x86_64`，可直接装机与跑模拟器）。

### 手机怎么连云端

App 里的网关只监听 `127.0.0.1`。手机要够到一个跑在别处的 OpenList，有两条路：

1. **临时**：把 OpenList 的 `scheme.address` 从 `127.0.0.1` 改成 `0.0.0.0`（并在防火墙放行端口），App 内「接入设置」填电脑的局域网地址。注意这会把 OpenList 暴露到局域网。
2. **彻底**：等阶段 3 的**内置网盘驱动**，手机上不再依赖 OpenList。

模拟器联调时用 `http://10.0.2.2:5244/dav` 指向宿主机回环。

### 安卓端实测（2026-11-23，模拟器，与 PC 同一把密钥）

| 项目 | 结果 |
|---|---|
| 密钥指纹 | 与 PC 端完全一致（配置里没有再次生成） |
| 列目录 | 解密出原名与原始大小（照片 / 大文件 / 视频各一个） |
| 设备侧网关 90% 位置取 1 MiB | **206** + 正确 `Content-Range`，切片 SHA256 与 PC 源文件同区间**一致** |
| 图片解密渲染 | 200、PNG 魔数、原图尺寸，WebView 正常显示 |
| 视频跳 90% | `seeked` **1.66 s**、进入播放 `readyState=4`；页内探针显示「起播耗时 32 ms」 |

> 调试技巧：debug 包默认打开 WebView 调试，`adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>` 后可直接在 DevTools 里看页面与网关请求。
> 若模拟器改过 `wm size`（override 尺寸与截图像素不一致），`adb shell input tap` 要用 override 坐标，否则点不中。

## 已知边界

- 文件名是**确定性加密**：同名文件密文名相同，云端能看出"两个目录有同名文件"和目录树形状。这是 rclone 格式的固有代价。
- 文件长度（16 字节精度）和修改时间不加密，云端知道你存了多大、什么时候传的。
- 断点粒度 = 分片大小（500 MiB）；片内失败要整片重传。真正的细粒度断点留给后续自建驱动阶段。
- 阶段 3 会把 OpenList 换成本机内置驱动，**云端数据不用迁移**：加密格式与分片布局保持不变。

