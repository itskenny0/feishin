import type { ServerListItem } from '/@/shared/types/domain-types';

import { memo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RiArrowRightSLine } from 'react-icons/ri';

import styles from './image-variants-settings.module.css';

import { clearThumbnails, hydrate } from '/@/renderer/cache';
import { applyThumbnailPreset, detectThumbnailPreset } from '/@/renderer/cache/variant-config';
import { SettingsOptions } from '/@/renderer/features/settings/components/settings-option';
import { useAuthStore } from '/@/renderer/store';
import { DEFAULT_IMAGE_VARIANTS, useImageVariants, useSettingsStore } from '/@/renderer/store';
import { Button } from '/@/shared/components/button/button';
import { Group } from '/@/shared/components/group/group';
import { NumberInput } from '/@/shared/components/number-input/number-input';
import { SegmentedControl } from '/@/shared/components/segmented-control/segmented-control';
import { Slider } from '/@/shared/components/slider/slider';
import { Stack } from '/@/shared/components/stack/stack';
import { Switch } from '/@/shared/components/switch/switch';
import { Table } from '/@/shared/components/table/table';
import { Text } from '/@/shared/components/text/text';
import { toast } from '/@/shared/components/toast/toast';

/**
 * Display order for the per-variant rows: smallest surface (dense lists)
 * first, original/full-screen last. Mirrors the `localCache.imageVariants`
 * bucket names so the surface→variant mapping needs no plumbing.
 */
type VariantKey = 'fullScreen' | 'header' | 'itemCard' | 'sidebar' | 'table';

const VARIANT_ORDER: VariantKey[] = ['table', 'itemCard', 'sidebar', 'header', 'fullScreen'];

const VARIANT_LABEL_KEYS: Record<VariantKey, { defaultValue: string; key: string }> = {
    fullScreen: {
        defaultValue: 'Full-screen player',
        key: 'page.setting.imageVariants.variantFullScreen',
    },
    header: { defaultValue: 'Page header', key: 'page.setting.imageVariants.variantHeader' },
    itemCard: { defaultValue: 'Grid card', key: 'page.setting.imageVariants.variantItemCard' },
    sidebar: { defaultValue: 'Sidebar', key: 'page.setting.imageVariants.variantSidebar' },
    table: { defaultValue: 'List / table row', key: 'page.setting.imageVariants.variantTable' },
};

interface ImageVariantsSettingsProps {
    /** Active server — required to re-trigger the sweep after a regenerate. */
    server?: ServerListItem;
}

