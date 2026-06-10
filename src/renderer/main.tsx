import { Capacitor } from '@capacitor/core';
import {
    PersistedClient,
    Persister,
    PersistQueryClientProvider,
} from '@tanstack/react-query-persist-client';
import { Buffer as BufferPolyfill } from 'buffer';
import { del, get, set } from 'idb-keyval';
import { createRoot } from 'react-dom/client';

import { App } from '/@/renderer/app';
import { initRemoteLogShipper } from '/@/renderer/debug/remote-log-shipper';
import { queryClient } from '/@/renderer/lib/react-query';
import { installConsoleCapture } from '/@/renderer/utils/console-capture';

// mqtt.js v5 (and its `mqtt-packet` dep) reach for `globalThis.Buffer` and
// `Buffer.from` at runtime. The Electron renderer has Node's Buffer
// available; the web build does not, so any code path that touches the
// peer-sync MQTT client (peer-client publish / lwt / encoded frames) used
// to throw "Buffer is not defined" the moment a user finished the
// Sync & Connect setup wizard. Polyfill once, eagerly, before anything
// imports `mqtt`. The cost is a small bundle delta + a single object
// assignment at boot.
if (typeof globalThis.Buffer === 'undefined') {
    (globalThis as unknown as { Buffer: typeof BufferPolyfill }).Buffer = BufferPolyfill;
    console.info('[boot] installed Buffer polyfill for the web build');
}

// Capture every console.log/warn/error/info into an in-memory ring buffer
// so mobile users (Capacitor on Android / iOS) can view logs from the
// settings panel — they have no devtools console.
installConsoleCapture();
// After console capture so the shipper's wrapper is outermost and sees every
// log line. No-op unless settings.remoteDebug is enabled.
initRemoteLogShipper();

/*
 * On a Capacitor Android cold start, the WebView often restores the
 * last URL hash from its saved-instance state — so opening the app
 * deep-drops the user back into a track-detail page or playlist they
 * had open last week, which is disorienting. (Spotify, Apple Music
 * and YouTube Music all cold-start on the Home tab.)
 *
 * Run BEFORE React mounts so the HashRouter reads `#/` for its first
 * navigation event and never paints the stale route. The check is
 * gated on Capacitor.getPlatform() === 'android' so Electron / web /
 * iOS users keep their existing in-session hash (e.g. URL deep-links
 * from notification taps or share sheets still work).
 */
if (Capacitor.getPlatform() === 'android') {
    // Empty string clears the hash without leaving a stray '#' in the
    // address bar. HashRouter treats no hash as the root route.
    window.location.hash = '';
}

function createIDBPersister(idbValidKey: IDBValidKey = 'reactQuery') {
    return {
        persistClient: async (client: PersistedClient) => {
            set(idbValidKey, client);
        },
        removeClient: async () => {
            await del(idbValidKey);
        },
        restoreClient: async () => {
            return await get<PersistedClient>(idbValidKey);
        },
    } as Persister;
}

const indexedDbPersister = createIDBPersister('feishin');

createRoot(document.getElementById('root')!).render(
    <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{
            buster: 'feishin',
            dehydrateOptions: {
                shouldDehydrateQuery: (query) => {
                    const isSuccess = query.state.status === 'success';
                    const isLyricsQueryKey =
                        query.queryKey.includes('song') &&
                        query.queryKey.includes('lyrics') &&
                        query.queryKey.includes('select');

                    return isSuccess && isLyricsQueryKey;
                },
            },
            hydrateOptions: {
                defaultOptions: {
                    queries: {
                        // Cache lyrics for a week so a song you played a few
                        // days ago still loads instantly, but the IndexedDB
                        // store doesn't grow without bound.
                        gcTime: 1000 * 60 * 60 * 24 * 7,
                    },
                },
            },
            // Discard the persisted lyric cache after 30 days so the hydration
            // payload stays small over years of use.
            maxAge: 1000 * 60 * 60 * 24 * 30,
            persister: indexedDbPersister,
        }}
    >
        <App />
    </PersistQueryClientProvider>,
);
