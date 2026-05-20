import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useHotkeyBindings } from '/@/renderer/store/settings.store';
import { Group } from '/@/shared/components/group/group';
import { Kbd } from '/@/shared/components/kbd/kbd';
import { ScrollArea } from '/@/shared/components/scroll-area/scroll-area';
import { Stack } from '/@/shared/components/stack/stack';
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

export const ShortcutsHelpContextModal = () => {
    const { t } = useTranslation();
    const bindings = useHotkeyBindings();

    const entries = useMemo(() => {
        return Object.entries(bindings)
            .filter(([, binding]) => Boolean(binding?.hotkey?.trim()))
            .map(([name, binding]) => {
                const context = BINDING_LABEL_CONTEXT[name];
                const label = context ? t('setting.hotkey', { context, defaultValue: name }) : name;
                return {
                    hotkey: binding.hotkey,
                    label,
                    name,
                };
            })
            .sort((a, b) => a.label.localeCompare(b.label));
    }, [bindings, t]);

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
        <ScrollArea style={{ maxHeight: '60vh' }}>
            <Stack gap="xs" style={{ paddingRight: 8 }}>
                {entries.map(({ hotkey, label, name }) => (
                    <Group justify="space-between" key={name} wrap="nowrap">
                        <Text size="sm" style={{ flex: '1 1 auto', minWidth: 0 }}>
                            {label}
                        </Text>
                        <HotkeyChips hotkey={hotkey} />
                    </Group>
                ))}
            </Stack>
        </ScrollArea>
    );
};
