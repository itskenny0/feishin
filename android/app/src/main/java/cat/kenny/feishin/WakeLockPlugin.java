package cat.kenny.feishin;

import android.content.Context;
import android.os.PowerManager;
import android.util.Log;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Self-contained partial wake-lock bridge for reliable background audio.
 *
 * The @jofr/capacitor-media-session plugin already starts a typed
 * {@code mediaPlayback} foreground service while playback is active, which
 * keeps the app process from being reclaimed and posts the media
 * notification. That FGS is necessary but NOT sufficient on aggressive
 * OEM builds (MIUI / HyperOS on the Mi 9T, ColorOS, OneUI, …): the
 * foreground service stops the process from being *killed*, but it does
 * not by itself stop the CPU from entering deep sleep when the screen is
 * off. Once the SoC suspends, the WebView's HTML5 {@code <audio>} element
 * stalls — playback audibly stutters and then halts within a minute or
 * two of backgrounding, and the OS may then tear the (now-idle) process
 * down entirely.
 *
 * Holding a {@link android.os.PowerManager#PARTIAL_WAKE_LOCK PARTIAL_WAKE_LOCK}
 * keeps the CPU running with the screen off, which is exactly what an audio
 * player needs while a track is playing. We acquire it on play and release
 * it on pause/stop (the renderer applies a short grace period before the
 * stop release so brief pause→play gaps don't thrash the lock).
 *
 * This is intentionally a tiny, dependency-free plugin (PowerManager +
 * com.getcapacitor only) rather than a patch to the third-party
 * media-session plugin in node_modules, which must stay vendor-owned.
 *
 * Method surface (all resolve immediately):
 *   - acquire()  -> ensure the partial wake lock is held (idempotent).
 *   - release()  -> release the partial wake lock if held (idempotent).
 *   - isHeld()   -> resolves { held: boolean }.
 *
 * The lock is reference-count-disabled (setReferenceCounted(false)) so
 * acquire/release are pure idempotent set/clear operations and a missed
 * release can never strand a lock across the play/pause boundary. A
 * watchdog timeout is applied as a backstop so a renderer crash mid-play
 * can never pin the CPU awake indefinitely.
 */
@CapacitorPlugin(name = "WakeLock")
public class WakeLockPlugin extends Plugin {

    private static final String TAG = "[wake-lock]";

    // Tag is surfaced in `dumpsys power` / battery historian, so make it
    // identifiable rather than generic.
    private static final String WAKE_LOCK_TAG = "feishin:playback";

    // Backstop so a renderer crash mid-playback cannot pin the CPU awake
    // forever. 10 minutes comfortably exceeds the longest single track we
    // expect; the renderer re-acquires on the next position tick / status
    // push well inside this window, so a still-playing track never lets the
    // lock lapse in practice.
    private static final long WATCHDOG_TIMEOUT_MS = 10 * 60 * 1000L;

    private PowerManager.WakeLock wakeLock = null;

    private synchronized PowerManager.WakeLock getOrCreateWakeLock() {
        if (wakeLock == null) {
            PowerManager powerManager =
                    (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
            if (powerManager == null) {
                Log.w(TAG, "PowerManager unavailable; cannot create wake lock");
                return null;
            }
            wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_LOCK_TAG);
            // Idempotent acquire/release semantics: one acquire is matched by
            // one release regardless of how many times each is called.
            wakeLock.setReferenceCounted(false);
        }
        return wakeLock;
    }

    @PluginMethod
    public void acquire(PluginCall call) {
        synchronized (this) {
            PowerManager.WakeLock lock = getOrCreateWakeLock();
            if (lock == null) {
                call.reject("PowerManager unavailable");
                return;
            }
            if (!lock.isHeld()) {
                lock.acquire(WATCHDOG_TIMEOUT_MS);
                Log.i(TAG, "partial wake lock acquired");
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void release(PluginCall call) {
        synchronized (this) {
            if (wakeLock != null && wakeLock.isHeld()) {
                wakeLock.release();
                Log.i(TAG, "partial wake lock released");
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void isHeld(PluginCall call) {
        com.getcapacitor.JSObject result = new com.getcapacitor.JSObject();
        synchronized (this) {
            result.put("held", wakeLock != null && wakeLock.isHeld());
        }
        call.resolve(result);
    }

    @Override
    protected void handleOnDestroy() {
        // Defensive: never let the activity teardown leak a held CPU lock.
        synchronized (this) {
            if (wakeLock != null && wakeLock.isHeld()) {
                wakeLock.release();
                Log.i(TAG, "partial wake lock released on destroy");
            }
        }
        super.handleOnDestroy();
    }
}
