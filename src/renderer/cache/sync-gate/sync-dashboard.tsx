import type { CSSProperties } from 'react';

import { Button } from '@mantine/core';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { EntityType } from '../types';
import type { GateEntity } from './gate-state';
import type { SyncRunnerState } from './use-sync-runner';

import { formatBytes, formatCount } from '../format';
import { useCacheStore } from '../store';
import { useSmoothSweep } from '../use-smooth-sweep';
import { enabledGateEntities, GATE_ENTITIES } from './gate-state';
import styles from './sync-dashboard.module.css';

import { useSettingsStore } from '/@/renderer/store';

// i18n key per entity — reuse the existing library-sync dashboard labels so we
// don't duplicate translation strings.
const ENTITY_LABEL_KEYS: Record<GateEntity, string> = {
    albums: 'page.setting.librarySyncDashboard.entityAlbums',
    artists: 'page.setting.librarySyncDashboard.entityArtists',
    favorites: 'page.setting.librarySyncDashboard.entityFavorites',
    genres: 'page.setting.librarySyncDashboard.entityGenres',
    lyrics: 'page.setting.librarySyncDashboard.entityLyrics',
    playlists: 'page.setting.librarySyncDashboard.entityPlaylists',
    songs: 'page.setting.librarySyncDashboard.entitySongs',
};

interface SyncDashboardProps {
    onContinueAnyway: () => void;
    runner: SyncRunnerState;
}

/**
 * Full-screen blocking dashboard shown while the first full library sync runs.
 * Renders overall %, live throughput, per-entity rows, retry/backoff status,
 * and (after repeated failures) the "Continue anyway" escape hatch. Reads all
 * live data from the cache store — it does not own any sync logic.
 */
