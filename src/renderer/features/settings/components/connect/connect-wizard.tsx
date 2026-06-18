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
import { Alert, Checkbox, Group, Radio, ScrollArea, Stack, Stepper } from '@mantine/core';
import isElectron from 'is-electron';
import { nanoid } from 'nanoid';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { testBrokerConnection } from '/@/renderer/features/peer-sync/controller/peer-client';
import { isPublicBrokerUrl } from '/@/renderer/features/settings/components/window/peer-sync-settings';
import { useIsMobileShell } from '/@/renderer/hooks/use-breakpoint';
import { useCurrentServer } from '/@/renderer/store/auth.store';
import { usePeerSyncSettings, useSettingsStoreActions } from '/@/renderer/store/settings.store';
import { Button } from '/@/shared/components/button/button';
import { PasswordInput } from '/@/shared/components/password-input/password-input';
import { Select } from '/@/shared/components/select/select';
import { TextInput } from '/@/shared/components/text-input/text-input';
import { Text } from '/@/shared/components/text/text';
import { toast } from '/@/shared/components/toast/toast';

const peerBrokerApi = isElectron() ? window.api.peerBroker : null;

type BrokerTier = 'embedded' | 'own' | 'public';
type PeerSyncTransport = 'auto' | 'tcp' | 'ws';

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
    onTest: () => void;
    onTransport: (v: PeerSyncTransport) => void;
    onUsername: (v: string) => void;
    password: string;
    testError: string;
    testState: TestState;
    tier: BrokerTier;
    transport: PeerSyncTransport;
    username: string;
}

/** Test-connection lifecycle for the wizard's broker-reachability gate. */
type TestState = 'error' | 'idle' | 'ok' | 'testing';

