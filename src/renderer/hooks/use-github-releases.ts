import { useQuery } from '@tanstack/react-query';
import axios from 'axios';

import packageJson from '../../../package.json';

// Fork-tagged builds (e.g. v1.11.0-itskenny0-2026-05-09g) only exist in the
// fork's repo, not in the upstream jeffvli/feishin one. Detect that prefix
// in package.json's version and route GitHub API calls to the right repo so
// release notes and update checks don't 404 (or point users at upstream
// releases) on fork builds.
const FORK_TAG_PATTERN = /-itskenny0?-/;
const FORK_REPO = 'itskenny0/feishin';
const UPSTREAM_REPO = 'jeffvli/feishin';

export const GITHUB_REPO = FORK_TAG_PATTERN.test(packageJson.version) ? FORK_REPO : UPSTREAM_REPO;

export const GITHUB_RELEASES_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases`;
export const RELEASES_TO_FETCH = 30;

export interface GitHubRelease {
    body: null | string;
    name: null | string;
    prerelease: boolean;
    published_at: string;
    tag_name: string;
}

export function parseVersionFromTag(tagName: string): string {
    return tagName.startsWith('v') ? tagName.slice(1) : tagName;
}

export function toTag(version: string): string {
    return version.startsWith('v') ? version : `v${version}`;
}

export const useGithubReleasesList = (perPage = RELEASES_TO_FETCH) => {
    return useQuery({
        queryFn: async () => {
            const response = await axios.get<GitHubRelease[]>(GITHUB_RELEASES_URL, {
                params: { per_page: perPage },
            });
            return response.data;
        },
        queryKey: ['github-releases-list', perPage],
        retry: 2,
    });
};

export const useGithubLatestRelease = (options?: {
    refetchInterval?: number;
    refetchIntervalInBackground?: boolean;
}) => {
    return useQuery({
        queryFn: async () => {
            const response = await axios.get<GitHubRelease>(`${GITHUB_RELEASES_URL}/latest`);
            return response.data;
        },
        queryKey: ['github-latest-release'],
        retry: 2,
        ...options,
    });
};
