import { openContextModal } from '@mantine/modals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openSettingsModal } from '/@/renderer/features/settings/utils/open-settings-modal';

vi.mock('@mantine/modals', () => ({
    openContextModal: vi.fn(),
}));

const openContextModalMock = vi.mocked(openContextModal);

/**
 * Stub `window.matchMedia` so the mobile-shell query reports a fixed result.
 * The util samples matchMedia synchronously at open-time, so the only handle
 * a test has on the mobile/desktop branch is what matchMedia returns.
 */
const setMatchMedia = (matches: boolean) => {
    window.matchMedia = ((query: string) => ({
        addEventListener: () => {},
        addListener: () => {},
        dispatchEvent: () => false,
        matches,
        media: query,
        onchange: null,
        removeEventListener: () => {},
        removeListener: () => {},
    })) as unknown as typeof window.matchMedia;
};

describe('openSettingsModal', () => {
    const originalMatchMedia = window.matchMedia;

    beforeEach(() => {
        openContextModalMock.mockClear();
    });

    afterEach(() => {
        window.matchMedia = originalMatchMedia;
    });

    it('opens the settings context modal', () => {
        setMatchMedia(false);

        openSettingsModal();

        expect(openContextModalMock).toHaveBeenCalledTimes(1);
        expect(openContextModalMock.mock.calls[0][0]).toMatchObject({
            innerProps: {},
            modal: 'settings',
        });
    });

    it('renders a centered, sized card on non-mobile viewports', () => {
        setMatchMedia(false);

        openSettingsModal();

        const props = openContextModalMock.mock.calls[0][0];
        expect(props.fullScreen).toBe(false);
        expect(props.size).toBe('60rem');
        expect(props.transitionProps).toEqual({ transition: 'pop' });
        expect((props.styles as Record<string, object>)?.content).toMatchObject({
            height: '100%',
            maxWidth: '90%',
            width: '100%',
        });
    });

    it('renders a fullscreen sheet on mobile-shell viewports', () => {
        setMatchMedia(true);

        openSettingsModal();

        const props = openContextModalMock.mock.calls[0][0];
        expect(props.fullScreen).toBe(true);
        expect(props.size).toBe('100%');
        expect(props.transitionProps).toEqual({ transition: 'slide-up' });
        expect((props.styles as Record<string, object>)?.content).toMatchObject({
            height: '100dvh',
            maxWidth: '100%',
            width: '100%',
        });
    });

    it('treats an absent matchMedia as the non-mobile branch', () => {
        // Some hosts / very old WebViews don't expose matchMedia at all.
        window.matchMedia = undefined as unknown as typeof window.matchMedia;

        openSettingsModal();

        const props = openContextModalMock.mock.calls[0][0];
        expect(props.fullScreen).toBe(false);
        expect(props.size).toBe('60rem');
    });
});
