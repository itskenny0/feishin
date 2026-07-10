import { del, get, set } from 'idb-keyval';
import { useEffect, useState } from 'react';
import { persist, subscribeWithSelector } from 'zustand/middleware';
import { createWithEqualityFn } from 'zustand/traditional';

const PLAYER_TIMESTAMP_POLL_INTERVAL_MS = 500;

interface TimestampState {
    setTimestamp: (timestamp: number) => void;
    timestamp: number;
}

// The live timestamp updates ~2x/sec while playing. Persisting every one of
// those ticks to IndexedDB hammers storage for no benefit — resume-on-restart
// only needs an occasionally-flushed value. We keep the in-memory store hot
// for the UI but throttle the persisted write to at most once per
// PERSIST_THROTTLE_MS, while still forcing an immediate flush on the moments
// that matter (pause/track-change → timestamp resets, and page unload).
const PERSIST_THROTTLE_MS = 7000;

let pendingPersistName: null | string = null;
let pendingPersistValue: null | number = null;
let throttleTimer: NodeJS.Timeout | null = null;

const writeTimestamp = async (name: string, timestamp: number) => {
    try {
        await set(name, timestamp);
    } catch (error) {
        console.warn('[timestamp-store] failed to persist timestamp', error);
    }
};

const flushPendingPersist = () => {
    if (throttleTimer) {
        clearTimeout(throttleTimer);
        throttleTimer = null;
    }
    if (pendingPersistName !== null && pendingPersistValue !== null) {
        const name = pendingPersistName;
        const value = pendingPersistValue;
        pendingPersistName = null;
        pendingPersistValue = null;
        void writeTimestamp(name, value);
    }
};

const timestampStorage = {
    getItem: async (name: string) => {
        const value = await get(name);
        if (value === undefined) {
            return null;
        }
        return { state: { timestamp: value }, version: 1 } as const;
    },
    removeItem: async (name: string) => {
        if (throttleTimer) {
            clearTimeout(throttleTimer);
            throttleTimer = null;
        }
        pendingPersistName = null;
        pendingPersistValue = null;
        await del(name);
    },
    setItem: (name: string, value: { state: { timestamp: number }; version?: number }) => {
        const timestamp = value.state.timestamp;
        pendingPersistName = name;
        pendingPersistValue = timestamp;

        // A timestamp of 0 is emitted on pause/track-change/stop/seek-to-zero —
        // exactly the moments where we want a durable write — so flush right away.
        if (timestamp === 0) {
            flushPendingPersist();
            return;
        }

        if (throttleTimer) {
            // A write is already scheduled; the latest value is captured in
            // pendingPersistValue and will be flushed when the timer fires.
            return;
        }

        throttleTimer = setTimeout(() => {
            throttleTimer = null;
            flushPendingPersist();
        }, PERSIST_THROTTLE_MS);
    },
};

if (typeof window !== 'undefined') {
    // Make sure the most recent position survives a reload/close even if the
    // throttle window hasn't elapsed yet.
    window.addEventListener('beforeunload', flushPendingPersist);
    window.addEventListener('pagehide', flushPendingPersist);
}

export const useTimestampStoreBase = createWithEqualityFn<TimestampState>()(
    persist(
        subscribeWithSelector((set, get) => ({
            setTimestamp: (timestamp: number) => {
                // No-op guard: identical values must not transition the store.
                // Without this, every poll tick (even while the second hand is
                // unchanged) would re-run subscribers and schedule a persist.
                if (get().timestamp === timestamp) {
                    return;
                }
                set({ timestamp });
            },
            timestamp: 0,
        })),
        {
            name: 'player-timestamp',
            storage: timestampStorage,
            version: 1,
        },
    ),
);

export const subscribePlayerProgress = (
    onChange: (properties: { timestamp: number }, prev: { timestamp: number }) => void,
) => {
    return useTimestampStoreBase.subscribe(
        (state) => state.timestamp,
        (timestamp, prevTimestamp) => {
            onChange({ timestamp }, { timestamp: prevTimestamp });
        },
        {
            equalityFn: (a, b) => {
                return a === b;
            },
        },
    );
};

export const usePlayerTimestamp = () => {
    const [timestamp, setLocalTimestamp] = useState(
        () => useTimestampStoreBase.getState().timestamp,
    );

    useEffect(() => {
        const syncTimestamp = () => {
            const nextTimestamp = useTimestampStoreBase.getState().timestamp;
            setLocalTimestamp((prevTimestamp) =>
                prevTimestamp !== nextTimestamp ? nextTimestamp : prevTimestamp,
            );
        };

        syncTimestamp();
        const interval = setInterval(syncTimestamp, PLAYER_TIMESTAMP_POLL_INTERVAL_MS);

        return () => clearInterval(interval);
    }, []);

    return timestamp;
};

export const setTimestamp = (timestamp: number) => {
    useTimestampStoreBase.getState().setTimestamp(timestamp);
};

/**
 * Force any throttled timestamp write to flush to storage immediately.
 * Exposed for callers that know they're at a durable boundary (e.g. just
 * before navigating away). Pause/track-change already flush automatically via
 * the timestamp-0 path in the storage adapter.
 */
export const flushTimestamp = () => {
    flushPendingPersist();
};
