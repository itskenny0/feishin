/**
 * Outbound state publisher (D1 / SEV-2).
 *
 * The receiver side of the MQTT lane (peer-state-mirror) was fully wired —
 * gates, RTT offset, stub queue — but nothing ever PUBLISHED a `state` frame,
 * so the entire mirror path was dead in production. This module closes that
 * gap: it subscribes the local player store (+ the timestamp store for the
 * sub-second playhead) and emits a retained `state` frame so any peer that has
 * picked THIS instance as its Connect target can mirror our playback.
 *
 * Design:
 *   - One subscription per process; `startStatePublisher` is idempotent.
 *   - Throttled to PUBLISH_THROTTLE_MS (~2 Hz) for high-frequency churn
 *     (position ticks), with an immediate EDGE publish on the things a human
 *     notices instantly: track change, pause/resume, shuffle/repeat/mute, and
 *     a discrete seek. The throttle is leading+trailing so the final value of a
 *     burst always lands.
 *   - Gated on `isSyncEnabled()` AND a live broker connection. When sync is off
 *     or we're disconnected we publish nothing (the retained frame we last
 *     pushed is cleared by stopPeerClient's teardown).
 *   - The loop guard is consulted INSIDE `publishOwnState`: when we're in the
 *     middle of applying an inbound command the publish is suppressed so an
 *     inbound pause→our-state-echo→their-re-apply ping-pong can't form.
 *
 * Index-space contract (SEV-3): `qIds` and `qIdx` are emitted in DEFAULT
 * (non-shuffle) queue order — the same order `getQueueOrder().items` returns
 * and the same order the receiver's `mediaPlayByIndex` / queue verbs interpret.
 * The now-playing item's index is resolved by `_uniqueId` against that default
 * order, so a target with shuffle ON still publishes a default-order qIdx that
 * the controller can mirror and act on without a shuffled-vs-visible mismatch.
 */
import {
    isPeerClientConnected,
    publishOwnState,
} from '/@/renderer/features/peer-sync/controller/peer-client';
import { INBOUND_APPLY_WINDOW_MS } from '/@/renderer/features/peer-sync/controller/peer-loop-guard';
import { isSyncEnabled } from '/@/renderer/features/peer-sync/controller/transport-selector';
import { buildState, jellyfinToPeerRepeat } from '/@/renderer/features/peer-sync/protocol/builders';
import { PeerRepeatMode, PeerTrack } from '/@/renderer/features/peer-sync/types';
import { usePlayerStoreBase } from '/@/renderer/store/player.store';
import { useTimestampStoreBase } from '/@/renderer/store/timestamp.store';
import { QueueSong } from '/@/shared/types/domain-types';
import { PlayerRepeat, PlayerShuffle, PlayerStatus } from '/@/shared/types/types';

const log = (...args: unknown[]) => console.info('[peer-sync]', ...args);

/** Minimum gap between throttled (position-driven) publishes — ~2 Hz. */
export const PUBLISH_THROTTLE_MS = 500;
/** Cap the queue id list we put on the wire. Matches the builder's own cap. */
const MAX_QUEUE_IDS = 200;

/** Map the store's PlayerRepeat enum to the compact wire enum. */
const repeatToWire = (repeat: PlayerRepeat): PeerRepeatMode => {
    if (repeat === PlayerRepeat.ALL) return jellyfinToPeerRepeat('RepeatAll');
    if (repeat === PlayerRepeat.ONE) return jellyfinToPeerRepeat('RepeatOne');
    return jellyfinToPeerRepeat('RepeatNone');
};

const toPeerTrack = (song: QueueSong | undefined): null | PeerTrack => {
    if (!song) return null;
    return {
        album: song.album ?? null,
        art: song.imageUrl ?? null,
        artist: song.artistName ?? song.albumArtists?.[0]?.name ?? null,
        id: song.id,
        title: song.name ?? null,
    };
};

/**
 * A flat, comparable snapshot of the fields that drive an EDGE publish. Used to
 * detect "something a human notices changed" between store mutations so we can
 * publish immediately instead of waiting for the throttle window.
 */
interface EdgeSnapshot {
    isMuted: boolean;
    isPaused: boolean;
    repeat: PlayerRepeat;
    shuffle: PlayerShuffle;
    speed: number;
    trackId: null | string;
    volume: number;
}

const snapshotEdge = (): EdgeSnapshot => {
    const state = usePlayerStoreBase.getState();
    const song = state.getCurrentSong();
    return {
        isMuted: state.player.muted,
        isPaused: state.player.status !== PlayerStatus.PLAYING,
        repeat: state.player.repeat,
        shuffle: state.player.shuffle,
        speed: state.player.speed,
        trackId: song?.id ?? null,
        volume: state.player.volume,
    };
};

const edgesDiffer = (a: EdgeSnapshot, b: EdgeSnapshot): boolean =>
    a.trackId !== b.trackId ||
    a.isPaused !== b.isPaused ||
    a.isMuted !== b.isMuted ||
    a.shuffle !== b.shuffle ||
    a.repeat !== b.repeat ||
    a.volume !== b.volume ||
    a.speed !== b.speed;

/**
 * Build a `PeerState` from the current player + queue. Position is read from
 * the timestamp store (seconds) and converted to ms for the wire. Queue ids /
 * index are emitted in DEFAULT order (SEV-3).
 */
