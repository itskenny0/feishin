import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useIsMobileShell } from '/@/renderer/hooks/use-breakpoint';
import { useHotkeyBindings } from '/@/renderer/store/settings.store';
import { Divider } from '/@/shared/components/divider/divider';
import { Group } from '/@/shared/components/group/group';
import { Icon } from '/@/shared/components/icon/icon';
import { Kbd } from '/@/shared/components/kbd/kbd';
import { ScrollArea } from '/@/shared/components/scroll-area/scroll-area';
import { Stack } from '/@/shared/components/stack/stack';
import { TextInput } from '/@/shared/components/text-input/text-input';
import { Text } from '/@/shared/components/text/text';

// Mapping from the binding key in the store to the i18n context used by
// the existing hotkey settings page (see hotkey-manager-settings.tsx).
// Reusing the same labels means translators only have one place to keep
// up to date — and the modal labels match what users see in Settings.
const BINDING_LABEL_CONTEXT: Record<string, string> = {
    browserBack: 'browserBack',
    browserForward: 'browserForward',
    favoriteCurrentAdd: 'favoriteCurrentSong',
    favoriteCurrentRemove: 'unfavoriteCurrentSong',
    favoriteCurrentToggle: 'toggleCurrentSongFavorite',
    favoritePreviousAdd: 'favoritePreviousSong',
    favoritePreviousRemove: 'unfavoritePreviousSong',
    favoritePreviousToggle: 'togglePreviousSongFavorite',
    globalSearch: 'globalSearch',
    listNavigateToPage: 'listNavigateToPage',
    listPlayDefault: 'listPlayDefault',
    listPlayLast: 'listPlayLast',
    listPlayNext: 'listPlayNext',
    listPlayNow: 'listPlayNow',
    listShowPlayingSong: 'listShowPlayingSong',
    localSearch: 'localSearch',
    navigateHome: 'navigateHome',
    next: 'playbackNext',
    pause: 'playbackPause',
    play: 'playbackPlay',
    playPause: 'playbackPlayPause',
    previous: 'playbackPrevious',
    rate0: 'rate0',
    rate1: 'rate1',
    rate2: 'rate2',
    rate3: 'rate3',
    rate4: 'rate4',
    rate5: 'rate5',
    skipBackward: 'skipBackward',
    skipForward: 'skipForward',
    stop: 'playbackStop',
    toggleFullscreenPlayer: 'toggleFullScreenPlayer',
    toggleQueue: 'toggleQueue',
    toggleRepeat: 'toggleRepeat',
    toggleShuffle: 'toggleShuffle',
    volumeDown: 'volumeDown',
    volumeMute: 'volumeMute',
    volumeUp: 'volumeUp',
    zoomIn: 'zoomIn',
    zoomOut: 'zoomOut',
};

// Ordered list of categories. Each binding is assigned to exactly one
// category; anything not listed here falls through to "other". Grouping
// makes the (otherwise long, flat) list scannable — users find "volume"
// under Playback instead of hunting an alphabetical wall of rows.
type CategoryKey = 'favorites' | 'lists' | 'navigation' | 'other' | 'playback' | 'rating' | 'view';

const CATEGORY_ORDER: CategoryKey[] = [
    'playback',
    'navigation',
    'lists',
    'favorites',
    'rating',
    'view',
    'other',
];

const CATEGORY_LABEL_KEY: Record<CategoryKey, string> = {
    favorites: 'shortcuts.categoryFavorites',
    lists: 'shortcuts.categoryLists',
    navigation: 'shortcuts.categoryNavigation',
    other: 'shortcuts.categoryOther',
    playback: 'shortcuts.categoryPlayback',
    rating: 'shortcuts.categoryRating',
    view: 'shortcuts.categoryView',
};

const CATEGORY_LABEL_FALLBACK: Record<CategoryKey, string> = {
    favorites: 'Favorites',
    lists: 'Lists',
    navigation: 'Navigation',
    other: 'Other',
    playback: 'Playback',
    rating: 'Rating',
    view: 'View',
};

const BINDING_CATEGORY: Record<string, CategoryKey> = {
    browserBack: 'navigation',
    browserForward: 'navigation',
    favoriteCurrentAdd: 'favorites',
    favoriteCurrentRemove: 'favorites',
    favoriteCurrentToggle: 'favorites',
    favoritePreviousAdd: 'favorites',
    favoritePreviousRemove: 'favorites',
    favoritePreviousToggle: 'favorites',
    globalSearch: 'navigation',
    listNavigateToPage: 'lists',
    listPlayDefault: 'lists',
    listPlayLast: 'lists',
    listPlayNext: 'lists',
    listPlayNow: 'lists',
    listShowPlayingSong: 'lists',
    localSearch: 'navigation',
    navigateHome: 'navigation',
    next: 'playback',
    pause: 'playback',
    play: 'playback',
    playPause: 'playback',
    previous: 'playback',
    rate0: 'rating',
    rate1: 'rating',
    rate2: 'rating',
    rate3: 'rating',
    rate4: 'rating',
    rate5: 'rating',
    skipBackward: 'playback',
    skipForward: 'playback',
    stop: 'playback',
    toggleFullscreenPlayer: 'view',
    toggleQueue: 'view',
    toggleRepeat: 'playback',
    toggleShuffle: 'playback',
    volumeDown: 'playback',
    volumeMute: 'playback',
    volumeUp: 'playback',
    zoomIn: 'view',
    zoomOut: 'view',
};

