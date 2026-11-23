package com.vaultd.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

/**
 * 单 Activity：进程内起 Go 网关（rclone crypt + chunker + WebDAV），
 * WebView 只加载 127.0.0.1 上的同一个前端。加解密全部在 Go 里完成，
 * Java 侧不含任何密码学代码。
 */
public class MainActivity extends Activity {

    private static final int REQ_FILE = 1001;

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // 本构建为调试包：打开 WebView 调试端口，便于 adb 侧排查（正式包会关掉）。
        WebView.setWebContentsDebuggingEnabled(true);
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        web.setWebViewClient(new WebViewClient());
        web.setWebChromeClient(new WebChromeClient() {
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

        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    final String url = mobile.Mobile.start(
                            getFilesDir().getAbsolutePath());
                    android.util.Log.i("vaultd", "gateway ready: " + url);
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            web.loadUrl(url);
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

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
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

    private void handleBack() {
        // 页面内的层级（查看器、子目录）由前端接管；前端返回 false 表示已在根目录，再退出。
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

    @Override
    protected void onDestroy() {
        try {
            mobile.Mobile.stop();
        } catch (Exception ignored) {
        }
        if (web != null) {
            web.destroy();
        }
        super.onDestroy();
    }
}

