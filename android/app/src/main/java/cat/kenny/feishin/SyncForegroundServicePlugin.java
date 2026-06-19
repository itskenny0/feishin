package cat.kenny.feishin;

import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.PowerManager;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.HashSet;
import java.util.Set;

/**
 * Capacitor bridge that wraps each JS sync pipeline (image-cache sweep +
 * offline-media downloads) in a typed {@code dataSync} foreground service, a
 * shared partial wake lock, and a per-pipeline progress notification — so the
 * existing promise/fetch-chained sync keeps progressing while the app is
 * backgrounded / the screen is locked.
 *
 * It does NOT re-implement sync. The renderer pipelines (src/renderer/cache)
 * stay unchanged; the renderer controller (src/renderer/features/sync-service)
 * drives this plugin from the cache-store progress state.
 *
 * Method surface (all resolve immediately):
 *   - start({ kind })  — start the FGS for `kind` and acquire the shared lock.
 *   - update({ kind, title, text, progress?, max?, indeterminate? })
 *                      — re-post `kind`'s notification with new progress.
 *   - stop({ kind })   — stop `kind`'s FGS + remove its notification; release
 *                        the shared lock once no kind remains active.
 *
 * Emits the Capacitor event `syncAction` with { kind, action } when a
 * notification Pause/Stop button is tapped (delivered via
 * {@link SyncActionReceiver}).
 *
 * Wake lock: ONE shared PARTIAL_WAKE_LOCK (tag {@code feishin:sync}),
 * setReferenceCounted(false) so acquire/release are idempotent; held while ANY
 * kind is active, released when the last kind stops. A watchdog timeout backstop
 * (mirrors WakeLockPlugin) ensures a renderer crash mid-sync can never strand
 * the CPU awake.
 *
 * Mirrors the tiny-self-contained-plugin convention of WakeLockPlugin /
 * MediaVolumesPlugin (android.* + com.getcapacitor only).
 */
@CapacitorPlugin(name = "SyncForegroundService")
public class SyncForegroundServicePlugin extends Plugin {

    private static final String TAG = "[sync-fgs]";

    private static final String WAKE_LOCK_TAG = "feishin:sync";

    // Backstop so a renderer crash mid-sync cannot pin the CPU awake forever.
    // The controller re-acquires on every throttled progress update (~1 Hz), so
    // a still-running sync never lets the lock lapse in practice. 30 minutes
    // comfortably exceeds the gap between updates while bounding a leak.
    private static final long WATCHDOG_TIMEOUT_MS = 30 * 60 * 1000L;

    // The single live plugin instance, so the OS-created SyncActionReceiver can
    // hand notification actions back without its own bridge handle.
    private static SyncForegroundServicePlugin instance;

    private PowerManager.WakeLock wakeLock = null;

    // Which pipelines currently have a live FGS. The wake lock is held while
    // this is non-empty.
    private final Set<String> activeKinds = new HashSet<>();

    @Override
    public void load() {
        instance = this;
    }

    @Override
    protected void handleOnDestroy() {
        // Defensive: never let the activity teardown leak a held CPU lock or
        // strand a foreground service.
        synchronized (this) {
            for (String kind : new HashSet<>(activeKinds)) {
                stopServiceForKind(kind);
            }
            activeKinds.clear();
            releaseWakeLockIfIdle();
        }
        if (instance == this) instance = null;
        super.handleOnDestroy();
    }

    private synchronized PowerManager.WakeLock getOrCreateWakeLock() {
        if (wakeLock == null) {
            PowerManager powerManager =
                    (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
            if (powerManager == null) {
                Log.w(TAG, "PowerManager unavailable; cannot create wake lock");
                return null;
            }
            wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_LOCK_TAG);
            wakeLock.setReferenceCounted(false);
        }
        return wakeLock;
    }

    private synchronized void acquireWakeLock() {
        PowerManager.WakeLock lock = getOrCreateWakeLock();
        if (lock == null) return;
        if (!lock.isHeld()) {
            lock.acquire(WATCHDOG_TIMEOUT_MS);
            Log.i(TAG, "wake lock acquired");
        } else {
            // Re-arm the watchdog so a long-running sync keeps the lock alive
            // past the backstop window (every progress update calls start/update).
            lock.acquire(WATCHDOG_TIMEOUT_MS);
        }
    }

