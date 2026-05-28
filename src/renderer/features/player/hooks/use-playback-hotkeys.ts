import { useMemo } from 'react';

import { HotkeyItem, useHotkeys } from '/@/renderer/hooks/use-hotkeys';
import { useHotkeySettings, usePlayerActions } from '/@/renderer/store';

export const usePlaybackHotkeys = () => {
    const { bindings } = useHotkeySettings();
    // Leaf subscription: only the action references matter. Previously this
    // hook subscribed to the *entire* player store, so every timestamp tick
    // / queue mutation / volume change rebuilt the hotkey items array and
    // re-registered the global keydown handler.
    const player = usePlayerActions();

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
