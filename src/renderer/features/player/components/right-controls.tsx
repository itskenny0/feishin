import { t } from 'i18next';
import { useCallback, useEffect, useMemo, useRef, useState, WheelEvent } from 'react';
import { useTranslation } from 'react-i18next';

import styles from './right-controls.module.css';

import { DevicePickerButton } from '/@/renderer/features/jellyfin-remote-target/components/device-picker-button';
import {
    useActiveNowPlayingItem,
    useActivePlayerSource,
    useTransportEnabled,
} from '/@/renderer/features/jellyfin-remote-target/hooks/use-active-player-source';
import { PopoverPlayQueue } from '/@/renderer/features/now-playing/components/popover-play-queue';
import { PlayerConfig } from '/@/renderer/features/player/components/player-config';
import { CustomPlayerbarSlider } from '/@/renderer/features/player/components/playerbar-slider';
import { SleepTimerButton } from '/@/renderer/features/player/components/sleep-timer-button';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import { useSetRating } from '/@/renderer/features/shared/hooks/use-set-rating';
import { useCreateFavorite } from '/@/renderer/features/shared/mutations/create-favorite-mutation';
import { useDeleteFavorite } from '/@/renderer/features/shared/mutations/delete-favorite-mutation';
import { useHotkeys } from '/@/renderer/hooks/use-hotkeys';
import {
    AUTO_DJ_MODE,
    AUTO_DJ_STRATEGY,
    type AutoDJStrategy,
    useAppStoreActions,
    useAutoDJSettings,
    useCurrentServer,
    useFullScreenPlayerActiveTab,
    useFullScreenPlayerExpanded,
    useHotkeySettings,
    usePlayerData,
    usePlayerMuted,
    useSetFullScreenPlayerStore,
    useSettingsStoreActions,
    useShowRatings,
    useSidebarRightExpanded,
    useSideQueueType,
    useVolumeWheelStep,
    useVolumeWidth,
} from '/@/renderer/store';
import { useFullScreenPlayerStoreActions } from '/@/renderer/store/full-screen-player.store';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Button } from '/@/shared/components/button/button';
import { Flex } from '/@/shared/components/flex/flex';
import { Group } from '/@/shared/components/group/group';
import { NumberInput } from '/@/shared/components/number-input/number-input';
import { Paper } from '/@/shared/components/paper/paper';
import { Popover } from '/@/shared/components/popover/popover';
import { Rating } from '/@/shared/components/rating/rating';
import { SegmentedControl } from '/@/shared/components/segmented-control/segmented-control';
import { Select } from '/@/shared/components/select/select';
import { Stack } from '/@/shared/components/stack/stack';
import { Switch } from '/@/shared/components/switch/switch';
import { Text } from '/@/shared/components/text/text';
import { useMediaQuery } from '/@/shared/hooks/use-media-query';
import { useThrottledCallback } from '/@/shared/hooks/use-throttled-callback';
import { LibraryItem, QueueSong, ServerType, Song } from '/@/shared/types/domain-types';

const calculateVolumeUp = (volume: number, volumeWheelStep: number) => {
    let volumeToSet: number;
    const newVolumeGreaterThanHundred = volume + volumeWheelStep > 100;
    if (newVolumeGreaterThanHundred) {
        volumeToSet = 100;
    } else {
        volumeToSet = volume + volumeWheelStep;
    }

    return volumeToSet;
};

const calculateVolumeDown = (volume: number, volumeWheelStep: number) => {
    let volumeToSet: number;
    const newVolumeLessThanZero = volume - volumeWheelStep < 0;
    if (newVolumeLessThanZero) {
        volumeToSet = 0;
    } else {
        volumeToSet = volume - volumeWheelStep;
    }

    return volumeToSet;
};

