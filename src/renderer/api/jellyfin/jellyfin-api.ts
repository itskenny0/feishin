import { Capacitor } from '@capacitor/core';
import { initClient, initContract } from '@ts-rest/core';
import axios, { AxiosError, AxiosResponse, isAxiosError, Method } from 'axios';
import omitBy from 'lodash/omitBy';
import qs from 'qs';
import { z } from 'zod';

import packageJson from '../../../../package.json';

import i18n from '/@/i18n/i18n';
import { authenticationFailure } from '/@/renderer/api/utils';
import { markServerReachable, markServerUnreachable } from '/@/renderer/lib/network-status';
import { useAuthStore } from '/@/renderer/store';
import { getServerUrl } from '/@/renderer/utils/normalize-server-url';
import { jfType } from '/@/shared/api/jellyfin/jellyfin-types';
import { getClientType } from '/@/shared/api/utils';
import { ServerListItemWithCredential } from '/@/shared/types/domain-types';

const c = initContract();

export const contract = c.router({
    addToPlaylist: {
        body: z.null(),
        method: 'POST',
        path: 'playlists/:id/items',
        query: jfType._parameters.addToPlaylist,
        responses: {
            204: jfType._response.addToPlaylist,
            400: jfType._response.error,
        },
    },
    authenticate: {
        body: jfType._parameters.authenticate,
        method: 'POST',
        path: 'users/authenticatebyname',
        responses: {
            200: jfType._response.authenticate,
            400: jfType._response.error,
        },
    },
    createFavorite: {
        body: jfType._parameters.favorite,
        method: 'POST',
        path: 'users/:userId/favoriteitems/:id',
        responses: {
            200: jfType._response.favorite,
            400: jfType._response.error,
        },
    },
    createPlaylist: {
        body: jfType._parameters.createPlaylist,
        method: 'POST',
        path: 'playlists',
        responses: {
            200: jfType._response.createPlaylist,
            400: jfType._response.error,
        },
    },
    deletePlaylist: {
        body: null,
        method: 'DELETE',
        path: 'items/:id',
        responses: {
            204: jfType._response.deletePlaylist,
            400: jfType._response.error,
        },
    },
    getAlbumArtistDetail: {
        method: 'GET',
        path: 'users/:userId/items/:id',
        query: jfType._parameters.albumArtistDetail,
        responses: {
            200: jfType._response.albumArtist,
            400: jfType._response.error,
        },
    },
    getAlbumArtistList: {
        method: 'GET',
        path: 'artists/albumArtists',
        query: jfType._parameters.albumArtistList,
        responses: {
            200: jfType._response.albumArtistList,
            400: jfType._response.error,
        },
    },
    getAlbumDetail: {
        method: 'GET',
        path: 'users/:userId/items/:id',
        query: jfType._parameters.albumDetail,
        responses: {
            200: jfType._response.album,
            400: jfType._response.error,
        },
    },
    getAlbumList: {
        method: 'GET',
        path: 'users/:userId/items',
        query: jfType._parameters.albumList,
        responses: {
            200: jfType._response.albumList,
            400: jfType._response.error,
        },
    },
    getArtistList: {
        method: 'GET',
        path: 'artists',
        query: jfType._parameters.albumArtistList,
        responses: {
            200: jfType._response.albumArtistList,
            400: jfType._response.error,
        },
    },
    getFilterList: {
        method: 'GET',
        path: 'items/filters',
        query: jfType._parameters.filterList,
        responses: {
            200: jfType._response.filters,
            400: jfType._response.error,
        },
    },
    getFolder: {
        method: 'GET',
        path: 'users/:userId/items',
        query: jfType._parameters.folder,
        responses: {
            200: jfType._response.folderList,
            400: jfType._response.error,
        },
    },
    getGenreList: {
        method: 'GET',
        path: 'musicgenres',
        query: jfType._parameters.genreList,
        responses: {
            200: jfType._response.genreList,
            400: jfType._response.error,
        },
    },
    getInstantMix: {
        method: 'GET',
        path: 'items/:itemId/InstantMix',
        query: jfType._parameters.similarSongs,
        responses: {
            200: jfType._response.songList,
            400: jfType._response.error,
        },
    },
    getMusicFolderList: {
        method: 'GET',
        path: 'users/:userId/items',
        responses: {
            200: jfType._response.musicFolderList,
            400: jfType._response.error,
        },
    },
    getPlaylistDetail: {
        method: 'GET',
        path: 'users/:userId/items/:id',
        query: jfType._parameters.playlistDetail,
        responses: {
            200: jfType._response.playlist,
            400: jfType._response.error,
        },
    },
    getPlaylistList: {
        method: 'GET',
        path: 'users/:userId/items',
        query: jfType._parameters.playlistList,
        responses: {
            200: jfType._response.playlistList,
            400: jfType._response.error,
        },
    },
    getPlaylistSongList: {
        method: 'GET',
        path: 'playlists/:id/items',
        query: jfType._parameters.songList,
        responses: {
            200: jfType._response.playlistSongList,
            400: jfType._response.error,
        },
    },
    getPlayQueue: {
        method: 'GET',
        path: 'sessions',
        query: jfType._parameters.getQueue,
        responses: {
            200: jfType._response.getSessions,
            400: jfType._response.error,
        },
    },
    getServerInfo: {
        method: 'GET',
        path: 'system/info',
        responses: {
            200: jfType._response.serverInfo,
            400: jfType._response.error,
        },
    },
    getSessions: {
        method: 'GET',
        path: 'sessions',
        query: jfType._parameters.getSessions,
        responses: {
            200: jfType._response.getSessions,
            400: jfType._response.error,
        },
    },
    getSimilarArtistList: {
        method: 'GET',
        path: 'artists/:id/similar',
        query: jfType._parameters.similarArtistList,
        responses: {
            200: jfType._response.albumArtistList,
            400: jfType._response.error,
        },
    },
    getSimilarSongs: {
        method: 'GET',
        path: 'items/:itemId/similar',
        query: jfType._parameters.similarSongs,
        responses: {
            200: jfType._response.similarSongs,
            400: jfType._response.error,
        },
    },
    getSongData: {
        method: 'GET',
        path: 'users/:userId/items/:id',
        query: jfType._parameters.songDetail,
        responses: {
            200: jfType._response.song,
            400: jfType._response.error,
        },
    },
    getSongDetail: {
        method: 'GET',
        path: 'users/:userId/items/:id',
        responses: {
            200: jfType._response.song,
            400: jfType._response.error,
        },
    },
    getSongList: {
        method: 'GET',
        path: 'users/:userId/items',
        query: jfType._parameters.songList,
        responses: {
            200: jfType._response.songList,
            400: jfType._response.error,
        },
    },
    getSongLyrics: {
        method: 'GET',
        path: 'audio/:id/Lyrics',
        responses: {
            200: jfType._response.lyrics,
            404: jfType._response.error,
        },
    },
    getStudioList: {
        method: 'GET',
        path: 'studios',
        query: jfType._parameters.studioList,
        responses: {
            200: jfType._response.studioList,
            400: jfType._response.error,
        },
    },
    getTopSongsList: {
        method: 'GET',
        path: 'users/:userId/items',
        query: jfType._parameters.songList,
        responses: {
            200: jfType._response.topSongsList,
            400: jfType._response.error,
        },
    },
    getUser: {
        method: 'GET',
        path: 'users/:id',
        responses: {
            200: jfType._response.user,
            400: jfType._response.error,
        },
    },
    movePlaylistItem: {
        body: null,
        method: 'POST',
        path: 'playlists/:playlistId/items/:itemId/move/:newIdx',
        responses: {
            200: jfType._response.moveItem,
            400: jfType._response.error,
        },
    },
    postCapabilitiesFull: {
        body: jfType._parameters.capabilitiesFull,
        method: 'POST',
        path: 'sessions/capabilities/full',
        responses: {
            204: jfType._response.capabilitiesFull,
            400: jfType._response.error,
        },
    },
    postGeneralCommand: {
        body: jfType._parameters.postGeneralCommand,
        method: 'POST',
        path: 'sessions/:sessionId/command',
        responses: {
            200: jfType._response.remoteCommand,
            204: jfType._response.remoteCommand,
            400: jfType._response.error,
        },
    },
    postPlaying: {
        body: z.null(),
        method: 'POST',
        path: 'sessions/:sessionId/playing',
        query: jfType._parameters.postPlaying,
        responses: {
            200: jfType._response.remoteCommand,
            204: jfType._response.remoteCommand,
            400: jfType._response.error,
        },
    },
    postPlayingCommand: {
        body: z.null(),
        method: 'POST',
        path: 'sessions/:sessionId/playing/:command',
        query: jfType._parameters.postPlayingCommand,
        responses: {
            200: jfType._response.remoteCommand,
            204: jfType._response.remoteCommand,
            400: jfType._response.error,
        },
    },
    removeFavorite: {
        body: jfType._parameters.favorite,
        method: 'DELETE',
        path: 'users/:userId/favoriteitems/:id',
        responses: {
            200: jfType._response.favorite,
            400: jfType._response.error,
        },
    },
    removeFromPlaylist: {
        body: null,
        method: 'DELETE',
        path: 'playlists/:id/items',
        query: jfType._parameters.removeFromPlaylist,
        responses: {
            200: jfType._response.removeFromPlaylist,
            400: jfType._response.error,
        },
    },
    savePlayQueue: {
        body: jfType._parameters.saveQueue,
        method: 'POST',
        path: 'sessions/playing',
        responses: {
            200: jfType._response.scrobble,
            400: jfType._response.error,
        },
    },
    scrobblePlaying: {
        body: jfType._parameters.scrobble,
        method: 'POST',
        path: 'sessions/playing',
        responses: {
            200: jfType._response.scrobble,
            400: jfType._response.error,
        },
    },
    scrobbleProgress: {
        body: jfType._parameters.scrobble,
        method: 'POST',
        path: 'sessions/playing/progress',
        responses: {
            200: jfType._response.scrobble,
            400: jfType._response.error,
        },
    },
    scrobbleStopped: {
        body: jfType._parameters.scrobble,
        method: 'POST',
        path: 'sessions/playing/stopped',
        responses: {
            200: jfType._response.scrobble,
            400: jfType._response.error,
        },
    },
    search: {
        method: 'GET',
        path: 'users/:userId/items',
        query: jfType._parameters.search,
        responses: {
            200: jfType._response.search,
            400: jfType._response.error,
        },
    },
    updatePlaylist: {
        body: jfType._parameters.updatePlaylist,
        method: 'POST',
        path: 'playlists/:id',
        responses: {
            200: jfType._response.updatePlaylist,
            400: jfType._response.error,
        },
    },
});

