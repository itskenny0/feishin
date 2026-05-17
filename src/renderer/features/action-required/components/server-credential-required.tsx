import { Trans, useTranslation } from 'react-i18next';

import { useCurrentServer } from '/@/renderer/store';
import { Text } from '/@/shared/components/text/text';

export const ServerCredentialRequired = () => {
    const { t } = useTranslation();
    const currentServer = useCurrentServer();

    return (
        <>
            <Text>
                <Trans
                    components={{ strong: <strong /> }}
                    i18nKey="serverCredentialRequired.message1"
                    t={t}
                    values={{ name: currentServer?.name ?? '' }}
                >
                    {`The selected server '{{name}}' requires an additional login to access.`}
                </Trans>
            </Text>
            <Text>
                {t('serverCredentialRequired.message2', {
                    defaultValue:
                        "Add your credentials in the 'manage servers' menu or switch to a different server.",
                })}
            </Text>
        </>
    );
};
