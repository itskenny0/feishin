import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import styles from './mobile-fullscreen-player.module.css';

import {
    useActiveIsPaused,
    useActiveRepeat,
    useActiveShuffle,
    useTransportEnabled,
} from '/@/renderer/features/jellyfin-remote-target/hooks/use-active-player-source';
import { MainPlayButton, PlayerButton } from '/@/renderer/features/player/components/player-button';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import { triggerHaptic } from '/@/renderer/hooks/use-haptic';
import { useSkipButtons } from '/@/renderer/store';
import { Icon } from '/@/shared/components/icon/icon';
import { Song } from '/@/shared/types/domain-types';
import { PlayerRepeat, PlayerShuffle } from '/@/shared/types/types';

interface MobileFullscreenPlayerControlsProps {
    currentSong?: Song;
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
        const isPaused = useActiveIsPaused();
        const shuffle = useActiveShuffle();
        const repeat = useActiveRepeat();
        // Capability gating: in remote mode, disable transport the target
        // doesn't advertise. Always enabled in local mode.
        const canShuffle = useTransportEnabled('SetShuffleQueue');
        const canPrevious = useTransportEnabled('PreviousTrack');
        const canPlayPause = useTransportEnabled('PlayPause');
        const canNext = useTransportEnabled('NextTrack');
        const canRepeat = useTransportEnabled('SetRepeatMode');
        // The 15s skip-back / skip-forward pair is only useful on long
        // tracks (podcasts, mixes, long-form sets). For songs under 8
        // minutes you're better off just letting it play to the next
        // track than scrubbing 15s at a time. Mirror the desktop
        // skip-buttons setting AND additionally hide them on short
        // songs so the row stays the clean 5-button Spotify layout
        // (shuffle/prev/play/next/repeat) which fits comfortably on a
        // 320px viewport.
        const skip = useSkipButtons();
        const LONG_TRACK_THRESHOLD_MS = 8 * 60 * 1000;
        const isLongTrack = (currentSong?.duration ?? 0) >= LONG_TRACK_THRESHOLD_MS;
        const skipEnabled = Boolean(skip?.enabled) && isLongTrack;
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
                    disabled={!canShuffle}
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
                    disabled={!canPrevious}
                    icon={<Icon fill="default" icon="mediaPrevious" size="xl" />}
                    onClick={(e) => mediaPrevious(e.altKey)}
                    tooltip={{
                        label: t('player.previous'),
                        openDelay: 400,
                    }}
                    variant="secondary"
                />
                {skipEnabled && (
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
                )}
                <MainPlayButton
                    disabled={currentSongId === undefined || !canPlayPause}
                    isPaused={isPaused}
                    onClick={() => {
                        // A firmer impact pulse on play/pause — the main
                        // transport action gets a slightly heavier tick
                        // than the surrounding tertiary controls.
                        triggerHaptic('impact');
                        mediaTogglePlayPause();
                    }}
                />
                {/*
                 * Note: button size used to be set via an inline 50×50px
                 * style here. Removed so the Spotify-scale 72px (mobile
                 * fullscreen) rule in mobile-fullscreen-player.module.css
                 * can apply — the desktop callers fall back to the
                 * MainPlayButton CSS-module default, which is already
                 * sized for the desktop playerbar.
                 */}
                {skipEnabled && (
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
                )}
                <PlayerButton
                    disabled={!canNext}
                    icon={<Icon fill="default" icon="mediaNext" size="xl" />}
                    onClick={(e) => mediaNext(e.altKey)}
                    tooltip={{
                        label: t('player.next'),
                        openDelay: 400,
                    }}
                    variant="secondary"
                />
                <PlayerButton
                    disabled={!canRepeat}
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
