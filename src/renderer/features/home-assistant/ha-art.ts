// Cover-art publisher for the Home Assistant bridge.
//
// Instead of handing Home Assistant a URL to fetch (which requires HA to reach
// the media server), we fetch the cover bytes in-app and publish them as
// base64 to the art topic. HA's `image` entity (image_encoding: b64) decodes
// and serves them, so artwork works regardless of HA's network position.
//
// Cover bytes only change when the track changes, so we publish on track
// identity change — never on the per-tick position updates.

import type { QueueSong } from '/@/shared/types/domain-types';

import { getItemImageUrl } from '/@/renderer/components/item-image/item-image';
import { usePlayerStoreBase } from '/@/renderer/store/player.store';
import { LibraryItem } from '/@/shared/types/domain-types';

const log = (...a: unknown[]) => console.info('[home-assistant]', ...a);
const warn = (...a: unknown[]) => console.warn('[home-assistant]', ...a);

// Resolve an absolute server cover URL from the song's imageId. QueueSong's own
// imageUrl is null off the wire (the UI fills it lazily), so we build it from
// the id. `useRemoteUrl` prefers the server's external address.
export const resolveArtUrl = (current: QueueSong | undefined): string => {
    if (!current) return '';
    try {
        return (
            getItemImageUrl({
                id: current.imageId || undefined,
                imageUrl: current.imageUrl || undefined,
                itemType: LibraryItem.SONG,
                serverId: current._serverId,
                useRemoteUrl: true,
            }) ?? ''
        );
    } catch {
        return '';
    }
};

const arrayBufferToBase64 = (buf: ArrayBuffer): string => {
    const bytes = new Uint8Array(buf);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
};

// Fetch the current track's cover and return it base64-encoded, or null on any
// failure (no art, network error, non-OK response).
export const fetchArtBase64 = async (current: QueueSong | undefined): Promise<null | string> => {
    const url = resolveArtUrl(current);
    if (!url) return null;
    try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const buf = await res.arrayBuffer();
        if (buf.byteLength === 0) return null;
        return arrayBufferToBase64(buf);
    } catch (err) {
        warn('art fetch failed', { err: (err as Error).message });
        return null;
    }
};

// Stable identity for the current cover — server + image id. When it changes we
// publish fresh bytes; ticks that don't change it are ignored.
const artKey = (current: QueueSong | undefined): string =>
    current ? `${current._serverId}:${current.imageId ?? current.id}` : '';

/**
 * Subscribe the player store and publish base64 cover bytes whenever the track
 * changes. Returns an unsubscribe. `publish` should send retained to the art
 * topic.
 */
export const startHaArtPublisher = (publish: (base64: string) => void): (() => void) => {
    let lastKey = '<init>';
    const run = (): void => {
        const current = usePlayerStoreBase.getState().getCurrentSong();
        const key = artKey(current);
        if (key === lastKey) return;
        lastKey = key;
        if (!current) return; // nothing playing — leave the last retained art
        void fetchArtBase64(current).then((b64) => {
            if (b64) {
                publish(b64);
                log('art published', { bytes: b64.length });
            }
        });
    };
    const unsub = usePlayerStoreBase.subscribe(run);
    run();
    return unsub;
};
