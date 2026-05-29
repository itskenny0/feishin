import merge from 'lodash/merge';
import { devtools, persist } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import { shallow } from 'zustand/shallow';
import { createWithEqualityFn } from 'zustand/traditional';

export interface FullScreenPlayerSlice extends FullScreenPlayerState {
    actions: {
        setStore: (data: Partial<FullScreenPlayerSlice>) => void;
    };
}

interface FullScreenPlayerState {
    activeTab: 'lyrics' | 'queue' | 'related' | string;
    dynamicBackground?: boolean;
    dynamicImageBlur: number;
    dynamicIsImage?: boolean;
    expanded: boolean;
    opacity: number;
    useImageAspectRatio: boolean;
    visualizerAsBackground?: boolean;
    visualizerExpanded: boolean;
    visualizerLyricsOverlay?: boolean;
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
                activeTab: 'queue',
                dynamicBackground: true,
                dynamicImageBlur: 1.5,
                dynamicIsImage: false,
                expanded: false,
                opacity: 60,
                useImageAspectRatio: false,
                visualizerAsBackground: false,
                visualizerExpanded: false,
                visualizerLyricsOverlay: true,
            })),
            { name: 'store_full_screen_player' },
        ),
        {
            merge: (persistedState, currentState) => {
                return merge(currentState, persistedState);
            },
            migrate: (persistedState, version) => {
                if (version <= 2) {
                    return {} as FullScreenPlayerState;
                }

                return persistedState;
            },
            name: 'store_full_screen_player',
            version: 3,
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

export const useFullScreenPlayerOpacity = () =>
    useFullScreenPlayerStore((state) => state.opacity);

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
