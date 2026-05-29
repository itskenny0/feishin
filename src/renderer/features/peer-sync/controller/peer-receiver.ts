/**
 * Inbound command receiver.
 *
 * Translates `PeerCommand` frames that arrive over MQTT into local
 * player-store mutations. The wire surface (`peer-client.ts` →
 * `handleMessage`) decodes the frame and forwards it to `use-peer-sync`'s
 * `onCommand` callback; this module is what turns the verb into a real
 * mediaPlay / mediaPause / setVolume / etc.
 *
 * Without this seam, MQTT commands arrive at peer B and get dropped on the
 * floor — see the v21 audit's "MQTT receiver wiring" gap.
 *
 * Authorisation model
 * -------------------
 * We accept a command only when ALL of the following hold:
 *
 *   1. Peer Sync is enabled in settings AND `jellyfinRemoteEnabled` is on
 *      (sync-enabled is mirrored into the transport selector so the same
 *      flag gates the dispatcher's outbound MQTT lane).
 *   2. The sender's `peerId` is NOT our own — guards against retained
 *      frame echo + buggy publishers that mis-address themselves.
 *   3. The sender's `peerId` has a fresh presence record on the transport
 *      selector. The broker's ACL already gates topic access via the
 *      room-key-as-password; a peer that's published presence has proven
 *      it's one of "ours" in the same room.
 *
 * Re-emission loop protection
 * ---------------------------
 * Applying an inbound command mutates the player store, and a future
 * publishOwnState wiring will notice that mutation and publish its own
 * state frame. To stop the ping-pong, every applied command bumps a
 * shared suppression window (`peer-loop-guard`) that publishers consult
 * before sending. The window is short (200ms) so genuine local actions
 * during that interval are NOT swallowed — only the state-tick that the
 * inbound command itself caused.
 */
import { markInboundApply } from '/@/renderer/features/peer-sync/controller/peer-loop-guard';
import { pickTransport } from '/@/renderer/features/peer-sync/controller/transport-selector';
import { PeerAddress } from '/@/renderer/features/peer-sync/protocol/topics';
import { PeerCommand, PeerRepeatMode } from '/@/renderer/features/peer-sync/types';
import { useAuthStore } from '/@/renderer/store/auth.store';
import { usePlayerStoreBase } from '/@/renderer/store/player.store';
import { useSettingsStore } from '/@/renderer/store/settings.store';
import { QueueSong, ServerType } from '/@/shared/types/domain-types';
import { Play, PlayerRepeat, PlayerShuffle } from '/@/shared/types/types';

const log = (...args: unknown[]) => console.info('[peer-sync]', ...args);
const warn = (...args: unknown[]) => console.warn('[peer-sync]', ...args);

/**
 * Mute is a bool on the wire (`{ mute: boolean }`) but the store only
 * exposes a toggle action. Convert: if requested != current, flip.
 */
const setMute = (next: boolean): void => {
    const current = usePlayerStoreBase.getState().player.muted;
    if (current === next) return;
    usePlayerStoreBase.getState().mediaToggleMute();
};

const setShuffleFromWire = (shuffle: boolean): void => {
    const next = shuffle ? PlayerShuffle.TRACK : PlayerShuffle.NONE;
    usePlayerStoreBase.getState().setShuffle(next);
};

const setRepeatFromWire = (mode: PeerRepeatMode): void => {
    let next: PlayerRepeat;
    if (mode === 'all') next = PlayerRepeat.ALL;
    else if (mode === 'one') next = PlayerRepeat.ONE;
    else next = PlayerRepeat.NONE;
    usePlayerStoreBase.getState().setRepeat(next);
};

/**
 * Map the wire's `{ visible: boolean }` shape onto the
 * `general.showLyricsInSidebar` settings flag. The setting is the canonical
 * lyrics-pane visibility toggle — wired into the sidebar play queue and the
 * full-screen player. Updating the flag is enough; the React tree
 * re-renders the pane on the next tick.
 */
