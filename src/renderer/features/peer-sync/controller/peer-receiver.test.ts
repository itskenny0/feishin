/**
 * Unit tests for the MQTT command receiver.
 *
 * Two halves:
 *
 *   - Verb → player-store-action mapping: every verb in the protocol
 *     should produce the correct mutation, and bad payloads should
 *     drop with `validation`.
 *
 *   - Authorisation gate: enabled flag, self-peer guard, presence
 *     freshness — these are the rules `isAuthorisedSender` enforces.
 *
 *   - Re-emission loop protection: applying any verb opens the
 *     suppression window, so a hypothetical publisher hooked to the
 *     store would see "skip publish".
 *
 * The receiver imports useSettingsStore + useAuthStore + useRemoteTargetStore
 * indirectly. We don't mock those — we drive their real Zustand stores
 * with `setState`, which is the same path the app uses at runtime.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    __resetInboundApply,
    isInboundApplyActive,
} from '/@/renderer/features/peer-sync/controller/peer-loop-guard';
import {
    applyPeerCommand,
    isAuthorisedSender,
} from '/@/renderer/features/peer-sync/controller/peer-receiver';
import {
    __resetForTests,
    recordPresence,
    setSyncEnabled,
} from '/@/renderer/features/peer-sync/controller/transport-selector';
import { buildCommand } from '/@/renderer/features/peer-sync/protocol/builders';
import { PeerAddress } from '/@/renderer/features/peer-sync/protocol/topics';
import { PeerCommand } from '/@/renderer/features/peer-sync/types';
import { useAuthStore } from '/@/renderer/store/auth.store';
import { usePlayerStoreBase } from '/@/renderer/store/player.store';
import { useSettingsStore } from '/@/renderer/store/settings.store';
import { ServerType, Song } from '/@/shared/types/domain-types';
import { PlayerRepeat, PlayerShuffle, PlayerStatus } from '/@/shared/types/types';

const SENDER: PeerAddress = { peerId: 'peer-from', userId: 'user-abc' };

// The async queue-replace path lazy-imports remote-target-api.hydrateSongs
// (JF-only network call). Mock it so the receiver's append/replace branches
// can be driven end-to-end: hydrateSongs echoes the requested itemIds as
// minimal Song objects (toQueueSong inside the store adds the _uniqueId).
vi.mock('/@/renderer/features/jellyfin-remote-target/api/remote-target-api', async () => {
    const actual = await vi.importActual<
        typeof import('/@/renderer/features/jellyfin-remote-target/api/remote-target-api')
    >('/@/renderer/features/jellyfin-remote-target/api/remote-target-api');
    return {
        ...actual,
        remoteTargetApi: {
            ...actual.remoteTargetApi,
            hydrateSongs: vi.fn(async ({ itemIds }: { itemIds: string[] }) =>
                itemIds.map(
                    (id) =>
                        ({
                            album: 'A',
                            albumArtists: [],
                            artists: [],
                            container: null,
                            duration: 1000,
                            id,
                            itemType: 'song',
                            name: id,
                        }) as unknown as Song,
                ),
            ),
        },
    };
});

const enableSync = () => {
    useSettingsStore.setState((state) => ({
        peerSync: {
            ...state.peerSync,
            enabled: true,
            jellyfinRemoteEnabled: true,
            peerId: 'peer-self',
        },
    }));
    setSyncEnabled(true);
    recordPresence(SENDER.peerId, true);
};

const seedAuth = () => {
    useAuthStore.setState({
        currentServer: {
            credential: 'cred',
            id: 'srv-1',
            name: 'demo',
            ndCredential: '',
            type: ServerType.JELLYFIN,
            url: 'https://demo.jellyfin.org/stable',
            userId: 'user-abc',
            username: 'demo',
        } as unknown as ReturnType<typeof useAuthStore.getState>['currentServer'],
    });
};

beforeEach(async () => {
    // Drain any fire-and-forget hydrate kicked off by a prior test's queue
    // verb (the receiver returns synchronously while hydrateSongs resolves on
    // a later tick) so a late insert can't leak into the next assertion.
    await import('/@/renderer/features/jellyfin-remote-target/api/remote-target-api');
    await new Promise((res) => setTimeout(res, 20));
    __resetForTests();
    __resetInboundApply();
    // Reset relevant slices of the player store between tests so a
    // mutation from one verb doesn't leak into the next assertion.
    usePlayerStoreBase.setState((state) => {
        state.player.status = PlayerStatus.PAUSED;
        state.player.muted = false;
        state.player.volume = 50;
        state.player.repeat = PlayerRepeat.NONE;
        state.player.shuffle = PlayerShuffle.NONE;
        state.player.index = 0;
    });
    // Clear any queue left behind by a previous test's hydrate.
    usePlayerStoreBase.getState().setQueue([], 0, 0);
    seedAuth();
    enableSync();
});

describe('isAuthorisedSender', () => {
    it('blocks when peer sync is disabled', () => {
        useSettingsStore.setState((state) => ({
            peerSync: { ...state.peerSync, enabled: false },
        }));
        expect(isAuthorisedSender(SENDER)).toBe(false);
    });

    it('blocks when jellyfinRemoteEnabled is off', () => {
        useSettingsStore.setState((state) => ({
            peerSync: { ...state.peerSync, jellyfinRemoteEnabled: false },
        }));
        expect(isAuthorisedSender(SENDER)).toBe(false);
    });

    it('blocks the self peer', () => {
        const self: PeerAddress = { peerId: 'peer-self', userId: 'user-abc' };
        recordPresence(self.peerId, true);
        expect(isAuthorisedSender(self)).toBe(false);
    });

    it('blocks an unknown / never-seen peer', () => {
        const stranger: PeerAddress = { peerId: 'peer-stranger', userId: 'user-abc' };
        expect(isAuthorisedSender(stranger)).toBe(false);
    });

    it('allows a peer with fresh presence + sync on', () => {
        expect(isAuthorisedSender(SENDER)).toBe(true);
    });
});

describe('applyPeerCommand verb mapping', () => {
    it('maps pause to mediaPause (status -> paused)', () => {
        usePlayerStoreBase.setState((state) => {
            state.player.status = PlayerStatus.PLAYING;
        });
        const r = applyPeerCommand(SENDER, buildCommand('pause'));
        expect(r.reason).toBe('applied');
        expect(usePlayerStoreBase.getState().player.status).toBe(PlayerStatus.PAUSED);
    });

    it('maps play (no args) to mediaPlay (status -> playing)', () => {
        const r = applyPeerCommand(SENDER, buildCommand('play'));
        expect(r.reason).toBe('applied');
        expect(usePlayerStoreBase.getState().player.status).toBe(PlayerStatus.PLAYING);
    });

    it('maps seek to mediaSeekToTimestamp (ms -> seconds)', () => {
        const calls: number[] = [];
        const original = usePlayerStoreBase.getState().mediaSeekToTimestamp;
        usePlayerStoreBase.setState({
            mediaSeekToTimestamp: (timestamp: number) => calls.push(timestamp),
        });
        try {
            const r = applyPeerCommand(SENDER, buildCommand('seek', { positionMs: 12_500 }));
            expect(r.reason).toBe('applied');
            // 12_500ms → 12.5s
            expect(calls).toEqual([12.5]);
        } finally {
            usePlayerStoreBase.setState({ mediaSeekToTimestamp: original });
        }
    });

    it('maps volume to setVolume and clamps to 0-100', () => {
        const r = applyPeerCommand(SENDER, buildCommand('volume', { volume: 150 }));
        expect(r.reason).toBe('applied');
        // clamped
        expect(usePlayerStoreBase.getState().player.volume).toBe(100);

        const r2 = applyPeerCommand(SENDER, buildCommand('volume', { volume: -10 }));
        expect(r2.reason).toBe('applied');
        expect(usePlayerStoreBase.getState().player.volume).toBe(0);

        const r3 = applyPeerCommand(SENDER, buildCommand('volume', { volume: 35 }));
        expect(r3.reason).toBe('applied');
        expect(usePlayerStoreBase.getState().player.volume).toBe(35);
    });

    it('maps mute (true) to a toggle when currently unmuted', () => {
        // store starts unmuted in beforeEach
        const r = applyPeerCommand(SENDER, buildCommand('mute', { mute: true }));
        expect(r.reason).toBe('applied');
        expect(usePlayerStoreBase.getState().player.muted).toBe(true);
    });

    it('maps mute (false) to no-op when already unmuted', () => {
        let calls = 0;
        const original = usePlayerStoreBase.getState().mediaToggleMute;
        usePlayerStoreBase.setState({
            mediaToggleMute: () => {
                calls += 1;
            },
        });
        try {
            const r = applyPeerCommand(SENDER, buildCommand('mute', { mute: false }));
            expect(r.reason).toBe('applied');
            expect(calls).toBe(0);
        } finally {
            usePlayerStoreBase.setState({ mediaToggleMute: original });
        }
    });

    it('maps shuffle (true) to setShuffle(TRACK)', () => {
        const r = applyPeerCommand(SENDER, buildCommand('shuffle', { shuffle: true }));
        expect(r.reason).toBe('applied');
        expect(usePlayerStoreBase.getState().player.shuffle).toBe(PlayerShuffle.TRACK);
    });

    it('maps shuffle (false) to setShuffle(NONE)', () => {
        usePlayerStoreBase.setState((state) => {
            state.player.shuffle = PlayerShuffle.TRACK;
        });
        const r = applyPeerCommand(SENDER, buildCommand('shuffle', { shuffle: false }));
        expect(r.reason).toBe('applied');
        expect(usePlayerStoreBase.getState().player.shuffle).toBe(PlayerShuffle.NONE);
    });

    it('maps repeat (all|one|off) to PlayerRepeat ALL|ONE|NONE', () => {
        applyPeerCommand(SENDER, buildCommand('repeat', { mode: 'all' }));
        expect(usePlayerStoreBase.getState().player.repeat).toBe(PlayerRepeat.ALL);

        applyPeerCommand(SENDER, buildCommand('repeat', { mode: 'one' }));
        expect(usePlayerStoreBase.getState().player.repeat).toBe(PlayerRepeat.ONE);

        applyPeerCommand(SENDER, buildCommand('repeat', { mode: 'off' }));
        expect(usePlayerStoreBase.getState().player.repeat).toBe(PlayerRepeat.NONE);
    });

    it('maps next to mediaNext', () => {
        let calls = 0;
        const original = usePlayerStoreBase.getState().mediaNext;
        usePlayerStoreBase.setState({
            mediaNext: () => {
                calls += 1;
            },
        });
        try {
            const r = applyPeerCommand(SENDER, buildCommand('next'));
            expect(r.reason).toBe('applied');
            expect(calls).toBe(1);
        } finally {
            usePlayerStoreBase.setState({ mediaNext: original });
        }
    });

    it('maps prev to mediaPrevious', () => {
        let calls = 0;
        const original = usePlayerStoreBase.getState().mediaPrevious;
        usePlayerStoreBase.setState({
            mediaPrevious: () => {
                calls += 1;
            },
        });
        try {
            const r = applyPeerCommand(SENDER, buildCommand('prev'));
            expect(r.reason).toBe('applied');
            expect(calls).toBe(1);
        } finally {
            usePlayerStoreBase.setState({ mediaPrevious: original });
        }
    });

    it('maps playIndex to mediaPlayByIndex', () => {
        const args: number[] = [];
        const original = usePlayerStoreBase.getState().mediaPlayByIndex;
        usePlayerStoreBase.setState({
            mediaPlayByIndex: (index: number) => args.push(index),
        });
        try {
            const r = applyPeerCommand(SENDER, buildCommand('playIndex', { index: 7 }));
            expect(r.reason).toBe('applied');
            expect(args).toEqual([7]);
        } finally {
            usePlayerStoreBase.setState({ mediaPlayByIndex: original });
        }
    });

    // SEV-3: playIndex is a DEFAULT-order index. With shuffle ON the receiver's
    // mediaPlayByIndex must select the song at DEFAULT index N (then map it to
    // the shuffled playback position internally) — NOT the shuffled position N.
    it('playIndex selects the DEFAULT-order song even with shuffle on (SEV-3)', () => {
        const songs: Song[] = Array.from(
            { length: 5 },
            (_, i) =>
                ({
                    album: 'A',
                    albumArtists: [],
                    artists: [],
                    container: null,
                    duration: 1000,
                    id: `song-${i}`,
                    itemType: 'song',
                    name: `Song ${i}`,
                }) as unknown as Song,
        );
        usePlayerStoreBase.getState().setQueue(songs, 0, 0);
        usePlayerStoreBase.getState().setShuffle(PlayerShuffle.TRACK);

        const r = applyPeerCommand(SENDER, buildCommand('playIndex', { index: 2 }));
        expect(r.reason).toBe('applied');
        // The current song must be the one at DEFAULT index 2, regardless of
        // where it landed in the shuffled order.
        expect(usePlayerStoreBase.getState().getCurrentSong()?.id).toBe('song-2');
    });

    it('drops a seek with a non-numeric positionMs as validation', () => {
        // Construct a deliberately malformed frame — the wire shape allows
        // it but the receiver should refuse to act.
        const bad = buildCommand('seek', { positionMs: 'oops' as unknown as number });
        const r = applyPeerCommand(SENDER, bad);
        expect(r.reason).toBe('dropped-validation');
    });

    it('drops playIndex / seek / volume with non-finite numbers (NaN / Infinity)', () => {
        // Spy the three store actions so we can assert they are never invoked
        // for a non-finite payload (the JSON codec masks this today, but a
        // future binary codec could carry NaN/Infinity).
        const calls = { playIndex: 0, seek: 0, volume: 0 };
        const originals = {
            mediaPlayByIndex: usePlayerStoreBase.getState().mediaPlayByIndex,
            mediaSeekToTimestamp: usePlayerStoreBase.getState().mediaSeekToTimestamp,
            setVolume: usePlayerStoreBase.getState().setVolume,
        };
        usePlayerStoreBase.setState({
            mediaPlayByIndex: () => {
                calls.playIndex += 1;
            },
            mediaSeekToTimestamp: () => {
                calls.seek += 1;
            },
            setVolume: () => {
                calls.volume += 1;
            },
        });
        try {
            for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
                expect(
                    applyPeerCommand(SENDER, buildCommand('playIndex', { index: bad })).reason,
                ).toBe('dropped-validation');
                expect(
                    applyPeerCommand(SENDER, buildCommand('seek', { positionMs: bad })).reason,
                ).toBe('dropped-validation');
                expect(
                    applyPeerCommand(SENDER, buildCommand('volume', { volume: bad })).reason,
                ).toBe('dropped-validation');
            }
            expect(calls).toEqual({ playIndex: 0, seek: 0, volume: 0 });
        } finally {
            usePlayerStoreBase.setState(originals);
        }
    });

    it('drops a repeat with an unknown mode as validation', () => {
        const bad = {
            ...buildCommand('repeat', { mode: 'all' }),
            a: { mode: 'cha-cha' as 'all' },
        } as PeerCommand;
        const r = applyPeerCommand(SENDER, bad);
        expect(r.reason).toBe('dropped-validation');
    });

    it('drops an unknown verb as unsupported', () => {
        const weird = {
            ...buildCommand('pause'),
            k: 'rewind3x' as unknown as PeerCommand['k'],
        } as PeerCommand;
        const r = applyPeerCommand(SENDER, weird);
        expect(r.reason).toBe('dropped-unsupported');
    });

    it('maps rate to setSpeed with the wire value', () => {
        const calls: number[] = [];
        const original = usePlayerStoreBase.getState().setSpeed;
        usePlayerStoreBase.setState({
            setSpeed: (speed: number) => calls.push(speed),
        });
        try {
            const r = applyPeerCommand(SENDER, buildCommand('rate', { rate: 1.5 }));
            expect(r.reason).toBe('applied');
            expect(calls).toEqual([1.5]);
        } finally {
            usePlayerStoreBase.setState({ setSpeed: original });
        }
    });

    it('drops a rate with a non-numeric / non-finite value as validation', () => {
        const bad = buildCommand('rate', {
            rate: 'fast' as unknown as number,
        });
        expect(applyPeerCommand(SENDER, bad).reason).toBe('dropped-validation');
        const nan = buildCommand('rate', { rate: Number.NaN });
        expect(applyPeerCommand(SENDER, nan).reason).toBe('dropped-validation');
    });

    it('maps lyrics(true|false) to the showLyricsInSidebar setting', () => {
        // Seed the opposite value so we can prove we actually flipped it.
        useSettingsStore.setState((state) => {
            state.general.showLyricsInSidebar = false;
        });
        const r = applyPeerCommand(SENDER, buildCommand('lyrics', { visible: true }));
        expect(r.reason).toBe('applied');
        expect(useSettingsStore.getState().general.showLyricsInSidebar).toBe(true);

        const r2 = applyPeerCommand(SENDER, buildCommand('lyrics', { visible: false }));
        expect(r2.reason).toBe('applied');
        expect(useSettingsStore.getState().general.showLyricsInSidebar).toBe(false);
    });

    it('drops a lyrics frame with a non-boolean visible field as validation', () => {
        const bad = buildCommand('lyrics', {
            visible: 'yes' as unknown as boolean,
        });
        expect(applyPeerCommand(SENDER, bad).reason).toBe('dropped-validation');
    });
});

/**
 * Queue mutation verbs (`queueInsert / queueRemove / queueReorder`).
 *
 * The receiver translates wire indices into uniqueId-based store actions
 * (`addToQueueByUniqueId`, `clearSelected`, `moveSelectedTo`). The tests
 * here seed the store directly via `setQueue` instead of going through the
 * (async, JF-only) hydrate path so the assertions stay synchronous.
 */
