import { t } from 'i18next';
import { memo, MouseEvent } from 'react';

import styles from './mobile-fullscreen-player.module.css';

import { usePlayerData } from '/@/renderer/store';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Group } from '/@/shared/components/group/group';

interface MobileFullscreenPlayerBottomControlsProps {
    isQueueActive: boolean;
    onToggleContextMenu: (e: MouseEvent<HTMLButtonElement | HTMLDivElement>) => void;
    onToggleQueue: () => void;
}

/**
 * Bottom utility bar inside the mobile fullscreen player. Two flat-icon
 * buttons - Queue (with count badge) and an overflow ⋯ that opens the
 * song's context menu. The lyrics and visualizer affordances live in
 * their own cards below the player face (see MobileFullscreenLyricsCard
 * and MobileFullscreenVisualizerCard) — the user prefers them to be
 * scroll-discoverable rather than dedicated tabs.
 */
export const MobileFullscreenPlayerBottomControls = memo(
    ({
        isQueueActive,
        onToggleContextMenu,
        onToggleQueue,
    }: MobileFullscreenPlayerBottomControlsProps) => {
        // Queue badge mirrors the desktop right-controls QueueButton —
        // surfaces "how many tracks are queued?" at a glance so the user
        // doesn't have to switch into the queue tab to find out.
        const { queueLength } = usePlayerData();

        return (
            <div className={styles.bottomControlsBar}>
                <Group className={styles.bottomControlsGroup} gap={0}>
                    <div className={styles.queueButtonWrapper}>
                        <ActionIcon
                            aria-label={t('player.viewQueue')}
                            aria-pressed={isQueueActive}
                            className={styles.bottomControlIcon}
                            icon="queue"
                            iconProps={{
                                fill: isQueueActive ? 'primary' : undefined,
                                size: 'xl',
                            }}
                            onClick={onToggleQueue}
                            variant="transparent"
                        />
                        {queueLength > 0 && (
                            <span aria-hidden className={styles.queueBadge}>
                                {queueLength > 99 ? '99+' : queueLength}
                            </span>
                        )}
                    </div>
                    <ActionIcon
                        aria-label={t('common.menu')}
                        className={styles.bottomControlIcon}
                        icon="ellipsisVertical"
                        iconProps={{
                            size: 'xl',
                        }}
                        onClick={onToggleContextMenu}
                        variant="transparent"
                    />
                </Group>
            </div>
        );
    },
);

MobileFullscreenPlayerBottomControls.displayName = 'MobileFullscreenPlayerBottomControls';
