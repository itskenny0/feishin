// Home Assistant bridge settings block. Rendered inside the peer-sync settings
// subpage whenever a broker is configured. Lets the user enable the HA MQTT
// bridge (default off), name the HA device, and copy a Tier-2
// media_player.template snippet for a native media-player card.

import { Stack, Switch } from '@mantine/core';
import { useTranslation } from 'react-i18next';

import { haTemplateSnippet } from '/@/renderer/features/home-assistant/template-snippet';
import { SettingsSection } from '/@/renderer/features/settings/components/settings-section';
import { usePeerSyncSettings, useSettingsStoreActions } from '/@/renderer/store';
import { Button } from '/@/shared/components/button/button';
import { TextInput } from '/@/shared/components/text-input/text-input';
import { toast } from '/@/shared/components/toast/toast';

export const HomeAssistantSettings = () => {
    const { t } = useTranslation();
    const settings = usePeerSyncSettings();
    const { setSettings } = useSettingsStoreActions();
    const ha = settings.homeAssistant;

    const handleCopySnippet = async (): Promise<void> => {
        try {
            await navigator.clipboard.writeText(haTemplateSnippet(ha?.deviceName ?? ''));
            toast.success({
                message: t('setting.homeAssistantSnippetCopied', {
                    defaultValue: 'Home Assistant template config copied to clipboard',
                }),
            });
        } catch {
            toast.error({
                message: t('setting.homeAssistantSnippetCopyFailed', {
                    defaultValue: 'Could not copy to clipboard',
                }),
            });
        }
    };

    // Only meaningful once a broker is configured (the bridge rides it).
    if (!settings.brokerUrl?.trim()) return null;

    return (
        <Stack gap="md">
            <SettingsSection
                options={[
                    {
                        control: (
                            <Switch
                                aria-label={t('setting.homeAssistant', {
                                    defaultValue: 'Expose to Home Assistant',
                                })}
                                checked={ha?.enabled === true}
                                onChange={(e) =>
                                    setSettings({
                                        peerSync: {
                                            homeAssistant: { enabled: e.currentTarget.checked },
                                        },
                                    })
                                }
                            />
                        ),
                        description: t('setting.homeAssistant', {
                            context: 'description',
                            defaultValue:
                                'Publish this player to Home Assistant over the same MQTT broker, using autodiscovery. A controllable device (play/pause, next/previous, volume, now-playing, artwork) appears automatically — no Home Assistant configuration required.',
                        }),
                        title: t('setting.homeAssistant', {
                            defaultValue: 'Expose to Home Assistant',
                        }),
                    },
                    {
                        control: (
                            <TextInput
                                aria-label={t('setting.homeAssistantDeviceName', {
                                    defaultValue: 'Device name',
                                })}
                                disabled={ha?.enabled !== true}
                                onChange={(e) =>
                                    setSettings({
                                        peerSync: {
                                            homeAssistant: { deviceName: e.currentTarget.value },
                                        },
                                    })
                                }
                                placeholder="Feishin"
                                value={ha?.deviceName ?? ''}
                            />
                        ),
                        description: t('setting.homeAssistantDeviceName', {
                            context: 'description',
                            defaultValue:
                                'Name shown for this player in Home Assistant. Defaults to "Feishin".',
                        }),
                        title: t('setting.homeAssistantDeviceName', {
                            defaultValue: 'Device name',
                        }),
                    },
                    {
                        control: (
                            <Button onClick={handleCopySnippet} variant="default">
                                {t('setting.homeAssistantCopySnippet', {
                                    defaultValue: 'Copy card config',
                                })}
                            </Button>
                        ),
                        description: t('setting.homeAssistantCopySnippet', {
                            context: 'description',
                            defaultValue:
                                'Optional: copy a media_player.template config (requires the HACS "media_player.template" component) to get a single native media-player card composed from the discovered entities.',
                        }),
                        title: t('setting.homeAssistantCopySnippet', {
                            defaultValue: 'Native media-player card (optional)',
                        }),
                    },
                ]}
            />
        </Stack>
    );
};
