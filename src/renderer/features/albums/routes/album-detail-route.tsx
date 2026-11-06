import { useRef } from 'react';
import { useParams } from 'react-router';

import { queryKeys } from '/@/renderer/api/query-keys';
import { useCachedItemImageUrl } from '/@/renderer/components/item-image/item-image';
import { NativeScrollArea } from '/@/renderer/components/native-scroll-area/native-scroll-area';
import { useNativeScrollPersist } from '/@/renderer/components/native-scroll-area/use-native-scroll-persist';
import { AlbumDetailContent } from '/@/renderer/features/albums/components/album-detail-content';
import { AlbumDetailHeader } from '/@/renderer/features/albums/components/album-detail-header';
import { DetailLoadFallback } from '/@/renderer/features/albums/components/detail-load-fallback';
import { useAlbumDetailSuspenseQuery } from '/@/renderer/features/albums/queries/albums-queries';
import { AnimatedPage } from '/@/renderer/features/shared/components/animated-page';
import {
    LibraryBackgroundImage,
    LibraryBackgroundOverlay,
} from '/@/renderer/features/shared/components/library-background-overlay';
import { LibraryContainer } from '/@/renderer/features/shared/components/library-container';
import { LibraryHeaderBar } from '/@/renderer/features/shared/components/library-header-bar';
import { PageErrorBoundary } from '/@/renderer/features/shared/components/page-error-boundary';
import { useFastAverageColor } from '/@/renderer/hooks';
import { useAlbumBackground, useCurrentServerId } from '/@/renderer/store';
import { LibraryItem } from '/@/shared/types/domain-types';

const ALBUM_DETAIL_BG_FALLBACK = 'var(--theme-colors-foreground-muted)';

const AlbumDetailRoute = () => {
    const scrollAreaRef = useRef<HTMLDivElement>(null);
    const headerRef = useRef<HTMLDivElement>(null);
    const { albumBackground, albumBackgroundBlur } = useAlbumBackground();

    const { albumId } = useParams() as { albumId: string };
    const serverId = useCurrentServerId();

    const detailQuery = useAlbumDetailSuspenseQuery({
        query: { id: albumId },
        serverId,
    });

    // The scroll area only mounts once data exists, so re-arm then.
    useNativeScrollPersist({ enabled: !!detailQuery.data, scrollRef: scrollAreaRef });

    const imageUrl =
        useCachedItemImageUrl({
            id: detailQuery?.data?.imageId || undefined,
            itemType: LibraryItem.ALBUM,
            type: 'itemCard',
        }) || '';

    const { background: backgroundColor } = useFastAverageColor({
        id: albumId,
        src: imageUrl,
        srcLoaded: true,
    });

    const background = backgroundColor ?? ALBUM_DETAIL_BG_FALLBACK;

    const showBlurredImage = albumBackground;

    // The suspense query can legitimately resolve to `null` when the cold
    // network fetch fails or times out with nothing cached (see
    // `cachedSwr`'s fallback path) - common on flaky mobile connections and
    // on a server busy with a sync. Render the still-loading / retry fallback
    // instead of dereferencing null data. All hooks above run
    // unconditionally (they already null-guard their inputs) so this early
    // return doesn't violate the rules of hooks.
    if (!detailQuery.data) {
        return (
            <AnimatedPage key={`album-detail-${albumId}`}>
                <DetailLoadFallback
                    icon="itemAlbum"
                    isRetrying={detailQuery.isFetching}
                    onRetry={() => void detailQuery.refetch()}
                    queryKey={queryKeys.albums.detail(serverId ?? '', { id: albumId })}
                />
            </AnimatedPage>
        );
    }

    return (
        <AnimatedPage key={`album-detail-${albumId}`}>
            <NativeScrollArea
                pageHeaderProps={{
                    backgroundColor: backgroundColor ?? ALBUM_DETAIL_BG_FALLBACK,
                    children: (
                        <LibraryHeaderBar>
                            <LibraryHeaderBar.PlayButton
                                ids={[albumId]}
                                itemType={LibraryItem.ALBUM}
                                variant="default"
                            />
                            <LibraryHeaderBar.Title>{detailQuery.data.name}</LibraryHeaderBar.Title>
                        </LibraryHeaderBar>
                    ),
                    offset: 200,
                    target: headerRef,
                }}
                ref={scrollAreaRef}
            >
                {showBlurredImage ? (
                    <LibraryBackgroundImage
                        blur={albumBackgroundBlur}
                        headerRef={headerRef}
                        imageUrl={imageUrl}
                    />
                ) : (
                    <LibraryBackgroundOverlay backgroundColor={background} headerRef={headerRef} />
                )}
                <LibraryContainer>
                    <AlbumDetailHeader ref={headerRef as React.Ref<HTMLDivElement>} />
                    <AlbumDetailContent />
                </LibraryContainer>
            </NativeScrollArea>
        </AnimatedPage>
    );
};

const AlbumDetailRouteWithBoundary = () => {
    return (
        <PageErrorBoundary>
            <AlbumDetailRoute />
        </PageErrorBoundary>
    );
};

export default AlbumDetailRouteWithBoundary;
