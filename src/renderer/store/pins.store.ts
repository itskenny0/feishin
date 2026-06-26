import { devtools, persist } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import { useShallow } from 'zustand/react/shallow';
import { createWithEqualityFn } from 'zustand/traditional';

import { LibraryItem } from '/@/shared/types/domain-types';

export interface Pin {
    id: string;
    imageId?: null | string;
    imageUrl?: null | string;
    itemType: PinItemType;
    name: string;
    pinnedAt: number;
    serverId: string;
}

export type PinItemType =
    | LibraryItem.ALBUM
    | LibraryItem.ALBUM_ARTIST
    | LibraryItem.ARTIST
    | LibraryItem.GENRE
    | LibraryItem.PLAYLIST
    | LibraryItem.SONG;

export interface PinsActions {
    addPin: (pin: Omit<Pin, 'pinnedAt'>) => void;
    clearPins: (serverId?: string) => void;
    removePin: (serverId: string, itemType: PinItemType, id: string) => void;
    togglePin: (pin: Omit<Pin, 'pinnedAt'>) => void;
    updatePinImage: (
        serverId: string,
        itemType: PinItemType,
        id: string,
        imageId: null | string,
    ) => void;
}

export interface PinsSlice extends PinsState {
    actions: PinsActions;
}

export interface PinsState {
    pins: Pin[];
}

const samePin = (pin: Pin, serverId: string, itemType: PinItemType, id: string) =>
    pin.serverId === serverId && pin.itemType === itemType && pin.id === id;

export const usePinsStore = createWithEqualityFn<PinsSlice>()(
    persist(
        devtools(
            immer((set, get) => ({
                actions: {
                    addPin: (pin) => {
                        const exists = get().pins.some((p) =>
                            samePin(p, pin.serverId, pin.itemType, pin.id),
                        );

                        if (exists) {
                            return;
                        }

                        console.info(
                            `[home-pins] add pin ${pin.itemType}:${pin.id} (${pin.name}) on server ${pin.serverId}`,
                        );

                        set((state) => {
                            state.pins.push({ ...pin, pinnedAt: Date.now() });
                        });
                    },
                    clearPins: (serverId) => {
                        console.info(
                            `[home-pins] clear pins${serverId ? ` for server ${serverId}` : ''}`,
                        );

                        set((state) => {
                            state.pins = serverId
                                ? state.pins.filter((p) => p.serverId !== serverId)
                                : [];
                        });
                    },
                    removePin: (serverId, itemType, id) => {
                        console.info(
                            `[home-pins] remove pin ${itemType}:${id} on server ${serverId}`,
                        );

                        set((state) => {
                            state.pins = state.pins.filter(
                                (p) => !samePin(p, serverId, itemType, id),
                            );
                        });
                    },
                    togglePin: (pin) => {
                        const exists = get().pins.some((p) =>
                            samePin(p, pin.serverId, pin.itemType, pin.id),
                        );

                        if (exists) {
                            get().actions.removePin(pin.serverId, pin.itemType, pin.id);
                        } else {
                            get().actions.addPin(pin);
                        }
                    },
                    updatePinImage: (serverId, itemType, id, imageId) => {
                        set((state) => {
                            const pin = state.pins.find((p) => samePin(p, serverId, itemType, id));
                            if (pin && pin.imageId !== imageId) {
                                console.info(
                                    `[home-pins] heal pin image ${itemType}:${id} -> ${imageId}`,
                                );
                                pin.imageId = imageId;
                            }
                        });
                    },
                },
                pins: [],
            })),
            { name: 'store_pins' },
        ),
        {
            name: 'store_pins',
            partialize: (state) => ({ pins: state.pins }),
            version: 1,
        },
    ),
);

export const usePinsActions = () => usePinsStore((state) => state.actions);

export const usePins = (serverId: string): Pin[] =>
    usePinsStore(
        useShallow((state) =>
            state.pins
                .filter((pin) => pin.serverId === serverId)
                .sort((a, b) => b.pinnedAt - a.pinnedAt),
        ),
    );

export const useIsPinned = (
    serverId: string,
    itemType: PinItemType,
    id: string | undefined,
): boolean =>
    usePinsStore((state) =>
        id ? state.pins.some((p) => samePin(p, serverId, itemType, id)) : false,
    );
