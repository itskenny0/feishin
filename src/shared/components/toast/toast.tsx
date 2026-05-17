import type { NotificationData } from '@mantine/notifications';

import {
    cleanNotifications,
    cleanNotificationsQueue,
    hideNotification,
    notifications,
    updateNotification,
} from '@mantine/notifications';
import clsx from 'clsx';
import { t } from 'i18next';

import styles from './toast.module.css';

interface NotificationProps extends Omit<NotificationData, 'message'> {
    message?: string;
    onClose?: () => void;
    type?: 'error' | 'info' | 'success' | 'warning';
}

const getTitle = (type: NotificationProps['type']) => {
    if (type === 'success') return t('common.success', { defaultValue: 'Success' });
    if (type === 'warning') return t('common.warning', { defaultValue: 'Warning' });
    if (type === 'error') return t('common.error', { defaultValue: 'Error' });
    return t('common.info', { defaultValue: 'Info' });
};

// Dedupe identical toast bodies within a short window. A flaky endpoint can
// otherwise stack a dozen of the same "Failed to fetch" toasts because the
// global react-query onError fires per failed query. We key by
// `${type}::${message}` so a success and an error with the same body still
// both show.
const RECENT_TOAST_TTL_MS = 5_000;
const recentToasts = new Map<string, number>();

const isDuplicate = (key: string): boolean => {
    const now = Date.now();
    // Lazy cleanup: drop expired entries on each lookup so the map doesn't
    // grow forever on long-running sessions.
    for (const [k, ts] of recentToasts) {
        if (now - ts > RECENT_TOAST_TTL_MS) recentToasts.delete(k);
    }
    const last = recentToasts.get(key);
    if (last !== undefined && now - last < RECENT_TOAST_TTL_MS) return true;
    recentToasts.set(key, now);
    return false;
};

const showToast = ({ message, onClose, type, ...props }: NotificationProps) => {
    if (message && isDuplicate(`${type ?? 'info'}::${message}`)) return undefined;
    return notifications.show({
        ...props,
        classNames: {
            body: styles.body,
            closeButton: styles.closeButton,
            description: styles.description,
            loader: styles.loader,
            root: clsx(styles.root, {
                [styles.error]: type === 'error',
                [styles.info]: type === 'info',
                [styles.success]: type === 'success',
                [styles.warning]: type === 'warning',
            }),
            title: styles.title,
        },
        message: message ?? '',
        onClose,
        title: getTitle(type),
        withBorder: true,
        withCloseButton: true,
    });
};

export const toast = {
    clean: cleanNotifications,
    cleanQueue: cleanNotificationsQueue,
    error: (props: NotificationProps) => showToast({ type: 'error', ...props }),
    hide: hideNotification,
    info: (props: NotificationProps) => showToast({ type: 'info', ...props }),
    show: showToast,
    success: (props: NotificationProps) => showToast({ type: 'success', ...props }),
    update: updateNotification,
    warn: (props: NotificationProps) => showToast({ type: 'warning', ...props }),
};
