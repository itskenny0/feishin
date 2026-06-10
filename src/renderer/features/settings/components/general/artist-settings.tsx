import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { DraggableItems } from '/@/renderer/features/settings/components/general/draggable-items';
import {
    SettingOption,
    SettingsSection,
} from '/@/renderer/features/settings/components/settings-section';
import {
    ArtistItem,
    ArtistReleaseTypeItem,
    SortableItem,
    useGeneralSettings,
    useSettingsStoreActions,
} from '/@/renderer/store';
import { Switch } from '/@/shared/components/switch/switch';

const ARTIST_ITEMS: Array<[ArtistItem, string]> = [
    [ArtistItem.BIOGRAPHY, 'table.column.biography'],
    [ArtistItem.FAVORITE_SONGS, 'page.albumArtistDetail.favoriteSongs'],
    [ArtistItem.TOP_SONGS, 'page.albumArtistDetail.topSongs'],
    [ArtistItem.RECENT_ALBUMS, 'page.albumArtistDetail.recentReleases'],
    [ArtistItem.SIMILAR_ARTISTS, 'page.albumArtistDetail.relatedArtists'],
];

export const ArtistSettings = memo(() => {
    const { artistItems } = useGeneralSettings();
    const { setArtistItems } = useSettingsStoreActions();

    return (
        <DraggableItems
            description="setting.artistConfiguration"
            itemLabels={ARTIST_ITEMS}
            items={artistItems as SortableItem<ArtistItem>[]}
            setItems={setArtistItems}
            title="setting.artistConfiguration"
        />
    );
});

const ARTIST_RELEASE_TYPE_ITEMS: Array<[ArtistReleaseTypeItem, string]> = [
    [ArtistReleaseTypeItem.APPEARS_ON, 'page.albumArtistDetail.appearsOn'],
    [ArtistReleaseTypeItem.RELEASE_TYPE_ALBUM, 'releaseType.primary.album'],
    [ArtistReleaseTypeItem.RELEASE_TYPE_EP, 'releaseType.primary.ep'],
    [ArtistReleaseTypeItem.RELEASE_TYPE_SINGLE, 'releaseType.primary.single'],
    [ArtistReleaseTypeItem.RELEASE_TYPE_BROADCAST, 'releaseType.primary.broadcast'],
    [ArtistReleaseTypeItem.RELEASE_TYPE_COMPILATION, 'releaseType.secondary.compilation'],
    [ArtistReleaseTypeItem.RELEASE_TYPE_AUDIO_DRAMA, 'releaseType.secondary.audioDrama'],
    [ArtistReleaseTypeItem.RELEASE_TYPE_AUDIOBOOK, 'releaseType.secondary.audiobook'],
    [ArtistReleaseTypeItem.RELEASE_TYPE_INTERVIEW, 'releaseType.secondary.interview'],
    [ArtistReleaseTypeItem.RELEASE_TYPE_LIVE, 'releaseType.secondary.live'],
    [ArtistReleaseTypeItem.RELEASE_TYPE_MIXTAPE_STREET, 'releaseType.secondary.mixtape'],
    [ArtistReleaseTypeItem.RELEASE_TYPE_OTHER, 'releaseType.primary.other'],
    [ArtistReleaseTypeItem.RELEASE_TYPE_REMIX, 'releaseType.secondary.remix'],
    [ArtistReleaseTypeItem.RELEASE_TYPE_DJ_MIX, 'releaseType.secondary.djMix'],
    [ArtistReleaseTypeItem.RELEASE_TYPE_DEMO, 'releaseType.secondary.demo'],
    [ArtistReleaseTypeItem.RELEASE_TYPE_FIELD_RECORDING, 'releaseType.secondary.fieldRecording'],
    [ArtistReleaseTypeItem.RELEASE_TYPE_SOUNDTRACK, 'releaseType.secondary.soundtrack'],
    [ArtistReleaseTypeItem.RELEASE_TYPE_SPOKENWORD, 'releaseType.secondary.spokenWord'],
];

export const ArtistReleaseTypeSettings = memo(() => {
    const { artistReleaseTypeItems } = useGeneralSettings();
    const { setArtistReleaseTypeItems } = useSettingsStoreActions();

    return (
        <DraggableItems
            description="setting.artistReleaseTypeConfiguration"
            itemLabels={ARTIST_RELEASE_TYPE_ITEMS}
            items={artistReleaseTypeItems as SortableItem<ArtistReleaseTypeItem>[]}
            setItems={setArtistReleaseTypeItems}
            title="setting.artistReleaseTypeConfiguration"
        />
    );
});

export const ArtistPageSectionsSettings = memo(() => {
    const { t } = useTranslation();
    const settings = useGeneralSettings();
    const { setSettings } = useSettingsStoreActions();

    const { artistPageSections } = settings;

    const update = (key: keyof typeof artistPageSections, value: boolean) => {
        setSettings({
            general: {
                ...settings,
                artistPageSections: {
                    ...artistPageSections,
                    [key]: value,
                },
            },
        });
    };

    const options: SettingOption[] = [
        {
            control: (
                <Switch
                    checked={artistPageSections.discographyButtons}
                    onChange={(e) => update('discographyButtons', e.currentTarget.checked)}
                />
            ),
            description: t('setting.artistPageDiscographyButtons', { context: 'description' }),
            title: t('setting.artistPageDiscographyButtons'),
        },
        {
            control: (
                <Switch
                    checked={artistPageSections.artistRadio}
                    onChange={(e) => update('artistRadio', e.currentTarget.checked)}
                />
            ),
            description: t('setting.artistPageArtistRadio', { context: 'description' }),
            title: t('setting.artistPageArtistRadio'),
        },
        {
            control: (
                <Switch
                    checked={artistPageSections.genres}
                    onChange={(e) => update('genres', e.currentTarget.checked)}
                />
            ),
            description: t('setting.artistPageGenres', { context: 'description' }),
            title: t('setting.artistPageGenres'),
        },
        {
            control: (
                <Switch
                    checked={artistPageSections.externalLinks}
                    onChange={(e) => update('externalLinks', e.currentTarget.checked)}
                />
            ),
            description: t('setting.artistPageExternalLinks', { context: 'description' }),
            title: t('setting.artistPageExternalLinks'),
        },
    ];

    return <SettingsSection options={options} title={t('setting.artistPageSections')} />;
});
