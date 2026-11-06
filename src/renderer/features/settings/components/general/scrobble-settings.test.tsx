import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ScrobbleSettings } from '/@/renderer/features/settings/components/general/scrobble-settings';
import { useSettingsStore } from '/@/renderer/store/settings.store';

const seedNotify = (notify: boolean) => {
    const prev = useSettingsStore.getState();
    useSettingsStore.setState({
        ...prev,
        playback: { ...prev.playback, scrobble: { ...prev.playback.scrobble, notify } },
    });
};

const stubNotification = (permission: NotificationPermission, granted: NotificationPermission) => {
    const requestPermission = vi.fn(async () => granted);
    (window as unknown as { Notification: unknown }).Notification = {
        permission,
        requestPermission,
    };
    return requestPermission;
};

const renderAndToggleNotify = () => {
    render(
        <MantineProvider>
            <ScrobbleSettings />
        </MantineProvider>,
    );
    fireEvent.click(screen.getByLabelText('Toggle notify'));
};

describe('ScrobbleSettings notify toggle', () => {
    beforeEach(() => seedNotify(false));
    afterEach(() => {
        cleanup();
        delete (window as unknown as { Notification?: unknown }).Notification;
        seedNotify(false);
    });

    it('persists notify=true after the permission prompt is granted', async () => {
        const requestPermission = stubNotification('default', 'granted');
        renderAndToggleNotify();

        await waitFor(() => expect(requestPermission).toHaveBeenCalled());
        await waitFor(() =>
            expect(useSettingsStore.getState().playback.scrobble.notify).toBe(true),
        );
    });

    it('leaves the switch off when the permission prompt is declined', async () => {
        stubNotification('default', 'denied');
        renderAndToggleNotify();

        await waitFor(() =>
            expect(screen.getByLabelText<HTMLInputElement>('Toggle notify').checked).toBe(false),
        );
        expect(useSettingsStore.getState().playback.scrobble.notify).toBe(false);
    });

    it('lets the user turn notify off even when permission was revoked', async () => {
        seedNotify(true);
        const requestPermission = stubNotification('denied', 'denied');
        renderAndToggleNotify();

        await waitFor(() =>
            expect(useSettingsStore.getState().playback.scrobble.notify).toBe(false),
        );
        expect(requestPermission).not.toHaveBeenCalled();
    });
});
