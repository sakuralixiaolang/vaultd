package com.vaultd.app;

import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.CallLog;
import android.provider.ContactsContract;
import android.provider.ContactsContract.CommonDataKinds.Phone;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.security.MessageDigest;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * 通讯录 / 短信 / 通话记录的备份：把系统里的数据导出成文件，走同一个加密管线上传。
 * 每天一份快照（contacts-2026-11-25.vcf 之类），内容没变就不重复传。
 */
public final class Extras {

    private static final int MAX_CONTACTS = 5000;
    private static final int MAX_SMS = 2000;
    private static final int MAX_CALLS = 2000;

    private Extras() {}

    /** 返回一句话总结，拼到自动同步的结果里。 */
    public static String run(Context ctx, String base, String token, String dir) {
        List<String> notes = new ArrayList<>();
        if (SyncPrefs.contacts(ctx)) {
            notes.add(pushText(ctx, base, token, dir, "通讯录", "contacts", ".vcf", contactsVcf(ctx)));
        }
        if (SyncPrefs.sms(ctx)) {
            notes.add(pushText(ctx, base, token, dir, "短信", "sms", ".json", smsJson(ctx)));
        }
        if (SyncPrefs.calls(ctx)) {
            notes.add(pushText(ctx, base, token, dir, "通话记录", "calls", ".json", callsJson(ctx)));
        }
        StringBuilder sb = new StringBuilder();
        for (String n : notes) {
            if (n == null || n.isEmpty()) continue;
            if (sb.length() > 0) sb.append(" · ");
            sb.append(n);
        }
        return sb.toString();
    }

    /** 通讯录导出成 vCard：只留姓名和号码，照片之类不导，文件小很多。 */
    static String contactsVcf(Context ctx) {
        Set<String> seen = new HashSet<>();
        StringBuilder sb = new StringBuilder();
        int n = 0;
        Cursor c = null;
        try {
            c = ctx.getContentResolver().query(
                    Phone.CONTENT_URI,
                    new String[]{Phone.DISPLAY_NAME, Phone.NUMBER},
                    null, null, Phone.DISPLAY_NAME + " ASC");
            if (c == null) return "";
            int nameI = c.getColumnIndex(Phone.DISPLAY_NAME);
            int numI = c.getColumnIndex(Phone.NUMBER);
            while (c.moveToNext() && n < MAX_CONTACTS) {
                String name = nameI >= 0 ? c.getString(nameI) : null;
                String number = numI >= 0 ? c.getString(numI) : null;
                if (number == null || number.trim().isEmpty()) continue;
                if (name == null || name.trim().isEmpty()) name = number;
                String key = name + "|" + number;
                if (!seen.add(key)) continue;
                sb.append("BEGIN:VCARD\n")
                        .append("VERSION:3.0\n")
                        .append("FN:").append(vcardEsc(name)).append('\n')
                        .append("N:").append(vcardEsc(name)).append(";;;;\n")
                        .append("TEL;TYPE=CELL:").append(vcardEsc(number.trim())).append('\n')
                        .append("END:VCARD\n");
                n++;
            }
        } catch (Exception ignore) {
            return "";
        } finally {
            if (c != null) c.close();
        }
        return n == 0 ? "" : sb.toString();
    }

    private static String vcardEsc(String s) {
        return s.replace("\\", "\\\\").replace("\n", " ").replace(",", "\\,").replace(";", "\\;");
    }

    /** 短信导出成 JSON 数组，最近 2000 条足够还原聊天记录。 */
    static String smsJson(Context ctx) {
        JSONArray arr = new JSONArray();
        Cursor c = null;
        try {
            c = ctx.getContentResolver().query(
                    Uri.parse("content://sms"),
                    new String[]{"address", "body", "date", "type", "read"},
                    null, null, "date DESC");
            if (c == null) return "";
            int addrI = c.getColumnIndex("address");
            int bodyI = c.getColumnIndex("body");
            int dateI = c.getColumnIndex("date");
            int typeI = c.getColumnIndex("type");
            while (c.moveToNext() && arr.length() < MAX_SMS) {
                JSONObject o = new JSONObject();
                try {
                    o.put("address", addrI >= 0 ? c.getString(addrI) : "");
                    String body = bodyI >= 0 ? c.getString(bodyI) : "";
                    if (body != null && body.length() > 2000) body = body.substring(0, 2000) + "…";
                    o.put("body", body == null ? "" : body);
                    o.put("date", dateI >= 0 ? c.getLong(dateI) : 0);
                    o.put("type", typeI >= 0 ? c.getInt(typeI) : 0);
                } catch (Exception ignore) {
                }
                arr.put(o);
            }
        } catch (Exception ignore) {
            return "";
        } finally {
            if (c != null) c.close();
        }
        return arr.length() == 0 ? "" : arr.toString();
    }

