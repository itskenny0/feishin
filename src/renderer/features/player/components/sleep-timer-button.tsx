import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { usePlayerEvents } from '/@/renderer/features/player/audio-player/hooks/use-player-events';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import {
    usePlayerActions,
    usePlayerShuffle,
    usePlayerStatus,
    usePlayerStoreBase,
} from '/@/renderer/store/player.store';
import {
    useSettingsStoreActions,
    useSleepTimerFadeSeconds,
} from '/@/renderer/store/settings.store';
import {
    useSleepTimerActions,
    useSleepTimerActive,
    useSleepTimerMode,
    useSleepTimerRemaining,
    useSleepTimerStore,
} from '/@/renderer/store/sleep-timer.store';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Button } from '/@/shared/components/button/button';
import { Divider } from '/@/shared/components/divider/divider';
import { Flex } from '/@/shared/components/flex/flex';
import { Grid } from '/@/shared/components/grid/grid';
import { Group } from '/@/shared/components/group/group';
import { NumberInput } from '/@/shared/components/number-input/number-input';
import { Popover } from '/@/shared/components/popover/popover';
import { Stack } from '/@/shared/components/stack/stack';
import { Text } from '/@/shared/components/text/text';
import { PlayerShuffle, PlayerStatus } from '/@/shared/types/types';

const PRESET_OPTIONS = [
    { minutes: 0, mode: 'endOfSong' as const },
    { minutes: 0, mode: 'endOfAlbum' as const },
    { minutes: 5, mode: 'timed' as const },
    { minutes: 10, mode: 'timed' as const },
    { minutes: 15, mode: 'timed' as const },
    { minutes: 30, mode: 'timed' as const },
    { minutes: 45, mode: 'timed' as const },
    { minutes: 60, mode: 'timed' as const },
    { minutes: 120, mode: 'timed' as const },
    { minutes: 180, mode: 'timed' as const },
    { minutes: 240, mode: 'timed' as const },
];