const setLyricsVisibleFromWire = (visible: boolean): void => {
    useSettingsStore.setState((state) => {
        state.general.showLyricsInSidebar = visible;
    });
};

/**
 * Result of {@link applyPeerCommand}. `false` means the verb was either
 * unauthorised or unsupported — useful for tests and for the inbound
 * diagnostics counter (the caller still records the frame regardless).
 */
export interface ApplyResult {
    /** Why we did/didn't apply, for diagnostics + tests. */
    reason:
        | 'applied'
        | 'dropped-disabled'
        | 'dropped-self'
        | 'dropped-stale-peer'
        | 'dropped-unsupported'
        | 'dropped-validation';
}

/**
 * Authorisation gate. Pure read of settings + the transport selector — no
 * side effects. Exposed for tests; the receiver hot path calls it inline.
 */
export const isAuthorisedSender = (from: PeerAddress, now: number = Date.now()): boolean => {
    const settings = useSettingsStore.getState().peerSync;
    if (!settings.enabled || !settings.jellyfinRemoteEnabled) return false;
    if (!from.peerId) return false;
    // Don't apply our own frames if they ever loop back. peer-client already
    // filters retained-self echoes, but this is the belt-and-braces version.
    if (settings.peerId && settings.peerId === from.peerId) return false;
    // Presence-fresh = transport selector thinks MQTT is alive for this
    // peer. Equivalent to "we've seen a recent retained presence frame".
    if (pickTransport(from.peerId, now) !== 'mqtt') return false;
    return true;
};

/**
 * Apply an inbound MQTT command to the local player. Returns the
 * disposition for diagnostics. Never throws — codec failures are handled
 * upstream and a malformed `a` payload for a known verb is treated as
 * "unsupported" rather than crashing the receiver.
 *
 * Lifecycle log lines are tagged `[peer-sync] apply cmd` so the diag
 * console can grep them out of the larger stream.
 */
