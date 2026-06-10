import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';

import { useCachedItemImageUrl } from '/@/renderer/components/item-image/item-image';
import { NativeScrollArea } from '/@/renderer/components/native-scroll-area/native-scroll-area';
import { AlbumDetailContent } from '/@/renderer/features/albums/components/album-detail-content';
import { AlbumDetailHeader } from '/@/renderer/features/albums/components/album-detail-header';
import { useAlbumDetailSuspenseQuery } from '/@/renderer/features/albums/queries/albums-queries';
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
import { useAlbumBackground, useCurrentServerId } from '/@/renderer/store';
import { LibraryItem } from '/@/shared/types/domain-types';

const ALBUM_DETAIL_BG_FALLBACK = 'var(--theme-colors-foreground-muted)';

const AlbumDetailRoute = () => {
    const { t } = useTranslation();
    const scrollAreaRef = useRef<HTMLDivElement>(null);
    const headerRef = useRef<HTMLDivElement>(null);
    const { albumBackground, albumBackgroundBlur } = useAlbumBackground();

    const { albumId } = useParams() as { albumId: string };
    const serverId = useCurrentServerId();

    const detailQuery = useAlbumDetailSuspenseQuery({
        query: { id: albumId },
        serverId,
    });

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
    // `cachedSwr`'s fallback path) — common on flaky mobile connections.
    // Render a graceful empty state instead of dereferencing null data,
    // which previously threw "Cannot read properties of null (reading
    // 'name')" and tripped the page error boundary. All hooks above run
    // unconditionally (they already null-guard their inputs) so this early
    // return doesn't violate the rules of hooks.
    if (!detailQuery.data) {
        return (
            <AnimatedPage key={`album-detail-${albumId}`}>
                <EmptyState
                    description={t('error.networkError', {
                        defaultValue: 'Could not load this album. Check your connection and retry.',
                    })}
                    icon="itemAlbum"
                    title={t('error.genericError', { defaultValue: 'Something went wrong' })}
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
                scrollKey={`album-detail-${albumId}`}
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