const seedQueue = (count: number): void => {
    const songs: Song[] = Array.from(
        { length: count },
        (_, i) =>
            ({
                album: 'A',
                albumArtists: [],
                artists: [],
                container: null,
                duration: 1000,
                id: `song-${i}`,
                itemType: 'song',
                name: `Song ${i}`,
                // `_uniqueId` is added by toQueueSong inside setQueue. The
                // shape we pass here mirrors what hydrateSongs would return.
            }) as unknown as Song,
    );
    usePlayerStoreBase.getState().setQueue(songs, 0, 0);
};

describe('applyPeerCommand queueRemove', () => {
    it('removes the songs at the given indices from the default queue', () => {
        seedQueue(5);
        const initialIds = usePlayerStoreBase
            .getState()
            .getQueueOrder()
            .items.map((s) => s.id);
        expect(initialIds).toEqual(['song-0', 'song-1', 'song-2', 'song-3', 'song-4']);

        const r = applyPeerCommand(SENDER, buildCommand('queueRemove', { indices: [1, 3] }));
        expect(r.reason).toBe('applied');

        const after = usePlayerStoreBase
            .getState()
            .getQueueOrder()
            .items.map((s) => s.id);
        expect(after).toEqual(['song-0', 'song-2', 'song-4']);
    });

    it('skips out-of-range indices silently when at least one is in range', () => {
        seedQueue(3);
        const r = applyPeerCommand(SENDER, buildCommand('queueRemove', { indices: [0, 99, -1] }));
        expect(r.reason).toBe('applied');
        const after = usePlayerStoreBase
            .getState()
            .getQueueOrder()
            .items.map((s) => s.id);
        expect(after).toEqual(['song-1', 'song-2']);
    });

    it('drops with validation when ALL indices are out of range', () => {
        seedQueue(3);
        const r = applyPeerCommand(SENDER, buildCommand('queueRemove', { indices: [99, 100] }));
        expect(r.reason).toBe('dropped-validation');
    });

    it('drops a queueRemove with a non-array indices field', () => {
        const bad = buildCommand('queueRemove', {
            indices: 'all' as unknown as number[],
        });
        expect(applyPeerCommand(SENDER, bad).reason).toBe('dropped-validation');
    });

    it('drops a queueRemove with an empty indices array', () => {
        seedQueue(3);
        const r = applyPeerCommand(SENDER, buildCommand('queueRemove', { indices: [] }));
        expect(r.reason).toBe('dropped-validation');
    });

    it('drops a queueRemove whose indices array contains a non-number', () => {
        const bad = buildCommand('queueRemove', {
            indices: [0, 'one' as unknown as number, 2],
        });
        expect(applyPeerCommand(SENDER, bad).reason).toBe('dropped-validation');
    });
});

