/**
 * Peer sync (MQTT) settings subpage. Desktop hosts the optional embedded
 * broker; web/mobile peers connect to whichever URL the user configures.
 *
 *  - Top-level Enable switch flips the master toggle. Off = subsystem inert;
 *    existing Jellyfin Sessions polling continues unchanged.
 *  - Advanced collapsible exposes broker URL, embedded broker on/off
 *    (desktop only), embedded host/port, TLS cert paths, and the shared
 *    room key. Hidden until the master is on.
 *  - A non-private broker URL triggers an undismissable Alert warning that
 *    public brokers can see playback state and commands.
 *  - peerId / roomKey are auto-generated on first opt-in if missing.
 */
import { Alert, Collapse, Group, Stack, Switch } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import isElectron from 'is-electron';
import { nanoid } from 'nanoid';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useRemoteTargetStore } from '/@/renderer/features/jellyfin-remote-target/store/remote-target-store';
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

    // Mirror controlled inputs locally so typing in the URL field doesn't
    // round-trip through the persisted store on every keystroke (and so
    // empty strings stay empty without immediately re-validating).
    const [brokerUrlDraft, setBrokerUrlDraft] = useState(settings.brokerUrl);
    const [roomKeyDraft, setRoomKeyDraft] = useState(settings.roomKey);
    const [brokerUsernameDraft, setBrokerUsernameDraft] = useState(settings.brokerUsername);
    const [brokerPasswordDraft, setBrokerPasswordDraft] = useState(settings.brokerPassword);
    useEffect(() => setBrokerUrlDraft(settings.brokerUrl), [settings.brokerUrl]);
    useEffect(() => setRoomKeyDraft(settings.roomKey), [settings.roomKey]);
    useEffect(() => setBrokerUsernameDraft(settings.brokerUsername), [settings.brokerUsername]);
    useEffect(() => setBrokerPasswordDraft(settings.brokerPassword), [settings.brokerPassword]);

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
            // Flipping the MQTT lane off while the embedded broker is still
            // running would leave a zombie listener with no client behind it.
            // Stop it here so the user gets a fully-quiet system back.
            if (!enabled && peerBrokerApi && settings.broker.enabled) {
                void peerBrokerApi.setEnabled(null);
                setSettings({ peerSync: { broker: { enabled: false }, enabled } });
                return;
            }
            setSettings({ peerSync: { enabled } });
        },
        [ensureIdentity, setSettings, settings.broker.enabled],
    );

    /**
     * Master kill-switch for the whole Jellyfin Remote subsystem. Flipping
     * it off mid-session has to clean up everything the user was running:
     * the live remote target (otherwise the player would stay wedged on a
     * device the picker can no longer reach) and the embedded broker (which
     * the picker is also the entry point for).
     */
    const handleJellyfinRemoteEnabled = useCallback(
        (enabled: boolean) => {
            if (!enabled) {
                // Drop the current Connect session so the player snaps back
                // to local before the UI surfaces disappear.
                useRemoteTargetStore.getState().actions.clearTarget();
                setSettings({
                    peerSync: { jellyfinRemoteEnabled: false },
                    playback: { remoteTargetDeviceId: null, remoteTargetDeviceName: null },
                });
                if (peerBrokerApi && settings.broker.enabled) {
                    void peerBrokerApi.setEnabled(null);
                    setSettings({ peerSync: { broker: { enabled: false } } });
                }
                return;
            }
            setSettings({ peerSync: { jellyfinRemoteEnabled: true } });
        },
        [setSettings, settings.broker.enabled],
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
            {
                control: (
                    <TextInput
                        autoComplete="off"
                        onBlur={(e) => {
                            const next = e.currentTarget.value;
                            if (next === settings.brokerUsername) return;
                            setSettings({ peerSync: { brokerUsername: next } });
                        }}
                        onChange={(e) => setBrokerUsernameDraft(e.currentTarget.value)}
                        placeholder={t('setting.peerSyncBrokerUsername', {
                            context: 'placeholder',
                            defaultValue: 'Leave blank for embedded broker',
                        })}
                        value={brokerUsernameDraft}
                    />
                ),
                description: (
                    <Text isMuted isNoSelect size="sm">
                        {t('setting.peerSyncBrokerUsername', {
                            context: 'description',
                            defaultValue:
                                'Username for brokers that require authentication. Leave blank when using the embedded broker on the LAN.',
                        })}
                    </Text>
                ),
                title: t('setting.peerSyncBrokerUsername', { defaultValue: 'Broker username' }),
            },
            {
                control: (
                    <TextInput
                        autoComplete="new-password"
                        onBlur={(e) => {
                            const next = e.currentTarget.value;
                            if (next === settings.brokerPassword) return;
                            setSettings({ peerSync: { brokerPassword: next } });
                        }}
                        onChange={(e) => setBrokerPasswordDraft(e.currentTarget.value)}
                        placeholder=""
                        type="password"
                        value={brokerPasswordDraft}
                    />
                ),
                description: (
                    <Text isMuted isNoSelect size="sm">
                        {t('setting.peerSyncBrokerPassword', {
                            context: 'description',
                            defaultValue:
                                'Password for brokers that require authentication. Stored locally; treat it like any other saved password.',
                        })}
                    </Text>
                ),
                title: t('setting.peerSyncBrokerPassword', { defaultValue: 'Broker password' }),
            },
            ...(isElectron()
                ? [
                      {
                          control: (
                              <Switch
                                  aria-label={t('setting.peerSyncEmbeddedBroker', {
                                      defaultValue: 'Embedded broker',
                                  })}
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
                                  key={`broker-host-${settings.broker.host}`}
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
                                  defaultValue={settings.broker.port}
                                  key={`broker-port-${settings.broker.port}`}
                                  max={65_535}
                                  min={1}
                                  onBlur={(e) => {
                                      if (!e) return;
                                      const port = Number(e.currentTarget.value);
                                      if (!Number.isFinite(port) || port === settings.broker.port)
                                          return;
                                      setSettings({ peerSync: { broker: { port } } });
                                  }}
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
                                  key={`tls-cert-${settings.broker.tlsCertPath ?? ''}`}
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
                                  key={`tls-key-${settings.broker.tlsKeyPath ?? ''}`}
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
            brokerPasswordDraft,
            brokerUrlDraft,
            brokerUsernameDraft,
            copyRoomKey,
            handleBrokerToggle,
            roomKeyDraft,
            settings.broker.enabled,
            settings.broker.host,
            settings.broker.port,
            settings.broker.tlsCertPath,
            settings.broker.tlsKeyPath,
            settings.brokerPassword,
            settings.brokerUrl,
            settings.brokerUsername,
            settings.roomKey,
            setSettings,
            t,
        ],
    );

    return (
        <Stack gap="md">
            <SettingsSection
                options={[
                    {
                        control: (
                            <Switch
                                aria-label={t('setting.enableJellyfinRemote', {
                                    defaultValue: 'Enable Jellyfin Remote',
                                })}
                                checked={settings.jellyfinRemoteEnabled}
                                onChange={(e) =>
                                    handleJellyfinRemoteEnabled(e.currentTarget.checked)
                                }
                            />
                        ),
                        description: t('setting.enableJellyfinRemote', {
                            context: 'description',
                            defaultValue:
                                'Master kill-switch for Jellyfin Remote. When off: no device picker, no Sessions polling, no remote-control receiver. MQTT is also paused since the picker is its entry point.',
                        }),
                        title: t('setting.enableJellyfinRemote', {
                            defaultValue: 'Enable Jellyfin Remote',
                        }),
                    },
                    {
                        control: (
                            <Switch
                                aria-label={t('setting.enablePeerSync', {
                                    defaultValue: 'Enable MQTT peer sync',
                                })}
                                checked={settings.enabled}
                                disabled={!settings.jellyfinRemoteEnabled}
                                onChange={(e) => handleEnable(e.currentTarget.checked)}
                            />
                        ),
                        description: settings.jellyfinRemoteEnabled
                            ? t('setting.enablePeerSync', {
                                  context: 'description',
                                  defaultValue:
                                      'When two Feishins are reachable via MQTT, commands and state flow over MQTT instead of the polling lane.',
                              })
                            : t('setting.enablePeerSyncDisabledHint', {
                                  defaultValue:
                                      'Re-enable Jellyfin Remote above to use the MQTT lane. MQTT piggy-backs on the same picker.',
                              }),
                        title: t('setting.enablePeerSync', {
                            defaultValue: 'Enable MQTT peer sync',
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

            {settings.onboarded && (
                <SettingsSection
                    options={[
                        {
                            control: (
                                <Switch
                                    aria-label={t('setting.peerSyncShowConnectButton', {
                                        defaultValue: 'Show Connect button',
                                    })}
                                    checked={settings.ui.connectButton}
                                    onChange={(e) =>
                                        setSettings({
                                            peerSync: {
                                                ui: { connectButton: e.currentTarget.checked },
                                            },
                                        })
                                    }
                                />
                            ),
                            description: t('setting.peerSyncShowConnectButton', {
                                context: 'description',
                                defaultValue:
                                    'Hide the Connect button on the player bar to keep the UI tidy. The picker is still reachable from the device list.',
                            }),
                            title: t('setting.peerSyncShowConnectButton', {
                                defaultValue: 'Show Connect button',
                            }),
                        },
                        {
                            control: (
                                <Switch
                                    aria-label={t('setting.peerSyncShowStatusPill', {
                                        defaultValue: 'Show transport pill',
                                    })}
                                    checked={settings.ui.statusPill}
                                    onChange={(e) =>
                                        setSettings({
                                            peerSync: {
                                                ui: { statusPill: e.currentTarget.checked },
                                            },
                                        })
                                    }
                                />
                            ),
                            description: t('setting.peerSyncShowStatusPill', {
                                context: 'description',
                                defaultValue:
                                    'Show the Local / Jellyfin / MQTT lane indicator next to the Connect button.',
                            }),
                            title: t('setting.peerSyncShowStatusPill', {
                                defaultValue: 'Show transport pill',
                            }),
                        },
                        {
                            control: (
                                <Switch
                                    aria-label={t('setting.peerSyncShowPickerBadges', {
                                        defaultValue: 'Show MQTT lane badges',
                                    })}
                                    checked={settings.ui.pickerBadges}
                                    onChange={(e) =>
                                        setSettings({
                                            peerSync: {
                                                ui: { pickerBadges: e.currentTarget.checked },
                                            },
                                        })
                                    }
                                />
                            ),
                            description: t('setting.peerSyncShowPickerBadges', {
                                context: 'description',
                                defaultValue:
                                    'Show the MQTT badge next to peers in the device picker when MQTT is the live lane.',
                            }),
                            title: t('setting.peerSyncShowPickerBadges', {
                                defaultValue: 'Show MQTT lane badges',
                            }),
                        },
                    ]}
                />
            )}

            {settings.enabled && (
                <Stack gap="xs">
                    <Group justify="space-between">
                        <Text fw={500} id="peer-sync-advanced-label">
                            {t('setting.peerSyncAdvanced', { defaultValue: 'Advanced' })}
                        </Text>
                        <Button
                            aria-controls="peer-sync-advanced-panel"
                            aria-expanded={advancedOpen}
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
                        <div
                            aria-labelledby="peer-sync-advanced-label"
                            id="peer-sync-advanced-panel"
                            role="region"
                        >
                            <SettingsSection options={advancedOptions} />
                        </div>
                    </Collapse>
                </Stack>
            )}
        </Stack>
    );
});

PeerSyncSettings.displayName = 'PeerSyncSettings';
