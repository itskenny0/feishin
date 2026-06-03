// Critical-path features: evaluated eagerly at main-process startup because
// they are needed before / during first paint (player + media keys, settings
// store, lyrics providers, the local visualizer display-media gate, and the
// remote server whose shutdownServer() is wired into index.ts's window-quit
// handler).
import './lyrics';
import './player';
import './remote';
import './settings';
import './visualizer';

// Deferred features: these only register IPC handlers that the renderer
// invokes *after* it has loaded and the user takes an action (Discord RPC
// connect, LAN autodiscover ping, peer-sync broker opt-in, native TCP socket
// for the MQTT transport). None of them are imported elsewhere in the main
// process, and pulling in their heavy node deps (aedes, bonjour-service,
// @xhayper/discord-rpc, mqtt) is pure startup tax. Loading them on a
// post-startup microtask keeps that cost off the boot critical path without
// changing behaviour — the handlers are registered well before any renderer
// IPC can reach them.
let deferredFeaturesLoaded = false;

export const loadDeferredCoreFeatures = (): void => {
    if (deferredFeaturesLoaded) return;
    deferredFeaturesLoaded = true;

    console.info(
        '[startup] loading deferred core features (discord-rpc, autodiscover, peer-broker, tcp-socket)',
    );

    Promise.all([
        import('./autodiscover'),
        import('./discord-rpc'),
        import('./peer-broker'),
        import('./tcp-socket'),
    ])
        .then(() => {
            console.info('[startup] deferred core features ready');
        })
        .catch((error) => {
            console.error('[startup] failed to load deferred core features', error);
        });
};
