import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import {
    SettingOption,
    SettingsSection,
} from '/@/renderer/features/settings/components/settings-section';
import {
    ScrobbleMinimumMode,
    usePlaybackSettings,
    useSettingsStore,
    useSettingsStoreActions,
} from '/@/renderer/store/settings.store';
import { NumberInput } from '/@/shared/components/number-input/number-input';
import { Select } from '/@/shared/components/select/select';
import { Slider } from '/@/shared/components/slider/slider';
import { Switch } from '/@/shared/components/switch/switch';
import { toast } from '/@/shared/components/toast/toast';

export const ScrobbleSettings = memo(() => {
    const { t } = useTranslation();
    const settings = usePlaybackSettings();
    const { setSettings } = useSettingsStoreActions();

    const scrobbleMinimumMode = useSettingsStore((state) => state.playback.scrobble.minimumMode);

    const scrobbleOptions: SettingOption[] = [
        {
            control: (
                <Switch
                    aria-label="Toggle scrobble"
                    defaultChecked={settings.scrobble.enabled}
                    onChange={(e) => {
                        setSettings({
                            playback: {
                                scrobble: {
                                    enabled: e.currentTarget.checked,
                                },
                            },
                        });
                    }}
                />
            ),
            description: t('setting.scrobble', {
                context: 'description',
            }),
            title: t('setting.scrobble'),
        },
        {
            control: (
                <Select
                    data={[
                        {
                            label: t('setting.scrobbleMinimumMode', {
                                context: 'optionBoth',
                            }),
                            value: ScrobbleMinimumMode.BOTH,
                        },
                        {
                            label: t('setting.scrobbleMinimumMode', {
                                context: 'optionSeconds',
                            }),
                            value: ScrobbleMinimumMode.SECONDS,
                        },
                        {
                            label: t('setting.scrobbleMinimumMode', {
                                context: 'optionPercentage',
                            }),
                            value: ScrobbleMinimumMode.PERCENTAGE,
                        },
                    ]}
                    defaultValue={settings.scrobble.minimumMode}
                    onChange={(e) =>
                        setSettings({
                            playback: {
                                scrobble: {
                                    minimumMode: e as ScrobbleMinimumMode,
                                },
                            },
                        })
                    }
                />
            ),
            description: t('setting.scrobbleMinimumMode', {
                context: 'description',
            }),
            title: t('setting.scrobbleMinimumMode'),
        },
        {
            control: (
                <Slider
                    aria-label="Scrobble percentage"
                    defaultValue={settings.scrobble.scrobbleAtPercentage}
                    label={`${settings.scrobble.scrobbleAtPercentage}%`}
                    max={90}
                    min={25}
                    onChange={(e) => {
                        setSettings({
                            playback: {
                                scrobble: {
                                    scrobbleAtPercentage: e,
                                },
                            },
                        });
                    }}
                    w={100}
                />
            ),
            description: t('setting.minimumScrobblePercentage', {
                context: 'description',
            }),
            isHidden: scrobbleMinimumMode === ScrobbleMinimumMode.SECONDS,
            title: `${t('setting.minimumScrobblePercentage')}: ${settings.scrobble.scrobbleAtPercentage}%`,
        },
        {
            control: (
                <NumberInput
                    aria-label="Scrobble duration in seconds"
                    defaultValue={settings.scrobble.scrobbleAtDuration}
                    max={1200}
                    min={0}
                    onChange={(e) => {
                        if (e === '') return;
                        setSettings({
                            playback: {
                                scrobble: {
                                    scrobbleAtDuration: Number(e),
                                },
                            },
                        });
                    }}
                    width={75}
                />
            ),
            description: t('setting.minimumScrobbleSeconds', {
                context: 'description',
            }),
            isHidden: scrobbleMinimumMode === ScrobbleMinimumMode.PERCENTAGE,
            title: t('setting.minimumScrobbleSeconds'),
        },
        {
            control: (
                <Switch
                    aria-label="Toggle notify"
                    checked={settings.scrobble.notify}
                    onChange={async (e) => {
                        // Read before awaiting: React nulls currentTarget once
                        // the handler yields.
                        const notify = e.currentTarget.checked;

                        // Permission only gates turning notifications on.
                        if (notify && Notification.permission !== 'granted') {
                            const permission =
                                Notification.permission === 'denied'
                                    ? 'denied'
                                    : await Notification.requestPermission();
                            if (permission !== 'granted') {
                                toast.error({
                                    message: t('error.notificationDenied'),
                                });
                                return;
                            }
                        }

                        setSettings({ playback: { scrobble: { notify } } });
                    }}
                />
            ),
            description: t('setting.notify', {
                context: 'description',
            }),
            isHidden: !('Notification' in window),
            title: t('setting.notify'),
        },
    ];

    return <SettingsSection options={scrobbleOptions} title={t('page.setting.scrobble')} />;
});
