/**
 * Unit tests for the peer-sync diagnostics ring-buffer + selectors.
 *
 * The store is intentionally pure — no React, no zustand subscribers — so
 * these tests just drive the record* helpers and assert the resulting shape.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    peekDiagnostics,
    recordBrokerStatus,
    recordEmbeddedBroker,
    recordInboundCommand,
    recordInboundState,
    recordLatencySample,
    recordOutboundCommand,
    recordOutboundState,
    recordPresenceFrame,
    recordTransportFlip,
    resetDiagnostics,
} from '/@/renderer/features/peer-sync/diagnostics/diagnostics-store';
import { PROTOCOL_VERSION } from '/@/renderer/features/peer-sync/types';

const cmd = (k: string): import('/@/renderer/features/peer-sync/types').PeerCommand => ({
    k: k as never,
    t: 'cmd',
    ts: Date.now(),
    v: PROTOCOL_VERSION,
});

const state = (overrides: Partial<import('/@/renderer/features/peer-sync/types').PeerState> = {}) =>
    ({
        dur: 200_000,
        paused: false,
        pos: 30_000,
        rep: 'off' as const,
        shuf: false,
        t: 'state' as const,
        track: { album: 'a', art: null, artist: 'b', id: 'song-1', title: 'c' },
        ts: Date.now(),
        v: PROTOCOL_VERSION,
        vol: 50,
        ...overrides,
    }) as import('/@/renderer/features/peer-sync/types').PeerState;

describe('diagnostics-store', () => {
    beforeEach(() => {
        resetDiagnostics();
    });

    it('starts with empty rings + idle broker', () => {
        const s = peekDiagnostics();
        expect(s.broker.clientStatus).toBe('idle');
        expect(s.commands).toEqual([]);
        expect(s.states).toEqual([]);
        expect(s.flips).toEqual([]);
        expect(Object.keys(s.presence)).toEqual([]);
        expect(Object.keys(s.latency)).toEqual([]);
        expect(s.embeddedBroker).toEqual({ enabled: false, running: false });
    });

    it('records inbound + outbound commands separately with the right direction', () => {
        recordInboundCommand('peer-A', cmd('play'));
        recordOutboundCommand('peer-B', cmd('pause'));
        const { commands } = peekDiagnostics();
        expect(commands).toHaveLength(2);
        expect(commands[0]).toMatchObject({ direction: 'inbound', k: 'play', peerId: 'peer-A' });
        expect(commands[1]).toMatchObject({ direction: 'outbound', k: 'pause', peerId: 'peer-B' });
    });

    it('caps each ring at RING_SIZE (50) entries, dropping the oldest', () => {
        for (let i = 0; i < 60; i += 1) recordInboundCommand('p', cmd(`cmd-${i}`));
        const { commands } = peekDiagnostics();
        expect(commands).toHaveLength(50);
        // The oldest 10 should have been dropped, so we see cmd-10..cmd-59.
        expect(commands[0].k).toBe('cmd-10');
        expect(commands[commands.length - 1].k).toBe('cmd-59');
    });

    it('records state frames with the inbound/outbound direction + track title', () => {
        recordOutboundState('peer-A', state({ track: { ...state().track!, title: 'Bohemian' } }));
        recordInboundState('peer-B', state({ paused: true, pos: 12_000 }));
        const { states } = peekDiagnostics();
        expect(states).toHaveLength(2);
        expect(states[0]).toMatchObject({
            direction: 'outbound',
            peerId: 'peer-A',
            trackTitle: 'Bohemian',
        });
        expect(states[1]).toMatchObject({
            direction: 'inbound',
            paused: true,
            peerId: 'peer-B',
            pos: 12_000,
        });
    });

    it('flips presence per peer keyed by id and preserves the timestamp from the frame', () => {
        recordPresenceFrame('peer-A', {
            online: true,
            t: 'presence',
            ts: 1_000_000,
            v: PROTOCOL_VERSION,
        });
        recordPresenceFrame('peer-A', {
            online: false,
            t: 'presence',
            ts: 1_005_000,
            v: PROTOCOL_VERSION,
        });
        recordPresenceFrame('peer-B', {
            online: true,
            t: 'presence',
            ts: 1_002_000,
            v: PROTOCOL_VERSION,
        });
        const { presence } = peekDiagnostics();
        expect(presence['peer-A']).toEqual({
            lastSeenAt: 1_005_000,
            online: false,
            peerId: 'peer-A',
        });
        expect(presence['peer-B']).toEqual({
            lastSeenAt: 1_002_000,
            online: true,
            peerId: 'peer-B',
        });
    });

    it('records transport flips only when from !== to', () => {
        recordTransportFlip('peer-A', 'jellyfin', 'mqtt');
        recordTransportFlip('peer-A', 'mqtt', 'mqtt'); // no-op
        recordTransportFlip('peer-A', 'mqtt', 'jellyfin');
        const { flips } = peekDiagnostics();
        expect(flips).toHaveLength(2);
        expect(flips[0]).toMatchObject({ from: 'jellyfin', peerId: 'peer-A', to: 'mqtt' });
        expect(flips[1]).toMatchObject({ from: 'mqtt', peerId: 'peer-A', to: 'jellyfin' });
    });

    it('latency samples replace per-peer with the newest value', () => {
        recordLatencySample('peer-A', 42);
        recordLatencySample('peer-A', 18);
        recordLatencySample('peer-B', 80);
        const { latency } = peekDiagnostics();
        expect(latency['peer-A'].rttMs).toBe(18);
        expect(latency['peer-B'].rttMs).toBe(80);
    });

    it('broker status transitions stamp lastTransitionAt; identical transitions are no-ops', () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(1_000_000);
            recordBrokerStatus('connecting');
            expect(peekDiagnostics().broker.lastTransitionAt).toBe(1_000_000);
            vi.setSystemTime(1_000_500);
            recordBrokerStatus('connecting'); // same status + no error; should be a no-op
            expect(peekDiagnostics().broker.lastTransitionAt).toBe(1_000_000);
            vi.setSystemTime(1_001_000);
            recordBrokerStatus('errored', 'bad creds');
            expect(peekDiagnostics().broker.lastTransitionAt).toBe(1_001_000);
            expect(peekDiagnostics().broker.lastErrorMessage).toBe('bad creds');
        } finally {
            vi.useRealTimers();
        }
    });

    it('embedded broker status is a flat replace', () => {
        recordEmbeddedBroker({ enabled: true, listenAddress: '0.0.0.0:8083', running: true });
        expect(peekDiagnostics().embeddedBroker).toEqual({
            enabled: true,
            listenAddress: '0.0.0.0:8083',
            running: true,
        });
        recordEmbeddedBroker({ enabled: true, running: false });
        expect(peekDiagnostics().embeddedBroker).toEqual({ enabled: true, running: false });
    });

    it('resetDiagnostics clears every slice back to initial', () => {
        recordInboundCommand('p', cmd('play'));
        recordOutboundState('p', state());
        recordPresenceFrame('p', { online: true, t: 'presence', ts: 1, v: PROTOCOL_VERSION });
        recordTransportFlip('p', 'jellyfin', 'mqtt');
        recordLatencySample('p', 50);
        recordBrokerStatus('connected');
        recordEmbeddedBroker({ enabled: true, running: true });
        resetDiagnostics();
        const s = peekDiagnostics();
        expect(s.commands).toEqual([]);
        expect(s.states).toEqual([]);
        expect(s.flips).toEqual([]);
        expect(Object.keys(s.presence)).toEqual([]);
        expect(Object.keys(s.latency)).toEqual([]);
        expect(s.broker.clientStatus).toBe('idle');
        expect(s.embeddedBroker).toEqual({ enabled: false, running: false });
    });
});