    private synchronized void releaseWakeLockIfIdle() {
        if (!activeKinds.isEmpty()) return;
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
            Log.i(TAG, "wake lock released");
        }
    }

    private String normalizeKind(String kind) {
        return SyncForegroundService.KIND_DOWNLOADS.equals(kind)
                ? SyncForegroundService.KIND_DOWNLOADS
                : SyncForegroundService.KIND_IMAGES;
    }

    private void startServiceWith(String action, String kind, PluginCall call) {
        Intent intent = new Intent(getContext(), SyncForegroundService.class);
        intent.setAction(action);
        intent.putExtra(SyncForegroundService.EXTRA_KIND, kind);
        if (call != null) {
            String title = call.getString("title");
            String text = call.getString("text");
            if (title != null) intent.putExtra(SyncForegroundService.EXTRA_TITLE, title);
            if (text != null) intent.putExtra(SyncForegroundService.EXTRA_TEXT, text);
            Integer progress = call.getInt("progress");
            Integer max = call.getInt("max");
            Boolean indeterminate = call.getBoolean("indeterminate");
            if (progress != null) {
                intent.putExtra(SyncForegroundService.EXTRA_PROGRESS, progress.intValue());
            }
            if (max != null) intent.putExtra(SyncForegroundService.EXTRA_MAX, max.intValue());
            if (indeterminate != null) {
                intent.putExtra(
                        SyncForegroundService.EXTRA_INDETERMINATE, indeterminate.booleanValue());
            }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(intent);
        } else {
            getContext().startService(intent);
        }
    }

    private void stopServiceForKind(String kind) {
        // Each pipeline owns its own foreground-service instance + notification
        // id; stopping the (single) service class removes whichever notification
        // it last posted. Because both kinds share one Service class, we stop the
        // service only when NO kind remains active and otherwise re-post the
        // surviving kind's notification so it isn't torn down with the other.
        // Simpler + robust: cancel this kind's notification explicitly and stop
        // the service when it's the last one.
        android.app.NotificationManager nm =
                (android.app.NotificationManager)
                        getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        int id =
                SyncForegroundService.KIND_DOWNLOADS.equals(kind)
                        ? 0xF5C2
                        : 0xF5C1;
        if (nm != null) nm.cancel(id);
        if (activeKinds.isEmpty()) {
            Intent intent = new Intent(getContext(), SyncForegroundService.class);
            getContext().stopService(intent);
        }
    }

    @PluginMethod
    public void start(PluginCall call) {
        String kind = normalizeKind(call.getString("kind"));
        synchronized (this) {
            activeKinds.add(kind);
            acquireWakeLock();
        }
        startServiceWith(SyncForegroundService.ACTION_START, kind, call);
        Log.i(TAG, "start kind=" + kind);
        call.resolve();
    }

    @PluginMethod
    public void update(PluginCall call) {
        String kind = normalizeKind(call.getString("kind"));
        boolean wasActive;
        synchronized (this) {
            wasActive = activeKinds.contains(kind);
            // An update for a kind we don't think is active implies a missed
            // start (e.g. process restart mid-sync) — treat it as a start.
            activeKinds.add(kind);
            acquireWakeLock();
        }
        startServiceWith(
                wasActive ? SyncForegroundService.ACTION_UPDATE : SyncForegroundService.ACTION_START,
                kind,
                call);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        String kind = normalizeKind(call.getString("kind"));
        synchronized (this) {
            activeKinds.remove(kind);
            stopServiceForKind(kind);
            releaseWakeLockIfIdle();
        }
        Log.i(TAG, "stop kind=" + kind);
        call.resolve();
    }

    /**
     * Called from {@link SyncActionReceiver} (OS-created, no bridge handle) to
     * re-emit a notification Pause/Stop tap to JS as the `syncAction` event.
     */
    public static void dispatchSyncAction(String kind, String action) {
        SyncForegroundServicePlugin self = instance;
        if (self == null) {
            Log.w(TAG, "syncAction dropped — no live plugin instance");
            return;
        }
        JSObject data = new JSObject();
        data.put("kind", kind);
        data.put("action", action);
        self.notifyListeners("syncAction", data);
    }
}