describe('applyPeerCommand queueReorder', () => {
    it('moves an item from index 3 forward to index 1', () => {
        seedQueue(5);
        const r = applyPeerCommand(SENDER, buildCommand('queueReorder', { from: 3, to: 1 }));
        expect(r.reason).toBe('applied');
        const ids = usePlayerStoreBase
            .getState()
            .getQueueOrder()
            .items.map((s) => s.id);
        // song-3 lands AT index 1; song-1, song-2 shift right by one.
        expect(ids).toEqual(['song-0', 'song-3', 'song-1', 'song-2', 'song-4']);
    });

    it('moves an item forward from index 1 to index 3 (lands AT index 3)', () => {
        seedQueue(5);
        const r = applyPeerCommand(SENDER, buildCommand('queueReorder', { from: 1, to: 3 }));
        expect(r.reason).toBe('applied');
        const ids = usePlayerStoreBase
            .getState()
            .getQueueOrder()
            .items.map((s) => s.id);
        // Forward move uses the 'bottom' edge to compensate for the
        // post-filter left-shift; song-1 must land exactly at index 3.
        expect(ids).toEqual(['song-0', 'song-2', 'song-3', 'song-1', 'song-4']);
    });

    it('moves an item forward to the adjacent slot (from 1 to 2)', () => {
        seedQueue(5);
        const r = applyPeerCommand(SENDER, buildCommand('queueReorder', { from: 1, to: 2 }));
        expect(r.reason).toBe('applied');
        const ids = usePlayerStoreBase
            .getState()
            .getQueueOrder()
            .items.map((s) => s.id);
        expect(ids).toEqual(['song-0', 'song-2', 'song-1', 'song-3', 'song-4']);
    });

    it('moves an item past the end via moveSelectedToBottom', () => {
        seedQueue(4);
        const r = applyPeerCommand(SENDER, buildCommand('queueReorder', { from: 1, to: 99 }));
        expect(r.reason).toBe('applied');
        const ids = usePlayerStoreBase
            .getState()
            .getQueueOrder()
            .items.map((s) => s.id);
        expect(ids).toEqual(['song-0', 'song-2', 'song-3', 'song-1']);
    });

    it('drops a no-op reorder where from === to as validation', () => {
        seedQueue(3);
        const r = applyPeerCommand(SENDER, buildCommand('queueReorder', { from: 1, to: 1 }));
        expect(r.reason).toBe('dropped-validation');
    });

    it('drops a reorder with from out of range', () => {
        seedQueue(3);
        const r = applyPeerCommand(SENDER, buildCommand('queueReorder', { from: 99, to: 0 }));
        expect(r.reason).toBe('dropped-validation');
    });

    it('drops a reorder with non-numeric from/to as validation', () => {
        const bad = buildCommand('queueReorder', {
            from: 'a' as unknown as number,
            to: 'b' as unknown as number,
        });
        expect(applyPeerCommand(SENDER, bad).reason).toBe('dropped-validation');
    });
});

