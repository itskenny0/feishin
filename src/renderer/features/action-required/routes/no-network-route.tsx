import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { PageHeader } from '/@/renderer/components/page-header/page-header';
import { AnimatedPage } from '/@/renderer/features/shared/components/animated-page';
import { PageErrorBoundary } from '/@/renderer/features/shared/components/page-error-boundary';
import { useIsMobileShell } from '/@/renderer/hooks/use-breakpoint';
import { AppRoute } from '/@/renderer/router/routes';
import { Button } from '/@/shared/components/button/button';
import { Center } from '/@/shared/components/center/center';
import { Icon } from '/@/shared/components/icon/icon';
import { Stack } from '/@/shared/components/stack/stack';
import { Text } from '/@/shared/components/text/text';

const NoNetworkRoute = () => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const isMobileShell = useIsMobileShell();

    const handleRetry = () => {
        // Navigate to home which will trigger authentication again
        navigate(AppRoute.HOME);
    };

    return (
        <AnimatedPage>
            <PageHeader />
            <Center style={{ height: '100%', padding: '24px' }}>
                <Stack
                    align="center"
                    gap="xl"
                    style={{
                        maxWidth: 'min(100% - 8px, 420px)',
                        textAlign: 'center',
                        width: '100%',
                    }}
                >
                    <Icon icon="wifiOff" size="4rem" />
                    <Stack gap="sm">
                        <Text size="xl" weight={600}>
                            {t('error.noNetwork')}
                        </Text>
                        <Text isMuted size="sm">
                            {t('error.noNetworkDescription')}
                        </Text>
                        <Text isMuted size="xs" style={{ opacity: 0.75 }}>
                            {t('error.noNetworkHint', {
                                defaultValue:
                                    'If the problem continues, check that the server is running and reachable, or switch to a different server.',
                            })}
                        </Text>
                    </Stack>
                    <Button
                        fullWidth={isMobileShell}
                        leftSection={<Icon icon="refresh" />}
                        onClick={handleRetry}
                        variant="filled"
                    >
                        {t('common.retry')}
                    </Button>
                </Stack>
            </Center>
        </AnimatedPage>
    );
};

const NoNetworkRouteWithBoundary = () => {
    return (
        <PageErrorBoundary>
            <NoNetworkRoute />
        </PageErrorBoundary>
    );
};

export default NoNetworkRouteWithBoundary;