// Transport-level ceiling so a hung TCP connection can't pin a request
// forever (axios has no default timeout). 30s is generous for slow library
// scans / large fetches but bounded enough that the UI recovers. Applies only
// to these JSON API/metadata calls — audio stream URLs are plain string URLs
// handled by the <audio> element and are untouched.
const REQUEST_TIMEOUT_MS = 30_000;

const axiosClient = axios.create({ timeout: REQUEST_TIMEOUT_MS });

axiosClient.defaults.paramsSerializer = (params) => {
    return qs.stringify(params, { arrayFormat: 'repeat' });
};

axiosClient.interceptors.response.use(
    (response) => {
        // A real response means the server is reachable — clear any prior
        // unreachable override so connectivity-gated work can resume.
        markServerReachable();
        return response;
    },
    (error) => {
        if (error.response && error.response.status === 401) {
            const currentServer = useAuthStore.getState().currentServer;

            if (currentServer) {
                useAuthStore
                    .getState()
                    .actions.updateServer(currentServer.id, { credential: undefined });
            }

            authenticationFailure(currentServer);
        }

        return Promise.reject(error);
    },
);

const parsePath = (fullPath: string) => {
    const [path, params] = fullPath.split('?');

    const parsedParams = qs.parse(params);
    const notNilParams = omitBy(parsedParams, (value) => value === 'undefined' || value === 'null');

    return {
        params: notNilParams,
        path,
    };
};

