package com.vaultd.app;

import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Context;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Log;
import android.util.LruCache;
import android.util.Size;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
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
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

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
        return run(ctx, false);
    }

    /**
     * full=true 用于「立即同步」和后台服务刚启动的第一轮：不限时间窗，
     * 把相册里远端还没有的文件都找出来；平时轮询只回看最近 24 小时。
     */
    public static synchronized Result run(Context ctx, boolean full) {
        Result r = new Result();
        String base = SyncPrefs.base(ctx);
        String token = SyncPrefs.token(ctx);
        if (base.isEmpty() || token.isEmpty()) {
            r.msg = "网关还没起来，先打开 App 一次";
            SyncPrefs.setProgress(ctx, false, 0, 0, "");
            return r;
        }
        if (SyncPrefs.wifiOnly(ctx) && !isWifi(ctx)) {
            r.ok = true;
            r.msg = "仅 Wi-Fi：当前是流量，跳过这一轮";
            SyncPrefs.setLastResult(ctx, r.msg + " · " + now());
            SyncPrefs.setLastRun(ctx, System.currentTimeMillis());
            SyncPrefs.setProgress(ctx, false, 0, 0, "仅 Wi-Fi，已跳过");
            return r;
        }
        String dir = SyncPrefs.dir(ctx);
        boolean keepAlbum = SyncPrefs.keepAlbum(ctx);
        try {
            SyncPrefs.setProgress(ctx, true, 0, 0, "正在检查新照片…");
            List<Item> items = scan(ctx, full);
            Map<String, Set<String>> remote = new HashMap<>();
            Map<String, List<Item>> todoByDir = new LinkedHashMap<>();
            int total = 0;
            for (Item it : items) {
                // 云端按「相册名」分子文件夹，保留手机上原来的相册结构。
                String folder = keepAlbum ? join(dir, it.album) : dir;
                Set<String> names = remote.get(folder);
                if (names == null) {
                    ensureDir(base, token, folder);
                    names = remoteNames(base, token, folder);
                    remote.put(folder, names);
                }
                if (names.contains(it.name)) {
                    r.skipped++;
                    continue;
                }
                // 同一轮里也可能重名，先去重，失败时再放开重试。
                names.add(it.name);
                List<Item> list = todoByDir.get(folder);
                if (list == null) {
                    list = new ArrayList<>();
                    todoByDir.put(folder, list);
                }
                list.add(it);
                total++;
            }
            SyncPrefs.setProgress(ctx, true, 0, total, total == 0 ? "没有新增照片" : "准备上传");
            // 小文件多的时候，逐张串行主要卡在「139 建文件/收尾」的往返延迟上。
            // 3 路上传并行，既能把延迟叠起来，又不会把手机的加密和上行带宽压死。
            final AtomicInteger done = new AtomicInteger(0);
            final AtomicInteger okCount = new AtomicInteger(0);
            final AtomicInteger failCount = new AtomicInteger(0);
            final AtomicReference<String> firstErr = new AtomicReference<>("");
            if (total > 0) {
                final int taskTotal = total;
                ExecutorService pool = Executors.newFixedThreadPool(Math.min(3, total));
                for (final Map.Entry<String, List<Item>> e : todoByDir.entrySet()) {
                    for (final Item it : e.getValue()) {
                        pool.submit(new Runnable() {
                            @Override
                            public void run() {
                                SyncPrefs.setProgress(ctx, true, done.get(), taskTotal, it.name);
                                try {
                                    uploadWithRetry(base, token, e.getKey(), it, ctx);
                                    okCount.incrementAndGet();
                                } catch (Exception ex) {
                                    remote.get(e.getKey()).remove(it.name); // 失败了下一轮还得重试
                                    failCount.incrementAndGet();
                                    firstErr.compareAndSet("", it.name + " 失败：" + ex.getMessage());
                                    Log.w("vaultd-sync", "上传失败 " + it.name + ": " + ex.getMessage());
                                }
                                int d = done.incrementAndGet();
                                SyncPrefs.setProgress(ctx, true, d, taskTotal, it.name);
                            }
                        });
                    }
                }
                pool.shutdown();
                try {
                    while (!pool.awaitTermination(30, TimeUnit.SECONDS)) {
                        // 大视频可能传很久；这里只是等线程池收尾，不死等。
                    }
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    pool.shutdownNow();
                }
            }
            r.uploaded = okCount.get();
            r.failed = failCount.get();
            if (!firstErr.get().isEmpty()) r.msg = firstErr.get();
            int finished = done.get();
            SyncPrefs.setLastScanMark(ctx, System.currentTimeMillis());
            SyncPrefs.setLastRun(ctx, System.currentTimeMillis());
            r.ok = r.failed == 0;
            SyncPrefs.setProgress(ctx, true, finished, total, "照片完成，检查其他备份…");
            String extra = Extras.run(ctx, base, token, dir);
            String folders = FolderSync.run(ctx, base, token);
            String errNote = (r.failed > 0 && !firstErr.get().isEmpty()) ? " · " + firstErr.get() : "";
            r.msg = "上传 " + r.uploaded + " · 跳过 " + r.skipped + (r.failed > 0 ? " · 失败 " + r.failed : "")
                    + errNote
                    + (extra.isEmpty() ? "" : " · " + extra)
                    + (folders.isEmpty() ? "" : " · " + folders);
            SyncPrefs.setLastResult(ctx, r.msg + " · " + now());
            SyncPrefs.setProgress(ctx, false, finished, total, "");
        } catch (Exception e) {
            r.ok = false;
            r.msg = "同步失败：" + e.getMessage();
            SyncPrefs.setLastResult(ctx, r.msg + " · " + now());
            SyncPrefs.setLastRun(ctx, System.currentTimeMillis());
            SyncPrefs.setProgress(ctx, false, 0, 0, "同步失败：" + e.getMessage());
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
    private static List<Item> scan(Context ctx, boolean full) {
        List<Item> out = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        Set<String> picked = selectedAlbums(ctx);
        long since;
        if (full) {
            since = 0; // 手动「立即同步」：不看时间窗，远端没有的都补
        } else {
            long mark = SyncPrefs.lastScanMark(ctx);
            // 首次开启 / 上次同步失败时没有标记：回看 7 天，避免把去年的整库搬上去。
            since = mark > 0 ? mark - 24L * 3600_000L : System.currentTimeMillis() - 7L * 24 * 3600_000L;
        }
        int maxItems = full ? 4000 : 1500;
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
                while (c.moveToNext() && out.size() < maxItems) {
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

    /** 后台补封面时回调给界面（主线程由调用方负责）。 */
    public interface CoverListener {
        void onCover(String album, String dataUrl);
    }

    public static String albumsJson(Context ctx) {
        return albumsJson(ctx, null);
    }

    /**
     * 系统相册清单：给设置面板勾选用；count 是该相册里的图片+视频数量。
     * 每个相册就是一个 MediaStore bucket，也就是手机里的一个文件夹，所以顺便把
     * 真实文件夹路径（DCIM/Camera 这类）和 112px 封面一起返回，选的时候不容易认错。
     * 缓存里已有的封面立刻返回；没缓存的先留空，后台慢慢做，做好了通过 cb 补上。
     */
    public static String albumsJson(Context ctx, CoverListener cb) {
        pruneCoverCache(ctx);
        Map<String, Integer> count = new HashMap<>();
        Map<String, long[]> cover = new HashMap<>();  // album -> {mediaId, video?1:0, dateModified}
        Map<String, String> folders = new HashMap<>();
        boolean hasRelative = Build.VERSION.SDK_INT >= 29;
        String[] tables = {"images", "video"};
        for (String t : tables) {
            boolean video = "video".equals(t);
            Uri table = video
                    ? MediaStore.Video.Media.EXTERNAL_CONTENT_URI
                    : MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
            Cursor c = null;
            try {
                String[] proj = hasRelative
                        ? new String[]{"bucket_display_name", "bucket_id", MediaStore.MediaColumns._ID,
                        MediaStore.MediaColumns.SIZE, MediaStore.MediaColumns.RELATIVE_PATH,
                        MediaStore.MediaColumns.DATA, MediaStore.MediaColumns.DATE_MODIFIED}
                        : new String[]{"bucket_display_name", "bucket_id", MediaStore.MediaColumns._ID,
                        MediaStore.MediaColumns.SIZE, MediaStore.MediaColumns.DATA,
                        MediaStore.MediaColumns.DATE_MODIFIED};
                c = ctx.getContentResolver().query(table, proj,
                        null, null, MediaStore.MediaColumns.DATE_MODIFIED + " DESC");
                if (c == null) continue;
                int bkI = c.getColumnIndex("bucket_display_name");
                int bkIdI = c.getColumnIndex("bucket_id");
                int idI = c.getColumnIndex(MediaStore.MediaColumns._ID);
                int sizeI = c.getColumnIndex(MediaStore.MediaColumns.SIZE);
                int relI = c.getColumnIndex(MediaStore.MediaColumns.RELATIVE_PATH);
                int dataI = c.getColumnIndex(MediaStore.MediaColumns.DATA);
                int modI = c.getColumnIndex(MediaStore.MediaColumns.DATE_MODIFIED);
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
                    // 按 DATE_MODIFIED 倒序扫，第一条就是最新的一张，拿来当封面
                    if (!cover.containsKey(album) && idI >= 0) {
                        cover.put(album, new long[]{c.getLong(idI), video ? 1 : 0,
                                modI >= 0 ? c.getLong(modI) : 0});
                    }
                    if (!folders.containsKey(album)) {
                        String folder = folderOf(relI >= 0 ? c.getString(relI) : null);
                        if (folder.isEmpty() && dataI >= 0) folder = folderOf(c.getString(dataI));
                        if (!folder.isEmpty()) folders.put(album, folder);
                    }
                }
            } catch (Exception ignore) {
            } finally {
                if (c != null) c.close();
            }
        }
        List<Map.Entry<String, Integer>> list = new ArrayList<>(count.entrySet());
        list.sort((a, b) -> b.getValue() - a.getValue());
        JSONArray arr = new JSONArray();
        List<Object[]> pending = new ArrayList<>();
        for (Map.Entry<String, Integer> e : list) {
            JSONObject o = new JSONObject();
            try {
                o.put("name", e.getKey());
                o.put("count", e.getValue());
                String folder = folders.get(e.getKey());
                if (folder != null && !folder.isEmpty()) o.put("path", folder);
                long[] cv = cover.get(e.getKey());
                // 已缓存的立刻带上；没缓存的记下来后台做，界面先显示文件夹图标
                if (cv != null) {
                    String data = coverCached(ctx, cv[0], cv[1] == 1, cv[2]);
                    if (!data.isEmpty()) o.put("cover", data);
                    else pending.add(new Object[]{e.getKey(), cv[0], cv[1] == 1, cv[2]});
                }
                arr.put(o);
            } catch (Exception ignore) {
            }
        }
        if (cb != null && !pending.isEmpty()) {
            final Context app = ctx.getApplicationContext();
            final List<Object[]> jobs = new ArrayList<>(pending);
            final CoverListener sink = cb;
            Thread t = new Thread(new Runnable() {
                @Override
                public void run() {
                    for (Object[] job : jobs) {
                        String data = coverBuild(app, (Long) job[1], (Boolean) job[2], (Long) job[3]);
                        if (!data.isEmpty()) {
                            try {
                                sink.onCover((String) job[0], data);
                            } catch (Throwable ignore) {
                            }
                        }
                    }
                }
            }, "album-covers");
            t.setDaemon(true);
            t.start();
        }
        return arr.toString();
    }

    /** 把 RELATIVE_PATH / DATA 统一成「DCIM/Camera」这种相对文件夹。 */
    private static String folderOf(String raw) {
        if (raw == null) return "";
        String p = raw.trim();
        if (p.isEmpty()) return "";
        int i = p.indexOf("/storage/emulated/0/");
        if (i >= 0) p = p.substring(i + "/storage/emulated/0/".length());
        if (p.startsWith("/")) p = p.substring(1);
        if (p.endsWith("/")) return p.substring(0, p.length() - 1);
        int slash = p.lastIndexOf('/');
        return slash > 0 ? p.substring(0, slash) : "";
    }

    /** 封面缓存最多留多少个文件；超了按最久没用的删。 */
    private static final int COVER_CACHE_MAX = 400;

    /** 进程内再缓存一层 data URL（约 4MB），同一次打开里反复取相册清单不用重复读盘、编码。 */
    private static final LruCache<String, String> COVER_MEM = new LruCache<String, String>(4096) {
        @Override
        protected int sizeOf(String key, String value) {
            return (value == null ? 0 : value.length()) / 1024 + 1;
        }
    };

    /**
     * 封面缓存：cacheDir/album-covers，文件名带「类型+媒体id+修改时间」。
     * 只要相册最新一张照片没换，key 就不变，下次打开直接读文件；换了新照片自然换成新 key。
     */
    private static File coverFile(Context ctx, long id, boolean video, long modified) {
        try {
            File dir = new File(ctx.getCacheDir(), "album-covers");
            if (!dir.isDirectory() && !dir.mkdirs()) return null;
            return new File(dir, (video ? "v" : "i") + id + "_" + modified + ".jpg");
        } catch (Throwable ignore) {
            return null;
        }
    }

    private static File coverDir(Context ctx) {
        return new File(ctx.getCacheDir(), "album-covers");
    }

    private static void pruneCoverCache(Context ctx) {
        try {
            File dir = coverDir(ctx);
            File[] files = dir.listFiles();
            if (files == null || files.length <= COVER_CACHE_MAX) return;
            List<File> all = new ArrayList<>();
            for (File f : files) if (f.isFile()) all.add(f);
            if (all.size() <= COVER_CACHE_MAX) return;
            all.sort((a, b) -> Long.compare(a.lastModified(), b.lastModified()));
            for (int i = 0; i < all.size() - COVER_CACHE_MAX; i++) all.get(i).delete();
        } catch (Throwable ignore) {
        }
    }

    private static String dataUrl(byte[] jpeg) {
        return "data:image/jpeg;base64," + Base64.encodeToString(jpeg, Base64.NO_WRAP);
    }

    /** 只查缓存：内存 → 本地文件；没有就返回空串，交给后台生成。 */
    private static String coverCached(Context ctx, long id, boolean video, long modified) {
        File f = coverFile(ctx, id, video, modified);
        if (f == null) return "";
        String hit = COVER_MEM.get(f.getName());
        if (hit != null) return hit;
        if (!f.isFile() || f.length() <= 0) return "";
        try (FileInputStream in = new FileInputStream(f)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream((int) f.length());
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            String data = dataUrl(out.toByteArray());
            COVER_MEM.put(f.getName(), data);
            return data;
        } catch (Throwable ignore) {
            return "";
        }
    }

    /** 现场做缩略图，写进文件缓存和内存缓存后返回 data URL。 */
    private static String coverBuild(Context ctx, long id, boolean video, long modified) {
        byte[] jpeg = thumbJpeg(ctx, id, video);
        if (jpeg == null || jpeg.length == 0) return "";
        File f = coverFile(ctx, id, video, modified);
        if (f != null) {
            try (FileOutputStream out = new FileOutputStream(f)) {
                out.write(jpeg);
            } catch (Throwable ignore) {
            }
        }
        String data = dataUrl(jpeg);
        if (f != null) COVER_MEM.put(f.getName(), data);
        return data;
    }

    /** 取一张 112px 方图，压成 JPEG 字节；失败返回 null，前端退回文件夹图标。 */
    private static byte[] thumbJpeg(Context ctx, long id, boolean video) {
        Bitmap bmp = null;
        Bitmap square = null;
        try {
            Uri uri = ContentUris.withAppendedId(video
                    ? MediaStore.Video.Media.EXTERNAL_CONTENT_URI
                    : MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id);
            if (Build.VERSION.SDK_INT >= 29) {
                bmp = ctx.getContentResolver().loadThumbnail(uri, new Size(112, 112), null);
            } else if (video) {
                bmp = MediaStore.Video.Thumbnails.getThumbnail(ctx.getContentResolver(), id,
                        MediaStore.Video.Thumbnails.MINI_KIND, null);
            } else {
                bmp = MediaStore.Images.Thumbnails.getThumbnail(ctx.getContentResolver(), id,
                        MediaStore.Images.Thumbnails.MINI_KIND, null);
            }
            if (bmp == null) return null;
            int w = bmp.getWidth(), h = bmp.getHeight();
            int side = Math.min(w, h);
            square = Bitmap.createBitmap(bmp, (w - side) / 2, (h - side) / 2, side, side);
            if (square.getWidth() != 112) {
                Bitmap scaled = Bitmap.createScaledBitmap(square, 112, 112, true);
                if (scaled != square) {
                    square.recycle();
                    square = scaled;
                }
            }
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            square.compress(Bitmap.CompressFormat.JPEG, 72, out);
            return out.toByteArray();
        } catch (Throwable ignore) {
            return null;
        } finally {
            if (square != null && square != bmp) square.recycle();
            if (bmp != null) bmp.recycle();
        }
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

    static void ensureDir(String base, String token, String dir) throws Exception {
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
        // 上传是多线程并行，失败时各线程会从这个集合里删名字，必须用并发集合。
        Set<String> set = ConcurrentHashMap.newKeySet();
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

    /**
     * 三路并行上传时，云端偶尔会对某一个请求返回一次瞬时错误；
     * 单文件重试三次（中间稍等），比整轮失败、等 15 分钟再补要快得多。
     */
    private static void uploadWithRetry(String base, String token, String dir, Item it, Context ctx) throws Exception {
        Exception last = null;
        for (int attempt = 0; attempt < 3; attempt++) {
            try {
                upload(base, token, dir, it, ctx);
                return;
            } catch (Exception e) {
                last = e;
                if (attempt < 2) {
                    try {
                        Thread.sleep(400L * (attempt + 1));
                    } catch (InterruptedException ie) {
                        Thread.currentThread().interrupt();
                        throw ie;
                    }
                }
            }
        }
        throw last == null ? new RuntimeException("上传失败") : last;
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
