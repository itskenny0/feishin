// "What's the difference?" explainer for the device picker: MQTT peer-sync
// vs plain Jellyfin remote control. Opened from the picker header so users
// understand why MQTT-capable devices are preferred (and why non-MQTT
// clients are hidden by default once peer-sync is configured).

import { openModal } from '@mantine/modals';
import { useTranslation } from 'react-i18next';

import { Icon } from '/@/shared/components/icon/icon';
import { Stack } from '/@/shared/components/stack/stack';
import { Text } from '/@/shared/components/text/text';

interface ComparisonRow {
    jellyfin: string;
    mqtt: string;
    topic: string;
}

const TransportComparisonContent = () => {
    const { t } = useTranslation();

    const rows: ComparisonRow[] = [
        {
            jellyfin: t('page.remoteTarget.compare.latencyJellyfin', {
                defaultValue: 'Polls the server every few seconds — controls feel delayed.',
            }),
            mqtt: t('page.remoteTarget.compare.latencyMqtt', {
                defaultValue:
                    'Pushes instantly over a live connection — controls react in milliseconds.',
            }),
            topic: t('page.remoteTarget.compare.latency', { defaultValue: 'Speed & latency' }),
        },
        {
            jellyfin: t('page.remoteTarget.compare.accuracyJellyfin', {
                defaultValue:
                    'Only sees what the server reports: the current track and rough position. The upcoming queue is often missing or stale.',
            }),
            mqtt: t('page.remoteTarget.compare.accuracyMqtt', {
                defaultValue:
                    'Mirrors the full player state: exact position, play queue including shuffle order, repeat mode and upcoming tracks.',
            }),
            topic: t('page.remoteTarget.compare.accuracy', { defaultValue: 'Data accuracy' }),
        },
        {
            jellyfin: t('page.remoteTarget.compare.controlJellyfin', {
                defaultValue: 'Basic transport only: play/pause, next/previous, seek, volume.',
            }),
            mqtt: t('page.remoteTarget.compare.controlMqtt', {
                defaultValue:
                    'Full two-way control: transport, volume, queue edits, shuffle/repeat — and the remote device reports back immediately.',
            }),
            topic: t('page.remoteTarget.compare.control', { defaultValue: 'Control depth' }),
        },
        {
            jellyfin: t('page.remoteTarget.compare.loadJellyfin', {
                defaultValue: 'Constant polling adds load on the Jellyfin server.',
            }),
            mqtt: t('page.remoteTarget.compare.loadMqtt', {
                defaultValue:
                    'Devices talk peer-to-peer through the broker — no extra load on the media server.',
            }),
            topic: t('page.remoteTarget.compare.load', { defaultValue: 'Server load' }),
        },
        {
            jellyfin: t('page.remoteTarget.compare.setupJellyfin', {
                defaultValue: 'Works out of the box with any Jellyfin client (web, TV, mobile).',
            }),
            mqtt: t('page.remoteTarget.compare.setupMqtt', {
                defaultValue:
                    'Needs Sync & Connect set up on both devices (same broker + room key).',
            }),
            topic: t('page.remoteTarget.compare.setup', { defaultValue: 'Setup' }),
        },
    ];

    return (
        <Stack gap="md">
            <Text isMuted size="sm">
                {t('page.remoteTarget.compare.intro', {
                    defaultValue:
                        'Devices can be controlled over two different channels. MQTT (Sync & Connect) is the better experience whenever both devices support it.',
                })}
            </Text>
            {rows.map((row) => (
                <Stack gap={4} key={row.topic}>
                    <Text fw={600} size="sm">
                        {row.topic}
                    </Text>
                    <Text size="sm">
                        <Text component="span" fw={600}>
                            MQTT:{' '}
                        </Text>
                        {row.mqtt}
                    </Text>
                    <Text isMuted size="sm">
                        <Text component="span" fw={600}>
                            Jellyfin:{' '}
                        </Text>
                        {row.jellyfin}
                    </Text>
                </Stack>
            ))}
            <Text isMuted size="xs">
                <Icon icon="info" size="sm" />{' '}
                {t('page.remoteTarget.compare.hideHint', {
                    defaultValue:
                        "With Sync & Connect configured, Jellyfin-only clients are hidden from this picker by default — switch off 'Hide devices without MQTT' in Settings to show them.",
                })}
            </Text>
        </Stack>
    );
};

export const openTransportComparisonModal = (title: string): void => {
    openModal({
        children: <TransportComparisonContent />,
        size: 'lg',
        title,
    });
};