export const SyncDashboard = ({ onContinueAnyway, runner }: SyncDashboardProps) => {
    const { t } = useTranslation();
    const smooth = useSmoothSweep();
    const entityCounts = useCacheStore((s) => s.entityCounts);
    const hydrationStates = useCacheStore((s) => s.hydrationStates);
    const bytesUsed = useCacheStore((s) => s.bytesUsed);
    const entityToggles = useSettingsStore((s) => s.localCache.entities);

    const entities = useMemo(() => enabledGateEntities(entityToggles), [entityToggles]);
    const currentEntity = smooth.entity as EntityType | undefined;

    // Overall progress: each completed (full) entity is one whole unit; the
    // entity currently sweeping contributes a fraction from the live sweep.
    const overallPct = useMemo(() => {
        if (entities.length === 0) return 100;
        let done = 0;
        for (const e of entities) {
            if (hydrationStates[e] === 'full') {
                done += 1;
            } else if (e === currentEntity && smooth.total && smooth.total > 0) {
                done += Math.min(0.999, smooth.done / smooth.total);
            }
        }
        return Math.min(100, Math.round((done / entities.length) * 100));
    }, [entities, hydrationStates, currentEntity, smooth.done, smooth.total]);

    const completedCount = entities.filter((e) => hydrationStates[e] === 'full').length;

    // ── Live stat strip values ──
    const itemsLabel = smooth.entity
        ? `${formatCount(smooth.done)}${smooth.total ? ` / ${formatCount(smooth.total)}` : ''}`
        : '—';
    const itemsPerSecLabel = smooth.entity ? `${smooth.itemsPerSec.toFixed(1)}/s` : '—';
    const bytesLabel = smooth.entity ? formatBytes(smooth.bytesDownloaded) : formatBytes(bytesUsed);

    // ETA: remaining items at the current rate. Best-effort; hidden when we
    // can't estimate.
    const etaLabel = useMemo(() => {
        if (!smooth.entity || !smooth.total || smooth.itemsPerSec <= 0) return '—';
        const remaining = Math.max(0, smooth.total - smooth.done);
        const sec = remaining / smooth.itemsPerSec;
        if (!Number.isFinite(sec)) return '—';
        if (sec < 60) return `${Math.ceil(sec)}s`;
        if (sec < 3600) return `${Math.ceil(sec / 60)}m`;
        return `${(sec / 3600).toFixed(1)}h`;
    }, [smooth.entity, smooth.total, smooth.done, smooth.itemsPerSec]);

    const sweeping = runner.phase === 'syncing' && Boolean(smooth.entity);

    // Tick once per second while waiting for a retry so the countdown animates
    // (keeps Date.now() out of render — purity rule).
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (runner.phase !== 'retry-wait') return undefined;
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, [runner.phase]);

    // Retry / backoff status line.
    const retryNote = (() => {
        if (runner.phase === 'retry-wait') {
            const sec = runner.nextRetryAt
                ? Math.max(0, Math.ceil((runner.nextRetryAt - now) / 1000))
                : undefined;
            return t('page.syncGate.retryScheduled', {
                count: runner.failureCount,
                defaultValue:
                    'Sync was interrupted (attempt {{count}}). Retrying automatically{{when}}…',
                when: sec !== undefined ? ` in ${sec}s` : '',
            });
        }
        if (sweeping && currentEntity) {
            return t('page.syncGate.syncingEntity', {
                defaultValue: 'Caching {{entity}}…',
                entity: t(ENTITY_LABEL_KEYS[currentEntity as GateEntity] ?? '', {
                    defaultValue: currentEntity,
                }),
            });
        }
        return t('page.syncGate.preparing', { defaultValue: 'Preparing…' });
    })();

    const ringStyle = { '--pct': overallPct } as CSSProperties;

    return (
        <div className={styles.root}>
            <div className={styles.panel}>
                <span className={styles.eyebrow}>
                    {t('page.syncGate.eyebrow', { defaultValue: 'Local library' })}
                </span>
                <h1 className={styles.heading}>
                    {t('page.syncGate.heading', { defaultValue: 'Building your offline library' })}
                </h1>
                <p className={styles.subheading}>
                    {t('page.syncGate.subheading', {
                        defaultValue:
                            "We're caching your library's metadata — track, album and artist info plus artwork — so everything loads instantly and works offline. The songs themselves aren't downloaded here. This runs once; keep the app open until it finishes.",
                    })}
                </p>

                {/* Central progress ring */}
                <div className={styles.ringWrap} data-active={sweeping}>
                    <div className={styles.ring} style={ringStyle} />
                    <div className={styles.ringSweep} />
                    <div className={styles.ringInner}>
                        <div className={styles.pct}>
                            {overallPct}
                            <span className={styles.pctSign}>%</span>
                        </div>
                        <div className={styles.ringCaption}>
                            {t('page.syncGate.entitiesDone', {
                                defaultValue: '{{done}} / {{total}} done',
                                done: completedCount,
                                total: entities.length,
                            })}
                        </div>
                    </div>
                </div>

                {/* Live stat strip */}
                <div className={styles.stats}>
                    <div className={styles.stat}>
                        <span className={styles.statValue}>{itemsLabel}</span>
                        <span className={styles.statLabel}>
                            {t('page.syncGate.statItems', { defaultValue: 'Items' })}
                        </span>
                    </div>
                    <div className={styles.stat}>
                        <span className={styles.statValue}>{itemsPerSecLabel}</span>
                        <span className={styles.statLabel}>
                            {t('page.syncGate.statRate', { defaultValue: 'Rate' })}
                        </span>
                    </div>
                    <div className={styles.stat}>
                        <span className={styles.statValue}>{bytesLabel}</span>
                        <span className={styles.statLabel}>
                            {t('page.syncGate.statData', { defaultValue: 'Data' })}
                        </span>
                    </div>
                    <div className={styles.stat}>
                        <span className={styles.statValue}>{etaLabel}</span>
                        <span className={styles.statLabel}>
                            {t('page.syncGate.statEta', { defaultValue: 'ETA' })}
                        </span>
                    </div>
                </div>

                {/* Per-entity rows */}
                <div className={styles.entities}>
                    {entities.map((entity) => {
                        const state = hydrationStates[entity] ?? 'none';
                        const isCurrent = entity === currentEntity && sweeping;
                        const count = entityCounts[entity] ?? 0;
                        const meta = isCurrent
                            ? `${formatCount(smooth.done)}${smooth.total ? ` / ${formatCount(smooth.total)}` : ''}`
                            : state === 'full'
                              ? t('page.syncGate.entityCount', {
                                    count,
                                    defaultValue: '{{count}} cached',
                                })
                              : t('page.syncGate.entityWaiting', { defaultValue: 'Waiting' });
                        return (
                            <div
                                className={styles.entity}
                                data-current={isCurrent}
                                data-state={state}
                                key={entity}
                            >
                                <span className={styles.dot} />
                                <span className={styles.entityName}>
                                    {t(ENTITY_LABEL_KEYS[entity], { defaultValue: entity })}
                                    {entity === 'songs' && (
                                        <span className={styles.entityHint}>
                                            {t('page.syncGate.entitySongsHint', {
                                                defaultValue: 'metadata, not audio',
                                            })}
                                        </span>
                                    )}
                                </span>
                                <span className={styles.entityMeta}>{meta}</span>
                            </div>
                        );
                    })}
                </div>

                {/* Footer: retry status + escape hatch */}
                <div className={styles.footer}>
                    <span className={styles.retryNote} data-error={Boolean(runner.lastError)}>
                        {retryNote}
                        {runner.lastError ? ` — ${runner.lastError}` : ''}
                    </span>

                    {runner.canContinue ? (
                        <div className={styles.escape}>
                            <Button color="gray" onClick={onContinueAnyway} variant="light">
                                {t('page.syncGate.continueAnyway', {
                                    defaultValue: 'Continue anyway',
                                })}
                            </Button>
                            <span className={styles.escapeHint}>
                                {t('page.syncGate.continueHint', {
                                    defaultValue:
                                        'Sync keeps failing. You can enter the app now — caching will resume in the background, but some screens may be incomplete until it finishes.',
                                })}
                            </span>
                        </div>
                    ) : null}
                </div>
            </div>
        </div>
    );
};

// Re-export so the gate module can reference the full label set if needed.
export const SYNC_DASHBOARD_ENTITIES: readonly GateEntity[] = GATE_ENTITIES;
