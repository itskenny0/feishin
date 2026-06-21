// SyncGate — the top-level provider that blocks the authenticated app behind
// the first-full-sync dashboard. Mounted around the authenticated outlet
// (see router/app-outlet.tsx). When the gate verdict is `dashboard` it renders
// ONLY the blocking SyncDashboard (no routes, no player, no playback); when the
// verdict is `app` it renders its children (the normal app).
//
// Forced re-sync: the gate keys release off the PERSISTED per-server
// `firstSyncComplete` flag. An interrupted first sync never writes that flag,
// so on the next launch the gate re-enters the dashboard and the runner resumes
// the sweep from its Dexie checkpoints.

import type { ReactNode } from 'react';

import { useEffect, useMemo, useRef } from 'react';

import { useCacheStore } from '../store';
import { computeGateState } from './gate-state';
import { SyncDashboard } from './sync-dashboard';
import { useSyncRunner } from './use-sync-runner';

import { useCurrentServerWithCredential } from '/@/renderer/store/auth.store';
import { useSettingsStore } from '/@/renderer/store/settings.store';

const TAG = '[sync-gate]';

interface SyncGateProps {
    children: ReactNode;
}

export const SyncGate = ({ children }: SyncGateProps) => {
    const server = useCurrentServerWithCredential();
    const enabled = useSettingsStore((s) => s.localCache?.enabled === true);
    const entityToggles = useSettingsStore((s) => s.localCache?.entities);
    const firstSyncComplete = useSettingsStore((s) => s.localCache?.firstSyncComplete);
    const setFirstSyncComplete = useSettingsStore((s) => s.actions.setFirstSyncComplete);
    const cacheAvailable = useCacheStore((s) => s.cacheAvailable);
    const hydrationStates = useCacheStore((s) => s.hydrationStates);

    const serverId = server?.id;
    const persistedComplete = serverId ? firstSyncComplete?.[serverId] : undefined;

    const verdict = useMemo(
        () =>
            computeGateState({
                cacheAvailable,
                enabled,
                entityToggles,
                hydrationStates,
                persistedComplete,
                server: server ? { id: server.id, type: server.type, userId: server.userId } : null,
            }),
        [cacheAvailable, enabled, entityToggles, hydrationStates, persistedComplete, server],
    );

    // Trace verdict transitions (not every render).
    const lastShownRef = useRef<string | undefined>(undefined);
    useEffect(() => {
        const key = verdict.show === 'dashboard' ? 'dashboard' : `app:${verdict.reason}`;
        if (lastShownRef.current !== key) {
            lastShownRef.current = key;
            console.info(`${TAG} verdict`, { serverId, verdict: key });
        }
    }, [verdict, serverId]);

    if (verdict.show === 'dashboard' && server) {
        return (
            <BlockingDashboard
                onEscape={() => setFirstSyncComplete(server.id, true)}
                server={server}
            />
        );
    }

    return <>{children}</>;
};

// Inner component so `useSyncRunner` (which kicks off hydration + retries) only
// mounts while the gate is actually blocking. When the gate releases this
// unmounts, cancelling any pending retry timer.
const BlockingDashboard = ({
    onEscape,
    server,
}: {
    onEscape: () => void;
    server: Parameters<typeof useSyncRunner>[0];
}) => {
    const runner = useSyncRunner(server);
    return <SyncDashboard onContinueAnyway={onEscape} runner={runner} />;
};
