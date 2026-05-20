import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import styles from './mobile-fullscreen-player.module.css';

import { MainPlayButton, PlayerButton } from '/@/renderer/features/player/components/player-button';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import { triggerHaptic } from '/@/renderer/hooks/use-haptic';
import { usePlayerRepeat, usePlayerShuffle, usePlayerStatus } from '/@/renderer/store';
import { Icon } from '/@/shared/components/icon/icon';
import { QueueSong } from '/@/shared/types/domain-types';
import { PlayerRepeat, PlayerShuffle, PlayerStatus } from '/@/shared/types/types';

interface MobileFullscreenPlayerControlsProps {
    currentSong?: QueueSong;
}

/**
 * Transport row for the mobile full-screen player.
 *
 * Spotify-style layout: shuffle on the far left, repeat on the far right,
 * with previous / skip-back / play / skip-forward / next clustered in the
 * middle. Adding shuffle + repeat here closes the biggest functional gap
 * between the mobile and desktop players — they were previously only
 * reachable from desktop's center-controls.
 */
export const MobileFullscreenPlayerControls = memo(
    ({ currentSong }: MobileFullscreenPlayerControlsProps) => {
        const currentSongId = currentSong?.id;
        const { t } = useTranslation();
        const status = usePlayerStatus();
        const shuffle = usePlayerShuffle();
        const repeat = usePlayerRepeat();
        const {
            mediaNext,
            mediaPrevious,
            mediaSkipBackward,
            mediaSkipForward,
            mediaTogglePlayPause,
            toggleRepeat,
            toggleShuffle,
        } = usePlayer();

        const shuffleActive = shuffle !== PlayerShuffle.NONE;
        const repeatActive = repeat !== PlayerRepeat.NONE;

        return (
            <div className={styles.controlsContainer}>
                <PlayerButton
                    icon={
                        <Icon
                            fill={shuffleActive ? 'primary' : 'default'}
                            icon="mediaShuffle"
                            size="lg"
                        />
                    }
                    isActive={shuffleActive}
                    onClick={toggleShuffle}
                    tooltip={{
                        label: shuffleActive
                            ? t('player.shuffle', { defaultValue: 'Shuffle on' })
                            : t('player.shuffle', {
                                  context: 'off',
                                  defaultValue: 'Shuffle off',
                              }),
                        openDelay: 400,
                    }}
                    variant="tertiary"
                />
                <PlayerButton
                    icon={<Icon fill="default" icon="mediaPrevious" size="xl" />}
                    onClick={mediaPrevious}
                    tooltip={{
                        label: t('player.previous'),
                        openDelay: 400,
                    }}
                    variant="secondary"
                />
                <PlayerButton
                    icon={<Icon fill="default" icon="mediaStepBackward" size="lg" />}
                    onClick={mediaSkipBackward}
                    tooltip={{
                        label: t('player.skip', {
                            context: 'back',
                        }),
                        openDelay: 400,
                    }}
                    variant="tertiary"
                />
                <MainPlayButton
                    disabled={currentSongId === undefined}
                    isPaused={status === PlayerStatus.PAUSED}
                    onClick={() => {
                        // A firmer impact pulse on play/pause — the main
                        // transport action gets a slightly heavier tick
                        // than the surrounding tertiary controls.
                        triggerHaptic('impact');
                        mediaTogglePlayPause();
                    }}
                    style={{
                        height: '50px',
                        width: '50px',
                    }}
                />
                <PlayerButton
                    icon={<Icon fill="default" icon="mediaStepForward" size="lg" />}
                    onClick={mediaSkipForward}
                    tooltip={{
                        label: t('player.skip', {
                            context: 'forward',
                        }),
                        openDelay: 400,
                    }}
                    variant="tertiary"
                />
                <PlayerButton
                    icon={<Icon fill="default" icon="mediaNext" size="xl" />}
                    onClick={mediaNext}
                    tooltip={{
                        label: t('player.next'),
                        openDelay: 400,
                    }}
                    variant="secondary"
                />
                <PlayerButton
                    icon={
                        repeat === PlayerRepeat.ONE ? (
                            <Icon fill="primary" icon="mediaRepeatOne" size="lg" />
                        ) : (
                            <Icon
                                fill={repeatActive ? 'primary' : 'default'}
                                icon="mediaRepeat"
                                size="lg"
                            />
                        )
                    }
                    isActive={repeatActive}
                    onClick={toggleRepeat}
                    tooltip={{
                        label:
                            repeat === PlayerRepeat.ONE
                                ? t('player.repeat', {
                                      context: 'one',
                                      defaultValue: 'Repeat one',
                                  })
                                : repeatActive
                                  ? t('player.repeat', { defaultValue: 'Repeat all' })
                                  : t('player.repeat', {
                                        context: 'off',
                                        defaultValue: 'Repeat off',
                                    }),
                        openDelay: 400,
                    }}
                    variant="tertiary"
                />
            </div>
        );
    },
);

MobileFullscreenPlayerControls.displayName = 'MobileFullscreenPlayerControls';