describe('applyPeerCommand queueInsert', () => {
    it('drops with validation when the index is negative', () => {
        const bad = buildCommand('queueInsert', { index: -1, itemIds: ['x'] });
        expect(applyPeerCommand(SENDER, bad).reason).toBe('dropped-validation');
    });

    it('drops with validation when itemIds is empty', () => {
        const bad = buildCommand('queueInsert', { index: 0, itemIds: [] });
        expect(applyPeerCommand(SENDER, bad).reason).toBe('dropped-validation');
    });

    it('drops with validation when itemIds is missing', () => {
        // Missing itemIds entirely.
        const bad = {
            ...buildCommand('queueInsert', { index: 0, itemIds: ['x'] }),
            a: { index: 0 } as unknown as { index: number; itemIds: string[] },
        } as PeerCommand;
        expect(applyPeerCommand(SENDER, bad).reason).toBe('dropped-validation');
    });

    it('returns applied when the validation gate passes (async hydrate path)', () => {
        // We don't drive the hydrate end-to-end here — the dispatch
        // contract is: validation passes, the receiver kicks off the
        // async hydrate, and returns `applied`. The integration test for
        // the dispatcher → receiver pair will exercise the wire path.
        const r = applyPeerCommand(
            SENDER,
            buildCommand('queueInsert', { index: 0, itemIds: ['song-x'] }),
        );
        expect(r.reason).toBe('applied');
    });
});

