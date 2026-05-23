// The placeholderData function for react-query must be synchronous. Dexie
// reads are async. We bridge that with an in-memory map populated by every
// Dexie read we do in this session — so once a queryKey has been read
// from disk, the next mount finds the snapshot synchronously.
//
// The map is keyed by JSON.stringify(queryKey) because react-query's own
// hash strategy is stable across renders.

import type { QueryKey } from '@tanstack/react-query';

const snapshots = new Map<string, unknown>();

const hash = (key: QueryKey): string => JSON.stringify(key);

export const clearAllSnapshots = (): void => snapshots.clear();

export const dropSnapshot = (key: QueryKey): void => {
    snapshots.delete(hash(key));
};

/**
 * Drop everything keyed under a specific serverId. Used on server switch.
 * The convention in this repo is that the first element of a queryKey is
 * the serverId — see `src/renderer/api/query-keys.ts`.
 */
export const dropSnapshotsForServer = (serverId: string): void => {
    const prefix = JSON.stringify([serverId]).slice(0, -1);
    for (const k of snapshots.keys()) {
        if (k.startsWith(prefix)) snapshots.delete(k);
    }
};

export const readSnapshot = <T>(key: QueryKey): T | undefined =>
    snapshots.get(hash(key)) as T | undefined;

export const writeSnapshot = <T>(key: QueryKey, value: T): void => {
    snapshots.set(hash(key), value);
};
