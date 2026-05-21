import { SettingsLayout } from '/@/renderer/features/settings/components/settings-layout';

/**
 * Wrapper kept for the existing import in settings-route.tsx. All real
 * structure now lives in `SettingsLayout` (the Android-Settings-style
 * two-pane / drill-down rewrite of what used to be a horizontal Tabs).
 *
 * Wraps SettingsLayout in a min-height: 0 flex-grow container so the
 * layout fills the route's vertical space exactly once (the route's
 * outer LibraryContainer + Flex already provides bounded height) and
 * the sidebar's own overflow-y: auto takes over for scrolling - without
 * this the layout's height: 100% collapses to its content's natural
 * height and the outer main-content ends up scrolling, dragging the
 * sidebar along with the content.
 */
export const SettingsContent = () => {
    return (
        <div style={{ display: 'flex', flex: 1, minHeight: 0, width: '100%' }}>
            <SettingsLayout />
        </div>
    );
};
