import { t } from 'i18next';
import { memo, MouseEvent } from 'react';

import styles from './mobile-fullscreen-player.module.css';

import { usePlayerData } from '/@/renderer/store';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Group } from '/@/shared/components/group/group';

interface MobileFullscreenPlayerBottomControlsProps {
    isLyricsActive: boolean;
    isQueueActive: boolean;
    onToggleContextMenu: (e: MouseEvent<HTMLButtonElement | HTMLDivElement>) => void;
    onToggleLyrics: () => void;
    onToggleQueue: () => void;
}

/**
 * Bottom utility bar inside the mobile fullscreen player. Spotify pattern:
 * three flat-icon buttons - Queue (with count badge), Lyrics, and an
 * overflow ⋯ that opens the song's context menu.
 *
 * The visualizer button used to live here too but now lives inside the
 * dedicated Visualizer card lower in the scrollable card stack — that
 * card has its own expand-to-fullscreen button, which is also where
 * the eye lands when scrolling Spotify-style. Mirroring the affordance
 * in the bottom bar would be noise.
 */
export const MobileFullscreenPlayerBottomControls = memo(
    ({
        isLyricsActive,
        isQueueActive,
        onToggleContextMenu,
        onToggleLyrics,
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
                        aria-label={t('player.lyrics')}
                        aria-pressed={isLyricsActive}
                        className={styles.bottomControlIcon}
                        // Microphone matches the desktop LyricsButton icon
                        // so the affordance is consistent across surfaces.
                        // The previous `metadata` (book-open) icon was
                        // semantically vague for lyrics on mobile.
                        icon="microphone"
                        iconProps={{
                            fill: isLyricsActive ? 'primary' : undefined,
                            size: 'xl',
                        }}
                        onClick={onToggleLyrics}
                        variant="transparent"
                    />
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
