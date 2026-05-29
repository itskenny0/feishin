import { useMemo } from 'react';

import { usePlayer } from '/@/renderer/features/player/context/player-context';
import { HotkeyItem, useHotkeys } from '/@/renderer/hooks/use-hotkeys';
import { useHotkeySettings } from '/@/renderer/store';

export const usePlaybackHotkeys = () => {
    const { bindings } = useHotkeySettings();
    // Go through PlayerContext (not usePlayerActions directly) so hotkeys are
    // routed through the same remote/local branching the on-screen buttons
    // use. Otherwise Space / N / P drive the local mpv engine even when a
    // Jellyfin Connect target is selected.
    const player = usePlayer();

    const playbackHotkeysItems = useMemo(() => {
        const hotkeyItems: HotkeyItem[] = [];

        const bindingHandlers: Array<{
            binding: (typeof bindings)[keyof typeof bindings];
            handler: () => void;
        }> = [
            { binding: bindings.next, handler: () => player.mediaNext() },
            { binding: bindings.pause, handler: () => player.mediaPause() },
            { binding: bindings.play, handler: () => player.mediaPlay() },
            { binding: bindings.playPause, handler: () => player.mediaTogglePlayPause() },
            { binding: bindings.previous, handler: () => player.mediaPrevious() },
            { binding: bindings.skipBackward, handler: () => player.mediaSkipBackward() },
            { binding: bindings.skipForward, handler: () => player.mediaSkipForward() },
            { binding: bindings.stop, handler: () => player.mediaStop() },
            { binding: bindings.toggleRepeat, handler: () => player.toggleRepeat() },
            { binding: bindings.toggleShuffle, handler: () => player.toggleShuffle() },
        ];

        // Filter and map to hotkey items
        bindingHandlers.forEach(({ binding, handler }) => {
            if (!binding.isGlobal && binding.hotkey && binding.hotkey !== '') {
                hotkeyItems.push([binding.hotkey, handler]);
            }
        });

        return hotkeyItems;
    }, [bindings, player]);

    useHotkeys(playbackHotkeysItems);
};

export const PlaybackHotkeysHook = () => {
    usePlaybackHotkeys();
    return null;
};