// Render a hotkey string like "mod+shift+k" as a row of <Kbd> chips
// separated by "+" so each key reads as its own visual unit.
const HotkeyChips = ({ hotkey }: { hotkey: string }) => {
    const parts = hotkey
        .split('+')
        .map((part) => part.trim())
        .filter(Boolean);

    return (
        <Group gap={4} wrap="nowrap">
            {parts.map((part, index) => (
                <Group gap={4} key={`${part}-${index}`} wrap="nowrap">
                    {index > 0 && (
                        <Text isMuted size="sm">
                            +
                        </Text>
                    )}
                    <Kbd>{part}</Kbd>
                </Group>
            ))}
        </Group>
    );
};

interface ShortcutEntry {
    category: CategoryKey;
    hotkey: string;
    label: string;
    name: string;
}

export const ShortcutsHelpContextModal = () => {
    const { t } = useTranslation();
    const bindings = useHotkeyBindings();
    const isMobile = useIsMobileShell();
    const [query, setQuery] = useState('');

    const entries = useMemo<ShortcutEntry[]>(() => {
        return Object.entries(bindings)
            .filter(([, binding]) => Boolean(binding?.hotkey?.trim()))
            .map(([name, binding]) => {
                const context = BINDING_LABEL_CONTEXT[name];
                const label = context ? t('setting.hotkey', { context, defaultValue: name }) : name;
                return {
                    category: BINDING_CATEGORY[name] ?? 'other',
                    hotkey: binding.hotkey,
                    label,
                    name,
                };
            })
            .sort((a, b) => a.label.localeCompare(b.label));
    }, [bindings, t]);

    const normalizedQuery = query.trim().toLocaleLowerCase();

    const groups = useMemo(() => {
        const filtered = normalizedQuery
            ? entries.filter(
                  (entry) =>
                      entry.label.toLocaleLowerCase().includes(normalizedQuery) ||
                      entry.hotkey.toLocaleLowerCase().includes(normalizedQuery),
              )
            : entries;

        return CATEGORY_ORDER.map((category) => ({
            category,
            items: filtered.filter((entry) => entry.category === category),
        })).filter((group) => group.items.length > 0);
    }, [entries, normalizedQuery]);

    if (entries.length === 0) {
        return (
            <Stack gap="md">
                <Text isMuted>
                    {t('shortcuts.noneBound', {
                        defaultValue:
                            'No keyboard shortcuts are currently bound. Configure them in Settings.',
                    })}
                </Text>
            </Stack>
        );
    }

    return (
        <Stack gap="sm">
            {isMobile && (
                <Group
                    align="center"
                    gap="xs"
                    style={{
                        backgroundColor: 'var(--theme-colors-surface)',
                        borderRadius: 'var(--theme-radius-md, 8px)',
                        padding: '8px 12px',
                    }}
                    wrap="nowrap"
                >
                    <Icon icon="info" />
                    <Text isMuted size="sm">
                        {t('shortcuts.touchNote', {
                            defaultValue: 'These shortcuts apply to a connected physical keyboard.',
                        })}
                    </Text>
                </Group>
            )}
            <TextInput
                aria-label={t('shortcuts.searchPlaceholder', { defaultValue: 'Search shortcuts' })}
                autoFocus={!isMobile}
                leftSection={<Icon icon="search" />}
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder={t('shortcuts.searchPlaceholder', {
                    defaultValue: 'Search shortcuts',
                })}
                value={query}
            />
            <ScrollArea style={{ maxHeight: '60vh' }}>
                <Stack gap="lg" style={{ paddingRight: 8 }}>
                    {groups.length === 0 ? (
                        <Text isMuted size="sm">
                            {t('shortcuts.noResults', {
                                defaultValue: 'No shortcuts match "{{query}}".',
                                query: query.trim(),
                            })}
                        </Text>
                    ) : (
                        groups.map(({ category, items }) => (
                            <Stack gap="xs" key={category}>
                                <Divider
                                    label={t(CATEGORY_LABEL_KEY[category], {
                                        defaultValue: CATEGORY_LABEL_FALLBACK[category],
                                    })}
                                    labelPosition="left"
                                />
                                {items.map(({ hotkey, label, name }) => (
                                    <Group justify="space-between" key={name} wrap="nowrap">
                                        <Text size="sm" style={{ flex: '1 1 auto', minWidth: 0 }}>
                                            {label}
                                        </Text>
                                        <HotkeyChips hotkey={hotkey} />
                                    </Group>
                                ))}
                            </Stack>
                        ))
                    )}
                </Stack>
            </ScrollArea>
        </Stack>
    );
};
