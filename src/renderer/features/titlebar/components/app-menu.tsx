import { openContextModal, openModal } from '@mantine/modals';
import isElectron from 'is-electron';
import { Fragment, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';

import packageJson from '../../../../../package.json';
import styles from './app-menu.module.css';

import { isServerLock } from '/@/renderer/features/action-required/utils/window-properties';
import { ServerList } from '/@/renderer/features/servers/components/server-list';
import { openSettingsModal } from '/@/renderer/features/settings/utils/open-settings-modal';
import { ServerSelector } from '/@/renderer/features/sidebar/components/server-selector';
import { useGithubReleasesUpdaterControls } from '/@/renderer/hooks/use-github-releases-updater';
import { openReleaseNotesModal } from '/@/renderer/release-notes-modal';
import {
    useAppStore,
    useAppStoreActions,
    useCommandPalette,
    useCurrentServer,
    useGeneralSettings,
    useSettingsStoreActions,
} from '/@/renderer/store';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { DropdownMenu, MenuItemProps } from '/@/shared/components/dropdown-menu/dropdown-menu';
import { Group } from '/@/shared/components/group/group';
import { Icon } from '/@/shared/components/icon/icon';
import { toast } from '/@/shared/components/toast/toast';
import { ServerType } from '/@/shared/types/types';

const browser = isElectron() ? window.api.browser : null;

interface BaseMenuItem {
    id: string;
    type: 'conditional-group' | 'conditional-item' | 'custom' | 'divider' | 'item';
}

interface ConditionalGroupItem extends BaseMenuItem {
    condition: boolean;
    items: MenuItem[];
    type: 'conditional-group';
}

interface ConditionalItem extends BaseMenuItem {
    condition: boolean;
    item: Omit<MenuItem, 'id' | 'type'>;
    type: 'conditional-item';
}

interface CustomItem extends BaseMenuItem {
    component: ReactNode;
    type: 'custom';
}

interface DividerItem extends BaseMenuItem {
    type: 'divider';
}

type MenuItem = ConditionalGroupItem | ConditionalItem | CustomItem | DividerItem | RegularMenuItem;

interface RegularMenuItem extends BaseMenuItem {
    component?: 'a' | typeof Link;
    href?: string;
    icon?: keyof typeof import('/@/shared/components/icon/icon').AppIcon;
    iconColor?:
        | 'contrast'
        | 'default'
        | 'error'
        | 'info'
        | 'inherit'
        | 'muted'
        | 'primary'
        | 'success'
        | 'warn';
    label: string;
    leftSection?: ReactNode;
    onClick?: () => void;
    rightSection?: ReactNode;
    target?: string;
    to?: string;
    type: 'item';
}

export const AppMenu = () => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const collapsed = useAppStore((state) => state.sidebar.collapsed);
    const privateMode = useAppStore((state) => state.privateMode);
    const { setPrivateMode, setSideBar } = useAppStoreActions();
    const { setSettings } = useSettingsStoreActions();
    const settings = useGeneralSettings();
    const currentServer = useCurrentServer();
    const { open: openCommandPalette } = useCommandPalette();
    const { checkNow: checkForUpdatesNow, installLatest } = useGithubReleasesUpdaterControls();

    const handleBrowserDevTools = () => {
        browser?.devtools();
    };

    const handleCollapseSidebar = () => {
        setSideBar({ collapsed: true });
    };

    const handleExpandSidebar = () => {
        setSideBar({ collapsed: false });
    };

    const handlePrivateModeOff = () => {
        setPrivateMode(false);
        toast.info({
            message: t('form.privateMode.disabled'),
            title: t('form.privateMode.title'),
        });
    };

    const handlePrivateModeOn = () => {
        setPrivateMode(true);
        toast.info({
            message: t('form.privateMode.enabled'),
            title: t('form.privateMode.title'),
        });
    };

    const handleManageServersModal = () => {
        openModal({
            children: <ServerList />,
            title: t('page.manageServers.title'),
        });
    };

    const handleQuit = () => {
        browser?.quit();
    };

    const handleSetSideQueueLayout = (sideQueueLayout: 'horizontal' | 'vertical') => {
        setSettings({
            general: {
                ...settings,
                sideQueueLayout,
            },
        });
    };

    const serverHeaderMenuItems: MenuItem[] = currentServer
        ? [
              {
                  component: (
                      <div className={styles.serverSelector}>
                          <ServerSelector />
                      </div>
                  ),
                  id: 'server-selector',
                  type: 'custom',
              },
              {
                  id: 'divider-server',
                  type: 'divider',
              },
          ]
        : [];

    // Menu is grouped into at most four sections with dividers between them.
    // Conditional groups gate their own divider so we never emit a ghost
    // divider when every item in the group is hidden.
    //
    //   Group 1: Server (header + selector)        - shown only when a server is selected
    //   Group 2: Library actions                   - palette + jellyfin migration + manage servers
    //   Group 3: Window / sidebar (collapsed only) - back/forward + expand sidebar
    //   Group 4: App                               - settings, private mode, version, devtools, quit, layout
    //
    // Group 1's leading divider is folded into `serverHeaderMenuItems` above,
    // so we only emit three more dividers here.

    const libraryActionItems: MenuItem[] = [
        {
            icon: 'search',
            id: 'command-palette',
            label: t('page.appMenu.commandPalette'),
            onClick: openCommandPalette,
            type: 'item',
        },
        {
            condition: currentServer?.type === ServerType.JELLYFIN,
            id: 'folder-playlist-migration',
            item: {
                icon: 'playlistAdd',
                label: t('page.appMenu.folderPlaylistMigration'),
                onClick: () => {
                    openContextModal({
                        innerProps: {},
                        modal: 'folderPlaylistMigration',
                        size: 'xl',
                        title: t('folderPlaylistMigration.title'),
                    });
                },
                type: 'item',
            },
            type: 'conditional-item',
        },
        {
            condition: !isServerLock(),
            id: 'manage-servers',
            item: {
                label: t('page.appMenu.manageServers'),
                leftSection: <Icon icon="edit" />,
                onClick: handleManageServersModal,
                type: 'item',
            },
            type: 'conditional-item',
        },
    ];

    const windowItems: MenuItem[] = collapsed
        ? [
              {
                  id: 'divider-window',
                  type: 'divider',
              },
              {
                  icon: 'arrowLeftS',
                  id: 'go-back',
                  label: t('page.appMenu.goBack'),
                  onClick: () => navigate(-1),
                  type: 'item',
              },
              {
                  icon: 'arrowRightS',
                  id: 'go-forward',
                  label: t('page.appMenu.goForward'),
                  onClick: () => navigate(1),
                  type: 'item',
              },
              {
                  icon: 'panelRightOpen',
                  id: 'expand-sidebar',
                  label: t('page.appMenu.expandSidebar'),
                  onClick: handleExpandSidebar,
                  type: 'item',
              },
          ]
        : [
              // When the sidebar is expanded the only "window" control is the
              // collapse toggle. We keep it in the App group below so the
              // window divider doesn't appear by itself.
          ];

    const appItems: MenuItem[] = [
        {
            condition: !collapsed,
            id: 'sidebar-collapse',
            item: {
                icon: 'panelRightClose',
                id: 'collapse-sidebar',
                label: t('page.appMenu.collapseSidebar'),
                onClick: handleCollapseSidebar,
                type: 'item',
            },
            type: 'conditional-item',
        },
        {
            icon: 'settings',
            id: 'settings',
            label: t('page.appMenu.settings'),
            onClick: () => openSettingsModal(),
            type: 'item',
        },
        {
            condition: privateMode,
            id: 'private-mode-off',
            item: {
                icon: 'lock',
                iconColor: 'error',
                label: t('page.appMenu.privateModeOff'),
                onClick: handlePrivateModeOff,
                type: 'item',
            },
            type: 'conditional-item',
        },
        {
            condition: !privateMode,
            id: 'private-mode-on',
            item: {
                icon: 'lockOpen',
                label: t('page.appMenu.privateModeOn'),
                onClick: handlePrivateModeOn,
                type: 'item',
            },
            type: 'conditional-item',
        },
        {
            icon: 'brandGitHub',
            id: 'version',
            label: t('page.appMenu.version', { version: packageJson.version }),
            onClick: () =>
                openReleaseNotesModal(
                    t('common.newVersion', { version: packageJson.version }) as string,
                ),
            type: 'item',
        },
        {
            // Non-Electron platforms (Capacitor Android, web/PWA) get a
            // visible "Check for updates" + "Install latest release" pair
            // since the only automatic check is the 6h background poll
            // and the user can't always wait. Electron is hidden because
            // electron-updater has its own UI surface.
            condition: !isElectron(),
            id: 'check-for-updates',
            item: {
                icon: 'refresh',
                id: 'check-for-updates',
                label: t('page.appMenu.checkForUpdates', {
                    defaultValue: 'Check for updates',
                }),
                onClick: () => {
                    void checkForUpdatesNow();
                },
                type: 'item',
            },
            type: 'conditional-item',
        },
        {
            condition: !isElectron(),
            id: 'install-latest',
            item: {
                icon: 'download',
                id: 'install-latest',
                label: t('page.appMenu.installLatest', {
                    defaultValue: 'Install latest release',
                }),
                onClick: () => {
                    void installLatest();
                },
                type: 'item',
            },
            type: 'conditional-item',
        },
        {
            condition: isElectron(),
            id: 'devtools',
            item: {
                icon: 'appWindow',
                id: 'open-devtools',
                label: t('page.appMenu.openBrowserDevtools'),
                onClick: handleBrowserDevTools,
                type: 'item',
            },
            type: 'conditional-item',
        },
        {
            condition: isElectron(),
            id: 'quit',
            item: {
                icon: 'x',
                id: 'quit-app',
                label: t('page.appMenu.quit'),
                onClick: handleQuit,
                type: 'item',
            },
            type: 'conditional-item',
        },
        {
            condition: settings.sideQueueType === 'sideQueue',
            id: 'layout-toggle-group',
            items: [
                {
                    component: (
                        <Group gap="xs" grow pb="xs" pt="sm" px="xs" w="100%">
                            <ActionIcon
                                icon="layoutPanelRight"
                                iconProps={{
                                    size: 'xl',
                                }}
                                onClick={() => handleSetSideQueueLayout('horizontal')}
                                tooltip={{
                                    label: t('setting.sidePlayQueueLayout', {
                                        context: 'optionHorizontal',
                                    }),
                                    openDelay: 400,
                                    position: 'bottom',
                                }}
                                variant={
                                    settings.sideQueueLayout === 'horizontal'
                                        ? 'default'
                                        : 'transparent'
                                }
                            />
                            <ActionIcon
                                icon="layoutPanelBottom"
                                iconProps={{
                                    size: 'xl',
                                }}
                                onClick={() => handleSetSideQueueLayout('vertical')}
                                tooltip={{
                                    label: t('setting.sidePlayQueueLayout', {
                                        context: 'optionVertical',
                                    }),
                                    openDelay: 400,
                                    position: 'bottom',
                                }}
                                variant={
                                    settings.sideQueueLayout === 'vertical'
                                        ? 'default'
                                        : 'transparent'
                                }
                            />
                        </Group>
                    ),
                    id: 'layout-toggle',
                    type: 'custom',
                },
            ],
            type: 'conditional-group',
        },
    ];

    const menuConfig: MenuItem[] = [
        ...serverHeaderMenuItems,
        ...libraryActionItems,
        ...windowItems,
        {
            id: 'divider-app',
            type: 'divider',
        },
        ...appItems,
    ];

    const renderMenuItem = (item: MenuItem): ReactNode => {
        switch (item.type) {
            case 'conditional-group':
                if (!item.condition) return null;
                return (
                    <div key={item.id}>
                        {item.items.map((subItem) => {
                            return <Fragment key={subItem.id}>{renderMenuItem(subItem)}</Fragment>;
                        })}
                    </div>
                );

            case 'conditional-item':
                if (!item.condition) return null;
                return <Fragment key={item.id}>{renderMenuItem(item.item as MenuItem)}</Fragment>;

            case 'custom':
                return <div key={item.id}>{item.component}</div>;

            case 'divider':
                return <DropdownMenu.Divider key={item.id} />;

            case 'item': {
                const leftSection =
                    item.leftSection ||
                    (item.icon && <Icon color={item.iconColor} icon={item.icon} />);

                const props = {
                    leftSection,
                    ...(item.rightSection && { rightSection: item.rightSection }),
                    ...(item.onClick && { onClick: item.onClick }),
                    ...(item.component && { component: item.component }),
                    ...(item.to && { to: item.to }),
                    ...(item.href && { href: item.href }),
                    ...(item.target && { target: item.target }),
                } as MenuItemProps;

                return (
                    <DropdownMenu.Item key={item.id} {...props}>
                        {item.label}
                    </DropdownMenu.Item>
                );
            }

            default:
                return null;
        }
    };

    return <>{menuConfig.map((item) => renderMenuItem(item))}</>;
};