export const ImageVariantsSettings = memo(({ server }: ImageVariantsSettingsProps) => {
    const { t } = useTranslation();
    const imageVariants = useImageVariants() ?? DEFAULT_IMAGE_VARIANTS;
    const setLocalCache = useSettingsStore((s) => s.actions.setLocalCache);

    const [regenerating, setRegenerating] = useState(false);

    const isDownload = imageVariants.mode === 'download';

    // Every write goes through the canonical default so a partially-seeded
    // persisted blob (older builds) can't drop a sibling key when we merge.
    const patchImageVariants = useCallback(
        (partial: Partial<typeof imageVariants>) => {
            setLocalCache({
                imageVariants: {
                    ...DEFAULT_IMAGE_VARIANTS,
                    ...imageVariants,
                    ...partial,
                },
            });
        },
        [imageVariants, setLocalCache],
    );

    const handleModeChange = useCallback(
        (value: string) => {
            console.info('[image-variants] mode changed', { mode: value });
            patchImageVariants({ mode: value === 'download' ? 'download' : 'downscale' });
        },
        [patchImageVariants],
    );

    // The active speed/quality preset, derived from which bounded sizes are
    // enabled. 'custom' means the per-size toggles below don't match any preset.
    // When autoPreset is on, the control shows 'auto' (the derived preset is the
    // live, already-applied one).
    const preset = detectThumbnailPreset(imageVariants);
    const auto = imageVariants.autoPreset === true;
    const displayPreset = auto ? 'auto' : preset;
    const handlePresetChange = useCallback(
        (value: string) => {
            if (value === 'auto') {
                console.info('[image-variants] preset changed', { preset: 'auto' });
                // Re-tunes on the next sync; turn the explicit pin off.
                patchImageVariants({ autoPreset: true });
                return;
            }
            if (value !== 'speed' && value !== 'balanced' && value !== 'full') return;
            console.info('[image-variants] preset changed', { preset: value });
            // An explicit pick disables auto-tune so a later sync won't override it.
            patchImageVariants({
                autoPreset: false,
                variants: applyThumbnailPreset(imageVariants, value),
            });
        },
        [imageVariants, patchImageVariants],
    );

    const handleFormatChange = useCallback(
        (value: string) => {
            patchImageVariants({ format: value === 'jpeg' ? 'jpeg' : 'webp' });
        },
        [patchImageVariants],
    );

    const handleQualityChange = useCallback(
        (value: number) => {
            patchImageVariants({ quality: value });
        },
        [patchImageVariants],
    );

    const handleVariantToggle = useCallback(
        (variant: VariantKey, enabled: boolean) => {
            patchImageVariants({
                variants: {
                    ...DEFAULT_IMAGE_VARIANTS.variants,
                    ...imageVariants.variants,
                    [variant]: {
                        ...imageVariants.variants[variant],
                        enabled,
                    },
                },
            });
        },
        [imageVariants, patchImageVariants],
    );

    const handleVariantPx = useCallback(
        (variant: VariantKey, px: number) => {
            patchImageVariants({
                variants: {
                    ...DEFAULT_IMAGE_VARIANTS.variants,
                    ...imageVariants.variants,
                    [variant]: {
                        ...imageVariants.variants[variant],
                        px: Math.max(0, Math.round(px)),
                    },
                },
            });
        },
        [imageVariants, patchImageVariants],
    );

    // Regenerate = nuke the variant rows and re-run the sweep so every
    // enabled variant is produced fresh under the current config.
    const handleRegenerate = useCallback(async () => {
        if (regenerating) return;
        setRegenerating(true);
        try {
            console.info('[image-variants] regenerate requested — clearing thumbnails');
            await clearThumbnails();
            if (server) {
                console.info('[image-variants] regenerate — re-triggering sweep', {
                    serverId: server.id,
                });
                void hydrate(server, 'full');
            } else {
                console.warn('[image-variants] regenerate — no active server, sweep not started');
            }
            toast.success({
                message: t('page.setting.imageVariants.regenerateStarted', {
                    defaultValue: 'Artwork variants cleared — regenerating in the background.',
                }),
            });
        } catch (err) {
            console.warn('[image-variants] regenerate failed', { err });
            toast.error({ message: (err as Error).message ?? String(err) });
        } finally {
            setRegenerating(false);
        }
    }, [regenerating, server, t]);

    return (
        <Stack gap="sm">
            {/* Speed / quality preset — the primary control. Maps to which
                bounded sizes are pre-cached; fewer = faster first sync. */}
            <SettingsOptions
                control={
                    <SegmentedControl
                        aria-label={t('page.setting.imageVariants.presetLabel', {
                            defaultValue: 'Thumbnail detail',
                        })}
                        data={[
                            {
                                label: t('page.setting.imageVariants.presetAuto', {
                                    defaultValue: 'Auto ({{resolved}})',
                                    resolved:
                                        preset === 'speed'
                                            ? t('page.setting.imageVariants.presetSpeed', {
                                                  defaultValue: 'Speed',
                                              })
                                            : t('page.setting.imageVariants.presetBalanced', {
                                                  defaultValue: 'Balanced',
                                              }),
                                }),
                                value: 'auto',
                            },
                            {
                                label: t('page.setting.imageVariants.presetSpeed', {
                                    defaultValue: 'Speed',
                                }),
                                value: 'speed',
                            },
                            {
                                label: t('page.setting.imageVariants.presetBalanced', {
                                    defaultValue: 'Balanced',
                                }),
                                value: 'balanced',
                            },
                            {
                                label: t('page.setting.imageVariants.presetFull', {
                                    defaultValue: 'Full',
                                }),
                                value: 'full',
                            },
                            ...(preset === 'custom'
                                ? [
                                      {
                                          label: t('page.setting.imageVariants.presetCustom', {
                                              defaultValue: 'Custom',
                                          }),
                                          value: 'custom',
                                      },
                                  ]
                                : []),
                        ]}
                        onChange={handlePresetChange}
                        value={displayPreset}
                    />
                }
                description={t('page.setting.imageVariants.presetHelp', {
                    defaultValue:
                        'Fewer sizes = faster first sync. Speed pre-caches just list + grid sizes (larger surfaces upscale from the grid size); Balanced adds a larger size; Full caches every size. Tune individual sizes below for Custom.',
                })}
                indent
                title={t('page.setting.imageVariants.presetLabel', {
                    defaultValue: 'Thumbnail detail',
                })}
            />

            {/* Global generation mode */}
            <SettingsOptions
                control={
                    <SegmentedControl
                        aria-label={t('page.setting.imageVariants.modeLabel', {
                            defaultValue: 'Variant source',
                        })}
                        data={[
                            {
                                label: t('page.setting.imageVariants.modeDownload', {
                                    defaultValue: 'Download per size',
                                }),
                                value: 'download',
                            },
                            {
                                label: t('page.setting.imageVariants.modeDownscale', {
                                    defaultValue: 'Downscale locally',
                                }),
                                value: 'downscale',
                            },
                        ]}
                        onChange={handleModeChange}
                        value={imageVariants.mode}
                    />
                }
                description={t('page.setting.imageVariants.modeHelp', {
                    defaultValue:
                        'Download per size requests each resolution from the server. Downscale locally fetches each cover once and resizes it in the app (more CPU, fewer requests).',
                })}
                indent
                title={t('page.setting.imageVariants.modeLabel', {
                    defaultValue: 'Variant source',
                })}
            />

            {/* Per-variant pre-cache table */}
            <SettingsOptions
                indent
                isSubheader
                title={t('page.setting.imageVariants.variantsHeader', {
                    defaultValue: 'Sizes to pre-cache',
                })}
            />
            <Table className={styles.variantTable} withRowBorders={false}>
                <Table.Thead>
                    <Table.Tr>
                        <Table.Th>
                            <Text isMuted size="xs">
                                {t('page.setting.imageVariants.colVariant', {
                                    defaultValue: 'Surface',
                                })}
                            </Text>
                        </Table.Th>
                        <Table.Th>
                            <Text isMuted size="xs">
                                {t('page.setting.imageVariants.colEnabled', {
                                    defaultValue: 'Pre-cache',
                                })}
                            </Text>
                        </Table.Th>
                        <Table.Th align="right">
                            <Text isMuted size="xs">
                                {t('page.setting.imageVariants.colPx', {
                                    defaultValue: 'Target px',
                                })}
                            </Text>
                        </Table.Th>
                    </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                    {VARIANT_ORDER.map((variant) => {
                        const v =
                            imageVariants.variants[variant] ??
                            DEFAULT_IMAGE_VARIANTS.variants[variant];
                        const label = t(VARIANT_LABEL_KEYS[variant].key, {
                            defaultValue: VARIANT_LABEL_KEYS[variant].defaultValue,
                        });
                        return (
                            <Table.Tr key={variant}>
                                <Table.Td>
                                    <Text className={styles.variantName}>{label}</Text>
                                </Table.Td>
                                <Table.Td>
                                    <Switch
                                        aria-label={label}
                                        checked={v.enabled}
                                        onChange={(e) =>
                                            handleVariantToggle(variant, e.currentTarget.checked)
                                        }
                                    />
                                </Table.Td>
                                <Table.Td align="right">
                                    <NumberInput
                                        aria-label={`${label} px`}
                                        max={2000}
                                        min={0}
                                        onChange={(value) => {
                                            if (typeof value !== 'number') return;
                                            handleVariantPx(variant, value);
                                        }}
                                        value={v.px}
                                        width={96}
                                    />
                                </Table.Td>
                            </Table.Tr>
                        );
                    })}
                </Table.Tbody>
            </Table>
            <Text isMuted size="xs">
                {t('page.setting.imageVariants.pxHelp', {
                    defaultValue: '0 = keep the original resolution (no resize).',
                })}
            </Text>

            {/* Downscale-only re-encode controls — greyed in download mode */}
            <div className={isDownload ? styles.downscaleDisabled : undefined}>
                <SettingsOptions
                    control={
                        <SegmentedControl
                            aria-label={t('page.setting.imageVariants.formatLabel', {
                                defaultValue: 'Re-encode format',
                            })}
                            data={[
                                { label: 'WebP', value: 'webp' },
                                { label: 'JPEG', value: 'jpeg' },
                            ]}
                            disabled={isDownload}
                            onChange={handleFormatChange}
                            value={imageVariants.format}
                        />
                    }
                    description={t('page.setting.imageVariants.formatHelp', {
                        defaultValue:
                            'Format used when re-encoding downscaled covers. WebP is smaller; JPEG keeps maximum compatibility. Only applies in downscale mode.',
                    })}
                    indent
                    title={t('page.setting.imageVariants.formatLabel', {
                        defaultValue: 'Re-encode format',
                    })}
                />
                <SettingsOptions
                    control={
                        <Slider
                            aria-label={t('page.setting.imageVariants.qualityLabel', {
                                defaultValue: 'Quality',
                            })}
                            disabled={isDownload}
                            label={(value) => `${value}`}
                            max={100}
                            min={1}
                            onChangeEnd={handleQualityChange}
                            step={1}
                            value={imageVariants.quality}
                            w={180}
                        />
                    }
                    description={t('page.setting.imageVariants.qualityHelp', {
                        defaultValue:
                            'Encoder quality (1–100). 82 is a good balance. Only applies in downscale mode.',
                    })}
                    indent
                    title={t('page.setting.imageVariants.qualityLabel', {
                        defaultValue: 'Quality',
                    })}
                />
            </div>

            {/* Regenerate action */}
            <Group className={styles.regenerateRow}>
                <Button
                    disabled={regenerating}
                    loading={regenerating}
                    onClick={() => void handleRegenerate()}
                    variant="default"
                >
                    {t('page.setting.imageVariants.regenerate', {
                        defaultValue: 'Regenerate variants now',
                    })}
                </Button>
                <Text isMuted size="xs">
                    {t('page.setting.imageVariants.regenerateHelp', {
                        defaultValue:
                            'Clears the cached covers and rebuilds every enabled size under the current settings.',
                    })}
                </Text>
            </Group>
        </Stack>
    );
});

