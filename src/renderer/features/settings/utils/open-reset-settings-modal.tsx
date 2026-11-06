import { closeAllModals, openModal } from '@mantine/modals';
import { t } from 'i18next';

import { useSettingsStore } from '/@/renderer/store/settings.store';
import { ConfirmModal } from '/@/shared/components/modal/modal';
import { Text } from '/@/shared/components/text/text';

/** Confirm, then restore every setting to its default. */
export const openResetSettingsModal = () =>
    openModal({
        children: (
            <ConfirmModal
                onConfirm={() => {
                    useSettingsStore.getState().actions.reset();
                    closeAllModals();
                }}
            >
                <Text>{t('common.areYouSure')}</Text>
            </ConfirmModal>
        ),
        title: t('common.resetToDefault'),
    });
