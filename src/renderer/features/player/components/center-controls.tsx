import clsx from 'clsx';
import { TFunction } from 'i18next';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import styles from './center-controls.module.css';

import {
    useActiveIsPaused,
    useActiveNowPlayingItem,
    useActiveRepeat,
    useActiveShuffle,
    useTransportEnabled,
} from '/@/renderer/features/jellyfin-remote-target/hooks/use-active-player-source';
import { MainPlayButton, PlayerButton } from '/@/renderer/features/player/components/player-button';
import { PlayerbarSlider } from '/@/renderer/features/player/components/playerbar-slider';
import { openShuffleAllModal } from '/@/renderer/features/player/components/shuffle-all-modal';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import {
    useIsPlayingRadio,
    useIsRadioActive,
    useRadioControls,
    useRadioPlayer,
} from '/@/renderer/features/radio/hooks/use-radio-player';
import { useIsBigTablet } from '/@/renderer/hooks/use-breakpoint';
import { useButtonSize, useSkipButtons } from '/@/renderer/store';
import { Icon } from '/@/shared/components/icon/icon';
import { Stack } from '/@/shared/components/stack/stack';
import { Text } from '/@/shared/components/text/text';
import { PlayerRepeat, PlayerShuffle } from '/@/shared/types/types';

export const CenterControls = () => {
    const skip = useSkipButtons();
    const { t } = useTranslation();
    // Lifted here and threaded down as primitives so the nine transport
    // buttons don't each independently subscribe to the button-size store +
    // spin up their own i18next subscription. With these as props and the
    // leaf buttons React.memo'd, a button-size change re-renders the small
    // parent once instead of nine separate subscribers, and the leaves only
    // reconcile when one of their own props (active state, enabled, size)
    // actually changes.
    const buttonSize = useButtonSize();

    const isRadioActive = useIsRadioActive();
    /*
     * Tablet-tier (835–1280): the right sidebar slides in as a 400px
     * overlay, but the playerbar grid is still laid out as if the
     * sidebar occupied its own column, so the center controls + slider
     * have only ~300–400px of effective width. With nine buttons plus a
     * full slider, the queue-toggle / volume / cast cluster on the right
     * spills off-screen. Drop everything except prev / play / next in
     * this range so the slider gets meaningful room and the right-side
     * controls stay reachable. The buttons return to the desktop layout
     * at ≥1281 and below 835 the mobile shell takes over.
     */
    const isCompactTablet = useIsBigTablet();

    if (isRadioActive) {
        return (
            <>
                <div className={styles.controlsContainer}>
                    <div className={styles.buttonsContainer}>
                        {!isCompactTablet && <RadioStopButton buttonSize={buttonSize} t={t} />}
                        {!isCompactTablet && (
                            <ShuffleButton buttonSize={buttonSize} disabled={isRadioActive} t={t} />
                        )}
                        <PreviousButton buttonSize={buttonSize} disabled={isRadioActive} t={t} />
                        {!isCompactTablet && skip?.enabled && (
                            <SkipBackwardButton
                                buttonSize={buttonSize}
                                disabled={isRadioActive}
                                t={t}
                            />
                        )}
                        <RadioCenterPlayButton />
                        {!isCompactTablet && skip?.enabled && (
                            <SkipForwardButton
                                buttonSize={buttonSize}
                                disabled={isRadioActive}
                                t={t}
                            />
                        )}
                        <NextButton buttonSize={buttonSize} disabled={isRadioActive} t={t} />
                        {!isCompactTablet && (
                            <RepeatButton buttonSize={buttonSize} disabled={isRadioActive} t={t} />
                        )}
                        {!isCompactTablet && (
                            <ShuffleAllButton
                                buttonSize={buttonSize}
                                disabled={isRadioActive}
                                t={t}
                            />
                        )}
                    </div>
                </div>
            </>
        );
    }

    return (
        <>
            <div className={styles.controlsContainer}>
                <div className={styles.buttonsContainer}>
                    {!isCompactTablet && <StopButton buttonSize={buttonSize} t={t} />}
                    {!isCompactTablet && <ShuffleButton buttonSize={buttonSize} t={t} />}
                    <PreviousButton buttonSize={buttonSize} t={t} />
                    {!isCompactTablet && skip?.enabled && (
                        <SkipBackwardButton buttonSize={buttonSize} t={t} />
                    )}
                    <CenterPlayButton />
                    {!isCompactTablet && skip?.enabled && (
                        <SkipForwardButton buttonSize={buttonSize} t={t} />
                    )}
                    <NextButton buttonSize={buttonSize} t={t} />
                    {!isCompactTablet && <RepeatButton buttonSize={buttonSize} t={t} />}
                    {!isCompactTablet && <ShuffleAllButton buttonSize={buttonSize} t={t} />}
                </div>
            </div>
            <PlayerbarSlider />
        </>
    );
};

