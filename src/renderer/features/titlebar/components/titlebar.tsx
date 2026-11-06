import styles from './titlebar.module.css';

import { WindowControls } from '/@/renderer/features/window-controls/components/window-controls';

export const Titlebar = () => {
    return (
        <div className={styles.titlebarContainer}>
            <div className={styles.right}>
                <WindowControls />
            </div>
        </div>
    );
};
