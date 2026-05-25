import { Collapse, UnstyledButton } from '@mantine/core';
import { closeAllModals, openModal } from '@mantine/modals';
import isElectron from 'is-electron';
import { nanoid } from 'nanoid/non-secure';
import { FocusEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '/@/renderer/api';
import {
    isLegacyAuth,
    isServerLock,
} from '/@/renderer/features/action-required/utils/window-properties';
import JellyfinIcon from '/@/renderer/features/servers/assets/jellyfin.png';
import NavidromeIcon from '/@/renderer/features/servers/assets/navidrome.png';
import SubsonicIcon from '/@/renderer/features/servers/assets/opensubsonic.png';
import { IgnoreCorsSslSwitches } from '/@/renderer/features/servers/components/ignore-cors-ssl-switches';
import { useIsMobileShell } from '/@/renderer/hooks/use-breakpoint';
import { useAuthStoreActions, useServerList } from '/@/renderer/store';
import { Button } from '/@/shared/components/button/button';
import { Checkbox } from '/@/shared/components/checkbox/checkbox';
import { Divider } from '/@/shared/components/divider/divider';
import { Group } from '/@/shared/components/group/group';
import { Icon } from '/@/shared/components/icon/icon';
import { ModalButton } from '/@/shared/components/modal/model-shared';
import { Paper } from '/@/shared/components/paper/paper';
import { PasswordInput } from '/@/shared/components/password-input/password-input';
import { Stack } from '/@/shared/components/stack/stack';
import { TextInput } from '/@/shared/components/text-input/text-input';
import { Text } from '/@/shared/components/text/text';
import { toast } from '/@/shared/components/toast/toast';
import { useDisclosure } from '/@/shared/hooks/use-disclosure';
import { useFocusTrap } from '/@/shared/hooks/use-focus-trap';
import { useForm } from '/@/shared/hooks/use-form';
import { AuthenticationResponse, ServerListItemWithCredential } from '/@/shared/types/domain-types';
import { DiscoveredServerItem, ServerType, toServerType } from '/@/shared/types/types';

const autodiscover = isElectron() ? window.api.autodiscover : null;
const localSettings = isElectron() ? window.api.localSettings : null;

interface AddServerFormProps {
    onCancel: (() => void) | null;
}

interface ServerDetails {
    icon: string;
    name: string;
}

function useAutodiscovery() {
    const [isDone, setDone] = useState(false);
    const [servers, setServers] = useState<DiscoveredServerItem[]>([]);

    useEffect(() => {
        setServers([]);

        autodiscover
            ?.discover((newServer) => {
                setServers((tail) => [...tail, newServer]);
            })
            .then(() => {
                setDone(true);
            });
    }, []);

    return { isDone, servers };
}

const SERVER_TYPES: Record<ServerType, ServerDetails> = {
    [ServerType.JELLYFIN]: {
        icon: JellyfinIcon,
        name: 'Jellyfin',
    },
    [ServerType.NAVIDROME]: {
        icon: NavidromeIcon,
        name: 'Navidrome',
    },
    [ServerType.SUBSONIC]: {
        icon: SubsonicIcon,
        name: 'OpenSubsonic',
    },
};

function JellyfinFirstTypePicker({
    disabled,
    onChange,
    value,
}: {
    disabled?: boolean;
    onChange: (type: ServerType) => void;
    value: ServerType;
}) {
    const { t } = useTranslation();
    const [otherOpen, { toggle: toggleOther }] = useDisclosure(value !== ServerType.JELLYFIN);

    return (
        <Stack gap="sm">
            <ServerTypeCard
                disabled={disabled}
                icon={JellyfinIcon}
                isSelected={value === ServerType.JELLYFIN}
                label="Jellyfin"
                onClick={() => onChange(ServerType.JELLYFIN)}
            />
            <Button
                disabled={disabled}
                onClick={toggleOther}
                rightSection={<Icon icon={otherOpen ? 'arrowUpS' : 'arrowDownS'} size="sm" />}
                size="xs"
                variant="subtle"
            >
                {t('form.addServer.otherServerTypes')}
            </Button>
            <Collapse expanded={otherOpen}>
                <Group gap="sm" grow>
                    <ServerTypeCard
                        disabled={disabled}
                        icon={NavidromeIcon}
                        isSelected={value === ServerType.NAVIDROME}
                        label="Navidrome"
                        onClick={() => onChange(ServerType.NAVIDROME)}
                    />
                    <ServerTypeCard
                        disabled={disabled}
                        icon={SubsonicIcon}
                        isSelected={value === ServerType.SUBSONIC}
                        label="OpenSubsonic"
                        onClick={() => onChange(ServerType.SUBSONIC)}
                    />
                </Group>
            </Collapse>
        </Stack>
    );
}

function NonJellyfinWarningModal({
    onConfirm,
    onRevert,
    typeName,
}: {
    onConfirm: () => void;
    onRevert: () => void;
    typeName: string;
}) {
    const { t } = useTranslation();
    return (
        <Stack gap="md">
            <Text>{t('form.addServer.jellyfinWarning_body')}</Text>
            <Group gap="sm" justify="flex-end">
                <Button onClick={onRevert} variant="default">
                    {t('form.addServer.jellyfinWarning_useJellyfin')}
                </Button>
                <Button onClick={onConfirm} variant="filled">
                    {t('form.addServer.jellyfinWarning_continue', { type: typeName })}
                </Button>
            </Group>
        </Stack>
    );
}

function normalizeInputUrl(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) return trimmed;
    if (!/^https?:\/\//i.test(trimmed)) return 'http://' + trimmed.replace(/\/$/, '');
    // Only strip trailing slash when there's a host (not just a bare scheme)
    const withoutScheme = trimmed.replace(/^https?:\/\//i, '');
    if (!withoutScheme || withoutScheme === '/') return trimmed;
    return trimmed.replace(/\/$/, '');
}

function ServerTypeCard({
    disabled,
    icon,
    isSelected,
    label,
    onClick,
}: {
    disabled?: boolean;
    icon: string;
    isSelected: boolean;
    label: string;
    onClick: () => void;
}) {
    return (
        <UnstyledButton
            aria-checked={isSelected}
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
            role="radio"
            style={{
                border: isSelected
                    ? '2px solid var(--mantine-color-primary-6)'
                    : '2px solid transparent',
                borderRadius: 'var(--mantine-radius-md)',
                cursor: disabled ? 'default' : 'pointer',
                opacity: disabled ? 0.6 : 1,
                padding: 'var(--mantine-spacing-md)',
                textAlign: 'center' as const,
                width: '100%',
            }}
        >
            <Stack align="center" gap="xs">
                <img alt={label} height={40} src={icon} width={40} />
                <Text fw={isSelected ? 700 : 400} size="sm">
                    {label}
                </Text>
            </Stack>
        </UnstyledButton>
    );
}

const URL_PLACEHOLDERS: Record<ServerType, string> = {
    [ServerType.JELLYFIN]: 'http://jellyfin.yourdomain.com',
    [ServerType.NAVIDROME]: 'http://navidrome.yourdomain.com',
    [ServerType.SUBSONIC]: 'http://your-subsonic-server.com',
};

const DEFAULT_NAMES: Record<ServerType, string> = {
    [ServerType.JELLYFIN]: 'My Jellyfin',
    [ServerType.NAVIDROME]: 'My Navidrome',
    [ServerType.SUBSONIC]: 'My OpenSubsonic',
};

export const AddServerForm = ({ onCancel }: AddServerFormProps) => {
    const { t } = useTranslation();
    const focusTrapRef = useFocusTrap(true);
    const [isLoading, setIsLoading] = useState(false);
    const { addServer, setCurrentServer } = useAuthStoreActions();
    const serverList = useServerList();
    const { servers: discovered } = useAutodiscovery();
    const isMobileShell = useIsMobileShell();

    const serverLock = isServerLock();

    const form = useForm({
        initialValues: {
            legacyAuth: isLegacyAuth(),
            name:
                (localSettings ? localSettings.env.SERVER_NAME : window.SERVER_NAME) ||
                (DEFAULT_NAMES[
                    ((localSettings
                        ? localSettings.env.SERVER_TYPE
                        : toServerType(window.SERVER_TYPE)) ?? ServerType.JELLYFIN) as ServerType
                ] ??
                    'My Server'),
            password: '',
            preferInstantMix: undefined,
            preferRemoteUrl: false,
            remoteUrl: '',
            savePassword: undefined,
            type:
                (localSettings
                    ? localSettings.env.SERVER_TYPE
                    : toServerType(window.SERVER_TYPE)) ?? ServerType.JELLYFIN,
            url: (localSettings ? localSettings.env.SERVER_URL : window.SERVER_URL) ?? 'http://',
            username: '',
        },
    });

    const mobileInputProps = isMobileShell
        ? {
              onFocus: (e: FocusEvent<HTMLInputElement>) =>
                  e.currentTarget.scrollIntoView({ behavior: 'smooth', block: 'center' }),
          }
        : {};

    const handleTypeSelect = (newType: ServerType) => {
        if (newType !== ServerType.JELLYFIN && form.values.type === ServerType.JELLYFIN) {
            openModal({
                children: (
                    <NonJellyfinWarningModal
                        onConfirm={() => {
                            form.setFieldValue('type', newType);
                            closeAllModals();
                        }}
                        onRevert={closeAllModals}
                        typeName={SERVER_TYPES[newType].name}
                    />
                ),
                title: t('form.addServer.jellyfinWarning_title'),
            });
        } else {
            form.setFieldValue('type', newType);
        }
    };

    const handleUrlBlur = (e: FocusEvent<HTMLInputElement>) => {
        const normalized = normalizeInputUrl(e.currentTarget.value);
        form.setFieldValue('url', normalized);
        form.getInputProps('url').onBlur?.(e);

        if (!normalized) return;

        const defaultName = DEFAULT_NAMES[form.values.type as ServerType] ?? 'My Server';
        const isStillDefault =
            !form.values.name || Object.values(DEFAULT_NAMES).includes(form.values.name);
        if (!isStillDefault) return;

        try {
            const url = new URL(normalized);
            const hostname = url.hostname.replace(/^www\./, '');
            const isRawAddress =
                /^\d+(\.\d+){3}$/.test(hostname) || // IPv4
                hostname.startsWith('[') || // IPv6
                hostname === 'localhost';
            if (isRawAddress) {
                form.setFieldValue('name', defaultName);
            } else {
                const firstSegment = hostname.split('.')[0];
                form.setFieldValue('name', firstSegment || defaultName);
            }
        } catch {
            // invalid URL — leave name as-is
        }
    };

    const isSubmitDisabled =
        !form.values.name || !form.values.url || !form.values.username || !form.values.password;

    const fillServerDetails = (server: DiscoveredServerItem) => {
        form.setValues({ ...server });
    };

    const handleSubmit = form.onSubmit(async (values) => {
        if (serverLock && Object.keys(serverList).length >= 1) {
            toast.error({
                message: t('error.serverLockSingleServer'),
            });
            return;
        }

        const authFunction = api.controller.authenticate;

        if (!authFunction) {
            return toast.error({
                message: t('error.invalidServer'),
            });
        }

        try {
            setIsLoading(true);
            const data: AuthenticationResponse | undefined = await authFunction(
                values.url,
                {
                    legacy: values.legacyAuth,
                    password: values.password,
                    username: values.username,
                },
                values.type as ServerType,
            );

            if (!data) {
                return toast.error({
                    message: t('error.authenticationFailed'),
                });
            }

            const serverItem: ServerListItemWithCredential = {
                credential: data.credential,
                id: nanoid(),
                isAdmin: data.isAdmin,
                name: values.name,
                type: values.type as ServerType,
                url: values.url.replace(/\/$/, ''),
                userId: data.userId,
                username: data.username,
            };

            if (values.preferInstantMix !== undefined) {
                serverItem.preferInstantMix = values.preferInstantMix;
            }

            if (values.savePassword !== undefined) {
                serverItem.savePassword = values.savePassword;
            }

            if (values.remoteUrl?.trim()) {
                serverItem.remoteUrl = values.remoteUrl.trim().replace(/\/$/, '');
            }

            if (values.preferRemoteUrl !== undefined) {
                serverItem.preferRemoteUrl = values.preferRemoteUrl;
            }

            if (data.ndCredential !== undefined) {
                serverItem.ndCredential = data.ndCredential;
            }

            addServer(serverItem);
            setCurrentServer(serverItem);
            closeAllModals();

            toast.success({
                message: t('form.addServer.success'),
            });

            if (localSettings && values.savePassword) {
                const saved = await localSettings.passwordSet(values.password, serverItem.id);
                if (!saved) {
                    toast.error({
                        message: t('form.addServer.error', {
                            context: 'savePassword',
                        }),
                    });
                }
            }
        } catch (err: any) {
            setIsLoading(false);
            return toast.error({ message: err?.message });
        }

        return setIsLoading(false);
    });

    return (
        <>
            <Stack>
                {discovered.map((server) => (
                    <Paper key={server.url} p="10px">
                        <Group>
                            <img height="32" src={SERVER_TYPES[server.type].icon} width="32" />
                            <div
                                onClick={() => fillServerDetails(server)}
                                style={{ cursor: 'pointer' }}
                            >
                                <Text fw={700}>{server.name}</Text>
                                <Text>
                                    {SERVER_TYPES[server.type].name} server at {server.url}
                                </Text>
                            </div>
                        </Group>
                    </Paper>
                ))}
            </Stack>
            <form onSubmit={handleSubmit}>
                <Stack m={5} ref={focusTrapRef}>
                    <JellyfinFirstTypePicker
                        disabled={serverLock}
                        onChange={handleTypeSelect}
                        value={form.values.type as ServerType}
                    />
                    {isMobileShell ? (
                        // On phones the name/url side-by-side made both
                        // inputs uncomfortably narrow (especially since
                        // URL placeholders are long). Stack vertically.
                        <Stack gap="md">
                            <TextInput
                                data-autofocus
                                disabled={serverLock}
                                label={t('form.addServer.input', {
                                    context: 'name',
                                })}
                                required
                                {...form.getInputProps('name')}
                                {...mobileInputProps}
                            />
                            <TextInput
                                autoCapitalize="none"
                                autoComplete="url"
                                autoCorrect="off"
                                disabled={serverLock}
                                inputMode="url"
                                label={t('form.addServer.input', { context: 'url' })}
                                placeholder={URL_PLACEHOLDERS[form.values.type as ServerType]}
                                required
                                spellCheck={false}
                                {...form.getInputProps('url')}
                                {...mobileInputProps}
                                onBlur={handleUrlBlur}
                            />
                        </Stack>
                    ) : (
                        <Group grow>
                            <TextInput
                                data-autofocus
                                disabled={serverLock}
                                label={t('form.addServer.input', {
                                    context: 'name',
                                })}
                                required
                                {...form.getInputProps('name')}
                                {...mobileInputProps}
                            />
                            <TextInput
                                autoCapitalize="none"
                                autoComplete="url"
                                autoCorrect="off"
                                disabled={serverLock}
                                inputMode="url"
                                label={t('form.addServer.input', { context: 'url' })}
                                placeholder={URL_PLACEHOLDERS[form.values.type as ServerType]}
                                required
                                spellCheck={false}
                                {...form.getInputProps('url')}
                                {...mobileInputProps}
                                onBlur={handleUrlBlur}
                            />
                        </Group>
                    )}
                    <TextInput
                        disabled={serverLock}
                        label={t('form.addServer.input', {
                            context: 'remoteUrl',
                        })}
                        placeholder={t('form.addServer.input', {
                            context: 'remoteUrlPlaceholder',
                        })}
                        {...form.getInputProps('remoteUrl')}
                    />
                    {form.values.remoteUrl && (
                        <Checkbox
                            label={t('form.addServer.input', {
                                context: 'preferRemoteUrl',
                            })}
                            {...form.getInputProps('preferRemoteUrl', {
                                type: 'checkbox',
                            })}
                        />
                    )}
                    <TextInput
                        autoCapitalize="none"
                        autoComplete="username"
                        autoCorrect="off"
                        label={t('form.addServer.input', {
                            context: 'username',
                        })}
                        required
                        {...form.getInputProps('username')}
                        {...mobileInputProps}
                    />
                    <PasswordInput
                        autoComplete="current-password"
                        label={t('form.addServer.input', {
                            context: 'password',
                        })}
                        {...form.getInputProps('password')}
                        {...mobileInputProps}
                    />
                    {localSettings && form.values.type === ServerType.NAVIDROME && (
                        <Checkbox
                            label={t('form.addServer.input', {
                                context: 'savePassword',
                            })}
                            {...form.getInputProps('savePassword', {
                                type: 'checkbox',
                            })}
                        />
                    )}
                    {form.values.type === ServerType.SUBSONIC && (
                        <Checkbox
                            disabled={serverLock}
                            label={t('form.addServer.input', {
                                context: 'legacyAuthentication',
                            })}
                            {...form.getInputProps('legacyAuth', { type: 'checkbox' })}
                        />
                    )}
                    {form.values.type === ServerType.JELLYFIN && (
                        <Checkbox
                            description={t('form.addServer.input', {
                                context: 'preferInstantMixDescription',
                            })}
                            label={t('form.addServer.input', {
                                context: 'preferInstantMix',
                            })}
                            {...form.getInputProps('preferInstantMix', {
                                type: 'checkbox',
                            })}
                        />
                    )}
                    {isElectron() && (
                        <>
                            <Divider />
                            <IgnoreCorsSslSwitches />
                            <Divider />
                        </>
                    )}
                    <Group grow justify="flex-end">
                        {onCancel && (
                            <ModalButton onClick={onCancel}>{t('common.cancel')}</ModalButton>
                        )}
                        <ModalButton
                            disabled={isSubmitDisabled}
                            loading={isLoading}
                            type="submit"
                            variant="filled"
                        >
                            {t('common.add')}
                        </ModalButton>
                    </Group>
                </Stack>
            </form>
        </>
    );
};
