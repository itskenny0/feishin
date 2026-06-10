import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import i18n from '/@/i18n/i18n';
import { SettingsOptions } from '/@/renderer/features/settings/components/settings-option';
import { useGeneralSettings, useSettingsStoreActions } from '/@/renderer/store';
import { Button } from '/@/shared/components/button/button';
import { NumberInput } from '/@/shared/components/number-input/number-input';
import { Table } from '/@/shared/components/table/table';
import { Text } from '/@/shared/components/text/text';

const options = [
    {
        label: i18n.t('setting.imageResolution_optionTable'),
        value: 'table',
    },
    {
        label: i18n.t('setting.imageResolution_optionItemCard'),
        value: 'itemCard',
    },
    {
        label: i18n.t('setting.imageResolution_optionSidebar'),
        value: 'sidebar',
    },
    {
        label: i18n.t('setting.imageResolution_optionHeader'),
        value: 'header',
    },
    {
        label: i18n.t('setting.imageResolution_optionFullScreenPlayer'),
        value: 'fullScreenPlayer',
    },
];

interface ImageResolutionSettingsProps {
    /**
     * When true the per-surface table is shown directly with no Edit/Close
     * toggle. The dedicated drill-down subpage passes this; the legacy inline
     * usage keeps the collapsible toggle so it doesn't bloat the page.
     */
    alwaysOpen?: boolean;
}

export const ImageResolutionSettings = memo(
    ({ alwaysOpen = false }: ImageResolutionSettingsProps) => {
        const { t } = useTranslation();
        const { setSettings } = useSettingsStoreActions();
        const settings = useGeneralSettings();

        const [open, setOpen] = useState(false);
        const showTable = alwaysOpen || open;

        const descriptionText = t('setting.imageResolution', {
            context: 'description',
        });

        const titleText = t('setting.imageResolution');

        return (
            <>
                <SettingsOptions
                    control={
                        alwaysOpen ? null : (
                            <Button
                                onClick={() => setOpen(!open)}
                                size="compact-md"
                                variant={open ? 'subtle' : 'filled'}
                            >
                                {t(open ? 'common.close' : 'common.edit')}
                            </Button>
                        )
                    }
                    description={descriptionText}
                    title={titleText}
                />
                {showTable && (
                    <Table withRowBorders={false}>
                        <Table.Tbody>
                            {options.map((option) => (
                                <Table.Tr key={option.value}>
                                    <Table.Th key={option.value}>
                                        <Text>{option.label}</Text>
                                    </Table.Th>
                                    <Table.Td align="right" key={option.value}>
                                        <NumberInput
                                            max={2000}
                                            min={0}
                                            onChange={(e) => {
                                                if (typeof e !== 'number') return;

                                                setSettings({
                                                    general: {
                                                        ...settings,
                                                        imageRes: {
                                                            ...settings.imageRes,
                                                            [option.value]: e,
                                                        },
                                                    },
                                                });
                                            }}
                                            rightSection={
                                                <Text isMuted isNoSelect pr="lg" size="sm">
                                                    px
                                                </Text>
                                            }
                                            value={settings.imageRes[option.value]}
                                            width={90}
                                        />
                                    </Table.Td>
                                </Table.Tr>
                            ))}
                        </Table.Tbody>
                    </Table>
                )}
            </>
        );
    },
);

ImageResolutionSettings.displayName = 'ImageResolutionSettings';

/**
 * Dedicated drill-down subpage variant — renders the per-surface resolution
 * table directly (no Edit toggle) since the whole subpage is about cover-art
 * quality.
 */
export const ImageResolutionSubpage = memo(() => <ImageResolutionSettings alwaysOpen />);

ImageResolutionSubpage.displayName = 'ImageResolutionSubpage';
