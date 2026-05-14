import { t } from 'i18next';
import { useCallback, useEffect, useState, WheelEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { DevicePickerButton } from '/@/renderer/features/jellyfin-remote-target/components/device-picker-button';
import { useActivePlayerSource } from '/@/renderer/features/jellyfin-remote-target/hooks/use-active-player-source';
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
    useAppStoreActions,
    useAutoDJSettings,
    useCurrentServer,
    useFullScreenPlayerStore,
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
import { Rating } from '/@/shared/components/rating/rating';
import { Tooltip } from '/@/shared/components/tooltip/tooltip';
import { useMediaQuery } from '/@/shared/hooks/use-media-query';
import { useThrottledCallback } from '/@/shared/hooks/use-throttled-callback';
import { useThrottledValue } from '/@/shared/hooks/use-throttled-value';
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

const AutoDJButton = () => {
    const { t } = useTranslation();
    const settings = useAutoDJSettings();
    const { setSettings } = useSettingsStoreActions();

    const toggleAutoDJ = () => {
        setSettings({
            autoDJ: {
                ...settings,
                enabled: !settings.enabled,
            },
        });
    };

    return (
        <Tooltip
            label={`${t('setting.autoDJ')} — ${t('setting.autoDJ_description')}`}
            openDelay={400}
            withinPortal
        >
            <Button
                aria-label={t('setting.autoDJ')}
                aria-pressed={settings.enabled}
                onClick={(e) => {
                    e.stopPropagation();
                    toggleAutoDJ();
                }}
                size="compact-xs"
                style={{ color: settings.enabled ? 'var(--theme-colors-primary)' : undefined }}
                uppercase
                variant="transparent"
            >
                {t('setting.autoDJ')}
            </Button>
        </Tooltip>
    );
};

const QueueButton = () => {
    const { t } = useTranslation();
    const isSidebarRightExpanded = useSidebarRightExpanded();
    const { setSideBar } = useAppStoreActions();
    const sideQueueType = useSideQueueType();

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
        />
    );
};

const LyricsButton = () => {
    const setFullScreenPlayerStore = useSetFullScreenPlayerStore();
    const activeTab = useFullScreenPlayerStore((state) => state.activeTab);

    const { setStore } = useFullScreenPlayerStoreActions();
    const { expanded: isFullScreenPlayerExpanded } = useFullScreenPlayerStore();

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
    const currentSong = useActivePlayerSource().nowPlayingItem;
    const { bindings } = useHotkeySettings();

    const addToFavoritesMutation = useCreateFavorite({});
    const removeFromFavoritesMutation = useDeleteFavorite({});

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
    const currentSong = useActivePlayerSource().nowPlayingItem;
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

    const throttledVolume = useThrottledValue(sliderValue, 100);

    // Sync throttled value to actual volume
    useEffect(() => {
        setVolume(throttledVolume);
    }, [throttledVolume, setVolume]);

    // Sync external volume changes to local state
    useEffect(() => {
        setSliderValue(volume);
    }, [volume]);

    const handleVolumeDown = useCallback(() => {
        decreaseVolume(volumeWheelStep);
    }, [decreaseVolume, volumeWheelStep]);

    const handleVolumeUp = useCallback(() => {
        increaseVolume(volumeWheelStep);
    }, [increaseVolume, volumeWheelStep]);

    const handleVolumeSlider = useCallback((e: number) => {
        setSliderValue(e);
    }, []);

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
                    max={100}
                    min={0}
                    onChange={handleVolumeSlider}
                    onClick={(e) => {
                        e.stopPropagation();
                    }}
                    onWheel={handleVolumeWheel}
                    size={6}
                    value={sliderValue}
                    w={volumeWidth}
                />
            ) : null}
        </>
    );
};
