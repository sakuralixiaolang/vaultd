# vaultd · 密文备份

把本地文件加密后放进个人云盘，云端只存密文；图片视频本机点开就能播，进度条随便拖，可以解决图片视频压缩文件误杀问题，一定程度上保护隐私。**注意不要当作唯一备份和加密！！密钥丢失等同文件丢！！！**。

> 说明：这是一个自托管的小工具，单独一套进程、单独一份密钥，不依赖任何第三方服务器。
> 云盘驱动对接的是**非官方接口**，仅供个人备份与学习使用，与服务提供商无关，也不构成任何官方支持；
> 使用前请自行确认符合你所使用服务的条款。

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
internal/cloud139/     内置个人云客户端（路由/列表/直链/Range 读/分片上传/改名/删除）
internal/dav/          进程内最小 WebDAV 服务，把云盘接口翻译成 rclone 认识的文件系统
internal/vault/        chunker→crypt→webdav 三层组装，List/Upload/OpenRange
internal/server/       Range 网关、上传、错误分类、缩略图（/api/thumb，内存 LRU）
internal/webui/        内嵌前端（网格相册 / 列表 / 查看器 / 上传队列）
android/               单 Activity + WebView 壳、手工打包脚本（不依赖 Gradle）
scripts/selftest.ps1   无需真实云盘的全链路自测
scripts/ui-fixture.ps1 离线 UI 验收：本机 WebDAV 替身 + 模拟器指向宿主机
scripts/build-aar.ps1  重建安卓 Go 绑定
scripts/native_accept.ps1  内置驱动端到端验收（40 MB 上传 + 90% Range）
scripts/secret-scan.ps1   提交前自检：扫凭据、私人标识、真实对象名
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

## 接入方式（两种，二选一）

### A. 内置直连（默认形态，PC 与手机都不需要外部进程）

`config.json` 里：

```json
{
  "backend": "native",
  "cloud_provider": "139",
  "cloud_authorization": "<登录后得到的 base64 授权串>",
  "remote_path": "vault"
}
```

- `cloud_authorization` 由登录流程得到（`Authorization` 头的原文），**只存本机、不入仓库**；
  剩余有效期不足 15 天时客户端会自动调刷新接口换新，并把新串回写配置。
- 授权串里带着账号与过期时间，解码规则见 `internal/cloud139/client.go` 的 `splitAuth`。
- 这一形态下 rclone 的 `webdav` 层指向进程内 `127.0.0.1:53511`（端口被占时退回随机口），由 `internal/dav` 直连云盘；
  端口随进程生命周期存在，口令随机生成，进程退出即失效。

安卓侧同一个内核：App 私有目录放同一份配置即可。**新设备不用命令行**——在「接入设置」里
把 PC 端配置的三样东西贴进去（`cloud_authorization`、`master_key`、`salt`），点「保存并连接」即可；
只贴授权串也行，但那样会生成一把新钥匙，只能看到之后新传的内容。

`POST /api/setup` 对 native 形态做了前置校验：授权串必须能解码、能分出三段、没过期；
主密钥与盐必须成对出现且各是 64 位 hex。任一项不合格都不会落盘，已有配置不受影响。

### B. 外部 WebDAV（旧形态，仍保留）

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
| 手机端相册 | `scripts/ui-fixture.ps1` 后看：网格出真缩略图（3000×2000 大图缩放正常）、左右切图、双击放大、返回键先关查看器 |
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

### 内置驱动实测（2026-11-23，`backend=native`，**全程没有 OpenList 进程**）

| 项目 | 结果 |
|---|---|
| 鉴权与路由 | `qryRoutePolicy` 下发 `personal-*` 主机，全程只用授权串，不存 Cookie |
| 列目录 | 根目录数十项、`vault` 下若干密文对象，名字与大小与旧路径完全一致 |
| 40 MB 加密上传 | HTTP 200；耗时与链路带宽相关，与 OpenList 路径同量级 |
| 90% 位置取 1 MiB | **206**，`Content-Range` 起点正确，切片 SHA256 与源文件**一致** |
| 首 100 KB | 冷启动数秒（含建连），热连接亚秒级 |
| 云端对象 | 新对象名是一串 base32 乱码，大小与源文件同量级，头 8 字节 `RCLONE` |
| 建目录幂等 | 重复 MKCOL 返回 405，不再产生 `vault_<时间戳>` 影子目录（修掉了 `force_rename` 的坑） |
| 改名（chunker 收尾） | `POST /file/update` 原地改名，避免多余的服务器端拷贝 |
| 安卓端（native 配置） | 同一把钥匙（指纹与 PC 一致）、列表可见、点开图片正常解密渲染 |

