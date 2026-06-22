// Remote eval channel for live debugging.
//
// Companion to the remote-log-shipper: where that ships logs OUT, this lets a
// developer push JS IN to a running instance and read the result — the same
// way you read its shipped logs, but two-way. Built for devices that aren't
// reachable over ADB/devtools (a phone on the LAN with "Remote debug" on) so a
// stuck sweep / weird store state can be inspected and poked live.
//
// Gated entirely by the same `remoteDebug.enabled` switch as the shipper, and
// driven by it (the shipper owns the session id + endpoint and calls
// start/stopRemoteEval). It only ever runs commands an operator queued on their
// OWN receiver, and only while the user has remote debug turned on. Arbitrary
// eval is the point — this is a debug tool, off by default.

import { getActiveCacheDb } from '/@/renderer/cache/db';
import { useCacheStore } from '/@/renderer/cache/store';
import { useSettingsStore } from '/@/renderer/store/settings.store';

const POLL_MS = 2000;

let timer: null | ReturnType<typeof setInterval> = null;
let base = '';
let session = '';
let inFlight = false;

/** Best-effort serialize an eval result for transport (handles cycles/Errors). */
const safeSerialize = (v: unknown): string => {
    if (v === undefined) return 'undefined';
    const seen = new WeakSet<object>();
    try {
        const json = JSON.stringify(
            v,
            (_k, val) => {
                if (val instanceof Error) return `${val.name}: ${val.message}`;
                if (typeof val === 'bigint') return val.toString();
                if (typeof val === 'function') return `[Function ${val.name || 'anonymous'}]`;
                if (typeof val === 'object' && val !== null) {
                    if (seen.has(val)) return '[Circular]';
                    seen.add(val);
                }
                return val;
            },
            2,
        );
        return json ?? String(v);
    } catch {
        try {
            return String(v);
        } catch {
            return '[unserializable]';
        }
    }
};

/**
 * Run one eval command. The command string is the BODY of an async function, so
 * it may `return` a value and `await`. Debug handles are exposed both as a
 * `feishin` argument and on `window.__feishin` for ad-hoc console-style probing
 * (e.g. `return feishin.cacheStore.getState().sweep`,
 * `return await feishin.db()?.albums.count()`). Errors are captured, never
 * thrown into the app.
 */
export const runEvalCommand = async (js: string): Promise<{ error?: string; result?: string }> => {
    const handles = {
        cacheStore: useCacheStore,
        db: () => getActiveCacheDb(),
        settingsStore: useSettingsStore,
    };
    try {
        if (typeof window !== 'undefined') {
            (window as unknown as { __feishin?: unknown }).__feishin = handles;
        }
        const fn = new Function('feishin', `"use strict"; return (async () => { ${js} })();`);
        const result = await fn(handles);
        return { result: safeSerialize(result) };
    } catch (e) {
        return {
            error:
                e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ''}` : safeSerialize(e),
        };
    }
};

const poll = async (): Promise<void> => {
    if (inFlight || !base || !session) return;
    inFlight = true;
    try {
        const res = await fetch(`${base}/control/${encodeURIComponent(session)}`);
        if (!res.ok) return;
        const cmds = (await res.json()) as { id: string; js: string }[];
        for (const cmd of cmds) {
            const out = await runEvalCommand(cmd.js);
            await fetch(`${base}/control/${encodeURIComponent(session)}/result`, {
                body: JSON.stringify({ id: cmd.id, ...out }),
                headers: { 'Content-Type': 'application/json' },
                method: 'POST',
            }).catch(() => {});
        }
    } catch {
        // a debug channel must never throw into the app
    } finally {
        inFlight = false;
    }
};

/** Start polling the receiver's control queue for this session. Idempotent. */
export const startRemoteEval = (controlBase: string, sess: string): void => {
    base = controlBase;
    session = sess;
    if (timer) clearInterval(timer);
    timer = setInterval(() => void poll(), POLL_MS);
    console.info('[remote-eval] control channel ENABLED', { base, session });
};

export const stopRemoteEval = (): void => {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
    base = '';
    session = '';
};
