import { memo, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import styles from './mobile-fullscreen-player.module.css';

import {
    useActivePlayerSource,
    useTransportEnabled,
} from '/@/renderer/features/jellyfin-remote-target/hooks/use-active-player-source';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import { useIsAndroidNative } from '/@/renderer/hooks/use-breakpoint';
import { usePlayerMuted } from '/@/renderer/store';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Slider } from '/@/shared/components/slider/slider';
import { useThrottledValue } from '/@/shared/hooks/use-throttled-value';

/**
 * Volume control for the mobile full-screen player.
 *
 * Mirrors the desktop right-controls VolumeButton + slider pair, but laid
 * out as a single horizontal row that fits between the seek bar and the
 * transport controls. Tap the icon to mute/unmute, drag the slider to set
 * volume. Throttles outgoing setVolume calls to 100ms so a rapid drag
 * doesn't spam the audio backend or remote Jellyfin transport.
 */
export const MobileFullscreenPlayerVolume = memo(() => {
    const { t } = useTranslation();
    const source = useActivePlayerSource();
    const canSetVolume = useTransportEnabled('SetVolume');
    const localMuted = usePlayerMuted();
    const volume = source.volume;
    const isAndroidNative = useIsAndroidNative();
    // Remote mode treats volume === 0 as muted (no separate mute channel);
    // local player keeps a dedicated muted flag so the user can mute without
    // losing their pre-mute volume level.
    const muted = source.mode === 'remote' ? source.volume === 0 : localMuted;
    const { mediaToggleMute, setVolume } = usePlayer();

    const [sliderValue, setSliderValue] = useState(volume);
    const throttledVolume = useThrottledValue(sliderValue, 100);

    useEffect(() => {
        setVolume(throttledVolume);
    }, [throttledVolume, setVolume]);

    useEffect(() => {
        setSliderValue(volume);
    }, [volume]);

    const handleSliderChange = useCallback((value: number) => {
        setSliderValue(value);
    }, []);

    const handleMute = useCallback(() => {
        mediaToggleMute();
    }, [mediaToggleMute]);

    // On Android the OS volume rocker is the single source of truth for
    // playback volume — the in-app slider just adds confusion (it would
    // attenuate the audio a second time on top of the system volume).
    // Hide the entire row. The bootstrap in `useAndroidForceFullVolume`
    // (app.tsx) sets the internal volume to 100% on startup so the
    // engine doesn't attenuate anything.
    if (isAndroidNative) {
        return null;
    }

    return (
        <div className={styles.volumeRow}>
            <div className={styles.volumeIconSlot}>
                <ActionIcon
                    aria-label={
                        muted || volume === 0
                            ? t('player.muted', { defaultValue: 'Unmute' })
                            : t('player.volume', { defaultValue: 'Mute' })
                    }
                    icon={
                        muted || volume === 0
                            ? 'volumeMute'
                            : volume > 50
                              ? 'volumeMax'
                              : 'volumeNormal'
                    }
                    iconProps={{
                        color: muted ? 'muted' : undefined,
                        size: 'lg',
                    }}
                    onClick={handleMute}
                    size="md"
                    variant="subtle"
                />
            </div>
            <Slider
                aria-label={t('player.volume', { defaultValue: 'Volume' })}
                className={styles.volumeSlider}
                disabled={!canSetVolume}
                max={100}
                min={0}
                onChange={handleSliderChange}
                size={6}
                style={{ flex: 1, opacity: canSetVolume ? undefined : 0.4 }}
                value={sliderValue}
            />
            <div aria-hidden="true" className={styles.volumeRowSpacer} />
        </div>
    );
});

MobileFullscreenPlayerVolume.displayName = 'MobileFullscreenPlayerVolume';