客户端实现要点（均可对照 `internal/cloud139`）：

- 路由：`POST https://user-njs.yun.139.com/user/route/qryRoutePolicy`，取 `modName=personal` 的 `httpsUrl`。
- 列表：`POST {host}/file/list`，`pageCursor` 翻页到空为止；`type=="folder"` 视为目录。
- 下载：`POST {host}/file/getDownloadUrl`，`cdnSwitch=true` 用 `cdnUrl` 否则 `url`；网关把 `Range` 头原样透传给 CDN。
- 上传：`/file/create`（先算 SHA256）→ 分片 `PUT` → 超过 100 片用 `/file/getUploadUrl` 追加 → `/file/complete`；分片 100 MB，>30 GB 时 512 MB。
- 建目录：`/file/create` `type=folder`；删除：`/recyclebin/batchTrash`。
- 通用头与签名：`Mcloud-Sign: <ts>,<rand>,<sig>`，签名 = `urlencode(body)` 按字符排序 → base64 → `MD5` 两轮后大写。

> 接口行为通过阅读 OpenList 的 139 驱动源码确认；这里是与它**独立实现**的最小客户端，没有把 AGPL 代码搬进本仓库。

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

内置驱动形态下，手机**不需要**够到任何跑在别处的进程：网关、云盘客户端都在 App 进程内，
App 私有目录的 `config.json` 里放 `backend=native` + `cloud_provider=139` + `cloud_authorization` 即可。

新装 App 打开「设置」时，默认展示的就是内置直连表单（`backend` 默认 `native`），要填四样：

| 字段 | 从哪来 | 说明 |
|---|---|---|
| 云端授权串 | PC 配置里的 `cloud_authorization` | 单会话语义：手机续期后 PC 旧串可能失效，反之亦然 |
| 主密钥 | PC 配置里的 `master_key` | **必须与 PC 一致**，留空等于新生成一把钥匙，打不开已有密文 |
| 盐 | PC 配置里的 `salt` | 与主密钥成对 |
| 密文根目录 | 默认 `vault` | 与 PC 相同 |

PC 端配置文件位置：Windows 为 `%APPDATA%\EncryptedVault\config.json`。
#### 一键搬家：配置导出 / 导入（2026-11-24）

手抄 64 位密钥不现实，所以设置面板里内置了搬运通道：

1. 电脑端点「导出配置」，浏览器得到 `vaultd-config.json`（含 `cloud_authorization`、`master_key`、`salt`、根目录、分片大小）。
2. 把这个文件发到手机（微信文件传输、139 邮箱、任意网盘都行）。
3. 手机端「设置 → 内置直连 → 选择文件导入」，选中文件即自动填入并连接，顶部指纹应与电脑一致。
   不方便传文件时，也可以把文件内容整段粘到「从文本导入」的框里。

接口：`GET /api/config/export`（`Content-Disposition: attachment`）、`POST /api/config/import`（与 `/api/setup` 共用同一套校验与落盘逻辑）。
导出文件**等于整库钥匙**，界面和文件里都写了「别发给别人、导入完就删」；服务端不提供任何后台自动导出。
保存后顶部指纹应与 PC 一致（8 位十六进制，例如 `A1B2C3D4`），
列表里能看到 PC 传过的文件，才说明密钥对上了。接入方式随时可在设置面板里切到「外部 WebDAV」。

只有回到旧形态（`backend` 为空、走外部 WebDAV）时，才需要让手机够到电脑上的 OpenList：

1. **临时**：把 OpenList 的 `scheme.address` 从 `127.0.0.1` 改成 `0.0.0.0`（并在防火墙放行端口），App 内「接入设置」填电脑的局域网地址。注意这会把 OpenList 暴露到局域网。
2. 模拟器联调时用 `http://10.0.2.2:5244/dav` 指向宿主机回环。

### 安卓端实测（2026-11-23，模拟器，与 PC 同一把密钥）

