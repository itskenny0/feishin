import { useCallback, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router';

import { CommandPalettePages } from '/@/renderer/features/search/components/command';
import {
    MobileGoToPage,
    MobileSearchPalette,
    MobileServerPage,
} from '/@/renderer/features/search/components/mobile-search-palette';
import { AnimatedPage } from '/@/renderer/features/shared/components/animated-page';
import { PageErrorBoundary } from '/@/renderer/features/shared/components/page-error-boundary';
import { MOBILE_SHELL_QUERY } from '/@/renderer/hooks/use-breakpoint';
import { AppRoute } from '/@/renderer/router/routes';
import { useSettingsStore } from '/@/renderer/store';

/**
 * The command palette as a TRUE in-shell page (mobile). Mounted at `/command`
 * inside the mobile-layout `<Outlet/>`, so the bottom tab bar + mini-player
 * stay visible and the platform back gesture works — it is no longer a
 * fullscreen overlay/portal. Desktop keeps the Mod+K overlay (CommandPalette in
 * the responsive layout), so on desktop `/command` just redirects to the
 * unified results page.
 *
 * Reuses the existing mobile palette content (MobileSearchPalette / GoTo /
 * Server) and owns the page-stack + query state the overlay used to own.
 */
const CommandPaletteRoute = () => {
    const navigate = useNavigate();
    const mobileShellForce = useSettingsStore((state) => state.general.mobileShellForce);
    // Evaluate the shell SYNCHRONOUSLY (matchMedia) for the redirect decision.
    // `useMediaQuery` returns false on the first render before its effect runs,
    // which would bounce a phone visiting /command straight to /search before
    // the query settles. A synchronous read avoids that race.
    const isMobileShell = useMemo(() => {
        if (mobileShellForce) return true;
        if (typeof window === 'undefined' || !window.matchMedia) return true;
        return window.matchMedia(MOBILE_SHELL_QUERY).matches;
    }, [mobileShellForce]);
    const [pages, setPages] = useState<CommandPalettePages[]>([CommandPalettePages.HOME]);
    const [query, setQuery] = useState('');
    const searchInputRef = useRef<HTMLInputElement>(null);
    const activePage = pages[pages.length - 1];

    // Leave the palette route entirely (the down-chevron / "close").
    const leaveRoute = useCallback(() => {
        navigate(-1);
    }, [navigate]);

    // Sub-pages (Go to…/Server commands…) "close" back to the search home
    // page WITHOUT leaving the route — popping the internal page stack. (Their
    // goTo/switch handlers navigate away on their own; resetting the stack here
    // is harmless when that happens.)
    const popToHome = useCallback(() => {
        setPages([CommandPalettePages.HOME]);
    }, []);

    // Desktop has the Mod+K overlay; there is no in-shell palette page there.
    if (!isMobileShell) {
        return <Navigate replace to={AppRoute.SEARCH_INDEX} />;
    }

    return (
        <AnimatedPage>
            {activePage === CommandPalettePages.GO_TO ? (
                <MobileGoToPage handleClose={popToHome} setPages={setPages} setQuery={setQuery} />
            ) : activePage === CommandPalettePages.MANAGE_SERVERS ? (
                <MobileServerPage handleClose={popToHome} setPages={setPages} setQuery={setQuery} />
            ) : (
                <MobileSearchPalette
                    handleClose={leaveRoute}
                    onSelectResult={() => {}}
                    pages={pages}
                    query={query}
                    searchInputRef={searchInputRef}
                    setPages={setPages}
                    setQuery={setQuery}
                />
            )}
        </AnimatedPage>
    );
};

const CommandPaletteRouteWithBoundary = () => {
    return (
        <PageErrorBoundary>
            <CommandPaletteRoute />
        </PageErrorBoundary>
    );
};

export default CommandPaletteRouteWithBoundary;