export const RightControls = () => {
    const showRatings = useShowRatings();
    return (
        <Flex align="flex-end" direction="column" h="100%" px="1rem" py="0.5rem">
            <Group h="calc(100% / 3)">
                {showRatings && <RatingButton />}
                <AutoDJButton />
            </Group>
            <Group align="center" gap="xs" wrap="nowrap">
                <SleepTimerButton />
                <PlayerConfig />
                <LyricsButton />
                <FavoriteButton />
                <QueueButton />
                <DevicePickerButton />
                <VolumeButton />
            </Group>
            <Group h="calc(100% / 3)" />
        </Flex>
    );
};

/**
 * Toggles the auto-DJ setting (keep playing similar tracks once the queue
 * runs dry). Exported so the mobile fullscreen player can reuse it - it
 * was previously a desktop-only convenience.
 */
export const AutoDJButton = () => {
    const { t } = useTranslation();
    const settings = useAutoDJSettings();
    const { setSettings } = useSettingsStoreActions();

    const itemLabels = useMemo(() => {
        return {
            description: t('setting.autoDJ_itemCount_description'),
            title: t('setting.autoDJ_itemCount'),
        };
    }, [t]);

    const strategySelectData = useMemo(
        () => [
            {
                label: t('setting.autoDJ_strategy_option_similar'),
                value: AUTO_DJ_STRATEGY.SIMILAR,
            },
            {
                label: t('setting.autoDJ_strategy_option_library_random'),
                value: AUTO_DJ_STRATEGY.LIBRARY_RANDOM,
            },
        ],
        [t],
    );

    const strategyLabels =
        settings.mode === AUTO_DJ_MODE.ALBUMS
            ? {
                  description: '',
                  title: t('setting.autoDJ_albumStrategy'),
              }
            : {
                  description: '',
                  title: t('setting.autoDJ_songStrategy'),
              };

    const strategyValue =
        settings.mode === AUTO_DJ_MODE.ALBUMS
            ? (settings.albumStrategy ?? AUTO_DJ_STRATEGY.SIMILAR)
            : (settings.songStrategy ?? AUTO_DJ_STRATEGY.SIMILAR);

    return (
        <Popover position="top-end" withArrow>
            <Popover.Target>
                <Button
                    onClick={(e) => {
                        e.stopPropagation();
                    }}
                    size="compact-xs"
                    style={{ color: settings.enabled ? 'var(--theme-colors-primary)' : undefined }}
                    uppercase
                    variant="transparent"
                >
                    {t('setting.autoDJ')}
                </Button>
            </Popover.Target>
            <Popover.Dropdown maw={320} miw={260} onClick={(e) => e.stopPropagation()} p="sm">
                <Stack gap="sm">
                    <Paper p="md" radius="md">
                        <Group align="center" gap="xs" justify="space-between" wrap="nowrap">
                            <Text fw={600} isNoSelect size="sm">
                                {t('setting.autoDJ_enabled')}
                            </Text>
                            <Switch
                                checked={settings.enabled}
                                onChange={(e) =>
                                    setSettings({
                                        autoDJ: { enabled: e.currentTarget.checked },
                                    })
                                }
                            />
                        </Group>
                    </Paper>
                    <SegmentedControl
                        data={[
                            { label: t('setting.autoDJ_mode_songs'), value: AUTO_DJ_MODE.SONGS },
                            {
                                label: t('setting.autoDJ_mode_albums'),
                                value: AUTO_DJ_MODE.ALBUMS,
                            },
                        ]}
                        onChange={(value) =>
                            setSettings({
                                autoDJ: {
                                    mode: value as 'albums' | 'songs',
                                },
                            })
                        }
                        value={settings.mode}
                        w="100%"
                    />
                    <Select
                        comboboxProps={{ withinPortal: false }}
                        data={strategySelectData}
                        description={strategyLabels.description}
                        label={strategyLabels.title}
                        onChange={(value) => {
                            if (!value) return;
                            setSettings({
                                autoDJ:
                                    settings.mode === AUTO_DJ_MODE.ALBUMS
                                        ? { albumStrategy: value as AutoDJStrategy }
                                        : { songStrategy: value as AutoDJStrategy },
                            });
                        }}
                        size="md"
                        value={strategyValue}
                        w="100%"
                    />
                    <NumberInput
                        aria-label={itemLabels.title}
                        description={itemLabels.description}
                        hideControls={false}
                        label={itemLabels.title}
                        max={50}
                        min={1}
                        onChange={(e) =>
                            setSettings({
                                autoDJ: {
                                    itemCount: Number(e),
                                },
                            })
                        }
                        size="md"
                        value={Number(settings.itemCount)}
                    />
                    <NumberInput
                        aria-label={t('setting.autoDJ_timing')}
                        description={t('setting.autoDJ_timing_description')}
                        hideControls={false}
                        label={t('setting.autoDJ_timing')}
                        max={5}
                        min={1}
                        onChange={(e) =>
                            setSettings({
                                autoDJ: {
                                    timing: Number(e),
                                },
                            })
                        }
                        size="md"
                        value={Number(settings.timing)}
                    />
                </Stack>
            </Popover.Dropdown>
        </Popover>
    );
};

