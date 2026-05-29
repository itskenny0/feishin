/**
 * Transport selector behavior: presence-recency + master-toggle fallback.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    __resetForTests,
    forgetPeer,
    getPeerIdForJellyfinDeviceId,
    MQTT_PRESENCE_TTL_MS,
    pickTransport,
    pickTransportByJellyfinDeviceId,
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

describe('jellyfin-deviceId bridge', () => {
    it('returns undefined for a deviceId we have no presence for', () => {
        expect(getPeerIdForJellyfinDeviceId('jf-device-1')).toBeUndefined();
        expect(pickTransportByJellyfinDeviceId('jf-device-1')).toBe('jellyfin');
    });

    it('returns undefined for an empty deviceId so the picker never bridges a blank row', () => {
        expect(getPeerIdForJellyfinDeviceId('')).toBeUndefined();
    });

    it('maps deviceId -> peerId when presence carries `dev`', () => {
        setSyncEnabled(true);
        recordPresence('peer-1', true, Date.now(), 'jf-device-1');
        expect(getPeerIdForJellyfinDeviceId('jf-device-1')).toBe('peer-1');
        expect(pickTransportByJellyfinDeviceId('jf-device-1')).toBe('mqtt');
    });

    it('respects presence freshness — a stale bridge resolves back to jellyfin', () => {
        setSyncEnabled(true);
        const now = 1_000_000;
        recordPresence('peer-1', true, now, 'jf-device-1');
        expect(pickTransportByJellyfinDeviceId('jf-device-1', now)).toBe('mqtt');
        expect(pickTransportByJellyfinDeviceId('jf-device-1', now + MQTT_PRESENCE_TTL_MS + 1)).toBe(
            'jellyfin',
        );
    });

    it('respects the master toggle — bridge resolves to jellyfin when sync is off', () => {
        recordPresence('peer-1', true, Date.now(), 'jf-device-1');
        expect(pickTransportByJellyfinDeviceId('jf-device-1')).toBe('jellyfin');
        expect(getPeerIdForJellyfinDeviceId('jf-device-1')).toBe('peer-1');
    });

    it('LWT offline RELEASES the bridge entry so a dead peer cannot hold a deviceId (B2)', () => {
        setSyncEnabled(true);
        recordPresence('peer-1', true, Date.now(), 'jf-device-1');
        recordPresence('peer-1', false, Date.now(), 'jf-device-1');
        // B2: an explicit offline releases LIVE routing ownership — otherwise a
        // departed peer keeps routing commands to a dead peer and makes the
        // mirror's gate reject a legitimate new owner's frames. The lane also
        // resolves to jellyfin (presence not fresh). Last-known dev for
        // diagnostics is still readable from presence.get(peerId).
        expect(getPeerIdForJellyfinDeviceId('jf-device-1')).toBeUndefined();
        expect(pickTransportByJellyfinDeviceId('jf-device-1')).toBe('jellyfin');
    });

    it('updating a peer to a new deviceId drops the stale bridge entry', () => {
        setSyncEnabled(true);
        recordPresence('peer-1', true, Date.now(), 'jf-device-old');
        expect(getPeerIdForJellyfinDeviceId('jf-device-old')).toBe('peer-1');
        recordPresence('peer-1', true, Date.now(), 'jf-device-new');
        expect(getPeerIdForJellyfinDeviceId('jf-device-old')).toBeUndefined();
        expect(getPeerIdForJellyfinDeviceId('jf-device-new')).toBe('peer-1');
    });

    it('last-writer-wins when two peers claim the same deviceId', () => {
        setSyncEnabled(true);
        recordPresence('peer-1', true, Date.now(), 'shared-device');
        recordPresence('peer-2', true, Date.now(), 'shared-device');
        // peer-2 now owns the bridge. If peer-1 later goes offline its
        // forgetPeer call must NOT delete peer-2's mapping.
        forgetPeer('peer-1');
        expect(getPeerIdForJellyfinDeviceId('shared-device')).toBe('peer-2');
    });

    it('forgetPeer removes the bridge entry only when it still points to that peer', () => {
        setSyncEnabled(true);
        recordPresence('peer-1', true, Date.now(), 'jf-device-1');
        forgetPeer('peer-1');
        expect(getPeerIdForJellyfinDeviceId('jf-device-1')).toBeUndefined();
    });

    it('presence without `dev` does not register a bridge entry', () => {
        setSyncEnabled(true);
        recordPresence('peer-1', true);
        // peer-1 is online via MQTT, but with no jellyfinDeviceId published,
        // the picker has no way to bridge a Jellyfin device row to it.
        expect(pickTransport('peer-1')).toBe('mqtt');
        expect(getPeerIdForJellyfinDeviceId('jf-device-1')).toBeUndefined();
    });

    it('__resetForTests clears the reverse map', () => {
        setSyncEnabled(true);
        recordPresence('peer-1', true, Date.now(), 'jf-device-1');
        expect(getPeerIdForJellyfinDeviceId('jf-device-1')).toBe('peer-1');
        __resetForTests();
        expect(getPeerIdForJellyfinDeviceId('jf-device-1')).toBeUndefined();
    });
});
