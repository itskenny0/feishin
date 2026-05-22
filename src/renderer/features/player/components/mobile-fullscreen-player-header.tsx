import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import styles from './mobile-fullscreen-player.module.css';

import { SONG_TABLE_COLUMNS } from '/@/renderer/components/item-list/item-table-list/default-columns';
import { AutoDJButton } from '/@/renderer/features/player/components/right-controls';
import { SleepTimerButton } from '/@/renderer/features/player/components/sleep-timer-button';
import {
    ListConfigMenu,
    SONG_DISPLAY_TYPES,
} from '/@/renderer/features/shared/components/list-config-menu';
import {
    useFullScreenPlayerStore,
    useFullScreenPlayerStoreActions,
    useLyricsDisplaySettings,
    useLyricsSettings,
    usePlaybackSettings,
    useSettingsStore,
    useSettingsStoreActions,
} from '/@/renderer/store';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Button } from '/@/shared/components/button/button';
import { Divider } from '/@/shared/components/divider/divider';
import { Group } from '/@/shared/components/group/group';
import { NumberInput } from '/@/shared/components/number-input/number-input';
import { Option } from '/@/shared/components/option/option';
import { Popover } from '/@/shared/components/popover/popover';
import { SegmentedControl } from '/@/shared/components/segmented-control/segmented-control';
import { Slider } from '/@/shared/components/slider/slider';
import { Switch } from '/@/shared/components/switch/switch';
import { QueueSong } from '/@/shared/types/domain-types';
import { ItemListKey, ListDisplayType } from '/@/shared/types/types';

interface MobileFullscreenPlayerHeaderProps {
    currentSong?: QueueSong;
    isPageHovered: boolean;
    onClose: () => void;
}