/**
 * Queue-replace / append path (`play` verb carrying itemIds).
 *
 * The wire's playCommand decides the disposition: PlayNext/PlayLast APPEND
 * (mirroring the Jellyfin lane + the cold-queue handling in queueInsert),
 * while PlayNow/undefined fully REPLACE the queue via setQueue. These tests
 * await the async hydrate microtask before asserting on the queue.
 */
// The receiver lazy-imports remote-target-api the first time a queue verb
// fires; that first dynamic import resolves a tick later than a plain
// microtask. Warm the module here and give the await chain a real timer.
const flushHydrate = async () => {
    await import('/@/renderer/features/jellyfin-remote-target/api/remote-target-api');
    await new Promise((res) => setTimeout(res, 20));
};

describe('applyPeerCommand play (queue replace/append)', () => {
    it('PlayLast appends to a non-empty queue, leaving existing tracks + index intact', async () => {
        seedQueue(3); // song-0, song-1, song-2 — index 0
        const r = applyPeerCommand(
            SENDER,
            buildCommand('play', {
                itemIds: ['song-x', 'song-y'],
                playCommand: 'PlayLast',
            }),
        );
        expect(r.reason).toBe('applied');
        await flushHydrate();

        const ids = usePlayerStoreBase
            .getState()
            .getQueueOrder()
            .items.map((s) => s.id);
        expect(ids).toEqual(['song-0', 'song-1', 'song-2', 'song-x', 'song-y']);
        // Now-playing position is preserved (no replace).
        expect(usePlayerStoreBase.getState().player.index).toBe(0);
    });

    it('PlayNext inserts after the current track (player.index)', async () => {
        seedQueue(3); // song-0, song-1, song-2 — index 0
        const r = applyPeerCommand(
            SENDER,
            buildCommand('play', {
                itemIds: ['song-x', 'song-y'],
                playCommand: 'PlayNext',
            }),
        );
        expect(r.reason).toBe('applied');
        await flushHydrate();

        const ids = usePlayerStoreBase
            .getState()
            .getQueueOrder()
            .items.map((s) => s.id);
        // New tracks land directly after index 0 (song-0).
        expect(ids).toEqual(['song-0', 'song-x', 'song-y', 'song-1', 'song-2']);
        expect(usePlayerStoreBase.getState().player.index).toBe(0);
    });

    it('PlayNow replaces the whole queue and resets the index', async () => {
        seedQueue(3); // song-0, song-1, song-2 — index 2
        usePlayerStoreBase.setState((state) => {
            state.player.index = 2;
        });
        const r = applyPeerCommand(
            SENDER,
            buildCommand('play', {
                itemIds: ['song-x', 'song-y'],
                playCommand: 'PlayNow',
            }),
        );
        expect(r.reason).toBe('applied');
        await flushHydrate();

        const ids = usePlayerStoreBase
            .getState()
            .getQueueOrder()
            .items.map((s) => s.id);
        expect(ids).toEqual(['song-x', 'song-y']);
        expect(usePlayerStoreBase.getState().player.index).toBe(0);
    });

    it('an undefined playCommand still replaces (default PlayNow semantics)', async () => {
        seedQueue(3);
        const r = applyPeerCommand(SENDER, buildCommand('play', { itemIds: ['song-x'] }));
        expect(r.reason).toBe('applied');
        await flushHydrate();

        const ids = usePlayerStoreBase
            .getState()
            .getQueueOrder()
            .items.map((s) => s.id);
        expect(ids).toEqual(['song-x']);
    });

    it('PlayLast on a cold (empty) queue falls back to setQueue', async () => {
        // Empty the queue first.
        usePlayerStoreBase.getState().setQueue([], 0, 0);
        const r = applyPeerCommand(
            SENDER,
            buildCommand('play', {
                itemIds: ['song-x', 'song-y'],
                playCommand: 'PlayLast',
            }),
        );
        expect(r.reason).toBe('applied');
        await flushHydrate();

        const ids = usePlayerStoreBase
            .getState()
            .getQueueOrder()
            .items.map((s) => s.id);
        expect(ids).toEqual(['song-x', 'song-y']);
    });
});

