// src/renderer/features/jellyfin-remote-target/hooks/use-sessions-poller.tsx
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { shallow } from 'zustand/shallow';

import { sessionsPoller } from '/@/renderer/features/jellyfin-remote-target/controller/sessions-poller';
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

    const currentServer = useAuthStore((s) => s.currentServer, shallow);
    const targetDeviceId = useRemoteTargetStore((s) => s.targetDeviceId);
    const isPickerOpen = useRemoteTargetStore((s) => s.pickerOpen);
    const jellyfinRemoteEnabled = usePeerSyncSettings().jellyfinRemoteEnabled;

    useEffect(() => {
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
        return () => sessionsPoller.stop();
    }, [currentServer, isPickerOpen, jellyfinRemoteEnabled, targetDeviceId]);
};

export const SessionsPollerHook = () => {
    useSessionsPoller();
    return null;
};
