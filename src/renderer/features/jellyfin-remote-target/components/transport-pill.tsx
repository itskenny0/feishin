import type { TransportKind } from '/@/renderer/features/peer-sync/types';

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
import { memo, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useRemoteTarget } from '/@/renderer/features/jellyfin-remote-target/hooks/use-remote-target';
import {
    pickTransport,
    subscribe as subscribeTransport,
} from '/@/renderer/features/peer-sync/controller/transport-selector';
import { usePeerSyncSettings } from '/@/renderer/store';

type Lane = 'local' | TransportKind;

const laneColor: Record<Lane, string> = {
    jellyfin: 'grape',
    local: 'gray',
    mqtt: 'teal',
};

export const TransportPill = memo(() => {
    const { t } = useTranslation();
    const target = useRemoteTarget();
    const peerSync = usePeerSyncSettings();
    const [lane, setLane] = useState<Lane>('local');

    // Resolve the lane reactively. When there's no remote target it's
    // always "local"; otherwise we ask the transport selector and listen
    // for flips.
    useEffect(() => {
        const peerId = target.isRemote ? (target.deviceId ?? '') : '';
        if (!peerId) {
            setLane('local');
            return;
        }
        setLane(pickTransport(peerId));
        return subscribeTransport((flippedPeer, kind) => {
            if (flippedPeer === peerId) setLane(kind);
        });
    }, [target.isRemote, target.deviceId]);

    if (!peerSync.onboarded || !peerSync.jellyfinRemoteEnabled || !peerSync.ui.statusPill) {
        return null;
    }

    const label =
        lane === 'mqtt'
            ? t('common.transportMqtt', { defaultValue: 'MQTT' })
            : lane === 'jellyfin'
              ? t('common.transportJellyfin', { defaultValue: 'Jellyfin' })
              : t('common.transportLocal', { defaultValue: 'Local' });

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
