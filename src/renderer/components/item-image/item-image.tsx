import { memo, useMemo } from 'react';
import z from 'zod';

import { api } from '/@/renderer/api';
import {
    GeneralSettingsSchema,
    getServerById,
    useAuthStore,
    useBlurExplicitImages,
    useCurrentServerId,
    useImageRes,
    useSettingsStore,
} from '/@/renderer/store';
import { BaseImage, ImageProps } from '/@/shared/components/image/image';
import { useNativeImage } from '/@/shared/components/image/use-native-image';
import { ExplicitStatus, ImageRequest, LibraryItem } from '/@/shared/types/domain-types';

const getUnloaderIcon = (itemType: LibraryItem) => {
    switch (itemType) {
        case LibraryItem.ALBUM:
            return 'emptyAlbumImage';
        case LibraryItem.ALBUM_ARTIST:
            return 'emptyArtistImage';
        case LibraryItem.ARTIST:
            return 'emptyArtistImage';
        case LibraryItem.GENRE:
            return 'emptyGenreImage';
        case LibraryItem.PLAYLIST:
            return 'emptyPlaylistImage';
        case LibraryItem.SONG:
            return 'emptySongImage';
        default:
            return 'emptyImage';
    }
};

const BaseItemImage = (
    props: Omit<ImageProps, 'id' | 'src'> & {
        explicitStatus?: ExplicitStatus | null;
        id?: null | string;
        itemType: LibraryItem;
        serverId?: null | string;
        src?: null | string;
        type?: keyof z.infer<typeof GeneralSettingsSchema>['imageRes'];
    },
) => {
    const { explicitStatus, serverId, src, ...rest } = props;
    const blurExplicitImages = useBlurExplicitImages();

    // Compute the request once and derive the display `src` from it. The
    // request already carries the resolved URL (`imageRequest.url`), so the
    // previous separate `useItemImageUrl` call was a duplicate store
    // subscription + memo per card — pure overhead on large grids.
    const imageRequest = useItemImageRequest({
        id: props.id,
        imageUrl: src,
        itemType: props.itemType,
        serverId: serverId || undefined,
        type: props.type,
    });

    const imageUrl = imageRequest?.url;

    const isExplicit = blurExplicitImages && explicitStatus === ExplicitStatus.EXPLICIT;

    return (
        <BaseImage
            imageRequest={imageRequest}
            isExplicit={isExplicit}
            src={imageUrl}
            unloaderIcon={getUnloaderIcon(props.itemType)}
            {...rest}
            id={props.id || undefined}
        />
    );
};

export const ItemImage = memo(BaseItemImage);

// The thumbnail cache keys each surface bucket independently (schema v11).
// `ItemImage`'s `type` selects a `general.imageRes` entry whose names line up
// with the variant buckets one-for-one, EXCEPT the full-screen player, which
// `imageRes` calls `fullScreenPlayer` while the variant config calls it
// `fullScreen`. Map that one; pass every other surface name through verbatim.
// Anything without a `type` resolves against the full-resolution cover.
const FULL_SCREEN_VARIANT = 'fullScreen';
const surfaceToVariant = (
    type: keyof z.infer<typeof GeneralSettingsSchema>['imageRes'] | undefined,
): string => {
    if (!type) return FULL_SCREEN_VARIANT;
    return type === 'fullScreenPlayer' ? FULL_SCREEN_VARIANT : type;
};

interface UseItemImageUrlProps {
    id?: null | string;
    imageUrl?: null | string;
    itemType: LibraryItem;
    serverId?: string;
    size?: number;
    type?: keyof z.infer<typeof GeneralSettingsSchema>['imageRes'];
    useRemoteUrl?: boolean;
}

export const useItemImageUrl = (args: UseItemImageUrlProps) => {
    const { id, imageUrl, itemType, size, type, useRemoteUrl } = args;
    const serverId = useCurrentServerId();

    const imageRes = useImageRes();
    const sizeByType: number | undefined = type ? imageRes[type] : undefined;

    return useMemo(() => {
        if (imageUrl) {
            return imageUrl;
        }

        if (!id) {
            return undefined;
        }

        const targetServerId = args.serverId || serverId;
        let baseUrl: string | undefined;

        if (useRemoteUrl) {
            const server = getServerById(targetServerId);
            baseUrl = server?.remoteUrl || server?.url;
        }

        return (
            api.controller.getImageUrl({
                apiClientProps: { serverId: targetServerId },
                baseUrl,
                query: { id, itemType, size: size ?? sizeByType },
            }) || undefined
        );
    }, [args.serverId, id, imageUrl, itemType, serverId, size, sizeByType, useRemoteUrl]);
};

/**
 * Cache-backed variant of `useItemImageUrl` for consumers that render a bare
 * `<img>`/`<motion.img>` instead of `<ItemImage>` (the full-screen player's
 * crossfade machinery, the mobile cover swiper). Resolves through the SAME
 * pipeline `<BaseImage>` uses — synchronous shared-URL peek, refcounted
 * acquire, Dexie thumbnail lookup, nearest-larger fallback — and returns a
 * displayable URL string (a `blob:` URL on any cache hit, the network URL
 * as last resort, `undefined` while resolving / on error).
 *
 * Before this hook these surfaces fed the RAW server URL into the DOM, so
 * every track change re-downloaded the cover and offline sessions showed no
 * artwork at all even with a fully-synced thumbnail cache.
 */
