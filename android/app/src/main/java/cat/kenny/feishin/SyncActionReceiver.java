package cat.kenny.feishin;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * Receives the Pause / Stop notification-action broadcasts fired by the
 * per-pipeline sync notifications and forwards them to the live
 * {@link SyncForegroundServicePlugin} instance, which re-emits them to JS as the
 * Capacitor {@code syncAction} event. The renderer controller maps the event to
 * the right cancel ({@code cancelOfflineSync()} / sweep abort).
 *
 * A static handback to the plugin instance is used (rather than a second
 * Capacitor bridge) because the BroadcastReceiver is created by the OS and has
 * no bridge handle of its own.
 */
public class SyncActionReceiver extends BroadcastReceiver {

    private static final String TAG = "[sync-fgs]";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        String kind = intent.getStringExtra(SyncForegroundService.EXTRA_ACTION_KIND);
        if (kind == null) kind = SyncForegroundService.KIND_IMAGES;

        String mapped;
        if (SyncForegroundService.ACTION_NOTIFICATION_PAUSE.equals(action)) {
            mapped = "pause";
        } else if (SyncForegroundService.ACTION_NOTIFICATION_STOP.equals(action)) {
            mapped = "stop";
        } else {
            return;
        }

        Log.i(TAG, "notification action received kind=" + kind + " action=" + mapped);
        SyncForegroundServicePlugin.dispatchSyncAction(kind, mapped);
    }
}
