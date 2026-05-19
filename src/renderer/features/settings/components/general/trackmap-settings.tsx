import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
    SettingOption,
    SettingsSection,
} from '/@/renderer/features/settings/components/settings-section';
import {
    TRACKMAP_ADVANCED_DEFAULTS,
    useGeneralSettings,
    useSettingsStoreActions,
} from '/@/renderer/store';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Button } from '/@/shared/components/button/button';
import { ColorInput } from '/@/shared/components/color-input/color-input';
import { Group } from '/@/shared/components/group/group';
import { JsonInput } from '/@/shared/components/json-input/json-input';
import { Select } from '/@/shared/components/select/select';
import { Slider } from '/@/shared/components/slider/slider';
import { Stack } from '/@/shared/components/stack/stack';
import { Switch } from '/@/shared/components/switch/switch';
import { toast } from '/@/shared/components/toast/toast';

/**
 * Every trackmap-namespaced setting key, in the order they appear in the
 * exported JSON. Anything in `general` that starts with `trackmap` and that
 * the user should be able to round-trip via copy/paste should live in this
 * list — `trackmapStyle` and `trackmapEnabled` included, so a pasted snapshot
 * fully reproduces someone's setup.
 */
const TRACKMAP_KEYS = [
    'trackmapEnabled',
    'trackmapOnlyOverLan',
    'trackmapStyle',
    'trackmapHeight',
    'trackmapGlow',
    'trackmapSensitivity',
    'trackmapColorBgGlow',
    'trackmapColorCool',
    'trackmapColorWarm',
    'trackmapColorStrandB',
    'trackmapBgGlowAlpha',
    'trackmapEnvelopeFillAlpha',
    'trackmapEnvelopeOutlineAlpha',
    'trackmapEnvelopeOutlineWidthPx',
    'trackmapStrandHaloAlpha',
    'trackmapStrandCrispAlpha',
    'trackmapHaloBlurPx',
    'trackmapHelixCycles',
    'trackmapHelixRotationSec',
    'trackmapRungAlpha',
    'trackmapRungSpacingPx',
    'trackmapBreathAmplitudePct',
    'trackmapBreathPeriodSec',
    'trackmapDimMaskMin',
    'trackmapDimMaskTransitionPx',
    'trackmapPlayheadGlowAlpha',
    'trackmapPlayheadShadowBlurPx',
    'trackmapPlayheadWidthPx',
] as const;

type TrackmapKey = (typeof TRACKMAP_KEYS)[number];

/**
 * Custom control for the JSON export/import row. Lives in this file because
 * it's the only place this widget is used and inlining it keeps the settings
 * list flat.
 */
