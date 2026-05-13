import { ChangeEvent, memo, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { SidebarReorder } from '/@/renderer/features/settings/components/general/sidebar-reorder';
import {
    SettingOption,
    SettingsSection,
} from '/@/renderer/features/settings/components/settings-section';
import { useGeneralSettings, useSettingsStoreActions } from '/@/renderer/store';
import { Select } from '/@/shared/components/select/select';
import { Switch } from '/@/shared/components/switch/switch';
import { TextInput } from '/@/shared/components/text-input/text-input';
import { useDebouncedCallback } from '/@/shared/hooks/use-debounced-callback';

export const SidebarSettings = memo(() => {
    const { t } = useTranslation();
    const settings = useGeneralSettings();
    const { setSettings } = useSettingsStoreActions();

    const handleSetSidebarBottomSection = (value: null | string) => {
        if (value !== 'playlists' && value !== 'favoriteAlbums' && value !== 'none') {
            return;
        }
        setSettings({
            general: {
                sidebarBottomSection: value,
                // Keep the legacy boolean in sync so older code paths and the
                // mobile sidebar that still read it stay consistent.
                sidebarPlaylistList: value === 'playlists',
            },
        });
    };

    const handleSetSidebarPlaylistSorting = (e: ChangeEvent<HTMLInputElement>) => {
        setSettings({
            general: {
                sidebarPlaylistSorting: e.target.checked,
            },
        });
    };

    const handleSetSidebarCollapsedNavigation = (e: ChangeEvent<HTMLInputElement>) => {
        setSettings({
            general: {
                sidebarCollapsedNavigation: e.target.checked,
            },
        });
    };

    const [localFilterRegex, setLocalFilterRegex] = useState(
        settings.sidebarPlaylistListFilterRegex,
    );

    useEffect(() => {
        setLocalFilterRegex(settings.sidebarPlaylistListFilterRegex);
    }, [settings.sidebarPlaylistListFilterRegex]);

    const debouncedSetFilterRegex = useDebouncedCallback((value: string) => {
        setSettings({
            general: {
                sidebarPlaylistListFilterRegex: value,
            },
        });
    }, 500);

    const options: SettingOption[] = [
        {
            control: (
                <Select
                    data={[
                        {
                            label: t('setting.sidebarBottomSection_playlists'),
                            value: 'playlists',
                        },
                        {
                            label: t('setting.sidebarBottomSection_favoriteAlbums'),
                            value: 'favoriteAlbums',
                        },
                        {
                            label: t('setting.sidebarBottomSection_none'),
                            value: 'none',
                        },
                    ]}
                    onChange={handleSetSidebarBottomSection}
                    value={settings.sidebarBottomSection}
                />
            ),
            description: t('setting.sidebarBottomSection', {
                context: 'description',
            }),
            title: t('setting.sidebarBottomSection'),
        },
        {
            control: (
                <TextInput
                    onChange={(e) => {
                        const value = e.currentTarget.value;
                        setLocalFilterRegex(value);
                        debouncedSetFilterRegex(value);
                    }}
                    placeholder={t('setting.sidebarPlaylistListFilterRegex_placeholder')}
                    value={localFilterRegex}
                />
            ),
            description: t('setting.sidebarPlaylistListFilterRegex', {
                context: 'description',
            }),
            title: t('setting.sidebarPlaylistListFilterRegex'),
        },
        {
            control: (
                <Switch
                    checked={settings.sidebarPlaylistSorting}
                    onChange={handleSetSidebarPlaylistSorting}
                />
            ),
            description: t('setting.sidebarPlaylistSorting', {
                context: 'description',
            }),
            title: t('setting.sidebarPlaylistSorting'),
        },
        {
            control: (
                <Switch
                    checked={settings.sidebarCollapsedNavigation}
                    onChange={handleSetSidebarCollapsedNavigation}
                />
            ),
            description: t('setting.sidebarCollapsedNavigation', {
                context: 'description',
            }),
            title: t('setting.sidebarCollapsedNavigation'),
        },
        {
            control: (
                <Switch
                    aria-label="Show lyrics in attached play queue"
                    defaultChecked={settings.showLyricsInSidebar}
                    onChange={(e) => {
                        setSettings({
                            general: {
                                showLyricsInSidebar: e.currentTarget.checked,
                            },
                        });
                    }}
                />
            ),
            description: t('setting.showLyricsInSidebar', {
                context: 'description',
            }),
            title: t('setting.showLyricsInSidebar'),
        },
        {
            control: (
                <Switch
                    aria-label="Show visualizer in sidebar"
                    defaultChecked={settings.showVisualizerInSidebar}
                    onChange={(e) => {
                        setSettings({
                            general: {
                                showVisualizerInSidebar: e.currentTarget.checked,
                            },
                        });
                    }}
                />
            ),
            description: t('setting.showVisualizerInSidebar', {
                context: 'description',
            }),
            title: t('setting.showVisualizerInSidebar'),
        },
        {
            control: (
                <Switch
                    aria-label="Combine lyrics and visualizer"
                    defaultChecked={settings.combinedLyricsAndVisualizer}
                    onChange={(e) => {
                        setSettings({
                            general: {
                                combinedLyricsAndVisualizer: e.currentTarget.checked,
                            },
                        });
                    }}
                />
            ),
            description: t('setting.combinedLyricsAndVisualizer', {
                context: 'description',
            }),
            title: t('setting.combinedLyricsAndVisualizer'),
        },
    ];

    return (
        <SettingsSection
            extra={<SidebarReorder />}
            options={options}
            title={t('page.setting.sidebar')}
        />
    );
});
