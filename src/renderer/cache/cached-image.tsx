// Drop-in `<img>` replacement that resolves the `src` through the local
// thumbnail cache. Falls back to the raw URL whenever the cache pipeline
// returns the original URL unchanged. The created `blob:` URL is revoked
// on unmount and whenever the resolution inputs change, so we don't leak
// object URLs across rerenders.

import type { CSSProperties, ImgHTMLAttributes } from 'react';

import { useEffect, useRef, useState } from 'react';

import { resolveThumbnail, THUMBNAIL_UPGRADED_EVENT } from './images';

import { NO_ARTWORK_URL, PENDING_SYNC_URL } from '/@/shared/components/image/use-native-image';

// 1×1 transparent GIF — the placeholder src while a cover resolves or is pending,
// so the <img> never points at the remote server (no network draw) and never
// has an empty src.
const EMPTY_PIXEL =
    'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

export interface CachedImageProps extends ImgHTMLAttributes<HTMLImageElement> {
    itemId: string;
    placeholder?: string;
    size: number;
    src: string;
    style?: CSSProperties;
    // Surface bucket to resolve against (`table` / `itemCard` / `header` /
    // `sidebar` / `fullScreen`). Without it the numeric `size` collapses to
    // the `fullScreen` bucket — which is NOT pre-cached by default, so every
    // render paid a network fetch for the original even when a pre-sized
    // cover sat in Dexie. Small-thumbnail callers should pass the bucket
    // that matches what the sweep actually caches.
    variant?: string;
}

export const CachedImage = ({
    decoding,
    itemId,
    loading,
    placeholder,
    size,
    src,
    style,
    variant,
    ...rest
}: CachedImageProps) => {
    const [resolved, setResolved] = useState<string | undefined>(undefined);
    const [reresolveNonce, setReresolveNonce] = useState(0);
    // True while this cover is waiting for the sweep to cache it — used to gate
    // the upgrade listener so an already-loaded cell never re-resolves.
    const pendingRef = useRef(false);

    useEffect(() => {
        let cancelled = false;
        let createdBlobUrl: string | undefined;
        pendingRef.current = false;

        resolveThumbnail(itemId, variant ?? size, src)
            .then((url) => {
                if (cancelled) {
                    if (url.startsWith('blob:')) URL.revokeObjectURL(url);
                    return;
                }
                if (url === NO_ARTWORK_URL) {
                    // Authoritative no-artwork: render the placeholder (or
                    // nothing) instead of re-fetching a URL known to 404.
                    setResolved(placeholder ?? EMPTY_PIXEL);
                    return;
                }
                if (url === PENDING_SYNC_URL) {
                    // Not cached yet (sync-only). Draw a placeholder, NEVER the
                    // remote URL — the sweep populates it and fires the upgrade
                    // event, which re-resolves this cell to the blob below.
                    pendingRef.current = true;
                    setResolved(placeholder ?? EMPTY_PIXEL);
                    return;
                }
                if (url.startsWith('blob:')) createdBlobUrl = url;
                setResolved(url);
            })
            .catch((err) => {
                if (cancelled) return;
                console.warn('[cache] thumbnail resolve failed', err);
                // Never fall back to the remote URL — show the placeholder.
                setResolved(placeholder ?? EMPTY_PIXEL);
            });

        return () => {
            cancelled = true;
            if (createdBlobUrl) URL.revokeObjectURL(createdBlobUrl);
        };
    }, [itemId, placeholder, size, src, variant, reresolveNonce]);

    // Repaint a pending cover the moment the sweep writes its row
    // (finishUpgrade fires THUMBNAIL_UPGRADED_EVENT for the degraded serve the
    // resolver recorded). Matches on itemId only — cheap, and any variant write
    // for this item is a fine trigger to re-resolve.
    useEffect(() => {
        if (typeof window === 'undefined') return undefined;
        const onUpgraded = (event: Event): void => {
            const detail = (event as CustomEvent<{ itemId: string; variant: string }>).detail;
            if (!pendingRef.current || detail?.itemId !== itemId) return;
            setReresolveNonce((n) => n + 1);
        };
        window.addEventListener(THUMBNAIL_UPGRADED_EVENT, onUpgraded);
        return () => window.removeEventListener(THUMBNAIL_UPGRADED_EVENT, onUpgraded);
    }, [itemId]);

    return (
        <img
            // Decode off the main thread by default to avoid scroll jank on
            // large grids; `loading="lazy"` defers off-screen fetches (a
            // no-op on already-resolved blob: URLs, beneficial on the remote
            // fallback URL). Both stay overridable by the caller via `rest`-
            // less explicit props so existing callers keep their behaviour.
            decoding={decoding ?? 'async'}
            loading={loading ?? 'lazy'}
            {...rest}
            // Never the remote `src`: until the cache resolves we draw the
            // placeholder / transparent pixel, so a synced library never
            // re-downloads a cover it already has.
            src={resolved ?? placeholder ?? EMPTY_PIXEL}
            style={style}
        />
    );
};