export const applyPeerCommand = (from: PeerAddress, cmd: PeerCommand): ApplyResult => {
    if (!isAuthorisedSender(from)) {
        const settings = useSettingsStore.getState().peerSync;
        if (!settings.enabled || !settings.jellyfinRemoteEnabled) {
            return { reason: 'dropped-disabled' };
        }
        if (settings.peerId && settings.peerId === from.peerId) {
            return { reason: 'dropped-self' };
        }
        return { reason: 'dropped-stale-peer' };
    }

    // The transport selector is keyed on a Jellyfin user namespace — we
    // only act when we have a signed-in Jellyfin user. Without one the
    // peer-client wouldn't even subscribe, but a unit-test that wires the
    // receiver directly can hit this path, so it's an explicit gate.
    const auth = useAuthStore.getState().currentServer;
    const hasJellyfinSession = auth?.type === ServerType.JELLYFIN && Boolean(auth.userId);
    if (!hasJellyfinSession && cmd.k === 'play' && cmd.a && 'itemIds' in cmd.a) {
        // Bare play/pause don't need the server; an inbound queue-replace
        // does (hydrateSongs is JF-only). Drop with a warn so the producer
        // knows their queue command didn't take.
        warn('dropped cmd: no jellyfin session for queue hydrate', {
            from: from.peerId,
            k: cmd.k,
        });
        return { reason: 'dropped-unsupported' };
    }

    log('apply cmd', { k: cmd.k, peerId: from.peerId });
    // Open the loop-guard window before we mutate — any synchronous
    // publishOwnState fire-through that reads the guard inside this tick
    // will see "yes, suppress".
    markInboundApply();

    const actions = usePlayerStoreBase.getState();
    switch (cmd.k) {
        case 'lyrics': {
            if (!cmd.a || !('visible' in cmd.a) || typeof cmd.a.visible !== 'boolean') {
                return { reason: 'dropped-validation' };
            }
            setLyricsVisibleFromWire(cmd.a.visible);
            return { reason: 'applied' };
        }
        case 'mute': {
            if (!cmd.a || !('mute' in cmd.a) || typeof cmd.a.mute !== 'boolean') {
                return { reason: 'dropped-validation' };
            }
            setMute(cmd.a.mute);
            return { reason: 'applied' };
        }
        case 'next': {
            actions.mediaNext();
            return { reason: 'applied' };
        }
        case 'pause': {
            actions.mediaPause();
            return { reason: 'applied' };
        }
        case 'play': {
            // Two shapes: bare (just resume) and queue-replace (itemIds).
            // The latter needs server-side hydration which the renderer
            // already has a path for via remoteTargetApi.hydrateSongs.
            // To keep the receiver synchronous + dependency-light we
            // accept the bare form here; the queue-replace form is a
            // 'queue' verb (separate case) so producers should use that.
            if (cmd.a && 'itemIds' in cmd.a) {
                // Forward to the queue handler. The wire allows either
                // verb to carry itemIds — we normalise here.
                return applyQueueReplace(cmd.a, from);
            }
            actions.mediaPlay();
            return { reason: 'applied' };
        }
        case 'playIndex': {
            if (
                !cmd.a ||
                !('index' in cmd.a) ||
                typeof cmd.a.index !== 'number' ||
                !Number.isFinite(cmd.a.index)
            ) {
                return { reason: 'dropped-validation' };
            }
            actions.mediaPlayByIndex(cmd.a.index);
            return { reason: 'applied' };
        }
        case 'prev': {
            actions.mediaPrevious();
            return { reason: 'applied' };
        }
        case 'queue': {
            if (!cmd.a || !('itemIds' in cmd.a)) {
                return { reason: 'dropped-validation' };
            }
            return applyQueueReplace(cmd.a, from);
        }
        case 'queueInsert': {
            if (
                !cmd.a ||
                !('index' in cmd.a) ||
                !('itemIds' in cmd.a) ||
                typeof cmd.a.index !== 'number' ||
                !Array.isArray(cmd.a.itemIds) ||
                cmd.a.itemIds.length === 0
            ) {
                return { reason: 'dropped-validation' };
            }
            return applyQueueInsert(cmd.a.index, cmd.a.itemIds, from);
        }
        case 'queueRemove': {
            if (
                !cmd.a ||
                !('indices' in cmd.a) ||
                !Array.isArray(cmd.a.indices) ||
                cmd.a.indices.length === 0 ||
                cmd.a.indices.some((i) => typeof i !== 'number' || !Number.isFinite(i))
            ) {
                return { reason: 'dropped-validation' };
            }
            return applyQueueRemove(cmd.a.indices, from);
        }
        case 'queueReorder': {
            if (
                !cmd.a ||
                !('from' in cmd.a) ||
                !('to' in cmd.a) ||
                typeof cmd.a.from !== 'number' ||
                typeof cmd.a.to !== 'number'
            ) {
                return { reason: 'dropped-validation' };
            }
            return applyQueueReorder(cmd.a.from, cmd.a.to, from);
        }
        case 'rate': {
            // Wire range is 0.5..2.0; the store action clamps but we still
            // validate the input is a finite number so a buggy publisher
            // can't trick the store into NaN.
            if (
                !cmd.a ||
                !('rate' in cmd.a) ||
                typeof cmd.a.rate !== 'number' ||
                !Number.isFinite(cmd.a.rate)
            ) {
                return { reason: 'dropped-validation' };
            }
            actions.setSpeed(cmd.a.rate);
            return { reason: 'applied' };
        }
        case 'repeat': {
            if (!cmd.a || !('mode' in cmd.a)) {
                return { reason: 'dropped-validation' };
            }
            const m = cmd.a.mode;
            if (m !== 'off' && m !== 'all' && m !== 'one') {
                return { reason: 'dropped-validation' };
            }
            setRepeatFromWire(m);
            return { reason: 'applied' };
        }
        case 'seek': {
            if (
                !cmd.a ||
                !('positionMs' in cmd.a) ||
                typeof cmd.a.positionMs !== 'number' ||
                !Number.isFinite(cmd.a.positionMs)
            ) {
                return { reason: 'dropped-validation' };
            }
            // The store action takes seconds (everything else in the
            // renderer's playhead is in seconds — only the wire frame is
            // ms for sub-second precision). mediaSeekToTimestamp itself
            // propagates the new value to the timestamp store so no extra
            // setTimestampStore call is needed here.
            const seconds = Math.max(0, cmd.a.positionMs / 1000);
            actions.mediaSeekToTimestamp(seconds);
            return { reason: 'applied' };
        }
        case 'shuffle': {
            if (!cmd.a || !('shuffle' in cmd.a) || typeof cmd.a.shuffle !== 'boolean') {
                return { reason: 'dropped-validation' };
            }
            setShuffleFromWire(cmd.a.shuffle);
            return { reason: 'applied' };
        }
        case 'stop': {
            actions.mediaStop();
            return { reason: 'applied' };
        }
        case 'togglePause': {
            actions.mediaTogglePlayPause();
            return { reason: 'applied' };
        }
        case 'volume': {
            if (
                !cmd.a ||
                !('volume' in cmd.a) ||
                typeof cmd.a.volume !== 'number' ||
                !Number.isFinite(cmd.a.volume)
            ) {
                return { reason: 'dropped-validation' };
            }
            // Clamp to the wire's documented 0-100 range so a buggy
            // publisher can't push the engine into a negative/over-max
            // setting.
            const vol = Math.max(0, Math.min(100, cmd.a.volume));
            actions.setVolume(vol);
            return { reason: 'applied' };
        }
        default: {
            // Unknown verb — drop silently. The codec already lets
            // unknown verbs through so newer publishers stay forward-
            // compatible; the receiver's job is to ignore what it
            // doesn't understand.
            warn('dropped cmd: unsupported verb', {
                from: from.peerId,
                // Cast to string for the log only; the union exhaust
                // guarantees we never actually reach here at runtime
                // for a typed PeerCommand, but the wire surface is
                // bytes — anything can arrive.
                k: (cmd as PeerCommand).k as string,
            });
            return { reason: 'dropped-unsupported' };
        }
    }
};

