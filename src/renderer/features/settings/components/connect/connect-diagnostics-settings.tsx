/**
 * Connect -> Diagnostics. Read-only view of peer-sync's live state:
 *   - MQTT client connection status + last error
 *   - Embedded broker status (desktop only)
 *   - Known peers and presence freshness
 *   - Last command frames (in and out)
 *   - Last state frames
 *   - Recent transport lane flips
 *   - Latency samples (when available)
 */
import { Alert, Badge, Group, ScrollArea, Stack, Table } from '@mantine/core';
import { memo, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
    type BrokerConnectionStatus,
    useDiagnostics,
} from '/@/renderer/features/peer-sync/diagnostics/diagnostics-store';
import { resetDiagnostics } from '/@/renderer/features/peer-sync/diagnostics/diagnostics-store';
import { SettingsSection } from '/@/renderer/features/settings/components/settings-section';
import { usePeerSyncSettings } from '/@/renderer/store/settings.store';
import { Button } from '/@/shared/components/button/button';
import { Text } from '/@/shared/components/text/text';

const statusColor: Record<BrokerConnectionStatus, string> = {
    connected: 'teal',
    connecting: 'yellow',
    disconnected: 'gray',
    errored: 'red',
    idle: 'gray',
};

const formatRelative = (ts: number | undefined, now: number): string => {
    if (!ts) return '—';
    const dt = Math.max(0, now - ts);
    if (dt < 1500) return 'just now';
    if (dt < 60_000) return `${Math.round(dt / 1000)}s ago`;
    if (dt < 3_600_000) return `${Math.round(dt / 60_000)}m ago`;
    return `${Math.round(dt / 3_600_000)}h ago`;
};

const peerLabel = (peerId: string): string => {
    if (!peerId) return '(unknown)';
    return peerId.length > 12 ? `${peerId.slice(0, 6)}…${peerId.slice(-4)}` : peerId;
};

