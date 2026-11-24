package com.vaultd.app;

import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Context;
import android.database.Cursor;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.provider.MediaStore;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * 相册自动同步的干活部分：扫系统媒体库最近的相机/相册新文件，
 * 通过本机网关（同一个加密管线）传到密文库的指定目录。
 * 纯原生实现，App 不在前台也能跑（前台服务里调用）。
 */
public final class AutoSync {

    public static final class Result {
        public int uploaded;
        public int skipped;
        public int failed;
        public boolean ok;
        public String msg = "";
    }

    private static final class Item {
        Uri uri;
        String name;
        String album;
        long size;
        long mtime;
    }

    private AutoSync() {}

    public static Result run(Context ctx) {
        Result r = new Result();
        String base = SyncPrefs.base(ctx);
        String token = SyncPrefs.token(ctx);
        if (base.isEmpty() || token.isEmpty()) {
            r.msg = "网关还没起来，先打开 App 一次";
            return r;
        }
        if (SyncPrefs.wifiOnly(ctx) && !isWifi(ctx)) {
            r.ok = true;
            r.msg = "仅 Wi-Fi：当前是流量，跳过这一轮";
            SyncPrefs.setLastResult(ctx, r.msg + " · " + now());
            SyncPrefs.setLastRun(ctx, System.currentTimeMillis());
            return r;
        }
        String dir = SyncPrefs.dir(ctx);
        boolean keepAlbum = SyncPrefs.keepAlbum(ctx);
        try {
            Map<String, Set<String>> remote = new HashMap<>();
            List<Item> items = scan(ctx);
            for (Item it : items) {
                // 云端按「相册名」分子文件夹，保留手机上原来的相册结构。
                String folder = keepAlbum ? join(dir, it.album) : dir;
                Set<String> names = remote.get(folder);
                if (names == null) {
                    ensureDir(base, token, folder);
                    names = remoteNames(base, token, folder);
                    remote.put(folder, names);
                }
                if (!names.add(it.name)) {
                    r.skipped++;
                    continue;
                }
                try {
                    upload(base, token, folder, it, ctx);
                    r.uploaded++;
                } catch (Exception e) {
                    names.remove(it.name); // 失败了下一轮还得重试
                    r.failed++;
                    r.msg = it.name + " 失败：" + e.getMessage();
                }
            }
            SyncPrefs.setLastScanMark(ctx, System.currentTimeMillis());
            SyncPrefs.setLastRun(ctx, System.currentTimeMillis());
            r.ok = r.failed == 0;
            r.msg = "上传 " + r.uploaded + " · 跳过 " + r.skipped + (r.failed > 0 ? " · 失败 " + r.failed : "");
            SyncPrefs.setLastResult(ctx, r.msg + " · " + now());
        } catch (Exception e) {
            r.ok = false;
            r.msg = "同步失败：" + e.getMessage();
            SyncPrefs.setLastResult(ctx, r.msg + " · " + now());
            SyncPrefs.setLastRun(ctx, System.currentTimeMillis());
        }
        return r;
    }

    private static String now() {
        return new SimpleDateFormat("MM-dd HH:mm", Locale.US).format(new Date());
    }

    private static boolean isWifi(Context ctx) {
        try {
            ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return false;
            Network n = cm.getActiveNetwork();
            if (n == null) return false;
            NetworkCapabilities cap = cm.getNetworkCapabilities(n);
            return cap != null && cap.hasTransport(NetworkCapabilities.TRANSPORT_WIFI);
        } catch (Exception e) {
            return false;
        }
    }

