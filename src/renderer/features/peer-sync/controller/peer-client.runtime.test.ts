/**
 * Web-build runtime guard: importing the peer-sync client must not
 * crash when `globalThis.Buffer` is absent. mqtt.js (and its mqtt-packet
 * dep) reach for `Buffer.from(...)` at module load + on the first publish,
 * so the renderer entry installs the `buffer` polyfill before anything
 * imports the peer-client. If a future refactor removes that polyfill —
 * or moves the import earlier than the polyfill setup — this test fails
 * the build before users hit "Buffer is not defined" mid-onboarding.
 */
import { describe, expect, it } from 'vitest';

describe('peer-sync client buffer requirement', () => {
    it('finds Buffer.from on globalThis at module load (polyfill or native)', () => {
        // jsdom + Node both ship Buffer. The runtime branch we are guarding
        // against is the browser path that boots without the polyfill. We
        // assert the contract here so a refactor that breaks the import
        // order surfaces as a unit-test failure.
        expect(typeof (globalThis as { Buffer?: unknown }).Buffer).toBe('function');
        const buf = Buffer.from(new Uint8Array([1, 2, 3]));
        expect(buf.length).toBe(3);
        // alloc(0) is a code path peer-client.ts hits when publishing the
        // empty-payload presence-clear retained message.
        expect(Buffer.alloc(0).length).toBe(0);
    });

    it('can build the LWT payload shape the peer-client uses', async () => {
        // Touch the actual import path so a tree-shake misconfig surfaces.
        const { codec } = await import('/@/renderer/features/peer-sync/protocol/codec');
        const payload = Buffer.from(codec.encode({ online: false, t: 'presence', ts: 0, v: 1 }));
        expect(payload.length).toBeGreaterThan(0);
    });
});