    /** 通话记录导出成 JSON 数组。 */
    static String callsJson(Context ctx) {
        JSONArray arr = new JSONArray();
        Cursor c = null;
        try {
            c = ctx.getContentResolver().query(
                    CallLog.Calls.CONTENT_URI,
                    new String[]{
                            CallLog.Calls.NUMBER, CallLog.Calls.CACHED_NAME,
                            CallLog.Calls.TYPE, CallLog.Calls.DATE, CallLog.Calls.DURATION},
                    null, null, CallLog.Calls.DATE + " DESC");
            if (c == null) return "";
            int numI = c.getColumnIndex(CallLog.Calls.NUMBER);
            int nameI = c.getColumnIndex(CallLog.Calls.CACHED_NAME);
            int typeI = c.getColumnIndex(CallLog.Calls.TYPE);
            int dateI = c.getColumnIndex(CallLog.Calls.DATE);
            int durI = c.getColumnIndex(CallLog.Calls.DURATION);
            while (c.moveToNext() && arr.length() < MAX_CALLS) {
                JSONObject o = new JSONObject();
                try {
                    o.put("number", numI >= 0 ? c.getString(numI) : "");
                    o.put("name", nameI >= 0 ? c.getString(nameI) : "");
                    o.put("type", typeI >= 0 ? c.getInt(typeI) : 0);
                    o.put("date", dateI >= 0 ? c.getLong(dateI) : 0);
                    o.put("duration", durI >= 0 ? c.getLong(durI) : 0);
                } catch (Exception ignore) {
                }
                arr.put(o);
            }
        } catch (Exception ignore) {
            return "";
        } finally {
            if (c != null) c.close();
        }
        return arr.length() == 0 ? "" : arr.toString();
    }

    /** 内容按天一份；哈希没变就跳过，改过就覆盖当天的文件。 */
    private static String pushText(Context ctx, String base, String token, String dir,
                                   String kind, String prefix, String ext, String content) {
        if (content == null || content.isEmpty()) {
            return kind + "：没有数据";
        }
        String day = new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
        String name = prefix + "-" + day + ext;
        String hash = sha256(content.getBytes());
        String lastKey = "last_" + prefix;
        if (hash.equals(SyncPrefs.lastDigest(ctx, lastKey)) && day.equals(SyncPrefs.lastDigestDay(ctx, lastKey))) {
            return kind + "：今天没变化";
        }
        try {
            String folder = dir + "/" + kind;
            AutoSync.ensureDir(base, token, folder);
            byte[] data = content.getBytes("UTF-8");
            String path = folder + "/" + name;
            String url = base + "/api/upload?path=" + URLEncoder.encode(path, "UTF-8")
                    + "&mtime=" + System.currentTimeMillis() / 1000L + "&t=" + token;
            HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setRequestMethod("PUT");
            conn.setDoOutput(true);
            conn.setFixedLengthStreamingMode(data.length);
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(120000);
            OutputStream out = conn.getOutputStream();
            out.write(data);
            out.flush();
            out.close();
            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) return kind + "：上传失败 HTTP " + code;
            SyncPrefs.setLastDigest(ctx, lastKey, hash, day);
            return kind + "：已更新";
        } catch (Exception e) {
            return kind + "：" + (e.getMessage() == null ? "失败" : e.getMessage());
        }
    }

    private static String sha256(byte[] data) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] d = md.digest(data);
            StringBuilder sb = new StringBuilder();
            for (byte b : d) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }
}
