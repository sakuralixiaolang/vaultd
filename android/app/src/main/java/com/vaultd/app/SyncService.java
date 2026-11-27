package com.vaultd.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.util.Log;

/**
 * 自动同步的前台服务：每 15 分钟扫一次相机目录，发现新照片/视频就上传。
 * 用前台服务是为了让进程在切到后台后还能活着（否则网关一停就没法加密上传）。
 */
public class SyncService extends Service {
    private static final String TAG = "vaultd-sync";
    private static final String CHANNEL = "autosync";
    private static final int NID = 1001;
    private static final long INTERVAL_MS = 15L * 60L * 1000L;

    private HandlerThread thread;
    private Handler handler;
    private Runnable tick;
    private boolean firstRun = true;

    public static void start(Context ctx) {
        Intent i = new Intent(ctx, SyncService.class);
        try {
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i);
            else ctx.startService(i);
        } catch (Exception e) {
            Log.w(TAG, "启动同步服务失败: " + e.getMessage());
        }
    }

    public static void stop(Context ctx) {
        try {
            ctx.stopService(new Intent(ctx, SyncService.class));
        } catch (Exception ignore) {
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        // 通道必须在 startForeground 之前建好，否则系统直接判“通知无效”把进程杀掉。
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) ensureChannel(nm);
        } catch (Exception ignore) {
        }
        thread = new HandlerThread("autosync");
        thread.start();
        handler = new Handler(thread.getLooper());
        tick = new Runnable() {
            @Override
            public void run() {
                if (!SyncPrefs.enabled(SyncService.this)) {
                    stopSelf();
                    return;
                }
                final AutoSync.Result r;
                try {
                    // 服务刚起来的第一轮做全量补齐；之后每 15 分钟只看最近的增量。
                    r = AutoSync.run(SyncService.this, firstRun);
                    firstRun = false;
                } catch (Throwable t) {
                    Log.w(TAG, "同步异常: " + t.getMessage());
                    handler.postDelayed(this, INTERVAL_MS);
                    return;
                }
                publish("自动同步：" + r.msg);
                handler.postDelayed(this, INTERVAL_MS);
            }
        };
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForeground(NID, notification("自动同步已开启"));
        firstRun = true;
        handler.removeCallbacks(tick);
        handler.post(tick); // 开启后先跑一轮，用户马上能看到效果
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        if (handler != null) handler.removeCallbacks(tick);
        if (thread != null) thread.quitSafely();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void publish(String text) {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            ensureChannel(nm);
            nm.notify(NID, notification(text));
        } catch (Exception ignore) {
        }
    }

    private void ensureChannel(NotificationManager nm) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationChannel ch = nm.getNotificationChannel(CHANNEL);
        if (ch != null) return;
        ch = new NotificationChannel(CHANNEL, "相册自动同步", NotificationManager.IMPORTANCE_LOW);
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
    }

    private Notification notification(String text) {
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) {
            b = new Notification.Builder(this, CHANNEL);
        } else {
            b = new Notification.Builder(this);
        }
        b.setContentTitle("我的网盘")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.stat_sys_upload)
                .setOngoing(true);
        return b.build();
    }
}