// Shared props for the transport leaf buttons. `buttonSize` and `t` are lifted
// into CenterControls (the single parent) and threaded down so each leaf
// avoids its own useButtonSize/useTranslation subscription; the leaves are
// React.memo'd so they only reconcile when their own props change.
interface TransportButtonProps {
    buttonSize: number;
    disabled?: boolean;
    t: TFunction;
}

const RadioCenterPlayButton = ({ disabled }: { disabled?: boolean }) => {
    const { currentStreamUrl } = useRadioPlayer();
    const isPlayingRadio = useIsPlayingRadio();
    const { pause, play } = useRadioControls();

    const handleClick = () => {
        if (isPlayingRadio) {
            pause();
        } else if (currentStreamUrl) {
            play();
        }
    };

    return (
        <div
            className={clsx(styles.playButtonWrapper, {
                [styles.playButtonPlaying]: isPlayingRadio,
            })}
        >
            <MainPlayButton disabled={disabled} isPaused={!isPlayingRadio} onClick={handleClick} />
        </div>
    );
};

const RadioStopButton = memo(({ buttonSize, disabled, t }: TransportButtonProps) => {
    const { stop } = useRadioControls();

    return (
        <PlayerButton
            disabled={disabled}
            icon={<Icon fill="default" icon="mediaStop" size={buttonSize - 2} />}
            onClick={stop}
            tooltip={{
                label: t('player.stop'),
                openDelay: 400,
            }}
            variant="tertiary"
        />
    );
});
RadioStopButton.displayName = 'RadioStopButton';

const StopButton = memo(({ buttonSize, disabled, t }: TransportButtonProps) => {
    const { mediaStop } = usePlayer();

    return (
        <PlayerButton
            disabled={disabled}
            icon={<Icon fill="default" icon="mediaStop" size={buttonSize - 2} />}
            onClick={() => mediaStop()}
            tooltip={{
                label: t('player.stop'),
                openDelay: 400,
            }}
            variant="tertiary"
        />
    );
});
StopButton.displayName = 'StopButton';

const ShuffleButton = memo(({ buttonSize, disabled, t }: TransportButtonProps) => {
    const shuffle = useActiveShuffle();
    const { toggleShuffle } = usePlayer();
    const canShuffle = useTransportEnabled('SetShuffleQueue');

    return (
        <PlayerButton
            disabled={disabled || !canShuffle}
            icon={
                <Icon
                    color={shuffle === PlayerShuffle.NONE ? 'default' : 'primary'}
                    icon="mediaShuffle"
                    size={buttonSize}
                />
            }
            isActive={shuffle !== PlayerShuffle.NONE}
            onClick={toggleShuffle}
            style={{ opacity: canShuffle ? undefined : 0.4 }}
            tooltip={{
                label:
                    shuffle === PlayerShuffle.NONE
                        ? t('player.shuffle', {
                              context: 'off',
                          })
                        : t('player.shuffle'),
                openDelay: 400,
            }}
            variant="tertiary"
        />
    );
});
ShuffleButton.displayName = 'ShuffleButton';

const PreviousButton = memo(({ buttonSize, disabled, t }: TransportButtonProps) => {
    const { mediaPrevious } = usePlayer();
    const canPrevious = useTransportEnabled('PreviousTrack');

    return (
        <PlayerButton
            disabled={disabled || !canPrevious}
            icon={<Icon fill="default" icon="mediaPrevious" size={buttonSize} />}
            onClick={(e) => mediaPrevious(e.altKey)}
            style={{ opacity: canPrevious ? undefined : 0.4 }}
            tooltip={{
                label: (
                    <Stack gap="xs" justify="center">
                        <Text fw={500} ta="center">
                            {t('player.previous')}
                        </Text>
                        <Text fw={500} isMuted size="xs" ta="center">
                            {t('player.previousAlbum')}
                        </Text>
                    </Stack>
                ),
                openDelay: 0,
            }}
            variant="secondary"
        />
    );
});
PreviousButton.displayName = 'PreviousButton';