const QueueButton = () => {
    const { t } = useTranslation();
    const isSidebarRightExpanded = useSidebarRightExpanded();
    const { setSideBar } = useAppStoreActions();
    const sideQueueType = useSideQueueType();
    // Surface queue size on the toggle button itself via a small numeric
    // badge — saves a click for "how many tracks are queued?". usePlayerData
    // is already memoised with shallow equality so this doesn't add a
    // re-render hot path.
    const { queueLength } = usePlayerData();

    const { bindings } = useHotkeySettings();

    const [popoverOpened, setPopoverOpened] = useState(false);

    const handleToggleQueue = () => {
        if (sideQueueType === 'sideQueue') {
            setSideBar({ rightExpanded: !isSidebarRightExpanded });
        } else {
            setPopoverOpened((prev) => !prev);
        }
    };

    const handlePopoverClose = () => {
        setPopoverOpened(false);
    };

    useHotkeys([
        [bindings.toggleQueue.isGlobal ? '' : bindings.toggleQueue.hotkey, handleToggleQueue],
        // Escape closes the queue drawer when it's open. Consistent with
        // how Escape closes modals/dialogs throughout the app — without
        // this the right-side queue had no keyboard close affordance.
        [
            'Escape',
            (e) => {
                if (sideQueueType === 'sideQueue' && isSidebarRightExpanded) {
                    e.preventDefault();
                    setSideBar({ rightExpanded: false });
                }
            },
        ],
    ]);

    const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
        e.stopPropagation();

        if (sideQueueType === 'sideQueue') {
            return handleToggleQueue();
        }
    };

    if (sideQueueType === 'sideQueue') {
        return (
            <div className={styles.queueButtonWrapper}>
                <ActionIcon
                    icon={isSidebarRightExpanded ? 'panelRightClose' : 'panelRightOpen'}
                    iconProps={{
                        size: 'lg',
                    }}
                    onClick={handleClick}
                    size="sm"
                    tooltip={{
                        label: t('player.viewQueue'),
                        openDelay: 400,
                    }}
                    variant="subtle"
                />
                {queueLength > 0 && (
                    <span aria-hidden className={styles.queueBadge}>
                        {queueLength > 99 ? '99+' : queueLength}
                    </span>
                )}
            </div>
        );
    }

    return (
        <PopoverPlayQueue
            onClose={handlePopoverClose}
            onToggle={(e) => {
                e.stopPropagation();
                handleToggleQueue();
            }}
            opened={popoverOpened}
            queueLength={queueLength}
        />
    );
};

