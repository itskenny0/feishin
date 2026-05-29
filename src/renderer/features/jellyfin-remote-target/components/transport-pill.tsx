import type { TransportKind } from '/@/renderer/features/peer-sync/types';
import type { TFunction } from 'i18next';

/**
 * Tiny status pill that lives next to the Connect button in the player bar
 * and announces which transport is driving playback right now:
 *
 *   - "Local"    — no remote target selected
 *   - "Jellyfin" — controlling a remote device over Jellyfin Sessions polling
 *   - "MQTT"     — controlling a remote peer over the MQTT lane
 *
 * Hidden until peer sync is onboarded AND the per-element visibility toggle
 * is on. Stateless on its own — derives everything from the existing
 * remote-target hooks and the transport selector.
 */
import { Badge } from '@mantine/core';
import { memo, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useRemoteTarget } from '/@/renderer/features/jellyfin-remote-target/hooks/use-remote-target';
import {
    getPeerIdForJellyfinDeviceId,
    pickTransportByJellyfinDeviceId,
    subscribe as subscribeTransport,
} from '/@/renderer/features/peer-sync/controller/transport-selector';
import { usePeerSyncSettings } from '/@/renderer/store';

export type Lane = 'local' | TransportKind;

const laneColor: Record<Lane, string> = {
    jellyfin: 'grape',
    local: 'gray',
    mqtt: 'teal',
};

/**
 * Shared human-facing label for a sync lane. The transport pill and the
 * Connect diagnostics tables MUST render the same vocabulary, so this is the
 * single mapping both call sites use — keep it here as the canonical source.
 */
export const laneLabel = (lane: Lane, t: TFunction): string => {
    switch (lane) {
        case 'jellyfin':
            return t('common.transportJellyfin', { defaultValue: 'Jellyfin' });
        case 'mqtt':
            return t('common.transportMqtt', { defaultValue: 'MQTT' });
        default:
            return t('common.transportLocal', { defaultValue: 'Local' });
    }
};

export const TransportPill = memo(() => {
    const { t } = useTranslation();
    const target = useRemoteTarget();
    const peerSync = usePeerSyncSettings();
    const [lane, setLane] = useState<Lane>('local');

    // Hold the current target's Jellyfin deviceId in a ref so the flip
    // subscription can read the live value without being torn down and
    // re-created on every target change. The selector's `subscribe` is a
    // module-level Set; re-subscribing on each target flip churned the
    // listener set for no benefit (B5). We subscribe ONCE on mount and the
    // listener always resolves against the *current* target.
    const jfDeviceIdRef = useRef('');
    jfDeviceIdRef.current = target.isRemote ? (target.deviceId ?? '') : '';

    // Re-resolve the lane whenever the target changes. When there's no
    // remote target it's always "local"; otherwise we ask the transport
    // selector — via the Jellyfin-deviceId bridge, since `target.deviceId`
    // is the Jellyfin Sessions deviceId, not the MQTT peerId.
    useEffect(() => {
        const jfDeviceId = jfDeviceIdRef.current;
        setLane(jfDeviceId ? pickTransportByJellyfinDeviceId(jfDeviceId) : 'local');
    }, [target.isRemote, target.deviceId]);

    // Subscribe to transport flips exactly once. The listener reads the live
    // target deviceId from the ref and re-resolves when the flip concerns OUR
    // target (current bridge mapping) OR when there's no mapping yet — the
    // flip may be the one that establishes it.
    useEffect(() => {
        return subscribeTransport((flippedPeer) => {
            const jfDeviceId = jfDeviceIdRef.current;
            if (!jfDeviceId) return;
            const targetPeerId = getPeerIdForJellyfinDeviceId(jfDeviceId);
            if (!targetPeerId || flippedPeer === targetPeerId) {
                setLane(pickTransportByJellyfinDeviceId(jfDeviceId));
            }
        });
    }, []);

    if (!peerSync.onboarded || !peerSync.jellyfinRemoteEnabled || !peerSync.ui.statusPill) {
        return null;
    }

    const label = laneLabel(lane, t);

    return (
        <Badge
            color={laneColor[lane]}
            size="sm"
            title={t('common.transportPillTooltip', {
                defaultValue: 'Active sync lane',
            })}
            variant={lane === 'local' ? 'outline' : 'light'}
        >
            {label}
        </Badge>
    );
});

TransportPill.displayName = 'TransportPill';