describe('applyPeerCommand authorisation drops', () => {
    it('drops when sync is disabled', () => {
        useSettingsStore.setState((state) => ({
            peerSync: { ...state.peerSync, enabled: false },
        }));
        let calls = 0;
        const original = usePlayerStoreBase.getState().mediaPause;
        usePlayerStoreBase.setState({
            mediaPause: () => {
                calls += 1;
            },
        });
        try {
            const r = applyPeerCommand(SENDER, buildCommand('pause'));
            expect(r.reason).toBe('dropped-disabled');
            expect(calls).toBe(0);
        } finally {
            usePlayerStoreBase.setState({ mediaPause: original });
        }
    });

    it('drops when the sender is ourselves', () => {
        const self: PeerAddress = { peerId: 'peer-self', userId: 'user-abc' };
        recordPresence(self.peerId, true);
        const r = applyPeerCommand(self, buildCommand('pause'));
        expect(r.reason).toBe('dropped-self');
    });

    it('drops when the sender has no fresh presence', () => {
        const stranger: PeerAddress = { peerId: 'peer-stranger', userId: 'user-abc' };
        const r = applyPeerCommand(stranger, buildCommand('pause'));
        expect(r.reason).toBe('dropped-stale-peer');
    });
});

describe('re-emission loop protection', () => {
    it('opens the inbound-apply suppression window when a verb is applied', () => {
        expect(isInboundApplyActive()).toBe(false);
        applyPeerCommand(SENDER, buildCommand('pause'));
        expect(isInboundApplyActive()).toBe(true);
    });

    it('does NOT open the window for a dropped command', () => {
        useSettingsStore.setState((state) => ({
            peerSync: { ...state.peerSync, enabled: false },
        }));
        applyPeerCommand(SENDER, buildCommand('pause'));
        expect(isInboundApplyActive()).toBe(false);
    });

    it('expires after the configured window', () => {
        const t0 = 1_000_000;
        // Open the window at t0.
        const r = applyPeerCommand(SENDER, buildCommand('pause'));
        expect(r.reason).toBe('applied');
        expect(isInboundApplyActive(t0)).toBe(true);
        // After 250ms we should be back to "publish freely".
        expect(isInboundApplyActive(Date.now() + 250)).toBe(false);
    });
});

describe('integration: inbound play resumes a paused local player', () => {
    it('moves status from PAUSED to PLAYING when an inbound play arrives', () => {
        usePlayerStoreBase.setState((state) => {
            state.player.status = PlayerStatus.PAUSED;
        });
        applyPeerCommand(SENDER, buildCommand('play'));
        expect(usePlayerStoreBase.getState().player.status).toBe(PlayerStatus.PLAYING);
    });

    it('does not bubble an outbound publish (loop guard set)', () => {
        applyPeerCommand(SENDER, buildCommand('play'));
        expect(isInboundApplyActive()).toBe(true);
    });
});
