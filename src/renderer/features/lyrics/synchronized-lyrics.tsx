import clsx from 'clsx';
import { t } from 'i18next';
import isElectron from 'is-electron';
import { useCallback, useEffect, useMemo, useRef } from 'react';

import styles from './synchronized-lyrics.module.css';

import { LyricLine } from '/@/renderer/features/lyrics/lyric-line';
import {
    useLyricsDisplaySettings,
    useLyricsSettings,
    usePlaybackType,
    usePlayerActions,
    usePlayerStatus,
} from '/@/renderer/store';
import { usePlayerTimestamp } from '/@/renderer/store/timestamp.store';
import { FullLyricsMetadata, SynchronizedLyricsArray } from '/@/shared/types/domain-types';
import { PlayerStatus, PlayerType } from '/@/shared/types/types';

const mpvPlayer = isElectron() ? window.api.mpvPlayer : null;
const utils = isElectron() ? window.api.utils : null;
const mpris = isElectron() && utils?.isLinux() ? window.api.mpris : null;

export interface SynchronizedLyricsProps extends Omit<FullLyricsMetadata, 'lyrics'> {
    lyrics: SynchronizedLyricsArray;
    offsetMs?: number;
    settingsKey?: string;
    style?: React.CSSProperties;
    translatedLyrics?: null | string;
}

const SCROLL_CONTAINER_ID = 'sychronized-lyrics-scroll-container';

// Maximum expected duration of a smooth scroll. We assume the programmatic
// scroll is over after this much time, even if no scrollend event is observed.
const PROGRAMMATIC_SCROLL_GUARD_MS = 1200;

// Auto-scroll is paused this long after a user scroll gesture.
const USER_SCROLL_COOLDOWN_MS = 3000;

// Index returned when no lyric line should be considered active (e.g. before
// the first line, or before any lyric data has been loaded).
const NO_ACTIVE_INDEX = -1;

// When a fresh player timestamp re-anchors the active line *backward* by this
// little (in lyric-ms), treat it as clock jitter rather than a seek. The
// advance timer moves the highlight forward exactly at a line boundary; the
// next player tick can report a time a few hundred ms behind that boundary
// (coarse progress granularity / report lag) and would otherwise snap the
// highlight back one line, making it flicker back and forth. A backward move
// larger than this is honored as a genuine seek.
const SEEK_BACK_TOLERANCE_MS = 1500;

