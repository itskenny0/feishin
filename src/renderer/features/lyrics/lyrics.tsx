import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import styles from './lyrics.module.css';

import { queryKeys } from '/@/renderer/api/query-keys';
import { translateLyrics } from '/@/renderer/features/lyrics/api/lyric-translate';
import {
    computeSelectedFromResult,
    getDisplayOffset,
    lyricsQueries,
    type LyricsQueryResult,
} from '/@/renderer/features/lyrics/api/lyrics-api';
import { openLyricsExportModal } from '/@/renderer/features/lyrics/components/lyrics-export-form';
import { LyricsActions } from '/@/renderer/features/lyrics/lyrics-actions';
import {
    SynchronizedLyrics,
    SynchronizedLyricsProps,
} from '/@/renderer/features/lyrics/synchronized-lyrics';
import {
    UnsynchronizedLyrics,
    UnsynchronizedLyricsProps,
} from '/@/renderer/features/lyrics/unsynchronized-lyrics';
import { openLyricsSettingsModal } from '/@/renderer/features/lyrics/utils/open-lyrics-settings-modal';
import { uploadLyricsToServer } from '/@/renderer/features/lyrics/utils/upload-lyrics-to-server';
import { usePlayerEvents } from '/@/renderer/features/player/audio-player/hooks/use-player-events';
import { useIsRadioActive } from '/@/renderer/features/radio/hooks/use-radio-player';
import { ComponentErrorBoundary } from '/@/renderer/features/shared/components/component-error-boundary';
import { queryClient } from '/@/renderer/lib/react-query';
import { useLyricsSettings, usePlayerSong } from '/@/renderer/store';
import { useCurrentServerWithCredential } from '/@/renderer/store/auth.store';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Center } from '/@/shared/components/center/center';
import { Group } from '/@/shared/components/group/group';
import { Spinner } from '/@/shared/components/spinner/spinner';
import { Text } from '/@/shared/components/text/text';
import { toast } from '/@/shared/components/toast/toast';
import { LyricsOverride, ServerType } from '/@/shared/types/domain-types';

type LyricsProps = {
    fadeOutNoLyricsMessage?: boolean;
    settingsKey?: string;
};