/**
 * Best-effort Android device model from the WebView user-agent, e.g.
 * "Pixel 7" from "...; Android 13; Pixel 7 Build/...". Modern Chrome freezes
 * the model to "K" for privacy — treated as unknown so we fall back to a
 * generic label rather than showing a useless "K".
 */
const parseAndroidModel = (ua: string): null | string => {
    const m = ua.match(/Android[^;]*;\s*([^;)]+?)(?:\s+Build\/|\))/i);
    const model = m?.[1]?.trim();
    if (!model || model.toLowerCase() === 'k' || /^wv$/i.test(model)) return null;
    return model;
};

export const getDeviceLabel = (): string => {
    // On the Android (Capacitor) client the WebView UA otherwise resolves to
    // "Chrome", which is meaningless in the device picker. Surface the device
    // model when we can read it, and always identify the app as Feishin.
    if (Capacitor.getPlatform() === 'android') {
        const model =
            typeof navigator !== 'undefined' ? parseAndroidModel(navigator.userAgent) : null;
        return model ? `Feishin (${model})` : 'Feishin (Android)';
    }
    const base = getClientType();
    // In Electron, append the system hostname so the device shows up in
    // Jellyfin's "Play On" picker as e.g. "Desktop Client (laptop)".
    const hostname =
        typeof window !== 'undefined' && window.api?.utils?.getHostname
            ? window.api.utils.getHostname()
            : '';
    return hostname ? `${base} (${hostname})` : base;
};

