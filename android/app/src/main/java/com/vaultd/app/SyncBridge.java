package com.vaultd.app;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.webkit.JavascriptInterface;

import org.json.JSONObject;

/**
 * 前端（同一个 WebView 里的设置面板）调原生自动同步的桥。
 * 只暴露「开关 / 目录 / 仅 Wi-Fi / 立即同步 / 授权」这几个动作。
 */
public class SyncBridge {
    private final MainActivity act;

    SyncBridge(MainActivity act) {
        this.act = act;
    }

    @JavascriptInterface
    public String state() {
        try {
            Context c = act;
            JSONObject o = new JSONObject();
            o.put("enabled", SyncPrefs.enabled(c));
            o.put("dir", SyncPrefs.dir(c));
            o.put("wifiOnly", SyncPrefs.wifiOnly(c));
            o.put("last", SyncPrefs.lastRun(c));
            o.put("result", SyncPrefs.lastResult(c));
            o.put("hasPermission", hasMediaPermission(c));
            o.put("gateway", !SyncPrefs.base(c).isEmpty());
            return o.toString();
        } catch (Exception e) {
            return "{\"error\":\"" + e.getMessage() + "\"}";
        }
    }

    @JavascriptInterface
    public String setEnabled(boolean on) {
        if (on && SyncPrefs.lastScanMark(act) == 0) {
            // 第一次打开：从现在开始算，别把几百张旧照片一次全传上去
            SyncPrefs.setLastScanMark(act, System.currentTimeMillis());
        }
        SyncPrefs.setEnabled(act, on);
        if (on) SyncService.start(act);
        else SyncService.stop(act);
        return state();
    }

    @JavascriptInterface
    public String setDir(String dir) {
        SyncPrefs.setDir(act, dir);
        return state();
    }

    @JavascriptInterface
    public String setWifiOnly(boolean on) {
        SyncPrefs.setWifiOnly(act, on);
        return state();
    }

    @JavascriptInterface
    public String syncNow() {
        new Thread(new Runnable() {
            @Override
            public void run() {
                String msg;
                try {
                    AutoSync.Result r = AutoSync.run(act);
                    msg = r.msg;
                } catch (Throwable t) {
                    msg = "同步异常：" + t.getMessage();
                }
                act.notifySyncUpdate(msg);
            }
        }).start();
        return state();
    }

    @JavascriptInterface
    public String requestPermissions() {
        act.requestMediaPermissions();
        return state();
    }

    static boolean hasMediaPermission(Context c) {
        if (Build.VERSION.SDK_INT >= 33) {
            return c.checkSelfPermission(Manifest.permission.READ_MEDIA_IMAGES) == PackageManager.PERMISSION_GRANTED;
        }
        return c.checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED;
    }
}
