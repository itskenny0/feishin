import { beforeEach, describe, expect, it, vi } from 'vitest';

const { show } = vi.hoisted(() => ({ show: vi.fn() }));

vi.mock('@mantine/notifications', () => ({
    cleanNotifications: vi.fn(),
    cleanNotificationsQueue: vi.fn(),
    hideNotification: vi.fn(),
    notifications: { show },
    updateNotification: vi.fn(),
}));
vi.mock('i18next', () => ({
    t: (_key: string, options: { defaultValue: string }) => options.defaultValue,
}));

import { toast } from '/@/shared/components/toast/toast';

beforeEach(() => show.mockClear());

describe('toast', () => {
    it('keeps a caller-supplied title', () => {
        toast.info({ message: 'Private mode on', title: 'Private Mode' });
        expect(show.mock.calls[0][0].title).toBe('Private Mode');
    });

    it('falls back to the type title', () => {
        toast.error({ message: 'Something broke' });
        expect(show.mock.calls[0][0].title).toBe('Error');
    });
});
