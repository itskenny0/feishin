// Mantine modal that surfaces the in-memory console ring buffer to the
// user. Linked from the Library sync dashboard so mobile users (who
// can't open devtools) have somewhere to read cache logs / warnings /
// errors from.

import type { ConsoleEntry } from '/@/renderer/utils/console-capture';

import { Button, Group, Modal, ScrollArea, Stack, Text } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
    clearConsoleBuffer,
    formatConsoleBuffer,
    getConsoleBuffer,
    subscribeToConsoleBuffer,
} from '/@/renderer/utils/console-capture';
import { toast } from '/@/shared/components/toast/toast';

const levelColor: Record<ConsoleEntry['level'], string> = {
    debug: 'dimmed',
    error: 'red',
    info: 'blue',
    log: 'gray',
    warn: 'yellow',
};

const formatTime = (timestamp: number): string => {
    const d = new Date(timestamp);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    return `${hh}:${mm}:${ss}.${ms}`;
};

export const ConsoleLogViewer = () => {
    const { t } = useTranslation();
    const [opened, { close, open }] = useDisclosure(false);
    const [tick, setTick] = useState(0);

    // Subscribe to buffer changes only while the modal is open so we don't
    // re-render the rest of the app every time console.info fires.
    useEffect(() => {
        if (!opened) return undefined;
        return subscribeToConsoleBuffer(() => setTick((n) => n + 1));
    }, [opened]);

    const entries = opened ? getConsoleBuffer() : [];

    const handleCopy = async () => {
        const text = formatConsoleBuffer();
        try {
            if (navigator.clipboard) {
                await navigator.clipboard.writeText(text);
                toast.success({
                    message: t('page.setting.consoleLogViewer.copySuccess', {
                        defaultValue: `Copied ${entries.length} log entries to clipboard`,
                    }),
                });
            }
        } catch {
            // Fallback for old WebViews that block the clipboard API.
            const textarea = document.createElement('textarea');
            textarea.value = text;
            document.body.appendChild(textarea);
            textarea.select();
            try {
                document.execCommand('copy');
                toast.success({
                    message: t('page.setting.consoleLogViewer.copySuccess', {
                        defaultValue: `Copied ${entries.length} log entries to clipboard`,
                    }),
                });
            } finally {
                document.body.removeChild(textarea);
            }
        }
    };

    return (
        <>
            <Button onClick={open} size="xs" variant="default">
                {t('page.setting.consoleLogViewer.openButton', { defaultValue: 'Show logs' })}
            </Button>
            <Modal
                onClose={close}
                opened={opened}
                size="xl"
                styles={{ body: { padding: 0 }, content: { maxHeight: '90vh' } }}
                title={t('page.setting.consoleLogViewer.title', {
                    defaultValue: `Console log (${entries.length} entries, newest at bottom)`,
                })}
            >
                <Stack gap={0}>
                    <Group justify="flex-end" p="sm">
                        <Button onClick={handleCopy} size="xs" variant="default">
                            {t('page.setting.consoleLogViewer.copy', {
                                defaultValue: 'Copy all',
                            })}
                        </Button>
                        <Button
                            color="red"
                            onClick={() => clearConsoleBuffer()}
                            size="xs"
                            variant="default"
                        >
                            {t('page.setting.consoleLogViewer.clear', {
                                defaultValue: 'Clear',
                            })}
                        </Button>
                    </Group>
                    <ScrollArea h="70vh" type="auto">
                        <Stack gap={2} p="sm">
                            {entries.length === 0 ? (
                                <Text c="dimmed" size="sm" ta="center">
                                    {t('page.setting.consoleLogViewer.empty', {
                                        defaultValue: 'No log entries yet.',
                                    })}
                                </Text>
                            ) : (
                                entries.map((entry, idx) => (
                                    <Text
                                        c={levelColor[entry.level]}
                                        ff="monospace"
                                        // ring buffer indices are stable for the duration of
                                        // a modal session; using array index as the key is
                                        // safe and avoids hashing the (potentially large)
                                        // args string on every render.

                                        key={`${entry.timestamp}-${idx}`}
                                        size="xs"
                                        style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                                    >
                                        [{formatTime(entry.timestamp)}] [{entry.level.toUpperCase()}
                                        ] {entry.args}
                                    </Text>
                                ))
                            )}
                        </Stack>
                    </ScrollArea>
                    {/* swallow the unused-state warning — tick is intentional */}
                    <span data-tick={tick} style={{ display: 'none' }} />
                </Stack>
            </Modal>
        </>
    );
};
