import clsx from 'clsx';

import styles from './player-bar.module.css';

import { RemoteStatusBanner } from '/@/renderer/features/jellyfin-remote-target/components/remote-status-banner';
import { Playerbar } from '/@/renderer/features/player/components/playerbar';
import { usePlayerbarOpenDrawer } from '/@/renderer/store';

export const PlayerBar = () => {
    const playerbarOpenDrawer = usePlayerbarOpenDrawer();

    return (
        <div
            className={clsx({
                [styles.container]: true,
                [styles.openDrawer]: playerbarOpenDrawer,
            })}
            id="player-bar"
        >
            <RemoteStatusBanner />
            <Playerbar />
        </div>
    );
};
