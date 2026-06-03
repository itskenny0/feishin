/**
 * Regression coverage for the perf fix that switched `lyricsKey` from a
 * `useMemo([currentSong])` to a leaf-selected `useMemo([serverId, songId])`.
 *
 * The original code recomputed the key (and tripped every downstream
 * `useCallback`) on every favorite / rating mutation of the same song. After
 * the fix the key tuple is stable across non-key-field mutations, so the
 * `queryKeys.songs.lyrics` builder is called once per real song change, not
 * once per metadata bump.
 */
import type { ReactNode } from 'react';

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { computeSelectedFromResultMock, lyricsKeyBuilder, lyricsQueriesMock, songRef } = vi.hoisted(
    () => ({
        computeSelectedFromResultMock: vi.fn(() => ({ selected: null, selectedSynced: false })),
        lyricsKeyBuilder: vi.fn((serverId: string, query: { songId: string }) => [
            serverId,
            'song',
            'lyrics',
            'select',
            query,
        ]),
        lyricsQueriesMock: {
            songLyrics: vi.fn(() => ({
                enabled: false,
                queryFn: async () => null,
                queryKey: ['noop'],
            })),
        },
        songRef: {
            current: null as null | {
                _serverId?: string;
                artists?: { id: string; name: string }[];
                duration?: number;
                id?: string;
                name?: string;
                userFavorite?: boolean;
                userRating?: number;
            },
        },
    }),
);

vi.mock('/@/renderer/api/query-keys', async () => {
    const actual = await vi.importActual<typeof import('/@/renderer/api/query-keys')>(
        '/@/renderer/api/query-keys',
    );
    return {
        ...actual,
        queryKeys: {
            ...actual.queryKeys,
            songs: {
                ...actual.queryKeys.songs,
                lyrics: lyricsKeyBuilder,
            },
        },
    };
});

vi.mock('/@/renderer/features/jellyfin-remote-target/hooks/use-active-player-source', () => ({
    useActiveNowPlayingItem: () => songRef.current,
}));

vi.mock('/@/renderer/features/lyrics/api/lyrics-api', async () => {
    const actual = await vi.importActual<
        typeof import('/@/renderer/features/lyrics/api/lyrics-api')
    >('/@/renderer/features/lyrics/api/lyrics-api');
    return {
        ...actual,
        computeSelectedFromResult: computeSelectedFromResultMock,
        getDisplayOffset: () => 0,
        lyricsQueries: lyricsQueriesMock,
    };
});

vi.mock('@tanstack/react-query', () => ({
    useQuery: () => ({ data: null, isLoading: false }),
}));

vi.mock('/@/renderer/features/radio/hooks/use-radio-player', () => ({
    useIsRadioActive: () => false,
}));

vi.mock('/@/renderer/store', () => ({
    useLyricsSettings: () => ({
        enableAutoTranslation: false,
        preferLocalLyrics: false,
        translationApiKey: '',
        translationApiProvider: '',
        translationTargetLanguage: 'en',
    }),
}));

vi.mock('/@/renderer/store/auth.store', () => ({
    useCurrentServerWithCredential: () => null,
}));

vi.mock('/@/renderer/features/player/audio-player/hooks/use-player-events', () => ({
    usePlayerEvents: () => undefined,
}));

vi.mock('/@/renderer/lib/react-query', () => ({
    queryClient: {
        invalidateQueries: vi.fn(),
        setQueryData: vi.fn(),
    },
}));

vi.mock('react-i18next', async () => {
    const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
    return {
        ...actual,
        useTranslation: () => ({ t: (k: string) => k }),
    };
});

// Lightweight passthroughs for layout/animation chrome.
vi.mock('motion/react', () => ({
    AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
    motion: new Proxy(
        {},
        {
            get:
                () =>
                ({ children, ...props }: Record<string, unknown> & { children?: ReactNode }) => (
                    <div {...props}>{children}</div>
                ),
        },
    ),
}));

