// Tests for the MQTT-lane mirror: controller-derived album art and
// upcoming-queue hydration.
//
// The wire `track.art` URL comes from the TARGET's session (its token/device
// binding) — the controller often can't load it, so covers were blank. The
// mirror now derives art from track.id through the CONTROLLER's own server
// connection (wire art only as fallback). Likewise the wire carries bare
// `qIds`: the controller hydrates them through its own Jellyfin connection so
// the "upcoming tracks" panel shows real titles/artists/covers, not id stubs.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    applyMirrorFromServer: vi.fn(),
    getItemImageUrl: vi.fn(
        ({ id }: { id: string }) => `https://controller.example/Items/${id}/Primary?token=mine`,
    ),
    hydrateSongs: vi.fn(async ({ itemIds }: { itemIds: string[] }) =>
        itemIds.map((id) => ({ id, imageUrl: `hydrated-${id}`, name: `Song ${id}` })),
    ),
    storeState: {
        mirrored: { queue: [] as any[] },
        targetDeviceId: 'dev-1',
    } as any,
}));

vi.mock('/@/renderer/components/item-image/item-image', () => ({
    getItemImageUrl: mocks.getItemImageUrl,
}));

vi.mock('/@/renderer/features/jellyfin-remote-target/api/remote-target-api', () => ({
    remoteTargetApi: { hydrateSongs: mocks.hydrateSongs },
}));

vi.mock('/@/renderer/features/jellyfin-remote-target/store/remote-target-store', () => ({
    useRemoteTargetStore: {
        getState: () => ({
            actions: { applyMirrorFromServer: mocks.applyMirrorFromServer },
            mirrored: mocks.storeState.mirrored,
            targetDeviceId: mocks.storeState.targetDeviceId,
        }),
    },
}));

vi.mock('/@/renderer/store/auth.store', () => ({
    useAuthStore: {
        getState: () => ({
            currentServer: { id: 'srv', type: 'jellyfin', userId: 'u1' },
        }),
    },
}));

import {
    __resetQueueHydration,
    ensureQueueHydrated,
    peerStateToMirrored,
} from '/@/renderer/features/peer-sync/controller/peer-state-mirror';

const baseState = (over: Record<string, unknown> = {}) =>
    ({
        dur: 200_000,
        paused: false,
        pos: 1_000,
        rep: 'off',
        shuf: false,
        t: 'state',
        track: { art: 'https://target.example/art?token=theirs', id: 'song-1', title: 'One' },
        ts: 1,
        v: 1,
        vol: 50,
        ...over,
    }) as any;

beforeEach(() => {
    __resetQueueHydration();
    mocks.storeState.mirrored = { queue: [] };
});

afterEach(() => {
    vi.clearAllMocks();
});

// The image helper loads lazily on first use (it must not be statically
// imported into the peer-sync module graph); prime it and let the dynamic
// import settle before asserting derivation.
const primeImageHelper = async () => {
    peerStateToMirrored(baseState());
    await vi.dynamicImportSettled();
};

describe('peerStateToMirrored — controller-derived art', () => {
    it('derives the now-playing cover from track.id via the controller server', async () => {
        await primeImageHelper();
        const out = peerStateToMirrored(baseState());
        expect((out.nowPlayingItem as any).imageUrl).toBe(
            'https://controller.example/Items/song-1/Primary?token=mine',
        );
    });

    it('falls back to the wire art URL when derivation fails', async () => {
        await primeImageHelper();
        mocks.getItemImageUrl.mockImplementationOnce(() => {
            throw new Error('no server');
        });
        const out = peerStateToMirrored(baseState());
        expect((out.nowPlayingItem as any).imageUrl).toBe(
            'https://target.example/art?token=theirs',
        );
    });
});

describe('peerStateToMirrored — next-track + upcoming sequence', () => {
    it('maps nxt → nextItemId and nxts → upcomingItemIds when the publisher reports them', () => {
        const out = peerStateToMirrored(
            baseState({ nxt: 'song-2', nxts: ['song-2', 'song-5', 'song-3'] }),
        );
        expect(out.nextItemId).toBe('song-2');
        expect(out.upcomingItemIds).toEqual(['song-2', 'song-5', 'song-3']);
    });

    it('clears upcomingItemIds to [] when a new-enough publisher omits nxts (end of queue)', () => {
        // nxt present (=> new publisher) but no nxts (nothing upcoming): the
        // mirror must not keep a stale sequence around.
        const out = peerStateToMirrored(baseState({ nxt: null }));
        expect(out.nextItemId).toBeNull();
        expect(out.upcomingItemIds).toEqual([]);
    });

    it('leaves both next fields untouched for an older publisher (nxt undefined)', () => {
        const out = peerStateToMirrored(baseState());
        expect('nextItemId' in out).toBe(false);
        expect('upcomingItemIds' in out).toBe(false);
    });
});

describe('ensureQueueHydrated — upcoming tracks', () => {
    it('hydrates qIds once and patches the mirrored queue with full songs', async () => {
        const state = baseState({ qIds: ['song-1', 'song-2', 'song-3'], qIdx: 0 });
        const first = peerStateToMirrored(state);
        mocks.storeState.mirrored = { queue: first.queue };

        await ensureQueueHydrated(['song-1', 'song-2', 'song-3'], 0);

        expect(mocks.hydrateSongs).toHaveBeenCalledTimes(1);
        expect(mocks.applyMirrorFromServer).toHaveBeenCalledTimes(1);
        const patch = mocks.applyMirrorFromServer.mock.calls[0][0];
        expect(patch.queue.map((s: any) => s.name)).toEqual([
            'Song song-1',
            'Song song-2',
            'Song song-3',
        ]);
        expect(patch.queueIndex).toBe(0);

        // Same queue on the next state tick: no second hydration round-trip.
        await ensureQueueHydrated(['song-1', 'song-2', 'song-3'], 0);
        expect(mocks.hydrateSongs).toHaveBeenCalledTimes(1);
    });

    it('later frames build the queue from the hydrated cache (no stub regression)', async () => {
        const state = baseState({ qIds: ['song-1', 'song-2'], qIdx: 0 });
        peerStateToMirrored(state);
        await ensureQueueHydrated(['song-1', 'song-2'], 0);

        const next = peerStateToMirrored(baseState({ qIds: ['song-1', 'song-2'], qIdx: 1 }));
        expect((next.queue as any[]).map((s) => s.name)).toEqual(['Song song-1', 'Song song-2']);
    });

    it('skips the store patch when the queue changed while hydrating', async () => {
        mocks.storeState.mirrored = { queue: [{ id: 'different' }] };
        await ensureQueueHydrated(['song-9'], 0);
        expect(mocks.applyMirrorFromServer).not.toHaveBeenCalled();
    });
});