const StepConfigure = ({
    brokerUrl,
    onBack,
    onBrokerUrl,
    onNext,
    onPassword,
    onTest,
    onTransport,
    onUsername,
    password,
    testError,
    testState,
    tier,
    transport,
    username,
}: StepConfigureProps): React.JSX.Element => {
    const { t } = useTranslation();
    // Tiers that carry a broker URL (own/public) must pass a live connection
    // test before the user can advance. The embedded tier has no URL — its
    // broker is validated at Finish via peerBrokerApi.setEnabled — so it keeps
    // the simpler "is this Electron" gate.
    const hasBrokerUrl = tier !== 'embedded';
    const hasBrokerInput = brokerUrl.trim().length > 0;
    const canAdvance = tier === 'embedded' ? isElectron() : hasBrokerInput && testState === 'ok';
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
                <Stack gap="xs">
                    <Text fw={500} size="sm">
                        {t('page.setting.wizardTransport', { defaultValue: 'Connection' })}
                    </Text>
                    <Select
                        clearable={false}
                        data={[
                            {
                                label: t('page.setting.wizardTransport', {
                                    context: 'auto',
                                    defaultValue: 'Automatic',
                                }),
                                value: 'auto',
                            },
                            {
                                label: t('page.setting.wizardTransport', {
                                    context: 'ws',
                                    defaultValue: 'WebSocket',
                                }),
                                value: 'ws',
                            },
                            {
                                label: t('page.setting.wizardTransport', {
                                    context: 'tcp',
                                    defaultValue: 'TCP (raw socket)',
                                }),
                                value: 'tcp',
                            },
                        ]}
                        onChange={(v) => {
                            if (v === 'auto' || v === 'ws' || v === 'tcp') onTransport(v);
                        }}
                        value={transport}
                    />
                    <Text isMuted size="sm">
                        {t('page.setting.wizardTransport', {
                            context: 'description',
                            defaultValue:
                                'Automatic uses WebSocket, and on Android or the desktop app upgrades to raw TCP for mqtt:// / mqtts:// broker URLs. Choose TCP if your broker only exposes raw MQTT on port 1883/8883 with no WebSocket listener. Raw TCP is unavailable in the browser/PWA build, which always uses WebSocket.',
                        })}
                    </Text>
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
                        <PasswordInput
                            autoComplete="new-password"
                            onChange={(e) => onPassword(e.currentTarget.value)}
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

            {hasBrokerUrl && (
                <Stack gap="xs">
                    <Group gap="sm">
                        <Button
                            disabled={!hasBrokerInput || testState === 'testing'}
                            loading={testState === 'testing'}
                            onClick={onTest}
                            variant="default"
                        >
                            {t('page.setting.wizardTestConnection', {
                                defaultValue: 'Test connection',
                            })}
                        </Button>
                        {testState === 'ok' && (
                            <Text c="teal" size="sm">
                                {t('page.setting.wizardTestOk', {
                                    defaultValue: 'Connected successfully.',
                                })}
                            </Text>
                        )}
                        {testState === 'error' && (
                            <Text c="red" size="sm">
                                {testError ||
                                    t('page.setting.wizardTestFailed', {
                                        defaultValue: 'Could not reach the broker.',
                                    })}
                            </Text>
                        )}
                    </Group>
                    {testState !== 'ok' && (
                        <Text isMuted size="sm">
                            {t('page.setting.wizardTestHint', {
                                defaultValue:
                                    'Run a connection test before continuing. Next stays disabled until the test succeeds.',
                            })}
                        </Text>
                    )}
                </Stack>
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
    finished: boolean;
    homeAssistant: boolean;
    onBack: () => void;
    onFinish: () => void;
    onHomeAssistantChange: (value: boolean) => void;
    onRerun: () => void;
    saving: boolean;
    tier: BrokerTier;
}

const StepFinish = ({
    brokerUrl,
    finished,
    homeAssistant,
    onBack,
    onFinish,
    onHomeAssistantChange,
    onRerun,
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
            {finished ? (
                <Alert color="teal" variant="light">
                    {t('page.setting.wizardFinishedAlert', {
                        defaultValue:
                            'Sync is on. You can close this page or re-run the wizard to change brokers.',
                    })}
                </Alert>
            ) : (
                <Text>
                    {t('page.setting.wizardFinishIntro', {
                        defaultValue:
                            'All set. Click Finish to enable peer sync and unhide the Connect UI in the rest of the app. You can still tweak everything later from Sync & Connect.',
                    })}
                </Text>
            )}
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
            {!finished && (
                <Checkbox
                    checked={homeAssistant}
                    description={t('page.setting.wizardHomeAssistant', {
                        context: 'description',
                        defaultValue:
                            'Publish this player to Home Assistant over the same broker, using autodiscovery. A controllable device appears automatically — no Home Assistant configuration required. You can change this later in Sync & Connect.',
                    })}
                    label={t('page.setting.wizardHomeAssistant', {
                        defaultValue: 'Also expose this player to Home Assistant',
                    })}
                    onChange={(e) => onHomeAssistantChange(e.currentTarget.checked)}
                />
            )}
            <Group justify="space-between">
                <Button disabled={saving || finished} onClick={onBack} variant="default">
                    {t('common.back', { defaultValue: 'Back' })}
                </Button>
                {finished ? (
                    <Button onClick={onRerun} variant="filled">
                        {t('page.setting.wizardRerun', { defaultValue: 'Re-run wizard' })}
                    </Button>
                ) : (
                    <Button disabled={saving} loading={saving} onClick={onFinish} variant="filled">
                        {t('common.finish', { defaultValue: 'Finish' })}
                    </Button>
                )}
            </Group>
        </Stack>
    );
};

export const ConnectWizard = memo(() => {
    const { t } = useTranslation();
    const isMobile = useIsMobileShell();
    const settings = usePeerSyncSettings();
    const currentServer = useCurrentServer();
    const { setSettings } = useSettingsStoreActions();

    const [step, setStep] = useState(0);
    // Latches once the user clicks Finish and the save resolves so the
    // Finish step renders a success Alert + Re-run button instead of
    // teleporting back to step 0 (which read as "the click broke").
    const [finished, setFinished] = useState(false);
    // Seed the tier from existing settings ONCE on mount. A subsequent
    // setSettings (e.g. the user typing in the broker URL field — which
    // round-trips through the store) must not clobber the tier the user
    // is actively configuring inside the wizard.
    const [tier, setTier] = useState<BrokerTier>(() => {
        if (settings.broker.enabled) return 'embedded';
        if (settings.brokerUrl && isPublicBrokerUrl(settings.brokerUrl)) return 'public';
        return 'own';
    });
    const [brokerUrl, setBrokerUrl] = useState(settings.brokerUrl);
    const [username, setUsername] = useState(settings.brokerUsername);
    const [password, setPassword] = useState(settings.brokerPassword);
    const [transport, setTransport] = useState<PeerSyncTransport>(
        (settings.transport as PeerSyncTransport) ?? 'auto',
    );
    // Connection-test gate for the own/public tiers. `Next` on the Configure
    // step is blocked until a test against the CURRENT broker config succeeds.
    const [testState, setTestState] = useState<TestState>('idle');
    const [testError, setTestError] = useState('');
    // Token guards against a stale in-flight test resolving after the user has
    // changed the broker config (which resets the gate back to idle).
    const testTokenRef = useRef(0);
    const [saving, setSaving] = useState(false);
    // Home Assistant opt-in (default off). Seeded from the persisted value so a
    // re-run of the wizard reflects the current setting.
    const [homeAssistant, setHomeAssistant] = useState(settings.homeAssistant?.enabled === true);
    // Guard against a double-tap on Finish racing two concurrent save flows
    // (Mantine's `loading` prop doesn't disable the underlying button, so
    // a fast pointer + slow IPC round-trip could fire `setEnabled` twice).
    const finishingRef = useRef(false);

    // Track the highest step the user has reached so we can let them
    // click *back* to any visited step but not skip forward past
    // validation (e.g. clicking "Finish" before filling broker fields).
    const [maxStepReached, setMaxStepReached] = useState(0);

    const goNext = useCallback(
        () =>
            setStep((s) => {
                const next = s + 1;
                setMaxStepReached((m) => Math.max(m, next));
                return next;
            }),
        [],
    );
    const goBack = useCallback(() => setStep((s) => Math.max(0, s - 1)), []);
    const handleStepClick = useCallback(
        (index: number) => {
            if (finished) return;
            if (index <= maxStepReached) setStep(index);
        },
        [finished, maxStepReached],
    );
    const handleRerun = useCallback(() => {
        setFinished(false);
        setStep(0);
        setMaxStepReached(0);
    }, []);

    // Any change to the broker config invalidates a prior successful test —
    // reset the gate to idle so the user must re-test the new configuration
    // before Next re-enables. The tier itself is also a dependency: switching
    // own ⇄ public ⇄ embedded changes which credentials/URL are in play.
    useEffect(() => {
        testTokenRef.current += 1;
        setTestState('idle');
        setTestError('');
    }, [brokerUrl, username, password, transport, tier]);

    const handleTest = useCallback(async () => {
        const url = brokerUrl.trim();
        if (!url) return;
        const token = ++testTokenRef.current;
        setTestState('testing');
        setTestError('');
        // own-tier credentials only — public brokers are anonymous, and the
        // embedded tier never reaches this handler (no broker URL). S2-B: also
        // pass the embedded-scheme userId/roomKey so a broker that enforces the
        // userId+roomKey CONNECT (an own-broker pointed at the embedded scheme)
        // is probed with the SAME credentials the live client will send —
        // otherwise the gate probes anonymously and mis-predicts live connect.
        const result = await testBrokerConnection(url, {
            password: tier === 'own' ? password : undefined,
            roomKey: currentServer?.username ?? undefined,
            transport,
            userId: currentServer?.userId ?? undefined,
            username: tier === 'own' ? username : undefined,
        });
        // A config change (which bumped the token + reset to idle) supersedes
        // this result; drop it so a slow test can't re-enable Next for a URL
        // the user has since edited.
        if (token !== testTokenRef.current) return;
        if (result.ok) {
            setTestState('ok');
            setTestError('');
        } else {
            setTestState('error');
            setTestError(result.error ?? '');
        }
    }, [brokerUrl, currentServer, password, tier, transport, username]);

    const handleFinish = useCallback(async () => {
        if (finishingRef.current) return;
        finishingRef.current = true;
        setSaving(true);
        try {
            // Make sure the identity is seeded so the client has something
            // to publish under. The peer-id stays stable for the install.
            // The room key (== broker auth password) is deterministically the
            // Jellyfin username so every device the same account signs into
            // authenticates to the same room — a random per-install key would
            // stop a user's own devices from pairing. Persist it here so the
            // embedded broker (peerBrokerApi.setEnabled) + diagnostics stay
            // consistent with what the live client derives at runtime.
            const peerId = settings.peerId || nanoid();
            const roomKey = currentServer?.username ?? '';

            // S2-A: never start the embedded broker with a blank roomKey. The
            // room key IS the broker auth password, and a broker started with
            // roomKey==='' accepts any client presenting an empty password —
            // effectively open. Mirror the guard peer-sync-settings'
            // handleBrokerToggle already enforces. (Bare username flows can
            // produce a blank username → blank roomKey.)
            if (tier === 'embedded' && !roomKey) {
                toast.warn({
                    message: t('error.embeddedBrokerNeedsServer', {
                        defaultValue:
                            'Sign in to a Jellyfin server before starting the embedded broker — the room key is derived from your username.',
                    }),
                });
                return;
            }

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
                    homeAssistant: { enabled: homeAssistant },
                    jellyfinRemoteEnabled: true,
                    onboarded: true,
                    peerId,
                    roomKey,
                    // Embedded/public peers run over the embedded/public WS
                    // listeners; only the own-broker tier exposes the transport
                    // choice (raw TCP makes sense there). Reset to 'auto'
                    // otherwise so a stale 'tcp' can't strand non-Android peers.
                    transport: tier === 'own' ? transport : 'auto',
                },
            });
            toast.info({
                message: t('page.setting.wizardFinished', {
                    defaultValue:
                        'Sync & Connect is set up. Look for the Connect button on the player bar.',
                }),
            });
            // Stay on the Finish step and flip into the success state so the
            // user sees a confirmation instead of being teleported back to the
            // intro (which read as "the click broke").
            setFinished(true);
        } finally {
            setSaving(false);
            finishingRef.current = false;
        }
    }, [
        brokerUrl,
        currentServer?.username,
        homeAssistant,
        password,
        settings.broker,
        settings.peerId,
        setSettings,
        t,
        tier,
        transport,
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
            <ScrollArea offsetScrollbars type="auto">
                <Stepper
                    active={step}
                    allowNextStepsSelect={false}
                    onStepClick={handleStepClick}
                    orientation={isMobile ? 'vertical' : 'horizontal'}
                >
                    <Stepper.Step
                        label={t('page.setting.wizardStepIntro', { defaultValue: 'About' })}
                    >
                        <StepIntro onNext={goNext} />
                    </Stepper.Step>
                    <Stepper.Step
                        label={t('page.setting.wizardStepTier', { defaultValue: 'Broker tier' })}
                    >
                        <StepTier onBack={goBack} onNext={goNext} onTier={setTier} tier={tier} />
                    </Stepper.Step>
                    <Stepper.Step
                        label={t('page.setting.wizardStepConfigure', {
                            defaultValue: 'Configure',
                        })}
                    >
                        <StepConfigure
                            brokerUrl={brokerUrl}
                            onBack={goBack}
                            onBrokerUrl={setBrokerUrl}
                            onNext={goNext}
                            onPassword={setPassword}
                            onTest={handleTest}
                            onTransport={setTransport}
                            onUsername={setUsername}
                            password={password}
                            testError={testError}
                            testState={testState}
                            tier={tier}
                            transport={transport}
                            username={username}
                        />
                    </Stepper.Step>
                    <Stepper.Step
                        label={t('page.setting.wizardStepFinish', { defaultValue: 'Finish' })}
                    >
                        <StepFinish
                            brokerUrl={brokerUrl}
                            finished={finished}
                            homeAssistant={homeAssistant}
                            onBack={goBack}
                            onFinish={handleFinish}
                            onHomeAssistantChange={setHomeAssistant}
                            onRerun={handleRerun}
                            saving={saving}
                            tier={tier}
                        />
                    </Stepper.Step>
                </Stepper>
            </ScrollArea>
        </Stack>
    );
});

ConnectWizard.displayName = 'ConnectWizard';
