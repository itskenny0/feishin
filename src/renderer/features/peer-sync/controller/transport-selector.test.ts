/**
 * Transport selector behavior: presence-recency + master-toggle fallback.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    __resetForTests,
    forgetPeer,
    MQTT_PRESENCE_TTL_MS,
    pickTransport,
    recordPresence,
    setSyncEnabled,
    subscribe,
    sweepStalePresence,
} from '/@/renderer/features/peer-sync/controller/transport-selector';

beforeEach(() => {
    __resetForTests();
});

describe('transport-selector', () => {
    it('defaults to the jellyfin lane when sync is disabled', () => {
        recordPresence('peer-1', true);
        expect(pickTransport('peer-1')).toBe('jellyfin');
    });

    it('switches to mqtt when sync is enabled and presence is fresh', () => {
        setSyncEnabled(true);
        recordPresence('peer-1', true);
        expect(pickTransport('peer-1')).toBe('mqtt');
    });

    it('falls back to jellyfin when presence is stale', () => {
        setSyncEnabled(true);
        const now = 1_000_000;
        recordPresence('peer-1', true, now);
        expect(pickTransport('peer-1', now + 1_000)).toBe('mqtt');
        expect(pickTransport('peer-1', now + MQTT_PRESENCE_TTL_MS + 1)).toBe('jellyfin');
    });

    it('falls back to jellyfin when LWT marks the peer offline', () => {
        setSyncEnabled(true);
        recordPresence('peer-1', true);
        expect(pickTransport('peer-1')).toBe('mqtt');
        recordPresence('peer-1', false);
        expect(pickTransport('peer-1')).toBe('jellyfin');
    });

    it('flipping master toggle off forces every peer to jellyfin', () => {
        setSyncEnabled(true);
        recordPresence('peer-1', true);
        recordPresence('peer-2', true);
        expect(pickTransport('peer-1')).toBe('mqtt');
        expect(pickTransport('peer-2')).toBe('mqtt');
        setSyncEnabled(false);
        expect(pickTransport('peer-1')).toBe('jellyfin');
        expect(pickTransport('peer-2')).toBe('jellyfin');
    });

    it('forgetPeer drops the peer and notifies the listener of a flip', () => {
        setSyncEnabled(true);
        const flips: Array<[string, string]> = [];
        subscribe((peerId, kind) => flips.push([peerId, kind]));
        recordPresence('peer-1', true);
        expect(flips).toEqual([['peer-1', 'mqtt']]);
        forgetPeer('peer-1');
        expect(flips).toEqual([
            ['peer-1', 'mqtt'],
            ['peer-1', 'jellyfin'],
        ]);
        expect(pickTransport('peer-1')).toBe('jellyfin');
    });

    it('notifies subscribers only on transport changes, not on every presence frame', () => {
        setSyncEnabled(true);
        const listener = vi.fn();
        subscribe(listener);
        recordPresence('peer-1', true, 100);
        recordPresence('peer-1', true, 200);
        recordPresence('peer-1', true, 300);
        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener).toHaveBeenLastCalledWith('peer-1', 'mqtt');
    });

    it('sweepStalePresence ages out a peer whose presence stops landing', () => {
        setSyncEnabled(true);
        const listener = vi.fn();
        subscribe(listener);
        const now = 1_000_000;
        recordPresence('peer-1', true, now);
        expect(pickTransport('peer-1', now)).toBe('mqtt');
        sweepStalePresence(now + MQTT_PRESENCE_TTL_MS + 1);
        expect(pickTransport('peer-1', now + MQTT_PRESENCE_TTL_MS + 1)).toBe('jellyfin');
        // The listener saw mqtt-up then jellyfin-fallback.
        expect(listener).toHaveBeenNthCalledWith(1, 'peer-1', 'mqtt');
        expect(listener).toHaveBeenNthCalledWith(2, 'peer-1', 'jellyfin');
    });
});
