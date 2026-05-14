import { jfApiClient } from '/@/renderer/api/jellyfin/jellyfin-api';
import { JF_FIELDS } from '/@/renderer/api/jellyfin/jellyfin-controller';
import type {
    RemoteDevice,
    RemotePlayCommand,
    RemotePlaystateCommand,
} from '/@/renderer/features/jellyfin-remote-target/types';
import { jfNormalize } from '/@/shared/api/jellyfin/jellyfin-normalize';
import type { ServerListItemWithCredential, Song } from '/@/shared/types/domain-types';

type ServerArg = { server: ServerListItemWithCredential };

const safeSessionToDevice = (s: any): null | RemoteDevice => {
    if (!s || typeof s.Id !== 'string' || typeof s.DeviceId !== 'string') return null;
    const np = s.NowPlayingItem ?? null;
    return {
        capabilities: Array.isArray(s.SupportedCommands) ? s.SupportedCommands : [],
        client: typeof s.Client === 'string' ? s.Client : '',
        deviceId: s.DeviceId,
        deviceName: typeof s.DeviceName === 'string' ? s.DeviceName : 'Unknown device',
        isPaused: Boolean(s.PlayState?.IsPaused),
        lastActivityIso: typeof s.LastActivityDate === 'string' ? s.LastActivityDate : '',
        nowPlayingArtist: np?.Artists?.[0] ?? np?.AlbumArtist ?? null,
        nowPlayingItemId: np?.Id ?? null,
        nowPlayingTitle: np?.Name ?? null,
        sessionId: s.Id,
        supportsMediaControl: Boolean(s.SupportsMediaControl),
    };
};

export const remoteTargetApi = {
    /**
     * Fetch every session the current user can control. The Jellyfin API
     * returns sessions for the *authenticated* user; ControllableByUserId
     * filters to ones the user has permission to drive.
     */
    listSessions: async (args: ServerArg): Promise<RemoteDevice[]> => {
        const userId = args.server.userId;
        if (!userId) return [];
        const res = await jfApiClient({ server: args.server }).getSessions({
            query: { ControllableByUserId: userId },
        });
        if (res.status !== 200 || !Array.isArray(res.body)) return [];
        return res.body
            .map((s) => safeSessionToDevice(s))
            .filter((d): d is RemoteDevice => Boolean(d));
    },

    /**
     * Like listSessions but also returns the matching raw session object so
     * callers can read fields not in RemoteDevice (e.g. NowPlayingQueue).
     */
    listSessionsWithRaw: async (
        args: ServerArg,
    ): Promise<{ devices: RemoteDevice[]; raws: Record<string, unknown> }> => {
        const userId = args.server.userId;
        if (!userId) return { devices: [], raws: {} };
        const res = await jfApiClient({ server: args.server }).getSessions({
            query: { ControllableByUserId: userId },
        });
        if (res.status !== 200 || !Array.isArray(res.body)) return { devices: [], raws: {} };
        const raws: Record<string, unknown> = {};
        const devices: RemoteDevice[] = [];
        for (const s of res.body) {
            const device = safeSessionToDevice(s);
            if (!device) continue;
            devices.push(device);
            raws[device.sessionId] = s;
        }
        return { devices, raws };
    },

    /**
     * Push a list of itemIds to a session with PlayNow/PlayNext/PlayLast.
     */
    play: async (
        args: ServerArg & {
            itemIds: string[];
            playCommand: RemotePlayCommand;
            sessionId: string;
            startIndex?: number;
            startPositionTicks?: number;
        },
    ): Promise<void> => {
        await jfApiClient({ server: args.server }).postPlaying({
            body: null,
            params: { sessionId: args.sessionId },
            query: {
                ItemIds: args.itemIds.join(','),
                PlayCommand: args.playCommand,
                StartIndex: args.startIndex,
                StartPositionTicks: args.startPositionTicks,
            },
        });
    },

    /**
     * Send a transport command to a session.
     */
    sendPlaystate: async (
        args: ServerArg & {
            command: RemotePlaystateCommand;
            playlistIndex?: number;
            seekPositionTicks?: number;
            sessionId: string;
        },
    ): Promise<void> => {
        await jfApiClient({ server: args.server }).postPlayingCommand({
            body: null,
            params: { sessionId: args.sessionId, command: args.command },
            query: {
                SeekPositionTicks: args.seekPositionTicks,
                PlaylistIndex: args.playlistIndex,
            },
        });
    },

    /**
     * Send a GeneralCommand (SetVolume, Mute, …).
     */
    sendGeneralCommand: async (
        args: ServerArg & {
            arguments?: Record<string, string>;
            name: string;
            sessionId: string;
        },
    ): Promise<void> => {
        await jfApiClient({ server: args.server }).postGeneralCommand({
            body: { Name: args.name, Arguments: args.arguments },
            params: { sessionId: args.sessionId },
        });
    },

    /**
     * Hydrate a list of item IDs into Song objects via the existing /Items
     * route. Used for the mirrored queue display.
     */
    hydrateSongs: async (
        args: ServerArg & { itemIds: string[] },
    ): Promise<Song[]> => {
        if (args.itemIds.length === 0) return [];
        const server = args.server;
        if (!server.userId) return [];
        const res = await jfApiClient({ server }).getSongList({
            params: { userId: server.userId },
            query: {
                Fields: JF_FIELDS.SONG,
                Ids: args.itemIds.join(','),
                IncludeItemTypes: 'Audio',
                Limit: args.itemIds.length,
                Recursive: true,
            },
        });
        if (res.status !== 200) return [];
        const byId = new Map(
            res.body.Items.map((item) => [item.Id, jfNormalize.song(item, server)]),
        );
        return args.itemIds
            .map((id) => byId.get(id))
            .filter((s): s is Song => Boolean(s));
    },
};
