import { openConfirmModal } from '@mantine/modals';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import isElectron from 'is-electron';
import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import packageJson from '../../../package.json';

import { toast } from '/@/shared/components/toast/toast';

/**
 * Polls the fork's GitHub releases for a newer build than what's running and
 * pops a one-shot toast offering a download.
 *
 * Electron has its own electron-updater path (feed pointed at this fork);
 * Capacitor Android and web/PWA use this hook. The toast's "Install" action
 * triggers the APK download via a synthesised <a download> click, which the
 * Android WebView's download manager hands off to the system package
 * installer. On non-Android we open the release page so the user can pick
 * the right binary.
 *
 * Versions look like:
 *   - package.json after CI rewrite: "1.11.0-itskenny0-2026-05-21bb"
 *   - git tag for the same release:  "v1.11.0-itskenny0-2026.05.21bb"
 *
 * Comparison splits the version at the first `-`: the `MAJOR.MINOR.PATCH`
 * head is compared NUMERICALLY per segment (a plain string compare gets
 * `1.13.0` vs `1.9.0` wrong — `'1' < '9'` — so a genuinely newer release
 * looks older and the update is never offered), and the fork-suffix tail
 * (`itskenny0-YYYY.MM.DD-HHMM`, a zero-padded ISO date) is compared
 * lexicographically, where alphabetical and chronological order agree.
 */

const REPO = 'itskenny0/feishin';
const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DISMISSED_KEY = 'feishin-github-update-dismissed-tag';
const QUERY_KEY = ['feishin-github-releases-updater'] as const;

interface GithubRelease {
    assets: GithubReleaseAsset[];
    body: string;
    html_url: string;
    name: string;
    tag_name: string;
}

interface GithubReleaseAsset {
    browser_download_url: string;
    name: string;
}

const fetchLatestRelease = async (): Promise<GithubRelease | null> => {
    try {
        const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
            headers: { Accept: 'application/vnd.github+json' },
        });
        if (!res.ok) return null;
        return (await res.json()) as GithubRelease;
    } catch {
        return null;
    }
};

interface ParsedVersion {
    // MAJOR.MINOR.PATCH as integers.
    head: number[];
    // Everything after the first '-' (the fork suffix + ISO date), dots
    // normalised to dashes so the git-tag and package.json forms line up.
    tail: string;
}

const parseVersion = (raw: string): ParsedVersion => {
    const s = raw.replace(/^v/, '');
    const dash = s.indexOf('-');
    const headStr = dash >= 0 ? s.slice(0, dash) : s;
    const tail = dash >= 0 ? s.slice(dash + 1).replace(/\./g, '-') : '';
    const head = headStr.split('.').map((n) => Number.parseInt(n, 10) || 0);
    return { head, tail };
};

export const isNewerVersion = (latestTag: string, current: string): boolean => {
    const a = parseVersion(latestTag);
    const b = parseVersion(current);
    // MAJOR.MINOR.PATCH compared numerically per segment.
    const len = Math.max(a.head.length, b.head.length);
    for (let i = 0; i < len; i += 1) {
        const av = a.head[i] ?? 0;
        const bv = b.head[i] ?? 0;
        if (av !== bv) return av > bv;
    }
    // Equal head — fall back to the dated fork suffix (lexicographic == chrono).
    if (a.tail === b.tail) return false;
    return a.tail > b.tail;
};

const isAndroidWebView = (): boolean => {
    if (typeof navigator === 'undefined') return false;
    return /android/i.test(navigator.userAgent);
};

/**
 * Force-trigger a download for the given URL by synthesising an anchor
 * click. On Capacitor Android this hands off to the WebView's download
 * manager, which Android then routes to the system package installer for
 * .apk MIME types. On other platforms the browser handles it as a normal
 * download (or follows the link to the release page).
 */
const triggerDownload = (url: string, filename?: string): void => {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.rel = 'noopener noreferrer';
    anchor.target = '_blank';
    if (filename) anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
};

const pickDownloadTarget = (
    release: GithubRelease,
): { filename?: string; isApk: boolean; url: string } => {
    const apkAsset = release.assets.find((a) => a.name.toLowerCase().endsWith('.apk'));
    if (isAndroidWebView() && apkAsset) {
        return { filename: apkAsset.name, isApk: true, url: apkAsset.browser_download_url };
    }
    return { isApk: false, url: release.html_url };
};

const dismissTag = (tag: string) => {
    try {
        localStorage.setItem(DISMISSED_KEY, tag);
    } catch {
        // ignore
    }
};

/**
 * Hook used by the AppEffects layer: arms the background polling and pops
 * a toast when a newer release is detected.
 */