const LyricsButton = () => {
    const setFullScreenPlayerStore = useSetFullScreenPlayerStore();
    const activeTab = useFullScreenPlayerActiveTab();

    const { setStore } = useFullScreenPlayerStoreActions();
    const isFullScreenPlayerExpanded = useFullScreenPlayerExpanded();

    const expandFullScreenPlayer = () => {
        setFullScreenPlayerStore({ expanded: !isFullScreenPlayerExpanded });
    };

    return (
        <ActionIcon
            icon="microphone"
            iconProps={{
                color: activeTab === 'lyrics' && isFullScreenPlayerExpanded ? 'primary' : undefined,
                size: 'lg',
            }}
            onClick={(e) => {
                e.stopPropagation();
                if (!isFullScreenPlayerExpanded) setStore({ activeTab: 'lyrics' });
                expandFullScreenPlayer();
            }}
            role="button"
            size="sm"
            tooltip={{
                label: t('player.lyrics'),
                openDelay: 400,
            }}
            variant="subtle"
        />
    );
};

const FavoriteButton = () => {
    const currentSong = useActiveNowPlayingItem();
    const { bindings } = useHotkeySettings();

    const addToFavoritesMutation = useCreateFavorite({});
    const removeFromFavoritesMutation = useDeleteFavorite({});

    // Track the previous favorite state so we can fire a one-shot "pulse"
    // animation when the heart goes off -> on. The pulseOn flag is true
    // for a single animation duration, then resets so the next favorite
    // toggle (on a different song, say) can fire it again. Un-favoriting
    // intentionally stays plain — a celebratory pulse for the destructive
    // direction would read as noise.
    const isFavorite = Boolean(currentSong?.userFavorite);
    const prevFavoriteRef = useRef(isFavorite);
    const [pulseOn, setPulseOn] = useState(false);

    useEffect(() => {
        const prev = prevFavoriteRef.current;
        prevFavoriteRef.current = isFavorite;
        if (!prev && isFavorite) {
            setPulseOn(true);
            const handle = window.setTimeout(() => setPulseOn(false), 320);
            return () => window.clearTimeout(handle);
        }
        return undefined;
    }, [isFavorite]);

    const handleAddToFavorites = (song: null | QueueSong | Song | undefined) => {
        if (!song?.id) return;

        addToFavoritesMutation.mutate({
            apiClientProps: { serverId: song?._serverId || '' },
            query: {
                id: [song.id],
                type: LibraryItem.SONG,
            },
        });
    };

    const handleRemoveFromFavorites = (song: null | QueueSong | Song | undefined) => {
        if (!song?.id) return;

        removeFromFavoritesMutation.mutate({
            apiClientProps: { serverId: song?._serverId || '' },
            query: {
                id: [song.id],
                type: LibraryItem.SONG,
            },
        });
    };

    const handleToggleFavorite = (song: null | QueueSong | Song | undefined) => {
        if (!song?.id) return;

        if (song.userFavorite) {
            handleRemoveFromFavorites(song);
        } else {
            handleAddToFavorites(song);
        }
    };

    useFavoritePreviousSongHotkeys({
        handleAddToFavorites,
        handleRemoveFromFavorites,
        handleToggleFavorite,
    });

    useHotkeys([
        [
            bindings.favoriteCurrentAdd.isGlobal ? '' : bindings.favoriteCurrentAdd.hotkey,
            () => handleAddToFavorites(currentSong),
        ],
        [
            bindings.favoriteCurrentRemove.isGlobal ? '' : bindings.favoriteCurrentRemove.hotkey,
            () => handleRemoveFromFavorites(currentSong),
        ],
        [
            bindings.favoriteCurrentToggle.isGlobal ? '' : bindings.favoriteCurrentToggle.hotkey,
            () => handleToggleFavorite(currentSong),
        ],
    ]);

    return (
        <ActionIcon
            icon="favorite"
            iconProps={{
                className: pulseOn ? styles.heartPulse : undefined,
                fill: currentSong?.userFavorite ? 'primary' : undefined,
                size: 'lg',
            }}
            onClick={(e) => {
                e.stopPropagation();
                handleToggleFavorite(currentSong);
            }}
            size="sm"
            tooltip={{
                label: currentSong?.userFavorite ? t('player.unfavorite') : t('player.favorite'),
                openDelay: 400,
            }}
            variant="subtle"
        />
    );
};

