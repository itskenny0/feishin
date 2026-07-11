// OfflineDownloadManager — the persistent, sequential offline-download queue.
// The queue IS the offlineTargets table: targets whose Status is non-settled
// (queued/enumerating/downloading/paused) are pending work. One target
// downloads at a time; concurrency lives inside processTarget (added later).

import type { Song } from '/@/shared/types/domain-types';

import type { LocalMediaStore } from '../media-store';
import type { OfflineTargetRow } from '../types';

import { getActiveCacheDb } from '../db';
import { localMediaStore, normalizeTargetStatus, targetKey } from '../media-store';
import { isUpToDate, sourceTagFor } from './dedup';
import { streamTargetSongs, withRetry } from './enumerate';
import { publishProgress, publishQueue } from './progress';
import { cacheOfflineSongMeta, countMissingOfflineSongMeta } from './song-meta';

import { api } from '/@/renderer/api';
import { useSettingsStore } from '/@/renderer/store';

// Songs downloaded concurrently WITHIN a single target.
const DOWNLOAD_CONCURRENCY = 3;

const TAG = '[offline-media]';

export interface AddTargetArgs {
    entityId: string;
    entityType: OfflineTargetRow['EntityType'];
    name: string;
    serverId: string;
}

export type ProcessHook = (target: OfflineTargetRow) => Promise<void>;

// Statuses that keep a target in the active queue.
const READY = new Set<OfflineTargetRow['Status']>(['downloading', 'enumerating', 'queued']);
// Statuses that count as pending (ready + paused) for the queue summary.
const PENDING = new Set<OfflineTargetRow['Status']>([
    'downloading',
    'enumerating',
    'paused',
    'queued',
]);

export class OfflineDownloadManager {
    protected getStore: () => LocalMediaStore;
    // Per-target abort controllers so a single target can be paused/cancelled
    // (or preempted) without touching the others.
    private aborts = new Map<string, AbortController>();
    private enqueueSeq = 0;
    private idleWaiters: Array<() => void> = [];
    // Called after a target settles or a target/all are removed, so callers can
    // refresh aggregate stats + the availability index. Injected (defaults to a
    // no-op) to avoid an import cycle with the stats module.
    private onChanged: () => Promise<void>;
    private processHook?: ProcessHook;
    private pumping = false;
    // Set when a control enqueues work while the pump is already running, so the
    // pump loops again instead of declaring the queue idle (closes the race
    // between the last empty poll and the pump releasing).
    private rekick = false;

    constructor(
        getStore: () => LocalMediaStore = () => localMediaStore,
        onChanged: () => Promise<void> = async () => {},
    ) {
        this.getStore = getStore;
        this.onChanged = onChanged;
    }

    /** Abort the in-flight download of a specific target (pause/cancel/preempt). */
    abortTarget(key: string): void {
        this.aborts.get(key)?.abort();
    }

    /** Upsert a target to `queued` and kick the loop. Idempotent. */
    async enqueue(args: AddTargetArgs): Promise<OfflineTargetRow> {
        const store = this.getStore();
        const key = targetKey(args.serverId, args.entityType, args.entityId);
        const existing = await store.getTarget(key);
        const enqueuedAt = this.nextEnqueuedAt();
        if (existing) {
            await store.patchTarget(key, { EnqueuedAt: enqueuedAt, Status: 'queued' });
        } else {
            const now = Date.now();
            await store.putTarget({
                AddedAt: now,
                Bytes: 0,
                DownloadedCount: 0,
                EnqueuedAt: enqueuedAt,
                EntityId: args.entityId,
                EntityType: args.entityType,
                Key: key,
                LastError: undefined,
                Name: args.name,
                ServerId: args.serverId,
                SongCount: undefined,
                Status: 'queued',
                UpdatedAt: now,
            });
        }
        console.info(`${TAG} enqueued`, { key });
        void this.kick();
        return (await store.getTarget(key)) as OfflineTargetRow;
    }

