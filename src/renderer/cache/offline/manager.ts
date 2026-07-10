// OfflineDownloadManager — the persistent, sequential offline-download queue.
// The queue IS the offlineTargets table: targets whose Status is non-settled
// (queued/enumerating/downloading/paused) are pending work. One target
// downloads at a time; concurrency lives inside processTarget (added later).

import type { LocalMediaStore } from '../media-store';
import type { OfflineTargetRow } from '../types';

import { localMediaStore, targetKey } from '../media-store';
import { publishQueue } from './progress';

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
    private enqueueSeq = 0;
    private idleWaiters: Array<() => void> = [];
    private processHook?: ProcessHook;
    private pumping = false;
    // Set when a control enqueues work while the pump is already running, so the
    // pump loops again instead of declaring the queue idle (closes the race
    // between the last empty poll and the pump releasing).
    private rekick = false;

    constructor(getStore: () => LocalMediaStore = () => localMediaStore) {
        this.getStore = getStore;
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

    /** Test seam: replace the real processTarget with a stub. */
    setProcessHook(hook: ProcessHook | undefined): void {
        this.processHook = hook;
    }

    /** Resolves when the queue has drained. */
    whenIdle(): Promise<void> {
        if (!this.pumping) return Promise.resolve();
        return new Promise((resolve) => this.idleWaiters.push(resolve));
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

    // Real download implementation lands in a later task.
    protected async processTarget(_target: OfflineTargetRow): Promise<void> {
        throw new Error(`${TAG} processTarget not implemented yet`);
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