/**
 * Queue-replace path. The wire's `play`/`queue` verbs can carry an
 * `itemIds` array; we hydrate those via the remote-target API (Jellyfin
 * only) and feed them through `setQueue`. Hydration is async so we kick
 * it off and return synchronously — the caller sees "applied" the moment
 * we've gated the request. A failed hydrate is logged but doesn't
 * surface as a result-code change because there's nothing the caller
 * could do with it.
 */
const applyQueueReplace = (
    args: {
        itemIds: string[];
        playCommand?: 'PlayLast' | 'PlayNext' | 'PlayNow';
        startIndex?: number;
    },
    from: PeerAddress,
): ApplyResult => {
    if (!Array.isArray(args.itemIds) || args.itemIds.length === 0) {
        return { reason: 'dropped-validation' };
    }
    const auth = useAuthStore.getState().currentServer;
    if (!auth || auth.type !== ServerType.JELLYFIN || !auth.userId) {
        warn('dropped cmd: no jellyfin session for queue', { from: from.peerId });
        return { reason: 'dropped-unsupported' };
    }
    // Lazy import to avoid pulling the JF API surface into a unit test
    // that only exercises the synchronous verb mapping.
    void import('/@/renderer/features/jellyfin-remote-target/api/remote-target-api')
        .then(async (mod) => {
            try {
                const songs = await mod.remoteTargetApi.hydrateSongs({
                    itemIds: args.itemIds,
                    server: auth,
                });
                if (songs.length === 0) {
                    warn('dropped cmd: hydrate returned empty', { from: from.peerId });
                    return;
                }
                const pc = args.playCommand;
                markInboundApply();
                const store = usePlayerStoreBase.getState();
                if (pc === 'PlayNext' || pc === 'PlayLast') {
                    // PlayNext/PlayLast must APPEND (mirroring the Jellyfin
                    // lane's PlayCommand + applyQueueInsert's cold-queue path).
                    // Only PlayNow/undefined performs a full replace.
                    const order = store.getQueueOrder().items;
                    if (order.length === 0) {
                        // Cold queue: nothing to insert after, so fall back to
                        // setQueue (same as applyQueueInsert's cold-queue path).
                        store.setQueue(songs, 0, 0);
                    } else {
                        store.addToQueueByType(songs, pc === 'PlayNext' ? Play.NEXT : Play.LAST);
                    }
                    log('apply cmd queue (append)', {
                        count: songs.length,
                        mode: pc,
                        peerId: from.peerId,
                    });
                } else {
                    const startIndex = typeof args.startIndex === 'number' ? args.startIndex : 0;
                    store.setQueue(songs, startIndex, 0);
                    log('apply cmd queue', {
                        count: songs.length,
                        peerId: from.peerId,
                        startIndex,
                    });
                }
            } catch (err) {
                warn('dropped cmd: hydrate failed', {
                    err: (err as Error).message,
                    from: from.peerId,
                });
            }
        })
        .catch((err) => {
            warn('dropped cmd: import failed', { err: (err as Error).message });
        });
    return { reason: 'applied' };
};

