package com.vaultd.app;

import android.content.Context;
import android.content.SharedPreferences;

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
}
