// Offline play-guard.
//
// While OFFLINE only downloaded songs can actually play (use-stream-url serves
// a local blob; a non-downloaded song resolves to a dead network URL). This
// pure helper decides, for a play request, whether it may proceed and which
// songs are actually playable — so the player context can show a clear
// "not available offline" toast instead of silently handing the audio element
// a dead URL.
//
// Pure + side-effect free so the decision is unit-testable in isolation; the
// caller owns the toast + the queue mutation.

const TAG = '[offline-ux]';

export interface OfflineGuardInput<T extends OfflineGuardSong> {
    /** Reports whether a given song has a downloaded blob available offline. */
    isAvailable: (serverId: string, songId: string) => boolean;
    /** Combined connectivity signal (navigator.onLine AND server reachable). */
    online: boolean;
    /**
     * When the request targets ONE specific song within `songs` (e.g. a row tap
     * or queue jump), its id. If that exact song is unavailable offline the
     * whole request is blocked, mirroring the user's intent ("play THIS").
     */
    playSongId?: string;
    /** The songs the request wants to enqueue/play. */
    songs: readonly T[];
}

export interface OfflineGuardResult<T extends OfflineGuardSong> {
    /** False → caller should show the offline toast and abort. */
    allowed: boolean;
    /**
     * The subset of `songs` that can actually play. Equals `songs` when online.
     * When offline it is the downloaded-only subset (used for multi-song adds
     * where some tracks are downloaded and some aren't).
     */
    playable: T[];
}

export interface OfflineGuardSong {
    _serverId: string;
    id: string;
}

/**
 * Decide whether an offline play request may proceed.
 *
 * - ONLINE → always allowed, every song playable (unchanged behaviour).
 * - OFFLINE + a specific `playSongId` that isn't downloaded → blocked.
 * - OFFLINE + no downloaded songs in the request at all → blocked.
 * - OFFLINE + at least one downloaded song → allowed, narrowed to the
 *   downloaded subset.
 */
export const selectOfflinePlayable = <T extends OfflineGuardSong>(
    input: OfflineGuardInput<T>,
): OfflineGuardResult<T> => {
    const { isAvailable, online, playSongId, songs } = input;

    if (online) {
        return { allowed: true, playable: [...songs] };
    }

    // The explicitly-targeted song must itself be downloaded — "play THIS"
    // can't fall back to a neighbour.
    if (playSongId) {
        const target = songs.find((s) => s.id === playSongId);
        if (target && !isAvailable(target._serverId, target.id)) {
            console.info(`${TAG} play blocked: targeted song unavailable offline`, {
                songId: playSongId,
            });
            return { allowed: false, playable: [] };
        }
    }

    const playable = songs.filter((s) => isAvailable(s._serverId, s.id));
    if (playable.length === 0) {
        console.info(`${TAG} play blocked: no downloaded songs in request`, {
            requested: songs.length,
        });
        return { allowed: false, playable: [] };
    }

    if (playable.length !== songs.length) {
        console.info(`${TAG} play narrowed to downloaded subset`, {
            playable: playable.length,
            requested: songs.length,
        });
    }
    return { allowed: true, playable };
};