ImageVariantsSettings.displayName = 'ImageVariantsSettings';

interface ImageVariantsRowProps {
    /** Navigate to the drill-down editor subpage. */
    onOpen: () => void;
}

/**
 * Build a one-line summary of the current artwork-variant configuration —
 * e.g. "Downscale locally · 4 sizes enabled". Used both by the navigation
 * row in the Library sync page and as a quick at-a-glance status.
 */
const useImageVariantsSummary = (): string => {
    const { t } = useTranslation();
    const imageVariants = useImageVariants() ?? DEFAULT_IMAGE_VARIANTS;

    const modeLabel =
        imageVariants.mode === 'download'
            ? t('page.setting.imageVariants.modeDownload', { defaultValue: 'Download per size' })
            : t('page.setting.imageVariants.modeDownscale', { defaultValue: 'Downscale locally' });

    const enabledCount = VARIANT_ORDER.filter(
        (variant) =>
            (imageVariants.variants[variant] ?? DEFAULT_IMAGE_VARIANTS.variants[variant]).enabled,
    ).length;

    return t('page.setting.imageVariants.summary', {
        count: enabledCount,
        defaultValue: '{{mode}} · {{count}} sizes enabled',
        mode: modeLabel,
    });
};

/**
 * Navigation row that replaces the old inline Edit/Close toggle. Shows the
 * artwork-variant title, a live summary of the current config, and a chevron
 * that drills into the dedicated editor subpage.
 */
