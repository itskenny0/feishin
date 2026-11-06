import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useGithubReleasesUpdaterControls } from '/@/renderer/hooks/use-github-releases-updater';

const toast = vi.hoisted(() => ({ info: vi.fn(), success: vi.fn(), warn: vi.fn() }));
vi.mock('/@/shared/components/toast/toast', () => ({ toast }));

const release = {
    assets: [],
    body: '',
    html_url: 'https://github.com/itskenny0/feishin/releases/tag/v999.0.0',
    name: 'v999.0.0',
    tag_name: 'v999.0.0',
};

describe('useGithubReleasesUpdaterControls.checkNow', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.clearAllMocks();
    });

    // A manual check used to rely on the background poller to announce an
    // update, but the poller only toasts a tag once per session (and never
    // after it was dismissed), so "Check for updates" went silent exactly
    // when an update existed.
    it('announces an available update itself instead of relying on the poller', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({ json: async () => release, ok: true })),
        );
        const queryClient = new QueryClient();
        const { result } = renderHook(() => useGithubReleasesUpdaterControls(), {
            wrapper: ({ children }) => (
                <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
            ),
        });

        await act(async () => {
            await result.current.checkNow();
        });

        expect(toast.info).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'github-update-available' }),
        );
        expect(toast.warn).not.toHaveBeenCalled();
    });
});
