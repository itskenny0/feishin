import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import styles from './feature-card-picker.module.css';

import { FeatureCardVariant } from '/@/renderer/features/home/components/feature-card/feature-card';
import { useHomeFeatureContent, useSettingsStoreActions } from '/@/renderer/store/settings.store';
import { Select } from '/@/shared/components/select/select';

/**
 * A small inline picker that lets the user switch the feature-card variant on
 * the fly without going into Settings. Writes directly to the same setting,
 * so changes here persist for next visit.
 */
export const FeatureCardPicker = () => {
    const { t } = useTranslation();
    const value = useHomeFeatureContent();
    const { setSettings } = useSettingsStoreActions();

    const options = useMemo<{ label: string; value: FeatureCardVariant }[]>(
        () => [
            { label: t('page.home.featureVariant_artist'), value: 'artist' },
            { label: t('page.home.featureVariant_genre'), value: 'genre' },
            { label: t('page.home.featureVariant_recentlyPlayed'), value: 'recentlyPlayed' },
            { label: t('page.home.featureVariant_topPlayed'), value: 'topPlayed' },
            { label: t('page.home.featureVariant_favorites'), value: 'favorites' },
            { label: t('page.home.featureVariant_unplayed'), value: 'unplayed' },
            {
                label: t('page.home.featureVariant_forgottenFavorites'),
                value: 'forgottenFavorites',
            },
            { label: t('page.home.featureVariant_timeMachine'), value: 'timeMachine' },
            { label: t('page.home.featureVariant_decade'), value: 'decade' },
            { label: t('page.home.featureVariant_albumOfTheDay'), value: 'albumOfTheDay' },
            { label: t('page.home.featureVariant_album'), value: 'album' },
            { label: t('page.home.featureVariant_surpriseMe'), value: 'surpriseMe' },
        ],
        [t],
    );

    return (
        <div className={styles.pickerRow}>
            <span className={styles.pickerLabel}>{t('page.home.featurePicker_label')}</span>
            <Select
                allowDeselect={false}
                className={styles.pickerSelect}
                data={options}
                onChange={(next) => {
                    if (!next) return;
                    setSettings({
                        general: {
                            homeFeatureContent: next as FeatureCardVariant,
                        },
                    });
                }}
                size="xs"
                value={value}
            />
        </div>
    );
};
