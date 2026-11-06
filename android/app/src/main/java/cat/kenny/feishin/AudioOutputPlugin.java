package cat.kenny.feishin;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.AudioManager;
import android.util.Log;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Forwards {@link AudioManager#ACTION_AUDIO_BECOMING_NOISY} to the renderer so
 * playback pauses when wired headphones are unplugged or a Bluetooth / USB
 * audio device disconnects (the Android convention: never let a track that was
 * playing privately fall through to the loudspeaker).
 *
 * The WebView's HTML5 audio does not react to this broadcast on its own. The
 * renderer listens for the {@code becomingNoisy} event and pauses through the
 * player store, so the UI, the media notification and any remote peer all see
 * the same pause a tap on the pause button would produce.
 *
 * Lifecycle: the receiver is registered for as long as the plugin (i.e. the
 * bridge + WebView) exists, NOT tied to activity resume/pause, because the
 * case that matters most is a backgrounded app with the screen off. The audio
 * lives inside the WebView, so once the bridge is destroyed there is nothing
 * left to pause and the receiver goes with it. The OS delays the actual route
 * change for about a second after this broadcast while music is active, which
 * leaves room for the round trip into JS.
 */
@CapacitorPlugin(name = "AudioOutput")
public class AudioOutputPlugin extends Plugin {

    private static final String TAG = "[audio-output]";

    static final String EVENT_BECOMING_NOISY = "becomingNoisy";

    private BroadcastReceiver noisyReceiver = null;

    @Override
    public void load() {
        noisyReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (!AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(intent.getAction())) return;
                Log.i(TAG, "audio becoming noisy (output device disconnected)");
                // Not retained: a stale "unplugged" delivered later (e.g. to a
                // listener added after a reload) must never pause new playback.
                notifyListeners(EVENT_BECOMING_NOISY, new JSObject());
            }
        };
        // System broadcast, so it still reaches a not-exported receiver; the
        // flag just keeps other apps from spoofing it.
        ContextCompat.registerReceiver(
            getContext(),
            noisyReceiver,
            new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY),
            ContextCompat.RECEIVER_NOT_EXPORTED
        );
        Log.i(TAG, "becoming-noisy receiver registered");
    }

    @Override
    protected void handleOnDestroy() {
        if (noisyReceiver != null) {
            try {
                getContext().unregisterReceiver(noisyReceiver);
                Log.i(TAG, "becoming-noisy receiver unregistered");
            } catch (IllegalArgumentException e) {
                // Already unregistered; nothing to do.
            }
            noisyReceiver = null;
        }
        super.handleOnDestroy();
    }
}
