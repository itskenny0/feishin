import clsx from 'clsx';
import {
    ForwardedRef,
    forwardRef,
    HTMLAttributes,
    type ImgHTMLAttributes,
    memo,
    ReactNode,
    useEffect,
    useMemo,
    useState,
} from 'react';

import styles from './image.module.css';
import { useNativeImage } from './use-native-image';

import { AppIcon, Icon } from '/@/shared/components/icon/icon';
import { Skeleton } from '/@/shared/components/skeleton/skeleton';
import { useDebouncedValue } from '/@/shared/hooks/use-debounced-value';
import { useInViewport } from '/@/shared/hooks/use-in-viewport';
import { ImageRequest } from '/@/shared/types/domain-types';

// Bounded, insertion-order LRU of cacheKeys we've already loaded this
// session. Used only to suppress the load animation for already-seen
// images, so eviction is harmless (a stale cover merely re-animates
// once). Capped so a long session over a large library doesn't let the
// set grow without bound for the life of the renderer.
const MAX_LOADED_IMAGE_CACHE_KEYS = 2000;
const loadedImageCacheKeysMap = new Map<string, true>();

const loadedImageCacheKeys = {
    add(key: string): void {
        // Refresh recency on a repeat hit so frequently-seen covers
        // aren't evicted ahead of one-off ones.
        if (loadedImageCacheKeysMap.has(key)) {
            loadedImageCacheKeysMap.delete(key);
        } else if (loadedImageCacheKeysMap.size >= MAX_LOADED_IMAGE_CACHE_KEYS) {
            const oldest = loadedImageCacheKeysMap.keys().next().value;
            if (oldest !== undefined) loadedImageCacheKeysMap.delete(oldest);
        }
        loadedImageCacheKeysMap.set(key, true);
    },
    has(key: string): boolean {
        return loadedImageCacheKeysMap.has(key);
    },
};

export interface ImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> {
    containerClassName?: string;
    enableAnimation?: boolean;
    enableDebounce?: boolean;
    enableViewport?: boolean;
    fetchPriority?: 'auto' | 'high' | 'low';
    imageContainerProps?: Omit<ImageContainerProps, 'children'>;
    imageRequest?: ImageRequest;
    includeLoader?: boolean;
    includeUnloader?: boolean;
    isExplicit?: boolean;
    src: string | undefined;
    unloaderIcon?: keyof typeof AppIcon;
}

interface ImageContainerProps extends HTMLAttributes<HTMLDivElement> {
    children: ReactNode;
    isExplicit?: boolean;
}

interface ImageLoaderProps {
    className?: string;
}

interface ImageUnloaderProps {
    className?: string;
    icon?: keyof typeof AppIcon;
}

export const FALLBACK_SVG =
    'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMDAiIGhlaWdodD0iMzAwIj48ZmlsdGVyIGlkPSJhIiB4PSIwIiB5PSIwIj48ZmVUdXJidWxlbmNlIHR5cGU9ImZyYWN0YWxOb2lzZSIgYmFzZUZyZXF1ZW5jeT0iLjc1IiBzdGl0Y2hUaWxlcz0ic3RpdGNoIi8+PGZlQ29sb3JNYXRyaXggdHlwZT0ic2F0dXJhdGUiIHZhbHVlcz0iMCIvPjwvZmlsdGVyPjxwYXRoIGZpbHRlcj0idXJsKCNhKSIgb3BhY2l0eT0iLjA1IiBkPSJNMCAwaDMwMHYzMDBIMHoiLz48L3N2Zz4=';

