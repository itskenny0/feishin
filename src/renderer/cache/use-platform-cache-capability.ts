import { useEffect, useState } from 'react';

import { isCacheAvailable } from '/@/renderer/cache/capability';

/**
 * Answers "can THIS PLATFORM host the local cache?" — independent of whether
 * the user has the cache enabled. The cache store's `cacheAvailable` flag is
 * forced false while the subsystem is disabled (a kill switch for runtime
 * consumers), so settings surfaces that gate setup UI on it lock the user
 * out: with the cache disabled they saw "unavailable on this platform" and
 * no way to enable it. Returns null while probing, then the probe verdict.
 */
export const usePlatformCacheCapability = (): boolean | null => {
    const [capable, setCapable] = useState<boolean | null>(null);

    useEffect(() => {
        let cancelled = false;
        isCacheAvailable()
            .then((available) => {
                if (!cancelled) setCapable(available);
            })
            .catch(() => {
                if (!cancelled) setCapable(false);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    return capable;
};