| 项目 | 结果 |
|---|---|
| 密钥指纹 | 与 PC 端完全一致（配置里没有再次生成） |
| 列目录 | 解密出原名与原始大小（照片 / 大文件 / 视频各一个） |
| 设备侧网关 90% 位置取 1 MiB | **206** + 正确 `Content-Range`，切片 SHA256 与 PC 源文件同区间**一致** |
| 图片解密渲染 | 200、PNG 魔数、原图尺寸，WebView 正常显示 |
| 视频跳 90% | `seeked` **1.66 s**、进入播放 `readyState=4`；页内探针显示「起播耗时 32 ms」 |
| 内置驱动（native 配置，无 OpenList） | 指纹与 PC 一致、列表若干项，点开图片解密渲染正常 |

> 调试技巧：debug 包默认打开 WebView 调试，`adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>` 后可直接在 DevTools 里看页面与网关请求。
> 若模拟器改过 `wm size`（override 尺寸与截图像素不一致），`adb shell input tap` 要用 override 坐标，否则点不中。

### 手机端界面（2026-11-24 改版）

App 名从「密文相册」改成「**我的网盘**」（`AndroidManifest.xml` 的 `android:label` 与页面标题同步）。前端仍然是同一份 `internal/webui/static/*`，PC 与安卓共用，改版重点是「像相册而不是文件列表」：

- **网格相册**：方形瓦片、`object-fit: cover`、底部渐变名条；视频/音频/普通文件用角标区分格式，文件夹单独配色。视图可在「网格 / 列表」间切换，按名称/时间/大小排序，选择记在 `localStorage`。
- **深色 / 浅色两套主题**：右上角 ◐ 一键切换，首次进入跟随系统 `prefers-color-scheme`，手动切过就用 `localStorage["vaultd.theme"]` 记住。样式全部改成语义变量（`--bg/--panel/--tile/--meta-grad/...`），`[data-theme="light"]` 只覆盖变量与几处渐变；缩略图名条在浅色下换成白底深字，查看器始终深色（看图看片时浅底反而刺眼）。
- **缩略图**：新增 `GET /api/thumb?path=&w=`。服务端按扩展名只接 `jpg/png/gif/webp/bmp`，整包读入（>24 MiB 直接拒绝，避免手机上爆内存），`x/image/draw` 的 Catmull-Rom 缩放到目标宽度后编成 JPEG(q82)，按 `路径+大小+修改时间+宽度` 做键，内存缓存上限 200 张 / 48 MiB；同一个键并发请求只解码一次。不支持的格式返回错误让前端退回占位图标。
- **视频首帧缩略**：不塞 ffmpeg，交给 WebView 解码：静音自动播放 → `requestVideoFrameCallback` 拿到第一帧立刻暂停 → `drawImage` 进 canvas 顶到格子里，随后立刻释放 `<video>`（`src` 置空再 `remove()`）。用 canvas 而不是直接摆 `<video>`，是因为部分 WebView（软件渲染 / 无 GPU）只解码不合成，会留一块黑。每次重绘预算 24 个，超出保留图标；9 s 硬超时兜底，避免格子里挂着一个不放的 video 元素。
- **查看器**：左右箭头 + 单指横滑切图（放大状态下不切，避免和拖动冲突）、双击放大到 2 倍并按点中位置定位、放大后可拖动查看整张；视频保留 90% 跳转与起播探针。
- **返回键**：`targetSdk 36` 下系统默认走预测性返回，`onBackPressed` 不会被调用，因此 Activity 显式注册 `OnBackInvokedCallback`，交给前端的 `window.vaultdBack()`：先关查看器，再退一层目录，到根目录才退出 App。
- **上传（任意文件类型）**：照片、视频之外的文档、压缩包、安装包和未知格式都走同一个 `/api/upload`（服务端不按扩展名拦截，只要求 `Content-Length` 以便确定密文长度）。队列成功后自动收起；失败按 `1s / 3s / 8s` 退避重试，重试耗尽后留一行错误并提供「重试」按钮；上传目标目录在上传开始时固定，中途翻目录不会传错地方。
- **按文件夹上传**：上传面板多了「上传到」下拉——当前目录、当前目录下已有子文件夹、`＋ 新建文件夹…`（选新建会露出日期预填的输入框）。开始上传前先 `POST /api/mkdir` 建目录，文件全部传进这个目录，所以当前目录里只多出一个文件夹，不会散一堆文件。媒体库工具条另有「＋文件夹」按钮，随时建空目录。
- **目录也能删**：`/api/delete` 现在先按文件取对象，取不到再 `List` 判目录，命中目录就递归清空子项后 `Rmdir`（WebDAV 不支持递归删目录，直接删会报 `directory not empty`）。所以文件夹格子上的 × 能用。
- **分类与文件详情**：媒体库上方有「全部 / 图片 / 视频 / 文件」筛选条（带数量），按扩展名区分文档、压缩包、文本、安装包，各有图标与角标。点开非图片/视频会进文件详情页：类型、大小、时间、密文库内路径，以及「下载到本机」。
- **下载原名**：`GET /api/stream?path=&dl=1` 会加 `Content-Disposition: attachment`，同时给 ASCII 回退名和 `filename*=UTF-8''`，所以取回的是解密后的中文原名。安卓侧 WebView 不能把 cookie 交给系统下载器，Activity 自带 `DownloadListener`：带 cookie 重新请求网关，API 29+ 写入 MediaStore 的「下载」目录（`IS_PENDING` 两步落盘），更低版本写 App 外部下载目录，完成后 Toast 提示大小。
- **启动重试**：手机开机后 DNS / 网络常常比 App 晚就绪，首次 `/api/list` 很容易失败。启动流程改成 5 次退避重试（1.2s 起、每次 ×1 递增），失败才弹「列表加载失败」。
- **移动端细节**：`env(safe-area-inset-*)`、触控目标 ≥40px、删除按钮常显（手机没有 hover）、顶部/底部栏常驻，错误统一走底部 toast 而不是 `alert()` 打断操作。

