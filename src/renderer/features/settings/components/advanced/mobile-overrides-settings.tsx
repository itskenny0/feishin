import { ChangeEvent } from 'react';

import { SettingOption, SettingsSection } from '/@/renderer/features/settings/components/settings-section';
import { useSettingsStore, useSettingsStoreActions } from '/@/renderer/store/settings.store';
import { Switch } from '/@/shared/components/switch/switch';

/**
 * Power-user toggles that bend the responsive layout out of shape on
 * purpose. Lives under Advanced — most users should never need these,
 * but the "force mobile shell" override is the only way to opt into
 * the Spotify-style touch UI on a wide display.
 */
export const MobileOverridesSettings = () => {
    const settings = useSettingsStore((state) => state.general);
    const { setSettings } = useSettingsStoreActions();

    const handleSetMobileShellForce = (e: ChangeEvent<HTMLInputElement>) => {
        setSettings({
            general: {
                mobileShellForce: e.target.checked,
            },
        });
    };

    const options: SettingOption[] = [
        {
            control: (
                <Switch
                    aria-label="Force mobile view"
                    checked={settings.mobileShellForce}
                    onChange={handleSetMobileShellForce}
                />
            ),
            description:
                'Render the touch-first Spotify-style UI regardless of viewport size. Useful on tablets in landscape or on small laptops where you want the mobile shell despite having a pointer. Refresh after toggling.',
            title: 'Force mobile view',
        },
    ];

    return <SettingsSection options={options} title="Mobile overrides" />;
};