export const useGithubReleasesUpdater = () => {
    const { t } = useTranslation();
    const currentVersion = packageJson.version;
    const shownForRef = useRef<null | string>(null);

    // Skip in Vite dev mode (the bare package.json version is always older
    // than any release tag) and in Electron (electron-updater handles it).
    const isEnabled = !isElectron() && !import.meta.env.DEV;

    const { data } = useQuery({
        enabled: isEnabled,
        queryFn: fetchLatestRelease,
        queryKey: [...QUERY_KEY, currentVersion],
        refetchInterval: POLL_INTERVAL_MS,
        // Leave this off so the poll only fires while the app is foreground.
        // Capacitor Android puts the WebView into Doze when backgrounded —
        // a background refetch then both wastes battery AND racks up
        // throttled GitHub API hits that never reach the user. Foreground
        // polling at 6h intervals + the manual "Check for updates" path is
        // plenty for surfacing new releases.
        refetchIntervalInBackground: false,
        refetchOnWindowFocus: false,
        staleTime: POLL_INTERVAL_MS / 2,
    });

    useEffect(() => {
        if (!data || !isEnabled) return;
        const latestTag = data.tag_name;
        if (!isNewerVersion(latestTag, currentVersion)) return;
        if (shownForRef.current === latestTag) return;
        shownForRef.current = latestTag;
        try {
            if (localStorage.getItem(DISMISSED_KEY) === latestTag) return;
        } catch {
            // ignore
        }

        const target = pickDownloadTarget(data);

        toast.info({
            autoClose: false,
            // Stable id → a newer release REPLACES the existing toast instead of
            // stacking a second persistent one (the wrapper hides-before-show
            // for id'd toasts). Short message so the toast stays small — the long
            // version tag used to wrap to half the screen.
            id: 'github-update-available',
            message: t('common.updateAvailableBody', {
                defaultValue: target.isApk
                    ? 'A new version is available. Tap to install.'
                    : 'A new version is available. Tap to open the release page.',
            }),
            onClick: () => {
                // Confirm before downloading: tapping the toast body used to
                // launch the OS installer immediately, so a mis-tap (aiming for
                // the ✕) yanked the user out of the app. Gate it behind an
                // explicit Install/Later choice.
                openConfirmModal({
                    children: t('common.updateConfirmBody', {
                        defaultValue: target.isApk
                            ? 'Download {{tag}} and install it now? The system installer will take over.'
                            : 'Open the release page for {{tag}} in your browser?',
                        tag: latestTag,
                    }),
                    labels: {
                        cancel: t('common.later', { defaultValue: 'Later' }),
                        confirm: t('common.install', { defaultValue: 'Install' }),
                    },
                    onConfirm: () => {
                        triggerDownload(target.url, target.filename);
                        dismissTag(latestTag);
                    },
                    title: t('common.updateAvailable', { defaultValue: 'Update available' }),
                });
            },
            onClose: () => dismissTag(latestTag),
            title: t('common.updateAvailable', { defaultValue: 'Update available' }),
        });
    }, [data, currentVersion, isEnabled, t]);
};

/**
 * Imperative controls for the GitHub-releases updater. Exposed for any UI
 * surface that wants a manual "Check for updates" button (mobile drawer,
 * settings entry, etc.) — re-invalidates the cached query so the next
 * usage of `useGithubReleasesUpdater` re-fetches and the auto-toast fires
 * if there's a newer release; and exposes `installLatest` for callers that
 * want to immediately stage the most recent release for install (regardless
 * of whether it's newer than the running build — useful for "re-download
 * latest" / repair flows).
 */
export const useGithubReleasesUpdaterControls = () => {
    const queryClient = useQueryClient();
    const { t } = useTranslation();
    const currentVersion = packageJson.version;

    const checkNow = useCallback(async () => {
        toast.info({
            autoClose: 3000,
            message: t('common.checkingForUpdates', {
                defaultValue: 'Checking for updates…',
            }),
        });
        // Force a re-fetch by invalidating the cache; the
        // useGithubReleasesUpdater effect will pop the standard
        // update-available toast if a newer release shows up.
        await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
        // Look at the data we just refetched directly so we can give the
        // user clear feedback when they're already on the latest release.
        const fresh =
            queryClient.getQueryData<GithubRelease | null>([...QUERY_KEY, currentVersion]) ??
            (await fetchLatestRelease());
        if (!fresh) {
            toast.warn({
                message: t('common.updateCheckFailed', {
                    defaultValue: 'Could not reach the update server.',
                }),
            });
            return;
        }
        if (!isNewerVersion(fresh.tag_name, currentVersion)) {
            toast.success({
                message: t('common.upToDate', {
                    defaultValue: 'You are on the latest version ({{tag}}).',
                    tag: fresh.tag_name,
                }),
            });
        }
    }, [queryClient, t, currentVersion]);

    const installLatest = useCallback(async () => {
        const release = await fetchLatestRelease();
        if (!release) {
            toast.warn({
                message: t('common.updateCheckFailed', {
                    defaultValue: 'Could not reach the update server.',
                }),
            });
            return;
        }
        const target = pickDownloadTarget(release);
        triggerDownload(target.url, target.filename);
        toast.info({
            message: t('common.installStarted', {
                defaultValue: target.isApk
                    ? 'Downloading APK — the OS installer will prompt to install.'
                    : 'Opening release page in your browser.',
            }),
        });
    }, [t]);

    return { checkNow, installLatest };
};
