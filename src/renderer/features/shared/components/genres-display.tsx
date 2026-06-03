import { useDisclosure } from '@mantine/hooks';
import { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { useIsMobileShell } from '/@/renderer/hooks/use-breakpoint';
import { Button } from '/@/shared/components/button/button';
import { Group } from '/@/shared/components/group/group';
import { Modal } from '/@/shared/components/modal/modal';
import { Pill, PillLink } from '/@/shared/components/pill/pill';

/**
 * Number of genres shown inline (desktop) before collapsing the remainder
 * behind a "+N" trigger. Tuned to the 300px sticky album-detail metadata
 * column — beyond ~8 pills the column grows tall and overflows.
 */
export const GENRES_INLINE_THRESHOLD = 8;

export interface GenreItem {
    id: string;
    name: string;
}

export type GenresDisplayVariant = 'button' | 'pill';

interface GenresDisplayProps {
    /** Genres to render. */
    genres: GenreItem[];
    /** Optional cap override for the inline list (desktop). */
    threshold?: number;
    /** Resolve a genre id to its route path. */
    to: (genreId: string) => string;
    /** Visual style of the inline genre items. */
    variant?: GenresDisplayVariant;
}

const GenrePillItem = ({
    children,
    onNavigate,
    to,
}: {
    children: ReactNode;
    onNavigate?: () => void;
    to: string;
}) => (
    <PillLink onClick={onNavigate} size="md" to={to}>
        {children}
    </PillLink>
);

const GenreButtonItem = ({
    children,
    onNavigate,
    to,
}: {
    children: ReactNode;
    onNavigate?: () => void;
    to: string;
}) => (
    <Button
        component={Link}
        onClick={onNavigate}
        radius="md"
        size="compact-md"
        to={to}
        variant="outline"
    >
        {children}
    </Button>
);

/**
 * Genres display with a "see all" affordance.
 *
 * - Desktop, `genres.length <= threshold`: render every genre inline.
 * - Desktop, `genres.length > threshold`: render the first `threshold`
 *   inline, then a trailing "+N" trigger that opens a modal listing ALL
 *   genres.
 * - Mobile (`useIsMobileShell`): always render a single compact summary
 *   chip ("Genres (N)") that opens the modal — the full inline list never
 *   renders on a phone where it would wrap badly.
 *
 * The visibility gate (`useGenresDisplay`) is applied by the caller, so this
 * component renders nothing-special-cased — callers return null when the
 * toggle is off.
 */
export const GenresDisplay = ({
    genres,
    threshold = GENRES_INLINE_THRESHOLD,
    to,
    variant = 'pill',
}: GenresDisplayProps) => {
    const { t } = useTranslation();
    const isMobile = useIsMobileShell();
    const [opened, { close, open }] = useDisclosure(false);

    if (genres.length === 0) return null;

    const renderItem = (genre: GenreItem, onNavigate?: () => void) =>
        variant === 'button' ? (
            <GenreButtonItem key={`genre-${genre.id}`} onNavigate={onNavigate} to={to(genre.id)}>
                {genre.name}
            </GenreButtonItem>
        ) : (
            <GenrePillItem key={`genre-${genre.id}`} onNavigate={onNavigate} to={to(genre.id)}>
                {genre.name}
            </GenrePillItem>
        );

    const overflow = isMobile ? genres.length : Math.max(genres.length - threshold, 0);
    const showTrigger = isMobile || genres.length > threshold;
    const inlineGenres = isMobile ? [] : genres.slice(0, threshold);

    const triggerLabel = isMobile
        ? t('entity.genre', { count: genres.length })
        : t('common.plusMore', { count: overflow, defaultValue: '+{{count}} more' });

    const trigger =
        variant === 'button' ? (
            <Button onClick={open} radius="md" size="compact-md" variant="outline">
                {triggerLabel}
            </Button>
        ) : (
            <Pill onClick={open} size="md" style={{ cursor: 'pointer' }}>
                {triggerLabel}
            </Pill>
        );

    return (
        <>
            <Group gap={variant === 'button' ? 'sm' : 'xs'}>
                {inlineGenres.map((genre) => renderItem(genre))}
                {showTrigger && trigger}
            </Group>
            <Modal
                handlers={{ close, open, toggle: () => (opened ? close() : open()) }}
                opened={opened}
                size="md"
                title={t('entity.genre', { count: genres.length })}
            >
                <Group gap="xs">{genres.map((genre) => renderItem(genre, close))}</Group>
            </Modal>
        </>
    );
};
