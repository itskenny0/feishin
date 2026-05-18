import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import {
    SettingOption,
    SettingsSection,
} from '/@/renderer/features/settings/components/settings-section';
import { useGeneralSettings, useSettingsStoreActions } from '/@/renderer/store';
import { Select } from '/@/shared/components/select/select';
import { Slider } from '/@/shared/components/slider/slider';
import { Switch } from '/@/shared/components/switch/switch';

export const TrackmapSettings = memo(() => {
    const { t } = useTranslation();
    const settings = useGeneralSettings();
    const { setSettings } = useSettingsStoreActions();

    const options: SettingOption[] = [
        {
            control: (
                <Switch
                    aria-label={t('setting.trackmap')}
                    defaultChecked={settings.trackmapEnabled}
                    onChange={(e) =>
                        setSettings({ general: { trackmapEnabled: e.currentTarget.checked } })
                    }
                />
            ),
            description: t('setting.trackmap', { context: 'description' }),
            title: t('setting.trackmap'),
        },
        {
            control: (
                <Switch
                    aria-label={t('setting.trackmapOnlyOverLan')}
                    defaultChecked={settings.trackmapOnlyOverLan}
                    onChange={(e) =>
                        setSettings({
                            general: { trackmapOnlyOverLan: e.currentTarget.checked },
                        })
                    }
                />
            ),
            description: t('setting.trackmapOnlyOverLan', { context: 'description' }),
            indent: true,
            isHidden: !settings.trackmapEnabled,
            title: t('setting.trackmapOnlyOverLan'),
        },
        {
            control: (
                <Select
                    data={[{ label: t('setting.trackmapStyle_optionGlow'), value: 'glow' }]}
                    disabled
                    onChange={(value) => {
                        if (value) setSettings({ general: { trackmapStyle: value as 'glow' } });
                    }}
                    value={settings.trackmapStyle}
                />
            ),
            description: t('setting.trackmapStyle', { context: 'description' }),
            indent: true,
            isHidden: !settings.trackmapEnabled,
            title: t('setting.trackmapStyle'),
        },
        {
            control: (
                <Slider
                    aria-label={t('setting.trackmapHeight')}
                    max={100}
                    min={0}
                    onChangeEnd={(value) => setSettings({ general: { trackmapHeight: value } })}
                    step={1}
                    value={settings.trackmapHeight}
                />
            ),
            description: t('setting.trackmapHeight', { context: 'description' }),
            indent: true,
            isHidden: !settings.trackmapEnabled,
            title: t('setting.trackmapHeight'),
        },
        {
            control: (
                <Slider
                    aria-label={t('setting.trackmapGlow')}
                    max={100}
                    min={0}
                    onChangeEnd={(value) => setSettings({ general: { trackmapGlow: value } })}
                    step={1}
                    value={settings.trackmapGlow}
                />
            ),
            description: t('setting.trackmapGlow', { context: 'description' }),
            indent: true,
            isHidden: !settings.trackmapEnabled,
            title: t('setting.trackmapGlow'),
        },
        {
            control: (
                <Slider
                    aria-label={t('setting.trackmapSensitivity')}
                    max={100}
                    min={0}
                    onChangeEnd={(value) =>
                        setSettings({ general: { trackmapSensitivity: value } })
                    }
                    step={1}
                    value={settings.trackmapSensitivity}
                />
            ),
            description: t('setting.trackmapSensitivity', { context: 'description' }),
            indent: true,
            isHidden: !settings.trackmapEnabled,
            note: t('setting.trackmapSensitivity_note'),
            title: t('setting.trackmapSensitivity'),
        },
    ];

    return <SettingsSection options={options} title={t('page.setting.trackmap')} />;
});

TrackmapSettings.displayName = 'TrackmapSettings';