### 2026-11-25 改版：打开更快、目录更清楚

- **网关端口固定**：进程内网关优先监听 `127.0.0.1:53511`，被占才退回随机口。WebView 的 origin 稳定后，`localStorage`、HTTP 缓存和上次所在目录才能真正跨进程留下来；此前每次启动换端口，等于每次都是「新网站」，主题和缓存全部丢失。
- **冷启动先画缓存**：列表按目录存进 `localStorage`（最多 8 个目录、每个 600 项），启动时不等 `/api/status` 和云端，先把上次那一屏画出来，再后台刷新；进过的目录带 8 秒内存缓存，来回翻不重新请求。
- **记住上次位置**：当前目录与每个目录的滚动位置都存本地，杀进程重开还停在原处；目录被删/改名导致列表 404 时自动退回根目录。
- **面包屑导航**：路径栏改成 `根目录 › 相册备份 › 2026-11`，每一级都能点，层级超过 4 级时省略中间段，窄屏横向滚动。
- **回前台不重载**：Activity 接管 `uiMode / density / fontScale / locale` 等配置变化，转屏、切深浅色都不重建 WebView；只有用户真正退出才停网关，系统回收界面后回来不用重新连。WebView 渲染进程若被杀，`onRenderProcessGone` 会就地重建并恢复同一地址。
- **主题记忆到原生**：手动切过的深浅色除了写 `localStorage`，还写进 SharedPreferences；冷启动时窗口底色、状态栏、WebView 底色先按记住的主题刷好，再加载页面，不再黑一下/白一下。跟随系统时不写死，系统换深浅色会同步跟。
- **静态资源缓存**：`/app.js`、`/style.css` 带内容哈希 ETag，未变更时回 304，冷启动少解析一遍；页头的 `backdrop-filter` 去掉，换实色，滚动时少一层 GPU 合成。

### 2026-11-26 改版：相册选择能看到内容

