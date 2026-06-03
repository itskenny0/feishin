import { closeModal, ContextModalProps } from '@mantine/modals';
import dayjs from 'dayjs';
import { useTranslation } from 'react-i18next';

import { useShareItem } from '/@/renderer/features/sharing/mutations/share-item-mutation';
import { useIsMobileShell } from '/@/renderer/hooks/use-breakpoint';
import { useCurrentServer } from '/@/renderer/store';
import { getServerUrl } from '/@/renderer/utils/normalize-server-url';
import { DateTimePicker } from '/@/shared/components/date-time-picker/date-time-picker';
import { Group } from '/@/shared/components/group/group';
import { ModalButton } from '/@/shared/components/modal/model-shared';
import { Stack } from '/@/shared/components/stack/stack';
import { Switch } from '/@/shared/components/switch/switch';
import { Text } from '/@/shared/components/text/text';
import { Textarea } from '/@/shared/components/textarea/textarea';
import { toast } from '/@/shared/components/toast/toast';
import { useForm } from '/@/shared/hooks/use-form';

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

    const shareItemMutation = useShareItem({});
    const isCreating = shareItemMutation.isPending;

    // Uses the same default as Navidrome: 1 year
    const defaultDate = dayjs().add(1, 'year').format('YYYY-MM-DD HH:mm:ss');

    const form = useForm({
        initialValues: {
            allowDownloading: false,
            description: '',
            expires: defaultDate,
        },
        validate: {
            expires: (value) =>
                dayjs(value).isAfter(dayjs()) ? null : t('form.shareItem.expireInvalid'),
        },
    });

    // Hand the link off to the platform: native share sheet on mobile when
    // available, otherwise copy to clipboard. Returns whether the link ended up
    // on the clipboard so the success toast can tell the user where to look.
    const deliverShareUrl = async (shareUrl: string): Promise<boolean> => {
        const canUseNativeShare =
            isMobile && typeof navigator.share === 'function' && window.isSecureContext;

        if (canUseNativeShare) {
            try {
                await navigator.share({ url: shareUrl });
                return false;
            } catch {
                // User dismissed the sheet or the browser refused; fall through
                // to clipboard so they still walk away with the link.
            }
        }

        const canUseClipboard = Boolean(navigator.clipboard) && window.isSecureContext;
        if (canUseClipboard) {
            try {
                await navigator.clipboard.writeText(shareUrl);
                return true;
            } catch {
                return false;
            }
        }

        return false;
    };

    const handleSubmit = form.onSubmit((values) => {
        shareItemMutation.mutate(
            {
                apiClientProps: { serverId: server?.id || '' },
                body: {
                    description: values.description,
                    downloadable: values.allowDownloading,
                    expires: dayjs(values.expires).valueOf(),
                    resourceIds: itemIds.join(),
                    resourceType,
                },
            },
            {
                onError: () => {
                    // Keep the modal open so the user can adjust and retry
                    // instead of losing everything they typed.
                    toast.error({
                        message: t('form.shareItem.createFailed'),
                    });
                },
                onSuccess: async (_data) => {
                    if (!server || !_data?.id) {
                        toast.error({ message: t('form.shareItem.createFailed') });
                        return;
                    }

                    const serverUrl = getServerUrl(server, true);
                    if (!serverUrl) {
                        toast.error({ message: t('form.shareItem.createFailed') });
                        return;
                    }

                    const shareUrl = `${serverUrl}/share/${_data.id}`;
                    const copiedToClipboard = await deliverShareUrl(shareUrl);

                    closeModal(id);

                    toast.success({
                        autoClose: copiedToClipboard ? 5000 : 15000,
                        id: 'share-item-toast',
                        message: t(
                            copiedToClipboard
                                ? 'form.shareItem.success'
                                : 'form.shareItem.successMustClick',
                            {},
                        ),
                        onClick: (a) => {
                            if (!(a.target instanceof HTMLElement)) return;

                            // Make sure we weren't clicking close (otherwise clicking close /also/ opens the url)
                            if (a.target.nodeName !== 'svg') {
                                window.open(shareUrl, '_blank', 'noopener,noreferrer');
                                toast.hide('share-item-toast');
                            }
                        },
                    });
                },
            },
        );
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
                <DateTimePicker
                    clearable
                    description={t('form.shareItem.setExpirationDescription', {
                        defaultValue: 'Leave empty for a link that never expires.',
                    })}
                    disabled={isCreating}
                    label={t('form.shareItem.setExpiration')}
                    minDate={new Date()}
                    placeholder={defaultDate}
                    popoverProps={{ withinPortal: true }}
                    valueFormat="MM/DD/YYYY HH:mm"
                    {...form.getInputProps('expires')}
                />
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