const useFavoritePreviousSongHotkeys = ({
    handleAddToFavorites,
    handleRemoveFromFavorites,
    handleToggleFavorite,
}: {
    handleAddToFavorites: (song: null | QueueSong | Song | undefined) => void;
    handleRemoveFromFavorites: (song: null | QueueSong | Song | undefined) => void;
    handleToggleFavorite: (song: null | QueueSong | Song | undefined) => void;
}) => {
    const { bindings } = useHotkeySettings();
    const { previousSong } = usePlayerData();

    useHotkeys([
        [
            bindings.favoritePreviousAdd.isGlobal ? '' : bindings.favoritePreviousAdd.hotkey,
            () => handleAddToFavorites(previousSong),
        ],
        [
            bindings.favoritePreviousRemove.isGlobal ? '' : bindings.favoritePreviousRemove.hotkey,
            () => handleRemoveFromFavorites(previousSong),
        ],
        [
            bindings.favoritePreviousToggle.isGlobal ? '' : bindings.favoritePreviousToggle.hotkey,
            () => handleToggleFavorite(previousSong),
        ],
    ]);

    return null;
};

const RatingButton = () => {
    const server = useCurrentServer();
    const currentSong = useActiveNowPlayingItem();
    const setRating = useSetRating();

    const isSongDefined = Boolean(currentSong?.id);
    const showRating =
        isSongDefined &&
        (server?.type === ServerType.NAVIDROME || server?.type === ServerType.SUBSONIC);

    const handleUpdateRating = (rating: number) => {
        if (!currentSong) return;

        setRating(currentSong._serverId, [currentSong.id], LibraryItem.SONG, rating);
    };

    const { bindings } = useHotkeySettings();

    useHotkeys([
        [bindings.rate0.isGlobal ? '' : bindings.rate0.hotkey, () => handleUpdateRating(0)],
        [bindings.rate1.isGlobal ? '' : bindings.rate1.hotkey, () => handleUpdateRating(1)],
        [bindings.rate2.isGlobal ? '' : bindings.rate2.hotkey, () => handleUpdateRating(2)],
        [bindings.rate3.isGlobal ? '' : bindings.rate3.hotkey, () => handleUpdateRating(3)],
        [bindings.rate4.isGlobal ? '' : bindings.rate4.hotkey, () => handleUpdateRating(4)],
        [bindings.rate5.isGlobal ? '' : bindings.rate5.hotkey, () => handleUpdateRating(5)],
    ]);

    return (
        <>
            {showRating && (
                <Rating
                    onChange={handleUpdateRating}
                    size="xs"
                    value={currentSong?.userRating || 0}
                />
            )}
        </>
    );
};

