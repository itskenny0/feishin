import { ErrorBoundary } from 'react-error-boundary';
import { useTranslation } from 'react-i18next';

import { Box } from '/@/shared/components/box/box';
import { Button } from '/@/shared/components/button/button';
import { Center } from '/@/shared/components/center/center';
import { Group } from '/@/shared/components/group/group';
import { Icon } from '/@/shared/components/icon/icon';
import { Stack } from '/@/shared/components/stack/stack';
import { TextTitle } from '/@/shared/components/text-title/text-title';
import { Text } from '/@/shared/components/text/text';

interface ComponentErrorFallbackProps {
    error: Error;
    resetErrorBoundary: () => void;
}

const ComponentErrorFallback = ({ error, resetErrorBoundary }: ComponentErrorFallbackProps) => {
    const { t } = useTranslation();

    return (
        <Box h="100%" pos="relative" w="100%">
            <Center h="100%" p="md" w="100%">
                <Stack maw="800px">
                    <Group gap="xs">
                        <Icon fill="error" icon="error" size="lg" />
                        <TextTitle fw={600} order={4}>
                            {t('error.genericError')}
                        </TextTitle>
                    </Group>
                    {/* Surface the actual error message so users have some
                        clue what went wrong rather than a generic
                        "Something went wrong" with no context. In dev,
                        include the stack for quick triage. */}
                    {error?.message && (
                        <Text isMuted size="sm" style={{ wordBreak: 'break-word' }}>
                            {error.message}
                        </Text>
                    )}
                    {process.env.NODE_ENV === 'development' && error?.stack && (
                        <Text
                            component="pre"
                            isMuted
                            size="xs"
                            style={{
                                maxHeight: '200px',
                                overflow: 'auto',
                                whiteSpace: 'pre-wrap',
                            }}
                        >
                            {error.stack}
                        </Text>
                    )}
                    <Group grow>
                        <Button onClick={resetErrorBoundary} size="xs" variant="default">
                            {t('common.reload')}
                        </Button>
                    </Group>
                </Stack>
            </Center>
        </Box>
    );
};

interface ComponentErrorBoundaryProps {
    children: React.ReactNode;
}

export const ComponentErrorBoundary = ({ children }: ComponentErrorBoundaryProps) => {
    return <ErrorBoundary FallbackComponent={ComponentErrorFallback}>{children}</ErrorBoundary>;
};
