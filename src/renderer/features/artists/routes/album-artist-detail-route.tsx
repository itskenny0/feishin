import { useSuspenseQueries } from '@tanstack/react-query';
import { Suspense, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';

import { useCachedItemImageUrl } from '/@/renderer/components/item-image/item-image';
import { NativeScrollArea } from '/@/renderer/components/native-scroll-area/native-scroll-area';
import { albumQueries } from '/@/renderer/features/albums/api/album-api';
import { artistsQueries } from '/@/renderer/features/artists/api/artists-api';
import { AlbumArtistDetailContent } from '/@/renderer/features/artists/components/album-artist-detail-content';
import { AlbumArtistDetailHeader } from '/@/renderer/features/artists/components/album-artist-detail-header';
import { useAlbumArtistInfoQuery } from '/@/renderer/features/artists/queries/artists-queries';
import { AnimatedPage } from '/@/renderer/features/shared/components/animated-page';
import { EmptyState } from '/@/renderer/features/shared/components/empty-state';
import {
    LibraryBackgroundImage,
    LibraryBackgroundOverlay,
} from '/@/renderer/features/shared/components/library-background-overlay';
import { LibraryContainer } from '/@/renderer/features/shared/components/library-container';
import { LibraryHeaderBar } from '/@/renderer/features/shared/components/library-header-bar';
import { PageErrorBoundary } from '/@/renderer/features/shared/components/page-error-boundary';
import { useFastAverageColor } from '/@/renderer/hooks';
import { useArtistBackground, useCurrentServerId } from '/@/renderer/store';
import { useArtistItems } from '/@/renderer/store/settings.store';
import { Spinner } from '/@/shared/components/spinner/spinner';
import { AlbumListSort, LibraryItem, SortOrder } from '/@/shared/types/domain-types';

const AlbumArtistDetailRouteContent = () => {
    const { t } = useTranslation();
    const scrollAreaRef = useRef<HTMLDivElement>(null);
    const headerRef = useRef<HTMLDivElement>(null);
    // Single serverId source across the route + header + content. Reading
    // it once and passing the detailQuery down keeps every subscriber on
    // one query key so React Query dedups to a single network call (the
    // header used to issue its own useSuspenseQuery keyed off
    // useCurrentServer()?.id, which diverged from this selector mid
    // server-switch and defeated dedup).
    const serverId = useCurrentServerId();
    const { artistBackground, artistBackgroundBlur } = useArtistBackground();
    const artistItems = useArtistItems();

    const { albumArtistId, artistId } = useParams() as {
        albumArtistId?: string;
        artistId?: string;
    };

    const routeId = (artistId || albumArtistId) as string;

    const [detailQuery, albumsQuery] = useSuspenseQueries({
        queries: [
            artistsQueries.albumArtistDetail({ query: { id: routeId }, serverId }),
            albumQueries.list({
                query: {
                    artistIds: [routeId],
                    limit: -1,
                    sortBy: AlbumListSort.RELEASE_DATE,
                    sortOrder: SortOrder.DESC,
                    startIndex: 0,
                },
                serverId,
            }),
        ],
    });

    // Warm the artist `info` (biography + similar artists) query in
    // parallel with the suspense queries above instead of waiting for the
    // content children to mount. Gated by the same settings flags the
    // content uses so disabled sections don't trigger a network call;
    // the children subscribe to the same key and dedup onto this fetch.
    const wantsArtistInfo =
        artistItems.some((item) => item.id === 'biography' && !item.disabled) ||
        artistItems.some((item) => item.id === 'similarArtists' && !item.disabled);

    useAlbumArtistInfoQuery({
        options: { enabled: Boolean(serverId && routeId && wantsArtistInfo) },
        query: { id: routeId, limit: 10 },
        serverId,
    });

    const imageUrl = useCachedItemImageUrl({
        id: detailQuery.data?.imageId || undefined,
        imageUrl: detailQuery.data?.imageUrl,
        itemType: LibraryItem.ALBUM_ARTIST,
        type: 'header',
    });

    const libraryBackgroundImageUrl = useCachedItemImageUrl({
        id: detailQuery.data?.imageId || undefined,
        imageUrl: detailQuery.data?.imageUrl,
        itemType: LibraryItem.ALBUM_ARTIST,
        type: 'itemCard',
    });

    const selectedImageUrl = imageUrl || detailQuery.data?.imageUrl;

    const { background: backgroundColor } = useFastAverageColor({
        id: artistId,
        src: selectedImageUrl,
        srcLoaded: true,
    });

    const background = backgroundColor;

    const showBlurredImage = artistBackground;

    // The suspense query can legitimately resolve to `null` on a cold
    // network failure with nothing cached (cachedSwr fallback). Mirror the
    // album-detail guard: render a graceful empty state instead of an
    // empty header + empty content tree. All hooks above run
    // unconditionally and null-guard their inputs, so this early return is
    // rules-of-hooks safe.
    if (!detailQuery.data) {
        return (
            <AnimatedPage key={`album-artist-detail-${routeId}`}>
                <EmptyState
                    description={t('error.networkError', {
                        defaultValue:
                            'Could not load this artist. Check your connection and retry.',
                    })}
                    icon="emptyArtistImage"
                    title={t('error.genericError', { defaultValue: 'Something went wrong' })}
                />
            </AnimatedPage>
        );
    }

    return (
        <AnimatedPage key={`album-artist-detail-${routeId}`}>
            <NativeScrollArea
                pageHeaderProps={{
                    backgroundColor: backgroundColor || undefined,
                    children: (
                        <LibraryHeaderBar>
                            <LibraryHeaderBar.PlayButton
                                ids={[routeId]}
                                itemType={LibraryItem.ALBUM_ARTIST}
                                variant="default"
                            />
                            <LibraryHeaderBar.Title>
                                {detailQuery.data?.name}
                            </LibraryHeaderBar.Title>
                        </LibraryHeaderBar>
                    ),
                    offset: 200,
                    target: headerRef,
                }}
                ref={scrollAreaRef}
                scrollKey={`album-artist-detail-${routeId}`}
            >
                {showBlurredImage ? (
                    <LibraryBackgroundImage
                        blur={artistBackgroundBlur}
                        headerRef={headerRef}
                        imageUrl={libraryBackgroundImageUrl || ''}
                    />
                ) : (
                    <LibraryBackgroundOverlay backgroundColor={background} headerRef={headerRef} />
                )}
                <LibraryContainer>
                    <AlbumArtistDetailHeader
                        albumsQuery={albumsQuery}
                        detailQuery={detailQuery}
                        ref={headerRef as React.Ref<HTMLDivElement>}
                    />
                    <AlbumArtistDetailContent albumsQuery={albumsQuery} detailQuery={detailQuery} />
                </LibraryContainer>
            </NativeScrollArea>
        </AnimatedPage>
    );
};

const AlbumArtistDetailRoute = () => {
    const { albumArtistId, artistId } = useParams() as {
        albumArtistId?: string;
        artistId?: string;
    };
    const routeId = (artistId || albumArtistId) as string;

    return (
        <Suspense fallback={<Spinner container />} key={`album-artist-detail-suspense-${routeId}`}>
            <AlbumArtistDetailRouteContent />
        </Suspense>
    );
};

const AlbumArtistDetailRouteWithBoundary = () => {
    return (
        <PageErrorBoundary>
            <AlbumArtistDetailRoute />
        </PageErrorBoundary>
    );
};

export default AlbumArtistDetailRouteWithBoundary;