const TrackmapJsonControls = () => {
    const { t } = useTranslation();
    const settings = useGeneralSettings();
    const { setSettings } = useSettingsStoreActions();
    const [draft, setDraft] = useState('');

    // Recompute on every render — the values come from useGeneralSettings, so
    // any slider tweak above re-renders this component and the export view
    // updates live.
    const exported = useMemo(() => {
        const snapshot: Record<string, unknown> = {};
        for (const key of TRACKMAP_KEYS) {
            snapshot[key] = (settings as unknown as Record<string, unknown>)[key];
        }
        return JSON.stringify(snapshot, null, 2);
    }, [settings]);

    const handleCopy = () => {
        navigator.clipboard
            .writeText(exported)
            .then(() => {
                toast.success({ message: t('setting.trackmapJsonCopy') });
            })
            .catch(() => {
                toast.error({ message: t('setting.trackmapJsonInvalid') });
            });
    };

    const handleApply = () => {
        let parsed: unknown;
        try {
            parsed = JSON.parse(draft);
        } catch {
            toast.error({ message: t('setting.trackmapJsonInvalid') });
            return;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            toast.error({ message: t('setting.trackmapJsonInvalid') });
            return;
        }

        // Only apply keys we know about, and only when the value's basic
        // type matches the schema. Pasted garbage (numbers in color slots,
        // strings in numeric slots, null) is silently skipped rather than
        // poisoning the store. The merge layer also drops undefined, so a
        // value that fails the type guard is left at its current setting.
        const known = parsed as Record<string, unknown>;
        const patch: Partial<Record<TrackmapKey, unknown>> = {};
        let count = 0;
        for (const key of TRACKMAP_KEYS) {
            if (!(key in known)) continue;
            const value = known[key];
            if (value === null || value === undefined) continue;
            const isColor = key.startsWith('trackmapColor');
            const isStyle = key === 'trackmapStyle';
            const isBool = key === 'trackmapEnabled' || key === 'trackmapOnlyOverLan';
            if (isColor || isStyle) {
                if (typeof value !== 'string') continue;
            } else if (isBool) {
                if (typeof value !== 'boolean') continue;
            } else if (typeof value !== 'number' || !Number.isFinite(value)) {
                continue;
            }
            patch[key] = value;
            count += 1;
        }
        if (count === 0) {
            toast.error({ message: t('setting.trackmapJsonInvalid') });
            return;
        }

        setSettings({ general: patch as Record<string, unknown> });
        setDraft('');
        toast.success({ message: t('setting.trackmapJsonApplied') });
    };

    return (
        <Stack gap="sm" style={{ minWidth: 320, width: '100%' }}>
            <JsonInput
                aria-label={t('setting.trackmapJsonExport')}
                autosize
                formatOnBlur
                maxRows={14}
                minRows={6}
                readOnly
                value={exported}
            />
            <Group justify="flex-end">
                <Button onClick={handleCopy} size="compact-sm" variant="default">
                    {t('setting.trackmapJsonCopy')}
                </Button>
            </Group>
            <JsonInput
                aria-label={t('setting.trackmapJsonImport')}
                autosize
                maxRows={14}
                minRows={4}
                onChange={setDraft}
                placeholder={t('setting.trackmapJsonImport')}
                validationError={t('setting.trackmapJsonInvalid')}
                value={draft}
            />
            <Group justify="flex-end">
                <Button
                    disabled={draft.trim().length === 0}
                    onClick={handleApply}
                    size="compact-sm"
                    variant="filled"
                >
                    {t('common.apply', { defaultValue: 'Apply' })}
                </Button>
            </Group>
        </Stack>
    );
};