- **封面预览**：`AutoSync.albumsJson()` 在统计每个相册的同时，取该相册最新一张图的 112px 方图（`loadThumbnail`，API 29 以下走旧 Thumbnails 接口），压成 JPEG 后以 `data:` URL 返回；最多做 24 个，超出的相册用文件夹图标，避免设置页打开变慢（实测 2 个相册 28 ms）。
- **显示真实文件夹**：每个相册附带 `relative_path`（如 `DCIM/Camera`、`Pictures/截图`），选择卡片第二行显示「路径 · 数量」，同名的「相机」「截图」不会再认错。
- **选择界面改卡片网格**：不再是名称+数量的小胶囊，改成 46px 封面 + 名称 + 路径/数量 + 右上角勾选角标，窄屏两列。
- **备份文件夹**：沿用已有能力——「按相册名分文件夹：开」时，云端在同步目录（默认 `相册备份`）下按相册名建同名子文件夹；通讯录/短信/通话记录固定写 `通讯录/`、`短信/`、`通话记录/`。关掉后全部平铺在同步目录。
- **任意文件夹备份**：设置 → 备份 → 「＋ 添加文件夹」，用系统目录选择器（`ACTION_OPEN_DOCUMENT_TREE`）挑任意目录（下载、微信文件、Documents 等），`takePersistableUriPermission` 记住授权。`FolderSync` 用 `DocumentsContract` 递归遍历整棵目录树，按原层级上传到云端 `文件备份/<文件夹名>/`，文件名里的 `/ : \` 会清洗，超长名保留扩展名。
- **增量与上限**：每个目录先 `/api/list` 拿「文件名→大小」，同名同大小直接跳过，改了大小就覆盖重传；单次每个根目录最多 5000 个文件，超出的下一轮继续。上传仍走本机网关 `/api/upload`，保留原文件修改时间。
- **权限失效处理**：目录被删或授权被系统收回时，查询会返回空并提示「权限可能已失效，移除后重新添加」，不会静默当成功。

离线验证 UI（不依赖真实云盘与外网）：`scripts/ui-fixture.ps1` 用本机 `rclone serve webdav` 冒充云端，造 3000×2000 / 400×400 / 160×90 三个样本加密上传，再把设备配置指向 `http://10.0.2.2:5299`，即可在模拟器里检查网格、缩略图、切图与返回键；普通文件可用 zip / pdf 一并验证（设备端下载后 SHA256 与源文件一致）。测目录备份时注意：`rclone serve webdav` 必须带 `--baseurl /dav`（否则 `/dav` 会被当成云盘子目录，MKCOL/PUT 全报 409）；设备配置要显式写 `"backend": "webdav"`，否则会按默认的 `native`（139）走，报「尚未配置云端接入信息」。

## 已知边界

- 文件夹备份是单向的：手机新增/修改会传上去，手机上删除**不会**删云端；要清理得在网盘里手动删。同名文件大小变了会覆盖，内容变了但大小没变（极少见）会按「没变」跳过。
- 目录选择受系统 SAF 限制：`Android/data`、`Android/obb`、存储根目录选不了；部分厂商文件管理器返回的 URI 可能拿不到子目录，遇到就换系统「文件」选择器再选一次。
- 单个根目录一轮最多 5000 个文件，超大目录要分几轮传完；没有「排除某类文件」的规则，选整个微信目录会把缓存图片一起传。

- 普通文件只做「上传 / 列表 / 下载」，没有内嵌预览：取回后在系统文件管理器或对应 App 里打开。视频有首帧封面（WebView 解码首帧后画进 canvas，见上文），但封面只在渲染列表时按预算生成，超出预算的瓦片仍用格式角标。
- HEIC 不做缩略图（Go 标准库/`x-image` 里没有解码器），瓦片退回占位图标，点开仍可正常解密查看。
- 文件名是**确定性加密**：同名文件密文名相同，云端能看出"两个目录有同名文件"和目录树形状。这是 rclone 格式的固有代价。
- 文件长度（16 字节精度）和修改时间不加密，云端知道你存了多大、什么时候传的。
- 断点粒度 = 分片大小（500 MiB）；片内失败要整片重传。上传时会先落一份临时文件到本机（为了算 SHA256 与分片重传），所以本机磁盘要留出与待传文件等量的空间。
- 内置驱动只实现了个人云（`personal_new`）的读路径、上传、建目录、改名、删除；群组云、分享链接、秒传失败后的"覆盖同名"策略尚未接入。
- 云端上传速率受链路影响很大：同样 40 MB，顺畅时 13 s，拥塞时段 70～130 s（与 OpenList 轮路对照结果一致，不是驱动实现的问题）。
- 授权串是**单会话**语义：一端触发续期后，另一端手里的旧串可能失效（表现为「云端鉴权失败」）。
  多设备时把新串重新贴一次即可；客户端只在剩余不足 15 天时才会续期，所以平时很少碰到。
- 首次登录（手机号 + 短信验证码换授权串）还没内置：目前授权串从已登录的客户端/OpenList 里取一次即可，之后长期有效并能自动续期。
- 跨目录移动（MOVE 到另一个目录）返回 501；当前拓扑里 chunker 只做原地改名，用不到它。

## 许可证

本仓库以 MIT 许可发布，见 `LICENSE`。

第三方依赖：rclone（MIT，`crypt`/`chunker`/`webdav` 三个后端）、golang.org/x/mobile（BSD-3-Clause）。
云盘接口的行为参照了 OpenList 的对应驱动实现（AGPL-3.0），但本仓库中的客户端与 WebDAV 端点是独立编写的，
没有包含其源码；如果你要再分发本仓库，请自行评估你所在司法辖区的相关要求。


