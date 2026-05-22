import { openModal } from '@mantine/modals';
import { useTranslation } from 'react-i18next';
import { Navigate } from 'react-router';

import { PageHeader } from '/@/renderer/components/page-header/page-header';
import { ActionRequiredContainer } from '/@/renderer/features/action-required/components/action-required-container';
import { ServerCredentialRequired } from '/@/renderer/features/action-required/components/server-credential-required';
import { ServerRequired } from '/@/renderer/features/action-required/components/server-required';
import { isServerLock } from '/@/renderer/features/action-required/utils/window-properties';
import LoginRoute from '/@/renderer/features/login/routes/login-route';
import { ServerList } from '/@/renderer/features/servers/components/server-list';
import { AnimatedPage } from '/@/renderer/features/shared/components/animated-page';
import { PageErrorBoundary } from '/@/renderer/features/shared/components/page-error-boundary';
import { AppRoute } from '/@/renderer/router/routes';
import { useCurrentServerWithCredential } from '/@/renderer/store';
import { Button } from '/@/shared/components/button/button';
import { Center } from '/@/shared/components/center/center';
import { Group } from '/@/shared/components/group/group';
import { Icon } from '/@/shared/components/icon/icon';
import { ScrollArea } from '/@/shared/components/scroll-area/scroll-area';
import { Stack } from '/@/shared/components/stack/stack';

const ActionRequiredRoute = () => {
    const { t } = useTranslation();
    const currentServer = useCurrentServerWithCredential();
    const isServerRequired = !currentServer;
    const isCredentialRequired = currentServer && !currentServer.credential;

    const isLoginRequired = isServerLock() && !currentServer;

    const checks = [
        {
            component: <ServerCredentialRequired />,
            title: t('error.credentialsRequired'),
            valid: !isCredentialRequired,
        },
        {
            component: <ServerRequired />,
            title: t('error.serverRequired'),
            valid: !isServerRequired,
        },
    ];

    const canReturnHome = checks.every((c) => c.valid);
    const displayedCheck = checks.find((c) => !c.valid);

    const handleManageServersModal = () => {
        openModal({
            children: <ServerList />,
            title: t('page.appMenu.manageServers'),
        });
    };

    if (isLoginRequired) {
        return <LoginRoute />;
    }

    return (
        <AnimatedPage>
            <PageHeader />
            <Center style={{ height: '100%', width: '100vw' }}>
                <Stack
                    gap="xl"
                    style={{
                        /*
                         * Desktop: 50% of the viewport keeps the form
                         * comfortably centered without spreading
                         * input fields across the whole window.
                         * Mobile: 50% of a 390px phone = 195px, which
                         * was narrower than the URL / username input's
                         * intrinsic width and pushed the form past the
                         * right edge of the screen — the OpenSubsonic
                         * server-type chip and most placeholder text
                         * got clipped. Use min() so the container
                         * tracks the viewport on phones and only caps
                         * on wider screens.
                         */
                        maxWidth: 'min(100% - 32px, 50%)',
                        width: 'min(100%, 560px)',
                    }}
                >
                    <ScrollArea style={{ maxHeight: 'calc(100vh - 50px)' }}>
                        <Group wrap="nowrap">
                            {displayedCheck && (
                                <ActionRequiredContainer title={displayedCheck.title}>
                                    {displayedCheck?.component}
                                </ActionRequiredContainer>
                            )}
                        </Group>
                        <Stack mt="2rem">
                            {canReturnHome && <Navigate to={AppRoute.HOME} />}
                            {/* This should be displayed if a credential is required */}
                            {isCredentialRequired && !isServerLock && (
                                <Group justify="center" wrap="nowrap">
                                    <Button
                                        fullWidth
                                        leftSection={<Icon icon="edit" />}
                                        onClick={handleManageServersModal}
                                        variant="filled"
                                    >
                                        {t('page.appMenu.manageServers')}
                                    </Button>
                                </Group>
                            )}
                        </Stack>
                    </ScrollArea>
                </Stack>
            </Center>
        </AnimatedPage>
    );
};

const ActionRequiredRouteWithBoundary = () => {
    return (
        <PageErrorBoundary>
            <ActionRequiredRoute />
        </PageErrorBoundary>
    );
};

export default ActionRequiredRouteWithBoundary;