    async enqueueMany(argsList: AddTargetArgs[]): Promise<void> {
        for (const args of argsList) await this.enqueue(args);
    }

    /**
     * One-shot heal: populate db.songs metadata for every already-downloaded
     * target so the "Available offline" view resolves all blobs (fixes downloads
     * made before metadata was persisted at download time). syncMeta-flagged so
     * it runs once per DB. Online + best-effort.
     *
     * A single broken/deleted target (e.g. a playlist removed on the server
     * after being marked offline) must not block healing for every OTHER
     * target forever — that previously bailed the whole pass on the first
     * enumeration failure, so a lone bad entry re-failed (and re-blocked
     * everything behind it) on every future launch. Instead we skip the
     * failed target and keep going; the one-shot flag is only stamped once
     * every target enumerated cleanly, so a bad target still gets retried
     * next launch WITHOUT starving the others in the meantime.
     */
    async healSongMeta(): Promise<void> {
        const db = getActiveCacheDb();
        if (!db) return;
        const FLAG = 'offlineSongMetaHeal_v1';
        const stampFlag = (healedCount: number) =>
            db.syncMeta.put({
                EntityType: FLAG as never,
                hydrationState: 'none',
                lastFullSyncAt: undefined,
                lastSweepAt: undefined,
                nextStartIndex: undefined,
                pausedUntil: undefined,
                totalCount: healedCount,
            });
        try {
            // The "Available offline" list only shows a downloaded blob that also
            // has a db.songs metadata row (use-offline-songs.ts), so any
            // downloaded song lacking metadata is silently invisible there. Drive
            // the heal off a ground-truth gap check, NOT a permanent one-shot
            // flag: the old flag made this run once ever, so songs downloaded
            // after the first heal — or dropped by a failed metadata write —
            // stayed missing forever (the "N downloaded, far fewer shown" bug).
            // `totalCount` on the flag row records the downloaded-song count we
            // last fully healed at, so we re-heal when new downloads arrive but
            // do NOT re-enumerate the whole library every launch for a residual
            // gap that is unresolvable (blobs whose song was removed server-side).
            const songIds = (await this.getStore().listSongKeys())
                .map((k) => k.slice(k.indexOf(':') + 1))
                .filter(Boolean);
            const missing = await countMissingOfflineSongMeta(songIds, db);
            if (missing === 0) {
                if (!(await db.syncMeta.get(FLAG as never))) await stampFlag(songIds.length);
                return;
            }
            const flagRow = await db.syncMeta.get(FLAG as never);
            if (flagRow && songIds.length <= (flagRow.totalCount ?? 0)) {
                // Already healed at (or above) this library size; the residual
                // gap won't close by re-enumerating, so don't do it every launch.
                return;
            }
            console.info(
                `${TAG} healSongMeta: ${missing} downloaded song(s) missing metadata — backfilling`,
            );

            // A single broken/deleted target (e.g. a playlist removed on the
            // server after being marked offline) must not block healing the
            // others — skip it and keep going. Track row-write failures too, so a
            // transient bulkPut/per-row failure isn't recorded as a clean heal.
            let allOk = true;
            let failedRows = 0;
            for (const t of await this.getStore().listTargets()) {
                try {
                    for await (const page of streamTargetSongs(t)) {
                        const res = await cacheOfflineSongMeta(page, db);
                        failedRows += res.failed;
                    }
                } catch (err) {
                    allOk = false;
                    console.warn(`${TAG} healSongMeta: enumerate failed, skipping target`, {
                        err,
                        key: t.Key,
                    });
                }
            }
            if (!allOk || failedRows > 0) {
                console.warn(
                    `${TAG} healSongMeta: incomplete (allOk=${allOk}, failedRows=${failedRows}), will retry next launch`,
                );
                return; // don't record completion → retry next launch
            }
            await stampFlag(songIds.length);
            console.info(`${TAG} healSongMeta complete`);
        } catch (err) {
            console.warn(`${TAG} healSongMeta failed`, err);
        }
    }

