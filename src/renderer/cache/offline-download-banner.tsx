// OfflineDownloadBanner — a persistent, app-wide progress banner shown while an
// offline download is running. Mirrors the cache-sync progress convention: it
// surfaces ITEMS done/total AND BYTES downloaded / estimated remaining in SI
// units, and animates smoothly (rAF interpolation via useSmoothOfflineSync,
// >=20fps). Self-gates entirely on the cache store's `offlineSync` field, so
// it renders nothing when no download is active and never needs an explicit
// mount/unmount from its parent layout.
//
// Mounted once in the default + mobile layouts so it floats above page content
// regardless of which route the user is on after they trigger a download.

import { ActionIcon, Group, Progress, Stack, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';

import { formatBytes, formatCount } from './format';
import styles from './offline-download-banner.module.css';
import { cancelOfflineSync } from './offline-media';
import { useCacheStore } from './store';
import { useSmoothOfflineSync } from './use-smooth-offline-sync';

import { useIsMobileShell } from '/@/renderer/hooks/use-breakpoint';
import { useSettingsStore } from '/@/renderer/store';
import { Icon } from '/@/shared/components/icon/icon';

export const OfflineDownloadBanner = () => {
    const { t } = useTranslation();
    const enabled = useSettingsStore((s) => s.localCache?.enabled === true);
    const isMobileShell = useIsMobileShell();
    const sync = useSmoothOfflineSync();
    const queue = useCacheStore((s) => s.offlineQueue);

    if (!enabled || !sync) return null;

    const enumerating = sync.phase === 'enumerating';
    const done = Math.floor(sync.done);
    const total = sync.total;
    const pct = total && total > 0 ? Math.min(100, (100 * done) / total) : undefined;

    // Page indicator — surfaces enumeration paging so a big playlist/album on a
    // slow server visibly advances page-by-page instead of looking stuck.
    const pageText =
        enumerating && (sync.pageIndex ?? 0) > 0
            ? ` · ${t('page.setting.offlineMedia.page', {
                  defaultValue: 'page {{page}}',
                  page: sync.pageIndex,
              })}`
            : '';

    const title = enumerating
        ? t('page.setting.offlineMedia.preparing', {
              count: sync.foundCount ?? 0,
              defaultValue: 'Preparing {{name}} — found {{count}} songs…',
              name: sync.name,
          }) + pageText
        : t('page.setting.offlineMedia.downloading', {
              defaultValue: 'Downloading {{name}}',
              name: sync.name,
          });

    const itemsText = total ? `${formatCount(done)} / ${formatCount(total)}` : formatCount(done);

    // Bytes downloaded / estimated remaining, in SI units — matches the
    // cache-sync chip wording so the two progress surfaces read identically.
    const remaining =
        sync.estimatedTotalBytes && sync.estimatedTotalBytes > sync.bytesDownloaded
            ? sync.estimatedTotalBytes - sync.bytesDownloaded
            : undefined;
    const bytesText =
        remaining !== undefined
            ? `${formatBytes(sync.bytesDownloaded)} · ~${formatBytes(remaining)} ${t(
                  'page.setting.offlineMedia.remaining',
                  { defaultValue: 'remaining' },
              )}`
            : formatBytes(sync.bytesDownloaded);

    const rateText = sync.bytesPerSec > 0 ? ` · ${formatBytes(sync.bytesPerSec)}/s` : '';
    const queuedText =
        queue && queue.queuedCount > 0
            ? ` · ${t('page.setting.offlineMedia.queuedCount', {
                  count: queue.queuedCount,
                  defaultValue: '{{count}} queued',
              })}`
            : '';

    return (
        <div
            aria-label={title}
            className={styles.banner}
            data-position={isMobileShell ? 'top' : 'bottom'}
            role="status"
        >
            <Group align="center" gap="sm" wrap="nowrap">
                <Icon icon="cache" size="lg" />
                <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
                    <Text className={styles.title} fw={600} size="sm" truncate>
                        {title}
                    </Text>
                    {/* During enumeration nothing has downloaded yet — show an
                        animated indeterminate bar instead of a 0% / 100% jump. */}
                    <Progress
                        animated={enumerating}
                        size="sm"
                        value={enumerating ? 100 : (pct ?? 100)}
                    />
                    <Text c="dimmed" size="xs" truncate>
                        {enumerating
                            ? `${formatCount(sync.foundCount ?? 0)} ${t(
                                  'page.setting.offlineMedia.songsFound',
                                  { defaultValue: 'songs found' },
                              )}${queuedText}`
                            : `${itemsText} · ${bytesText}${rateText}${queuedText}`}
                    </Text>
                </Stack>
                <ActionIcon
                    aria-label={t('page.setting.offlineMedia.cancel', { defaultValue: 'Cancel' })}
                    color="gray"
                    onClick={() => cancelOfflineSync()}
                    variant="subtle"
                >
                    <Icon icon="x" size="md" />
                </ActionIcon>
            </Group>
        </div>
    );
};
