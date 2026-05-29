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
 * The CI's `sanitizedSuffix` step converts every fork-suffix dot to a dash.
 * `normalizeVersion` mirrors that conversion (only on the part after
 * `-itskenny0`) so the two forms line up under plain lexicographic
 * comparison. The ISO date inside the suffix means alphabetical sort and
 * chronological sort agree.
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

const normalizeVersion = (raw: string): string => {
    let s = raw.replace(/^v/, '');
    const suffixIdx = s.indexOf('-itskenny0');
    if (suffixIdx >= 0) {
        const head = s.slice(0, suffixIdx);
        const tail = s.slice(suffixIdx).replace(/\./g, '-');
        s = head + tail;
    }
    return s;
};

const isNewerVersion = (latestTag: string, current: string): boolean => {
    const a = normalizeVersion(latestTag);
    const b = normalizeVersion(current);
    if (a === b) return false;
    return a > b;
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
            message: t('common.updateAvailableBody', {
                defaultValue: target.isApk
                    ? 'Version {{tag}} is available. Tap to download — the OS installer will take over.'
                    : 'Version {{tag}} is available. Tap to open the release page.',
                tag: latestTag,
            }),
            onClick: () => {
                triggerDownload(target.url, target.filename);
                dismissTag(latestTag);
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