    isRunning(): boolean {
        return this.pumping;
    }

    /** Pause a target: stop its in-flight download and drop it from the queue. */
    async pause(key: string): Promise<void> {
        await this.getStore().patchTarget(key, {
            EnqueuedAt: undefined,
            Preempt: false,
            Status: 'paused',
        });
        this.abortTarget(key);
        console.info(`${TAG} paused`, { key });
    }

    /** Pause whichever target is currently downloading/enumerating (if any). */
    async pauseActive(): Promise<void> {
        const active = (await this.getStore().listTargets()).find(
            (t) => t.Status === 'downloading' || t.Status === 'enumerating',
        );
        if (active) await this.pause(active.Key);
    }

    /** Pause every active/queued target. */
    async pauseAll(): Promise<void> {
        for (const t of await this.getStore().listTargets()) {
            if (READY.has(t.Status)) await this.pause(t.Key);
        }
    }

    /**
     * Launch/periodic delta pass: for each settled `complete` target, count the
     * server's current songs (streamed enumeration) and re-queue only when it
     * grew. Cheap — enumeration is cache-served. User-owned states
     * (partial/error/paused) are left alone.
     */
    async refreshTargets(): Promise<void> {
        for (const t of await this.getStore().listTargets()) {
            if (t.Status !== 'complete') continue;
            let found = 0;
            try {
                for await (const page of streamTargetSongs(t)) found += page.length;
            } catch (err) {
                console.warn(`${TAG} refresh: enumerate failed`, { err, key: t.Key });
                continue;
            }
            if (found > (t.DownloadedCount ?? 0)) {
                console.info(`${TAG} refresh: target grew, re-queue`, {
                    found,
                    key: t.Key,
                    was: t.DownloadedCount,
                });
                await this.resume(t.Key);
            }
        }
    }

    /** Remove a target (cancel if active) and reclaim any blobs it solely owned. */
    async remove(key: string): Promise<void> {
        this.abortTarget(key);
        await this.getStore().removeTarget(key);
        await this.onChanged();
    }

    /** Remove every target and wipe all offline blobs. */
    async removeAll(): Promise<void> {
        for (const [, ac] of this.aborts) ac.abort();
        this.aborts.clear();
        await this.getStore().clearAll();
        await this.onChanged();
    }

    /** Resume a paused/settled target by re-queuing it (normal priority). */
    async resume(key: string): Promise<void> {
        await this.getStore().patchTarget(key, {
            EnqueuedAt: this.nextEnqueuedAt(),
            Preempt: false,
            Status: 'queued',
        });
        void this.kick();
    }

    /** Re-queue every paused/partial/error target. */
    async resumeAll(): Promise<void> {
        for (const t of await this.getStore().listTargets()) {
            if (t.Status === 'paused' || t.Status === 'partial' || t.Status === 'error') {
                await this.resume(t.Key);
            }
        }
    }

    /**
     * Normalize every persisted target Status (legacy values + crash residue)
     * and resume the queue. Called on server activation so a restart/crash
     * auto-resumes pending downloads. Settled targets are left untouched.
     */
    async resumePersisted(): Promise<void> {
        const store = this.getStore();
        const targets = await store.listTargets();
        for (const t of targets) {
            const normalized = normalizeTargetStatus(t.Status);
            if (normalized !== t.Status) {
                const patch: Partial<OfflineTargetRow> = { Status: normalized };
                if (normalized === 'queued' && t.EnqueuedAt === undefined) {
                    patch.EnqueuedAt = this.nextEnqueuedAt();
                }
                await store.patchTarget(t.Key, patch);
                console.info(`${TAG} resume: normalized`, {
                    from: t.Status,
                    key: t.Key,
                    to: normalized,
                });
            }
        }
        void this.kick();
    }

    /** Retry a failed/partial target (alias of resume). */
    async retry(key: string): Promise<void> {
        await this.resume(key);
    }

