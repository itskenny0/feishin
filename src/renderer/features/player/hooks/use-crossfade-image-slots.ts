import { useEffect, useRef } from 'react';

import { useSetState } from '/@/shared/hooks/use-set-state';

export interface CrossfadeImageInputs {
    currentExplicit?: boolean;
    /** Resolved display URL for the current song — undefined while the async resolver runs. */
    currentImageUrl: string | undefined;
    nextExplicit?: boolean;
    nextImageUrl: string | undefined;
    /** Suspend all slot updates (radio playback renders its own art). */
    paused?: boolean;
    songKey: string | undefined;
}

export interface CrossfadeImageSlots {
    bottomExplicit: boolean;
    bottomImage: string | undefined;
    current: 0 | 1;
    topExplicit: boolean;
    topImage: string | undefined;
}

/**
 * Two-slot crossfade state for the fullscreen players' album art.
 *
 * The slots deliberately do NOT track the live image URLs — a song change
 * flips which slot is active so the outgoing cover can fade while the new
 * one fades in. The catch (device bug, 2026-06-10): `useCachedItemImageUrl`
 * resolves asynchronously (Dexie lookup, degraded fallback, network fetch),
 * so the URL captured at flip/mount time is usually `undefined` and the real
 * one lands a moment later WITHOUT a song change. The previous inline
 * implementations only wrote slots on song change, leaving the fullscreen
 * cover a placeholder forever while the mini-player (which renders the live
 * URL directly) showed it fine. This hook additionally adopts same-song URL
 * changes — late resolution and degraded→upgraded swaps — into the active
 * slot, and ignores truthy→undefined transitions so an in-flight re-resolve
 * never blanks a painted cover.
 */
export const useCrossfadeImageSlots = ({
    currentExplicit = false,
    currentImageUrl,
    nextExplicit = false,
    nextImageUrl,
    paused = false,
    songKey,
}: CrossfadeImageInputs): CrossfadeImageSlots => {
    const [imageState, setImageState] = useSetState<CrossfadeImageSlots>({
        bottomExplicit: nextExplicit,
        bottomImage: nextImageUrl,
        current: 0,
        topExplicit: currentExplicit,
        topImage: currentImageUrl,
    });

    const previousSongRef = useRef<string | undefined>(songKey);
    const imageStateRef = useRef(imageState);

    useEffect(() => {
        imageStateRef.current = imageState;
    }, [imageState]);

    useEffect(() => {
        if (paused) {
            return;
        }

        if (songKey !== previousSongRef.current) {
            const isTop = imageStateRef.current.current === 0;

            setImageState({
                bottomExplicit: isTop ? currentExplicit : nextExplicit,
                bottomImage: isTop ? currentImageUrl : nextImageUrl,
                current: isTop ? 1 : 0,
                topExplicit: isTop ? nextExplicit : currentExplicit,
                topImage: isTop ? nextImageUrl : currentImageUrl,
            });

            previousSongRef.current = songKey;
            return;
        }

        // Same song: adopt a late-resolving or upgraded URL into the active
        // slot. Skip undefined — a transient re-resolve must not blank a
        // cover that already painted.
        if (!currentImageUrl) {
            return;
        }
        const state = imageStateRef.current;
        const isTop = state.current === 0;
        const activeImage = isTop ? state.topImage : state.bottomImage;
        if (activeImage === currentImageUrl) {
            return;
        }
        setImageState(isTop ? { topImage: currentImageUrl } : { bottomImage: currentImageUrl });
    }, [
        paused,
        songKey,
        currentExplicit,
        currentImageUrl,
        nextExplicit,
        nextImageUrl,
        setImageState,
    ]);

    return imageState;
};
