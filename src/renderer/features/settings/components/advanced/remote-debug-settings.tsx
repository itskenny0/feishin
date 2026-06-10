// Remote debug — ship renderer logs to a developer machine.
//
// Built to diagnose crashes that take the whole WebView down (Android
// crash-to-launcher): local logs die with the process, so the only surviving
// evidence is what was streamed off the device beforehand. The matching
// receiver is a tiny HTTP server (see the in-app description); everything
// ships as plain-HTTP NDJSON.

import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { normalizeEndpoint } from '/@/renderer/debug/remote-log-shipper';
import {
    SettingOption,
    SettingsSection,
} from '/@/renderer/features/settings/components/settings-section';
import { useRemoteDebugSettings, useSettingsStoreActions } from '/@/renderer/store/settings.store';
import { Button } from '/@/shared/components/button/button';
import { Switch } from '/@/shared/components/switch/switch';
import { TextInput } from '/@/shared/components/text-input/text-input';
import { toast } from '/@/shared/components/toast/toast';

export const RemoteDebugSettings = memo(() => {
    const { t } = useTranslation();
    const remoteDebug = useRemoteDebugSettings();
    const { setSettings } = useSettingsStoreActions();
    const [testing, setTesting] = useState(false);

    const handleTest = async () => {
        const url = normalizeEndpoint(remoteDebug.endpoint);
        if (!url) {
            toast.error({
                message: t('setting.remoteDebugEndpointInvalid', {
                    defaultValue: 'Enter a receiver address first (host or host:port).',
                }),
            });
            return;
        }
        setTesting(true);
        try {
            const healthUrl = url.replace(/\/log$/, '/health');
            const res = await fetch(healthUrl, { method: 'GET' });
            if (res.ok) {
                toast.success({
                    message: t('setting.remoteDebugTestOk', {
                        defaultValue: 'Receiver reachable.',
                    }),
                });
            } else {
                toast.error({
                    message: t('setting.remoteDebugTestHttp', {
                        defaultValue: `Receiver answered HTTP ${res.status}.`,
                        status: res.status,
                    }),
                });
            }
        } catch {
            toast.error({
                message: t('setting.remoteDebugTestFail', {
                    defaultValue: 'Receiver not reachable from this device.',
                }),
            });
        } finally {
            setTesting(false);
        }
    };

    const options: SettingOption[] = [
        {
            control: (
                <Switch
                    aria-label={t('setting.remoteDebugEnabled', {
                        defaultValue: 'Ship logs to a remote receiver',
                    })}
                    checked={remoteDebug.enabled}
                    onChange={(e) =>
                        setSettings({
                            remoteDebug: { ...remoteDebug, enabled: e.currentTarget.checked },
                        })
                    }
                />
            ),
            description: t('setting.remoteDebugEnabledDescription', {
                defaultValue:
                    'Streams console output, errors and a heartbeat to the receiver below. For diagnosing crashes that kill the app — leave off otherwise.',
            }),
            title: t('setting.remoteDebugEnabled', {
                defaultValue: 'Ship logs to a remote receiver',
            }),
        },
        {
            control: (
                <TextInput
                    aria-label={t('setting.remoteDebugEndpoint', {
                        defaultValue: 'Receiver address',
                    })}
                    onChange={(e) =>
                        setSettings({
                            remoteDebug: { ...remoteDebug, endpoint: e.currentTarget.value },
                        })
                    }
                    placeholder="192.168.1.10:19191"
                    spellCheck={false}
                    value={remoteDebug.endpoint}
                    width={260}
                />
            ),
            description: t('setting.remoteDebugEndpointDescription', {
                defaultValue:
                    'IP or hostname of the machine running the log receiver (default port 19191). Plain HTTP on your local network.',
            }),
            title: t('setting.remoteDebugEndpoint', { defaultValue: 'Receiver address' }),
        },
        {
            control: (
                <Button loading={testing} onClick={() => void handleTest()} variant="default">
                    {t('setting.remoteDebugTest', { defaultValue: 'Test connection' })}
                </Button>
            ),
            description: t('setting.remoteDebugTestDescription', {
                defaultValue: 'Checks that the receiver answers from this device.',
            }),
            title: t('setting.remoteDebugTest', { defaultValue: 'Test connection' }),
        },
    ];

    return (
        <SettingsSection
            options={options}
            title={t('setting.remoteDebug', { defaultValue: 'Remote debug' })}
        />
    );
});

RemoteDebugSettings.displayName = 'RemoteDebugSettings';
