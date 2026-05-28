/**
 * Round-trip + version-drop tests for the peer-sync codec.
 *
 * The codec is the gatekeeper that prevents us from delivering a malformed
 * frame to the dispatcher / mirror. Anything malformed MUST return null on
 * decode so the caller drops it; nothing in higher layers should ever have
 * to inspect a frame's structural integrity.
 */
import { describe, expect, it } from 'vitest';

import {
    buildCommand,
    buildPresence,
    buildState,
    jellyfinToPeerRepeat,
    peerToJellyfinRepeat,
} from '/@/renderer/features/peer-sync/protocol/builders';
import { codec } from '/@/renderer/features/peer-sync/protocol/codec';
import { parseTopic, topicFor } from '/@/renderer/features/peer-sync/protocol/topics';
import { PROTOCOL_VERSION } from '/@/renderer/features/peer-sync/types';

describe('peer-sync codec', () => {
    it('round-trips a command frame', () => {
        const frame = buildCommand('seek', { positionMs: 12_345 });
        const bytes = codec.encode(frame);
        const decoded = codec.decode(bytes);
        expect(decoded).toEqual(frame);
    });

    it('round-trips a state frame including a track', () => {
        const frame = buildState({
            dur: 240_000,
            paused: false,
            pos: 5_000,
            rep: 'all',
            shuf: true,
            track: {
                album: 'OK Computer',
                art: 'https://example.com/art.jpg',
                artist: 'Radiohead',
                id: 'track-123',
                title: 'Paranoid Android',
            },
            vol: 67,
        });
        const decoded = codec.decode(codec.encode(frame));
        expect(decoded).toEqual(frame);
    });

    it('round-trips a state frame with no track loaded', () => {
        const frame = buildState({
            dur: 0,
            paused: true,
            pos: 0,
            rep: 'off',
            shuf: false,
            track: null,
            vol: 100,
        });
        const decoded = codec.decode(codec.encode(frame));
        expect(decoded).toEqual(frame);
    });

    it('round-trips a presence frame', () => {
        const frame = buildPresence(true);
        const decoded = codec.decode(codec.encode(frame));
        expect(decoded).toEqual(frame);
        expect(codec.decode(codec.encode(buildPresence(false)))?.t).toBe('presence');
    });

    it('drops a frame with an unknown protocol version', () => {
        const future = {
            k: 'play',
            t: 'cmd',
            ts: Date.now(),
            v: PROTOCOL_VERSION + 1,
        };
        const bytes = new TextEncoder().encode(JSON.stringify(future));
        expect(codec.decode(bytes)).toBeNull();
    });

    it('drops a frame with the wrong discriminator', () => {
        const garbage = {
            t: 'mystery',
            ts: Date.now(),
            v: PROTOCOL_VERSION,
        };
        const bytes = new TextEncoder().encode(JSON.stringify(garbage));
        expect(codec.decode(bytes)).toBeNull();
    });

    it('drops a state frame missing required numeric fields', () => {
        const malformed = {
            paused: false,
            pos: 0,
            rep: 'off',
            shuf: false,
            t: 'state',
            track: null,
            ts: Date.now(),
            v: PROTOCOL_VERSION,
            vol: 100,
            // dur omitted
        };
        const bytes = new TextEncoder().encode(JSON.stringify(malformed));
        expect(codec.decode(bytes)).toBeNull();
    });

    it('drops a state frame with an invalid repeat mode', () => {
        const malformed = {
            dur: 0,
            paused: false,
            pos: 0,
            rep: 'sometimes',
            shuf: false,
            t: 'state',
            track: null,
            ts: Date.now(),
            v: PROTOCOL_VERSION,
            vol: 100,
        };
        const bytes = new TextEncoder().encode(JSON.stringify(malformed));
        expect(codec.decode(bytes)).toBeNull();
    });

    it('drops a JSON-syntactically-broken payload without throwing', () => {
        const bytes = new TextEncoder().encode('{not json');
        expect(codec.decode(bytes)).toBeNull();
    });

    /**
     * Regression: when the wire format gained `mut`, `lyr`, `qIds`, `qIdx` and
     * `rate` after the initial v1 cut, the codec validator had to accept
     * frames with any subset of those fields absent. A publisher that doesn't
     * carry mute (e.g. an older Feishin) must still decode cleanly here.
     */
    it('round-trips a state frame with the new optional v1+ fields populated', () => {
        const frame = buildState({
            dur: 240_000,
            lyr: true,
            mut: true,
            paused: false,
            pos: 5_000,
            qIds: ['a', 'b', 'c', 'd'],
            qIdx: 2,
            rate: 1.25,
            rep: 'all',
            shuf: true,
            track: { album: null, art: null, artist: null, id: 't-9', title: 'x' },
            vol: 67,
        });
        const decoded = codec.decode(codec.encode(frame));
        expect(decoded).toEqual(frame);
        // Sanity check on the wire shape — `mut`/`qIds`/`qIdx`/`rate`/`lyr`
        // all populated.
        expect((decoded as typeof frame).mut).toBe(true);
        expect((decoded as typeof frame).qIds).toEqual(['a', 'b', 'c', 'd']);
        expect((decoded as typeof frame).qIdx).toBe(2);
        expect((decoded as typeof frame).rate).toBe(1.25);
        expect((decoded as typeof frame).lyr).toBe(true);
    });

    it('accepts a state frame from an older publisher that omits the v1+ optional fields', () => {
        // Hand-build the frame so `buildState` doesn't tack on optional
        // fields — this simulates what an older publisher would emit.
        const frame = {
            dur: 100,
            paused: true,
            pos: 0,
            rep: 'off' as const,
            shuf: false,
            t: 'state' as const,
            track: null,
            ts: Date.now(),
            v: PROTOCOL_VERSION,
            vol: 100,
        };
        const decoded = codec.decode(codec.encode(frame));
        expect(decoded).not.toBeNull();
        expect((decoded as typeof frame & { mut?: boolean }).mut).toBeUndefined();
    });

    it('drops a state frame whose optional `mut` field is the wrong type', () => {
        const malformed = {
            dur: 100,
            mut: 'yes',
            paused: true,
            pos: 0,
            rep: 'off',
            shuf: false,
            t: 'state',
            track: null,
            ts: Date.now(),
            v: PROTOCOL_VERSION,
            vol: 100,
        };
        const bytes = new TextEncoder().encode(JSON.stringify(malformed));
        expect(codec.decode(bytes)).toBeNull();
    });

    it('drops a state frame whose `qIds` array contains a non-string entry', () => {
        const malformed = {
            dur: 100,
            paused: true,
            pos: 0,
            qIds: ['a', 7, 'b'],
            rep: 'off',
            shuf: false,
            t: 'state',
            track: null,
            ts: Date.now(),
            v: PROTOCOL_VERSION,
            vol: 100,
        };
        const bytes = new TextEncoder().encode(JSON.stringify(malformed));
        expect(codec.decode(bytes)).toBeNull();
    });

    it('round-trips the `mute` and `playIndex` command verbs', () => {
        const muteCmd = buildCommand('mute', { mute: true });
        const decodedMute = codec.decode(codec.encode(muteCmd));
        expect(decodedMute).toEqual(muteCmd);

        const indexCmd = buildCommand('playIndex', { index: 7 });
        const decodedIndex = codec.decode(codec.encode(indexCmd));
        expect(decodedIndex).toEqual(indexCmd);
    });

    it('maps jellyfin repeat strings to the compact enum and back', () => {
        expect(jellyfinToPeerRepeat('RepeatNone')).toBe('off');
        expect(jellyfinToPeerRepeat('RepeatAll')).toBe('all');
        expect(jellyfinToPeerRepeat('RepeatOne')).toBe('one');
        expect(jellyfinToPeerRepeat(undefined)).toBe('off');
        expect(jellyfinToPeerRepeat('Unknown')).toBe('off');
        expect(peerToJellyfinRepeat('off')).toBe('RepeatNone');
        expect(peerToJellyfinRepeat('all')).toBe('RepeatAll');
        expect(peerToJellyfinRepeat('one')).toBe('RepeatOne');
    });
});