export const ConnectDiagnosticsSettings = memo(() => {
    const { t } = useTranslation();
    const settings = usePeerSyncSettings();

    const broker = useDiagnostics((s) => s.broker);
    const embedded = useDiagnostics((s) => s.embeddedBroker);
    const presence = useDiagnostics((s) => s.presence);
    const commands = useDiagnostics((s) => s.commands);
    const states = useDiagnostics((s) => s.states);
    const flips = useDiagnostics((s) => s.flips);
    const latency = useDiagnostics((s) => s.latency);

    // 1Hz tick to refresh relative timestamps without re-rendering on every
    // store mutation. Subscribing to setState keeps the entries fresh; this
    // tick just keeps the "12s ago" strings honest. Seed at 0 so the initial
    // render is deterministic (Date.now() in the render path violates the
    // react-hooks/purity rule); the effect bumps it immediately on mount.
    const [now, setNow] = useState(0);
    useEffect(() => {
        setNow(Date.now());
        const id = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(id);
    }, []);

    const presenceList = useMemo(() => Object.values(presence), [presence]);

    if (!settings.enabled) {
        return (
            <Alert color="gray" variant="light">
                {t('page.setting.connectDiagnosticsDisabled', {
                    defaultValue:
                        'Peer sync is disabled. Turn it on under Connect -> Jellyfin Connect (MQTT) to see live diagnostics here.',
                })}
            </Alert>
        );
    }

    return (
        <Stack gap="lg">
            <SettingsSection
                options={[
                    {
                        control: (
                            <Group gap="xs">
                                <Badge
                                    color={statusColor[broker.clientStatus]}
                                    size="lg"
                                    variant="filled"
                                >
                                    {broker.clientStatus}
                                </Badge>
                                <Text isMuted size="sm">
                                    {formatRelative(broker.lastTransitionAt, now)}
                                </Text>
                            </Group>
                        ),
                        description: (
                            <Stack gap={2}>
                                <Text isMuted isNoSelect size="sm">
                                    {settings.brokerUrl ||
                                        t('page.setting.diagnosticsBrokerAutoDiscover', {
                                            defaultValue: 'Auto-discover via mDNS',
                                        })}
                                </Text>
                                {broker.lastErrorMessage && (
                                    <Text c="red" size="sm">
                                        {broker.lastErrorMessage}
                                    </Text>
                                )}
                            </Stack>
                        ),
                        title: t('page.setting.diagnosticsBroker', {
                            defaultValue: 'MQTT client',
                        }),
                    },
                    {
                        control: (
                            <Badge
                                color={embedded.running ? 'teal' : 'gray'}
                                size="lg"
                                variant={embedded.running ? 'filled' : 'outline'}
                            >
                                {embedded.running
                                    ? 'running'
                                    : embedded.enabled
                                      ? 'stopped'
                                      : 'off'}
                            </Badge>
                        ),
                        description: (
                            <Text isMuted isNoSelect size="sm">
                                {embedded.listenAddress ||
                                    t('page.setting.diagnosticsEmbeddedOff', {
                                        defaultValue: 'Embedded broker is off',
                                    })}
                            </Text>
                        ),
                        title: t('page.setting.diagnosticsEmbedded', {
                            defaultValue: 'Embedded broker',
                        }),
                    },
                ]}
            />

            <Stack gap="xs">
                <Group justify="space-between">
                    <Text fw={600}>
                        {t('page.setting.diagnosticsPeers', { defaultValue: 'Peers' })}
                    </Text>
                    <Text isMuted size="sm">
                        {presenceList.length}
                    </Text>
                </Group>
                {presenceList.length === 0 ? (
                    <Text isMuted size="sm">
                        {t('page.setting.diagnosticsNoPeers', {
                            defaultValue: 'No peers seen yet.',
                        })}
                    </Text>
                ) : (
                    <Table withTableBorder>
                        <Table.Thead>
                            <Table.Tr>
                                <Table.Th>{t('common.peer', { defaultValue: 'Peer' })}</Table.Th>
                                <Table.Th>
                                    {t('common.status', { defaultValue: 'Status' })}
                                </Table.Th>
                                <Table.Th>
                                    {t('common.lastSeen', { defaultValue: 'Last seen' })}
                                </Table.Th>
                                <Table.Th>{t('common.rtt', { defaultValue: 'RTT' })}</Table.Th>
                            </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                            {presenceList.map((p) => {
                                const lat = latency[p.peerId];
                                return (
                                    <Table.Tr key={p.peerId}>
                                        <Table.Td>{peerLabel(p.peerId)}</Table.Td>
                                        <Table.Td>
                                            <Badge
                                                color={p.online ? 'teal' : 'gray'}
                                                size="sm"
                                                variant={p.online ? 'filled' : 'outline'}
                                            >
                                                {p.online ? 'online' : 'offline'}
                                            </Badge>
                                        </Table.Td>
                                        <Table.Td>{formatRelative(p.lastSeenAt, now)}</Table.Td>
                                        <Table.Td>
                                            {lat ? `${Math.round(lat.rttMs)} ms` : '—'}
                                        </Table.Td>
                                    </Table.Tr>
                                );
                            })}
                        </Table.Tbody>
                    </Table>
                )}
            </Stack>

            <Stack gap="xs">
                <Group justify="space-between">
                    <Text fw={600}>
                        {t('page.setting.diagnosticsCommands', {
                            defaultValue: 'Recent commands',
                        })}
                    </Text>
                    <Text isMuted size="sm">
                        {commands.length}
                    </Text>
                </Group>
                {commands.length === 0 ? (
                    <Text isMuted size="sm">
                        {t('page.setting.diagnosticsNoCommands', {
                            defaultValue: 'No commands yet.',
                        })}
                    </Text>
                ) : (
                    <ScrollArea h={180} type="auto">
                        <Table>
                            <Table.Tbody>
                                {[...commands].reverse().map((c, i) => (
                                    <Table.Tr key={`${c.ts}-${i}`}>
                                        <Table.Td style={{ width: 60 }}>
                                            <Badge
                                                color={
                                                    c.direction === 'outbound' ? 'blue' : 'grape'
                                                }
                                                size="sm"
                                                variant="light"
                                            >
                                                {c.direction === 'outbound' ? 'OUT' : 'IN'}
                                            </Badge>
                                        </Table.Td>
                                        <Table.Td style={{ width: 100 }}>{c.k}</Table.Td>
                                        <Table.Td>{peerLabel(c.peerId)}</Table.Td>
                                        <Table.Td style={{ textAlign: 'right', width: 80 }}>
                                            {formatRelative(c.ts, now)}
                                        </Table.Td>
                                    </Table.Tr>
                                ))}
                            </Table.Tbody>
                        </Table>
                    </ScrollArea>
                )}
            </Stack>

            <Stack gap="xs">
                <Group justify="space-between">
                    <Text fw={600}>
                        {t('page.setting.diagnosticsStates', {
                            defaultValue: 'Recent state frames',
                        })}
                    </Text>
                    <Text isMuted size="sm">
                        {states.length}
                    </Text>
                </Group>
                {states.length === 0 ? (
                    <Text isMuted size="sm">
                        {t('page.setting.diagnosticsNoStates', {
                            defaultValue: 'No state frames yet.',
                        })}
                    </Text>
                ) : (
                    <ScrollArea h={180} type="auto">
                        <Table>
                            <Table.Tbody>
                                {[...states].reverse().map((s, i) => (
                                    <Table.Tr key={`${s.ts}-${i}`}>
                                        <Table.Td style={{ width: 60 }}>
                                            <Badge
                                                color={
                                                    s.direction === 'outbound' ? 'blue' : 'grape'
                                                }
                                                size="sm"
                                                variant="light"
                                            >
                                                {s.direction === 'outbound' ? 'OUT' : 'IN'}
                                            </Badge>
                                        </Table.Td>
                                        <Table.Td>{peerLabel(s.peerId)}</Table.Td>
                                        <Table.Td>{s.paused ? '⏸' : '▶'}</Table.Td>
                                        <Table.Td>
                                            {s.trackTitle ? (
                                                <Text isNoSelect size="sm">
                                                    {s.trackTitle}
                                                </Text>
                                            ) : (
                                                '—'
                                            )}
                                        </Table.Td>
                                        <Table.Td style={{ textAlign: 'right', width: 80 }}>
                                            {formatRelative(s.ts, now)}
                                        </Table.Td>
                                    </Table.Tr>
                                ))}
                            </Table.Tbody>
                        </Table>
                    </ScrollArea>
                )}
            </Stack>

            <Stack gap="xs">
                <Group justify="space-between">
                    <Text fw={600}>
                        {t('page.setting.diagnosticsFlips', {
                            defaultValue: 'Transport flips',
                        })}
                    </Text>
                    <Text isMuted size="sm">
                        {flips.length}
                    </Text>
                </Group>
                {flips.length === 0 ? (
                    <Text isMuted size="sm">
                        {t('page.setting.diagnosticsNoFlips', {
                            defaultValue: 'No lane changes yet.',
                        })}
                    </Text>
                ) : (
                    <ScrollArea h={140} type="auto">
                        <Table>
                            <Table.Tbody>
                                {[...flips].reverse().map((f, i) => (
                                    <Table.Tr key={`${f.ts}-${i}`}>
                                        <Table.Td>{peerLabel(f.peerId)}</Table.Td>
                                        <Table.Td>
                                            <Text isMuted size="sm">
                                                {f.from}
                                            </Text>
                                        </Table.Td>
                                        <Table.Td>→</Table.Td>
                                        <Table.Td>
                                            <Text size="sm">{f.to}</Text>
                                        </Table.Td>
                                        <Table.Td style={{ textAlign: 'right', width: 80 }}>
                                            {formatRelative(f.ts, now)}
                                        </Table.Td>
                                    </Table.Tr>
                                ))}
                            </Table.Tbody>
                        </Table>
                    </ScrollArea>
                )}
            </Stack>

            <Group justify="flex-end">
                <Button onClick={() => resetDiagnostics()} size="compact-sm" variant="default">
                    {t('common.clear', { defaultValue: 'Clear' })}
                </Button>
            </Group>
        </Stack>
    );
});

ConnectDiagnosticsSettings.displayName = 'ConnectDiagnosticsSettings';