export const SynchronizedLyrics = ({
    artist,
    lyrics,
    name,
    offsetMs,
    remote,
    settingsKey = 'default',
    source,
    style,
    translatedLyrics,
}: SynchronizedLyricsProps) => {
    const playbackType = usePlaybackType();
    const lyricsSettings = useLyricsSettings();
    const displaySettings = useLyricsDisplaySettings(settingsKey);
    const settings = {
        ...lyricsSettings,
        fontSize:
            displaySettings.fontSize && displaySettings.fontSize !== 0
                ? displaySettings.fontSize
                : 24,
        gap: displaySettings.gap && displaySettings.gap !== 0 ? displaySettings.gap : 24,
        opacityNonActive: displaySettings.opacityNonActive,
        scaleNonActive:
            displaySettings.scaleNonActive && displaySettings.scaleNonActive !== 0
                ? displaySettings.scaleNonActive
                : 0.95,
    };
    const { mediaSeekToTimestamp } = usePlayerActions();
    const status = usePlayerStatus();
    const timestamp = usePlayerTimestamp();

    // Defensively sort by ascending time. LRC files in the wild are often
    // out-of-order or contain duplicate timestamps; without sorting, the
    // engine's "find current line" logic produces wrong results and the
    // smooth-scroll target jumps backwards.
    const sortedLyrics = useMemo(() => {
        const arr = lyrics.slice();
        arr.sort((a, b) => a[0] - b[0]);
        return arr;
    }, [lyrics]);

    // Splitting `translatedLyrics` once per render meant every parent render
    // ran an O(N) split, and the per-line `translatedLyrics.split('\n')[idx]`
    // expression below made it O(N²) — a noticeable cost on long songs.
    // Cache the split so the render path is O(N) total.
    const translatedLines = useMemo(
        () => (translatedLyrics ? translatedLyrics.split('\n') : null),
        [translatedLyrics],
    );

    const handleSeek = useCallback(
        (time: number) => {
            if (playbackType === PlayerType.LOCAL && mpvPlayer) {
                mpvPlayer.seekTo(time);
            } else {
                mpris?.updateSeek(time);
                mediaSeekToTimestamp(time);
            }
        },
        [mediaSeekToTimestamp, playbackType],
    );

    const containerRef = useRef<HTMLDivElement | null>(null);

    // Index of the currently highlighted lyric. We track it in a ref instead of
    // re-querying the DOM so we can short-circuit when nothing changed.
    const activeIndexRef = useRef<number>(NO_ACTIVE_INDEX);
    // Direct reference to the active <div>, so we don't have to re-scan via
    // querySelectorAll on every advance.
    const activeElementRef = useRef<HTMLElement | null>(null);

    // Pending setTimeout that will advance to the next lyric.
    const advanceTimerRef = useRef<null | ReturnType<typeof setTimeout>>(null);
    // Epoch lets stale timers know they were superseded and should no-op.
    const epochRef = useRef(0);

    const followRef = useRef(settings.follow);
    useEffect(() => {
        followRef.current = settings.follow;
    }, [settings.follow]);

    const userScrollingRef = useRef(false);
    const userScrollTimeoutRef = useRef<null | ReturnType<typeof setTimeout>>(null);
    const programmaticScrollRef = useRef(false);
    const programmaticScrollTimeoutRef = useRef<null | ReturnType<typeof setTimeout>>(null);

    // The scroll container is stable across a song, but resolving it walks the
    // ancestor chain calling getComputedStyle (a forced style/layout flush).
    // Cache the resolved element so we pay that cost once, not on every tick.
    const scrollContainerRef = useRef<HTMLElement | null>(null);
    // Pending rAF handle for the geometry read + scroll, so we never compute
    // layout synchronously inside the advance timer callback.
    const scrollRafRef = useRef<null | number>(null);

    const resolveScrollContainer = useCallback((fromNode: HTMLElement): HTMLElement | null => {
        if (scrollContainerRef.current && scrollContainerRef.current.isConnected) {
            return scrollContainerRef.current;
        }

        /*
         * The synced lyrics render in two surfaces: the full lyrics tab
         * (overflowing the viewport via #sychronized-lyrics-scroll-container)
         * and the mobile fullscreen player's preview card
         * (max-height: 60vh overflow:auto, no id). Find the nearest
         * scrollable ancestor walking up from the active line — that
         * way the scroll-into-view works inside whichever container is
         * actually clipping the lyric list. Fall back to the named
         * container id for the desktop tab.
         */
        let container: HTMLElement | null = fromNode.parentElement;
        while (container) {
            const overflowY = window.getComputedStyle(container).overflowY;
            const canScroll =
                (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') &&
                container.scrollHeight > container.clientHeight;
            if (canScroll) break;
            container = container.parentElement;
        }
        if (!container) {
            container = document.getElementById(SCROLL_CONTAINER_ID);
        }
        scrollContainerRef.current = container;
        return container;
    }, []);

    const setActiveIndex = useCallback(
        (nextIndex: number) => {
            if (nextIndex === activeIndexRef.current) {
                return;
            }
            activeIndexRef.current = nextIndex;

            // Swap the active class on a single tracked element instead of
            // touching every active node in the document.
            if (activeElementRef.current) {
                activeElementRef.current.classList.remove('active');
                activeElementRef.current = null;
            }

            if (nextIndex < 0) {
                return;
            }

            // Scope the lookup to our container rather than a document-wide
            // getElementById, which collides with the mobile preview card that
            // mounts a second synced-lyrics list sharing the `lyric-N` ids.
            const root = containerRef.current ?? document;
            const nextActive = root.querySelector<HTMLElement>(`#lyric-${nextIndex}`);
            if (!nextActive) {
                return;
            }

            nextActive.classList.add('active');
            activeElementRef.current = nextActive;

            if (!followRef.current || userScrollingRef.current) {
                return;
            }

            // Defer the geometry read + scroll to the next frame so the advance
            // timer never triggers a synchronous layout. Coalesce rapid
            // advances (duplicate timecodes, seeks) into a single scroll.
            if (scrollRafRef.current != null) {
                cancelAnimationFrame(scrollRafRef.current);
            }
            scrollRafRef.current = requestAnimationFrame(() => {
                scrollRafRef.current = null;
                const target = activeElementRef.current;
                if (!target || !followRef.current || userScrollingRef.current) {
                    return;
                }
                const container = resolveScrollContainer(target);
                if (!container) {
                    return;
                }

                const targetTop =
                    target.offsetTop -
                    container.offsetTop -
                    container.clientHeight / 2 +
                    target.clientHeight / 2;

                // Mark the upcoming scroll event chain as programmatic so the
                // user scroll handler doesn't mistake them for human input.
                programmaticScrollRef.current = true;
                if (programmaticScrollTimeoutRef.current) {
                    clearTimeout(programmaticScrollTimeoutRef.current);
                }
                programmaticScrollTimeoutRef.current = setTimeout(() => {
                    programmaticScrollRef.current = false;
                    programmaticScrollTimeoutRef.current = null;
                }, PROGRAMMATIC_SCROLL_GUARD_MS);

                container.scroll({ behavior: 'smooth', top: targetTop });
            });
        },
        [resolveScrollContainer],
    );

    // Reset state when the lyric set changes so we don't carry an active index
    // that points into the old array. Crucially, scrub the .active class off
    // any node that still carries it - the <LyricLine> elements are keyed by
    // index, so React reuses the same DOM nodes for the new song and only
    // replaces text content. Without this, the previously-highlit line stays
    // highlit at its old index until the first timecode of the new song fires,
    // which the user notices as a random line glowing on every track change.
    useEffect(() => {
        activeIndexRef.current = NO_ACTIVE_INDEX;
        if (activeElementRef.current) {
            activeElementRef.current.classList.remove('active');
            activeElementRef.current = null;
        }
        // Drop the cached scroll container; the list re-rendered and our cached
        // node may be detached (e.g. tab unmounted/remounted between songs).
        scrollContainerRef.current = null;
        // Belt-and-suspenders: clear any stray .active inside the container in
        // case the tracked ref got out of sync (e.g. the lyrics view unmounted
        // and remounted while the ref was still pointing at a detached node).
        const container = containerRef.current;
        if (container) {
            container.querySelectorAll('.active').forEach((el) => el.classList.remove('active'));
        }
    }, [sortedLyrics]);

    // Single source of truth for advancing through the lyric timeline. Re-runs
    // when the source data, playback status, timestamp from the player, or the
    // user-configured offset changes. The previous implementation split these
    // into three competing effects which would race each other and double-fire.
    useEffect(() => {
        if (status !== PlayerStatus.PLAYING || sortedLyrics.length === 0) {
            if (advanceTimerRef.current) {
                clearTimeout(advanceTimerRef.current);
                advanceTimerRef.current = null;
            }
            return;
        }

        const offset = offsetMs ?? 0;
        const myEpoch = ++epochRef.current;

        // Binary search: rightmost lyric whose timestamp is <= timeInMs.
        const findIndexAt = (timeInMs: number) => {
            let lo = 0;
            let hi = sortedLyrics.length;
            while (lo < hi) {
                const mid = (lo + hi) >>> 1;
                if (sortedLyrics[mid][0] <= timeInMs) {
                    lo = mid + 1;
                } else {
                    hi = mid;
                }
            }
            return lo - 1;
        };

        // Schedule advancement using performance.now() as the wall clock so
        // that drift accumulated during a long pause/seek doesn't compound.
        const wallStart = performance.now();
        const lyricStart = timestamp * 1000 + offset;

        const armNext = (currentIndex: number) => {
            // No next lyric, or sentinel: stay put.
            if (currentIndex >= sortedLyrics.length - 1) {
                advanceTimerRef.current = null;
                return;
            }

            const targetIndex = currentIndex + 1;
            const targetLyricTime = sortedLyrics[targetIndex][0];
            const wallElapsed = performance.now() - wallStart;
            const lyricNow = lyricStart + wallElapsed;
            // Coalesce duplicate / extremely-close timestamps so we don't burn
            // CPU on a flurry of synchronous setTimeout(0) recursions.
            const delay = Math.max(16, targetLyricTime - lyricNow);

            advanceTimerRef.current = setTimeout(() => {
                if (epochRef.current !== myEpoch) {
                    return;
                }
                setActiveIndex(targetIndex);
                armNext(targetIndex);
            }, delay);
        };

        // Compute and apply the active line for the current player time.
        const initialIndex = findIndexAt(lyricStart);

        if (initialIndex === NO_ACTIVE_INDEX) {
            // We're sitting before the first lyric. Don't highlight anything,
            // but schedule the first line.
            setActiveIndex(NO_ACTIVE_INDEX);
            const firstLyricTime = sortedLyrics[0][0];
            if (firstLyricTime > lyricStart) {
                advanceTimerRef.current = setTimeout(() => {
                    if (epochRef.current !== myEpoch) {
                        return;
                    }
                    setActiveIndex(0);
                    armNext(0);
                }, firstLyricTime - lyricStart);
            } else {
                // Edge case: every lyric is at time 0, just highlight the first.
                setActiveIndex(0);
                armNext(0);
            }
        } else {
            // Guard against timestamp jitter snapping the highlight backward by
            // a line right after the advance timer moved it forward. Only honor
            // a backward re-anchor when it's far enough behind to be a real
            // seek; otherwise keep the forward position and re-arm from there.
            const current = activeIndexRef.current;
            let effectiveIndex = initialIndex;
            if (current !== NO_ACTIVE_INDEX && initialIndex < current) {
                const currentLineStart = sortedLyrics[current]?.[0] ?? 0;
                if (currentLineStart - lyricStart <= SEEK_BACK_TOLERANCE_MS) {
                    effectiveIndex = current;
                }
            }
            setActiveIndex(effectiveIndex);
            armNext(effectiveIndex);
        }

        return () => {
            if (advanceTimerRef.current) {
                clearTimeout(advanceTimerRef.current);
                advanceTimerRef.current = null;
            }
        };
    }, [offsetMs, setActiveIndex, sortedLyrics, status, timestamp]);

    // Cleanup on unmount: cancel any pending work.
    useEffect(() => {
        return () => {
            epochRef.current += 1;
            if (advanceTimerRef.current) {
                clearTimeout(advanceTimerRef.current);
            }
            if (userScrollTimeoutRef.current) {
                clearTimeout(userScrollTimeoutRef.current);
            }
            if (programmaticScrollTimeoutRef.current) {
                clearTimeout(programmaticScrollTimeoutRef.current);
            }
            if (scrollRafRef.current != null) {
                cancelAnimationFrame(scrollRafRef.current);
            }
        };
    }, []);

    // Pause auto-scroll while the user is interacting with the scroll
    // container. Programmatic scrolls also fire scroll events; ignore those.
    useEffect(() => {
        const container =
            containerRef.current ||
            (document.getElementById(SCROLL_CONTAINER_ID) as HTMLElement | null);
        if (!container) return;

        const handleScroll = () => {
            if (programmaticScrollRef.current) {
                return;
            }

            userScrollingRef.current = true;

            if (userScrollTimeoutRef.current) {
                clearTimeout(userScrollTimeoutRef.current);
            }
            userScrollTimeoutRef.current = setTimeout(() => {
                userScrollingRef.current = false;
                userScrollTimeoutRef.current = null;
            }, USER_SCROLL_COOLDOWN_MS);
        };

        container.addEventListener('scroll', handleScroll, { passive: true });

        return () => {
            container.removeEventListener('scroll', handleScroll);
        };
    }, []);

    const hideScrollbar = () => {
        const doc = document.getElementById(SCROLL_CONTAINER_ID);
        doc?.classList.add('hide-scrollbar');
    };

    const showScrollbar = () => {
        const doc = document.getElementById(SCROLL_CONTAINER_ID);
        doc?.classList.remove('hide-scrollbar');
    };

    // Event delegation: one click handler on the container reads the time
    // from the nearest [data-lyric-time] element. Passing per-line inline
    // onClick (the previous shape) created a fresh function per render, which
    // defeated LyricLine's React.memo and re-rendered all N lines on every
    // active-line advance — a real cost for long songs.
    const onContainerClick = useCallback(
        (e: React.MouseEvent<HTMLDivElement>) => {
            const target = e.target as HTMLElement;
            const line = target.closest('[data-lyric-time]') as HTMLElement | null;
            if (!line) return;
            const time = Number(line.dataset.lyricTime);
            if (time > 0 && Number.isFinite(time)) {
                handleSeek(time / 1000);
            }
        },
        [handleSeek],
    );

    return (
        <div
            className={clsx(styles.container, 'synchronized-lyrics overlay-scrollbar')}
            id={SCROLL_CONTAINER_ID}
            onClick={onContainerClick}
            onMouseEnter={showScrollbar}
            onMouseLeave={hideScrollbar}
            ref={containerRef}
            style={
                {
                    // opacity/scale is set here for every lyric,
                    // and then overwritten by CSS for active lyrics
                    // to prevent expensive rerenders each lyric
                    '--lyric-opacity': settings.opacityNonActive,
                    '--lyric-scale': settings.scaleNonActive,
                    '--lyric-scale-origin': settings.alignment,
                    gap: `${settings.gap}px`,
                    ...style,
                } as React.CSSProperties
            }
        >
            {settings.showProvider && source && (
                <LyricLine
                    alignment={settings.alignment}
                    className="lyric-credit"
                    fontSize={settings.fontSize}
                    text={t('lyrics.providedBy', {
                        defaultValue: 'Provided by {{source}}',
                        source,
                    })}
                />
            )}
            {settings.showMatch && remote && (
                <LyricLine
                    alignment={settings.alignment}
                    className="lyric-credit"
                    fontSize={settings.fontSize}
                    text={t('lyrics.match', {
                        artist,
                        defaultValue: '"{{name}} by {{artist}}"',
                        name,
                    })}
                />
            )}
            {sortedLyrics.map(([time, text], idx) => (
                <LyricLine
                    alignment={settings.alignment}
                    className="lyric-line synchronized"
                    data-lyric-time={time}
                    fontSize={settings.fontSize}
                    id={`lyric-${idx}`}
                    key={idx}
                    text={
                        text +
                        (translatedLines && translatedLines[idx] !== undefined
                            ? `_BREAK_${translatedLines[idx]}`
                            : '')
                    }
                />
            ))}
        </div>
    );
};
