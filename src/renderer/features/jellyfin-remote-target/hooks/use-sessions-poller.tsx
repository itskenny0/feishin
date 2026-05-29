// src/renderer/features/jellyfin-remote-target/hooks/use-sessions-poller.tsx
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { shallow } from 'zustand/shallow';

import { sessionsPoller } from '/@/renderer/features/jellyfin-remote-target/controller/sessions-poller';
import { sessionsSink } from '/@/renderer/features/jellyfin-remote-target/controller/sessions-sink';
import {
    SessionsSocket,
    type SessionsSocketState,
} from '/@/renderer/features/jellyfin-remote-target/controller/sessions-socket';
import { useRemoteTargetStore } from '/@/renderer/features/jellyfin-remote-target/store/remote-target-store';
import { useAuthStore } from '/@/renderer/store/auth.store';
import { usePeerSyncSettings } from '/@/renderer/store/settings.store';
import { toast } from '/@/shared/components/toast/toast';
import { ServerType } from '/@/shared/types/domain-types';

// Intentionally no auto-restore on mount: a fresh launch always lands on local
// playback. The persisted `playback.remoteTargetDeviceId/Name` setting is kept
// around as a "last connected" memory for the picker, but the user must
// explicitly re-select a device before any remote-target side effect runs.
export const useSessionsPoller = () => {
    const { t } = useTranslation();
    // Carry the latest `t` into the offline callback via a ref so the poller
    // effect doesn't restart on language change — restarting wipes the
    // optimistic-hold and hasPolledOnce flags, which makes the picker flash
    // "Searching…" and lets a stale poll clobber a fresh optimistic update.
    const tRef = useRef(t);
    tRef.current = t;

    // Track the last server id we bound to so we can reset the shared
    // sessionsSink only when the active server actually changes. updateServer
    // (token / musicFolder refresh) replaces the currentServer object while
    // keeping the same id, so we compare ids — not object identity — to avoid
    // spuriously dropping the queue cache on a benign refresh.
    const prevServerIdRef = useRef<null | string>(null);

    const currentServer = useAuthStore((s) => s.currentServer, shallow);
    // The local Jellyfin Sessions deviceId — baked into the SessionsSocket
    // URL at connect time. We watch it here so a deviceId rotation (re-login
    // on the same server) tears the socket down and re-binds under the new id;
    // Jellyfin keys sessions by deviceId, so an old subscription leaks.
    const authDeviceId = useAuthStore((s) => s.deviceId);
    const targetDeviceId = useRemoteTargetStore((s) => s.targetDeviceId);
    const isPickerOpen = useRemoteTargetStore((s) => s.pickerOpen);
    const jellyfinRemoteEnabled = usePeerSyncSettings().jellyfinRemoteEnabled;

    useEffect(() => {
        // Reset the shared sink's per-device queue cache + hydrate backoff
        // whenever the bound server id actually changes (or on sign-out). The
        // sink keys those by deviceId only, so a deviceId that exists on both
        // server A and B would otherwise carry A's stale queue ids / backoff
        // into B and suppress re-hydration of B's queue for up to 30s. Only
        // the controllable-TARGET hook reset the sink before; the controller
        // lane (this hook) never did. Guard on id so a token/musicFolder
        // refresh (same id, new object) does not wipe a healthy cache.
        const nextServerId = currentServer?.id ?? null;
        if (prevServerIdRef.current !== nextServerId) {
            console.info('[remote-target] server changed — resetting sessions sink cache', {
                from: prevServerIdRef.current,
                to: nextServerId,
            });
            sessionsSink.reset();
            // E1 (secondary): when the active server genuinely changes (not the
            // first bind), clear any remote target that belonged to the old
            // server so its stale 'connected'/'reconnecting' chrome doesn't
            // linger. The getRemoteCtx server-id guard already blocks the
            // cross-server command leak; this releases the orphaned UI/target.
            if (prevServerIdRef.current !== null) {
                const rt = useRemoteTargetStore.getState();
                if (rt.targetDeviceId) {
                    console.info('[remote-target] clearing target after server switch', {
                        deviceId: rt.targetDeviceId,
                    });
                    rt.actions.clearTarget();
                }
            }
            prevServerIdRef.current = nextServerId;
        }

        if (!jellyfinRemoteEnabled) {
            sessionsPoller.stop();
            return;
        }
        if (!currentServer || currentServer.type !== ServerType.JELLYFIN) {
            sessionsPoller.stop();
            return;
        }
        if (!currentServer.credential) {
            sessionsPoller.stop();
            return;
        }
        if (!targetDeviceId && !isPickerOpen) {
            sessionsPoller.stop();
            return;
        }
        sessionsPoller.start({
            onOffline: (deviceName) =>
                toast.info({
                    message: tRef.current('page.remoteTarget.wentOffline', { deviceName }),
                }),
            server: currentServer,
        });

        // Native Jellyfin push lane. Real-time per-PlayState frames cut the
        // click → mirror floor from ~400ms (active-window poll) to ~50ms.
        // When the socket reports connected, gate the poller down to a 10s
        // safety-net cadence. When the socket drops, the poller's normal 2s
        // tick automatically resumes — both lanes feed sessionsSink.apply()
        // identically, so the two transports are fully interchangeable.
        let socket: null | SessionsSocket = null;
        // Capture the server in closure so a late-arriving frame from a
        // server we've just signed out of doesn't poison the store. The
        // effect cleanup tears the socket down before the next server gets
        // wired up.
        const boundServer = currentServer;
        try {
            socket = new SessionsSocket({
                onSessionsFrame: (rows) => {
                    try {
                        sessionsSink.apply(rows, boundServer);
                    } catch (err) {
                        console.warn('[remote-target] socket sink apply failed', err);
                    }
                },
                onStateChange: (next: SessionsSocketState) => {
                    sessionsPoller.setFallbackMode(next === 'connected');
                },
                server: boundServer,
            });
            socket.start();
        } catch (err) {
            // The socket is opt-in extra latency — if construction fails for
            // any reason (e.g. WebSocket undefined in some embedded webview)
            // the poller continues to drive Sessions sync at full cadence.
            console.warn('[remote-target] socket start failed — staying on poll', err);
            socket = null;
        }

        return () => {
            socket?.stop();
            sessionsPoller.stop();
        };
    }, [authDeviceId, currentServer, isPickerOpen, jellyfinRemoteEnabled, targetDeviceId]);
};

export const SessionsPollerHook = () => {
    useSessionsPoller();
    return null;
};
