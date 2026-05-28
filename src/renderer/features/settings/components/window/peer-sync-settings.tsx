/**
 * Peer sync (MQTT) settings — desktop primary, web/mobile read-only on
 * broker controls. Renders as a single collapsible block, *collapsed by
 * default*, sitting under the Jellyfin Connect group.
 *
 * Behavior contract:
 *
 *  - Top-level Enable switch flips the master toggle. Off = subsystem
 *    inert; existing Jellyfin Sessions polling continues unchanged.
 *  - Advanced collapsible exposes broker URL, embedded broker on/off
 *    (desktop only), embedded host/port, TLS cert paths, and the shared
 *    room key. Hidden until the master is on.
 *  - A non-private broker URL triggers an undismissable Alert warning the
 *    user that public brokers can see playback state and commands.
 *  - peerId / roomKey are auto-generated on first opt-in if missing.
 */
import { Alert, Collapse, Group, Stack, Switch } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import isElectron from 'is-electron';
import { nanoid } from 'nanoid';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { SettingsSection } from '/@/renderer/features/settings/components/settings-section';
import { usePeerSyncSettings, useSettingsStoreActions } from '/@/renderer/store';
import { Button } from '/@/shared/components/button/button';
import { NumberInput } from '/@/shared/components/number-input/number-input';
import { TextInput } from '/@/shared/components/text-input/text-input';
import { Text } from '/@/shared/components/text/text';
import { toast } from '/@/shared/components/toast/toast';

const peerBrokerApi = isElectron() ? window.api.peerBroker : null;

/**
 * Quick heuristic that decides whether a URL points at a public broker.
 * RFC1918 / loopback / `.local` are private; anything else gets the
 * public-broker warning surfaced. The check is intentionally conservative:
 * a false-positive shows a callout, which is a far smaller harm than a
 * false-negative letting a public broker through silently.
 */
export const isPublicBrokerUrl = (raw: string): boolean => {
    if (!raw) return false;
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return false;
    }
    // URL hostname strips the IPv6 brackets so `[::1]` parses to `::1`.
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!host) return false;
    if (host === 'localhost' || host === '127.0.0.1') return false;
    if (host === '::1' || host === '0:0:0:0:0:0:0:1') return false;
    if (host.endsWith('.local')) return false;
    // RFC1918 IPv4 ranges
    if (/^10\./.test(host)) return false;
    if (/^192\.168\./.test(host)) return false;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return false;
    // Link-local + Tailscale 100.x.y.z / unique-local IPv6 (fc00::/7)
    if (/^169\.254\./.test(host)) return false;
    if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return false;
    if (/^f[cd][0-9a-f]{2}:/i.test(host)) return false;
    return true;
};

