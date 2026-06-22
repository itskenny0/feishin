import { describe, expect, it } from 'vitest';

// The settings store reads window.api.utils at module-init; stub before the
// import graph (remote-eval → stores) pulls it in.
import { vi } from 'vitest';

vi.hoisted(() => {
    const g = globalThis as unknown as { window?: { api?: unknown } };
    g.window = g.window ?? {};
    g.window.api = {
        localSettings: { set: () => {} },
        utils: {
            isLinux: () => false,
            isMacOS: () => false,
            isWindows: () => true,
        },
    };
});

import { runEvalCommand } from './remote-eval';

describe('runEvalCommand', () => {
    it('evaluates an expression and serializes the result', async () => {
        expect(await runEvalCommand('return 6 * 7')).toEqual({ result: '42' });
    });

    it('supports await in the command body', async () => {
        expect(await runEvalCommand('return await Promise.resolve(1 + 1)')).toEqual({
            result: '2',
        });
    });

    it('serializes objects as pretty JSON', async () => {
        const out = await runEvalCommand('return { a: 1, b: [2, 3] }');
        expect(JSON.parse(out.result as string)).toEqual({ a: 1, b: [2, 3] });
    });

    it('reports undefined explicitly', async () => {
        expect(await runEvalCommand('return undefined')).toEqual({ result: 'undefined' });
    });

    it('captures thrown errors instead of throwing into the app', async () => {
        const out = await runEvalCommand('throw new Error("boom")');
        expect(out.error).toContain('boom');
        expect(out.result).toBeUndefined();
    });

    it('survives circular references', async () => {
        const out = await runEvalCommand('const o = {}; o.self = o; return o');
        expect(out.result).toContain('[Circular]');
    });

    it('exposes the feishin debug handles to the command', async () => {
        expect(await runEvalCommand('return typeof feishin.cacheStore')).toEqual({
            result: '"function"',
        });
    });
});
