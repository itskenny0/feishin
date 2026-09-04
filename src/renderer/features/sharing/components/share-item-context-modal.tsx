import { closeModal, ContextModalProps } from '@mantine/modals';
import dayjs, { type ManipulateType } from 'dayjs';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useShareItem } from '/@/renderer/features/sharing/mutations/share-item-mutation';
import { isShareExpiryValid } from '/@/renderer/features/sharing/utils/share-expiry';
import { useIsMobileShell } from '/@/renderer/hooks/use-breakpoint';
import { useCurrentServer, useGeneralSettings } from '/@/renderer/store';
import {
    type SettingsState,
    ShareExpirationUnit,
    useSettingsStoreActions,
} from '/@/renderer/store/settings.store';
import { getServerUrl } from '/@/renderer/utils/normalize-server-url';
import { Accordion } from '/@/shared/components/accordion/accordion';
import { Button } from '/@/shared/components/button/button';
import { DateTimePicker } from '/@/shared/components/date-time-picker/date-time-picker';
import { Group } from '/@/shared/components/group/group';
import { ModalButton } from '/@/shared/components/modal/model-shared';
import { NumberInput } from '/@/shared/components/number-input/number-input';
import { Select } from '/@/shared/components/select/select';
import { Stack } from '/@/shared/components/stack/stack';
import { Switch } from '/@/shared/components/switch/switch';
import { Text } from '/@/shared/components/text/text';
import { Textarea } from '/@/shared/components/textarea/textarea';
import { toast } from '/@/shared/components/toast/toast';
import { useForm } from '/@/shared/hooks/use-form';

const EXPIRES_FORMAT = 'YYYY-MM-DD HH:mm:ss';

const unitToDayjs: Record<ShareExpirationUnit, ManipulateType> = {
    [ShareExpirationUnit.DAY]: 'day',
    [ShareExpirationUnit.HOUR]: 'hour',
    [ShareExpirationUnit.MINUTE]: 'minute',
    [ShareExpirationUnit.MONTH]: 'month',
    [ShareExpirationUnit.SECOND]: 'second',
    [ShareExpirationUnit.WEEK]: 'week',
    [ShareExpirationUnit.YEAR]: 'year',
};

type ShareExpirationSettings = SettingsState['general']['shareExpiration'];
const getShareExpirationDate = (settings: ShareExpirationSettings): null | string => {
    if (settings.useServerDefault) {
        return null;
    }

    const amount = Math.max(1, Math.floor(settings.amount) || 1);
    return dayjs().add(amount, unitToDayjs[settings.unit]).format(EXPIRES_FORMAT);
};

const addExpiration = (amount: number, unit: ManipulateType): string =>
    dayjs().add(amount, unit).format(EXPIRES_FORMAT);

