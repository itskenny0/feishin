import { beforeEach, describe, expect, it, vi } from 'vitest';

const { currentRef } = vi.hoisted(() => ({ currentRef: { song: undefined as any } }));

vi.mock('/@/renderer/store/player.store', () => ({
    usePlayerStoreBase: {
        getState: () => ({ getCurrentSong: () => currentRef.song }),
        subscribe: () => () => {},
    },
}));

vi.mock('/@/renderer/components/item-image/item-image', () => ({
    getItemImageUrl: (args: { id?: string }) => (args.id ? `http://srv/art/${args.id}` : undefined),
}));

import { fetchArtBase64, resolveArtUrl, startHaArtPublisher } from './ha-art';

const song = (id: string) => ({ _serverId: 'srv', id, imageId: id }) as any;

describe('resolveArtUrl', () => {
    it('builds a server URL from the imageId', () => {
        expect(resolveArtUrl(song('abc'))).toBe('http://srv/art/abc');
    });
    it('is empty with no current song', () => {
        expect(resolveArtUrl(undefined)).toBe('');
    });
});

describe('fetchArtBase64', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('fetches the cover and base64-encodes it', async () => {
        const bytes = new Uint8Array([1, 2, 3, 4]);
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({ arrayBuffer: async () => bytes.buffer, ok: true })),
        );
        const b64 = await fetchArtBase64(song('abc'));
        expect(b64).toBe(btoa(String.fromCharCode(1, 2, 3, 4)));
    });

    it('returns null on a non-OK response', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(0), ok: false })),
        );
        expect(await fetchArtBase64(song('abc'))).toBeNull();
    });

    it('returns null when there is no art url', async () => {
        expect(await fetchArtBase64(undefined)).toBeNull();
    });
});

describe('startHaArtPublisher', () => {
    beforeEach(() => {
        currentRef.song = undefined;
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({ arrayBuffer: async () => new Uint8Array([9]).buffer, ok: true })),
        );
    });

    it('publishes base64 art for the current track on start', async () => {
        currentRef.song = song('xyz');
        const publish = vi.fn();
        startHaArtPublisher(publish);
        await vi.waitFor(() => expect(publish).toHaveBeenCalledWith(btoa(String.fromCharCode(9))));
    });
});