export const TrackmapSettings = memo(() => {
    const { t } = useTranslation();
    const settings = useGeneralSettings();
    const { setSettings } = useSettingsStoreActions();
    const [showAdvanced, setShowAdvanced] = useState(false);

    /**
     * Helper for the dense advanced slider rows — all share the same
     * shape (controlled value, write on change-end, indent + hide when
     * trackmap is off or advanced is collapsed). The title includes the
     * current numeric value so users can see what each knob is set to
     * without hovering or dragging to surface the Mantine tooltip.
     */
    const sliderRow = (
        key: TrackmapKey,
        labelKey: string,
        min: number,
        max: number,
        step = 1,
    ): SettingOption => ({
        control: (
            <Slider
                aria-label={t(`setting.${labelKey}`)}
                max={max}
                min={min}
                onChangeEnd={(value) =>
                    setSettings({ general: { [key]: value } as Record<string, number> })
                }
                step={step}
                value={settings[key] as number}
            />
        ),
        description: t(`setting.${labelKey}`, { context: 'description' }),
        indent: true,
        isHidden: !settings.trackmapEnabled || !showAdvanced,
        title: `${t(`setting.${labelKey}`)} (${settings[key]})`,
    });

    /** Most colors are required; trackmapColorWarm uniquely treats empty as
     *  "use the theme accent", so we let users clear that one via a right-
     *  section X button. Mantine's ColorInput has no built-in clearable
     *  affordance — `rightSection` is the supported escape hatch. */
    const colorRow = (
        key: TrackmapKey,
        labelKey: string,
        options?: { clearable?: boolean },
    ): SettingOption => ({
        control: (
            <ColorInput
                aria-label={t(`setting.${labelKey}`)}
                closeOnColorSwatchClick
                format="hex"
                onChangeEnd={(value) =>
                    setSettings({ general: { [key]: value } as Record<string, string> })
                }
                rightSection={
                    options?.clearable && (settings[key] as string).length > 0 ? (
                        <ActionIcon
                            aria-label={t('common.clear', { defaultValue: 'Clear' })}
                            onClick={() =>
                                setSettings({
                                    general: { [key]: '' } as Record<string, string>,
                                })
                            }
                            size="sm"
                            variant="subtle"
                        >
                            ✕
                        </ActionIcon>
                    ) : undefined
                }
                value={settings[key] as string}
            />
        ),
        description: t(`setting.${labelKey}`, { context: 'description' }),
        indent: true,
        isHidden: !settings.trackmapEnabled || !showAdvanced,
        title: t(`setting.${labelKey}`),
    });

    const options: SettingOption[] = [
        {
            control: (
                <Switch
                    aria-label={t('setting.trackmap')}
                    defaultChecked={settings.trackmapEnabled}
                    onChange={(e) =>
                        setSettings({ general: { trackmapEnabled: e.currentTarget.checked } })
                    }
                />
            ),
            description: t('setting.trackmap', { context: 'description' }),
            title: t('setting.trackmap'),
        },
        {
            control: (
                <Switch
                    aria-label={t('setting.trackmapOnlyOverLan')}
                    defaultChecked={settings.trackmapOnlyOverLan}
                    onChange={(e) =>
                        setSettings({
                            general: { trackmapOnlyOverLan: e.currentTarget.checked },
                        })
                    }
                />
            ),
            description: t('setting.trackmapOnlyOverLan', { context: 'description' }),
            indent: true,
            isHidden: !settings.trackmapEnabled,
            title: t('setting.trackmapOnlyOverLan'),
        },
        {
            control: (
                <Select
                    data={[{ label: t('setting.trackmapStyle_optionGlow'), value: 'glow' }]}
                    disabled
                    onChange={(value) => {
                        if (value) setSettings({ general: { trackmapStyle: value as 'glow' } });
                    }}
                    value={settings.trackmapStyle}
                />
            ),
            description: t('setting.trackmapStyle', { context: 'description' }),
            indent: true,
            isHidden: !settings.trackmapEnabled,
            title: t('setting.trackmapStyle'),
        },
        {
            control: (
                <Slider
                    aria-label={t('setting.trackmapHeight')}
                    max={100}
                    min={0}
                    onChangeEnd={(value) => setSettings({ general: { trackmapHeight: value } })}
                    step={1}
                    value={settings.trackmapHeight}
                />
            ),
            description: t('setting.trackmapHeight', { context: 'description' }),
            indent: true,
            isHidden: !settings.trackmapEnabled,
            title: `${t('setting.trackmapHeight')} (${settings.trackmapHeight})`,
        },
        {
            control: (
                <Slider
                    aria-label={t('setting.trackmapGlow')}
                    max={100}
                    min={0}
                    onChangeEnd={(value) => setSettings({ general: { trackmapGlow: value } })}
                    step={1}
                    value={settings.trackmapGlow}
                />
            ),
            description: t('setting.trackmapGlow', { context: 'description' }),
            indent: true,
            isHidden: !settings.trackmapEnabled,
            title: `${t('setting.trackmapGlow')} (${settings.trackmapGlow})`,
        },
        {
            control: (
                <Slider
                    aria-label={t('setting.trackmapSensitivity')}
                    max={100}
                    min={0}
                    onChangeEnd={(value) =>
                        setSettings({ general: { trackmapSensitivity: value } })
                    }
                    step={1}
                    value={settings.trackmapSensitivity}
                />
            ),
            description: t('setting.trackmapSensitivity', { context: 'description' }),
            indent: true,
            isHidden: !settings.trackmapEnabled,
            note: t('setting.trackmapSensitivity_note'),
            title: `${t('setting.trackmapSensitivity')} (${settings.trackmapSensitivity})`,
        },
        {
            control: (
                <Switch
                    aria-label={t('setting.trackmapAdvanced')}
                    checked={showAdvanced}
                    onChange={(e) => setShowAdvanced(e.currentTarget.checked)}
                />
            ),
            description: t('setting.trackmapAdvanced', { context: 'description' }),
            indent: true,
            isHidden: !settings.trackmapEnabled,
            title: t('setting.trackmapAdvanced'),
        },
        {
            control: (
                <Button
                    onClick={() => {
                        setSettings({
                            general: {
                                ...TRACKMAP_ADVANCED_DEFAULTS,
                            },
                        });
                        toast.info({ message: t('setting.trackmapResetAdvanced') });
                    }}
                    size="compact-sm"
                    variant="default"
                >
                    {t('setting.trackmapResetAdvanced')}
                </Button>
            ),
            description: t('setting.trackmapResetAdvanced', {
                context: 'description',
                defaultValue:
                    'Snap every value below back to the bundled default — useful when you want to start tweaking from a known baseline.',
            }),
            indent: true,
            isHidden: !settings.trackmapEnabled || !showAdvanced,
            title: t('setting.trackmapResetAdvanced'),
        },

        // Colors first — they're the most visually impactful knobs and the
        // ones a user is likeliest to want to tweak when they open the panel.
        colorRow('trackmapColorBgGlow', 'trackmapColorBgGlow'),
        colorRow('trackmapColorCool', 'trackmapColorCool'),
        colorRow('trackmapColorWarm', 'trackmapColorWarm', { clearable: true }),
        colorRow('trackmapColorStrandB', 'trackmapColorStrandB'),

        // Envelope (the silhouette that traces the wave's energy)
        sliderRow('trackmapBgGlowAlpha', 'trackmapBgGlowAlpha', 0, 100),
        sliderRow('trackmapEnvelopeFillAlpha', 'trackmapEnvelopeFillAlpha', 0, 100),
        sliderRow('trackmapEnvelopeOutlineAlpha', 'trackmapEnvelopeOutlineAlpha', 0, 100),
        sliderRow('trackmapEnvelopeOutlineWidthPx', 'trackmapEnvelopeOutlineWidthPx', 0, 10),

        // Helix strands
        sliderRow('trackmapStrandHaloAlpha', 'trackmapStrandHaloAlpha', 0, 100),
        sliderRow('trackmapStrandCrispAlpha', 'trackmapStrandCrispAlpha', 0, 100),
        sliderRow('trackmapHaloBlurPx', 'trackmapHaloBlurPx', 0, 50),
        sliderRow('trackmapHelixCycles', 'trackmapHelixCycles', 1, 12),
        sliderRow('trackmapHelixRotationSec', 'trackmapHelixRotationSec', 0, 120),

        // DNA rungs
        sliderRow('trackmapRungAlpha', 'trackmapRungAlpha', 0, 100),
        sliderRow('trackmapRungSpacingPx', 'trackmapRungSpacingPx', 4, 100),

        // Breath (idle pulse)
        sliderRow('trackmapBreathAmplitudePct', 'trackmapBreathAmplitudePct', 0, 30),
        sliderRow('trackmapBreathPeriodSec', 'trackmapBreathPeriodSec', 1, 30),

        // Unplayed-side dim mask
        sliderRow('trackmapDimMaskMin', 'trackmapDimMaskMin', 0, 100),
        sliderRow('trackmapDimMaskTransitionPx', 'trackmapDimMaskTransitionPx', 0, 100),

        // Playhead
        sliderRow('trackmapPlayheadGlowAlpha', 'trackmapPlayheadGlowAlpha', 0, 100),
        sliderRow('trackmapPlayheadShadowBlurPx', 'trackmapPlayheadShadowBlurPx', 0, 50),
        sliderRow('trackmapPlayheadWidthPx', 'trackmapPlayheadWidthPx', 1, 20),

        // JSON export/import sits at the very bottom of the advanced section
        {
            control: <TrackmapJsonControls />,
            description: t('setting.trackmapJsonCopy', { context: 'description' }),
            indent: true,
            isHidden: !settings.trackmapEnabled || !showAdvanced,
            title: t('setting.trackmapJsonExport'),
        },
    ];

    return <SettingsSection options={options} title={t('page.setting.trackmap')} />;
});

TrackmapSettings.displayName = 'TrackmapSettings';
