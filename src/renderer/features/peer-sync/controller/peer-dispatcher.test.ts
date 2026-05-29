/**
 * peer-dispatcher MQTT-lane coalescing (J5).
 *
 * The Jellyfin lane already collapses a slider drag into leading + trailing
 * via command-dispatcher's coalesceTrailing. The MQTT lane published EVERY
 * seek/volume invocation — a 60-event drag became 60 QoS-0 publishes. This
 * pins the per-(peer, verb) coalesce that brings the MQTT lane to parity.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PeerCommand } from '/@/renderer/features/peer-sync/types';

const published: PeerCommand[] = [];
vi.mock('/@/renderer/features/peer-sync/controller/peer-client', () => ({
    publishCommand: (_peer: unknown, cmd: PeerCommand) => published.push(cmd),
}));

import {
    __resetMqttCoalesce,
    peerDispatcher,
} from '/@/renderer/features/peer-sync/controller/peer-dispatcher';
import {
    recordPresence,
    __resetForTests as resetTransportSelector,
    setSyncEnabled,
} from '/@/renderer/features/peer-sync/controller/transport-selector';

const ctx = () => ({
    peer: { peerId: 'peer-1', userId: 'u' },
    server: { credential: 't', id: 's', type: 'jellyfin', url: 'x', userId: 'u' } as never,
    sessionId: 'sess',
});

beforeEach(() => {
    published.length = 0;
    resetTransportSelector();
    __resetMqttCoalesce();
    setSyncEnabled(true);
    // Fresh MQTT presence so the dispatcher routes via the MQTT lane.
    recordPresence('peer-1', true);
});

afterEach(() => {
    __resetMqttCoalesce();
    resetTransportSelector();
    vi.useRealTimers();
});

describe('peer-dispatcher MQTT coalescing (J5)', () => {
    it('routes a single setVolume through the MQTT lane immediately (leading edge)', () => {
        peerDispatcher.setVolume(ctx(), 40);
        expect(published).toHaveLength(1);
        expect(published[0].k).toBe('volume');
        expect((published[0].a as { volume: number }).volume).toBe(40);
    });

    it('collapses a burst of setVolume into leading + trailing with the final value', () => {
        vi.useFakeTimers();
        for (let v = 1; v <= 60; v += 1) peerDispatcher.setVolume(ctx(), v);
        // Leading edge fired once immediately; the rest are coalesced.
        expect(published).toHaveLength(1);
        expect((published[0].a as { volume: number }).volume).toBe(1);
        // Trailing publish lands after the window with the LAST value.
        vi.advanceTimersByTime(100);
        expect(published).toHaveLength(2);
        expect((published[1].a as { volume: number }).volume).toBe(60);
    });

    it('coalesces seek the same way and keeps a separate slot from volume', () => {
        vi.useFakeTimers();
        for (let p = 0; p < 30; p += 1) peerDispatcher.seek(ctx(), p * 1000);
        for (let v = 1; v <= 30; v += 1) peerDispatcher.setVolume(ctx(), v);
        // Each verb has its own leading edge.
        const seeks = published.filter((c) => c.k === 'seek');
        const vols = published.filter((c) => c.k === 'volume');
        expect(seeks).toHaveLength(1);
        expect(vols).toHaveLength(1);
        vi.advanceTimersByTime(100);
        const seeksAfter = published.filter((c) => c.k === 'seek');
        const volsAfter = published.filter((c) => c.k === 'volume');
        expect(seeksAfter).toHaveLength(2);
        expect(volsAfter).toHaveLength(2);
        // Final values land.
        expect((seeksAfter[1].a as { positionMs: number }).positionMs).toBe(29_000);
        expect((volsAfter[1].a as { volume: number }).volume).toBe(30);
    });
});