export const PeerSyncSettings = memo(() => {
    const { t } = useTranslation();
    const settings = usePeerSyncSettings();
    const { setSettings } = useSettingsStoreActions();
    const [advancedOpen, advancedHandlers] = useDisclosure(false);
    const [topOpen, topHandlers] = useDisclosure(false);

    // Mirror controlled inputs locally so typing in the URL field doesn't
    // round-trip through the persisted store on every keystroke (and so
    // empty strings stay empty without immediately re-validating).
    const [brokerUrlDraft, setBrokerUrlDraft] = useState(settings.brokerUrl);
    const [roomKeyDraft, setRoomKeyDraft] = useState(settings.roomKey);
    useEffect(() => setBrokerUrlDraft(settings.brokerUrl), [settings.brokerUrl]);
    useEffect(() => setRoomKeyDraft(settings.roomKey), [settings.roomKey]);

    const isPublicBroker = useMemo(() => isPublicBrokerUrl(brokerUrlDraft), [brokerUrlDraft]);

    const ensureIdentity = useCallback(() => {
        if (settings.peerId && settings.roomKey) return;
        setSettings({
            peerSync: {
                peerId: settings.peerId || nanoid(),
                roomKey: settings.roomKey || nanoid(24),
            },
        });
    }, [settings.peerId, settings.roomKey, setSettings]);

    const handleEnable = useCallback(
        (enabled: boolean) => {
            // Auto-seed peerId + roomKey on first opt-in so the user never
            // has to think about either to get the happy path working.
            if (enabled) ensureIdentity();
            setSettings({ peerSync: { enabled } });
        },
        [ensureIdentity, setSettings],
    );

    const handleBrokerToggle = useCallback(
        async (enabled: boolean) => {
            if (!peerBrokerApi) {
                toast.warn({
                    message: t('error.embeddedBrokerNeedsElectron', {
                        defaultValue: 'The embedded broker is only available in the desktop app.',
                    }),
                });
                return;
            }
            const errorMsg = enabled
                ? await peerBrokerApi.setEnabled({
                      host: settings.broker.host,
                      port: settings.broker.port,
                      roomKey: settings.roomKey || roomKeyDraft || nanoid(24),
                      tlsCertPath: settings.broker.tlsCertPath || undefined,
                      tlsKeyPath: settings.broker.tlsKeyPath || undefined,
                  })
                : await peerBrokerApi.setEnabled(null);
            if (errorMsg) {
                toast.error({ message: errorMsg });
                return;
            }
            setSettings({ peerSync: { broker: { enabled } } });
        },
        [
            settings.broker.host,
            settings.broker.port,
            settings.broker.tlsCertPath,
            settings.broker.tlsKeyPath,
            settings.roomKey,
            roomKeyDraft,
            setSettings,
            t,
        ],
    );

    const copyRoomKey = useCallback(async () => {
        const key = settings.roomKey || roomKeyDraft;
        if (!key) return;
        try {
            await navigator.clipboard.writeText(key);
            toast.info({ message: t('common.copied', { defaultValue: 'Copied' }) });
        } catch {
            // clipboard API may be unavailable in some sandboxed contexts;
            // fall through silently — the value is visible in the field.
        }
    }, [settings.roomKey, roomKeyDraft, t]);

    const advancedOptions = useMemo(
        () => [
            {
                control: (
                    <TextInput
                        onBlur={(e) => {
                            const next = e.currentTarget.value.trim();
                            if (next === settings.brokerUrl) return;
                            setSettings({ peerSync: { brokerUrl: next } });
                        }}
                        onChange={(e) => setBrokerUrlDraft(e.currentTarget.value)}
                        placeholder="ws://localhost:8083"
                        value={brokerUrlDraft}
                    />
                ),
                description: (
                    <Text isMuted isNoSelect size="sm">
                        {t('setting.peerSyncBrokerUrl', {
                            context: 'description',
                            defaultValue:
                                'WebSocket URL of the MQTT broker. Leave blank to auto-discover an embedded broker on the LAN.',
                        })}
                    </Text>
                ),
                title: t('setting.peerSyncBrokerUrl', { defaultValue: 'Broker URL' }),
            },
            ...(isElectron()
                ? [
                      {
                          control: (
                              <Switch
                                  checked={settings.broker.enabled}
                                  onChange={(e) => handleBrokerToggle(e.currentTarget.checked)}
                              />
                          ),
                          description: t('setting.peerSyncEmbeddedBroker', {
                              context: 'description',
                              defaultValue:
                                  'Run a local MQTT broker on this machine for other Feishins on your network to use.',
                          }),
                          title: t('setting.peerSyncEmbeddedBroker', {
                              defaultValue: 'Embedded broker',
                          }),
                      },
                      {
                          control: (
                              <TextInput
                                  defaultValue={settings.broker.host}
                                  onBlur={(e) => {
                                      const host = e.currentTarget.value.trim();
                                      if (host === settings.broker.host) return;
                                      setSettings({ peerSync: { broker: { host } } });
                                  }}
                                  placeholder="0.0.0.0"
                              />
                          ),
                          description: t('setting.peerSyncBrokerHost', {
                              context: 'description',
                              defaultValue:
                                  'Listen address for the embedded broker. 0.0.0.0 exposes it on every interface.',
                          }),
                          isHidden: !settings.broker.enabled,
                          title: t('setting.peerSyncBrokerHost', { defaultValue: 'Listen host' }),
                      },
                      {
                          control: (
                              <NumberInput
                                  max={65_535}
                                  min={1}
                                  onBlur={(e) => {
                                      if (!e) return;
                                      const port = Number(e.currentTarget.value);
                                      if (!Number.isFinite(port) || port === settings.broker.port)
                                          return;
                                      setSettings({ peerSync: { broker: { port } } });
                                  }}
                                  value={settings.broker.port}
                              />
                          ),
                          description: t('setting.peerSyncBrokerPort', {
                              context: 'description',
                              defaultValue: 'Listen port for the embedded broker.',
                          }),
                          isHidden: !settings.broker.enabled,
                          title: t('setting.peerSyncBrokerPort', { defaultValue: 'Listen port' }),
                      },
                      {
                          control: (
                              <TextInput
                                  defaultValue={settings.broker.tlsCertPath ?? ''}
                                  onBlur={(e) => {
                                      const tlsCertPath = e.currentTarget.value.trim() || undefined;
                                      if (tlsCertPath === settings.broker.tlsCertPath) return;
                                      setSettings({
                                          peerSync: { broker: { tlsCertPath } },
                                      });
                                  }}
                                  placeholder="/path/to/cert.pem"
                              />
                          ),
                          description: t('setting.peerSyncTlsCert', {
                              context: 'description',
                              defaultValue:
                                  'Path to a TLS certificate. Pair with a key path to enable WSS.',
                          }),
                          isHidden: !settings.broker.enabled,
                          title: t('setting.peerSyncTlsCert', { defaultValue: 'TLS certificate' }),
                      },
                      {
                          control: (
                              <TextInput
                                  defaultValue={settings.broker.tlsKeyPath ?? ''}
                                  onBlur={(e) => {
                                      const tlsKeyPath = e.currentTarget.value.trim() || undefined;
                                      if (tlsKeyPath === settings.broker.tlsKeyPath) return;
                                      setSettings({
                                          peerSync: { broker: { tlsKeyPath } },
                                      });
                                  }}
                                  placeholder="/path/to/key.pem"
                              />
                          ),
                          description: t('setting.peerSyncTlsKey', {
                              context: 'description',
                              defaultValue: 'Path to the private key matching the certificate.',
                          }),
                          isHidden: !settings.broker.enabled,
                          title: t('setting.peerSyncTlsKey', { defaultValue: 'TLS private key' }),
                      },
                  ]
                : []),
            {
                control: (
                    <Group gap="sm" wrap="nowrap">
                        <TextInput
                            onBlur={(e) => {
                                const next = e.currentTarget.value.trim();
                                if (!next || next === settings.roomKey) return;
                                setSettings({ peerSync: { roomKey: next } });
                            }}
                            onChange={(e) => setRoomKeyDraft(e.currentTarget.value)}
                            placeholder={
                                t('setting.peerSyncRoomKey', {
                                    defaultValue: 'Shared room key',
                                }) as string
                            }
                            value={roomKeyDraft}
                        />
                        <Button
                            onClick={() => {
                                const next = nanoid(24);
                                setRoomKeyDraft(next);
                                setSettings({ peerSync: { roomKey: next } });
                            }}
                            size="compact-sm"
                            variant="default"
                        >
                            {t('common.regenerate', { defaultValue: 'Regenerate' })}
                        </Button>
                        <Button onClick={copyRoomKey} size="compact-sm" variant="default">
                            {t('common.copy', { defaultValue: 'Copy' })}
                        </Button>
                    </Group>
                ),
                description: t('setting.peerSyncRoomKey', {
                    context: 'description',
                    defaultValue:
                        'Every Feishin that joins the same broker with this key is treated as a peer. Keep it secret.',
                }),
                title: t('setting.peerSyncRoomKey', { defaultValue: 'Room key' }),
            },
        ],
        [
            brokerUrlDraft,
            copyRoomKey,
            handleBrokerToggle,
            roomKeyDraft,
            settings.broker.enabled,
            settings.broker.host,
            settings.broker.port,
            settings.broker.tlsCertPath,
            settings.broker.tlsKeyPath,
            settings.brokerUrl,
            settings.roomKey,
            setSettings,
            t,
        ],
    );

    return (
        <Stack gap="sm">
            <Group justify="space-between">
                <Stack gap={2}>
                    <Text fw={600}>
                        {t('page.setting.peerSync', { defaultValue: 'Peer sync (MQTT)' })}
                    </Text>
                    <Text isMuted size="sm">
                        {t('page.setting.peerSyncDescription', {
                            defaultValue:
                                'Augment Jellyfin Connect with a low-latency direct sync between two Feishin instances.',
                        })}
                    </Text>
                </Stack>
                <Button onClick={topHandlers.toggle} size="compact-sm" variant="default">
                    {topOpen
                        ? t('common.hide', { defaultValue: 'Hide' })
                        : t('common.show', { defaultValue: 'Show' })}
                </Button>
            </Group>

            <Collapse expanded={topOpen}>
                <Stack gap="md">
                    <SettingsSection
                        options={[
                            {
                                control: (
                                    <Switch
                                        checked={settings.enabled}
                                        onChange={(e) => handleEnable(e.currentTarget.checked)}
                                    />
                                ),
                                description: t('setting.enablePeerSync', {
                                    context: 'description',
                                    defaultValue:
                                        'When two Feishins are reachable via MQTT, commands and state flow over MQTT instead of the polling lane.',
                                }),
                                title: t('setting.enablePeerSync', {
                                    defaultValue: 'Enable peer sync',
                                }),
                            },
                        ]}
                    />

                    {settings.enabled && isPublicBroker && (
                        <Alert color="yellow" variant="light">
                            {t('setting.peerSyncPublicBrokerWarning', {
                                defaultValue:
                                    'Public brokers can see your playback state and commands. Use TLS and a strong room key, or run your own broker.',
                            })}
                        </Alert>
                    )}

                    {settings.enabled && (
                        <Stack gap="xs">
                            <Group justify="space-between">
                                <Text fw={500}>
                                    {t('setting.peerSyncAdvanced', {
                                        defaultValue: 'Advanced',
                                    })}
                                </Text>
                                <Button
                                    onClick={advancedHandlers.toggle}
                                    size="compact-sm"
                                    variant="default"
                                >
                                    {advancedOpen
                                        ? t('common.hide', { defaultValue: 'Hide' })
                                        : t('common.show', { defaultValue: 'Show' })}
                                </Button>
                            </Group>
                            <Collapse expanded={advancedOpen}>
                                <SettingsSection options={advancedOptions} />
                            </Collapse>
                        </Stack>
                    )}
                </Stack>
            </Collapse>
        </Stack>
    );
});

PeerSyncSettings.displayName = 'PeerSyncSettings';