const SkipBackwardButton = memo(({ buttonSize, disabled, t }: TransportButtonProps) => {
    const { mediaSkipBackward } = usePlayer();

    return (
        <PlayerButton
            disabled={disabled}
            icon={<Icon fill="default" icon="mediaStepBackward" size={buttonSize} />}
            onClick={mediaSkipBackward}
            tooltip={{
                label: t('player.skip', {
                    context: 'back',
                }),
                openDelay: 400,
            }}
            variant="secondary"
        />
    );
});
SkipBackwardButton.displayName = 'SkipBackwardButton';

const CenterPlayButton = ({ disabled }: { disabled?: boolean }) => {
    const currentSong = useActiveNowPlayingItem();
    const currentSongId = currentSong?.id;
    const isPaused = useActiveIsPaused();
    const { mediaTogglePlayPause } = usePlayer();
    const canPlayPause = useTransportEnabled('PlayPause');

    const isPlaying = currentSongId !== undefined && !isPaused;

    return (
        <div
            className={clsx(styles.playButtonWrapper, {
                [styles.playButtonPlaying]: isPlaying,
            })}
        >
            <MainPlayButton
                disabled={disabled || currentSongId === undefined || !canPlayPause}
                isPaused={isPaused}
                onClick={mediaTogglePlayPause}
                style={{ opacity: canPlayPause ? undefined : 0.4 }}
            />
        </div>
    );
};

const SkipForwardButton = memo(({ buttonSize, disabled, t }: TransportButtonProps) => {
    const { mediaSkipForward } = usePlayer();

    return (
        <PlayerButton
            disabled={disabled}
            icon={<Icon fill="default" icon="mediaStepForward" size={buttonSize} />}
            onClick={mediaSkipForward}
            tooltip={{
                label: t('player.skip', {
                    context: 'forward',
                }),
                openDelay: 400,
            }}
            variant="secondary"
        />
    );
});
SkipForwardButton.displayName = 'SkipForwardButton';

const NextButton = memo(({ buttonSize, disabled, t }: TransportButtonProps) => {
    const { mediaNext } = usePlayer();
    const canNext = useTransportEnabled('NextTrack');

    return (
        <PlayerButton
            disabled={disabled || !canNext}
            icon={<Icon fill="default" icon="mediaNext" size={buttonSize} />}
            onClick={(e) => mediaNext(e.altKey)}
            style={{ opacity: canNext ? undefined : 0.4 }}
            tooltip={{
                label: (
                    <Stack gap="xs" justify="center">
                        <Text fw={500} ta="center">
                            {t('player.next')}
                        </Text>
                        <Text fw={500} isMuted size="xs" ta="center">
                            {t('player.nextAlbum')}
                        </Text>
                    </Stack>
                ),
                openDelay: 0,
            }}
            variant="secondary"
        />
    );
});
NextButton.displayName = 'NextButton';

const RepeatButton = memo(({ buttonSize, disabled, t }: TransportButtonProps) => {
    const repeat = useActiveRepeat();
    const { toggleRepeat } = usePlayer();
    const canRepeat = useTransportEnabled('SetRepeatMode');

    return (
        <PlayerButton
            disabled={disabled || !canRepeat}
            icon={
                repeat === PlayerRepeat.ONE ? (
                    <Icon fill="primary" icon="mediaRepeatOne" size={buttonSize} />
                ) : (
                    <Icon
                        fill={repeat === PlayerRepeat.NONE ? 'default' : 'primary'}
                        icon="mediaRepeat"
                        size={buttonSize}
                    />
                )
            }
            isActive={repeat !== PlayerRepeat.NONE}
            onClick={toggleRepeat}
            style={{ opacity: canRepeat ? undefined : 0.4 }}
            tooltip={{
                label: `${
                    repeat === PlayerRepeat.NONE
                        ? t('player.repeat', {
                              context: 'off',
                          })
                        : repeat === PlayerRepeat.ALL
                          ? t('player.repeat', {
                                context: 'all',
                            })
                          : t('player.repeat', {
                                context: 'one',
                            })
                }`,
                openDelay: 400,
            }}
            variant="tertiary"
        />
    );
});
RepeatButton.displayName = 'RepeatButton';

const ShuffleAllButton = memo(({ buttonSize, disabled, t }: TransportButtonProps) => {
    return (
        <PlayerButton
            disabled={disabled}
            icon={<Icon fill="default" icon="mediaRandom" size={buttonSize} />}
            onClick={() => openShuffleAllModal()}
            tooltip={{
                label: t('form.shuffleAll.title'),
                openDelay: 400,
            }}
            variant="tertiary"
        />
    );
});
ShuffleAllButton.displayName = 'ShuffleAllButton';
