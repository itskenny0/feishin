import { closeAllModals, openModal } from '@mantine/modals';
import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import DOMPurify from 'dompurify';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import packageJson from '../../package.json';

import {
    GITHUB_RELEASES_URL,
    GITHUB_REPO,
    type GitHubRelease,
    parseVersionFromTag,
    RELEASES_TO_FETCH,
    toTag,
    useGithubReleasesList,
} from '/@/renderer/hooks/use-github-releases';
import { formatHrDateTime } from '/@/renderer/utils/format';
import { Button } from '/@/shared/components/button/button';
import { Center } from '/@/shared/components/center/center';
import { Group } from '/@/shared/components/group/group';
import { Icon } from '/@/shared/components/icon/icon';
import { ScrollArea } from '/@/shared/components/scroll-area/scroll-area';
import { Select } from '/@/shared/components/select/select';
import { Spinner } from '/@/shared/components/spinner/spinner';
import { Stack } from '/@/shared/components/stack/stack';
import { Text } from '/@/shared/components/text/text';

interface ReleaseNotesContentProps {
    onDismiss: () => void;
    version: string;
}

const dotsToDashes = (version: string) => version.replace(/\./g, '-');

// Release builds stamp package.json with the tag's dots turned into dashes
// (v1.17.0-itskenny0-2026.11.06-0215 -> 1.17.0-itskenny0-2026-11-06-0215, see
// release-fork.yml), so map the installed version back to its real tag version.
export const resolveReleaseVersion = (version: string, releases: GitHubRelease[]): string => {
    const match = releases
        .map((r) => parseVersionFromTag(r.tag_name))
        .find((v) => dotsToDashes(v) === dotsToDashes(version));
    return match ?? version;
};

const ReleaseNotesContent = ({
    onDismiss,
    version: installedVersion,
}: ReleaseNotesContentProps) => {
    const { t } = useTranslation();
    const [selectedVersion, setSelectedVersion] = useState<null | string>(null);

    // Fetch list of recent releases for the selector
    const { data: releasesList = [], isPending: isListPending } = useGithubReleasesList();
    const version = resolveReleaseVersion(installedVersion, releasesList);
    const activeVersion = selectedVersion ?? version;

    const releaseOptions = useMemo(() => {
        const options = releasesList.slice(0, RELEASES_TO_FETCH).map((r) => {
            const v = parseVersionFromTag(r.tag_name);
            const dateStr = formatHrDateTime(r.published_at);
            return {
                label: dateStr ? `${v} - ${dateStr}` : v,
                value: v,
            };
        });
        const versions = options.map((o) => o.value);
        if (!versions.includes(version)) {
            options.unshift({ label: version, value: version });
        }
        return options;
    }, [releasesList, version]);

    // Fetch the selected release by tag
    const {
        data: releaseData,
        isError,
        isLoading,
    } = useQuery({
        // Wait for the list so the installed version resolves to its real tag
        enabled: !isListPending,
        queryFn: async () => {
            const response = await axios.get<GitHubRelease>(
                `${GITHUB_RELEASES_URL}/tags/${toTag(activeVersion)}`,
            );
            return response.data;
        },
        queryKey: ['github-release', activeVersion],
        retry: 2,
    });

    // Convert markdown to HTML using GitHub's markdown API
    const {
        data: htmlContent,
        isError: isMarkdownError,
        isLoading: isConverting,
    } = useQuery({
        enabled: !!releaseData?.body,
        queryFn: async () => {
            const response = await axios.post(
                'https://api.github.com/markdown',
                {
                    mode: 'gfm',
                    text: releaseData?.body ?? '',
                },
                {
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    responseType: 'text',
                },
            );
            return response.data;
        },
        queryKey: ['github-markdown', releaseData?.body],
        retry: 2,
    });

    const sanitizedHtml = useMemo(() => {
        if (!htmlContent) return '';
        return DOMPurify.sanitize(htmlContent, {
            ALLOWED_ATTR: ['alt', 'href', 'src', 'title'],
            ALLOWED_TAGS: [
                'a',
                'blockquote',
                'br',
                'code',
                'em',
                'h1',
                'h2',
                'h3',
                'h4',
                'h5',
                'h6',
                'img',
                'li',
                'ol',
                'p',
                'pre',
                'strong',
                'u',
                'ul',
            ],
        });
    }, [htmlContent]);

    const isLoadingState = isListPending || isLoading || isConverting;
    const isErrorState = isError || !releaseData || isMarkdownError;

    if (isLoadingState) {
        return (
            <Center h={400}>
                <Spinner />
            </Center>
        );
    }

    if (isErrorState) {
        return (
            <Stack gap="md">
                {releaseOptions.length > 1 && (
                    <Select
                        data={releaseOptions}
                        onChange={(v) => v && setSelectedVersion(v)}
                        value={activeVersion}
                    />
                )}
                <Text size="sm">{t('error.genericError')}</Text>
                <Group justify="flex-end">
                    <Button
                        component="a"
                        href={`https://github.com/${GITHUB_REPO}/releases/tag/${toTag(activeVersion)}`}
                        onClick={onDismiss}
                        rightSection={<Icon icon="externalLink" />}
                        target="_blank"
                        variant="filled"
                    >
                        {t('common.viewReleaseNotes')}
                    </Button>
                    <Button onClick={onDismiss} variant="default">
                        {t('common.dismiss')}
                    </Button>
                </Group>
            </Stack>
        );
    }

    return (
        <Stack gap="md">
            {releaseOptions.length > 1 && (
                <Select
                    data={releaseOptions}
                    onChange={(v) => v && setSelectedVersion(v)}
                    value={activeVersion}
                />
            )}
            <ScrollArea
                style={{
                    height: '400px',
                }}
            >
                <Text
                    dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
                    fw={400}
                    lh="1.5"
                    size="md"
                />
            </ScrollArea>
            <Group justify="flex-end">
                <Button
                    component="a"
                    href={`https://github.com/${GITHUB_REPO}/releases/tag/${toTag(activeVersion)}`}
                    onClick={onDismiss}
                    rightSection={<Icon icon="externalLink" />}
                    target="_blank"
                    variant="subtle"
                >
                    {t('action.viewMore')}
                </Button>
                <Button onClick={onDismiss} variant="filled">
                    {t('common.dismiss')}
                </Button>
            </Group>
        </Stack>
    );
};

export const openReleaseNotesModal = (title: string) =>
    openModal({
        children: (
            <ReleaseNotesContent onDismiss={() => closeAllModals()} version={packageJson.version} />
        ),
        size: 'xl',
        title,
    });

// The auto-on-update <ReleaseNotesModal /> component used to live here and
// pop up automatically whenever the installed version differed from the
// last-seen one. That popup interrupted launch on every fork build (we tag
// frequently), so the auto-open is removed. The release notes are still
// reachable on-demand via openReleaseNotesModal() from the app menu.
