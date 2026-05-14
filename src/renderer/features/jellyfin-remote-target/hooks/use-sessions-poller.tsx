// src/renderer/features/jellyfin-remote-target/hooks/use-sessions-poller.tsx
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { shallow } from 'zustand/shallow';

import { sessionsPoller } from '/@/renderer/features/jellyfin-remote-target/controller/sessions-poller';
import { useRemoteTargetStore } from '/@/renderer/features/jellyfin-remote-target/store/remote-target-store';
import { useAuthStore } from '/@/renderer/store/auth.store';
import { useRemoteTargetSetting } from '/@/renderer/store/settings.store';
import { toast } from '/@/shared/components/toast/toast';
import { ServerType } from '/@/shared/types/domain-types';

export const useSessionsPoller = () => {
    const { t } = useTranslation();
    const currentServer = useAuthStore((s) => s.currentServer, shallow);
    const targetDeviceId = useRemoteTargetStore((s) => s.targetDeviceId);
    const isPickerOpen = useRemoteTargetStore((s) => s.pickerOpen);

    const persisted = useRemoteTargetSetting();
    useEffect(() => {
        if (!persisted.deviceId || !persisted.deviceName) return;
        const state = useRemoteTargetStore.getState();
        if (state.targetDeviceId) return;
        // Set the target with a placeholder sessionId; the next poll tick will
        // reconcile to the real sessionId or fall back to local if missing.
        state.actions.setTarget({
            capabilities: [],
            deviceId: persisted.deviceId,
            deviceName: persisted.deviceName,
            sessionId: '__pending__',
        });
        state.actions.setStatus('reconnecting');
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
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
            server: currentServer,
            onOffline: (deviceName) =>
                toast.info({
                    message: t('page.remoteTarget.wentOffline', { deviceName }),
                }),
        });
        return () => sessionsPoller.stop();
    }, [currentServer, isPickerOpen, t, targetDeviceId]);
};

export const SessionsPollerHook = () => {
    useSessionsPoller();
    return null;
};