const VolumeButton = () => {
    const { bindings } = useHotkeySettings();
    const source = useActivePlayerSource();
    const canSetVolume = useTransportEnabled('SetVolume');
    const localMuted = usePlayerMuted();
    const volume = source.volume;
    // In remote mode, volume === 0 is a proxy for muted; in local mode, keep the
    // dedicated muted store value which can be independent of slider volume.
    const muted = source.mode === 'remote' ? source.volume === 0 : localMuted;
    const volumeWheelStep = useVolumeWheelStep();
    const volumeWidth = useVolumeWidth();
    const { decreaseVolume, increaseVolume, mediaToggleMute, setVolume } = usePlayer();
    const isMinWidth = useMediaQuery('(max-width: 480px)');

    const [sliderValue, setSliderValue] = useState(volume);

    // Sync external volume changes to local state. Drops re-fires from our
    // own optimistic mirror so we don't fight the slider mid-drag.
    useEffect(() => {
        setSliderValue(volume);
    }, [volume]);

    const handleVolumeDown = useCallback(() => {
        decreaseVolume(volumeWheelStep);
    }, [decreaseVolume, volumeWheelStep]);

    const handleVolumeUp = useCallback(() => {
        increaseVolume(volumeWheelStep);
    }, [increaseVolume, volumeWheelStep]);

    // Drive the slider value AND the underlying engine in one step. The
    // remote dispatcher already coalesces a burst into leading+trailing
    // POSTs; the local engine is a cheap zustand set. The previous 100ms
    // throttled-value indirection added a flat 100ms gate to every slider
    // tick (and ~100ms of latency for the last value of a drag), so any
    // remote target felt sluggish even when the wire was idle. Forwarding
    // straight through keeps the UI in lock-step with the click. Logged so
    // we can correlate against the dispatcher's publish trace.
    const handleVolumeSlider = useCallback(
        (e: number) => {
            setSliderValue(e);
            setVolume(e);
        },
        [setVolume],
    );

    const handleMute = useCallback(() => {
        mediaToggleMute();
    }, [mediaToggleMute]);

    const handleVolumeWheel = useCallback(
        (e: WheelEvent<HTMLButtonElement | HTMLDivElement>) => {
            let volumeToSet;
            if (e.deltaY > 0 || e.deltaX > 0) {
                volumeToSet = calculateVolumeDown(volume, volumeWheelStep);
            } else {
                volumeToSet = calculateVolumeUp(volume, volumeWheelStep);
            }

            // Move the thumb optimistically (like the drag path) instead
            // of waiting for the [volume] effect to round-trip the store.
            // In remote mode `source.volume` is an async mirror, so without
            // this the thumb (and the volume-driven icon/tooltip) visibly
            // lag the wheel.
            setSliderValue(volumeToSet);
            setVolume(volumeToSet);
        },
        [setVolume, volume, volumeWheelStep],
    );

    const handleVolumeDownThrottled = useThrottledCallback(handleVolumeDown, 100);
    const handleVolumeUpThrottled = useThrottledCallback(handleVolumeUp, 100);

    useHotkeys([
        [bindings.volumeDown.isGlobal ? '' : bindings.volumeDown.hotkey, handleVolumeDownThrottled],
        [bindings.volumeUp.isGlobal ? '' : bindings.volumeUp.hotkey, handleVolumeUpThrottled],
        [bindings.volumeMute.isGlobal ? '' : bindings.volumeMute.hotkey, handleMute],
    ]);

    return (
        <>
            <ActionIcon
                aria-label={muted || volume === 0 ? t('player.muted') : t('player.volume')}
                // Show the muted icon at 0 volume too — slider-to-zero
                // should look the same as explicit mute, otherwise the
                // icon stays at 'volumeNormal' while no sound plays and
                // it reads as "Feishin is broken".
                icon={
                    muted || volume === 0
                        ? 'volumeMute'
                        : volume > 50
                          ? 'volumeMax'
                          : 'volumeNormal'
                }
                iconProps={{
                    color: muted ? 'muted' : undefined,
                    size: 'xl',
                }}
                onClick={(e) => {
                    e.stopPropagation();
                    handleMute();
                }}
                onWheel={handleVolumeWheel}
                size="sm"
                tooltip={{
                    label: muted ? t('player.muted') : `${volume}%`,
                    openDelay: 400,
                }}
                variant="subtle"
            />
            {!isMinWidth ? (
                <CustomPlayerbarSlider
                    disabled={!canSetVolume}
                    max={100}
                    min={0}
                    onChange={handleVolumeSlider}
                    onClick={(e) => {
                        e.stopPropagation();
                    }}
                    onWheel={handleVolumeWheel}
                    size={6}
                    style={{ opacity: canSetVolume ? undefined : 0.4 }}
                    value={sliderValue}
                    w={volumeWidth}
                />
            ) : null}
        </>
    );
};
