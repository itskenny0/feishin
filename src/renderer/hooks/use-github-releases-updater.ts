import { useQuery } from '@tanstack/react-query';
import isElectron from 'is-electron';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import packageJson from '../../../package.json';

import { toast } from '/@/shared/components/toast/toast';

/**
 * Polls the fork's GitHub releases for a newer build than what's running and
 * pops a one-shot toast offering a download.
 *
 * On Electron, the platform's electron-updater handles updates natively
 * (the feed URL in src/main/index.ts now points at this fork), so this
 * hook is a no-op there. On Capacitor Android and on web/PWA, this is the
 * only update path — the toast's CTA opens the release page (or the APK
 * asset URL directly on Android) and the OS browser takes it from there.
 *
 * Versions look like:
 *   - package.json after CI rewrite: "1.11.0-itskenny0-2026-05-20q"
 *   - git tag for the same release:  "v1.11.0-itskenny0-2026.05.20q"
 *
 * The fork-suffix dots vs dashes is the CI's `sanitizedSuffix` translation.
 * `normalizeVersion` strips the 'v' prefix and converts the suffix dots to
 * dashes so the two forms line up under plain lexicographic comparison —
 * the ISO date in the suffix means alphabetical sort matches chronological.
 */

const REPO = 'itskenny0/feishin';
const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DISMISSED_KEY = 'feishin-github-update-dismissed-tag';

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
        // Network down, CORS, blocked — we just don't show the toast.
        return null;
    }
};

const normalizeVersion = (raw: string): string => {
    // Strip the 'v' prefix off git tags ("v1.11.0-..." → "1.11.0-...").
    let s = raw.replace(/^v/, '');
    // Find the start of the fork suffix and convert every dot inside it
    // to a dash, since CI converts those when it rewrites package.json
    // (sanitizedSuffix=${rawSuffix//./-}). The baseline "1.11.0" before
    // the suffix MUST stay intact - earlier versions of this function
    // greedily replaced the last dot anywhere in the string, which
    // mangled the baseline ("1.11.0" → "1.11-0") on already-normalized
    // current versions and caused a false-positive update toast.
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

export const useGithubReleasesUpdater = () => {
    const { t } = useTranslation();
    const currentVersion = packageJson.version;
    const shownForRef = useRef<null | string>(null);

    // Electron has its own native updater path; web + Capacitor don't, so
    // this hook only runs in the latter. Also skip in Vite dev mode so the
    // toast doesn't pop on every `pnpm dev` session — dev's package.json
    // version is the bare "1.11.0" baseline which is always older than any
    // release tag and would trigger the prompt continuously.
    const isEnabled = !isElectron() && !import.meta.env.DEV;

    const { data } = useQuery({
        enabled: isEnabled,
        queryFn: fetchLatestRelease,
        queryKey: ['feishin-github-releases-updater', currentVersion],
        refetchInterval: POLL_INTERVAL_MS,
        refetchIntervalInBackground: true,
        refetchOnWindowFocus: false,
        staleTime: POLL_INTERVAL_MS / 2,
    });

    useEffect(() => {
        if (!data || !isEnabled) return;
        const latestTag = data.tag_name;
        if (!isNewerVersion(latestTag, currentVersion)) return;

        // Don't re-toast the same release on every render.
        if (shownForRef.current === latestTag) return;
        shownForRef.current = latestTag;

        // Don't re-toast a release the user has already dismissed.
        try {
            if (localStorage.getItem(DISMISSED_KEY) === latestTag) return;
        } catch {
            // localStorage blocked (private mode / quota) — fall through.
        }

        const apkAsset = data.assets.find((asset) => asset.name.toLowerCase().endsWith('.apk'));
        // On Android, opening the .apk asset URL in the system browser
        // triggers the OS package-installer prompt directly. On every
        // other platform, the release page is the safer landing spot
        // (users can pick the right binary themselves).
        const downloadUrl =
            isAndroidWebView() && apkAsset ? apkAsset.browser_download_url : data.html_url;

        const dismiss = () => {
            try {
                localStorage.setItem(DISMISSED_KEY, latestTag);
            } catch {
                // ignore
            }
        };

        toast.info({
            autoClose: false,
            message: t('common.updateAvailableBody', {
                defaultValue:
                    'Version {{tag}} is available. Tap to download — your browser will handle installation.',
                tag: latestTag,
            }),
            onClick: () => {
                window.open(downloadUrl, '_blank', 'noopener,noreferrer');
                dismiss();
            },
            onClose: dismiss,
            title: t('common.updateAvailable', { defaultValue: 'Update available' }),
        });
    }, [data, currentVersion, isEnabled, t]);
};
