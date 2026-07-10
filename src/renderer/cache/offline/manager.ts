// OfflineDownloadManager — the persistent, sequential offline-download queue.
// The queue IS the offlineTargets table: targets whose Status is non-settled
// (queued/enumerating/downloading/paused) are pending work. One target
// downloads at a time; concurrency lives inside processTarget (added later).

import type { Song } from '/@/shared/types/domain-types';

import type { LocalMediaStore } from '../media-store';
import type { OfflineTargetRow } from '../types';

import { localMediaStore, targetKey } from '../media-store';
import { isUpToDate, sourceTagFor } from './dedup';
import { streamTargetSongs } from './enumerate';
import { publishProgress, publishQueue } from './progress';

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
    }

    /** Pause every active/queued target. */
    async pauseAll(): Promise<void> {
        for (const t of await this.getStore().listTargets()) {
            if (READY.has(t.Status)) await this.pause(t.Key);
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

    /** Resume a paused/settled target by re-queuing it. */
    async resume(key: string): Promise<void> {
        await this.getStore().patchTarget(key, {
            EnqueuedAt: this.nextEnqueuedAt(),
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
            await store.patchTarget(active.Key, { Status: 'queued' });
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
                    this.publishQueueSummary(targets, next.Key);
                    try {
                        await (this.processHook ?? ((t) => this.processTarget(t)))(next);
                    } catch (err) {
                        console.warn(`${TAG} process threw`, { err, key: next.Key });
                        await store.patchTarget(next.Key, {
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

        // Seed from what is already downloaded for THIS target (resume).
        const existingBlobs = await store.listByEntity(key);
        const seededBytes = existingBlobs.reduce((sum, b) => sum + b.ByteSize, 0);
        let bytesDownloaded = seededBytes;
        let done = existingBlobs.length;
        let shared = 0;
        let failed = false;
        let capHit = false;
        let found = 0;
        let total: number | undefined;
        let phase: 'downloading' | 'enumerating' = 'enumerating';
        // Bytes committed OR reserved by an in-flight worker (cap accounting).
        let reservedBytes = seededBytes;
        const maxBytes = this.getMaxBytes();
        const streaming = store.supportsStreaming();
        // In-run dedup: seed with songs already downloaded for this target so we
        // never re-resolve them; grows as pages enumerate.
        const seen = new Set<string>(existingBlobs.map((b) => b.SongId));

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
                itemsPerSec: (done - existingBlobs.length) / elapsed,
                name,
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

                // Dedup: a current copy already on disk (this or another target).
                const existing = await store.get(serverId, song.id);
                if (isUpToDate(existing, song)) {
                    if (existing) await store.addEntityMembership(serverId, song.id, key);
                    done += 1;
                    shared += 1;
                    push();
                    continue;
                }

                const projected = song.size && song.size > 0 ? song.size : 1024 * 1024;
                if (Number.isFinite(maxBytes) && reservedBytes + projected > maxBytes) {
                    capHit = true;
                    return;
                }
                reservedBytes += projected;
                let songReserved = projected;
                try {
                    const url = await api.controller.getStreamUrl({
                        apiClientProps: { serverId },
                        query: {
                            id: song.id,
                            skipAutoTranscode: this.downloadOriginal(),
                            transcode: false,
                        },
                    });
                    const sourceTag = sourceTagFor(song);
                    let isNew: boolean;
                    let size: number;
                    if (streaming) {
                        const res = await store.saveStreamed({
                            container: song.container ?? undefined,
                            entityKey: key,
                            serverId,
                            signal: abort.signal,
                            songId: song.id,
                            sourceTag,
                            url,
                        });
                        isNew = res.isNew;
                        size = res.size;
                        if (isNew) {
                            reservedBytes += size - projected;
                            songReserved = size;
                            if (Number.isFinite(maxBytes) && bytesDownloaded + size > maxBytes) {
                                await store.deleteBlobBytes(serverId, song.id);
                                reservedBytes -= size;
                                capHit = true;
                                return;
                            }
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
                        isNew = await store.save({
                            blob,
                            container: song.container ?? undefined,
                            entityKey: key,
                            serverId,
                            songId: song.id,
                            sourceTag,
                        });
                        size = blob.size;
                    }

                    if (isNew) {
                        songReserved = 0;
                        bytesDownloaded += size;
                        done += 1;
                        if (phase !== 'downloading') phase = 'downloading';
                    } else {
                        // Blob existed under another target — membership only.
                        reservedBytes -= songReserved;
                        songReserved = 0;
                        done += 1;
                        shared += 1;
                    }
                    await store.patchTarget(key, { Bytes: bytesDownloaded, DownloadedCount: done });
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
                for (const song of page) {
                    if (seen.has(song.id)) continue;
                    seen.add(song.id);
                    pending.push(song);
                    found += 1;
                }
                total = found;
                if (phase === 'enumerating') push();
            }
        } catch (err) {
            // First-page enumeration failure → nothing to download.
            enumerationDone = true;
            abort.abort();
            await Promise.allSettled(pool);
            this.aborts.delete(key);
            await store.patchTarget(key, {
                EnqueuedAt: undefined,
                LastError: (err as Error).message ?? String(err),
                Preempt: false,
                Status: 'error',
            });
            publishProgress(undefined);
            return;
        }

        enumerationDone = true;
        await Promise.allSettled(pool);
        this.aborts.delete(key);
        publishProgress(undefined);

        // Aborted (paused / cancelled / preempted): leave the Status the control
        // set — do not overwrite it here.
        if (abort.signal.aborted) return;

        const settled: OfflineTargetRow['Status'] = capHit
            ? 'partial'
            : done < found || failed
              ? failed
                  ? 'error'
                  : 'partial'
              : 'complete';
        await store.patchTarget(key, {
            EnqueuedAt: undefined,
            ErrorCount: failed ? (target.ErrorCount ?? 0) + 1 : 0,
            LastError: capHit ? 'Storage cap reached' : undefined,
            PendingCount: Math.max(0, found - done),
            Preempt: false,
            SharedCount: shared,
            SongCount: found,
            Status: settled,
        });
        console.info(`${TAG} settled`, { done, found, key, settled, shared });
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