    /** 只扫相机/相册目录（DCIM、Pictures、Movies），避免把下载目录里的东西也备份上去。 */
    private static List<Item> scan(Context ctx) {
        List<Item> out = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        Set<String> picked = selectedAlbums(ctx);
        long since = SyncPrefs.lastScanMark(ctx);
        if (since > 0) since -= 3L * 3600_000L; // 回看 3 小时，防止刚好卡在边界
        String[] proj = {
                MediaStore.MediaColumns._ID,
                MediaStore.MediaColumns.DISPLAY_NAME,
                MediaStore.MediaColumns.SIZE,
                MediaStore.MediaColumns.DATE_MODIFIED,
                "bucket_display_name",
                "bucket_id",
        };
        String[] tables = {"images", "video"};
        for (String t : tables) {
            Uri table = "images".equals(t)
                    ? MediaStore.Images.Media.EXTERNAL_CONTENT_URI
                    : MediaStore.Video.Media.EXTERNAL_CONTENT_URI;
            StringBuilder sel = new StringBuilder();
            List<String> args = new ArrayList<>();
            if (since > 0) {
                sel.append(MediaStore.MediaColumns.DATE_MODIFIED).append(">=?");
                args.add(String.valueOf(since / 1000L));
            }
            String pathCol = "relative_path";
            if (android.os.Build.VERSION.SDK_INT >= 29) {
                if (sel.length() > 0) sel.append(" AND ");
                sel.append("(").append(pathCol).append(" LIKE 'DCIM/%' OR ")
                        .append(pathCol).append(" LIKE 'Pictures/%' OR ")
                        .append(pathCol).append(" LIKE 'Movies/%')");
            }
            Cursor c = null;
            try {
                ContentResolver cr = ctx.getContentResolver();
                c = cr.query(table, proj, sel.length() > 0 ? sel.toString() : null,
                        args.isEmpty() ? null : args.toArray(new String[0]),
                        MediaStore.MediaColumns.DATE_MODIFIED + " DESC");
                if (c == null) continue;
                int idI = c.getColumnIndex(MediaStore.MediaColumns._ID);
                int nameI = c.getColumnIndex(MediaStore.MediaColumns.DISPLAY_NAME);
                int sizeI = c.getColumnIndex(MediaStore.MediaColumns.SIZE);
                int mtI = c.getColumnIndex(MediaStore.MediaColumns.DATE_MODIFIED);
                int bkI = c.getColumnIndex("bucket_display_name");
                int bkIdI = c.getColumnIndex("bucket_id");
                while (c.moveToNext() && out.size() < 300) {
                    String name = nameI >= 0 ? c.getString(nameI) : null;
                    if (name == null || name.isEmpty()) continue;
                    String album = "";
                    if (bkI >= 0) album = c.getString(bkI);
                    if (album == null || album.trim().isEmpty()) {
                        album = bkIdI >= 0 ? ("相册" + c.getString(bkIdI)) : "其他";
                    }
                    album = safeName(album);
                    // 用户勾了具体相册就只备份这些；没勾（空）表示全部相册。
                    if (!picked.isEmpty() && !picked.contains(album)) continue;
                    long size = sizeI >= 0 ? c.getLong(sizeI) : 0;
                    if (size <= 0) continue;
                    long mt = mtI >= 0 ? c.getLong(mtI) : 0;
                    long id = idI >= 0 ? c.getLong(idI) : 0;
                    if (!seen.add(album + "/" + name)) continue;
                    Item it = new Item();
                    it.uri = ContentUris.withAppendedId(table, id);
                    it.name = name;
                    it.album = album;
                    it.size = size;
                    it.mtime = mt > 0 ? mt : System.currentTimeMillis() / 1000L;
                    out.add(it);
                }
            } catch (Exception ignore) {
                // 没权限 / 该表不存在时静默跳过，交给 UI 提示去授权
            } finally {
                if (c != null) c.close();
            }
        }
        return out;
    }

    /** 相册名当文件夹用，把路径分隔符之类的不合法字符洗掉。 */
    private static String safeName(String s) {
        if (s == null) return "其他";
        String v = s.replace('/', '_').replace('\\', '_').replace(':', '_').trim();
        if (v.isEmpty() || v.equals(".") || v.equals("..")) return "其他";
        if (v.length() > 60) v = v.substring(0, 60);
        return v;
    }

    private static String join(String base, String sub) {
        if (sub == null || sub.trim().isEmpty()) return base;
        if (!base.endsWith("/")) base += "/";
        return base + sub;
    }

    /** 系统相册清单：给设置面板勾选用；count 是该相册里的图片+视频数量。 */
    public static String albumsJson(Context ctx) {
        Map<String, Integer> count = new HashMap<>();
        String[] tables = {"images", "video"};
        for (String t : tables) {
            Uri table = "images".equals(t)
                    ? MediaStore.Images.Media.EXTERNAL_CONTENT_URI
                    : MediaStore.Video.Media.EXTERNAL_CONTENT_URI;
            Cursor c = null;
            try {
                c = ctx.getContentResolver().query(table,
                        new String[]{"bucket_display_name", "bucket_id", MediaStore.MediaColumns.SIZE},
                        null, null, MediaStore.MediaColumns.DATE_MODIFIED + " DESC");
                if (c == null) continue;
                int bkI = c.getColumnIndex("bucket_display_name");
                int bkIdI = c.getColumnIndex("bucket_id");
                int sizeI = c.getColumnIndex(MediaStore.MediaColumns.SIZE);
                int rows = 0;
                while (c.moveToNext() && rows++ < 20000) {
                    if (sizeI >= 0 && c.getLong(sizeI) <= 0) continue;
                    String album = bkI >= 0 ? c.getString(bkI) : null;
                    if (album == null || album.trim().isEmpty()) {
                        album = bkIdI >= 0 ? ("相册" + c.getString(bkIdI)) : "其他";
                    }
                    album = safeName(album);
                    Integer n = count.get(album);
                    count.put(album, n == null ? 1 : n + 1);
                }
            } catch (Exception ignore) {
            } finally {
                if (c != null) c.close();
            }
        }
        List<Map.Entry<String, Integer>> list = new ArrayList<>(count.entrySet());
        list.sort((a, b) -> b.getValue() - a.getValue());
        JSONArray arr = new JSONArray();
        for (Map.Entry<String, Integer> e : list) {
            JSONObject o = new JSONObject();
            try {
                o.put("name", e.getKey());
                o.put("count", e.getValue());
                arr.put(o);
            } catch (Exception ignore) {
            }
        }
        return arr.toString();
    }

