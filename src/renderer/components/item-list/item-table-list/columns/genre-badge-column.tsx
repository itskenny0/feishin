import { useDisclosure } from '@mantine/hooks';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { generatePath, Link } from 'react-router';

import styles from './genre-badge-column.module.css';

import {
    ColumnNullFallback,
    ColumnSkeletonVariable,
    ItemTableListInnerColumn,
    TableColumnContainer,
} from '/@/renderer/components/item-list/item-table-list/item-table-list-column';
import { AppRoute } from '/@/renderer/router/routes';
import { Badge } from '/@/shared/components/badge/badge';
import { Group } from '/@/shared/components/group/group';
import { Modal } from '/@/shared/components/modal/modal';
import { Genre } from '/@/shared/types/domain-types';
import { stringToColor } from '/@/shared/utils/string-to-color';

const MAX_GENRES = 4;

interface DecoratedGenre extends Genre {
    color: string;
    isLight: boolean;
    path: string;
}

const GenreBadgeLink = ({
    genre,
    onNavigate,
}: {
    genre: DecoratedGenre;
    onNavigate?: () => void;
}) => (
    <Badge
        component={Link}
        onClick={onNavigate}
        state={{ item: genre }}
        style={{
            backgroundColor: genre.color,
            color: genre.isLight ? 'black' : 'white',
        }}
        to={genre.path}
    >
        {genre.name}
    </Badge>
);

const GenreBadgeOverflow = ({ genres }: { genres: DecoratedGenre[] }) => {
    const { t } = useTranslation();
    const [opened, { close, open }] = useDisclosure(false);
    const overflow = genres.length - MAX_GENRES;

    return (
        <>
            <Badge
                onClick={(e) => {
                    // Don't trigger row selection / navigation behind the cell.
                    e.preventDefault();
                    e.stopPropagation();
                    open();
                }}
                style={{ cursor: 'pointer' }}
            >
                {t('common.plusMore', { count: overflow, defaultValue: '+{{count}} more' })}
            </Badge>
            <Modal
                handlers={{ close, open, toggle: () => (opened ? close() : open()) }}
                opened={opened}
                size="md"
                title={t('entity.genre', { count: genres.length })}
            >
                <Group gap="xs">
                    {genres.map((genre) => (
                        <GenreBadgeLink genre={genre} key={genre.id} onNavigate={close} />
                    ))}
                </Group>
            </Modal>
        </>
    );
};

const GenreBadgeColumn = (props: ItemTableListInnerColumn) => {
    const rowItem = props.getRowItem?.(props.rowIndex) ?? (props.data as any[])[props.rowIndex];
    const row: Genre[] | undefined = (rowItem as any)?.genres;

    const genres = useMemo<DecoratedGenre[]>(() => {
        if (!row) return [];
        return row.map((genre) => {
            const { color, isLight } = stringToColor(genre.name);
            const path = generatePath(AppRoute.LIBRARY_GENRES_DETAIL, { genreId: genre.id });
            return { ...genre, color, isLight, path };
        });
    }, [row]);

    if (Array.isArray(row)) {
        return (
            <TableColumnContainer {...props}>
                <Group className={styles.group} wrap="wrap">
                    {genres.slice(0, MAX_GENRES).map((genre) => (
                        <GenreBadgeLink genre={genre} key={genre.id} />
                    ))}
                    {genres.length > MAX_GENRES && <GenreBadgeOverflow genres={genres} />}
                </Group>
            </TableColumnContainer>
        );
    }

    if (rowItem != null) {
        return <ColumnNullFallback {...props} />;
    }

    return <ColumnSkeletonVariable {...props} />;
};

export { GenreBadgeColumn };
