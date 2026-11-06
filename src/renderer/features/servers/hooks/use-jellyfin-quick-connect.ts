import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '/@/renderer/api';
import { toast } from '/@/shared/components/toast/toast';
import { AuthenticationResponse, ServerType } from '/@/shared/types/domain-types';

interface UseJellyfinQuickConnectProps {
    onAuthenticated: (data: AuthenticationResponse) => Promise<void> | void;
}

/**
 * Encapsulates the Jellyfin Quick Connect flow: initiating a request, polling
 * the server for authorization, and completing the login once approved.
 *
 * The caller is only responsible for what happens once authentication
 * succeeds (`onAuthenticated`), since that differs between the login route
 * and the add server form.
 */
export function useJellyfinQuickConnect({ onAuthenticated }: UseJellyfinQuickConnectProps) {
    const { t } = useTranslation();
    const [code, setCode] = useState<null | string>(null);
    const [isLoading, setIsLoading] = useState(false);
    const intervalRef = useRef<null | ReturnType<typeof setInterval>>(null);
    // Bumped by every start / stop / unmount. A request that resolves after its
    // run was cancelled (or superseded) must not start polling or log in.
    const runRef = useRef(0);
    // Read at login time so the caller's latest form values are used, not the
    // ones captured when polling started.
    const onAuthenticatedRef = useRef(onAuthenticated);
    onAuthenticatedRef.current = onAuthenticated;

    const clearPolling = useCallback(() => {
        runRef.current += 1;
        if (intervalRef.current) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
        }
    }, []);

    useEffect(() => clearPolling, [clearPolling]);

    const stop = useCallback(() => {
        clearPolling();
        setCode(null);
        setIsLoading(false);
    }, [clearPolling]);

    const start = useCallback(
        async (url: string) => {
            if (!url) return;

            clearPolling();
            const run = runRef.current;
            setIsLoading(true);
            setCode(null);

            let result: { code: string; secret: string };
            try {
                result = await api.controller.authenticate(
                    url,
                    { action: 'quickConnectInitiate' },
                    ServerType.JELLYFIN,
                );
            } catch (err: any) {
                if (runRef.current !== run) return;
                setIsLoading(false);
                toast.error({
                    message: err?.message ?? t('error.jellyfinQuickConnectNotActive'),
                });
                return;
            }
            if (runRef.current !== run) return;

            setCode(result.code);
            setIsLoading(false);

            intervalRef.current = setInterval(async () => {
                let approved = false;
                try {
                    const authenticated = await api.controller.authenticate(
                        url,
                        { action: 'quickConnectState', secret: result.secret },
                        ServerType.JELLYFIN,
                    );
                    if (!authenticated || runRef.current !== run) return;

                    approved = true;
                    stop();

                    const data = await api.controller.authenticate(
                        url,
                        { action: 'quickConnectAuthenticate', secret: result.secret },
                        ServerType.JELLYFIN,
                    );
                    if (!data) {
                        toast.error({ message: t('error.authenticationFailed') });
                        return;
                    }

                    await onAuthenticatedRef.current(data);
                } catch (err: any) {
                    if (!approved && runRef.current !== run) return;
                    stop();
                    toast.error({
                        message: err?.message ?? t('error.jellyfinQuickConnectDeactivated'),
                    });
                }
            }, 5000);
        },
        [clearPolling, stop, t],
    );

    return { code, isLoading, start, stop };
}
