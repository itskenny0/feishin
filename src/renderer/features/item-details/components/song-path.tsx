import isElectron from 'is-electron';
import { useTranslation } from 'react-i18next';

import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { CopyButton } from '/@/shared/components/copy-button/copy-button';
import { Group } from '/@/shared/components/group/group';
import { Text } from '/@/shared/components/text/text';
import { toast } from '/@/shared/components/toast/toast';

const util = isElectron() ? window.api.utils : null;

export type SongPathProps = {
    path: null | string;
};

export const SongPath = ({ path }: SongPathProps) => {
    const { t } = useTranslation();

    if (!path) return null;

    return (
        <Group gap="xs">
            <CopyButton timeout={2000} value={path}>
                {({ copied, copy }) => (
                    <ActionIcon
                        icon={copied ? 'check' : 'clipboardCopy'}
                        onClick={copy}
                        tooltip={{
                            label: t(
                                copied ? 'page.itemDetail.copiedPath' : 'page.itemDetail.copyPath',
                                {},
                            ),
                        }}
                        variant="transparent"
                    />
                )}
            </CopyButton>
            {util && (
                <ActionIcon
                    icon="externalLink"
                    onClick={() => {
                        util.openItem(path).catch((error) => {
                            toast.error({
                                message: (error as Error).message,
                                title: t('error.openError'),
                            });
                        });
                    }}
                    tooltip={{ label: t('page.itemDetail.openFile') }}
                    variant="transparent"
                />
            )}
            <Text
                style={{
                    flex: '1 1 12rem',
                    minWidth: 0,
                    overflowWrap: 'anywhere',
                    userSelect: 'all',
                }}
            >
                {path}
            </Text>
        </Group>
    );
};
