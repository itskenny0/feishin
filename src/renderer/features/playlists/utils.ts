import { nanoid } from 'nanoid/non-secure';

import { NDSongQueryFields } from '/@/shared/api/navidrome/navidrome-types';
import { Album, LibraryItem, Song } from '/@/shared/types/domain-types';
import { QueryBuilderGroup } from '/@/shared/types/types';

export type PlaylistAlbumRow = Album & { _playlistSongs?: Song[] };

// Strip the song filename off the end of song.path so it points at the
// containing folder. The album-list FS-name override expects album.path
// to be the album folder, not a track file inside it.
const albumFolderPathFromSongPath = (path?: null | string): null | string => {
    if (!path) return null;
    const segments = path.split(/[/\\]/);
    if (segments.length < 2) return null;
    return segments.slice(0, -1).join('/');
};

export function playlistSongsToAlbums(songs: Song[]): PlaylistAlbumRow[] {
    if (songs.length === 0) return [];

    const rows: PlaylistAlbumRow[] = [];
    let group: Song[] = [songs[0]];
    let prevAlbumId = songs[0].albumId;

    const pushRow = (song: Song, groupSongs: Song[]) => {
        rows.push({
            _itemType: LibraryItem.ALBUM,
            _playlistSongs: groupSongs,
            _serverId: song._serverId,
            _serverType: song._serverType,
            albumArtistName: song.albumArtistName,
            albumArtists: song.albumArtists,
            artists: song.artists,
            comment: song.comment,
            createdAt: song.createdAt,
            duration: null,
            explicitStatus: song.explicitStatus,
            genres: song.genres,
            id: song.albumId,
            imageId: song.imageId,
            imageUrl: song.imageUrl,
            isCompilation: song.compilation,
            lastPlayedAt: song.lastPlayedAt,
            mbzId: null,
            mbzReleaseGroupId: null,
            name: song.album ?? '',
            originalDate: null,
            originalYear: 0,
            participants: song.participants,
            path: albumFolderPathFromSongPath(song.path),
            playCount: null,
            recordLabels: [],
            releaseDate: song.releaseDate,
            releaseType: null,
            releaseTypes: [],
            releaseYear: song.releaseYear,
            size: null,
            songCount: null,
            sortName: song.album ?? '',
            tags: song.tags,
            updatedAt: song.updatedAt,
            userFavorite: false,
            userRating: null,
            version: null,
        });
    };

    for (let i = 1; i < songs.length; i++) {
        const song = songs[i];
        if (song.albumId === prevAlbumId) {
            group.push(song);
        } else {
            pushRow(group[0], group);
            group = [song];
            prevAlbumId = song.albumId;
        }
    }
    pushRow(group[0], group);

    return rows;
}

// Pure reorder helper shared by the playlist edit-mode tracklist. Given the
// current ordered list of items (matched by `id`), a set of source ids being
// moved, the drop target id and the drop edge, returns the new ordering.
// Multi-select moves keep the relative order of the sources. The math mirrors
// what the PLAYLIST_REORDER handler needs; extracted here so it can be unit
// tested in isolation.
export function reorderPlaylistItems<T extends { id: string }>(
    items: T[],
    sourceIds: string[],
    targetId: string,
    edge: 'bottom' | 'top',
): T[] {
    const currentIds = items.map((item) => item.id);

    const targetIndex = currentIds.indexOf(targetId);
    if (targetIndex === -1) {
        return items;
    }

    const idsWithoutSources = currentIds.filter((id) => !sourceIds.includes(id));

    const sourcesBeforeTarget = sourceIds.filter((id) => {
        const sourceIndex = currentIds.indexOf(id);
        return sourceIndex !== -1 && sourceIndex < targetIndex;
    }).length;

    const insertIndexInFiltered =
        edge === 'top' ? targetIndex - sourcesBeforeTarget : targetIndex - sourcesBeforeTarget + 1;

    const insertIndex = Math.max(0, Math.min(insertIndexInFiltered, idsWithoutSources.length));

    const reorderedIds = [
        ...idsWithoutSources.slice(0, insertIndex),
        ...sourceIds,
        ...idsWithoutSources.slice(insertIndex),
    ];

    const itemMap = new Map(items.map((item) => [item.id, item]));

    return reorderedIds
        .map((id) => itemMap.get(id))
        .filter((item): item is T => item !== undefined);
}

