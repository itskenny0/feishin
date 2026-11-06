import type { KeyboardEvent } from 'react';

/**
 * onKeyDown for a non-button element with role="button": Enter and Space run
 * the handler the way they would on a real <button> (Space without scrolling).
 */
export const onActivationKey = (handler: () => void) => (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        handler();
    }
};
