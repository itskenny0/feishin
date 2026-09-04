import isElectron from 'is-electron';
import React, { useCallback, useEffect } from 'react';

import { usePlayerStatus, useSettingsStore, useWindowSettings } from '/@/renderer/store';
import { logger } from '/@/renderer/utils/logger';
import { PlayerStatus } from '/@/shared/types/types';

const utils = isElectron() ? window.api.utils : null;

export const usePowerSaveBlocker = () => {
    const status = usePlayerStatus();
    const { preventSleepOnPlayback, preventSuspendOnPlayback } = useWindowSettings();

    const startPowerSaveBlocker = useCallback(async () => {
        if (!utils) return;

        try {
            // `full=true` maps to 'prevent-display-sleep' (covers app suspension
            // too); `full=false` maps to 'prevent-app-suspension'. If the user
            // only enabled display-sleep prevention, pass full=true; otherwise
            // fall back to the lighter app-suspension blocker.
            await utils.startPowerSaveBlocker(preventSleepOnPlayback);
        } catch (error) {
            logger.error('Failed to start power save blocker:', error);
        }
    }, [preventSleepOnPlayback]);

    const stopPowerSaveBlocker = useCallback(async () => {
        if (!utils) return;

        try {
            await utils.stopPowerSaveBlocker();
        } catch (error) {
            logger.error('Failed to stop power save blocker:', error);
        }
    }, []);

    useEffect(() => {
        // Either setting on its own should keep the system awake during
        // playback. Previously this AND-gated the two, so anyone who turned
        // only one of them on got no blocker at all.
        if (!preventSleepOnPlayback && !preventSuspendOnPlayback) return;

        if (status === PlayerStatus.PLAYING) {
            logger.info('Playback started - starting power save blocker');
            startPowerSaveBlocker();
        } else {
            logger.info('Playback stopped - stopping power save blocker');
            stopPowerSaveBlocker();
        }
    }, [
        status,
        preventSleepOnPlayback,
        startPowerSaveBlocker,
        stopPowerSaveBlocker,
        preventSuspendOnPlayback,
    ]);

    useEffect(() => {
        return () => {
            stopPowerSaveBlocker();
        };
    }, [stopPowerSaveBlocker]);
};

const PowerSaveBlockerHookInner = () => {
    usePowerSaveBlocker();
    return null;
};

export const PowerSaveBlockerHook = () => {
    const isElectronEnv = isElectron();
    const preventSleepOnPlayback = useSettingsStore((state) => state.window.preventSleepOnPlayback);
    const preventSuspendOnPlayback = useSettingsStore(
        (state) => state.window.preventSuspendOnPlayback,
    );

    if (!isElectronEnv || (!preventSleepOnPlayback && !preventSuspendOnPlayback)) {
        return null;
    }

    return React.createElement(PowerSaveBlockerHookInner);
};