export function BaseImage({
    className,
    containerClassName,
    enableAnimation = true,
    enableDebounce = false,
    enableViewport = true,
    fetchPriority = 'low',
    imageContainerProps,
    imageRequest,
    includeLoader = true,
    includeUnloader = true,
    isExplicit = false,
    onError,
    onLoad,
    src,
    unloaderIcon = 'emptyImage',
    ...props
}: ImageProps) {
    const viewport = useInViewport();
    const { inViewport, ref } = enableViewport ? viewport : { inViewport: true, ref: undefined };
    const { className: containerPropsClassName, ...restContainerProps } = imageContainerProps || {};

    const rawImageRequest = useMemo(
        () => imageRequest ?? (src ? { cacheKey: src, url: src } : undefined),
        [imageRequest, src],
    );
    const isInSessionCache = Boolean(
        rawImageRequest?.cacheKey && loadedImageCacheKeys.has(rawImageRequest.cacheKey),
    );
    const [debouncedImageRequest] = useDebouncedValue(rawImageRequest, 100, {
        waitForInitial: true,
    });
    const effectiveImageRequest =
        isInSessionCache || !enableDebounce ? rawImageRequest : debouncedImageRequest;

    const [hasLoadedInInstance, setHasLoadedInInstance] = useState(false);
    // Local error fallback. Distinct from `nativeImage.isError`, which is
    // tracked inside useNativeImage's fetch path. This catches the rarer
    // case where useNativeImage hands us a `displaySrc` (blob or remote
    // URL) that the browser then fails to decode/load — without this,
    // such items would render the browser's default broken-image icon
    // instead of our themed `<ImageUnloader>`.
    const [hasImgError, setHasImgError] = useState(false);

    useEffect(() => {
        setHasLoadedInInstance(false);
        setHasImgError(false);
    }, [effectiveImageRequest?.cacheKey]);

    const shouldLoadImage = Boolean(
        effectiveImageRequest &&
        (!enableViewport || isInSessionCache || inViewport || hasLoadedInInstance),
    );

    const nativeImage = useNativeImage({
        enabled: shouldLoadImage,
        fetchPriority,
        onFetchError: src
            ? () => {
                  (onError as ((event: undefined) => void) | undefined)?.(undefined);
              }
            : undefined,
        request: effectiveImageRequest,
    });

    useEffect(() => {
        if (!nativeImage.isLoaded || !effectiveImageRequest?.cacheKey) {
            return;
        }

        loadedImageCacheKeys.add(effectiveImageRequest.cacheKey);
        setHasLoadedInInstance(true);
    }, [effectiveImageRequest?.cacheKey, nativeImage.isLoaded]);

    return (
        <ImageContainer
            className={clsx(containerClassName, containerPropsClassName)}
            isExplicit={isExplicit}
            ref={ref}
            {...restContainerProps}
        >
            {nativeImage.displaySrc && !hasImgError ? (
                <img
                    className={clsx(styles.image, className, {
                        [styles.animated]: enableAnimation,
                    })}
                    decoding="async"
                    fetchPriority={fetchPriority}
                    onError={(e) => {
                        setHasImgError(true);
                        onError?.(e);
                    }}
                    onLoad={onLoad}
                    src={nativeImage.displaySrc}
                    {...props}
                />
            ) : !src ? (
                <ImageUnloader className={className} icon={unloaderIcon} />
            ) : nativeImage.isError || hasImgError ? (
                includeUnloader ? (
                    <ImageUnloader className={className} icon={unloaderIcon} />
                ) : null
            ) : includeLoader ? (
                <ImageLoader className={className} />
            ) : null}
        </ImageContainer>
    );
}

export const Image = memo(BaseImage);

const ImageContainer = forwardRef(
    (
        { children, className, isExplicit, ...props }: ImageContainerProps,
        ref: ForwardedRef<HTMLDivElement>,
    ) => {
        return (
            <div
                className={clsx(styles.imageContainer, className, {
                    [styles.censored]: isExplicit,
                })}
                ref={ref}
                {...props}
            >
                {children}
            </div>
        );
    },
);

export function ImageLoader({ className }: ImageLoaderProps) {
    return (
        <Skeleton
            className={clsx(styles.skeleton, styles.loader, className)}
            containerClassName={styles.skeletonContainer}
        />
    );
}

export function ImageUnloader({ className, icon = 'emptyImage' }: ImageUnloaderProps) {
    return (
        <div className={clsx(styles.unloader, className)}>
            <Icon color="default" icon={icon} size="25%" />
        </div>
    );
}
