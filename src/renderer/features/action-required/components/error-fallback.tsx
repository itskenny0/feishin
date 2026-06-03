import type { FallbackProps } from 'react-error-boundary';

import { useTranslation } from 'react-i18next';
import { useNavigate, useRouteError } from 'react-router';

import styles from './error-fallback.module.css';

import { useIsMobileShell } from '/@/renderer/hooks/use-breakpoint';
import { AppRoute } from '/@/renderer/router/routes';
import { Button } from '/@/shared/components/button/button';
import { Center } from '/@/shared/components/center/center';
import { Group } from '/@/shared/components/group/group';
import { Icon } from '/@/shared/components/icon/icon';
import { Stack } from '/@/shared/components/stack/stack';
import { Text } from '/@/shared/components/text/text';

export const ErrorFallback = ({ resetErrorBoundary }: FallbackProps) => {
    const error = useRouteError() as any;
    const { t } = useTranslation();
    const isMobileShell = useIsMobileShell();
    const navigate = useNavigate();

    const detail = typeof error?.message === 'string' ? error.message.trim() : '';

    const handleGoHome = () => {
        // Clear the error boundary first so the home route can mount cleanly.
        resetErrorBoundary();
        navigate(AppRoute.HOME);
    };

    return (
        <div className={styles.container}>
            <Center style={{ height: '100vh', padding: '24px' }}>
                <Stack
                    align="center"
                    gap="lg"
                    style={{
                        maxWidth: 'min(100% - 8px, 480px)',
                        textAlign: 'center',
                        width: '100%',
                    }}
                >
                    <Icon fill="error" icon="error" size="4rem" />
                    <Stack gap="sm">
                        <Text size="xl" weight={600}>
                            {t('error.genericError')}
                        </Text>
                        <Text isMuted size="sm">
                            {t('error.genericErrorDescription', {
                                defaultValue:
                                    'An unexpected error occurred. Reloading usually fixes it. If it keeps happening, please report it.',
                            })}
                        </Text>
                    </Stack>
                    {detail && (
                        <Text
                            isMuted
                            size="xs"
                            style={{
                                maxWidth: '100%',
                                opacity: 0.7,
                                overflowWrap: 'anywhere',
                                wordBreak: 'break-word',
                            }}
                        >
                            {detail}
                        </Text>
                    )}
                    <Group
                        gap="sm"
                        justify="center"
                        style={{ width: isMobileShell ? '100%' : undefined }}
                        wrap={isMobileShell ? 'wrap' : 'nowrap'}
                    >
                        <Button
                            fullWidth={isMobileShell}
                            leftSection={<Icon icon="refresh" />}
                            onClick={resetErrorBoundary}
                            variant="filled"
                        >
                            {t('common.reload')}
                        </Button>
                        <Button
                            fullWidth={isMobileShell}
                            leftSection={<Icon icon="home" />}
                            onClick={handleGoHome}
                            variant="default"
                        >
                            {t('error.goHome', { defaultValue: 'Go to home' })}
                        </Button>
                    </Group>
                </Stack>
            </Center>
        </div>
    );
};
