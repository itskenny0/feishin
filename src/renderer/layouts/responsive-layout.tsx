import { openContextModal } from '@mantine/modals';
import isElectron from 'is-electron';
import { lazy, Suspense, useCallback, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

// Lazy-load the command palette: it is mounted by the always-on layout but
// only ever rendered/opened on demand, so deferring its import keeps its
// (and fuse.js's) graph out of the first-paint entry chunk.
const CommandPalette = lazy(() =>
    import('/@/renderer/features/search/components/command-palette').then((m) => ({
        default: m.CommandPalette,
    })),
);
import { useGarbageCollection } from '/@/renderer/hooks/use-garbage-collection';
import { HotkeyItem, useHotkeys } from '/@/renderer/hooks/use-hotkeys';
import { useIsMobile } from '/@/renderer/hooks/use-is-mobile';
import { DefaultLayout } from '/@/renderer/layouts/default-layout';
import { MobileLayout } from '/@/renderer/layouts/mobile-layout/mobile-layout';
import { AppRoute } from '/@/renderer/router/routes';
import {
    useCommandPaletteState,
    useLayoutHotkeyBindings,
    useSettingsStoreActions,
    useZoomFactor,
} from '/@/renderer/store';

interface ResponsiveLayoutProps {
    shell?: boolean;
}

const ResponsiveLayoutBase = ({ shell }: ResponsiveLayoutProps) => {
    const isMobile = useIsMobile();

    if (isMobile) {
        return <MobileLayout shell={shell} />;
    }

    return <DefaultLayout shell={shell} />;
};

export const ResponsiveLayout = ({ shell }: ResponsiveLayoutProps) => {
    return (
        <>
            <ResponsiveLayoutBase shell={shell} />
            <LayoutHotkeys />
            <GarbageCollection />
        </>
    );
};

const localSettings = isElectron() ? window.api.localSettings : null;

const LayoutHotkeys = () => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const zoomFactor = useZoomFactor();
    const { setSettings } = useSettingsStoreActions();
    const bindings = useLayoutHotkeyBindings();
    const { close, open, opened, toggle } = useCommandPaletteState();

    const handlers = useMemo(
        () => ({
            close,
            open,
            toggle,
        }),
        [close, open, toggle],
    );

    const updateZoom = useCallback(
        (increase: number) => {
            const newVal = zoomFactor + increase;
            if (newVal > 300 || newVal < 50 || !localSettings) return;

            setSettings({
                general: {
                    zoomFactor: newVal,
                },
            });
            localSettings?.setZoomFactor(newVal);
        },
        [setSettings, zoomFactor],
    );

    useEffect(() => {
        if (localSettings) {
            localSettings?.setZoomFactor(zoomFactor);
        }
    }, [zoomFactor]);

    const openShortcutsHelp = useCallback(() => {
        openContextModal({
            innerProps: {},
            modal: 'shortcutsHelp',
            size: 'md',
            title: t('shortcuts.title', { defaultValue: 'Keyboard shortcuts' }),
        });
    }, [t]);

    const hotkeys = useMemo<HotkeyItem[]>(
        () => [
            [bindings.globalSearch.hotkey, open],
            [bindings.browserBack.hotkey, () => navigate(-1)],
            [bindings.browserForward.hotkey, () => navigate(1)],
            [bindings.navigateHome.hotkey, () => navigate(AppRoute.HOME)],
            // "?" key opens a help overlay listing every bound shortcut.
            // Uses physical-key matching so it works regardless of layout:
            // shift+slash on QWERTY produces "?", but the parser keys off
            // the physical Slash code so non-US keyboards still work.
            ['shift+slash', openShortcutsHelp, { preventDefault: true, usePhysicalKeys: true }],
            ...(localSettings
                ? ([
                      [bindings.zoomIn.hotkey, () => updateZoom(5)],
                      [bindings.zoomOut.hotkey, () => updateZoom(-5)],
                  ] as HotkeyItem[])
                : []),
        ],
        [bindings, navigate, open, openShortcutsHelp, updateZoom],
    );

    const modalProps = useMemo(
        () => ({
            handlers,
            opened,
        }),
        [handlers, opened],
    );

    useHotkeys(hotkeys);

    return (
        <Suspense fallback={null}>
            <CommandPalette modalProps={modalProps} />
        </Suspense>
    );
};

const GarbageCollection = () => {
    useGarbageCollection();
    return null;
};