export const useCachedItemImageUrl = (args: UseItemImageUrlProps): string | undefined => {
    const request = useItemImageRequest(args);
    const { displaySrc } = useNativeImage({
        enabled: true,
        fetchPriority: 'high',
        request,
    });
    return displaySrc;
};

// Recover the entity id from a resolved cover URL so a surface that passes only
// `imageUrl` (no explicit id) still routes through the local cache. Matches the
// item id the thumbnail sweep keys on: Jellyfin `/Items/<id>/Images/...` and
// Subsonic/Navidrome `?id=<id>` / `?coverArt=<id>`. Returns undefined for an
// unrecognised URL (genuinely external art → fetched as before).
const cacheIdFromImageUrl = (url: string): string | undefined => {
    const jf = /\/Items\/([^/?]+)\/Images/i.exec(url);
    if (jf) return jf[1];
    const sub = /[?&](?:id|coverArt)=([^&]+)/i.exec(url);
    if (sub) return decodeURIComponent(sub[1]);
    return undefined;
};

export const useItemImageRequest = (args: UseItemImageUrlProps) => {
    const { id, imageUrl, itemType, size, type, useRemoteUrl } = args;
    const serverId = useCurrentServerId();

    const imageRes = useImageRes();
    const sizeByType: number | undefined = type ? imageRes[type] : undefined;

    const variant = surfaceToVariant(type);

    return useMemo(() => {
        const effectiveSize = size ?? sizeByType;
        if (imageUrl) {
            return {
                // Tag the request with cacheItemId/cacheSize when we know
                // the entity id so the Dexie thumbnail table can intercept
                // the fetch. The `imageUrl` branch is used by callers that
                // already have a resolved URL (e.g. a remote provider) so
                // we still want the same blob to land in Dexie keyed by
                // the same id. When the caller has no explicit id (e.g.
                // artist rows carry only `Id`, no `imageId`), derive it from
                // the URL — otherwise the cover bypasses the cache and
                // re-downloads from the server even though the sweep cached
                // it keyed by that id.
                cacheItemId: id ?? cacheIdFromImageUrl(imageUrl),
                cacheKey: imageUrl,
                cacheSize: effectiveSize,
                url: imageUrl,
                variant,
            } satisfies ImageRequest;
        }

        if (!id) {
            return undefined;
        }

        const targetServerId = args.serverId || serverId;
        let baseUrl: string | undefined;

        if (useRemoteUrl) {
            const server = getServerById(targetServerId);
            baseUrl = server?.remoteUrl || server?.url;
        }

        const remote = api.controller.getImageRequest({
            apiClientProps: { serverId: targetServerId },
            baseUrl,
            query: { id, itemType, size: effectiveSize },
        });
        if (!remote) return undefined;
        return {
            ...remote,
            cacheItemId: id,
            cacheSize: effectiveSize,
            variant,
        } satisfies ImageRequest;
    }, [args.serverId, id, imageUrl, itemType, serverId, size, sizeByType, useRemoteUrl, variant]);
};

export function getItemImageRequest(args: UseItemImageUrlProps) {
    const { id, imageUrl, itemType, size, type, useRemoteUrl } = args;
    const authStore = useAuthStore.getState();
    const currentServerId = authStore.currentServer?.id;
    const serverId = (args.serverId || currentServerId) as string;

    const imageRes = useSettingsStore.getState().general.imageRes;
    const sizeByType: number | undefined = type ? imageRes[type] : undefined;

    if (imageUrl) {
        return {
            cacheKey: imageUrl,
            url: imageUrl,
        } satisfies ImageRequest;
    }

    if (!id) {
        return undefined;
    }

    let baseUrl: string | undefined;

    if (useRemoteUrl) {
        const server = getServerById(serverId);
        baseUrl = server?.remoteUrl || server?.url;
    }

    return (
        api.controller.getImageRequest({
            apiClientProps: { serverId },
            baseUrl,
            query: { id, itemType, size: size ?? sizeByType },
        }) || undefined
    );
}

export function getItemImageUrl(args: UseItemImageUrlProps) {
    const { id, imageUrl, itemType, size, type, useRemoteUrl } = args;
    const authStore = useAuthStore.getState();
    const currentServerId = authStore.currentServer?.id;
    const serverId = (args.serverId || currentServerId) as string;

    const imageRes = useSettingsStore.getState().general.imageRes;
    const sizeByType: number | undefined = type ? imageRes[type] : undefined;

    if (imageUrl) {
        return imageUrl;
    }

    if (!id) {
        return undefined;
    }

    let baseUrl: string | undefined;

    if (useRemoteUrl) {
        const server = getServerById(serverId);
        baseUrl = server?.remoteUrl || server?.url;
    }

    return (
        api.controller.getImageUrl({
            apiClientProps: { serverId },
            baseUrl,
            query: { id, itemType, size: size ?? sizeByType },
        }) || undefined
    );
}
