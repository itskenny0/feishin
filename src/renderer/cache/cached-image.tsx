// Drop-in `<img>` replacement that resolves the `src` through the local
// thumbnail cache. Falls back to the raw URL whenever the cache pipeline
// returns the original URL unchanged. The created `blob:` URL is revoked
// on unmount and whenever the resolution inputs change, so we don't leak
// object URLs across rerenders.

import type { CSSProperties, ImgHTMLAttributes } from 'react';

import { useEffect, useState } from 'react';

import { resolveThumbnail } from './images';

export interface CachedImageProps extends ImgHTMLAttributes<HTMLImageElement> {
    itemId: string;
    placeholder?: string;
    size: number;
    src: string;
    style?: CSSProperties;
}

export const CachedImage = ({
    decoding,
    itemId,
    loading,
    placeholder,
    size,
    src,
    style,
    ...rest
}: CachedImageProps) => {
    const [resolved, setResolved] = useState<string | undefined>(undefined);

    useEffect(() => {
        let cancelled = false;
        let createdBlobUrl: string | undefined;

        resolveThumbnail(itemId, size, src).then((url) => {
            if (cancelled) {
                if (url.startsWith('blob:')) URL.revokeObjectURL(url);
                return;
            }
            if (url.startsWith('blob:')) createdBlobUrl = url;
            setResolved(url);
        });

        return () => {
            cancelled = true;
            if (createdBlobUrl) URL.revokeObjectURL(createdBlobUrl);
        };
    }, [itemId, size, src]);

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
            src={resolved ?? placeholder ?? src}
            style={style}
        />
    );
};
