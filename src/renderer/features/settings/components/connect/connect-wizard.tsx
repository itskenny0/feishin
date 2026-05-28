/**
 * Sync & Connect setup wizard. Walks the user through enabling Jellyfin
 * Connect remote-play and the MQTT peer-sync transport with three broker
 * tiers (own hosted, embedded zeroconf, public).
 *
 * Lives in the new "Sync & Connect" settings category. Until the user
 * finishes the wizard, the peer-sync subsystem stays disabled and all
 * Connect-related UI chrome (device-picker buttons, status pill, lane
 * badges) is hidden from the rest of the app.
 */
import { Alert, Group, Radio, Stack, Stepper } from '@mantine/core';
import isElectron from 'is-electron';
import { nanoid } from 'nanoid';
import { memo, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { isPublicBrokerUrl } from '/@/renderer/features/settings/components/window/peer-sync-settings';
import { usePeerSyncSettings, useSettingsStoreActions } from '/@/renderer/store/settings.store';
import { Button } from '/@/shared/components/button/button';
import { TextInput } from '/@/shared/components/text-input/text-input';
import { Text } from '/@/shared/components/text/text';
import { toast } from '/@/shared/components/toast/toast';

const peerBrokerApi = isElectron() ? window.api.peerBroker : null;

type BrokerTier = 'embedded' | 'own' | 'public';

interface PublicBroker {
    description: string;
    label: string;
    notes: string;
    url: string;
}

const PUBLIC_BROKERS: PublicBroker[] = [
    {
        description: 'HiveMQ public test broker',
        label: 'HiveMQ (broker.hivemq.com)',
        notes: 'No authentication. Unencrypted. For testing only.',
        url: 'ws://broker.hivemq.com:8000/mqtt',
    },
    {
        description: 'Mosquitto.org public test broker',
        label: 'Mosquitto (test.mosquitto.org)',
        notes: 'WSS available; allow_anonymous true.',
        url: 'wss://test.mosquitto.org:8081',
    },
    {
        description: 'EMQX public test broker',
        label: 'EMQX (broker.emqx.io)',
        notes: 'WSS via port 8084. No authentication.',
        url: 'wss://broker.emqx.io:8084/mqtt',
    },
];

const StepIntro = ({ onNext }: { onNext: () => void }): React.JSX.Element => {
    const { t } = useTranslation();
    return (
        <Stack gap="md">
            <Text>
                {t('page.setting.wizardIntroBody', {
                    defaultValue:
                        "Feishin can remote-control another Jellyfin player and keep its state in sync with yours. There are two transports: Jellyfin's built-in /Sessions polling (works against jellyfin-web and other Jellyfin clients) and a low-latency MQTT lane between Feishin instances. This wizard sets both up.",
                })}
            </Text>
            <Text isMuted size="sm">
                {t('page.setting.wizardIntroNote', {
                    defaultValue:
                        'You can stop at any step — nothing is saved until you finish. You can also re-run this wizard later from Settings -> Sync & Connect -> Setup wizard.',
                })}
            </Text>
            <Group justify="flex-end">
                <Button onClick={onNext} variant="filled">
                    {t('common.next', { defaultValue: 'Next' })}
                </Button>
            </Group>
        </Stack>
    );
};

interface StepTierProps {
    onBack: () => void;
    onNext: () => void;
    onTier: (tier: BrokerTier) => void;
    tier: BrokerTier;
}

const StepTier = ({ onBack, onNext, onTier, tier }: StepTierProps): React.JSX.Element => {
    const { t } = useTranslation();
    return (
        <Stack gap="md">
            <Text>
                {t('page.setting.wizardTierIntro', {
                    defaultValue:
                        'Pick a broker. You can change this later from the Jellyfin Connect (MQTT) page.',
                })}
            </Text>
            <Radio.Group onChange={(v) => onTier(v as BrokerTier)} value={tier}>
                <Stack gap="sm">
                    <Radio
                        description={t('page.setting.wizardTierOwnDescription', {
                            defaultValue:
                                'Recommended. You point Feishin at a broker you host (mosquitto, HiveMQ, EMQX, etc.). Private + reliable. Username/password supported.',
                        })}
                        label={t('page.setting.wizardTierOwn', {
                            defaultValue: 'Your own MQTT broker',
                        })}
                        value="own"
                    />
                    <Radio
                        description={t('page.setting.wizardTierEmbeddedDescription', {
                            defaultValue:
                                'Each desktop Feishin runs a small MQTT broker on the LAN and announces itself via mDNS. Zero setup; peers on the same network auto-pair. Desktop-only on the broker side; web/mobile peers can still connect.',
                        })}
                        disabled={!isElectron()}
                        label={t('page.setting.wizardTierEmbedded', {
                            defaultValue: 'Zeroconf P2P (embedded broker)',
                        })}
                        value="embedded"
                    />
                    <Radio
                        description={t('page.setting.wizardTierPublicDescription', {
                            defaultValue:
                                "Use a public broker. Easiest to try, but the broker operator can see every command and state frame. Don't share sensitive playback data.",
                        })}
                        label={t('page.setting.wizardTierPublic', {
                            defaultValue: 'Public broker',
                        })}
                        value="public"
                    />
                </Stack>
            </Radio.Group>
            <Group justify="space-between">
                <Button onClick={onBack} variant="default">
                    {t('common.back', { defaultValue: 'Back' })}
                </Button>
                <Button onClick={onNext} variant="filled">
                    {t('common.next', { defaultValue: 'Next' })}
                </Button>
            </Group>
        </Stack>
    );
};

interface StepConfigureProps {
    brokerUrl: string;
    onBack: () => void;
    onBrokerUrl: (v: string) => void;
    onNext: () => void;
    onPassword: (v: string) => void;
    onUsername: (v: string) => void;
    password: string;
    tier: BrokerTier;
    username: string;
}

const StepConfigure = ({
    brokerUrl,
    onBack,
    onBrokerUrl,
    onNext,
    onPassword,
    onUsername,
    password,
    tier,
    username,
}: StepConfigureProps): React.JSX.Element => {
    const { t } = useTranslation();
    const canAdvance = tier === 'embedded' ? isElectron() : brokerUrl.trim().length > 0;
    const isPublic = tier === 'public' || isPublicBrokerUrl(brokerUrl);

    return (
        <Stack gap="md">
            {tier === 'own' && (
                <Text>
                    {t('page.setting.wizardConfigureOwn', {
                        defaultValue:
                            'Enter the WebSocket URL of your broker. If it requires authentication, fill in username and password.',
                    })}
                </Text>
            )}
            {tier === 'embedded' && (
                <Text>
                    {t('page.setting.wizardConfigureEmbedded', {
                        defaultValue:
                            'Feishin will start a small MQTT broker on this machine and announce it on the LAN via mDNS. Other Feishins on the same network will auto-discover it.',
                    })}
                </Text>
            )}
            {tier === 'public' && (
                <Stack gap="xs">
                    <Text>
                        {t('page.setting.wizardConfigurePublicIntro', {
                            defaultValue:
                                'Pick one of the public brokers below. Anyone with access can see your room key and playback state — treat the room key like a password and avoid this option for sensitive content.',
                        })}
                    </Text>
                    <Radio.Group onChange={(v) => onBrokerUrl(v)} value={brokerUrl}>
                        <Stack gap="xs">
                            {PUBLIC_BROKERS.map((b) => (
                                <Radio
                                    description={`${b.description} — ${b.notes}`}
                                    key={b.url}
                                    label={b.label}
                                    value={b.url}
                                />
                            ))}
                        </Stack>
                    </Radio.Group>
                </Stack>
            )}

            {(tier === 'own' || tier === 'public') && (
                <Stack gap="xs">
                    <Text fw={500} size="sm">
                        {t('page.setting.wizardBrokerUrl', { defaultValue: 'Broker URL' })}
                    </Text>
                    <TextInput
                        onChange={(e) => onBrokerUrl(e.currentTarget.value)}
                        placeholder="wss://broker.example.com:8083/mqtt"
                        value={brokerUrl}
                    />
                </Stack>
            )}

            {tier === 'own' && (
                <Group grow>
                    <Stack gap="xs">
                        <Text fw={500} size="sm">
                            {t('page.setting.wizardUsername', { defaultValue: 'Username' })}
                        </Text>
                        <TextInput
                            autoComplete="off"
                            onChange={(e) => onUsername(e.currentTarget.value)}
                            placeholder={t('page.setting.wizardUsernameOptional', {
                                defaultValue: 'Optional',
                            })}
                            value={username}
                        />
                    </Stack>
                    <Stack gap="xs">
                        <Text fw={500} size="sm">
                            {t('page.setting.wizardPassword', { defaultValue: 'Password' })}
                        </Text>
                        <TextInput
                            autoComplete="new-password"
                            onChange={(e) => onPassword(e.currentTarget.value)}
                            type="password"
                            value={password}
                        />
                    </Stack>
                </Group>
            )}

            {isPublic && brokerUrl && (
                <Alert color="yellow" variant="light">
                    {t('page.setting.wizardPublicWarning', {
                        defaultValue:
                            'This is a public broker. Anyone who knows the broker URL and your room key can see your playback state and commands.',
                    })}
                </Alert>
            )}

            <Group justify="space-between">
                <Button onClick={onBack} variant="default">
                    {t('common.back', { defaultValue: 'Back' })}
                </Button>
                <Button disabled={!canAdvance} onClick={onNext} variant="filled">
                    {t('common.next', { defaultValue: 'Next' })}
                </Button>
            </Group>
        </Stack>
    );
};

interface StepFinishProps {
    brokerUrl: string;
    onBack: () => void;
    onFinish: () => void;
    saving: boolean;
    tier: BrokerTier;
}

const StepFinish = ({
    brokerUrl,
    onBack,
    onFinish,
    saving,
    tier,
}: StepFinishProps): React.JSX.Element => {
    const { t } = useTranslation();
    const tierLabel =
        tier === 'own'
            ? t('page.setting.wizardTierOwn', { defaultValue: 'Your own MQTT broker' })
            : tier === 'embedded'
              ? t('page.setting.wizardTierEmbedded', {
                    defaultValue: 'Zeroconf P2P (embedded broker)',
                })
              : t('page.setting.wizardTierPublic', { defaultValue: 'Public broker' });
    return (
        <Stack gap="md">
            <Text>
                {t('page.setting.wizardFinishIntro', {
                    defaultValue:
                        'All set. Click Finish to enable peer sync and unhide the Connect UI in the rest of the app. You can still tweak everything later from Sync & Connect.',
                })}
            </Text>
            <Stack gap={4}>
                <Group justify="space-between">
                    <Text isMuted size="sm">
                        {t('page.setting.wizardFinishTier', { defaultValue: 'Broker tier' })}
                    </Text>
                    <Text size="sm">{tierLabel}</Text>
                </Group>
                {brokerUrl && (
                    <Group justify="space-between">
                        <Text isMuted size="sm">
                            {t('page.setting.wizardBrokerUrl', { defaultValue: 'Broker URL' })}
                        </Text>
                        <Text size="sm">{brokerUrl}</Text>
                    </Group>
                )}
            </Stack>
            <Group justify="space-between">
                <Button disabled={saving} onClick={onBack} variant="default">
                    {t('common.back', { defaultValue: 'Back' })}
                </Button>
                <Button loading={saving} onClick={onFinish} variant="filled">
                    {t('common.finish', { defaultValue: 'Finish' })}
                </Button>
            </Group>
        </Stack>
    );
};

export const ConnectWizard = memo(() => {
    const { t } = useTranslation();
    const settings = usePeerSyncSettings();
    const { setSettings } = useSettingsStoreActions();

    const [step, setStep] = useState(0);
    const [tier, setTier] = useState<BrokerTier>('own');
    const [brokerUrl, setBrokerUrl] = useState(settings.brokerUrl);
    const [username, setUsername] = useState(settings.brokerUsername);
    const [password, setPassword] = useState(settings.brokerPassword);
    const [saving, setSaving] = useState(false);

    // If the user already finished the wizard, default the tier to whatever
    // their current settings imply so re-running it doesn't reset the choice.
    useEffect(() => {
        if (settings.broker.enabled) setTier('embedded');
        else if (settings.brokerUrl && isPublicBrokerUrl(settings.brokerUrl)) setTier('public');
        else if (settings.brokerUrl) setTier('own');
    }, [settings.broker.enabled, settings.brokerUrl]);

    const goNext = useCallback(() => setStep((s) => s + 1), []);
    const goBack = useCallback(() => setStep((s) => Math.max(0, s - 1)), []);

    const handleFinish = useCallback(async () => {
        setSaving(true);
        try {
            // Make sure the identity is seeded so the client has something
            // to publish under. The peer-id stays stable for the install;
            // the room key is regenerated on first opt-in only when missing.
            const peerId = settings.peerId || nanoid();
            const roomKey = settings.roomKey || nanoid(24);

            if (tier === 'embedded' && peerBrokerApi) {
                const errorMsg = await peerBrokerApi.setEnabled({
                    host: settings.broker.host,
                    port: settings.broker.port,
                    roomKey,
                    tlsCertPath: settings.broker.tlsCertPath || undefined,
                    tlsKeyPath: settings.broker.tlsKeyPath || undefined,
                });
                if (errorMsg) {
                    toast.error({ message: errorMsg });
                    setSaving(false);
                    return;
                }
            }

            setSettings({
                peerSync: {
                    broker: {
                        ...settings.broker,
                        enabled: tier === 'embedded',
                    },
                    brokerPassword: tier === 'own' ? password : '',
                    brokerUrl: tier === 'embedded' ? '' : brokerUrl.trim(),
                    brokerUsername: tier === 'own' ? username : '',
                    enabled: true,
                    onboarded: true,
                    peerId,
                    roomKey,
                },
            });
            toast.info({
                message: t('page.setting.wizardFinished', {
                    defaultValue:
                        'Sync & Connect is set up. Look for the Connect button on the player bar.',
                }),
            });
            setStep(0);
        } finally {
            setSaving(false);
        }
    }, [
        brokerUrl,
        password,
        settings.broker,
        settings.peerId,
        settings.roomKey,
        setSettings,
        t,
        tier,
        username,
    ]);

    return (
        <Stack gap="lg">
            {settings.onboarded && (
                <Alert color="teal" variant="light">
                    {t('page.setting.wizardAlreadyOnboarded', {
                        defaultValue:
                            'Sync & Connect is already set up. Running the wizard again will overwrite the existing settings.',
                    })}
                </Alert>
            )}
            <Stepper active={step} onStepClick={setStep}>
                <Stepper.Step label={t('page.setting.wizardStepIntro', { defaultValue: 'About' })}>
                    <StepIntro onNext={goNext} />
                </Stepper.Step>
                <Stepper.Step
                    label={t('page.setting.wizardStepTier', { defaultValue: 'Broker tier' })}
                >
                    <StepTier onBack={goBack} onNext={goNext} onTier={setTier} tier={tier} />
                </Stepper.Step>
                <Stepper.Step
                    label={t('page.setting.wizardStepConfigure', { defaultValue: 'Configure' })}
                >
                    <StepConfigure
                        brokerUrl={brokerUrl}
                        onBack={goBack}
                        onBrokerUrl={setBrokerUrl}
                        onNext={goNext}
                        onPassword={setPassword}
                        onUsername={setUsername}
                        password={password}
                        tier={tier}
                        username={username}
                    />
                </Stepper.Step>
                <Stepper.Step
                    label={t('page.setting.wizardStepFinish', { defaultValue: 'Finish' })}
                >
                    <StepFinish
                        brokerUrl={brokerUrl}
                        onBack={goBack}
                        onFinish={handleFinish}
                        saving={saving}
                        tier={tier}
                    />
                </Stepper.Step>
            </Stepper>
        </Stack>
    );
});

ConnectWizard.displayName = 'ConnectWizard';
