import merge from 'lodash/merge';
import omit from 'lodash/omit';
import { devtools, persist } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import { shallow } from 'zustand/shallow';
import { createWithEqualityFn } from 'zustand/traditional';

export type FullScreenPlayerItemAlignment = 'center' | 'left' | 'right';

export interface FullScreenPlayerSlice extends FullScreenPlayerState {
    actions: {
        setStore: (data: Partial<FullScreenPlayerSlice>) => void;
    };
}

export type FullScreenPlayerTitleDisplayType = 'multiLine' | 'scroll';

interface FullScreenPlayerState {
    activeTab: 'lyrics' | 'queue' | 'related' | string;
    coverArtSize: number;
    dynamicBackground?: boolean;
    dynamicImageBlur: number;
    dynamicIsImage?: boolean;
    expanded: boolean;
    opacity: number;
    playerItemAlignment: FullScreenPlayerItemAlignment;
    titleDisplayType: FullScreenPlayerTitleDisplayType;
    titleLineCount: number;
    useImageAspectRatio: boolean;
    visualizerAsBackground?: boolean;
    visualizerExpanded: boolean;
    visualizerLyricsOverlay?: boolean;
    visualizerReturnToPlayer: boolean;
}

export const useFullScreenPlayerStore = createWithEqualityFn<FullScreenPlayerSlice>()(
    persist(
        devtools(
            immer((set, get) => ({
                actions: {
                    setStore: (data) => {
                        set({ ...get(), ...data });
                    },
                },
                activeTab: '',
                coverArtSize: 75,
                dynamicBackground: true,
                dynamicImageBlur: 6,
                dynamicIsImage: false,
                expanded: false,
                opacity: 25,
                playerItemAlignment: 'center',
                titleDisplayType: 'scroll',
                titleLineCount: 1,
                useImageAspectRatio: false,
                visualizerAsBackground: false,
                visualizerExpanded: false,
                visualizerLyricsOverlay: true,
                visualizerReturnToPlayer: false,
            })),
            { name: 'store_full_screen_player' },
        ),
        {
            merge: (persistedState, currentState) => {
                const merged = merge(currentState, persistedState);
                // Overlay view-state must NEVER be restored on launch. The
                // fullscreen player (and visualizer) are transient overlays on
                // top of the underlying route; persisting `expanded:true` made
                // the app boot straight into the fullscreen player instead of
                // the route beneath it (home on mobile). Always start collapsed.
                merged.expanded = false;
                merged.visualizerExpanded = false;
                return merged;
            },
            migrate: (persistedState, version) => {
                if (version <= 2) {
                    return {} as FullScreenPlayerState;
                }

                if (version <= 4) {
                    const state = persistedState as { coverArtSize?: number | string };
                    const legacyCoverArtSizeMap: Record<string, number> = {
                        large: 100,
                        medium: 75,
                        small: 50,
                    };

                    if (typeof state.coverArtSize === 'string') {
                        state.coverArtSize = legacyCoverArtSizeMap[state.coverArtSize] ?? 75;
                    }
                }

                return persistedState;
            },
            name: 'store_full_screen_player',
            // Don't persist the transient overlay flags at all — they're
            // forced false on load anyway, and keeping them out of storage
            // avoids a stale `expanded:true` lingering in localStorage.
            // `visualizerReturnToPlayer` is transient navigation intent used only to route
            // the "shrink visualizer" action back to the full-screen player; it isn't
            // meaningful across app restarts either.
            partialize: (state) =>
                omit(state, ['expanded', 'visualizerExpanded', 'visualizerReturnToPlayer']),
            version: 5,
        },
    ),
);

export const useFullScreenPlayerStoreActions = () =>
    useFullScreenPlayerStore((state) => state.actions);

export const useSetFullScreenPlayerStore = () =>
    useFullScreenPlayerStore((state) => state.actions.setStore);

export const useFullScreenPlayerOverlayState = () =>
    useFullScreenPlayerStore(
        (state) => ({
            expanded: state.expanded,
            visualizerExpanded: state.visualizerExpanded,
        }),
        shallow,
    );

export const useFullScreenPlayerExpanded = () =>
    useFullScreenPlayerStore((state) => state.expanded);

export const useFullScreenPlayerVisualizerExpanded = () =>
    useFullScreenPlayerStore((state) => state.visualizerExpanded);

export const useFullScreenPlayerActiveTab = () =>
    useFullScreenPlayerStore((state) => state.activeTab);

export const useFullScreenPlayerUseImageAspectRatio = () =>
    useFullScreenPlayerStore((state) => state.useImageAspectRatio);

export const useFullScreenPlayerOpacity = () => useFullScreenPlayerStore((state) => state.opacity);

export const useFullScreenPlayerDynamicBackground = () =>
    useFullScreenPlayerStore((state) => state.dynamicBackground);

export const useFullScreenPlayerDynamicImageBlur = () =>
    useFullScreenPlayerStore((state) => state.dynamicImageBlur);

export const useFullScreenPlayerDynamicIsImage = () =>
    useFullScreenPlayerStore((state) => state.dynamicIsImage);

export const useFullScreenPlayerVisualizerAsBackground = () =>
    useFullScreenPlayerStore((state) => state.visualizerAsBackground);

export const useFullScreenPlayerVisualizerLyricsOverlay = () =>
    useFullScreenPlayerStore((state) => state.visualizerLyricsOverlay);
