import clsx from 'clsx';
import { CSSProperties, lazy, MouseEvent, Suspense, useMemo } from 'react';

import styles from './playerbar.module.css';

import { CenterControls } from '/@/renderer/features/player/components/center-controls';
import { LeftControls } from '/@/renderer/features/player/components/left-controls';
import { RightControls } from '/@/renderer/features/player/components/right-controls';
import { useDominantColor } from '/@/renderer/features/player/hooks/use-dominant-color';
import { useIsMobile } from '/@/renderer/hooks/use-is-mobile';
import { Spinner } from '/@/shared/components/spinner/spinner';

const MobilePlayerbar = lazy(() =>
    import('./mobile-playerbar').then((module) => ({
        default: module.MobilePlayerbar,
    })),
);
import {
    useFullScreenPlayerStore,
    usePlayerSong,
    useSetFullScreenPlayerStore,
} from '/@/renderer/store';
import { usePlayerbarOpenDrawer } from '/@/renderer/store';
import { PlaybackSelectors } from '/@/shared/constants/playback-selectors';

export const Playerbar = () => {
    const playerbarOpenDrawer = usePlayerbarOpenDrawer();
    const { expanded: isFullScreenPlayerExpanded } = useFullScreenPlayerStore();
    const setFullScreenPlayerStore = useSetFullScreenPlayerStore();
    const isMobile = useIsMobile();
    const currentSong = usePlayerSong();
    const { color } = useDominantColor(currentSong?.imageUrl);

    // Two related CSS variables for descendants. `--playerbar-art-tint` is
    // used by the background gradient and stays `transparent` when there's
    // no art / CORS blocked the read. `--playerbar-art-accent` is the same
    // colour OR the theme primary when there's no tint, so descendants that
    // need a *visible* accent (the EQ pulse bars) can read it
    // unconditionally and still get a sensible colour in the fallback case.
    const tintStyle = useMemo<CSSProperties>(() => {
        const accent = color ?? 'var(--theme-colors-primary-filled)';
        return {
            ['--playerbar-art-accent' as string]: accent,
            ['--playerbar-art-tint' as string]: color ?? 'transparent',
        };
    }, [color]);

    const handleToggleFullScreenPlayer = (e?: KeyboardEvent | MouseEvent<HTMLDivElement>) => {
        e?.stopPropagation();
        setFullScreenPlayerStore({ expanded: !isFullScreenPlayerExpanded });
    };

    if (isMobile) {
        /*
         * Spotify-style empty state: hide the mini-player entirely when
         * there's no song queued. Previously the bar still rendered with
         * '—' placeholder lines for title/artist/album and a floating
         * play button — looked broken on the action-required / empty
         * library screens. The bottom-tab-bar fills in nicely without
         * the gap above.
         */
        if (!currentSong?.id) {
            return null;
        }
        return (
            <Suspense fallback={<Spinner />}>
                {/*
                 * Push the album-art dominant colour into the mobile
                 * mini-player too. Spotify tints its mini-player heavily
                 * with the current track's dominant colour, and the
                 * MobilePlayerbar CSS reads `--playerbar-art-tint` for a
                 * soft horizontal gradient. Apply the same tintStyle the
                 * desktop branch uses so descendants see a real colour
                 * instead of falling back to `transparent` (the default
                 * when nobody wires the vars up).
                 */}
                <div style={tintStyle}>
                    <MobilePlayerbar />
                </div>
            </Suspense>
        );
    }

    return (
        <div
            className={clsx(styles.container, PlaybackSelectors.mediaPlayer)}
            onClick={playerbarOpenDrawer ? handleToggleFullScreenPlayer : undefined}
            style={tintStyle}
        >
            <div className={styles.controlsGrid}>
                <div className={styles.leftGridItem}>
                    <LeftControls />
                </div>
                <div className={styles.centerGridItem}>
                    <CenterControls />
                </div>
                <div className={styles.rightGridItem}>
                    <RightControls />
                </div>
            </div>
        </div>
    );
};
