import { t } from 'i18next';
import { memo, MouseEvent } from 'react';

import styles from './mobile-fullscreen-player.module.css';

import {
    useFullScreenPlayerStore,
    useFullScreenPlayerStoreActions,
    usePlayerData,
} from '/@/renderer/store';
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
 * four flat-icon buttons - Queue (with count badge), Lyrics, Visualizer,
 * and an overflow ⋯ that opens the song's context menu.
 *
 * Shuffle and Repeat used to live here too, but they're in the transport
 * row above now, so duplicating them in the bottom bar was just clutter
 * and stole space from more useful controls. The visualizer toggle is the
 * only entry point on mobile (desktop has its own button in the
 * left-controls); without it there's no way to reach the fullscreen
 * visualizer from a phone.
 */
export const MobileFullscreenPlayerBottomControls = memo(
    ({
        isLyricsActive,
        isQueueActive,
        onToggleContextMenu,
        onToggleLyrics,
        onToggleQueue,
    }: MobileFullscreenPlayerBottomControlsProps) => {
        const { visualizerExpanded } = useFullScreenPlayerStore();
        const { setStore } = useFullScreenPlayerStoreActions();
        // Queue badge mirrors the desktop right-controls QueueButton —
        // surfaces "how many tracks are queued?" at a glance so the user
        // doesn't have to switch into the queue tab to find out.
        const { queueLength } = usePlayerData();

        const handleToggleVisualizer = () => {
            // Toggle the dedicated FullScreenVisualizer overlay (mobile-layout
            // renders it when visualizerExpanded is true). Collapses the
            // player overlay first so the user lands on the visualizer
            // cleanly rather than seeing both layered briefly.
            setStore({
                expanded: false,
                visualizerExpanded: !visualizerExpanded,
            });
        };

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
                        aria-label={t('player.visualizer', {
                            defaultValue: 'Visualizer',
                        })}
                        aria-pressed={visualizerExpanded}
                        className={styles.bottomControlIcon}
                        // Sparkles reads as "visual effects" - the closest
                        // metaphor we have in the icon set for an audio
                        // visualizer.
                        icon="sparkles"
                        iconProps={{
                            fill: visualizerExpanded ? 'primary' : undefined,
                            size: 'xl',
                        }}
                        onClick={handleToggleVisualizer}
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
