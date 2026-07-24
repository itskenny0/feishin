import { closeAllModals, openModal } from '@mantine/modals';
import { useTranslation } from 'react-i18next';

import { UpdateAvailableButton } from '/@/renderer/features/settings/components/update-available-button';
import { useSettingSearchContext } from '/@/renderer/features/settings/context/search-context';
import { LibraryHeaderBar } from '/@/renderer/features/shared/components/library-header-bar';
import { SearchInput } from '/@/renderer/features/shared/components/search-input';
import { useIsMobileShell, useIsTouch } from '/@/renderer/hooks/use-breakpoint';
import { useMobileDrawer } from '/@/renderer/store';
import { useSettingsStoreActions } from '/@/renderer/store/settings.store';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Button } from '/@/shared/components/button/button';
import { Flex } from '/@/shared/components/flex/flex';
import { Group } from '/@/shared/components/group/group';
import { Icon } from '/@/shared/components/icon/icon';
import { ConfirmModal } from '/@/shared/components/modal/modal';
import { Text } from '/@/shared/components/text/text';

export type SettingsHeaderProps = {
    setSearch: (search: string) => void;
    showUpdateAvailable?: boolean;
};

export const SettingsHeader = ({ setSearch, showUpdateAvailable }: SettingsHeaderProps) => {
    const { t } = useTranslation();
    const { reset } = useSettingsStoreActions();
    const search = useSettingSearchContext();
    /*
     * Touch devices: skip the search input's autofocus. Auto-focus
     * pops the on-screen keyboard the instant Settings opens, which
     * (a) covers half the viewport before the user sees any settings,
     * and (b) is unwanted 90% of the time — most users land in
     * Settings to flip a known switch, not to search. Mouse users
     * still get autofocus so cmd-K-style "open + type immediately"
     * flow stays intact.
     */
    const isTouch = useIsTouch();
    const isMobileShell = useIsMobileShell();
    const { open: openDrawer } = useMobileDrawer();

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

    /*
     * Mobile shell rendering: the title + search + reset button were
     * laid out as a single Flex row that overflowed the viewport on
     * phones — the SearchInput floated off into the right margin and
     * the "Reset to default" button wrapped onto a second visual line
     * that the user couldn't reach. On mobile the search and reset
     * are reachable from the drill-down section UI (Search affordance
     * is inside each section via the existing collapsible search
     * filter; Reset is a footer button at the very end of the General
     * tab), so dropping them from the header cleans up the layout
     * dramatically.
     */
    if (isMobileShell) {
        return (
            <Flex align="center" justify="space-between" w="100%">
                <LibraryHeaderBar>
                    <Group wrap="nowrap">
                        <Icon icon="settings" size="2xl" />
                        <LibraryHeaderBar.Title>
                            {t('common.setting', { count: 2 })}
                        </LibraryHeaderBar.Title>
                    </Group>
                </LibraryHeaderBar>
                {/* The "More" drawer moved off the bottom tab bar; surface it
                    here so it's still reachable (servers, about, etc). */}
                <ActionIcon
                    aria-label={t('common.menu', { defaultValue: 'Menu' })}
                    icon="menu"
                    iconProps={{ size: 'lg' }}
                    onClick={openDrawer}
                    tooltip={{
                        label: t('common.menu', { defaultValue: 'Menu' }),
                        openDelay: 400,
                    }}
                    variant="subtle"
                />
            </Flex>
        );
    }

    return (
        <Flex>
            <LibraryHeaderBar>
                <Flex align="center" justify="space-between" w="100%">
                    <Group wrap="nowrap">
                        <Icon icon="settings" size="5xl" />
                        <LibraryHeaderBar.Title>
                            {t('common.setting', { count: 2 })}
                        </LibraryHeaderBar.Title>
                    </Group>
                    <Group>
                        {showUpdateAvailable && <UpdateAvailableButton />}
                        <SearchInput
                            autoFocus={!isTouch}
                            defaultValue={search}
                            onChange={(event) => setSearch(event.target.value.toLocaleLowerCase())}
                        />
                        <Button onClick={openResetConfirmModal} variant="default">
                            {t('common.resetToDefault')}
                        </Button>
                    </Group>
                </Flex>
            </LibraryHeaderBar>
        </Flex>
    );
};