export const MobileFullscreenPlayerHeader = memo(
    ({ isPageHovered, onClose }: MobileFullscreenPlayerHeaderProps) => {
        const { t } = useTranslation();
        const {
            dynamicBackground,
            dynamicImageBlur,
            dynamicIsImage,
            opacity,
            useImageAspectRatio,
            visualizerAsBackground,
            visualizerLyricsOverlay,
        } = useFullScreenPlayerStore();
        const { setStore } = useFullScreenPlayerStoreActions();
        const { setSettings } = useSettingsStoreActions();
        const { webAudio } = usePlaybackSettings();
        const lyricsSettings = useLyricsSettings();
        const displaySettings = useLyricsDisplaySettings('default');
        const lyricConfig = { ...lyricsSettings, ...displaySettings };

        const handleOpenVisualizer = () => {
            // Web Audio is the prerequisite for the visualizer — without
            // it there's no analyzer to drive the canvas. The setting
            // lives in Playback → Web Audio which is a long way down a
            // sub-menu on mobile, so we flip it on inline here and then
            // expand. If the user prefers it off, they can toggle it
            // back in Playback settings.
            if (!webAudio) {
                setSettings({ playback: { webAudio: true } });
            }
            setStore({ visualizerExpanded: true });
        };

        const handleLyricsSettings = (property: string, value: any) => {
            const displayProperties = ['fontSize', 'fontSizeUnsync', 'gap', 'gapUnsync'];
            if (displayProperties.includes(property)) {
                const currentDisplay = useSettingsStore.getState().lyricsDisplay;
                setSettings({
                    lyricsDisplay: {
                        ...currentDisplay,
                        default: {
                            ...currentDisplay.default,
                            [property]: value,
                        },
                    },
                });
            } else {
                setSettings({
                    lyrics: {
                        ...useSettingsStore.getState().lyrics,
                        [property]: value,
                    },
                });
            }
        };

        return (
            <div
                className={styles.header}
                style={{
                    background: `rgb(var(--theme-colors-background-transparent), ${opacity}%)`,
                }}
            >
                <ActionIcon
                    icon="arrowDownS"
                    iconProps={{ size: 'lg' }}
                    onClick={onClose}
                    tooltip={{ label: t('common.minimize'), openDelay: 400 }}
                    variant={isPageHovered ? 'default' : 'subtle'}
                />
                <Popover position="bottom-end">
                    <Popover.Target>
                        <ActionIcon
                            icon="settings2"
                            iconProps={{ size: 'lg' }}
                            tooltip={{ label: t('common.configure'), openDelay: 400 }}
                            variant={isPageHovered ? 'default' : 'subtle'}
                        />
                    </Popover.Target>
                    <Popover.Dropdown>
                        <Option>
                            <Option.Label>
                                {t('page.fullscreenPlayer.config.dynamicBackground')}
                            </Option.Label>
                            <Option.Control>
                                <Switch
                                    defaultChecked={dynamicBackground}
                                    onChange={(e) =>
                                        setStore({
                                            dynamicBackground: e.target.checked,
                                        })
                                    }
                                />
                            </Option.Control>
                        </Option>
                        {dynamicBackground && (
                            <Option>
                                <Option.Label>
                                    {t('page.fullscreenPlayer.config.dynamicIsImage')}
                                </Option.Label>
                                <Option.Control>
                                    <Switch
                                        defaultChecked={dynamicIsImage}
                                        onChange={(e) =>
                                            setStore({
                                                dynamicIsImage: e.target.checked,
                                            })
                                        }
                                    />
                                </Option.Control>
                            </Option>
                        )}
                        {dynamicBackground && dynamicIsImage && (
                            <Option>
                                <Option.Label>
                                    {t('page.fullscreenPlayer.config.dynamicImageBlur')}
                                </Option.Label>
                                <Option.Control>
                                    <Slider
                                        defaultValue={dynamicImageBlur}
                                        label={(e) => `${e} rem`}
                                        max={6}
                                        min={0}
                                        onChangeEnd={(e) =>
                                            setStore({ dynamicImageBlur: Number(e) })
                                        }
                                        step={0.5}
                                        w="100%"
                                    />
                                </Option.Control>
                            </Option>
                        )}
                        {dynamicBackground && (
                            <Option>
                                <Option.Label>
                                    {t('page.fullscreenPlayer.config.opacity')}
                                </Option.Label>
                                <Option.Control>
                                    <Slider
                                        defaultValue={opacity}
                                        label={(e) => `${e} %`}
                                        max={100}
                                        min={0}
                                        onChangeEnd={(e) => setStore({ opacity: Number(e) })}
                                        w="100%"
                                    />
                                </Option.Control>
                            </Option>
                        )}
                        <Option>
                            <Option.Label>
                                {t('page.fullscreenPlayer.config.useImageAspectRatio')}
                            </Option.Label>
                            <Option.Control>
                                <Switch
                                    checked={useImageAspectRatio}
                                    onChange={(e) =>
                                        setStore({
                                            useImageAspectRatio: e.target.checked,
                                        })
                                    }
                                />
                            </Option.Control>
                        </Option>
                        {/*
                         * Direct entry point to the fullscreen visualizer
                         * surface. Mobile used to surface the visualizer
                         * through an inline card lower in the scroll
                         * stack, but the card is gated on webAudio being
                         * on and the option to flip it is buried in the
                         * Playback settings — meaning a fresh-install
                         * user had no obvious path to the visualizer.
                         * This button flips Web Audio on (if needed) and
                         * jumps straight to the expanded view.
                         */}
                        <Option>
                            <Option.Label>
                                {t('page.fullscreenPlayer.config.visualizer', {
                                    defaultValue: 'Visualizer',
                                })}
                            </Option.Label>
                            <Option.Control>
                                <Button onClick={handleOpenVisualizer} size="compact-sm">
                                    {t('common.open', { defaultValue: 'Open' })}
                                </Button>
                            </Option.Control>
                        </Option>
                        <Option>
                            <Option.Label>
                                {t('page.fullscreenPlayer.config.visualizerAsBackground', {
                                    defaultValue: 'Visualizer as background',
                                })}
                            </Option.Label>
                            <Option.Control>
                                <Switch
                                    checked={!!visualizerAsBackground}
                                    onChange={(e) =>
                                        setStore({
                                            visualizerAsBackground: e.target.checked,
                                        })
                                    }
                                />
                            </Option.Control>
                        </Option>
                        <Option>
                            <Option.Label>
                                {t('page.fullscreenPlayer.config.visualizerLyricsOverlay', {
                                    defaultValue: 'Show lyrics over visualizer',
                                })}
                            </Option.Label>
                            <Option.Control>
                                <Switch
                                    checked={visualizerLyricsOverlay !== false}
                                    onChange={(e) =>
                                        setStore({
                                            visualizerLyricsOverlay: e.target.checked,
                                        })
                                    }
                                />
                            </Option.Control>
                        </Option>
                        <Divider my="sm" />
                        <Option>
                            <Option.Label>
                                {t('page.fullscreenPlayer.config.followCurrentLyric')}
                            </Option.Label>
                            <Option.Control>
                                <Switch
                                    checked={lyricConfig.follow}
                                    onChange={(e) =>
                                        handleLyricsSettings('follow', e.currentTarget.checked)
                                    }
                                />
                            </Option.Control>
                        </Option>
                        <Option>
                            <Option.Label>
                                {t('page.fullscreenPlayer.config.showLyricProvider')}
                            </Option.Label>
                            <Option.Control>
                                <Switch
                                    checked={lyricConfig.showProvider}
                                    onChange={(e) =>
                                        handleLyricsSettings(
                                            'showProvider',
                                            e.currentTarget.checked,
                                        )
                                    }
                                />
                            </Option.Control>
                        </Option>
                        <Option>
                            <Option.Label>
                                {t('page.fullscreenPlayer.config.showLyricMatch')}
                            </Option.Label>
                            <Option.Control>
                                <Switch
                                    checked={lyricConfig.showMatch}
                                    onChange={(e) =>
                                        handleLyricsSettings('showMatch', e.currentTarget.checked)
                                    }
                                />
                            </Option.Control>
                        </Option>
                        <Option>
                            <Option.Label>
                                {t('page.fullscreenPlayer.config.lyricSize')}
                            </Option.Label>
                            <Option.Control>
                                <Group w="100%" wrap="nowrap">
                                    <Slider
                                        defaultValue={lyricConfig.fontSize}
                                        label={(e) =>
                                            `${t('page.fullscreenPlayer.config.synchronized')}: ${e}px`
                                        }
                                        max={72}
                                        min={8}
                                        onChangeEnd={(e) =>
                                            handleLyricsSettings('fontSize', Number(e))
                                        }
                                        w="100%"
                                    />
                                    <Slider
                                        defaultValue={lyricConfig.fontSizeUnsync}
                                        label={(e) =>
                                            `${t('page.fullscreenPlayer.config.unsynchronized')}: ${e}px`
                                        }
                                        max={72}
                                        min={8}
                                        onChangeEnd={(e) =>
                                            handleLyricsSettings('fontSizeUnsync', Number(e))
                                        }
                                        w="100%"
                                    />
                                </Group>
                            </Option.Control>
                        </Option>
                        <Option>
                            <Option.Label>
                                {t('page.fullscreenPlayer.config.lyricGap')}
                            </Option.Label>
                            <Option.Control>
                                <Group w="100%" wrap="nowrap">
                                    <Slider
                                        defaultValue={lyricConfig.gap}
                                        label={(e) => `Synchronized: ${e}px`}
                                        max={50}
                                        min={0}
                                        onChangeEnd={(e) => handleLyricsSettings('gap', Number(e))}
                                        w="100%"
                                    />
                                    <Slider
                                        defaultValue={lyricConfig.gapUnsync}
                                        label={(e) => `Unsynchronized: ${e}px`}
                                        max={50}
                                        min={0}
                                        onChangeEnd={(e) =>
                                            handleLyricsSettings('gapUnsync', Number(e))
                                        }
                                        w="100%"
                                    />
                                </Group>
                            </Option.Control>
                        </Option>
                        <Option>
                            <Option.Label>
                                {t('page.fullscreenPlayer.config.lyricAlignment')}
                            </Option.Label>
                            <Option.Control>
                                <SegmentedControl
                                    data={[
                                        {
                                            label: t('common.left'),
                                            value: 'left',
                                        },
                                        {
                                            label: t('common.center'),
                                            value: 'center',
                                        },
                                        {
                                            label: t('common.right'),
                                            value: 'right',
                                        },
                                    ]}
                                    onChange={(e) => handleLyricsSettings('alignment', e)}
                                    value={lyricConfig.alignment}
                                />
                            </Option.Control>
                        </Option>
                        <Option>
                            <Option.Label>
                                {t('page.fullscreenPlayer.config.lyricOffset')}
                            </Option.Label>
                            <Option.Control>
                                <NumberInput
                                    defaultValue={lyricConfig.delayMs}
                                    hideControls={false}
                                    onBlur={(e) =>
                                        handleLyricsSettings(
                                            'delayMs',
                                            Number(e.currentTarget.value),
                                        )
                                    }
                                    step={10}
                                />
                            </Option.Control>
                        </Option>
                        <Divider my="sm" />
                    </Popover.Dropdown>
                </Popover>
                <ListConfigMenu
                    buttonProps={{
                        variant: isPageHovered ? 'default' : 'subtle',
                    }}
                    displayTypes={[
                        { hidden: true, value: ListDisplayType.GRID },
                        ...SONG_DISPLAY_TYPES,
                    ]}
                    listKey={ItemListKey.FULL_SCREEN}
                    optionsConfig={{
                        table: {
                            itemsPerPage: { hidden: true },
                            pagination: { hidden: true },
                        },
                    }}
                    tableColumnsData={SONG_TABLE_COLUMNS}
                />
                {/* Sleep timer + auto-DJ are otherwise desktop-only —
                    mobile users couldn't reach either from the
                    collapsed playerbar. Surface both in the fullscreen
                    player header where there's room. */}
                <SleepTimerButton />
                <AutoDJButton />
            </div>
        );
    },
);

MobileFullscreenPlayerHeader.displayName = 'MobileFullscreenPlayerHeader';
