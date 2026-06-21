// The sync runner: drives `hydrate(server, 'full')` while the gate is blocking
// the app, with auto-retry + exponential backoff and an escape hatch.
//
// hydrate() swallows its own errors (every caller invokes it as fire-and-
// forget), so the runner detects success/failure structurally: after each run
// resolves we re-read the live hydration states. If every enabled gate entity
// reached `full` → success (persist the per-server completion flag, releasing
// the gate). Otherwise the attempt is treated as incomplete/failed → increment
// the consecutive-failure counter and schedule the next attempt after a backoff
// delay. After ESCAPE_HATCH_AFTER_FAILURES consecutive failures the dashboard
// surfaces "Continue anyway".
//
// Logging is tagged `[sync-gate]` at every lifecycle boundary.

import type { ServerListItem } from '/@/shared/types/domain-types';

import { useCallback, useEffect, useRef, useState } from 'react';

import { hydrate } from '../sync';
import { backoffDelayMs, canContinueAnyway } from './backoff';
import { isFirstSyncComplete } from './gate-state';

import { useCacheStore } from '/@/renderer/cache/store';
import { useSettingsStore } from '/@/renderer/store';

const TAG = '[sync-gate]';

export type RunnerPhase = 'failed' | 'idle' | 'retry-wait' | 'syncing';

export interface SyncRunnerState {
    // 1-indexed attempt number currently running / last run.
    attempt: number;
    // Whether the "Continue anyway" escape hatch should be offered.
    canContinue: boolean;
    // Consecutive incomplete/failed attempts.
    failureCount: number;
    // Last error message, if the run threw before completion.
    lastError: string | undefined;
    // Epoch ms when the next retry fires (during 'retry-wait').
    nextRetryAt: number | undefined;
    phase: RunnerPhase;
}

const INITIAL: SyncRunnerState = {
    attempt: 0,
    canContinue: false,
    failureCount: 0,
    lastError: undefined,
    nextRetryAt: undefined,
    phase: 'idle',
};

/**
 * Runs the blocking first-full-sync for `server`. Only call while the gate is
 * actually blocking (the SyncGate mounts the dashboard, which mounts this).
 * Unmounts when the gate releases, which cancels any pending retry timer (the
 * in-flight hydrate keeps running harmlessly — its results still land in the
 * cache).
 */
export const useSyncRunner = (server: null | ServerListItem): SyncRunnerState => {
    const [state, setState] = useState<SyncRunnerState>(INITIAL);
    const serverId = server?.id;

    // Refs so the async run loop reads live values without re-subscribing.
    const cancelledRef = useRef(false);
    const retryTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const failureCountRef = useRef(0);
    const runningRef = useRef(false);

    const clearRetryTimer = useCallback(() => {
        if (retryTimerRef.current) {
            clearTimeout(retryTimerRef.current);
            retryTimerRef.current = undefined;
        }
    }, []);

    useEffect(() => {
        if (!server) return undefined;

        cancelledRef.current = false;
        failureCountRef.current = 0;

        const runOnce = async (): Promise<void> => {
            if (cancelledRef.current || runningRef.current) return;
            runningRef.current = true;
            const attempt = failureCountRef.current + 1;
            console.info(`${TAG} starting full sync attempt`, { attempt, serverId });
            setState((s) => ({
                ...s,
                attempt,
                lastError: undefined,
                nextRetryAt: undefined,
                phase: 'syncing',
            }));

            let threw: string | undefined;
            try {
                await hydrate(server, 'full');
            } catch (err) {
                // hydrate() swallows internally, but guard anyway.
                threw = (err as Error)?.message ?? String(err);
                console.warn(`${TAG} full sync attempt threw`, { attempt, error: threw });
            } finally {
                runningRef.current = false;
            }

            if (cancelledRef.current) return;

            const { entities } = useSettingsStore.getState().localCache;
            const hydrationStates = useCacheStore.getState().hydrationStates;
            const complete = isFirstSyncComplete(entities, hydrationStates);

            if (complete) {
                console.info(`${TAG} full sync complete`, { attempt, serverId });
                failureCountRef.current = 0;
                useSettingsStore.getState().actions.setFirstSyncComplete(server.id, false);
                setState((s) => ({
                    ...s,
                    canContinue: false,
                    failureCount: 0,
                    lastError: undefined,
                    nextRetryAt: undefined,
                    phase: 'idle',
                }));
                return;
            }

            // Incomplete (a sweep aborted, the server stalled, or some entity
            // never reached `full`). Treat as a failure and schedule a retry.
            failureCountRef.current += 1;
            const failureCount = failureCountRef.current;
            const delay = backoffDelayMs(failureCount);
            const nextRetryAt = Date.now() + delay;
            console.warn(`${TAG} full sync incomplete, scheduling retry`, {
                attempt,
                delayMs: delay,
                failureCount,
                serverId,
            });
            setState((s) => ({
                ...s,
                canContinue: canContinueAnyway(failureCount),
                failureCount,
                lastError: threw,
                nextRetryAt,
                phase: 'retry-wait',
            }));
            clearRetryTimer();
            retryTimerRef.current = setTimeout(() => {
                if (cancelledRef.current) return;
                void runOnce();
            }, delay);
        };

        void runOnce();

        return () => {
            cancelledRef.current = true;
            clearRetryTimer();
        };
        // Re-run only when the target server identity changes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [serverId]);

    return state;
};