function formatRemaining(totalSeconds: number): string {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = Math.floor(totalSeconds % 60);

    if (h > 0) {
        return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${m}:${String(s).padStart(2, '0')}`;
}

const useSleepTimer = () => {
    const active = useSleepTimerActive();
    const mode = useSleepTimerMode();
    const { cancelTimer, setRemaining, setTargetAlbumId } = useSleepTimerActions();
    const { mediaPause } = usePlayer();
    const { setVolume } = usePlayerActions();
    const fadeSeconds = useSleepTimerFadeSeconds();

    const mediaPauseRef = useRef(mediaPause);
    mediaPauseRef.current = mediaPause;
    const setVolumeRef = useRef(setVolume);
    setVolumeRef.current = setVolume;
    const fadeSecondsRef = useRef(fadeSeconds);
    fadeSecondsRef.current = fadeSeconds;
    // Tracks the in-flight fade interval purely so a second fade can clear a
    // prior one. We intentionally do NOT clear this on unmount: a fade is only
    // ever started at timer expiry, which immediately calls cancelTimer() and
    // unmounts this hook. The fade must outlive that unmount so it can run to
    // completion — pausing and restoring volume in its final tick. Clearing it
    // on unmount would abort the fade before it ever paused, leaving playback
    // running at a reduced volume (the whole point of the timer defeated). The
    // interval is self-clearing and only calls store-level actions (setVolume /
    // mediaPause via refs), so it is safe to let it finish post-unmount.
    const fadeIntervalRef = useRef<null | number>(null);

    /**
     * Smoothly fade volume to 0 over {@link fadeSecondsRef} seconds, then pause
     * and restore the original volume so the user wakes to the same loudness
     * next time they hit play. If fade is disabled (0s) just pause hard.
     */
    const pauseWithOptionalFade = useCallback(() => {
        const fade = fadeSecondsRef.current;
        if (fade <= 0) {
            mediaPauseRef.current();
            return;
        }
        const startingVolume = usePlayerStoreBase.getState().player.volume;
        if (startingVolume <= 0) {
            mediaPauseRef.current();
            return;
        }
        const tickMs = 100;
        const totalTicks = Math.max(1, Math.round((fade * 1000) / tickMs));
        let tick = 0;
        // Clear any prior fade before starting a new one so we never leak a
        // second concurrent interval.
        if (fadeIntervalRef.current !== null) {
            window.clearInterval(fadeIntervalRef.current);
        }
        const id = window.setInterval(() => {
            tick += 1;
            const remainingFraction = Math.max(0, 1 - tick / totalTicks);
            setVolumeRef.current(Math.max(0, Math.round(startingVolume * remainingFraction)));
            if (tick >= totalTicks) {
                window.clearInterval(id);
                fadeIntervalRef.current = null;
                mediaPauseRef.current();
                // Give the engine one tick to apply pause, then restore volume.
                window.setTimeout(() => setVolumeRef.current(startingVolume), tickMs);
            }
        }, tickMs);
        fadeIntervalRef.current = id;
    }, []);

    // End of album mode. Set the pauseOnNextSongEnd flag whenever the current track
    // is the last one of the target album.
    const evaluateEndOfAlbum = useCallback(() => {
        const { currentSong, nextSong } = usePlayerStoreBase.getState().getPlayerData();

        if (!currentSong) {
            return;
        }

        let target = useSleepTimerStore.getState().targetAlbumId;

        if (target === null) {
            target = currentSong.albumId;
            setTargetAlbumId(target);
        }

        if (currentSong.albumId !== target) {
            usePlayerStoreBase.getState().setPauseOnNextSongEnd(false);
            cancelTimer();
            return;
        }

        const isLastOfAlbum = !nextSong || nextSong.albumId !== currentSong.albumId;
        usePlayerStoreBase.getState().setPauseOnNextSongEnd(isLastOfAlbum);
    }, [cancelTimer, setTargetAlbumId]);

    const handleOnCurrentSongChange = useCallback(() => {
        if (!active) {
            return;
        }

        // Cancel and pause on song change in end-of-song mode
        if (mode === 'endOfSong') {
            cancelTimer();
            pauseWithOptionalFade();
            return;
        }

        // Cancel and pause on song change in end-of-album mode
        if (mode === 'endOfAlbum') {
            evaluateEndOfAlbum();
        }
    }, [active, mode, cancelTimer, pauseWithOptionalFade, evaluateEndOfAlbum]);

    const status = usePlayerStatus();

    const handleOnPlayerProgress = useCallback(
        (properties: { timestamp: number }, prev: { timestamp: number }) => {
            if (!active) {
                return;
            }

            if (status !== PlayerStatus.PLAYING) {
                return;
            }

            // Skip seek-induced progress events. Normal playback advances
            // the timestamp by ~1 second per emission; anything bigger is a
            // seek that should not consume sleep-timer budget. We use 2 s
            // as the threshold so genuine multi-second progress hiccups
            // (e.g. a network stall on a streamed song) still decrement.
            const delta = Math.abs(properties.timestamp - prev.timestamp);
            if (delta > 2) {
                return;
            }

            // Count down in timed mode
            if (mode === 'timed') {
                const remaining = useSleepTimerStore.getState().remaining;

                if (remaining <= 0) {
                    cancelTimer();
                    pauseWithOptionalFade();
                } else {
                    setRemaining(Math.max(0, remaining - 1));
                }
            }
        },
        [active, cancelTimer, mode, pauseWithOptionalFade, setRemaining, status],
    );

    usePlayerEvents(
        {
            onCurrentSongChange: handleOnCurrentSongChange,
            onPlayerProgress: handleOnPlayerProgress,
        },
        [handleOnCurrentSongChange, handleOnPlayerProgress],
    );

    // End-of-song mode: set the pauseOnNextSongEnd flag so that
    // mediaAutoNext returns PAUSED status when the current song ends.
    // This is a generic player mechanism — the web player handles it
    // without needing to know about the sleep timer.
    // End-of-album mode: set the same flag conditionally, here we run
    // the intial evaluation in case the timer was started while already
    // on the last track of the album
    useEffect(() => {
        if (!active) {
            return;
        }

        if (mode === 'endOfSong') {
            usePlayerStoreBase.getState().setPauseOnNextSongEnd(true);

            return () => {
                usePlayerStoreBase.getState().setPauseOnNextSongEnd(false);
            };
        }

        if (mode === 'endOfAlbum') {
            evaluateEndOfAlbum();

            return () => {
                usePlayerStoreBase.getState().setPauseOnNextSongEnd(false);
            };
        }

        return undefined;
    }, [active, mode, evaluateEndOfAlbum]);
};

export const SleepTimerHookInner = () => {
    useSleepTimer();
    return null;
};

export const SleepTimerHook = () => {
    const active = useSleepTimerActive();

    if (!active) {
        return null;
    }

    return React.createElement(SleepTimerHookInner);
};

export const SleepTimerButton = () => {
    const { t } = useTranslation();
    const active = useSleepTimerActive();
    const mode = useSleepTimerMode();
    const remaining = useSleepTimerRemaining();
    const { cancelTimer, startEndOfAlbumTimer, startEndOfSongTimer, startTimedTimer } =
        useSleepTimerActions();
    const { mediaPause } = usePlayer();
    const shuffle = usePlayerShuffle();
    // Track level shuffle scatters and album across a play queue making 'end-of-album'
    // meaningless. Album shuffle keeps each album intact, so keep 'end-of-'album
    // enabled there
    const isTrackShuffle = shuffle === PlayerShuffle.TRACK;

    const [showCustom, setShowCustom] = useState(false);
    const [customHours, setCustomHours] = useState<number>(0);
    const [customMinutes, setCustomMinutes] = useState<number>(20);
    const [customSeconds, setCustomSeconds] = useState<number>(0);
    const [opened, setOpened] = useState(false);

    const fadeSeconds = useSleepTimerFadeSeconds();
    const { setSettings } = useSettingsStoreActions();

    const mediaPauseRef = useRef(mediaPause);
    mediaPauseRef.current = mediaPause;

    const handlePreset = useCallback(
        (option: (typeof PRESET_OPTIONS)[number]) => {
            if (option.mode === 'endOfSong') {
                startEndOfSongTimer();
            } else if (option.mode === 'endOfAlbum') {
                startEndOfAlbumTimer();
            } else {
                startTimedTimer(option.minutes * 60);
            }
            setShowCustom(false);
            setOpened(false);
        },
        [startEndOfAlbumTimer, startEndOfSongTimer, startTimedTimer],
    );

    const handleCustomStart = useCallback(() => {
        const totalSeconds = customHours * 3600 + customMinutes * 60 + customSeconds;
        if (totalSeconds > 0) {
            startTimedTimer(totalSeconds);
            setShowCustom(false);
            setOpened(false);
        }
    }, [customHours, customMinutes, customSeconds, startTimedTimer]);

    const handleCancel = useCallback(() => {
        cancelTimer();
        setShowCustom(false);
    }, [cancelTimer]);

    const getPresetLabel = (option: (typeof PRESET_OPTIONS)[number]) => {
        if (option.mode === 'endOfSong') {
            return t('player.sleepTimer_endOfSong');
        }
        if (option.mode === 'endOfAlbum') {
            return t('player.sleepTimer_endOfAlbum');
        }
        if (option.minutes >= 60) {
            return t('player.sleepTimer_hours', {
                count: option.minutes / 60,
            });
        }
        return t('player.sleepTimer_minutes', {
            count: option.minutes,
        });
    };

    return (
        <Popover onChange={setOpened} opened={opened} position="top" width={260}>
            <Popover.Target>
                <ActionIcon
                    icon={active ? 'sleepTimer' : 'sleepTimerOff'}
                    iconProps={{
                        color: active ? 'primary' : undefined,
                        size: 'lg',
                    }}
                    onClick={(e) => {
                        e.stopPropagation();
                        setOpened((prev) => !prev);
                    }}
                    size="sm"
                    tooltip={{
                        label: t('player.sleepTimer'),
                        openDelay: 400,
                    }}
                    variant="subtle"
                />
            </Popover.Target>
            <Popover.Dropdown>
                <Stack gap="xs" p="xs">
                    <Text fw="600" pb="md" size="sm" ta="center">
                        {t('player.sleepTimer')}
                    </Text>

                    {active && (
                        <Flex
                            align="center"
                            direction="column"
                            gap={4}
                            mb="xs"
                            style={{
                                background: 'var(--theme-colors-surface)',
                                borderRadius: 'var(--theme-radius-md)',
                                padding: 'var(--theme-spacing-sm) var(--theme-spacing-md)',
                            }}
                        >
                            {mode === 'endOfSong' ? (
                                <Text c="primary" size="sm">
                                    {t('player.sleepTimer_endOfSong')}
                                </Text>
                            ) : mode === 'endOfAlbum' ? (
                                <Text c="primary" size="sm">
                                    {t('player.sleepTimer_endOfAlbum')}
                                </Text>
                            ) : (
                                <Text c="primary" fw="600" size="lg">
                                    {formatRemaining(remaining)}
                                </Text>
                            )}
                            <Button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    handleCancel();
                                }}
                                size="compact-xs"
                                variant="subtle"
                            >
                                {t('player.sleepTimer_cancel')}
                            </Button>
                        </Flex>
                    )}

                    {PRESET_OPTIONS.filter(
                        (option) => option.mode === 'endOfSong' || option.mode === 'endOfAlbum',
                    ).map((option) => {
                        const disabled = option.mode === 'endOfAlbum' && isTrackShuffle;

                        return (
                            <Button
                                disabled={disabled}
                                fullWidth
                                justify="flex-start"
                                key={option.mode}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    handlePreset(option);
                                }}
                                size="xs"
                                variant="outline"
                            >
                                {getPresetLabel(option)}
                            </Button>
                        );
                    })}

                    <Divider my="md" />

                    <Grid gap="xs">
                        {PRESET_OPTIONS.filter((option) => option.mode === 'timed').map(
                            (option, index) => (
                                <Grid.Col key={index} span={4}>
                                    <Button
                                        fullWidth
                                        justify="flex-start"
                                        key={index}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            handlePreset(option);
                                        }}
                                        size="xs"
                                        variant="outline"
                                    >
                                        {getPresetLabel(option)}
                                    </Button>
                                </Grid.Col>
                            ),
                        )}
                    </Grid>

                    <Divider my="md" />

                    <Divider my={4} />
                    <Group align="center" gap="xs" justify="space-between" wrap="nowrap">
                        <Text c="dimmed" size="xs">
                            {t('player.sleepTimer_fadeOut')}
                        </Text>
                        <NumberInput
                            max={60}
                            min={0}
                            onChange={(val) => {
                                const n = Math.max(0, Math.min(60, Number(val) || 0));
                                setSettings({ playback: { sleepTimerFadeSeconds: n } });
                            }}
                            placeholder="0"
                            size="xs"
                            style={{ width: 80 }}
                            suffix="s"
                            value={fadeSeconds}
                        />
                    </Group>
                    <Divider my={4} />

                    {!showCustom ? (
                        <Button
                            fullWidth
                            justify="flex-start"
                            onClick={(e) => {
                                e.stopPropagation();
                                setShowCustom(true);
                            }}
                            size="xs"
                            ta="center"
                            variant="outline"
                        >
                            {t('player.sleepTimer_custom')}
                        </Button>
                    ) : (
                        <Stack gap="xs">
                            <Group gap={4} wrap="nowrap">
                                <NumberInput
                                    max={23}
                                    min={0}
                                    onChange={(val) => setCustomHours(Number(val) || 0)}
                                    placeholder="hr"
                                    size="xs"
                                    value={customHours}
                                />
                                <Text>:</Text>
                                <NumberInput
                                    max={59}
                                    min={0}
                                    onChange={(val) => setCustomMinutes(Number(val) || 0)}
                                    placeholder="min"
                                    size="xs"
                                    value={customMinutes}
                                />
                                <Text>:</Text>
                                <NumberInput
                                    max={59}
                                    min={0}
                                    onChange={(val) => setCustomSeconds(Number(val) || 0)}
                                    placeholder="sec"
                                    size="xs"
                                    value={customSeconds}
                                />
                            </Group>
                            <Group gap="xs" grow>
                                <Button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        handleCustomStart();
                                    }}
                                    size="xs"
                                    variant="filled"
                                >
                                    {t('player.sleepTimer_setCustom')}
                                </Button>
                                <Button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setShowCustom(false);
                                    }}
                                    size="xs"
                                    variant="default"
                                >
                                    {t('common.cancel')}
                                </Button>
                            </Group>
                        </Stack>
                    )}
                </Stack>
            </Popover.Dropdown>
        </Popover>
    );
};