/**
 * Queue-insert path. Hydrates the requested ids and threads them through
 * `addToQueueByUniqueId` at the resolved drop target. When the queue is
 * empty we fall through to `addToQueueByType(LAST)` which appends to a
 * cold queue without needing an existing uniqueId anchor. As with the
 * bulk `queue` verb the hydrate is async — we kick it off and return
 * `applied` synchronously so the diagnostics counter records the request.
 */
const applyQueueInsert = (index: number, itemIds: string[], from: PeerAddress): ApplyResult => {
    if (!Number.isFinite(index) || index < 0) {
        return { reason: 'dropped-validation' };
    }
    const auth = useAuthStore.getState().currentServer;
    if (!auth || auth.type !== ServerType.JELLYFIN || !auth.userId) {
        warn('dropped cmd: no jellyfin session for queueInsert', { from: from.peerId });
        return { reason: 'dropped-unsupported' };
    }
    void import('/@/renderer/features/jellyfin-remote-target/api/remote-target-api')
        .then(async (mod) => {
            try {
                const songs = await mod.remoteTargetApi.hydrateSongs({
                    itemIds,
                    server: auth,
                });
                if (songs.length === 0) {
                    warn('dropped cmd: hydrate returned empty (queueInsert)', {
                        from: from.peerId,
                    });
                    return;
                }
                markInboundApply();
                const store = usePlayerStoreBase.getState();
                const order = store.getQueueOrder().items;
                // Cold queue: just append. addToQueueByUniqueId needs an
                // existing anchor uniqueId to slot against, which there
                // isn't one of in an empty queue.
                if (order.length === 0) {
                    store.addToQueueByType(songs, Play.LAST);
                    log('apply cmd queueInsert (cold)', {
                        count: songs.length,
                        peerId: from.peerId,
                    });
                    return;
                }
                // Bound `index` into [0, order.length] — a publisher that
                // overshoots gets pinned to the tail rather than dropped.
                const safe = Math.min(Math.max(0, Math.floor(index)), order.length);
                if (safe >= order.length) {
                    const anchor = order[order.length - 1];
                    store.addToQueueByUniqueId(songs, anchor._uniqueId, 'bottom');
                } else {
                    const anchor = order[safe];
                    store.addToQueueByUniqueId(songs, anchor._uniqueId, 'top');
                }
                log('apply cmd queueInsert', {
                    count: songs.length,
                    index: safe,
                    peerId: from.peerId,
                });
            } catch (err) {
                warn('dropped cmd: hydrate failed (queueInsert)', {
                    err: (err as Error).message,
                    from: from.peerId,
                });
            }
        })
        .catch((err) => {
            warn('dropped cmd: import failed (queueInsert)', { err: (err as Error).message });
        });
    return { reason: 'applied' };
};

