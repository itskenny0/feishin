import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExplicitStatus } from '/@/shared/types/domain-types';

/**
 * Regression coverage for the mobile fullscreen player cover honouring the
 * `blurExplicitImages` setting.
 *
 * The bug: the mobile fullscreen album art rendered explicit covers
 * unblurred — it never derived the song's explicit status, never passed it
 * through `useCrossfadeImageSlots`, and its local `ImageWithPlaceholder`
 * applied no `censored` class. The mini-player and the DESKTOP fullscreen
 * cover both blur explicit art, so the mobile fullscreen cover leaked it.
 *
 * The fix threads `currentExplicit`/`nextExplicit` (+ `paused`) into the
 * crossfade hook and applies the `.censored` blur class gated on the setting.
 * This test renders the real component (with the real crossfade hook) and
 * asserts the cover carries the blur class only when the setting is on AND the
 * song is explicit.
 */

// Mutable state the mocked store hooks read from, so each test can vary the
// setting + the current song without re-registering mocks.
const state = vi.hoisted(() => ({
    blurExplicitImages: false as boolean,
    currentSong: undefined as unknown,
    nextSong: undefined as unknown,
    previousSong: undefined as unknown,
}));

vi.mock('/@/renderer/store', () => ({
    useBlurExplicitImages: () => state.blurExplicitImages,
    useFullScreenPlayerUseImageAspectRatio: () => false,
    useImageRes: () => ({ fullScreenPlayer: undefined }),
    usePlayerData: () => ({ nextSong: state.nextSong, previousSong: state.previousSong }),
    usePlayerSong: () => state.currentSong,
}));

// Resolve every cover to a stable non-empty URL so ImageWithPlaceholder renders
// the <img> (not the placeholder) and the crossfade slots carry a real src.
vi.mock('/@/renderer/components/item-image/item-image', () => ({
    useCachedItemImageUrl: () => 'https://example.test/cover.jpg',
}));

// Local (non-remote) playback: no active remote source, targetDeviceId null.
vi.mock('/@/renderer/features/jellyfin-remote-target/hooks/use-active-player-source', () => ({
    useActiveNextItem: () => undefined,
    useActiveNowPlayingItem: () => undefined,
}));
vi.mock('/@/renderer/features/jellyfin-remote-target/store/remote-target-store', () => ({
    useRemoteTargetStore: (selector: (s: unknown) => unknown) =>
        selector({
            mirrored: { nextItemId: undefined, queue: [], queueIndex: -1 },
            targetDeviceId: null,
        }),
}));
vi.mock('/@/renderer/features/player/context/player-context', () => ({
    usePlayer: () => ({ mediaNext: vi.fn(), mediaPrevious: vi.fn() }),
}));
vi.mock('/@/renderer/features/radio/hooks/use-radio-player', () => ({
    useIsRadioActive: () => false,
    useRadioPlayer: () => ({ isPlaying: false }),
}));
vi.mock('/@/renderer/hooks/use-haptic', () => ({ triggerHaptic: vi.fn() }));
vi.mock('/@/shared/components/icon/icon', () => ({ Icon: () => <span data-testid="icon" /> }));
vi.mock('/@/shared/components/center/center', () => ({
    Center: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

// Imported after the mocks are registered.
import { MobileFullscreenPlayerAlbumArt } from '/@/renderer/features/player/components/mobile-fullscreen-player-album-art';

const explicitSong = {
    _uniqueId: 'song-1',
    albumId: 'album-1',
    explicitStatus: ExplicitStatus.EXPLICIT,
    id: 'song-1',
    imageId: 'img-1',
};
const cleanSong = { ...explicitSong, explicitStatus: ExplicitStatus.CLEAN };

const coverEl = (container: HTMLElement): HTMLElement => {
    const el = container.querySelector('.player-cover-art');
    if (!el) throw new Error('cover art element not found');
    return el as HTMLElement;
};

beforeEach(() => {
    state.blurExplicitImages = false;
    state.currentSong = undefined;
    state.nextSong = undefined;
    state.previousSong = undefined;
});
afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe('mobile fullscreen player cover explicit blur', () => {
    it('blurs the cover when blurExplicitImages is on and the song is explicit', () => {
        state.blurExplicitImages = true;
        state.currentSong = explicitSong;

        const { container } = render(<MobileFullscreenPlayerAlbumArt />);

        expect(coverEl(container).className).toMatch(/censored/);
    });

    it('does not blur when blurExplicitImages is off (even if explicit)', () => {
        state.blurExplicitImages = false;
        state.currentSong = explicitSong;

        const { container } = render(<MobileFullscreenPlayerAlbumArt />);

        expect(coverEl(container).className).not.toMatch(/censored/);
    });

    it('does not blur a clean song when the setting is on', () => {
        state.blurExplicitImages = true;
        state.currentSong = cleanSong;

        const { container } = render(<MobileFullscreenPlayerAlbumArt />);

        expect(coverEl(container).className).not.toMatch(/censored/);
    });
});
