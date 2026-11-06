// @vitest-environment node
import { afterAll, describe, expect, it, vi } from 'vitest';

type Handler = (...args: unknown[]) => unknown;

const { handlers, mpv, propertySets } = vi.hoisted(() => {
    // Plain functions, not vi.fn: a spy attaches its own .then() to returned
    // promises, which would mark a floating rejection as handled.
    const propertySets: { calls: number; reject: Error | null } = { calls: 0, reject: null };
    return {
        handlers: new Map<string, Handler>(),
        mpv: {
            isRunning: () => true,
            on: () => {},
            quit: vi.fn(),
            setMultipleProperties: () => {
                propertySets.calls += 1;
                const error = propertySets.reject;
                propertySets.reject = null;
                return error ? Promise.reject(error) : Promise.resolve();
            },
            start: async () => {},
            stop: async () => {},
        },
        propertySets,
    };
});

vi.mock('electron', () => ({
    app: { on: () => {} },
    ipcMain: {
        handle: (channel: string, fn: Handler) => handlers.set(channel, fn),
        on: (channel: string, fn: Handler) => handlers.set(channel, fn),
    },
    powerMonitor: { on: () => {} },
}));
vi.mock('node-mpv', () => ({ default: vi.fn(() => mpv) }));
vi.mock('../../../index', () => ({ getMainWindow: () => null, sendToastToRenderer: vi.fn() }));
vi.mock('../../../logger', () => ({
    default: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock('../settings', () => ({ store: { get: () => undefined } }));
vi.mock('/@/main/env', () => ({ isMacOS: () => false, isWindows: () => false }));

// Plain emitter view: process.listeners() has no overload for a union of event names.
const proc: NodeJS.EventEmitter = process;
const CRASH_EVENTS = ['uncaughtException', 'unhandledRejection'];
const listenersBefore = new Map(CRASH_EVENTS.map((event) => [event, proc.listeners(event)]));
const addedListeners = (event: string) =>
    proc.listeners(event).filter((listener) => !listenersBefore.get(event)!.includes(listener));

await import('./index');

afterAll(() => {
    for (const event of CRASH_EVENTS) {
        for (const listener of addedListeners(event)) proc.removeListener(event, listener as never);
    }
});

describe('main mpv player', () => {
    it('does not register process-wide crash handlers that tear down mpv', () => {
        // The main process survives these (index.ts logs them), so a handler
        // that quits mpv would silently kill playback on any unrelated error.
        for (const event of CRASH_EVENTS) expect(addedListeners(event)).toHaveLength(0);
    });

    it('handles a rejected property set without leaving the promise unhandled', async () => {
        await handlers.get('player-initialize')?.({}, {});
        propertySets.calls = 0;
        propertySets.reject = Object.assign(new Error('invalid parameter'), { errcode: 3 });

        const unhandled = vi.fn();
        process.on('unhandledRejection', unhandled);
        try {
            await handlers.get('player-set-properties')?.({}, { 'audio-format': undefined });
            await new Promise((resolve) => setTimeout(resolve, 10));
        } finally {
            process.removeListener('unhandledRejection', unhandled);
        }

        expect(propertySets.calls).toBe(1);
        expect(unhandled).not.toHaveBeenCalled();
        expect(mpv.quit).not.toHaveBeenCalled();
    });
});
