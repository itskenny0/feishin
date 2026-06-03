import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router';

import { AnimatedPage } from '/@/renderer/features/shared/components/animated-page';
import { PageErrorBoundary } from '/@/renderer/features/shared/components/page-error-boundary';
import { useIsMobileShell } from '/@/renderer/hooks/use-breakpoint';
import { AppRoute } from '/@/renderer/router/routes';
import { Button } from '/@/shared/components/button/button';
import { Center } from '/@/shared/components/center/center';
import { Group } from '/@/shared/components/group/group';
import { Icon } from '/@/shared/components/icon/icon';
import { Stack } from '/@/shared/components/stack/stack';
import { Text } from '/@/shared/components/text/text';

const InvalidRoute = () => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const location = useLocation();
    const isMobileShell = useIsMobileShell();

    return (
        <AnimatedPage>
            <Center style={{ height: '100%', padding: '24px', width: '100%' }}>
                <Stack
                    align="center"
                    gap="xl"
                    style={{
                        maxWidth: 'min(100% - 8px, 420px)',
                        textAlign: 'center',
                        width: '100%',
                    }}
                >
                    <Icon color="warn" icon="error" size="4rem" />
                    <Stack gap="sm">
                        <Text size="xl" weight={600}>
                            {t('error.apiRouteError')}
                        </Text>
                        <Text isMuted size="sm">
                            {t('error.apiRouteErrorDescription', {
                                defaultValue:
                                    "We couldn't find a page for this address. The link may be broken or out of date.",
                            })}
                        </Text>
                        {location.pathname && (
                            <Text
                                isMuted
                                size="xs"
                                style={{
                                    opacity: 0.7,
                                    overflowWrap: 'anywhere',
                                    wordBreak: 'break-word',
                                }}
                            >
                                {location.pathname}
                            </Text>
                        )}
                    </Stack>
                    <Group
                        gap="sm"
                        justify="center"
                        style={{ width: isMobileShell ? '100%' : undefined }}
                        wrap={isMobileShell ? 'wrap' : 'nowrap'}
                    >
                        <Button
                            fullWidth={isMobileShell}
                            leftSection={<Icon icon="arrowLeftS" />}
                            onClick={() => navigate(-1)}
                            variant="default"
                        >
                            {t('common.back', { defaultValue: 'Back' })}
                        </Button>
                        <Button
                            fullWidth={isMobileShell}
                            leftSection={<Icon icon="home" />}
                            onClick={() => navigate(AppRoute.HOME)}
                            variant="filled"
                        >
                            {t('error.goHome', { defaultValue: 'Go to home' })}
                        </Button>
                    </Group>
                </Stack>
            </Center>
        </AnimatedPage>
    );
};

const InvalidRouteWithBoundary = () => {
    return (
        <PageErrorBoundary>
            <InvalidRoute />
        </PageErrorBoundary>
    );
};

export default InvalidRouteWithBoundary;