    /** Set the post-change callback (stats/availability refresh). */
    setOnChanged(fn: () => Promise<void>): void {
        this.onChanged = fn;
    }

    /** Test seam: replace the real processTarget with a stub. */
    setProcessHook(hook: ProcessHook | undefined): void {
        this.processHook = hook;
    }

    /** Re-queue every target that isn't already complete or actively running. */
    async syncAll(): Promise<void> {
        for (const t of await this.getStore().listTargets()) {
            if (t.Status !== 'complete' && !READY.has(t.Status)) await this.resume(t.Key);
            else if (t.Status === 'queued') void this.kick();
        }
    }

    /**
     * Sync a specific target NOW: mark it Preempt + re-queue, and bump the
     * currently-downloading target out of the way (it re-queues itself and the
     * pump picks the preempted one next).
     */
    async syncNow(key: string): Promise<void> {
        const store = this.getStore();
        const target = await store.getTarget(key);
        if (!target) return;
        await store.patchTarget(key, {
            EnqueuedAt: this.nextEnqueuedAt(),
            Preempt: true,
            Status: 'queued',
        });
        const active = (await store.listTargets()).find(
            (t) => t.Key !== key && (t.Status === 'downloading' || t.Status === 'enumerating'),
        );
        if (active) {
            await store.patchTarget(active.Key, { Preempt: false, Status: 'queued' });
            this.abortTarget(active.Key);
        }
        void this.kick();
    }

    /** Resolves when the queue has drained. */
    whenIdle(): Promise<void> {
        if (!this.pumping) return Promise.resolve();
        return new Promise((resolve) => this.idleWaiters.push(resolve));
    }

    protected downloadOriginal(): boolean {
        return useSettingsStore.getState().localCache?.offlineMedia?.downloadOriginal !== false;
    }

    protected getMaxBytes(): number {
        const n = useSettingsStore.getState().localCache?.offlineMedia?.maxBytes;
        return typeof n === 'number' && n > 0 ? n : Number.POSITIVE_INFINITY;
    }

    // Drive the queue: process one target at a time until none remain. Safe to
    // call concurrently — only one pump runs; extra calls set `rekick`.
    protected async kick(): Promise<void> {
        if (this.pumping) {
            this.rekick = true;
            return;
        }
        this.pumping = true;
        try {
            do {
                this.rekick = false;
                let next = this.pickNext(await this.getStore().listTargets());
                while (next) {
                    const store = this.getStore();
                    const targets = await store.listTargets();
                    // Re-validate against this FRESH read: a control (pause / remove /
                    // preempt-bump) can change `next`'s status in the window between
                    // pickNext() and here (both cross an await). processTarget starts
                    // unconditionally once invoked — it would silently clobber a
                    // just-applied pause back to 'enumerating'. Skip a target that's no
                    // longer ready and let pickNext choose the next eligible one.
                    const fresh = targets.find((t) => t.Key === next!.Key);
                    if (!fresh || !READY.has(fresh.Status)) {
                        console.info(`${TAG} skip stale dequeue`, { key: next.Key });
                        next = this.pickNext(targets);
                        continue;
                    }
                    this.publishQueueSummary(targets, fresh.Key);
                    console.info(`${TAG} dequeued`, {
                        key: fresh.Key,
                        preempt: Boolean(fresh.Preempt),
                    });
                    try {
                        await (this.processHook ?? ((t) => this.processTarget(t)))(fresh);
                    } catch (err) {
                        console.warn(`${TAG} process threw`, { err, key: fresh.Key });
                        await store.patchTarget(fresh.Key, {
                            EnqueuedAt: undefined,
                            LastError: (err as Error).message ?? String(err),
                            Preempt: false,
                            Status: 'error',
                        });
                    }
                    next = this.pickNext(await store.listTargets());
                }
            } while (this.rekick);
        } catch (err) {
            console.warn(`${TAG} kick loop error`, err);
        } finally {
            this.pumping = false;
        }
        publishQueue(undefined);
        const waiters = this.idleWaiters;
        this.idleWaiters = [];
        for (const w of waiters) w();
    }