const buildCurrentState = () => {
    const state = usePlayerStoreBase.getState();
    const song = state.getCurrentSong();
    const positionSec = useTimestampStoreBase.getState().timestamp;

    // Default-order queue (shuffle-agnostic) — the index space the receiver's
    // playIndex / queue verbs operate in.
    const order = state.getQueueOrder().items;
    const qIds = order.slice(0, MAX_QUEUE_IDS).map((s) => s.id);
    // Resolve the now-playing item's position in default order by _uniqueId so
    // shuffle ON doesn't ship a shuffled position.
    const qIdx = song
        ? state.getQueueOrder().items.findIndex((s) => s._uniqueId === song._uniqueId)
        : -1;

    return buildState({
        // `song.duration` is ALREADY milliseconds for every server (the
        // jellyfin/navidrome/subsonic normalizers all yield ms), so it must NOT
        // be scaled again — it's the same unit as `pos` (positionSec * 1000) and
        // the wire `dur` contract (PeerState.dur is ms). Scaling it produced a
        // ms×1000 duration the controller rendered as ~2:04:06:24.
        dur: song?.duration ?? 0,
        mut: state.player.muted,
        paused: state.player.status !== PlayerStatus.PLAYING,
        pos: Math.max(0, Math.round(positionSec * 1000)),
        qIds: qIds.length > 0 ? qIds : undefined,
        qIdx: qIds.length > 0 ? qIdx : undefined,
        rate: state.player.speed,
        rep: repeatToWire(state.player.repeat),
        shuf: state.player.shuffle === PlayerShuffle.TRACK,
        track: toPeerTrack(song),
        vol: state.player.volume,
    });
};

let unsubPlayer: (() => void) | null = null;
let unsubTimestamp: (() => void) | null = null;
let throttleTimer: null | ReturnType<typeof setTimeout> = null;
let inboundRetryTimer: null | ReturnType<typeof setTimeout> = null;
let lastPublishAt = 0;
let lastEdge: EdgeSnapshot | null = null;

/** Publish now and reset the throttle bookkeeping. */
const publishNow = (): void => {
    if (!isSyncEnabled() || !isPeerClientConnected()) return;
    if (throttleTimer) {
        clearTimeout(throttleTimer);
        throttleTimer = null;
    }
    // publishOwnState consults the loop guard at the single publish chokepoint
    // and returns false when the inbound-apply window suppressed the frame.
    const published = publishOwnState(buildCurrentState());
    if (published) {
        lastPublishAt = Date.now();
        lastEdge = snapshotEdge();
        return;
    }
    // Suppressed by the loop guard (we're mid-applying an inbound command).
    // Do NOT advance lastEdge/lastPublishAt — otherwise the settled
    // post-command state (e.g. the pause we just applied for a controller) is
    // recorded as already-published and never re-sent, so the controller's
    // mirror snaps back to our stale retained frame when its optimistic hold
    // expires. Re-arm a single trailing publish just past the window so the
    // confirmed state lands; if the window was extended by a burst, that
    // publish is suppressed again and re-arms until the burst ends.
    if (!inboundRetryTimer) {
        inboundRetryTimer = setTimeout(() => {
            inboundRetryTimer = null;
            schedulePublish();
        }, INBOUND_APPLY_WINDOW_MS + 20);
    }
};

/**
 * Schedule a throttled publish. Leading+trailing: if we haven't published
 * within PUBLISH_THROTTLE_MS we go immediately; otherwise we arm a trailing
 * timer so the final value of a burst still lands. An edge change bypasses the
 * throttle entirely (publish now).
 */
const schedulePublish = (): void => {
    if (!isSyncEnabled() || !isPeerClientConnected()) return;

    const edge = snapshotEdge();
    const isEdge = !lastEdge || edgesDiffer(lastEdge, edge);
    if (isEdge) {
        publishNow();
        return;
    }

    const elapsed = Date.now() - lastPublishAt;
    if (elapsed >= PUBLISH_THROTTLE_MS) {
        publishNow();
        return;
    }
    if (throttleTimer) return; // trailing publish already armed
    throttleTimer = setTimeout(() => {
        throttleTimer = null;
        publishNow();
    }, PUBLISH_THROTTLE_MS - elapsed);
};

/**
 * Start mirroring the local player onto the MQTT `state` topic. Idempotent —
 * a second call while already running is a no-op. Mounted from `use-peer-sync`
 * alongside the client lifecycle.
 */
export const startStatePublisher = (): void => {
    if (unsubPlayer) return; // already running
    log('state publisher started');
    lastEdge = null;
    lastPublishAt = 0;
    if (inboundRetryTimer) {
        clearTimeout(inboundRetryTimer);
        inboundRetryTimer = null;
    }
    // Player mutations: track change, pause/resume, queue edits, shuffle/repeat,
    // volume/mute, rate. zustand fires the listener on every set().
    unsubPlayer = usePlayerStoreBase.subscribe(() => schedulePublish());
    // Sub-second playhead: the timestamp store ticks far more often than the
    // player store mutates, so it's the high-frequency source the throttle
    // exists to tame. It never carries an edge field, so it always goes through
    // the throttle, never the immediate edge path.
    unsubTimestamp = useTimestampStoreBase.subscribe(() => schedulePublish());
    // Emit an initial snapshot so a controller that picks us right after boot
    // gets the retained truth immediately instead of waiting for the next tick.
    publishNow();
};

/** Stop mirroring. Idempotent. */
export const stopStatePublisher = (): void => {
    if (!unsubPlayer && !unsubTimestamp && !throttleTimer && !inboundRetryTimer) return;
    log('state publisher stopped');
    unsubPlayer?.();
    unsubTimestamp?.();
    unsubPlayer = null;
    unsubTimestamp = null;
    if (throttleTimer) {
        clearTimeout(throttleTimer);
        throttleTimer = null;
    }
    if (inboundRetryTimer) {
        clearTimeout(inboundRetryTimer);
        inboundRetryTimer = null;
    }
    lastEdge = null;
    lastPublishAt = 0;
};

/** Test-only: whether the publisher subscription is currently active. */
export const __isStatePublisherRunning = (): boolean => Boolean(unsubPlayer);