describe('peer-sync topics', () => {
    it('builds and re-parses a topic', () => {
        const topic = topicFor({ peerId: 'peer-xyz', userId: 'user-abc' }, 'state');
        expect(topic).toBe(`feishin/v${PROTOCOL_VERSION}/user-abc/peer-xyz/state`);
        const parsed = parseTopic(topic);
        expect(parsed?.addr).toEqual({ peerId: 'peer-xyz', userId: 'user-abc' });
        expect(parsed?.leaf).toBe('state');
    });

    it('rejects topics outside the feishin namespace', () => {
        expect(parseTopic('something/else/entirely')).toBeNull();
        expect(parseTopic(`feishin/v999/u/p/state`)).toBeNull();
        expect(parseTopic(`feishin/v${PROTOCOL_VERSION}/u/p/bogus`)).toBeNull();
    });

    it('sanitizes user / peer ids so they cannot escape the namespace', () => {
        // A user id containing a slash would otherwise spill into the next
        // segment and accidentally subscribe to a different peer.
        const topic = topicFor({ peerId: 'p/with+plus', userId: 'u/with/slash' }, 'cmd');
        const parsed = parseTopic(topic);
        expect(parsed).not.toBeNull();
        expect(parsed!.addr.userId).not.toContain('/');
        expect(parsed!.addr.peerId).not.toContain('/');
        expect(parsed!.addr.peerId).not.toContain('+');
    });
});
