import type { HotkeyItem } from '@mantine/hooks';

import { describe, expect, it, vi } from 'vitest';

import { toPhysicalHotkey, withPhysicalKeys } from '/@/shared/utils/hotkeys';

describe('toPhysicalHotkey', () => {
    it('rewrites bare digits to their physical Digit code', () => {
        expect(toPhysicalHotkey('mod+1')).toBe('mod+Digit1');
        expect(toPhysicalHotkey('ctrl+shift+9')).toBe('ctrl+shift+Digit9');
    });

    it('lowercases reserved modifier names', () => {
        expect(toPhysicalHotkey('Mod+Shift+A')).toBe('mod+shift+A');
        expect(toPhysicalHotkey('CTRL+ALT+META+X')).toBe('ctrl+alt+meta+X');
    });

    it('leaves non-digit, non-modifier parts untouched', () => {
        expect(toPhysicalHotkey('mod+K')).toBe('mod+K');
        expect(toPhysicalHotkey('ArrowUp')).toBe('ArrowUp');
    });

    it('preserves the [plus] sentinel verbatim', () => {
        expect(toPhysicalHotkey('mod+[plus]')).toBe('mod+[plus]');
    });

    it('trims surrounding whitespace in each part', () => {
        expect(toPhysicalHotkey('mod + 1')).toBe('mod+Digit1');
    });
});

describe('withPhysicalKeys', () => {
    it('rewrites the hotkey and forces usePhysicalKeys while preserving handler and options', () => {
        const handler = vi.fn();
        const input: HotkeyItem[] = [['mod+1', handler, { preventDefault: true }]];

        const result = withPhysicalKeys(input);

        expect(result).toHaveLength(1);
        const [hotkey, resultHandler, options] = result[0];
        expect(hotkey).toBe('mod+Digit1');
        expect(resultHandler).toBe(handler);
        expect(options).toEqual({ preventDefault: true, usePhysicalKeys: true });
    });

    it('adds usePhysicalKeys even when no options were supplied', () => {
        const handler = vi.fn();
        const result = withPhysicalKeys([['mod+K', handler]]);
        expect(result[0][2]).toEqual({ usePhysicalKeys: true });
    });
});
