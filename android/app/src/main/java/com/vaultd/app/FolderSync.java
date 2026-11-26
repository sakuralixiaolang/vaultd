package com.vaultd.app;

import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * 任意文件夹备份：用户在设置里用系统目录选择器（SAF）挑一个目录，
 * 这里递归遍历整棵目录树，按原来的层级放到云端「文件备份/<文件夹名>/」下。
 *
 * 和相册同步走同一个本机网关 /api/upload，加密、分片、时间戳都由网关处理；
 * Java 侧只负责读文件和拼路径。
 */
public final class FolderSync {

    /** 一次同步里每个根目录最多传多少个文件，避免第一次选中几百 GB 的目录时卡死。 */
    private static final int MAX_FILES_PER_ROOT = 5000;
    private static final int MAX_DEPTH = 16;
    private static final String[] CHILD_PROJ = {
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE,
            DocumentsContract.Document.COLUMN_LAST_MODIFIED
    };

    private FolderSync() {}

    /** 返回一句摘要；没添加文件夹时返回空串。 */
    public static String run(Context ctx, String base, String token) {
        JSONArray arr;
        try {
            arr = new JSONArray(SyncPrefs.folders(ctx));
        } catch (Exception e) {
            return "";
        }
        if (arr.length() == 0) return "";

        String root = SyncPrefs.folderDir(ctx);
        int uploaded = 0, skipped = 0, failed = 0, okRoots = 0;
        String err = "";
        for (int i = 0; i < arr.length(); i++) {
            JSONObject o = arr.optJSONObject(i);
            if (o == null) continue;
            String uriStr = o.optString("uri", "").trim();
            if (uriStr.isEmpty()) continue;
            String name = safe(o.optString("name", "文件夹"));
            Uri tree = Uri.parse(uriStr);
            String docId;
            try {
                docId = DocumentsContract.getTreeDocumentId(tree);
            } catch (Exception e) {
                failed++;
                if (err.isEmpty()) err = name + "：没有目录权限，移除后重新添加";
                continue;
            }
            String baseDir = root + "/" + name;
            try {
                ensureDir(base, token, baseDir);
            } catch (Exception e) {
                failed++;
                if (err.isEmpty()) err = name + "：建目录失败 " + msgOf(e);
                continue;
            }
            Walk w = new Walk(ctx, base, token, baseDir);
            try {
                w.walk(tree, docId, "", 0);
                okRoots++;
            } catch (Exception e) {
                failed++;
                if (err.isEmpty()) err = name + "：" + msgOf(e);
            }
            uploaded += w.uploaded;
            skipped += w.skipped;
            failed += w.failed;
            if (err.isEmpty() && !w.err.isEmpty()) err = w.err;
        }

        StringBuilder sb = new StringBuilder();
        sb.append("文件夹：上传 ").append(uploaded).append(" · 跳过 ").append(skipped);
        if (failed > 0) sb.append(" · 失败 ").append(failed);
        if (okRoots == 0 && uploaded == 0 && skipped == 0 && err.isEmpty()) sb.append(" · 没读到文件");
        if (!err.isEmpty()) sb.append(" · ").append(err);
        return sb.toString();
    }

    // ---------------- 目录选择结果的处理 ----------------