export const ImageVariantsRow = memo(({ onOpen }: ImageVariantsRowProps) => {
    const { t } = useTranslation();
    const summary = useImageVariantsSummary();

    return (
        <SettingsOptions
            control={
                <Button
                    aria-label={t('page.setting.imageVariants.title', {
                        defaultValue: 'Artwork variants',
                    })}
                    onClick={onOpen}
                    rightSection={<RiArrowRightSLine size="1.1rem" />}
                    size="compact-md"
                    variant="subtle"
                >
                    {summary}
                </Button>
            }
            description={t('page.setting.imageVariants.description', {
                defaultValue:
                    'Cache several cover sizes per item so dense lists and grids load without decoding full-resolution artwork.',
            })}
            title={t('page.setting.imageVariants.title', {
                defaultValue: 'Artwork variants',
            })}
        />
    );
});

ImageVariantsRow.displayName = 'ImageVariantsRow';

/**
 * Standalone drill-down subpage for the artwork-variant editor. Resolves the
 * active server itself (the sweep needs it for the regenerate action) so the
 * subpage manifest can register it without threading props.
 */
export const ImageVariantsSubpage = memo(() => {
    const { t } = useTranslation();
    const currentServer = useAuthStore((s) => s.currentServer);

    return (
        <Stack gap="lg">
            <Stack gap="xs">
                <Text size="lg">
                    {t('page.setting.imageVariants.title', { defaultValue: 'Artwork variants' })}
                </Text>
                <Text isMuted>
                    {t('page.setting.imageVariants.description', {
                        defaultValue:
                            'Cache several cover sizes per item so dense lists and grids load without decoding full-resolution artwork.',
                    })}
                </Text>
            </Stack>
            <ImageVariantsSettings server={currentServer ?? undefined} />
        </Stack>
    );
});

ImageVariantsSubpage.displayName = 'ImageVariantsSubpage';