    // Monotonic FIFO key. Time-based so ordering survives restarts, with a
    // per-call sequence tail so rapid enqueues never collide.
    protected nextEnqueuedAt(): number {
        this.enqueueSeq += 1;
        return Date.now() * 1000 + (this.enqueueSeq % 1000);
    }

    /** Pick Preempt first, then FIFO by EnqueuedAt. */
    protected pickNext(targets: OfflineTargetRow[]): OfflineTargetRow | undefined {
        const ready = targets.filter((t) => READY.has(t.Status));
        if (ready.length === 0) return undefined;
        ready.sort((a, b) => {
            if (Boolean(b.Preempt) !== Boolean(a.Preempt)) return a.Preempt ? -1 : 1;
            return (a.EnqueuedAt ?? Infinity) - (b.EnqueuedAt ?? Infinity);
        });
        return ready[0];
    }

    /**
     * Download every song of a target, streaming enumeration into a bounded
     * worker pool so downloads start on page 1. Dedups against existing blobs
     * (skips a song whose current copy is already on disk), enforces the global
     * byte cap, and writes a SourceTag on each new blob. Settles the target
     * complete / partial / error and clears EnqueuedAt.
     */
    protected async processTarget(target: OfflineTargetRow): Promise<void> {
        const store = this.getStore();
        const { Key: key, Name: name, ServerId: serverId } = target;
        const abort = new AbortController();
        this.aborts.set(key, abort);
        const startedAt = Date.now();

        await store.patchTarget(key, { LastError: undefined, Status: 'enumerating' });

        // Songs whose bytes are already counted in THIS target's footprint, so
        // a re-download's byte delta is reconciled correctly on the cap.
        const existingBlobs = await store.listByEntity(key);
        const alreadyHave = new Set(existingBlobs.map((b) => b.SongId));
        const seededBytes = existingBlobs.reduce((sum, b) => sum + b.ByteSize, 0);
        let bytesDownloaded = seededBytes;
        // Live counters (approximate; the persisted counts come from a
        // ground-truth re-read at settle so resume/retry can't drift them).
        let done = 0;
        let shared = 0;
        let failed = false;
        let capHit = false;
        let found = 0;
        let total: number | undefined;
        let phase: 'downloading' | 'enumerating' = 'enumerating';
        let pageIndex = 0;
        // Bytes committed OR reserved by an in-flight worker (cap accounting).
        let reservedBytes = seededBytes;
        const maxBytes = this.getMaxBytes();
        const streaming = store.supportsStreaming();
        // In-run dedup ONLY (same song enumerated twice across overlapping
        // pages/targets). NOT seeded from existing blobs — every song must reach
        // the worker so isUpToDate can decide skip vs. re-download.
        const seen = new Set<string>();

        const push = (): void => {
            const elapsed = Math.max(0.001, (Date.now() - startedAt) / 1000);
            const avg = done > 0 ? bytesDownloaded / done : 0;
            publishProgress({
                bytesDownloaded,
                bytesPerSec: (bytesDownloaded - seededBytes) / elapsed,
                done,
                entityKey: key,
                estimatedTotalBytes: total && avg > 0 ? avg * total : undefined,
                foundCount: found,
                itemsPerSec: done / elapsed,
                name,
                pageIndex,
                phase,
                startedAt,
                total,
            });
        };
        push();

        // Bounded worker pool fed by a shared cursor over a growing `pending`.
        const pending: Song[] = [];
        let enumerationDone = false;
        let cursor = 0;

        const worker = async (): Promise<void> => {
            while (!abort.signal.aborted && !capHit) {
                if (cursor >= pending.length) {
                    if (enumerationDone) return;
                    // Wait for more pages to enumerate.
                    await new Promise((r) => setTimeout(r, 15));
                    continue;
                }
                const song = pending[cursor];
                cursor += 1;

                const existing = await store.get(serverId, song.id);

                // Already have a CURRENT copy — no download. A blob from another
                // target additionally references this one (a shared song).
                if (isUpToDate(existing, song)) {
                    if (existing && !existing.EntityKeys.includes(key)) {
                        await store.addEntityMembership(serverId, song.id, key);
                        shared += 1;
                    }
                    done += 1;
                    push();
                    continue;
                }

                // Stale existing copy (fingerprint clearly differs): drop it
                // before re-downloading, preserving its membership under OTHER
                // targets so those don't silently lose the song.
                let priorKeys: string[] = [];
                if (existing) {
                    priorKeys = existing.EntityKeys.filter((k) => k !== key);
                    if (alreadyHave.has(song.id)) {
                        bytesDownloaded -= existing.ByteSize;
                        reservedBytes -= existing.ByteSize;
                    }
                    await store.deleteBlobBytes(serverId, song.id);
                }

                const projected = song.size && song.size > 0 ? song.size : 1024 * 1024;
                if (Number.isFinite(maxBytes) && reservedBytes + projected > maxBytes) {
                    capHit = true;
                    return;
                }
                reservedBytes += projected;
                let songReserved = projected;
                try {
                    // Resolving the stream URL is its own round-trip to the server and
                    // just as susceptible to a transient 502/503 under load as any
                    // enumeration call — retry it the same way rather than failing the
                    // whole song (and forcing a manual retry) on one blip.
                    const url = await withRetry(
                        () =>
                            api.controller.getStreamUrl({
                                apiClientProps: { serverId },
                                query: {
                                    id: song.id,
                                    skipAutoTranscode: this.downloadOriginal(),
                                    transcode: false,
                                },
                            }),
                        abort.signal,
                        `getStreamUrl:${song.id}`,
                    );
                    const sourceTag = sourceTagFor(song);
                    let size: number;
                    if (streaming) {
                        // The stale copy (if any) was deleted above, so this
                        // always writes fresh bytes.
                        const res = await store.saveStreamed({
                            container: song.container ?? undefined,
                            entityKey: key,
                            serverId,
                            signal: abort.signal,
                            songId: song.id,
                            sourceTag,
                            url,
                        });
                        size = res.size;
                        reservedBytes += size - projected;
                        songReserved = size;
                        if (Number.isFinite(maxBytes) && bytesDownloaded + size > maxBytes) {
                            await store.deleteBlobBytes(serverId, song.id);
                            reservedBytes -= size;
                            capHit = true;
                            return;
                        }
                    } else {
                        const resp = await fetch(url, { signal: abort.signal });
                        if (!resp.ok)
                            throw new Error(`HTTP ${resp.status} downloading offline audio`);
                        const blob = await resp.blob();
                        reservedBytes += blob.size - projected;
                        songReserved = blob.size;
                        if (Number.isFinite(maxBytes) && bytesDownloaded + blob.size > maxBytes) {
                            reservedBytes -= blob.size;
                            capHit = true;
                            return;
                        }
                        await store.save({
                            blob,
                            container: song.container ?? undefined,
                            entityKey: key,
                            serverId,
                            songId: song.id,
                            sourceTag,
                        });
                        size = blob.size;
                    }
                    // Restore memberships the stale blob had under other targets.
                    for (const k of priorKeys) {
                        await store.addEntityMembership(serverId, song.id, k);
                    }
                    songReserved = 0;
                    bytesDownloaded += size;
                    done += 1;
                    // Flip the PERSISTED Status the first time real bytes land, not
                    // just the in-memory `phase` used for progress events — the UI
                    // renders target.Status verbatim (READY already treats
                    // 'downloading' as distinct from 'enumerating'), so without this
                    // a multi-hour download stayed labelled "enumerating" the whole
                    // time. Gated on !aborted so a pause/cancel/preempt that raced in
                    // right here can't be clobbered back to an active state.
                    const enteringDownloadPhase = phase !== 'downloading';
                    if (enteringDownloadPhase) phase = 'downloading';
                    await store.patchTarget(key, {
                        Bytes: bytesDownloaded,
                        DownloadedCount: done,
                        ...(enteringDownloadPhase && !abort.signal.aborted
                            ? { Status: 'downloading' as const }
                            : {}),
                    });
                    push();
                } catch (err) {
                    reservedBytes -= songReserved;
                    if (abort.signal.aborted) return;
                    failed = true;
                    console.warn(`${TAG} item failed`, { err, key, songId: song.id });
                }
            }
        };

        const pool = Array.from({ length: DOWNLOAD_CONCURRENCY }, () => worker());

        try {
            for await (const page of streamTargetSongs(target, abort.signal)) {
                // Persist every enumerated song's metadata so the "Available
                // offline" view can render it regardless of the library sweep.
                void cacheOfflineSongMeta(page);
                for (const song of page) {
                    if (seen.has(song.id)) continue;
                    seen.add(song.id);
                    pending.push(song);
                    found += 1;
                }
                total = found;
                pageIndex += 1;
                if (phase === 'enumerating') push();
            }
        } catch (err) {
            // Capture whether a CONTROL aborted us BEFORE we abort the pool
            // ourselves — otherwise the abort below always makes this look
            // control-initiated and the genuine-error branch never runs (which
            // left a 502'd target stuck in `enumerating`, re-picked forever).
            const controlAborted = abort.signal.aborted;
            enumerationDone = true;
            abort.abort();
            await Promise.allSettled(pool);
            this.aborts.delete(key);
            publishProgress(undefined);
            // Aborted mid-enumeration (pause / cancel / preempt): leave the
            // status the control set — do NOT mark it error.
            if (controlAborted) return;
            // A genuine enumeration failure (e.g. the server 502'd every retry)
            // → settle `error` so the queue advances instead of looping.
            await store.patchTarget(key, {
                EnqueuedAt: undefined,
                LastError: (err as Error).message ?? String(err),
                Preempt: false,
                Status: 'error',
            });
            console.warn(`${TAG} enumerate failed, target errored`, { err, key });
            return;
        }

        enumerationDone = true;
        await Promise.allSettled(pool);
        this.aborts.delete(key);
        publishProgress(undefined);

        // Aborted (paused / cancelled / preempted): leave the Status the control
        // set — do not overwrite it here.
        if (abort.signal.aborted) return;

        // Persist counts from GROUND TRUTH (the blobs actually referencing this
        // target) rather than the live counters, so resume/retry/removal can't
        // leave DownloadedCount > SongCount or other drift.
        const finalBlobs = await store.listByEntity(key);
        const downloadedCount = finalBlobs.length;
        const finalBytes = finalBlobs.reduce((sum, b) => sum + b.ByteSize, 0);
        const settled: OfflineTargetRow['Status'] = capHit
            ? 'partial'
            : failed
              ? 'error'
              : downloadedCount >= found
                ? 'complete'
                : 'partial';
        await store.patchTarget(key, {
            Bytes: finalBytes,
            DownloadedCount: downloadedCount,
            EnqueuedAt: undefined,
            ErrorCount: failed ? (target.ErrorCount ?? 0) + 1 : 0,
            LastError: capHit ? 'Storage cap reached' : undefined,
            PendingCount: Math.max(0, found - downloadedCount),
            Preempt: false,
            SharedCount: shared,
            SongCount: found,
            Status: settled,
        });
        console.info(`${TAG} settled`, { downloadedCount, found, key, settled, shared });
        await this.onChanged();
    }

    protected publishQueueSummary(targets: OfflineTargetRow[], activeKey: string): void {
        const pending = targets.filter((t) => PENDING.has(t.Status));
        publishQueue({
            activeKey,
            queuedCount: Math.max(0, pending.length - 1),
            targetsDone: targets.length - pending.length,
            targetsTotal: targets.length,
        });
    }
}

export const offlineManager = new OfflineDownloadManager();