    /** 记住用户选的目录；同一个目录重复选只更新名字。 */
    public static void addFolder(Context ctx, Uri uri, String name) {
        try {
            JSONArray arr = new JSONArray(SyncPrefs.folders(ctx));
            JSONArray out = new JSONArray();
            boolean replaced = false;
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                if (o.optString("uri").equals(uri.toString())) {
                    o.put("name", name);
                    replaced = true;
                }
                out.put(o);
            }
            if (!replaced) {
                JSONObject o = new JSONObject();
                o.put("uri", uri.toString());
                o.put("name", uniqueName(out, name));
                out.put(o);
            }
            SyncPrefs.setFolders(ctx, out.toString());
        } catch (Exception ignore) {
        }
    }

    public static void removeFolder(Context ctx, String uriStr) {
        try {
            JSONArray arr = new JSONArray(SyncPrefs.folders(ctx));
            JSONArray out = new JSONArray();
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o != null && !o.optString("uri").equals(uriStr)) out.put(o);
            }
            SyncPrefs.setFolders(ctx, out.toString());
        } catch (Exception ignore) {
        }
        try {
            Uri u = Uri.parse(uriStr);
            ctx.getContentResolver().releasePersistableUriPermission(u,
                    android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (Exception ignore) {
        }
    }

    public static JSONArray list(Context ctx) {
        try {
            return new JSONArray(SyncPrefs.folders(ctx));
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    private static String uniqueName(JSONArray arr, String name) {
        String base = safe(name);
        Set<String> used = new HashSet<>();
        for (int i = 0; i < arr.length(); i++) {
            JSONObject o = arr.optJSONObject(i);
            if (o != null) used.add(o.optString("name", ""));
        }
        if (!used.contains(base)) return base;
        for (int n = 2; n < 100; n++) {
            String s = base + " (" + n + ")";
            if (!used.contains(s)) return s;
        }
        return base + " " + System.currentTimeMillis();
    }

    // ---------------- 递归遍历 + 上传 ----------------

    private static final class Walk {
        final Context ctx;
        final String base;
        final String token;
        final String baseDir;
        final Map<String, Map<String, Long>> remoteCache = new HashMap<>();
        final Set<String> ensured = new HashSet<>();
        int uploaded, skipped, failed;
        String err = "";

        Walk(Context ctx, String base, String token, String baseDir) {
            this.ctx = ctx;
            this.base = base;
            this.token = token;
            this.baseDir = baseDir;
        }

        void walk(Uri tree, String docId, String rel, int depth) throws Exception {
            if (depth > MAX_DEPTH) return;
            Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId);
            Cursor c = null;
            try {
                c = ctx.getContentResolver().query(children, CHILD_PROJ, null, null, null);
                if (c == null) {
                    if (err.isEmpty()) err = "读不到目录（权限可能已失效，移除后重新添加）";
                    return;
                }
                int idI = c.getColumnIndex(DocumentsContract.Document.COLUMN_DOCUMENT_ID);
                int nameI = c.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME);
                int mimeI = c.getColumnIndex(DocumentsContract.Document.COLUMN_MIME_TYPE);
                int sizeI = c.getColumnIndex(DocumentsContract.Document.COLUMN_SIZE);
                int mtimeI = c.getColumnIndex(DocumentsContract.Document.COLUMN_LAST_MODIFIED);
                while (c.moveToNext()) {
                    if (uploaded + skipped + failed >= MAX_FILES_PER_ROOT) {
                        if (err.isEmpty()) err = "单次上限 " + MAX_FILES_PER_ROOT + " 个，剩下的下次继续";
                        return;
                    }
                    String id = idI >= 0 ? c.getString(idI) : null;
                    String name = nameI >= 0 ? c.getString(nameI) : null;
                    String mime = mimeI >= 0 ? c.getString(mimeI) : null;
                    long size = sizeI >= 0 ? c.getLong(sizeI) : 0L;
                    long mtime = mtimeI >= 0 ? c.getLong(mtimeI) : 0L;
                    if (id == null || name == null) continue;
                    if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                        String dirName = safe(name);
                        walk(tree, id, rel + dirName + "/", depth + 1);
                        continue;
                    }
                    String fileName = safe(name);
                    String remoteDir = baseDir + (rel.isEmpty() ? "" : "/" + trimSlash(rel));
                    try {
                        Map<String, Long> names = names(remoteDir);
                        Long old = names.get(fileName);
                        if (old != null && size > 0 && old == size) {
                            skipped++;
                            continue;
                        }
                        Uri doc = DocumentsContract.buildDocumentUriUsingTree(tree, id);
                        upload(doc, remoteDir, fileName, size, mtime);
                        names.put(fileName, size);
                        uploaded++;
                    } catch (Exception e) {
                        failed++;
                        if (err.isEmpty()) err = fileName + "：" + msgOf(e);
                    }
                }
            } finally {
                if (c != null) c.close();
            }
        }

        private Map<String, Long> names(String dir) throws Exception {
            Map<String, Long> m = remoteCache.get(dir);
            if (m != null) return m;
            if (!ensured.contains(dir)) {
                ensureDir(base, token, dir);
                ensured.add(dir);
            }
            m = new HashMap<>();
            JSONObject o = new JSONObject(get(base + "/api/list?path="
                    + URLEncoder.encode(dir, "UTF-8") + "&t=" + token));
            JSONArray arr = o.optJSONArray("entries");
            if (arr != null) {
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject e = arr.getJSONObject(i);
                    if (!e.optBoolean("dir", false)) {
                        m.put(e.optString("name"), e.optLong("size", 0L));
                    }
                }
            }
            remoteCache.put(dir, m);
            return m;
        }

        private void upload(Uri doc, String remoteDir, String fileName,
                            long size, long mtimeSec) throws Exception {
            String remote = remoteDir + "/" + fileName;
            String url = base + "/api/upload?path=" + URLEncoder.encode(remote, "UTF-8")
                    + (mtimeSec > 0 ? "&mtime=" + mtimeSec : "")
                    + "&t=" + token;
            HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setRequestMethod("PUT");
            conn.setDoOutput(true);
            if (size > 0) conn.setFixedLengthStreamingMode(size);
            else conn.setChunkedStreamingMode(64 * 1024);
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(600000);
            InputStream in = ctx.getContentResolver().openInputStream(doc);
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
    }

    // ---------------- 小工具 ----------------

    static void ensureDir(String base, String token, String dir) throws Exception {
        String[] parts = dir.split("/");
        StringBuilder acc = new StringBuilder();
        for (String part : parts) {
            if (part.trim().isEmpty()) continue;
            if (acc.length() > 0) acc.append("/");
            acc.append(part.trim());
            String q = URLEncoder.encode(acc.toString(), "UTF-8");
            HttpURLConnection conn = (HttpURLConnection) new URL(base + "/api/mkdir?path="
                    + q + "&t=" + token).openConnection();
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(120000);
            int code = conn.getResponseCode();
            drain(conn);
            if (code >= 500) throw new RuntimeException("建目录 HTTP " + code);
        }
    }

    private static String get(String url) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setRequestMethod("GET");
        conn.setConnectTimeout(15000);
        conn.setReadTimeout(120000);
        int code = conn.getResponseCode();
        if (code != 200) {
            drain(conn);
            throw new RuntimeException("列目录 HTTP " + code);
        }
        StringBuilder sb = new StringBuilder();
        InputStream in = conn.getInputStream();
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
            if (in != null) {
                byte[] buf = new byte[4096];
                while (in.read(buf) > 0) { /* 读完才能复用连接 */ }
                in.close();
            }
        } catch (Exception ignore) {
        }
    }

    private static String trimSlash(String s) {
        return s.endsWith("/") ? s.substring(0, s.length() - 1) : s;
    }

    /** 云端文件名/目录名清洗：去路径分隔符，超长时保留扩展名。 */
    static String safe(String s) {
        if (s == null) return "文件";
        String v = s.replace('/', '_').replace('\\', '_').replace(':', '_').trim();
        if (v.isEmpty() || v.equals(".") || v.equals("..")) return "文件";
        if (v.length() > 100) {
            String ext = "";
            int dot = v.lastIndexOf('.');
            if (dot > 0 && v.length() - dot <= 12) ext = v.substring(dot);
            v = v.substring(0, Math.max(1, 100 - ext.length())) + ext;
        }
        return v;
    }

    private static String msgOf(Exception e) {
        String m = e.getMessage();
        return m == null || m.isEmpty() ? e.getClass().getSimpleName() : m;
    }
}
