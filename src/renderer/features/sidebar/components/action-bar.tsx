import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import styles from './action-bar.module.css';

import { AppMenu } from '/@/renderer/features/titlebar/components/app-menu';
import { useCommandPalette } from '/@/renderer/store';
import { Button } from '/@/shared/components/button/button';
import { DropdownMenu } from '/@/shared/components/dropdown-menu/dropdown-menu';
import { Grid } from '/@/shared/components/grid/grid';
import { Group } from '/@/shared/components/group/group';
import { Icon } from '/@/shared/components/icon/icon';
import { Kbd } from '/@/shared/components/kbd/kbd';
import { TextInput } from '/@/shared/components/text-input/text-input';

export const ActionBar = () => {
    const { t } = useTranslation();
    const { open } = useCommandPalette();

    return (
        <div className={styles.container}>
            <Grid
                display="flex"
                gap="sm"
                styles={{
                    inner: {
                        width: '100%',
                    },
                    root: {
                        padding: '0 var(--theme-spacing-md',
                        width: '100%',
                    },
                }}
            >
                <Grid.Col span={7}>
                    <TextInput
                        aria-label={t('common.search')}
                        leftSection={<Icon icon="search" />}
                        onClick={open}
                        // Open the palette on any printable key OR Enter/Space.
                        // (Previously only Enter/Space worked, so a user
                        // typing into the search box saw their first
                        // keystroke vanish.) The first keystroke is still
                        // lost — the palette doesn't accept a seeded query
                        // — but at least the palette opens immediately and
                        // accepts the rest of the typed string.
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ' || e.key.length === 1) {
                                open();
                            }
                        }}
                        placeholder={t('common.search')}
                        readOnly
                        // Permanent hint so users discover the command-
                        // palette shortcut without trawling the settings.
                        // "Mod+K" matches the hotkey string Mantine /
                        // mousetrap uses internally (mod = Ctrl on
                        // Windows/Linux, ⌘ on macOS).
                        rightSection={<Kbd size="xs">Mod+K</Kbd>}
                        rightSectionWidth={70}
                    />
                </Grid.Col>
                <Grid.Col span={5}>
                    <Group gap="sm" grow wrap="nowrap">
                        <DropdownMenu position="bottom-start">
                            <DropdownMenu.Target>
                                <Button
                                    aria-label={t('common.menu')}
                                    className={styles.actionBarButton}
                                    p="0"
                                >
                                    <Icon icon="menu" size="lg" />
                                </Button>
                            </DropdownMenu.Target>
                            <DropdownMenu.Dropdown>
                                <AppMenu />
                            </DropdownMenu.Dropdown>
                        </DropdownMenu>
                        <NavigateButtons />
                    </Group>
                </Grid.Col>
            </Grid>
        </div>
    );
};

const NavigateButtons = () => {
    const { t } = useTranslation();
    const navigate = useNavigate();

    return (
        <>
            <Button
                aria-label={t('common.back', { defaultValue: 'Back' })}
                className={styles.actionBarButton}
                onClick={() => navigate(-1)}
                p="0"
            >
                <Icon icon="arrowLeftS" size="lg" />
            </Button>
            <Button
                aria-label={t('common.forward', { defaultValue: 'Forward' })}
                className={styles.actionBarButton}
                onClick={() => navigate(1)}
                p="0"
            >
                <Icon icon="arrowRightS" size="lg" />
            </Button>
        </>
    );
};