export const createAuthHeader = (): string => {
    return `MediaBrowser Client="Feishin", Device="${getDeviceLabel()}", DeviceId="${
        useAuthStore.getState().deviceId
    }", Version="${packageJson.version}"`;
};

export const jfApiClient = (args: {
    forceRemoteUrl?: boolean;
    server: null | ServerListItemWithCredential;
    signal?: AbortSignal;
    url?: string;
}) => {
    const { forceRemoteUrl, server, signal, url } = args;

    return initClient(contract, {
        api: async ({ body, headers, method, path }) => {
            let baseUrl: string | undefined;
            let token: string | undefined;

            const { params, path: api } = parsePath(path);

            if (server) {
                const serverUrl = getServerUrl(server, forceRemoteUrl);
                baseUrl = serverUrl;
                token = server?.credential;
            } else {
                baseUrl = url;
            }

            try {
                const result = await axiosClient.request({
                    data: body,
                    headers: {
                        ...headers,
                        ...(token
                            ? { Authorization: createAuthHeader().concat(`, Token="${token}"`) }
                            : { Authorization: createAuthHeader() }),
                    },
                    method: method as Method,
                    params,
                    signal,
                    url: `${baseUrl}/${api}`,
                });
                return {
                    body: result.data,
                    headers: result.headers as any,
                    status: result.status,
                };
            } catch (e: unknown) {
                if (isAxiosError(e)) {
                    if (
                        e.code === 'ERR_NETWORK' ||
                        e.code === 'ECONNABORTED' ||
                        e.code === 'ETIMEDOUT'
                    ) {
                        // Transport failure (connection refused / timeout) — the
                        // server is unreachable, not merely returning an error.
                        markServerUnreachable();
                        throw new Error(i18n.t('error.networkError') as string);
                    }

                    const error = e as AxiosError;
                    const response = error.response as AxiosResponse;
                    return {
                        body: response?.data,
                        headers: response?.headers as any,
                        status: response?.status,
                    };
                }
                throw e;
            }
        },
        baseHeaders: {
            'Content-Type': 'application/json',
        },
        baseUrl: '',
        jsonQuery: false,
    });
};
