import { describe, expect, it } from 'vitest';

import {
    keyboardCodeToHotkeyKey,
    MODIFIER_KEY_CODES,
} from '/@/shared/utils/keyboard-code-to-hotkey';

describe('keyboardCodeToHotkeyKey', () => {
    it('maps named keys to their lowercase hotkey form', () => {
        expect(keyboardCodeToHotkeyKey('ArrowDown')).toBe('arrowdown');
        expect(keyboardCodeToHotkeyKey('Enter')).toBe('enter');
        expect(keyboardCodeToHotkeyKey('Escape')).toBe('escape');
        expect(keyboardCodeToHotkeyKey('Space')).toBe('space');
        expect(keyboardCodeToHotkeyKey('PageUp')).toBe('pageup');
    });

    it('strips the Key prefix for letter keys and lowercases', () => {
        expect(keyboardCodeToHotkeyKey('KeyA')).toBe('a');
        expect(keyboardCodeToHotkeyKey('KeyZ')).toBe('z');
    });

    it('strips the Digit prefix for top-row number keys', () => {
        expect(keyboardCodeToHotkeyKey('Digit0')).toBe('0');
        expect(keyboardCodeToHotkeyKey('Digit9')).toBe('9');
    });

    it('maps numpad operator keys via the numpad table', () => {
        expect(keyboardCodeToHotkeyKey('NumpadAdd')).toBe('numpadadd');
        expect(keyboardCodeToHotkeyKey('NumpadEnter')).toBe('numpadenter');
        expect(keyboardCodeToHotkeyKey('NumpadDivide')).toBe('numpaddivide');
    });

    it('maps numpad digit keys', () => {
        expect(keyboardCodeToHotkeyKey('Numpad0')).toBe('numpad0');
        expect(keyboardCodeToHotkeyKey('Numpad5')).toBe('numpad5');
    });

    it('returns null for unrecognised codes', () => {
        expect(keyboardCodeToHotkeyKey('F13')).toBeNull();
        expect(keyboardCodeToHotkeyKey('Unidentified')).toBeNull();
        expect(keyboardCodeToHotkeyKey('NumpadParenLeft')).toBeNull();
        expect(keyboardCodeToHotkeyKey('')).toBeNull();
    });
});

describe('MODIFIER_KEY_CODES', () => {
    it('contains both left and right variants of each modifier', () => {
        for (const code of [
            'AltLeft',
            'AltRight',
            'ControlLeft',
            'ControlRight',
            'MetaLeft',
            'MetaRight',
            'ShiftLeft',
            'ShiftRight',
        ]) {
            expect(MODIFIER_KEY_CODES.has(code)).toBe(true);
        }
    });

    it('does not contain non-modifier codes', () => {
        expect(MODIFIER_KEY_CODES.has('KeyA')).toBe(false);
        expect(MODIFIER_KEY_CODES.has('Enter')).toBe(false);
    });
});
