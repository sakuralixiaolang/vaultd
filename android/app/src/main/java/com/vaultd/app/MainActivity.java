package com.vaultd.app;

import android.Manifest;
import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.database.Cursor;
import android.graphics.drawable.ColorDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URLDecoder;
import java.net.URL;

/**
 * 单 Activity：进程内起 Go 网关（rclone crypt + chunker + WebDAV），
 * WebView 只加载 127.0.0.1 上的同一个前端。加解密全部在 Go 里完成，
 * Java 侧不含任何密码学代码。
 */
public class MainActivity extends Activity {

    private static final int REQ_FILE = 1001;
    private static final int REQ_MEDIA = 1002;
    private static final int REQ_DIR = 1003;

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private String gatewayUrl;
    private boolean webReady;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // 本构建为调试包：打开 WebView 调试端口，便于 adb 侧排查（正式包会关掉）。
        WebView.setWebContentsDebuggingEnabled(true);
        // 先把窗口底色刷成当前主题色：WebView 还没画出第一帧时不会黑一下/白一下。
        applyWindowTheme(null);
        web = buildWeb();
        setContentView(web);

        // targetSdk 33+ 的系统默认走「预测性返回」回调，onBackPressed 根本不会被调用，
        // 所以要显式注册 OnBackInvokedCallback；老系统仍走 onBackPressed。
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT,
                    new android.window.OnBackInvokedCallback() {
                        @Override
                        public void onBackInvoked() {
                            handleBack();
                        }
                    });
        }

        loadGateway();
    }

    /** 建一个 WebView：所有配置集中在这里，渲染进程崩了也能用同一份配置重建。 */
    private WebView buildWeb() {
        WebView w = new WebView(this);
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        // 布局宽度锁在「设备宽度」而不是系统放大后的宽度：
        // 有些机型的系统字体/显示缩放会让 WebView 的 layout width 变成 800+，
        // 界面就会突然像平板。这里关掉 wide viewport，并把字号缩放固定回 100%。
        s.setUseWideViewPort(false);
        s.setLoadWithOverviewMode(false);
        s.setTextZoom(100);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        w.setBackgroundColor(themeBg(null));
        w.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                webReady = true;
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                if (Build.VERSION.SDK_INT < 26) return false;
                android.util.Log.e("vaultd", "WebView 渲染进程退出，crash=" + detail.didCrash());
                try {
                    ViewGroup parent = (ViewGroup) view.getParent();
                    if (parent != null) parent.removeView(view);
                    view.destroy();
                } catch (Throwable ignored) {
                }
                web = buildWeb();
                setContentView(web);
                if (gatewayUrl != null && gatewayUrl.length() > 0) {
                    web.loadUrl(gatewayUrl);
                } else {
                    loadGateway();
                }
                Toast.makeText(MainActivity.this, "界面已恢复", Toast.LENGTH_SHORT).show();
                return true; // 已自行重建，系统别再杀进程
            }
        });
        w.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (fileCallback != null) {
                    fileCallback.onReceiveValue(null);
                }
                fileCallback = callback;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try {
                    startActivityForResult(Intent.createChooser(i, "选择文件"), REQ_FILE);
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });

        // 设置面板里的「相册自动同步」直接调原生（扫描 MediaStore + 前台服务）
        w.addJavascriptInterface(new SyncBridge(this), "Sync");

        // 普通文件（文档/压缩包/安装包）要能取回：网关是带 cookie 的本地 http，
        // 系统下载器不带 cookie 会 401，所以这里自己拿 InputStream 落盘。
        CookieManager.getInstance().setAcceptCookie(true);
        w.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition,
                                        String mimetype, long contentLength) {
                downloadFile(url, contentDisposition, mimetype);
            }
        });
        return w;
    }

    private void loadGateway() {
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    final String url = mobile.Mobile.start(
                            getFilesDir().getAbsolutePath());
                    gatewayUrl = url;
                    android.util.Log.i("vaultd", "gateway ready: " + url);
                    rememberGateway(url);
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            if (web == null) return;
                            web.loadUrl(url);
                            if (SyncPrefs.enabled(MainActivity.this)) {
                                SyncService.start(MainActivity.this);
                            }
                        }
                    });
                } catch (final Exception e) {
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            showError(e);
                        }
                    });
                }
            }
        }).start();
    }

    // ---------- 下载：把网关解出来的明文写到系统「下载」目录 ----------

    private void downloadFile(final String url, final String disposition, final String mimetype) {
        if (url == null || (!url.startsWith("http://127.0.0.1") && !url.startsWith("http://localhost"))) {
            Toast.makeText(this, "只支持从本机网关下载", Toast.LENGTH_SHORT).show();
            return;
        }
        final String name = safeName(fileNameFrom(disposition, url));
        Toast.makeText(this, "开始下载 " + name, Toast.LENGTH_SHORT).show();
        new Thread(new Runnable() {
            @Override
            public void run() {
                HttpURLConnection conn = null;
                InputStream in = null;
                OutputStream out = null;
                Uri pending = null;
                try {
                    conn = (HttpURLConnection) new URL(url).openConnection();
                    String cookie = CookieManager.getInstance().getCookie(url);
                    if (cookie != null && cookie.length() > 0) {
                        conn.setRequestProperty("Cookie", cookie);
                    }
                    conn.setConnectTimeout(15000);
                    conn.setReadTimeout(600000);
                    int code = conn.getResponseCode();
                    if (code != 200 && code != 206) {
                        throw new IOException("HTTP " + code);
                    }
                    in = conn.getInputStream();
                    final String mime = (mimetype == null || mimetype.length() == 0)
                            ? "application/octet-stream" : mimetype;
                    if (Build.VERSION.SDK_INT >= 29) {
                        ContentValues v = new ContentValues();
                        v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                        v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                        v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                        v.put(MediaStore.MediaColumns.IS_PENDING, 1);
                        pending = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                        if (pending == null) {
                            throw new IOException("无法创建下载文件");
                        }
                        out = getContentResolver().openOutputStream(pending);
                    } else {
                        File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                        if (dir == null) {
                            dir = getFilesDir();
                        }
                        if (!dir.exists()) {
                            dir.mkdirs();
                        }
                        out = new FileOutputStream(new File(dir, name));
                    }
                    byte[] buf = new byte[64 * 1024];
                    long total = 0;
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                        total += n;
                    }
                    out.flush();
                    if (pending != null) {
                        ContentValues done = new ContentValues();
                        done.put(MediaStore.MediaColumns.IS_PENDING, 0);
                        getContentResolver().update(pending, done, null, null);
                    }
                    final long size = total;
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            Toast.makeText(MainActivity.this,
                                    "已保存到「下载」：" + name + "（" + human(size) + "）",
                                    Toast.LENGTH_LONG).show();
                        }
                    });
                } catch (final Exception e) {
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            Toast.makeText(MainActivity.this, "下载失败：" + e.getMessage(),
                                    Toast.LENGTH_LONG).show();
                        }
                    });
                } finally {
                    closeQuietly(in);
                    closeQuietly(out);
                    if (conn != null) {
                        conn.disconnect();
                    }
                }
            }
        }).start();
    }

    private static void closeQuietly(java.io.Closeable c) {
        if (c != null) {
            try {
                c.close();
            } catch (Exception ignored) {
            }
        }
    }

    // 优先用服务端的 filename*=UTF-8''（解密后的原名），退回 URL 里的 path 参数
    private String fileNameFrom(String disposition, String url) {
        try {
            if (disposition != null) {
                int i = disposition.indexOf("filename*=UTF-8''");
                if (i >= 0) {
                    String tail = disposition.substring(i + 17);
                    int semi = tail.indexOf(';');
                    if (semi >= 0) {
                        tail = tail.substring(0, semi);
                    }
                    return URLDecoder.decode(tail.trim().replace("\"", ""), "UTF-8");
                }
                i = disposition.indexOf("filename=");
                if (i >= 0) {
                    return disposition.substring(i + 9).trim().replace("\"", "");
                }
            }
            String p = Uri.parse(url).getQueryParameter("path");
            if (p != null && p.length() > 0) {
                return p.substring(p.lastIndexOf('/') + 1);
            }
        } catch (Exception ignored) {
        }
        return "download.bin";
    }

    private String safeName(String raw) {
        String n = raw == null ? "" : raw.replace('\\', '_').replace('/', '_').trim();
        while (n.startsWith(".")) {
            n = n.substring(1);
        }
        return n.length() == 0 ? "download.bin" : n;
    }

    private static String human(long n) {
        if (n < 1024) return n + " B";
        String[] u = {"KB", "MB", "GB", "TB"};
        double v = n;
        int i = -1;
        do {
            v /= 1024;
            i++;
        } while (v >= 1024 && i < u.length - 1);
        return String.format(java.util.Locale.US, v >= 10 ? "%.0f %s" : "%.1f %s", v, u[i]);
    }

    private void showError(Exception e) {
        TextView tv = new TextView(this);
        tv.setText("启动失败：" + e.getMessage()
                + "\n\n请确认 APK 与设备 ABI 匹配（当前仅 arm64-v8a）。");
        tv.setTextSize(16);
        tv.setPadding(48, 96, 48, 48);
        FrameLayout box = new FrameLayout(this);
        box.addView(tv, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        setContentView(box);
    }

    /** 设置面板里的「添加文件夹」：拉起系统目录选择器，选完整棵目录递归备份。 */
    void pickFolder() {
        try {
            Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                    | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
                    | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
            startActivityForResult(i, REQ_DIR);
        } catch (Exception e) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    Toast.makeText(MainActivity.this, "打不开目录选择器：" + e.getMessage(),
                            Toast.LENGTH_LONG).show();
                }
            });
        }
    }

    /** SAF 只给 URI，名字要再查一次 DocumentsContract。 */
    private String treeName(Uri tree) {
        Cursor c = null;
        try {
            Uri doc = android.provider.DocumentsContract.buildDocumentUriUsingTree(
                    tree, android.provider.DocumentsContract.getTreeDocumentId(tree));
            c = getContentResolver().query(doc,
                    new String[]{android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME},
                    null, null, null);
            if (c != null && c.moveToFirst()) {
                String n = c.getString(0);
                if (n != null && !n.trim().isEmpty()) return n.trim();
            }
        } catch (Exception ignore) {
        } finally {
            if (c != null) c.close();
        }
        return "文件夹";
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_DIR) {
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                Uri uri = data.getData();
                try {
                    getContentResolver().takePersistableUriPermission(uri,
                            Intent.FLAG_GRANT_READ_URI_PERMISSION);
                } catch (Exception ignore) {
                }
                String name = treeName(uri);
                FolderSync.addFolder(this, uri, name);
                notifySyncUpdate("已添加文件夹：" + name);
            }
            return;
        }
        if (requestCode == REQ_FILE) {
            if (fileCallback == null) {
                super.onActivityResult(requestCode, resultCode, data);
                return;
            }
            Uri[] uris = null;
            if (resultCode == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int n = data.getClipData().getItemCount();
                    uris = new Uri[n];
                    for (int k = 0; k < n; k++) {
                        uris[k] = data.getClipData().getItemAt(k).getUri();
                    }
                } else if (data.getData() != null) {
                    uris = new Uri[]{data.getData()};
                }
            }
            fileCallback.onReceiveValue(uris);
            fileCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    // ---------- 自动同步：网关地址交给服务，结果回吐给设置面板 ----------

    private void rememberGateway(String url) {
        try {
            Uri u = Uri.parse(url);
            String base = u.getScheme() + "://" + u.getHost() + ":" + u.getPort();
            String token = u.getQueryParameter("t");
            if (token != null && !token.isEmpty()) {
                SyncPrefs.setGateway(this, base, token);
            }
        } catch (Exception ignored) {
        }
    }

    void notifySyncUpdate(String msg) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (web == null) return;
                web.evaluateJavascript("(window.onSyncUpdate && window.onSyncUpdate(" + jsStr(msg) + "))", null);
            }
        });
    }

    private static String jsStr(String s) {
        if (s == null) return "null";
        StringBuilder b = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            switch (ch) {
                case '"': b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                default:
                    if (ch < 0x20) b.append(String.format("\\u%04x", (int) ch));
                    else b.append(ch);
            }
        }
        return b.append('"').toString();
    }

    void requestMediaPermissions() {
        List<String> perms = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= 33) {
            perms.add(Manifest.permission.READ_MEDIA_IMAGES);
            perms.add(Manifest.permission.READ_MEDIA_VIDEO);
        } else {
            perms.add(Manifest.permission.READ_EXTERNAL_STORAGE);
        }
        perms.add(Manifest.permission.READ_CONTACTS);
        perms.add(Manifest.permission.READ_SMS);
        perms.add(Manifest.permission.READ_CALL_LOG);
        try {
            requestPermissions(perms.toArray(new String[0]), REQ_MEDIA);
        } catch (Exception ignored) {
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode == REQ_MEDIA) {
            notifySyncUpdate(SyncBridge.hasMediaPermission(this) ? "已获得相册权限" : "还没有相册权限");
            return;
        }
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    }

    private void handleBack() {        // 页面内的层级（查看器、子目录）由前端接管；前端返回 false 表示已在根目录，再退出。
        if (web == null) {
            finish();
            return;
        }
        web.evaluateJavascript(
                "(window.vaultdBack && window.vaultdBack()) ? 'true' : 'false'",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        if (!(value != null && value.contains("true"))) {
                            finish();
                        }
                    }
                });
    }

    @Override
    public void onBackPressed() {
        handleBack();
    }

    // ---------- 主题：窗口底色与前端保持一致，冷启动不闪 ----------

    private boolean darkTheme(String override) {
        String t = override != null ? override : SyncPrefs.theme(this);
        if ("dark".equals(t)) return true;
        if ("light".equals(t)) return false;
        int mode = getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        return mode != Configuration.UI_MODE_NIGHT_NO;
    }

    private int themeBg(String override) {
        return darkTheme(override) ? 0xFF0F1419 : 0xFFF2F5F8;
    }

    private void applyWindowTheme(String override) {
        int bg = themeBg(override);
        getWindow().setBackgroundDrawable(new ColorDrawable(bg));
        getWindow().setStatusBarColor(bg);
        getWindow().setNavigationBarColor(bg);
        if (Build.VERSION.SDK_INT >= 23) {
            int vis = getWindow().getDecorView().getSystemUiVisibility();
            if (darkTheme(override)) vis &= ~android.view.View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            else vis |= android.view.View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            getWindow().getDecorView().setSystemUiVisibility(vis);
        }
    }

    /** 前端切主题时调用：窗口、状态栏、WebView 底色一起换，并写进原生设置。 */
    void applyThemeNow(final String t) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                applyWindowTheme(t);
                if (web != null) web.setBackgroundColor(themeBg(t));
            }
        });
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        // 系统深浅色变了且用户没手动选过：窗口与页面一起跟着换，不重建 Activity。
        applyWindowTheme(null);
        if (web != null) {
            web.setBackgroundColor(themeBg(null));
            if (SyncPrefs.theme(this).isEmpty()) {
                web.evaluateJavascript("(window.vaultdThemeFromSystem && window.vaultdThemeFromSystem())", null);
            }
        }
    }

    @Override
    protected void onDestroy() {
        try {
            // 只有用户真正退出（而不是转屏/分屏重建）才停网关；
            // 系统因内存回收重建界面时保持网关活着，回来不用重新连。
            if (isFinishing() && !SyncPrefs.enabled(this)) mobile.Mobile.stop();
        } catch (Exception ignored) {
        }
        if (web != null) {
            web.destroy();
        }
        super.onDestroy();
    }
}