export const ShareItemContextModal = ({
    id,
    innerProps,
}: ContextModalProps<{
    itemIds: string[];
    resourceType: string;
}>) => {
    const { t } = useTranslation();
    const { itemIds, resourceType } = innerProps;
    const server = useCurrentServer();
    const isMobile = useIsMobileShell();
    const { setSettings } = useSettingsStoreActions();

    const shareItemMutation = useShareItem({});
    const isCreating = shareItemMutation.isPending;

    const { shareExpiration } = useGeneralSettings();
    const defaultDate = getShareExpirationDate(shareExpiration);

    const form = useForm({
        initialValues: {
            allowDownloading: false,
            description: '',
            expires: defaultDate,
        },
        validate: {
            // An empty value is intentional: it means "never expires" (the
            // picker is clearable and its description advertises this). Only
            // reject a value that is present *and* not in the future.
            expires: (value) =>
                isShareExpiryValid(value) ? null : t('form.shareItem.expireInvalid'),
        },
    });

    // Hand the link off to the platform via the native share sheet (mobile).
    // Returns true if the sheet successfully accepted the link. Clipboard
    // delivery on desktop is handled separately below so it can run inside the
    // click's user activation (see the activation comment in handleSubmit).
    const shareViaNativeSheet = async (shareUrl: string): Promise<boolean> => {
        const canUseNativeShare =
            isMobile && typeof navigator.share === 'function' && window.isSecureContext;

        if (canUseNativeShare) {
            try {
                await navigator.share({ url: shareUrl });
                return true;
            } catch {
                // User dismissed the sheet or the browser refused; fall through
                // so they still walk away with the link via the toast/clipboard.
            }
        }

        return false;
    };

    const unitOptions = useMemo(
        () => [
            {
                label: t('datetime.secondLong'),
                value: ShareExpirationUnit.SECOND,
            },
            {
                label: t('datetime.minuteLong'),
                value: ShareExpirationUnit.MINUTE,
            },
            {
                label: t('datetime.hourLong'),
                value: ShareExpirationUnit.HOUR,
            },
            {
                label: t('datetime.dayLong'),
                value: ShareExpirationUnit.DAY,
            },
            {
                label: t('datetime.weekLong'),
                value: ShareExpirationUnit.WEEK,
            },
            {
                label: t('datetime.monthLong'),
                value: ShareExpirationUnit.MONTH,
            },
            {
                label: t('datetime.yearLong'),
                value: ShareExpirationUnit.YEAR,
            },
        ],
        [t],
    );

    const expirationPresets = useMemo(
        () => [
            {
                getValue: (): null | string => null,
                label: t('form.shareItem.setExpiration', { context: 'serverDefault' }),
            },
            {
                getValue: (): null | string => addExpiration(1, 'day'),
                label: `1 ${t('datetime.dayLong')}`,
            },
            {
                getValue: (): null | string => addExpiration(1, 'week'),
                label: `1 ${t('datetime.weekLong')}`,
            },
            {
                getValue: (): null | string => addExpiration(1, 'month'),
                label: `1 ${t('datetime.monthLong')}`,
            },
            {
                getValue: (): null | string => addExpiration(1, 'year'),
                label: `1 ${t('datetime.yearLong')}`,
            },
        ],
        [t],
    );

    const updateShareExpiration = (updates: Partial<ShareExpirationSettings>) => {
        const next = { ...shareExpiration, ...updates };
        setSettings({
            general: {
                shareExpiration: next,
            },
        });
        form.setFieldValue('expires', getShareExpirationDate(next));
    };

    const handleSubmit = form.onSubmit(async (values) => {
        // Prefer the native share sheet on mobile; only fall back to the
        // clipboard path when native share isn't available. Computed
        // synchronously so the clipboard write below stays inside the gesture.
        const preferNativeShare =
            isMobile && typeof navigator.share === 'function' && window.isSecureContext;
        const canUseClipboard =
            !preferNativeShare && Boolean(navigator.clipboard) && window.isSecureContext;

        // The share URL only exists once the create request resolves. Calling
        // navigator.clipboard.writeText() from that async callback runs outside
        // the click's user activation, so Firefox/Safari reject it ("Clipboard
        // write was blocked due to lack of user activation") and nothing is
        // copied. Instead, call clipboard.write() synchronously within this
        // gesture with a ClipboardItem whose value is a promise that resolves to
        // the URL — this preserves the activation while the share is created.
        // Falls back to writeText, then to the "click to open" toast.
        const shareUrlPromise = shareItemMutation
            .mutateAsync({
                apiClientProps: { serverId: server?.id || '' },
                body: {
                    description: values.description,
                    downloadable: values.allowDownloading,
                    // An empty expiry means "use the server default" — omit the
                    // field entirely rather than sending a falsy timestamp.
                    ...(values.expires ? { expires: dayjs(values.expires).valueOf() } : {}),
                    resourceIds: itemIds.join(),
                    resourceType,
                },
            })
            .then((data) => {
                if (!server) throw new Error('Server not found');
                if (!data?.id) throw new Error('Failed to share item');

                const serverUrl = getServerUrl(server, true);
                if (!serverUrl) throw new Error('Server URL not found');
                return `${serverUrl}/share/${data.id}`;
            });

        let copied = false;
        if (canUseClipboard) {
            try {
                if (typeof ClipboardItem !== 'undefined') {
                    await navigator.clipboard.write([
                        new ClipboardItem({
                            'text/plain': shareUrlPromise.then(
                                (url) => new Blob([url], { type: 'text/plain' }),
                            ),
                        }),
                    ]);
                } else {
                    await navigator.clipboard.writeText(await shareUrlPromise);
                }
                copied = true;
            } catch {
                copied = false;
            }
        }

        let shareUrl: string;
        try {
            shareUrl = await shareUrlPromise;
        } catch {
            // Keep the modal open so the user can adjust and retry instead of
            // losing everything they typed.
            toast.error({
                message: t('form.shareItem.createFailed'),
            });
            return;
        }

        // On mobile, hand the resolved link to the native share sheet. If the
        // user accepts it there the link is delivered just like a clipboard
        // copy, so reuse the "success" (not "must click") toast.
        const sharedViaSheet = preferNativeShare ? await shareViaNativeSheet(shareUrl) : false;
        const delivered = copied || sharedViaSheet;

        toast.success({
            autoClose: delivered ? 5000 : 15000,
            id: 'share-item-toast',
            message: t(
                delivered ? 'form.shareItem.success' : 'form.shareItem.successMustClick',
                {},
            ),
            onClick: (a) => {
                if (!(a.target instanceof HTMLElement)) return;

                // Make sure we weren't clicking close (otherwise clicking close /also/ opens the url)
                if (a.target.nodeName !== 'svg') {
                    window.open(shareUrl);
                    toast.hide('share-item-toast');
                }
            },
        });

        closeModal(id);
    });

    return (
        <form onSubmit={handleSubmit}>
            <Stack>
                <Text isMuted size="sm">
                    {t('form.shareItem.intro', {
                        defaultValue:
                            'Create a public link that anyone can open, even without an account.',
                    })}
                </Text>
                <Stack gap="xs">
                    <DateTimePicker
                        clearable
                        description={t('form.shareItem.setExpiration', { context: 'description' })}
                        label={t('form.shareItem.setExpiration')}
                        minDate={new Date()}
                        placeholder={
                            defaultDate ??
                            t('form.shareItem.setExpiration', { context: 'serverDefault' })
                        }
                        popoverProps={{ withinPortal: true }}
                        valueFormat="MM/DD/YYYY HH:mm"
                        {...form.getInputProps('expires')}
                    />
                    <Group gap="xs" wrap="wrap">
                        {expirationPresets.map((preset) => (
                            <Button
                                key={preset.label}
                                onClick={() => {
                                    form.setFieldValue('expires', preset.getValue());
                                }}
                                size="compact-xs"
                                type="button"
                                variant="default"
                            >
                                {preset.label}
                            </Button>
                        ))}
                    </Group>
                </Stack>
                <Accordion variant="separated">
                    <Accordion.Item value="share-expiration-defaults">
                        <Accordion.Control>
                            <Text>{t('setting.shareExpiration')}</Text>
                        </Accordion.Control>
                        <Accordion.Panel>
                            <Stack gap="md">
                                <Switch
                                    checked={shareExpiration.useServerDefault}
                                    description={t('setting.shareExpirationUseServerDefault', {
                                        context: 'description',
                                    })}
                                    label={t('setting.shareExpirationUseServerDefault')}
                                    onChange={(e) => {
                                        updateShareExpiration({
                                            useServerDefault: e.currentTarget.checked,
                                        });
                                    }}
                                />
                                {!shareExpiration.useServerDefault && (
                                    <Stack gap="xs">
                                        <Text size="sm">{t('setting.shareExpiration')}</Text>
                                        <Text c="dimmed" size="xs">
                                            {t('setting.shareExpiration', {
                                                context: 'description',
                                            })}
                                        </Text>
                                        <Group gap="xs" wrap="nowrap">
                                            <NumberInput
                                                min={1}
                                                onBlur={(e) => {
                                                    const amount = Math.max(
                                                        1,
                                                        Math.floor(Number(e.currentTarget.value)) ||
                                                            1,
                                                    );
                                                    updateShareExpiration({ amount });
                                                }}
                                                value={shareExpiration.amount}
                                                width={90}
                                            />
                                            <Select
                                                data={unitOptions}
                                                onChange={(value) => {
                                                    if (!value) return;
                                                    updateShareExpiration({
                                                        unit: value as ShareExpirationUnit,
                                                    });
                                                }}
                                                value={shareExpiration.unit}
                                                w={120}
                                            />
                                        </Group>
                                    </Stack>
                                )}
                            </Stack>
                        </Accordion.Panel>
                    </Accordion.Item>
                </Accordion>
                <Textarea
                    autosize
                    description={t('form.shareItem.descriptionPlaceholder', {
                        defaultValue: 'Optional note shown on the share page',
                    })}
                    disabled={isCreating}
                    label={t('form.shareItem.description')}
                    minRows={isMobile ? 3 : 5}
                    {...form.getInputProps('description')}
                />
                <Switch
                    defaultChecked={false}
                    description={t('form.shareItem.allowDownloadingDescription', {
                        defaultValue:
                            'Let people download the original files, not just stream them.',
                    })}
                    disabled={isCreating}
                    label={t('form.shareItem.allowDownloading')}
                    {...form.getInputProps('allowDownloading')}
                />

                <Group justify="flex-end">
                    <ModalButton disabled={isCreating} onClick={() => closeModal(id)}>
                        {t('common.cancel')}
                    </ModalButton>
                    <ModalButton loading={isCreating} type="submit" variant="filled">
                        {t('common.share')}
                    </ModalButton>
                </Group>
            </Stack>
        </form>
    );
};
