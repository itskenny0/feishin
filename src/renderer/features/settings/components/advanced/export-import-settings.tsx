import { closeAllModals, openModal } from '@mantine/modals';
import { t } from 'i18next';
import { memo, useCallback } from 'react';

import { ExportImportSettingsModal } from '/@/renderer/components/export-import-settings-modal/export-import-settings-modal';
import {
    SettingOption,
    SettingsSection,
} from '/@/renderer/features/settings/components/settings-section';
import { useSettingsForExport, useSettingsStoreActions } from '/@/renderer/store';
import { Button } from '/@/shared/components/button/button';
import { ConfirmModal } from '/@/shared/components/modal/modal';
import { Text } from '/@/shared/components/text/text';

export const ExportImportSettings = memo(() => {
    const settingForExport = useSettingsForExport();
    const { reset } = useSettingsStoreActions();

    const onExportSettings = useCallback(() => {
        const settingsFile = new File([JSON.stringify(settingForExport)], 'feishin-settings.json', {
            type: 'application/json',
        });

        const settingsFileLink = document.createElement('a');
        const settingsFilesUrl = URL.createObjectURL(settingsFile);
        settingsFileLink.href = settingsFilesUrl;
        settingsFileLink.download = settingsFile.name;
        settingsFileLink.click();

        URL.revokeObjectURL(settingsFilesUrl);
    }, [settingForExport]);

    const openImportModal = () => {
        openModal({
            children: <ExportImportSettingsModal />,
            size: 'lg',
            title: t('setting.exportImportSettings_importModalTitle'),
        });
    };

    const handleResetToDefault = () => {
        reset();
        closeAllModals();
    };

    const openResetConfirmModal = () => {
        openModal({
            children: (
                <ConfirmModal onConfirm={handleResetToDefault}>
                    <Text>{t('common.areYouSure')}</Text>
                </ConfirmModal>
            ),
            title: t('common.resetToDefault'),
        });
    };

    const options: SettingOption[] = [
        {
            control: (
                <>
                    <Button onClick={onExportSettings} size="compact-sm">
                        {t('setting.exportImportSettings_control_exportText')}
                    </Button>
                    <Button onClick={openImportModal} size="compact-sm">
                        {t('setting.exportImportSettings_control_importText')}
                    </Button>
                </>
            ),
            description: t('setting.exportImportSettings_control_description'),
            title: t('setting.exportImportSettings_control_title'),
        },
        {
            control: (
                <Button onClick={openResetConfirmModal} size="compact-sm" variant="default">
                    {t('common.resetToDefault')}
                </Button>
            ),
            description: t('setting.resetToDefault', {
                context: 'description',
                defaultValue: 'Clear all saved settings and restore the defaults.',
            }),
            title: t('common.resetToDefault'),
        },
    ];

    return <SettingsSection options={options} title={t('page.setting.exportImport')} />;
});
