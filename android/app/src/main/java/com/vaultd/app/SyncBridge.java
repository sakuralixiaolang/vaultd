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
            o.put("keepAlbum", SyncPrefs.keepAlbum(c));
            o.put("albums", new org.json.JSONArray(SyncPrefs.albums(c)));
            o.put("folders", FolderSync.list(c));
            o.put("folderDir", SyncPrefs.folderDir(c));
            o.put("contacts", SyncPrefs.contacts(c));
            o.put("sms", SyncPrefs.sms(c));
            o.put("calls", SyncPrefs.calls(c));
            o.put("hasContacts", has(c, Manifest.permission.READ_CONTACTS));
            o.put("hasSms", has(c, Manifest.permission.READ_SMS));
            o.put("hasCalls", has(c, Manifest.permission.READ_CALL_LOG));
            o.put("running", SyncPrefs.progressRunning(c));
            o.put("done", SyncPrefs.progressDone(c));
            o.put("total", SyncPrefs.progressTotal(c));
            o.put("current", SyncPrefs.progressCurrent(c));
            return o.toString();
        } catch (Exception e) {
            return "{\"error\":\"" + e.getMessage() + "\"}";
        }
    }

    /** 只读同步进度，1.5 秒轮询一次，别把相册清单和文件夹列表整包搬来搬去。 */
    @JavascriptInterface
    public String progress() {
        return SyncPrefs.progressJson(act);
    }

    private static boolean has(Context c, String perm) {
        try {
            return c.checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED;
        } catch (Exception e) {
            return false;
        }
    }

    @JavascriptInterface
    public String setContacts(boolean on) {
        SyncPrefs.setContacts(act, on);
        return state();
    }

    @JavascriptInterface
    public String setSms(boolean on) {
        SyncPrefs.setSms(act, on);
        return state();
    }

    @JavascriptInterface
    public String setCalls(boolean on) {
        SyncPrefs.setCalls(act, on);
        return state();
    }

    /** 系统里有哪些相册（带文件数量），给设置面板勾选备份范围。 */
    @JavascriptInterface
    public String albums() {
        if (!hasMediaPermission(act)) return "[]";
        try {
            return AutoSync.albumsJson(act, new AutoSync.CoverListener() {
                @Override
                public void onCover(String album, String dataUrl) {
                    act.pushAlbumCover(album, dataUrl);
                }
            });
        } catch (Throwable t) {
            return "[]";
        }
    }

    /** 传 JSON 数组字符串，比如 ["Camera","WeiXin"]；传 [] 表示全部相册。 */
    @JavascriptInterface
    public String setAlbums(String json) {
        try {
            org.json.JSONArray arr = new org.json.JSONArray(json);
            org.json.JSONArray out = new org.json.JSONArray();
            for (int i = 0; i < arr.length(); i++) {
                String s = arr.optString(i, "").trim();
                if (!s.isEmpty()) out.put(s);
            }
            SyncPrefs.setAlbums(act, out.toString());
        } catch (Exception ignore) {
        }
        return state();
    }

    @JavascriptInterface
    public String setKeepAlbum(boolean on) {
        SyncPrefs.setKeepAlbum(act, on);
        return state();
    }

    /** 拉起系统目录选择器；选完在 onActivityResult 里记下，下次同步自动带上。 */
    @JavascriptInterface
    public String pickFolder() {
        act.pickFolder();
        return state();
    }

    @JavascriptInterface
    public String removeFolder(String uri) {
        FolderSync.removeFolder(act, uri == null ? "" : uri);
        return state();
    }

    @JavascriptInterface
    public String getTheme() {
        return SyncPrefs.theme(act);
    }

    /** 前端切主题时顺手写进原生设置：下次冷启动的窗口底色就不会闪。 */
    @JavascriptInterface
    public String setTheme(String t) {
        String v = "light".equals(t) || "dark".equals(t) ? t : "";
        SyncPrefs.setTheme(act, v);
        act.applyThemeNow(v);
        return v;
    }

    @JavascriptInterface
    public String setEnabled(boolean on) {
        SyncPrefs.setEnabled(act, on);
        if (on) {
            // 刚开启时由服务跑一轮「全量补齐」，把相册里已有、云端还没有的照片补上。
            SyncPrefs.setProgress(act, true, 0, 0, "正在检查新照片…");
            SyncService.start(act);
        } else {
            SyncService.stop(act);
            SyncPrefs.setProgress(act, false, 0, 0, "");
        }
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
        SyncPrefs.setProgress(act, true, 0, 0, "正在检查新照片…");
        new Thread(new Runnable() {
            @Override
            public void run() {
                String msg;
                try {
                    AutoSync.Result r = AutoSync.run(act, true);
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
