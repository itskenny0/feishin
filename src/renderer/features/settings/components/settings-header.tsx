import { useTranslation } from 'react-i18next';

import { PageHeader } from '/@/renderer/components/page-header/page-header';
import { UpdateAvailableButton } from '/@/renderer/features/settings/components/update-available-button';
import { useSettingSearchStore } from '/@/renderer/features/settings/store/search.store';
import { openResetSettingsModal } from '/@/renderer/features/settings/utils/open-reset-settings-modal';
import { LibraryHeaderBar } from '/@/renderer/features/shared/components/library-header-bar';
import { SearchInput } from '/@/renderer/features/shared/components/search-input';
import { useIsMobileShell, useIsTouch } from '/@/renderer/hooks/use-breakpoint';
import { useMobileDrawer } from '/@/renderer/store';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Button } from '/@/shared/components/button/button';
import { Flex } from '/@/shared/components/flex/flex';
import { Group } from '/@/shared/components/group/group';
import { Icon } from '/@/shared/components/icon/icon';

export type SettingsHeaderProps = {
    showUpdateAvailable?: boolean;
};

export const SettingsHeader = ({ showUpdateAvailable }: SettingsHeaderProps) => {
    const { t } = useTranslation();
    const { search, setSearch } = useSettingSearchStore();
    /*
     * Touch devices: skip the search input's autofocus. Auto-focus
     * pops the on-screen keyboard the instant Settings opens, which
     * (a) covers half the viewport before the user sees any settings,
     * and (b) is unwanted most of the time - most users land in
     * Settings to flip a known switch, not to search. Mouse users
     * still get autofocus so cmd-K-style "open + type immediately"
     * flow stays intact.
     */
    const isTouch = useIsTouch();
    const isMobileShell = useIsMobileShell();
    const { open: openDrawer } = useMobileDrawer();

    /*
     * Mobile shell: the title + search + reset row overflowed the viewport
     * on phones. Search lives in the category list (settings-layout) and
     * Reset under Advanced > Backup, so the header drops both there.
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
        <PageHeader>
            <LibraryHeaderBar>
                <Flex align="center" justify="space-between" w="100%">
                    <LibraryHeaderBar.Title>
                        {t('common.setting', { count: 2 })}
                    </LibraryHeaderBar.Title>
                    <Group pr="2rem">
                        {showUpdateAvailable && <UpdateAvailableButton />}
                        <SearchInput
                            autoFocus={!isTouch}
                            defaultValue={search}
                            onChange={(event) => setSearch(event.target.value.toLocaleLowerCase())}
                        />
                        <Button onClick={openResetSettingsModal} variant="default">
                            {t('common.resetToDefault')}
                        </Button>
                    </Group>
                </Flex>
            </LibraryHeaderBar>
        </PageHeader>
    );
};