export const parseQueryBuilderChildren = (groups: QueryBuilderGroup[], data: any[]) => {
    if (groups.length === 0) {
        return data;
    }

    const filterGroups: any[] = [];

    for (const group of groups) {
        const rootType = group.type;
        const query: any = {
            [rootType]: [],
        };

        for (const rule of group.rules) {
            if (rule.field && rule.operator) {
                const [table, field] = rule.field.split('.');
                const operator = mapDatePickerOperatorToApi(rule.operator);
                const value = field !== 'releaseDate' ? rule.value : new Date(rule.value);

                switch (table) {
                    default:
                        query[rootType].push({
                            [operator]: {
                                [table]: value,
                            },
                        });
                        break;
                }
            }
        }

        if (group.group.length > 0) {
            const b = parseQueryBuilderChildren(group.group, data);
            b.forEach((c) => query[rootType].push(c));
        }

        data.push(query);
        filterGroups.push(query);
    }

    return filterGroups;
};

// Convert QueryBuilderGroup to default query
export const convertQueryGroupToNDQuery = (filter: QueryBuilderGroup) => {
    const rootQueryType = filter.type;
    const rootQuery = {
        [rootQueryType]: [] as any[],
    };

    for (const rule of filter.rules) {
        if (rule.field && rule.operator) {
            const [field] = rule.field.split('.');
            const operator = mapDatePickerOperatorToApi(rule.operator);
            let value = rule.value;

            const booleanFields = NDSongQueryFields.filter(
                (queryField) => queryField.type === 'boolean',
            ).map((field) => field.value);

            // Convert string values to boolean
            if (booleanFields.includes(field)) {
                value = value === 'true';
            }

            switch (field) {
                default:
                    rootQuery[rootQueryType].push({
                        [operator]: {
                            [field]: value,
                        },
                    });
                    break;
            }
        }
    }

    const groups = parseQueryBuilderChildren(filter.group, []);
    for (const group of groups) {
        rootQuery[rootQueryType].push(group);
    }

    return rootQuery;
};

// Convert default query to QueryBuilderGroup
export const convertNDQueryToQueryGroup = (query: Record<string, any>) => {
    const rootType = Object.keys(query)[0];
    const rootGroup: QueryBuilderGroup = {
        group: [],
        rules: [],
        type: rootType as 'all' | 'any',
        uniqueId: nanoid(),
    };

    for (const rule of query[rootType]) {
        if (rule.any || rule.all) {
            const group = convertNDQueryToQueryGroup(rule);
            rootGroup.group.push(group);
        } else {
            let operator = Object.keys(rule)[0];
            const field = Object.keys(rule[operator])[0];
            let value = rule[operator][field];

            const booleanFields = NDSongQueryFields.filter(
                (queryField) => queryField.type === 'boolean',
            ).map((field) => field.value);

            // Convert boolean values to string
            if (booleanFields.includes(field)) {
                value = value.toString();
            }

            // Use date-picker operator in UI when value is date-like (e.g. YYYY-MM-DD); otherwise keep API operator
            operator = mapApiOperatorToDatePicker(operator, value);

            rootGroup.rules.push({
                field,
                operator,
                uniqueId: nanoid(),
                value,
            });
        }
    }

    return rootGroup;
};

const DATE_STRING_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function isDateLikeValue(value: unknown): boolean {
    if (value instanceof Date) return true;
    if (typeof value === 'string') return DATE_STRING_REGEX.test(value.trim());
    return false;
}

function isDateRangeValue(value: unknown): value is [null | string, null | string] {
    if (!Array.isArray(value) || value.length !== 2) return false;
    const [a, b] = value;
    return (a == null || isDateLikeValue(a)) && (b == null || isDateLikeValue(b));
}

function mapApiOperatorToDatePicker(operator: string, value: unknown): string {
    if (operator === 'before' && isDateLikeValue(value)) return 'beforeDate';
    if (operator === 'after' && isDateLikeValue(value)) return 'afterDate';
    if (operator === 'inTheRange' && isDateRangeValue(value)) return 'inTheRangeDate';
    return operator;
}

function mapDatePickerOperatorToApi(operator: string): string {
    if (operator === 'beforeDate') return 'before';
    if (operator === 'afterDate') return 'after';
    if (operator === 'inTheRangeDate') return 'inTheRange';
    return operator;
}