vi.mock('/@/renderer/features/shared/components/component-error-boundary', () => ({
    ComponentErrorBoundary: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('/@/renderer/features/lyrics/lyrics-actions', () => ({
    LyricsActions: () => <div data-testid="lyrics-actions" />,
}));

vi.mock('/@/renderer/features/lyrics/synchronized-lyrics', () => ({
    SynchronizedLyrics: () => <div data-testid="synced-lyrics" />,
}));

vi.mock('/@/renderer/features/lyrics/unsynchronized-lyrics', () => ({
    UnsynchronizedLyrics: () => <div data-testid="unsynced-lyrics" />,
}));

vi.mock('/@/renderer/features/lyrics/components/lyrics-export-form', () => ({
    openLyricsExportModal: vi.fn(),
}));

vi.mock('/@/renderer/features/lyrics/utils/open-lyrics-settings-modal', () => ({
    openLyricsSettingsModal: vi.fn(),
}));

vi.mock('/@/renderer/features/lyrics/utils/upload-lyrics-to-server', () => ({
    uploadLyricsToServer: vi.fn(),
}));

vi.mock('/@/renderer/features/lyrics/api/lyric-translate', () => ({
    translateLyrics: vi.fn(),
}));

vi.mock('/@/shared/components/action-icon/action-icon', () => ({
    ActionIcon: () => <button type="button" />,
}));
vi.mock('/@/shared/components/center/center', () => ({
    Center: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock('/@/shared/components/stack/stack', () => ({
    Stack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock('/@/shared/components/icon/icon', () => ({
    Icon: () => <span data-testid="icon" />,
}));
vi.mock('/@/shared/components/spinner/spinner', () => ({
    Spinner: () => <div data-testid="spinner" />,
}));
vi.mock('/@/shared/components/text/text', () => ({
    Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock('/@/shared/components/toast/toast', () => ({
    toast: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

// Imported after mocks are registered.
import { Lyrics } from '/@/renderer/features/lyrics/lyrics';

afterEach(() => {
    cleanup();
    lyricsKeyBuilder.mockClear();
    songRef.current = null;
});

describe('Lyrics lyricsKey memoization', () => {
    it('does NOT recompute lyricsKey when a non-key field of the same song changes', () => {
        songRef.current = {
            _serverId: 'srv1',
            artists: [{ id: 'a1', name: 'Artist' }],
            duration: 200_000,
            id: 'song-a',
            name: 'Song A',
            userFavorite: false,
            userRating: 0,
        };

        const { rerender } = render(<Lyrics />);

        const callsAfterMount = lyricsKeyBuilder.mock.calls.length;
        expect(callsAfterMount).toBeGreaterThan(0);

        // Flip favorite — a perfectly common mutation that previously rebuilt
        // the entire key + every useCallback that depended on it.
        songRef.current = { ...songRef.current, userFavorite: true };
        rerender(<Lyrics />);

        // Bump rating too.
        songRef.current = { ...songRef.current, userRating: 5 };
        rerender(<Lyrics />);

        // Mutate other non-key fields (track name change is rare but represents
        // any wide-object metadata refresh).
        songRef.current = { ...songRef.current, name: 'Song A (Remastered)' };
        rerender(<Lyrics />);

        expect(lyricsKeyBuilder.mock.calls.length).toBe(callsAfterMount);
    });

    it('DOES recompute lyricsKey when the song id changes', () => {
        songRef.current = {
            _serverId: 'srv1',
            id: 'song-a',
            name: 'Song A',
        };

        const { rerender } = render(<Lyrics />);

        const callsAfterMount = lyricsKeyBuilder.mock.calls.length;

        songRef.current = { _serverId: 'srv1', id: 'song-b', name: 'Song B' };
        rerender(<Lyrics />);

        expect(lyricsKeyBuilder.mock.calls.length).toBeGreaterThan(callsAfterMount);
    });

    it('DOES recompute lyricsKey when the serverId changes', () => {
        songRef.current = { _serverId: 'srv1', id: 'song-a' };

        const { rerender } = render(<Lyrics />);

        const callsAfterMount = lyricsKeyBuilder.mock.calls.length;

        songRef.current = { _serverId: 'srv2', id: 'song-a' };
        rerender(<Lyrics />);

        expect(lyricsKeyBuilder.mock.calls.length).toBeGreaterThan(callsAfterMount);
    });
});
