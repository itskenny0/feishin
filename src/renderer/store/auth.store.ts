import merge from 'lodash/merge';
import { nanoid } from 'nanoid/non-secure';
import { devtools, persist } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import { shallow } from 'zustand/shallow';
import { createWithEqualityFn } from 'zustand/traditional';

import { ServerListItem, ServerListItemWithCredential } from '/@/shared/types/domain-types';

export interface AuthSlice extends AuthState {
    actions: {
        addServer: (args: ServerListItemWithCredential) => void;
        deleteServer: (id: string) => void;
        getServer: (id: string) => null | ServerListItemWithCredential;
        logout: () => void;
        setCurrentServer: (server: null | ServerListItemWithCredential) => void;
        setMusicFolderId: (musicFolderId: string[] | undefined) => void;
        updateServer: (id: string, args: Partial<ServerListItemWithCredential>) => void;
    };
}

export interface AuthState {
    currentServer: null | ServerListItemWithCredential;
    deviceId: string;
    serverList: Record<string, ServerListItemWithCredential>;
}

export const useAuthStore = createWithEqualityFn<AuthSlice>()(
    persist(
        devtools(
            immer((set, get) => ({
                actions: {
                    addServer: (args) => {
                        set((state) => {
                            state.serverList[args.id] = args;
                        });
                    },
                    deleteServer: (id) => {
                        // Capture the server entry BEFORE the set() call so we
                        // can fire the `feishin:server-deleted` window event with
                        // the userId attached — the cache lifecycle hook needs
                        // both (serverId, userId) to drop the matching Dexie DB.
                        // Without this dispatch, orphan Dexie databases leak on
                        // disk forever after a server is removed.
                        const serverBeforeDelete = get().serverList[id];
                        set((state) => {
                            delete state.serverList[id];

                            if (state.currentServer?.id === id) {
                                state.currentServer = null;
                            }
                        });
                        if (typeof window !== 'undefined' && serverBeforeDelete?.userId) {
                            console.info('[cache] auth: dispatching feishin:server-deleted', {
                                serverId: id,
                                userId: serverBeforeDelete.userId,
                            });
                            window.dispatchEvent(
                                new CustomEvent('feishin:server-deleted', {
                                    detail: {
                                        serverId: id,
                                        userId: serverBeforeDelete.userId,
                                    },
                                }),
                            );
                        }
                    },
                    getServer: (id) => {
                        const server = get().serverList[id];
                        if (server) return server;
                        return null;
                    },
                    logout: () => {
                        set((state) => {
                            const currentServer = state.currentServer;
                            if (!currentServer) {
                                return;
                            }

                            const server = state.serverList[currentServer.id];
                            if (server) {
                                server.credential = '';
                                server.ndCredential = undefined;
                                server.savePassword = false;
                            }

                            state.currentServer = null;
                        });
                    },
                    setCurrentServer: (server) => {
                        set((state) => {
                            state.currentServer = server;
                        });
                    },
                    setMusicFolderId: (musicFolderId: string[] | undefined) => {
                        set((state) => {
                            if (state.currentServer) {
                                state.currentServer.musicFolderId = musicFolderId;
                                const serverId = state.currentServer.id;
                                if (state.serverList[serverId]) {
                                    state.serverList[serverId].musicFolderId = musicFolderId;
                                }
                            }
                        });
                    },
                    updateServer: (id: string, args: Partial<ServerListItemWithCredential>) => {
                        set((state) => {
                            const updatedServer = {
                                ...state.serverList[id],
                                ...args,
                            };

                            if (
                                state.currentServer?.id === id &&
                                !('musicFolderId' in args) &&
                                state.currentServer.musicFolderId !== undefined
                            ) {
                                updatedServer.musicFolderId = state.currentServer.musicFolderId;
                            }

                            state.serverList[id] = updatedServer;
                            if (state.currentServer?.id === id) {
                                state.currentServer = updatedServer;
                            }
                        });
                    },
                },
                currentServer: null,
                deviceId: nanoid(),
                serverList: {},
            })),
            { name: 'store_authentication' },
        ),
        {
            merge: (persistedState, currentState) => merge(currentState, persistedState),
            name: 'store_authentication',
            version: 2,
        },
    ),
);

export const useCurrentServerId = (): string =>
    useAuthStore((state) => {
        const currentServer = state.currentServer;

        if (!currentServer) {
            return '';
        }

        return currentServer.id;
    }, shallow);

export const useCurrentServer = () =>
    useAuthStore((state) => {
        if (!state.currentServer) {
            return null;
        }

        return {
            features: state.currentServer?.features,
            id: state.currentServer?.id,
            isAdmin: state.currentServer?.isAdmin,
            musicFolderId: state.currentServer?.musicFolderId,
            name: state.currentServer?.name,
            preferInstantMix: state.currentServer?.preferInstantMix,
            preferRemoteUrl: state.currentServer?.preferRemoteUrl,
            remoteUrl: state.currentServer?.remoteUrl,
            savePassword: state.currentServer?.savePassword,
            type: state.currentServer?.type,
            url: state.currentServer?.url,
            userId: state.currentServer?.userId,
            username: state.currentServer?.username,
            version: state.currentServer?.version,
        };
    }, shallow) as ServerListItem;

export const useIsAdmin = () =>
    useAuthStore((state) => {
        return {
            isAdmin: state.currentServer?.isAdmin ?? false,
            userId: state.currentServer?.userId,
        };
    }, shallow);

export const useCurrentServerWithCredential = (): null | ServerListItemWithCredential =>
    // Honest type: every caller already defensively checks for null/credential
    // (because the previous cast lied to TS), so reflect reality here. Makes
    // future callers handle the unloaded-server / signed-out case explicitly.
    useAuthStore((state) => state.currentServer) as null | ServerListItemWithCredential;

export const useServerList = () => useAuthStore((state) => state.serverList);

export const useAuthStoreActions = () => useAuthStore((state) => state.actions);

export const getServerById = (id?: string) => {
    if (!id) {
        return null;
    }

    return useAuthStore.getState().actions.getServer(id);
};

export const usePermissions = () => {
    const { isAdmin, userId } = useIsAdmin();

    return {
        playlists: {
            editOwner: isAdmin,
            editPublic: isAdmin,
        },
        radio: {
            create: true,
            delete: isAdmin,
            edit: isAdmin,
        },
        userId: userId,
    };
};
