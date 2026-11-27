package com.vaultd.app;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.hardware.biometrics.BiometricPrompt;
import android.os.Build;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.concurrent.Executor;

import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;

/**
 * 两层锁的原生后端：
 * - PIN 只保存 盐 + PBKDF2 哈希，明文不进 SharedPreferences；
 * - 指纹走系统 BiometricPrompt，不申请任何自定义权限；
 * - 解锁界面在 WebView 里，但这两种凭据的校验都在 Java 层，JS 拿不到哈希。
 */
public class SecurityBridge {
    private static final String PREFS = "vaultd-lock";
    private static final int ITER = 120000;
    private static final int PIN_MIN = 4;
    private static final int PIN_MAX = 8;

    private final Activity activity;
    private final WebView web;
    private final SharedPreferences sp;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Executor uiExec = command -> main.post(command);

    public SecurityBridge(Activity activity, WebView web) {
        this.activity = activity;
        this.web = web;
        this.sp = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    @JavascriptInterface
    public String state() {
        JSONObject o = new JSONObject();
        try {
            o.put("app_lock", sp.contains("app_salt"));
            o.put("folder_lock", sp.contains("folder_salt") && !sp.getString("folder_path", "").isEmpty());
            o.put("folder_path", sp.getString("folder_path", ""));
            o.put("biometric", biometricAvailable());
        } catch (Exception ignored) {
        }
        return o.toString();
    }

    @JavascriptInterface
    public boolean setPin(String which, String pin) {
        if (!validPin(pin)) return false;
        String prefix = keyPrefix(which);
        if (prefix == null) return false;
        try {
            byte[] salt = new byte[16];
            new SecureRandom().nextBytes(salt);
            String alg = canSha256() ? "sha256" : "sha1";
            String hash = hash(pin, salt, alg);
            sp.edit()
                    .putString(prefix + "_salt", Base64.encodeToString(salt, Base64.NO_WRAP))
                    .putString(prefix + "_hash", hash)
                    .putString(prefix + "_alg", alg)
                    .apply();
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    @JavascriptInterface
    public boolean verifyPin(String which, String pin) {
        String prefix = keyPrefix(which);
        if (prefix == null || pin == null) return false;
        try {
            String saltB64 = sp.getString(prefix + "_salt", "");
            String saved = sp.getString(prefix + "_hash", "");
            if (saltB64.isEmpty() || saved.isEmpty()) return false;
            String alg = sp.getString(prefix + "_alg", "sha256");
            byte[] salt = Base64.decode(saltB64, Base64.NO_WRAP);
            return MessageDigest.isEqual(saved.getBytes(StandardCharsets.UTF_8),
                    hash(pin, salt, alg).getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            return false;
        }
    }

    @JavascriptInterface
    public boolean clearPin(String which) {
        String prefix = keyPrefix(which);
        if (prefix == null) return false;
        sp.edit().remove(prefix + "_salt").remove(prefix + "_hash").apply();
        if ("folder".equals(which)) sp.edit().remove("folder_path").apply();
        return true;
    }

    @JavascriptInterface
    public boolean setFolderPath(String path) {
        String p = path == null ? "" : path.trim();
        if (p.isEmpty() || !p.startsWith("/") || p.contains("..")) return false;
        sp.edit().putString("folder_path", p).apply();
        return true;
    }

    @JavascriptInterface
    public String folderPath() {
        return sp.getString("folder_path", "");
    }

    @JavascriptInterface
    public boolean biometricAvailable() {
        if (Build.VERSION.SDK_INT < 28) return false;
        if (!activity.getPackageManager().hasSystemFeature(android.content.pm.PackageManager.FEATURE_FINGERPRINT)) {
            return false;
        }
        try {
            android.hardware.fingerprint.FingerprintManager fm =
                    activity.getSystemService(android.hardware.fingerprint.FingerprintManager.class);
            return fm != null && fm.isHardwareDetected() && fm.hasEnrolledFingerprints();
        } catch (Throwable ignored) {
            return false;
        }
    }

    @JavascriptInterface
    public void biometric(final String which) {
        final String kind = "folder".equals(which) ? "folder" : "app";
        if (!biometricAvailable()) {
            callback(false, "这台设备没有可用的指纹");
            return;
        }
        main.post(() -> {
            try {
                BiometricPrompt prompt = new BiometricPrompt.Builder(activity)
                        .setTitle("folder".equals(kind) ? "解锁私密文件夹" : "解锁 vaultd")
                        .setSubtitle("用指纹验证，或取消后输入 PIN")
                        .setNegativeButton("取消", uiExec, (dialog, id) -> callback(false, "已取消"))
                        .build();
                prompt.authenticate(new CancellationSignal(), uiExec,
                        new BiometricPrompt.AuthenticationCallback() {
                            @Override
                            public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                                callback(true, "");
                            }

                            @Override
                            public void onAuthenticationError(int code, CharSequence msg) {
                                callback(false, msg == null ? "指纹验证失败" : msg.toString());
                            }
                        });
            } catch (Throwable e) {
                callback(false, "指纹不可用：" + e.getMessage());
            }
        });
    }

    private void callback(boolean ok, String msg) {
        String js = "window.__onBioResult&&window.__onBioResult(" + (ok ? "true" : "false") + ","
                + JSONObject.quote(msg == null ? "" : msg) + ")";
        main.post(() -> {
            if (web != null) web.evaluateJavascript(js, null);
        });
    }

    private static boolean validPin(String pin) {
        if (pin == null || pin.length() < PIN_MIN || pin.length() > PIN_MAX) return false;
        for (int i = 0; i < pin.length(); i++) {
            char c = pin.charAt(i);
            if (c < '0' || c > '9') return false;
        }
        return true;
    }

    private static String keyPrefix(String which) {
        if ("app".equals(which)) return "app";
        if ("folder".equals(which)) return "folder";
        return null;
    }

    private static boolean canSha256() {
        try {
            SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256");
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private static String hash(String pin, byte[] salt, String alg) throws Exception {
        PBEKeySpec spec = new PBEKeySpec(pin.toCharArray(), salt, ITER, 256);
        String name = "sha1".equals(alg) ? "PBKDF2WithHmacSHA1" : "PBKDF2WithHmacSHA256";
        SecretKeyFactory f = SecretKeyFactory.getInstance(name);
        byte[] out = f.generateSecret(spec).getEncoded();
        spec.clearPassword();
        return Base64.encodeToString(out, Base64.NO_WRAP);
    }
}
