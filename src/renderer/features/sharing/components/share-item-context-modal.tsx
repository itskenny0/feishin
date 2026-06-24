import { closeModal, ContextModalProps } from '@mantine/modals';
import dayjs from 'dayjs';
import { useTranslation } from 'react-i18next';

import { useShareItem } from '/@/renderer/features/sharing/mutations/share-item-mutation';
import {
    isShareExpiryValid,
    toShareExpiryTimestamp,
} from '/@/renderer/features/sharing/utils/share-expiry';
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
                    // Empty expiry => "never expires" (mapped to 0). See
                    // share-expiry util.
                    expires: toShareExpiryTimestamp(values.expires),
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