    /** 已勾选的相册（空 = 全部）。 */
    public static Set<String> selectedAlbums(Context ctx) {
        Set<String> set = new HashSet<>();
        try {
            JSONArray arr = new JSONArray(SyncPrefs.albums(ctx));
            for (int i = 0; i < arr.length(); i++) {
                String s = arr.optString(i, "");
                if (!s.isEmpty()) set.add(s);
            }
        } catch (Exception ignore) {
        }
        return set;
    }

    private static void ensureDir(String base, String token, String dir) throws Exception {
        String[] parts = dir.split("/");
        StringBuilder acc = new StringBuilder();
        for (String part : parts) {
            if (part.trim().isEmpty()) continue;
            if (acc.length() > 0) acc.append("/");
            acc.append(part.trim());
            String q = URLEncoder.encode(acc.toString(), "UTF-8");
            HttpURLConnection conn = open(base + "/api/mkdir?path=" + q + "&t=" + token, "POST");
            int code = conn.getResponseCode();
            drain(conn);
            // 已存在时服务端会报错，忽略即可
            if (code >= 500) throw new RuntimeException("建目录 HTTP " + code);
        }
    }

    private static Set<String> remoteNames(String base, String token, String dir) throws Exception {
        Set<String> set = new HashSet<>();
        String q = URLEncoder.encode(dir, "UTF-8");
        HttpURLConnection conn = open(base + "/api/list?path=" + q + "&t=" + token, "GET");
        int code = conn.getResponseCode();
        if (code != 200) {
            drain(conn);
            throw new RuntimeException("列目录 HTTP " + code);
        }
        String body = readAll(conn.getInputStream());
        JSONObject o = new JSONObject(body);
        JSONArray arr = o.optJSONArray("entries");
        if (arr != null) {
            for (int i = 0; i < arr.length(); i++) {
                JSONObject e = arr.getJSONObject(i);
                if (!e.optBoolean("dir", false)) set.add(e.optString("name"));
            }
        }
        return set;
    }

    private static void upload(String base, String token, String dir, Item it, Context ctx) throws Exception {
        String remote = dir + "/" + it.name;
        String url = base + "/api/upload?path=" + URLEncoder.encode(remote, "UTF-8")
                + "&mtime=" + it.mtime + "&t=" + token;
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setRequestMethod("PUT");
        conn.setDoOutput(true);
        conn.setFixedLengthStreamingMode(it.size);
        conn.setConnectTimeout(15000);
        conn.setReadTimeout(600000);
        InputStream in = ctx.getContentResolver().openInputStream(it.uri);
        if (in == null) throw new RuntimeException("读不到文件");
        try {
            OutputStream out = conn.getOutputStream();
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            out.flush();
            out.close();
        } finally {
            in.close();
        }
        int code = conn.getResponseCode();
        drain(conn);
        if (code < 200 || code >= 300) throw new RuntimeException("上传 HTTP " + code);
    }

    private static HttpURLConnection open(String url, String method) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setRequestMethod(method);
        conn.setConnectTimeout(15000);
        conn.setReadTimeout(120000);
        return conn;
    }

    private static String readAll(InputStream in) throws Exception {
        StringBuilder sb = new StringBuilder();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) sb.append(new String(buf, 0, n, "UTF-8"));
        in.close();
        return sb.toString();
    }

    private static void drain(HttpURLConnection conn) {
        try {
            InputStream in = conn.getErrorStream();
            if (in == null) in = conn.getInputStream();
            if (in != null) readAll(in);
        } catch (Exception ignore) {
        }
    }
}
