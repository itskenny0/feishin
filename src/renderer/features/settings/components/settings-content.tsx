import { SettingsLayout } from '/@/renderer/features/settings/components/settings-layout';
import { LibraryContainer } from '/@/renderer/features/shared/components/library-container';

/**
 * Wrapper kept for the existing import in settings-route.tsx. All real
 * structure now lives in `SettingsLayout` (the Android-Settings-style
 * two-pane / drill-down rewrite of what used to be a horizontal Tabs).
 */
export const SettingsContent = () => {
    return (
        <LibraryContainer>
            <SettingsLayout />
        </LibraryContainer>
    );
};
