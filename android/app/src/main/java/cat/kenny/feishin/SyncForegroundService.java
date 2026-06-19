package cat.kenny.feishin;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import androidx.core.app.NotificationCompat;

/**
 * One typed {@code dataSync} foreground service instance per JS sync pipeline
 * (image-cache sweep + offline-media downloads), keeping the app process alive
 * and showing an ongoing progress notification while the app is backgrounded /
 * the screen is locked.
 *
 * The actual sync logic stays in the WebView (the promise/fetch-chained
 * pipelines in src/renderer/cache). This service does NOT re-implement sync; it
 * only:
 *   - posts startForeground() with a per-kind notification so the OS keeps the
 *     process resident, and
 *   - re-posts that notification on each progress update.
 *
 * Each pipeline ("kind") owns its own notification channel + notification id so
 * the two pipelines appear and stop independently. A single ONE service class
 * is started twice (distinct {@code kind} extras / notification ids).
 *
 * The shared partial wake lock and the Pause/Stop broadcast wiring live in
 * {@link SyncForegroundServicePlugin}; the service body is intentionally thin so
 * the plugin owns lifecycle + JS event re-emission.
 *
 * Dependency-free beyond android.* / androidx.core; mirrors the
 * tiny-self-contained-plugin convention of WakeLockPlugin / MediaVolumesPlugin.
 */
public class SyncForegroundService extends Service {

    private static final String TAG = "[sync-fgs]";

    public static final String ACTION_START = "cat.kenny.feishin.sync.START";
    public static final String ACTION_UPDATE = "cat.kenny.feishin.sync.UPDATE";

    public static final String EXTRA_KIND = "kind";
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_TEXT = "text";
    public static final String EXTRA_PROGRESS = "progress";
    public static final String EXTRA_MAX = "max";
    public static final String EXTRA_INDETERMINATE = "indeterminate";

    public static final String KIND_IMAGES = "images";
    public static final String KIND_DOWNLOADS = "downloads";

    // Broadcast the notification action buttons fire; the plugin's receiver
    // re-emits them to JS as the `syncAction` Capacitor event.
    public static final String ACTION_NOTIFICATION_PAUSE = "cat.kenny.feishin.sync.PAUSE";
    public static final String ACTION_NOTIFICATION_STOP = "cat.kenny.feishin.sync.STOP";
    public static final String EXTRA_ACTION_KIND = "actionKind";

    private static final String CHANNEL_IMAGES = "feishin-sync-images";
    private static final String CHANNEL_DOWNLOADS = "feishin-sync-downloads";

    // Stable per-kind notification ids so each pipeline owns its own
    // notification (start/update/stop independently).
    private static final int NOTIFICATION_ID_IMAGES = 0xF5C1;
    private static final int NOTIFICATION_ID_DOWNLOADS = 0xF5C2;

    private static int notificationIdForKind(String kind) {
        return KIND_DOWNLOADS.equals(kind) ? NOTIFICATION_ID_DOWNLOADS : NOTIFICATION_ID_IMAGES;
    }

    private static String channelForKind(String kind) {
        return KIND_DOWNLOADS.equals(kind) ? CHANNEL_DOWNLOADS : CHANNEL_IMAGES;
    }

    private void ensureChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm =
                (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        // IMPORTANCE_LOW = silent + no vibration, but still ongoing/visible.
        if (nm.getNotificationChannel(CHANNEL_IMAGES) == null) {
            NotificationChannel ch =
                    new NotificationChannel(
                            CHANNEL_IMAGES, "Library image sync", NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            ch.setSound(null, null);
            ch.enableVibration(false);
            nm.createNotificationChannel(ch);
        }
        if (nm.getNotificationChannel(CHANNEL_DOWNLOADS) == null) {
            NotificationChannel ch =
                    new NotificationChannel(
                            CHANNEL_DOWNLOADS, "Offline downloads", NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            ch.setSound(null, null);
            ch.enableVibration(false);
            nm.createNotificationChannel(ch);
        }
    }

    private PendingIntent contentIntent() {
        // Tap-to-open: relaunch MainActivity (singleTask, so it resumes the
        // existing task rather than stacking).
        Intent launch = new Intent(this, MainActivity.class);
        launch.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return PendingIntent.getActivity(this, 0, launch, flags);
    }

    private PendingIntent actionIntent(String kind, String action, int requestCode) {
        Intent intent = new Intent(this, SyncActionReceiver.class);
        intent.setAction(action);
        intent.putExtra(EXTRA_ACTION_KIND, kind);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return PendingIntent.getBroadcast(this, requestCode, intent, flags);
    }

    private Notification buildNotification(
            String kind, String title, String text, int progress, int max, boolean indeterminate) {
        // Per-kind request codes so the two notifications' action PendingIntents
        // don't collide.
        int base = KIND_DOWNLOADS.equals(kind) ? 200 : 100;
        NotificationCompat.Builder b =
                new NotificationCompat.Builder(this, channelForKind(kind))
                        .setContentTitle(title != null ? title : "Syncing")
                        .setContentText(text != null ? text : "")
                        .setSmallIcon(getApplicationInfo().icon)
                        .setOngoing(true)
                        .setOnlyAlertOnce(true)
                        .setContentIntent(contentIntent())
                        .setPriority(NotificationCompat.PRIORITY_LOW)
                        .addAction(
                                0,
                                "Pause",
                                actionIntent(kind, ACTION_NOTIFICATION_PAUSE, base + 1))
                        .addAction(
                                0,
                                "Stop",
                                actionIntent(kind, ACTION_NOTIFICATION_STOP, base + 2));
        if (max > 0) {
            b.setProgress(max, progress, indeterminate);
        } else {
            b.setProgress(0, 0, true);
        }
        return b.build();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            // Restarted by the OS with no intent — nothing to resume; the
            // renderer re-derives sync state on relaunch.
            stopSelf(startId);
            return START_NOT_STICKY;
        }
        String kind = intent.getStringExtra(EXTRA_KIND);
        if (kind == null) kind = KIND_IMAGES;
        String title = intent.getStringExtra(EXTRA_TITLE);
        String text = intent.getStringExtra(EXTRA_TEXT);
        int progress = intent.getIntExtra(EXTRA_PROGRESS, 0);
        int max = intent.getIntExtra(EXTRA_MAX, 0);
        boolean indeterminate = intent.getBooleanExtra(EXTRA_INDETERMINATE, max <= 0);

        ensureChannels();
        Notification notification =
                buildNotification(kind, title, text, progress, max, indeterminate);
        int id = notificationIdForKind(kind);

        String action = intent.getAction();
        if (ACTION_START.equals(action) || ACTION_UPDATE.equals(action)) {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    startForeground(
                            id,
                            notification,
                            android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
                } else {
                    startForeground(id, notification);
                }
                Log.i(TAG, "service " + action + " kind=" + kind);
            } catch (Exception e) {
                Log.w(TAG, "startForeground failed kind=" + kind + ": " + e.getMessage());
            }
        }
        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
