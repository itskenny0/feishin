import type { QueryKey } from '@tanstack/react-query';

import { useTranslation } from 'react-i18next';

import { useColdFetchPending } from '/@/renderer/cache';
import { EmptyState } from '/@/renderer/features/shared/components/empty-state';
import { useIsOnline } from '/@/renderer/lib/network-status';
import { Button } from '/@/shared/components/button/button';
import { type AppIconSelection } from '/@/shared/components/icon/icon';
import { Spinner } from '/@/shared/components/spinner/spinner';

interface DetailLoadFallbackProps {
    icon: AppIconSelection;
    isRetrying: boolean;
    onRetry: () => void;
    queryKey: QueryKey;
}

// Rendered by a detail page whose query settled on `null`: the cold fetch
// timed out or failed with nothing cached. A timed-out request is often
// still running (a busy server mid-sync) and its late result fills the page
// in, so that case reads as "still loading", not as an error. Once nothing is
// in flight the page offers a retry instead of a dead end.
export const DetailLoadFallback = ({
    icon,
    isRetrying,
    onRetry,
    queryKey,
}: DetailLoadFallbackProps) => {
    const { t } = useTranslation();
    const pending = useColdFetchPending(queryKey);
    // Online but nothing came back: most likely the item no longer exists, so
    // don't blame the network.
    const isOnline = useIsOnline();

    if (pending) {
        return (
            <EmptyState
                action={<Spinner />}
                description={t('emptyState.slowServerDescription', {
                    defaultValue:
                        'The server is taking longer than usual. This page fills in as soon as it answers.',
                })}
                icon={icon}
                title={t('emptyState.slowServerTitle', { defaultValue: 'Still loading' })}
            />
        );
    }

    return (
        <EmptyState
            action={
                <Button loading={isRetrying} onClick={onRetry} variant="filled">
                    {t('emptyState.retry', { defaultValue: 'Try again' })}
                </Button>
            }
            description={
                isOnline
                    ? t('emptyState.unavailableDescription')
                    : t('error.networkErrorFriendly', {
                          defaultValue:
                              'Could not reach the server. Check your network and try again.',
                      })
            }
            icon={icon}
            title={
                isOnline
                    ? t('emptyState.unavailableTitle')
                    : t('error.genericError', { defaultValue: 'Something went wrong' })
            }
        />
    );
};