export const Lyrics = ({ fadeOutNoLyricsMessage = true, settingsKey = 'default' }: LyricsProps) => {
    const currentSong = usePlayerSong();
    const isRadioActive = useIsRadioActive();

    const isLyricsDisabled = isRadioActive;

    const {
        enableAutoTranslation,
        preferLocalLyrics,
        translationApiKey,
        translationApiProvider,
        translationTargetLanguage,
    } = useLyricsSettings();
    const { t } = useTranslation();
    const [index, setIndexState] = useState(0);
    const [translatedLyrics, setTranslatedLyrics] = useState<null | string>(null);
    const [showTranslation, setShowTranslation] = useState(false);
    const [pendingSongId, setPendingSongId] = useState<string | undefined>(currentSong?.id);
    const lyricsFetchTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const previousSongIdRef = useRef<string | undefined>(currentSong?.id);

    useEffect(() => {
        const currentSongId = currentSong?.id;
        const previousSongId = previousSongIdRef.current;

        if (currentSongId === previousSongId) {
            return;
        }

        previousSongIdRef.current = currentSongId;
        setPendingSongId(undefined);

        if (!currentSongId) {
            return;
        }

        clearTimeout(lyricsFetchTimeoutRef.current);
        lyricsFetchTimeoutRef.current = setTimeout(() => {
            setPendingSongId(currentSongId);
        }, 500);

        return () => {
            clearTimeout(lyricsFetchTimeoutRef.current);
        };
    }, [currentSong?.id]);

    const lyricsKey = useMemo(() => {
        if (!currentSong?._serverId || !currentSong?.id) return null;
        return queryKeys.songs.lyrics(currentSong._serverId, { songId: currentSong.id });
    }, [currentSong]);

    const { data, isLoading } = useQuery(
        lyricsQueries.songLyrics(
            {
                options: {
                    enabled:
                        !!pendingSongId && pendingSongId === currentSong?.id && !isLyricsDisabled,
                },
                query: { songId: currentSong?.id || '' },
                serverId: currentSong?._serverId || '',
            },
            currentSong,
        ),
    );

    const indexToUse = data?.selectedStructuredIndex ?? index;
    useEffect(() => {
        if (data != null) setIndexState(data.selectedStructuredIndex);
    }, [data]);

    const { selected: lyrics, selectedSynced: synced } = useMemo(() => {
        if (!data) return { selected: null, selectedSynced: false };
        return computeSelectedFromResult(data, preferLocalLyrics, indexToUse);
    }, [data, indexToUse, preferLocalLyrics]);

    const displayLyrics = isLyricsDisabled ? null : lyrics;

    const currentOffsetMs = useMemo(() => {
        if (!data) return 0;
        return getDisplayOffset(lyrics, data.selectedOffsetMs, indexToUse, data.local);
    }, [data, indexToUse, lyrics]);

    const displayOffsetMs = isLyricsDisabled ? 0 : currentOffsetMs;

    const handleOnSearchOverride = useCallback(
        (params: LyricsOverride) => {
            if (!lyricsKey) return;
            queryClient.setQueryData<LyricsQueryResult>(lyricsKey, (prev) =>
                prev ? { ...prev, overrideSelection: params } : prev,
            );
            queryClient.invalidateQueries({ queryKey: lyricsKey });
        },
        [lyricsKey],
    );

    const handleUpdateOffset = useCallback(
        (offsetMs: number) => {
            if (!currentSong || !lyricsKey) return;

            queryClient.setQueryData<LyricsQueryResult>(lyricsKey, (prev) => {
                if (!prev) return prev;
                const updated = { ...prev, selectedOffsetMs: offsetMs };
                if (Array.isArray(prev.local) && prev.local.length > 0) {
                    const idx = Math.min(indexToUse, prev.local.length - 1);
                    updated.local = [...prev.local];
                    updated.local[idx] = {
                        ...updated.local[idx],
                        offsetMs,
                    };
                }
                return updated;
            });
        },
        [currentSong, indexToUse, lyricsKey],
    );

    const setIndex = useCallback(
        (newIndex: number) => {
            setIndexState(newIndex);
            if (!lyricsKey || !data) return;
            const { selected: nextSelected, selectedSynced: nextSynced } =
                computeSelectedFromResult(data, preferLocalLyrics, newIndex);
            const nextOffset = getDisplayOffset(
                nextSelected,
                data.selectedOffsetMs,
                newIndex,
                data.local,
            );
            queryClient.setQueryData<LyricsQueryResult>(lyricsKey, (prev) =>
                prev
                    ? {
                          ...prev,
                          selected: nextSelected,
                          selectedOffsetMs: nextOffset,
                          selectedStructuredIndex: newIndex,
                          selectedSynced: nextSynced,
                      }
                    : prev,
            );
        },
        [data, lyricsKey, preferLocalLyrics],
    );

    const handleOnRemoveLyric = useCallback(async () => {
        if (!currentSong || !lyricsKey) return;

        queryClient.setQueryData<LyricsQueryResult>(lyricsKey, (prev) =>
            prev
                ? {
                      ...prev,
                      overrideData: null,
                      overrideSelection: null,
                      remoteAuto: null,
                      suppressRemoteAuto: true,
                  }
                : prev,
        );
        await queryClient.invalidateQueries({ queryKey: lyricsKey });
    }, [currentSong, lyricsKey]);

    const fetchTranslation = useCallback(async () => {
        if (!lyrics || isLyricsDisabled) return;
        const originalLyrics = Array.isArray(lyrics.lyrics)
            ? lyrics.lyrics.map(([, line]) => line).join('\n')
            : lyrics.lyrics;
        const TranslatedText: null | string = await translateLyrics(
            originalLyrics,
            translationApiKey,
            translationApiProvider,
            translationTargetLanguage,
        );
        setTranslatedLyrics(TranslatedText);
        setShowTranslation(true);
    }, [
        isLyricsDisabled,
        lyrics,
        translationApiKey,
        translationApiProvider,
        translationTargetLanguage,
    ]);

    const handleOnTranslateLyric = useCallback(async () => {
        if (translatedLyrics) {
            setShowTranslation(!showTranslation);
            return;
        }
        await fetchTranslation();
    }, [translatedLyrics, showTranslation, fetchTranslation]);

    usePlayerEvents(
        {
            onCurrentSongChange: () => {
                setIndexState(0);
                setShowTranslation(false);
                setTranslatedLyrics(null);
            },
        },
        [],
    );

    useEffect(() => {
        if (displayLyrics && !translatedLyrics && enableAutoTranslation) {
            fetchTranslation();
        }
    }, [displayLyrics, translatedLyrics, enableAutoTranslation, fetchTranslation]);

    const languages = useMemo(() => {
        const local = data?.local;
        if (Array.isArray(local)) {
            return local.map((lyric, idx) => ({ label: lyric.lang, value: idx.toString() }));
        }
        if (local && !Array.isArray(local) && 'lyrics' in local) {
            return [{ label: 'xxx', value: '0' }];
        }
        return [];
    }, [data?.local]);

    const isLoadingLyrics = isLoading && !isLyricsDisabled;
    const hasNoLyrics = !displayLyrics;
    const [shouldFadeOut, setShouldFadeOut] = useState(false);

    useEffect(() => {
        if (!fadeOutNoLyricsMessage) {
            setShouldFadeOut(false);
            return undefined;
        }

        if (!isLoadingLyrics && hasNoLyrics) {
            const timer = setTimeout(() => {
                setShouldFadeOut(true);
            }, 3000);
            return () => clearTimeout(timer);
        }

        if (!hasNoLyrics) {
            setShouldFadeOut(false);
        }

        return undefined;
    }, [isLoadingLyrics, hasNoLyrics, fadeOutNoLyricsMessage]);

    const handleExportLyrics = useCallback(() => {
        if (displayLyrics) {
            openLyricsExportModal({ lyrics: displayLyrics, offsetMs: currentOffsetMs, synced });
        }
    }, [currentOffsetMs, displayLyrics, synced]);

    const credentialedServer = useCurrentServerWithCredential();

    // Lock for the duration of an in-flight upload so a double-click on the
    // 'Save to server' button doesn't fire two concurrent POSTs against the
    // same item.
    const savingLyricsRef = useRef(false);
    const handleSaveLyricsToServer = async () => {
        if (
            !credentialedServer ||
            credentialedServer.type !== ServerType.JELLYFIN ||
            !currentSong?.id ||
            !displayLyrics
        ) {
            return;
        }
        if (savingLyricsRef.current) return;
        savingLyricsRef.current = true;
        try {
            const outcome = await uploadLyricsToServer({
                itemId: currentSong.id,
                lyrics: displayLyrics,
                server: credentialedServer,
            });
            switch (outcome.kind) {
                case 'auth':
                    toast.error({
                        message: t('form.lyricsExport.saveFailed_auth', {
                            defaultValue:
                                "You don't have permission to upload lyrics to this server.",
                        }),
                    });
                    break;
                case 'empty':
                    toast.warn({
                        message: t('form.lyricsExport.saveFailed_empty', {
                            defaultValue: 'Nothing to save — these lyrics are empty.',
                        }),
                    });
                    break;
                case 'failed':
                    toast.error({
                        message: t('form.lyricsExport.saveFailed', {
                            code: String(outcome.status),
                        }),
                    });
                    break;
                case 'network':
                    toast.error({
                        message: t('form.lyricsExport.saveFailed_network', {
                            defaultValue:
                                "Couldn't reach the server. Check your connection and try again.",
                        }),
                    });
                    break;
                case 'success':
                    toast.info({ message: t('form.lyricsExport.savedToServer') });
                    // Bust the cached lyrics for this song so a manual refresh
                    // (or 'Clear') re-fetches the canonical server-side copy
                    // rather than serving the in-memory pre-upload version.
                    if (currentSong._serverId && currentSong.id) {
                        queryClient.invalidateQueries({
                            queryKey: queryKeys.songs.lyrics(currentSong._serverId, {
                                songId: currentSong.id,
                            }),
                        });
                    }
                    break;
                case 'tooLarge':
                    toast.error({
                        message: t('form.lyricsExport.saveFailed_tooLarge', {
                            defaultValue: 'Lyrics are too large to upload.',
                        }),
                    });
                    break;
            }
        } finally {
            savingLyricsRef.current = false;
        }
    };

    const canSaveToServer =
        Boolean(credentialedServer && credentialedServer.type === ServerType.JELLYFIN) &&
        Boolean(currentSong?.id) &&
        Boolean(displayLyrics);

    const handleOpenSettings = () => {
        openLyricsSettingsModal(settingsKey);
    };

    return (
        <ComponentErrorBoundary>
            <div className={styles.lyricsContainer}>
                <ActionIcon
                    aria-label={t('common.settings')}
                    className={styles.settingsIcon}
                    icon="settings2"
                    iconProps={{ size: 'lg' }}
                    onClick={handleOpenSettings}
                    pos="absolute"
                    right={0}
                    tooltip={{ label: t('common.settings'), openDelay: 400 }}
                    top={0}
                    variant="subtle"
                />
                {isLoadingLyrics ? (
                    <Spinner container />
                ) : (
                    <AnimatePresence mode="sync">
                        {hasNoLyrics ? (
                            <Center w="100%">
                                <motion.div
                                    animate={{ opacity: shouldFadeOut ? 0 : 1 }}
                                    initial={{ opacity: 1 }}
                                    transition={{ duration: 0.5 }}
                                >
                                    <Group>
                                        <Text fw={500} isMuted isNoSelect>
                                            {t('page.fullscreenPlayer.noLyrics')}
                                        </Text>
                                    </Group>
                                </motion.div>
                            </Center>
                        ) : (
                            <motion.div
                                animate={{ opacity: 1 }}
                                className={styles.scrollContainer}
                                initial={{ opacity: 0 }}
                                transition={{ duration: 0.5 }}
                            >
                                {synced ? (
                                    <SynchronizedLyrics
                                        {...(displayLyrics as SynchronizedLyricsProps)}
                                        offsetMs={displayOffsetMs}
                                        settingsKey={settingsKey}
                                        translatedLyrics={showTranslation ? translatedLyrics : null}
                                    />
                                ) : (
                                    <UnsynchronizedLyrics
                                        {...(displayLyrics as UnsynchronizedLyricsProps)}
                                        settingsKey={settingsKey}
                                        translatedLyrics={showTranslation ? translatedLyrics : null}
                                    />
                                )}
                            </motion.div>
                        )}
                    </AnimatePresence>
                )}
                <div className={styles.actionsContainer}>
                    <LyricsActions
                        hasLyrics={!!displayLyrics}
                        index={indexToUse}
                        languages={languages}
                        offsetMs={displayOffsetMs}
                        onExportLyrics={handleExportLyrics}
                        onRemoveLyric={handleOnRemoveLyric}
                        onSaveLyricsToServer={
                            canSaveToServer ? handleSaveLyricsToServer : undefined
                        }
                        onSearchOverride={handleOnSearchOverride}
                        onTranslateLyric={
                            translationApiProvider && translationApiKey
                                ? handleOnTranslateLyric
                                : undefined
                        }
                        onUpdateOffset={handleUpdateOffset}
                        setIndex={setIndex}
                        settingsKey={settingsKey}
                    />
                </div>
            </div>
        </ComponentErrorBoundary>
    );
};
