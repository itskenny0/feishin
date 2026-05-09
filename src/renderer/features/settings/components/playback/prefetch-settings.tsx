import { ChangeEvent, memo } from 'react';
import { useTranslation } from 'react-i18next';

import {
    SettingOption,
    SettingsSection,
} from '/@/renderer/features/settings/components/settings-section';
import { useGeneralSettings, useSettingsStoreActions } from '/@/renderer/store/settings.store';
import { NumberInput } from '/@/shared/components/number-input/number-input';
import { Switch } from '/@/shared/components/switch/switch';

export const PrefetchSettings = memo(() => {
    const { t } = useTranslation();
    const settings = useGeneralSettings();
    const { setSettings } = useSettingsStoreActions();

    const handleSetPrefetchSidebarAlbums = (e: ChangeEvent<HTMLInputElement>) => {
        setSettings({ general: { prefetchSidebarAlbums: e.currentTarget.checked } });
    };

    const handleSetPrefetchUpcomingLyrics = (e: ChangeEvent<HTMLInputElement>) => {
        setSettings({ general: { prefetchUpcomingLyrics: e.currentTarget.checked } });
    };

    const handleSetPrefetchUpcomingLyricsCount = (value: number | string) => {
        const next = typeof value === 'number' ? value : Number(value) || 0;
        setSettings({ general: { prefetchUpcomingLyricsCount: next } });
    };

    const options: SettingOption[] = [
        {
            control: (
                <Switch
                    checked={settings.prefetchSidebarAlbums}
                    onChange={handleSetPrefetchSidebarAlbums}
                />
            ),
            description: t('setting.prefetchSidebarAlbums', {
                context: 'description',
                postProcess: 'sentenceCase',
            }),
            title: t('setting.prefetchSidebarAlbums', { postProcess: 'sentenceCase' }),
        },
        {
            control: (
                <Switch
                    checked={settings.prefetchUpcomingLyrics}
                    onChange={handleSetPrefetchUpcomingLyrics}
                />
            ),
            description: t('setting.prefetchUpcomingLyrics', {
                context: 'description',
                postProcess: 'sentenceCase',
            }),
            title: t('setting.prefetchUpcomingLyrics', { postProcess: 'sentenceCase' }),
        },
        {
            control: (
                <NumberInput
                    aria-label="Prefetch upcoming lyrics count"
                    disabled={!settings.prefetchUpcomingLyrics}
                    hideControls={false}
                    max={50}
                    min={0}
                    onChange={handleSetPrefetchUpcomingLyricsCount}
                    value={settings.prefetchUpcomingLyricsCount}
                />
            ),
            description: t('setting.prefetchUpcomingLyricsCount', {
                context: 'description',
                postProcess: 'sentenceCase',
            }),
            title: t('setting.prefetchUpcomingLyricsCount', { postProcess: 'sentenceCase' }),
        },
    ];

    return (
        <SettingsSection
            options={options}
            title={t('setting.prefetch', { postProcess: 'titleCase' })}
        />
    );
});
