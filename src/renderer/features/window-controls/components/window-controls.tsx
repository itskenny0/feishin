import clsx from 'clsx';
import isElectron from 'is-electron';
import { useCallback, useState } from 'react';
import {
    RiCheckboxBlankLine,
    RiCheckboxMultipleBlankLine,
    RiCloseLine,
    RiSubtractLine,
} from 'react-icons/ri';

import styles from './window-controls.module.css';

const browser = isElectron() ? window.api.browser : null;

export const WindowControls = () => {
    const [max, setMax] = useState(false);

    const handleMinimize = useCallback(() => {
        browser?.minimize();
    }, []);

    const handleMaximize = useCallback(() => {
        // The maximize state is tracked locally because the main process does
        // not emit maximize/unmaximize events back to the renderer. This stays
        // in sync as long as the user toggles via these controls; OS-level
        // shortcuts or titlebar double-clicks can desync it, in which case the
        // next click simply corrects course.
        setMax((prev) => {
            if (prev) {
                browser?.unmaximize();
            } else {
                browser?.maximize();
            }
            return !prev;
        });
    }, []);

    const handleClose = useCallback(() => {
        browser?.exit();
    }, []);

    if (!isElectron()) {
        return null;
    }

    return (
        <div className={styles.windowsButtonGroup}>
            <button
                aria-label="Minimize window"
                className={styles.windowsButton}
                onClick={handleMinimize}
                tabIndex={-1}
                type="button"
            >
                <RiSubtractLine size={18} />
            </button>
            <button
                aria-label={max ? 'Restore window' : 'Maximize window'}
                className={styles.windowsButton}
                onClick={handleMaximize}
                tabIndex={-1}
                type="button"
            >
                {max ? (
                    <RiCheckboxMultipleBlankLine size={12} />
                ) : (
                    <RiCheckboxBlankLine size={13} />
                )}
            </button>
            <button
                aria-label="Close window"
                className={clsx(styles.windowsButton, styles.exitButton)}
                onClick={handleClose}
                tabIndex={-1}
                type="button"
            >
                <RiCloseLine size={18} />
            </button>
        </div>
    );
};