/**
 * Queue-remove path. Maps incoming indices into the target's default
 * (non-shuffled) queue order to QueueSong objects and delegates to
 * `clearSelected`, which already handles re-indexing the shuffled list
 * and bumping the current player index. Out-of-range indices are
 * skipped silently rather than failing the whole verb so a stale
 * controller doesn't deadlock on a queue that's already shorter than
 * it thinks.
 */
const applyQueueRemove = (indices: number[], from: PeerAddress): ApplyResult => {
    const store = usePlayerStoreBase.getState();
    const order = store.getQueueOrder().items;
    const targets: QueueSong[] = [];
    for (const idx of indices) {
        if (idx < 0 || idx >= order.length) continue;
        targets.push(order[idx]);
    }
    if (targets.length === 0) {
        warn('dropped cmd: queueRemove no in-range indices', {
            from: from.peerId,
            requested: indices.length,
        });
        return { reason: 'dropped-validation' };
    }
    store.clearSelected(targets);
    log('apply cmd queueRemove', {
        peerId: from.peerId,
        removed: targets.length,
    });
    return { reason: 'applied' };
};

/**
 * Queue-reorder path. Resolves `from` to a QueueSong in the default queue
 * order, then calls `moveSelectedTo` against the song currently at the
 * desired destination index. The edge is direction-aware: a backward move
 * (toIdx < fromIdx) uses the 'top' edge, while a forward move (toIdx >
 * fromIdx) uses the 'bottom' edge to compensate for moveSelectedTo's
 * post-filter left-shift — both cases land the moved item AT the destination
 * index. When `to` is past the end we fall through to `moveSelectedToBottom`.
 */
const applyQueueReorder = (fromIdx: number, toIdx: number, from: PeerAddress): ApplyResult => {
    if (
        !Number.isFinite(fromIdx) ||
        !Number.isFinite(toIdx) ||
        fromIdx < 0 ||
        toIdx < 0 ||
        fromIdx === toIdx
    ) {
        return { reason: 'dropped-validation' };
    }
    const store = usePlayerStoreBase.getState();
    const order = store.getQueueOrder().items;
    if (fromIdx >= order.length) {
        warn('dropped cmd: queueReorder from out of range', {
            from: from.peerId,
            fromIdx,
            len: order.length,
        });
        return { reason: 'dropped-validation' };
    }
    const moving = order[fromIdx];
    if (toIdx >= order.length) {
        store.moveSelectedToBottom([moving]);
    } else {
        const anchor = order[toIdx];
        // moveSelectedTo filters the moving id out of the queue FIRST, then
        // splices the item back in relative to the anchor. That filter
        // left-shifts every element after the moved one by one slot.
        //   - Backward (toIdx < fromIdx): the anchor sits before the moved
        //     item, so the filter doesn't move it. Edge 'top' lands the item
        //     AT the anchor's slot (toIdx).
        //   - Forward (toIdx > fromIdx): the anchor sits after the moved item,
        //     so the filter shifts the anchor left by one. Edge 'bottom'
        //     (insert AFTER the anchor) compensates for that left-shift so the
        //     item lands AT toIdx rather than one slot early.
        store.moveSelectedTo([moving], anchor._uniqueId, toIdx > fromIdx ? 'bottom' : 'top');
    }
    log('apply cmd queueReorder', {
        from: from.peerId,
        fromIdx,
        toIdx,
    });
    return { reason: 'applied' };
};
