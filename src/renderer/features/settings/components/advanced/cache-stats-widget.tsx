// Historical cache stats widget. Shows the running tallies emitted by
// `src/renderer/cache/stats.ts` so the user can see the cache's actual
// utility over time — hit ratio, total bytes fetched, miss markers
// written, failed fetches, etc.

import { Button, Group, Stack, Text, Title } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { formatBytes as formatBytesSI } from '/@/renderer/cache';
import { type CacheStats, getStats, resetStats, subscribeStats } from '/@/renderer/cache/stats';

const formatNumber = (n: number): string => n.toLocaleString();

const formatRelativeTime = (ms: number): string => {
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h`;
    const day = Math.floor(hr / 24);
    return `${day}d`;
};

export const CacheStatsWidget = () => {
    const { t } = useTranslation();
    const [stats, setStats] = useState<CacheStats>(getStats);
    // Captured-on-mount "now" so the render path stays pure. The
    // relative-time string ages with each stats update via the effect
    // below, which is sufficient — this widget doesn't need second-level
    // precision in the timestamp.
    const nowRef = useRef<number>(0);
    const [, forceTick] = useState(0);

    useEffect(() => {
        nowRef.current = Date.now();
        forceTick((n) => n + 1);
        const unsubscribe = subscribeStats((next) => {
            nowRef.current = Date.now();
            setStats({ ...next });
        });
        // Pick up any delta written before this component mounted.
        setStats({ ...getStats() });
        return unsubscribe;
    }, []);

    const handleReset = (): void => {
        if (
            typeof window !== 'undefined' &&
            typeof window.confirm === 'function' &&
            !window.confirm(
                t('page.setting.librarySyncDashboard.statsResetConfirm', {
                    defaultValue: 'Reset cache hit/miss stats? Historical data will be lost.',
                }),
            )
        ) {
            return;
        }
        resetStats();
    };

    const lookups = stats.blobHits + stats.missMarkerHits + stats.fetched + stats.missWrites;
    const hits = stats.blobHits + stats.missMarkerHits;
    const hitRatio = lookups > 0 ? hits / lookups : 0;
    const sinceMs = Math.max(0, nowRef.current - stats.firstSeenAt);

    return (
        <Stack gap={4}>
            <Title order={6}>
                {t('page.setting.librarySyncDashboard.statsTitle', {
                    defaultValue: 'Thumbnail cache stats',
                })}
            </Title>
            <Text c="dimmed" size="xs">
                {t('page.setting.librarySyncDashboard.statsSince', {
                    defaultValue: 'Tracking since {{when}} ago',
                    when: formatRelativeTime(sinceMs),
                })}
            </Text>
            <Group justify="space-between">
                <Text size="sm">
                    {t('page.setting.librarySyncDashboard.statsBlobHits', {
                        defaultValue: 'Blob hits',
                    })}
                </Text>
                <Text c="dimmed" size="sm">
                    {formatNumber(stats.blobHits)}
                </Text>
            </Group>
            <Group justify="space-between">
                <Text size="sm">
                    {t('page.setting.librarySyncDashboard.statsMissHits', {
                        defaultValue: 'Miss-marker hits (404s skipped)',
                    })}
                </Text>
                <Text c="dimmed" size="sm">
                    {formatNumber(stats.missMarkerHits)}
                </Text>
            </Group>
            <Group justify="space-between">
                <Text size="sm">
                    {t('page.setting.librarySyncDashboard.statsFetched', {
                        defaultValue: 'Fresh fetches',
                    })}
                </Text>
                <Text c="dimmed" size="sm">
                    {formatNumber(stats.fetched)}
                </Text>
            </Group>
            <Group justify="space-between">
                <Text size="sm">
                    {t('page.setting.librarySyncDashboard.statsMissWrites', {
                        defaultValue: 'Miss markers written',
                    })}
                </Text>
                <Text c="dimmed" size="sm">
                    {formatNumber(stats.missWrites)}
                </Text>
            </Group>
            <Group justify="space-between">
                <Text size="sm">
                    {t('page.setting.librarySyncDashboard.statsFailed', {
                        defaultValue: 'Failed fetches',
                    })}
                </Text>
                <Text c="dimmed" size="sm">
                    {formatNumber(stats.failed)}
                </Text>
            </Group>
            <Group justify="space-between">
                <Text size="sm">
                    {t('page.setting.librarySyncDashboard.statsBytesFetched', {
                        defaultValue: 'Bytes fetched (total)',
                    })}
                </Text>
                <Text c="dimmed" size="sm">
                    {formatBytesSI(stats.bytesFetched)}
                </Text>
            </Group>
            <Group justify="space-between">
                <Text fw={600} size="sm">
                    {t('page.setting.librarySyncDashboard.statsHitRatio', {
                        defaultValue: 'Hit ratio',
                    })}
                </Text>
                <Text fw={600} size="sm">
                    {lookups > 0 ? `${(hitRatio * 100).toFixed(1)}%` : '—'}
                </Text>
            </Group>
            <Group justify="flex-end" mt="xs">
                <Button onClick={handleReset} size="xs" variant="subtle">
                    {t('page.setting.librarySyncDashboard.statsReset', {
                        defaultValue: 'Reset stats',
                    })}
                </Button>
            </Group>
        </Stack>
    );
};
