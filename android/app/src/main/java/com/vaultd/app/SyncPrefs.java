package com.vaultd.app;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;

/** 自动同步的本地设置：开关、目标目录、仅 Wi-Fi、网关地址与 token。 */
public final class SyncPrefs {
    private static final String FILE = "vaultd-sync";

    private SyncPrefs() {}

    static SharedPreferences p(Context c) {
        return c.getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    public static boolean enabled(Context c) {
        return p(c).getBoolean("enabled", false);
    }

    public static void setEnabled(Context c, boolean v) {
        p(c).edit().putBoolean("enabled", v).apply();
    }

    public static String dir(Context c) {
        String d = p(c).getString("dir", "相册备份");
        return d == null || d.trim().isEmpty() ? "相册备份" : d.trim();
    }

    public static void setDir(Context c, String v) {
        p(c).edit().putString("dir", v == null ? "" : v.trim()).apply();
    }

    public static boolean wifiOnly(Context c) {
        return p(c).getBoolean("wifi_only", false);
    }

    public static void setWifiOnly(Context c, boolean v) {
        p(c).edit().putBoolean("wifi_only", v).apply();
    }

    public static String base(Context c) {
        return p(c).getString("base", "");
    }

    public static String token(Context c) {
        return p(c).getString("token", "");
    }

    /** 网关起来了就把地址和 token 记住，服务里自己拼请求。 */
    public static void setGateway(Context c, String base, String token) {
        p(c).edit().putString("base", base).putString("token", token).apply();
    }

    public static long lastRun(Context c) {
        return p(c).getLong("last_run", 0L);
    }

    public static void setLastRun(Context c, long v) {
        p(c).edit().putLong("last_run", v).apply();
    }

    public static String lastResult(Context c) {
        return p(c).getString("last_result", "");
    }

    public static void setLastResult(Context c, String v) {
        p(c).edit().putString("last_result", v == null ? "" : v).apply();
    }

    public static long lastScanMark(Context c) {
        return p(c).getLong("last_scan_ms", 0L);
    }

    public static void setLastScanMark(Context c, long v) {
        p(c).edit().putLong("last_scan_ms", v).apply();
    }

    // ---- 正在同步时的实时进度：前端每 1.5 秒读一次，画成底部浮条 ----
    static void setProgress(Context c, boolean running, int done, int total, String current) {
        p(c).edit()
                .putBoolean("pg_running", running)
                .putInt("pg_done", done)
                .putInt("pg_total", total)
                .putString("pg_current", current == null ? "" : current)
                .apply();
    }

    static String progressJson(Context c) {
        JSONObject o = new JSONObject();
        try {
            o.put("running", progressRunning(c));
            o.put("done", progressDone(c));
            o.put("total", progressTotal(c));
            o.put("current", progressCurrent(c));
            o.put("enabled", enabled(c));
        } catch (Exception ignore) {
        }
        return o.toString();
    }

    static boolean progressRunning(Context c) { return p(c).getBoolean("pg_running", false); }
    static int progressDone(Context c) { return p(c).getInt("pg_done", 0); }
    static int progressTotal(Context c) { return p(c).getInt("pg_total", 0); }
    static String progressCurrent(Context c) { return p(c).getString("pg_current", ""); }

    /** 要备份的相册名列表（JSON 数组字符串）；空数组表示「全部相册」。 */
    public static String albums(Context c) {
        String v = p(c).getString("albums", "[]");
        return v == null || v.trim().isEmpty() ? "[]" : v;
    }

    public static void setAlbums(Context c, String json) {
        p(c).edit().putString("albums", json == null ? "[]" : json).apply();
    }

    /** 上传时是否用「相册名」当子文件夹，保留原来的相册结构。 */
    public static boolean keepAlbum(Context c) {
        return p(c).getBoolean("keep_album", true);
    }

    public static void setKeepAlbum(Context c, boolean v) {
        p(c).edit().putBoolean("keep_album", v).apply();
    }

    /** 任意文件夹备份：用户在系统目录选择器里挑的目录（JSON 数组：[{uri,name}]）。 */
    public static String folders(Context c) {
        String v = p(c).getString("folders", "[]");
        return v == null || v.trim().isEmpty() ? "[]" : v;
    }

    public static void setFolders(Context c, String json) {
        p(c).edit().putString("folders", json == null ? "[]" : json).apply();
    }

    /** 任意文件夹备份在云端放的顶层目录。 */
    public static String folderDir(Context c) {
        String v = p(c).getString("folder_dir", "文件备份");
        return v == null || v.trim().isEmpty() ? "文件备份" : v.trim();
    }

    // ---- 通讯录 / 短信 / 通话记录：开关 + 当天快照的哈希（内容没变就不重复上传） ----
    public static boolean contacts(Context c) { return p(c).getBoolean("sync_contacts", false); }
    public static void setContacts(Context c, boolean v) { p(c).edit().putBoolean("sync_contacts", v).apply(); }

    public static boolean sms(Context c) { return p(c).getBoolean("sync_sms", false); }
    public static void setSms(Context c, boolean v) { p(c).edit().putBoolean("sync_sms", v).apply(); }

    public static boolean calls(Context c) { return p(c).getBoolean("sync_calls", false); }
    public static void setCalls(Context c, boolean v) { p(c).edit().putBoolean("sync_calls", v).apply(); }

    /** 界面主题：""=跟随系统，light / dark=用户手动选过。 */
    public static String theme(Context c) {
        String v = p(c).getString("theme", "");
        return v == null ? "" : v;
    }

    public static void setTheme(Context c, String v) {
        p(c).edit().putString("theme", v == null ? "" : v).apply();
    }

    public static String lastDigest(Context c, String key) {
        String v = p(c).getString(key, "");
        return v == null ? "" : v;
    }

    public static String lastDigestDay(Context c, String key) {
        String v = p(c).getString(key + "_day", "");
        return v == null ? "" : v;
    }

    public static void setLastDigest(Context c, String key, String digest, String day) {
        p(c).edit().putString(key, digest).putString(key + "_day", day).apply();
    }
}
