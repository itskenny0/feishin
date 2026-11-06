const CODE_TO_HOTKEY_KEY: Record<string, string> = {
    ArrowDown: 'arrowdown',
    ArrowLeft: 'arrowleft',
    ArrowRight: 'arrowright',
    ArrowUp: 'arrowup',
    Backquote: '`',
    Backslash: '\\',
    Backspace: 'backspace',
    BracketLeft: '[',
    BracketRight: ']',
    Comma: ',',
    Delete: 'delete',
    End: 'end',
    Enter: 'enter',
    Equal: 'equal',
    Escape: 'escape',
    Home: 'home',
    Insert: 'insert',
    Minus: 'minus',
    PageDown: 'pagedown',
    PageUp: 'pageup',
    Period: '.',
    Quote: "'",
    Semicolon: ';',
    Slash: '/',
    Space: 'space',
    Tab: 'tab',
};

const NUMPAD_CODE_TO_HOTKEY_KEY: Record<string, string> = {
    Add: 'numpadadd',
    Decimal: 'numpaddecimal',
    Divide: 'numpaddivide',
    Enter: 'numpadenter',
    Multiply: 'numpadmultiply',
    Subtract: 'numpadsubtract',
};

export const MODIFIER_KEY_CODES = new Set([
    'AltLeft',
    'AltRight',
    'ControlLeft',
    'ControlRight',
    'MetaLeft',
    'MetaRight',
    'ShiftLeft',
    'ShiftRight',
]);

export const keyboardCodeToHotkeyKey = (code: string): null | string => {
    const mapped = CODE_TO_HOTKEY_KEY[code];
    if (mapped) {
        return mapped;
    }

    if (code.startsWith('Key')) {
        return code.slice(3).toLowerCase();
    }

    if (code.startsWith('Digit')) {
        return code.slice(5);
    }

    if (/^F([1-9]|1\d|2[0-4])$/.test(code)) {
        return code.toLowerCase();
    }

    if (code.startsWith('Numpad')) {
        const suffix = code.slice(6);
        const numpadMapped = NUMPAD_CODE_TO_HOTKEY_KEY[suffix];
        if (numpadMapped) {
            return numpadMapped;
        }

        if (/^\d$/.test(suffix)) {
            return `numpad${suffix}`;
        }
    }

    return null;
};

const IS_APPLE_PLATFORM =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * One key of a hotkey string as users know it: the library's "mod" token
 * becomes Ctrl (or ⌘ on Apple platforms), other keys get a capital letter.
 */
export const formatHotkeyPart = (part: string): string => {
    const key = part.trim();
    if (key.toLowerCase() === 'mod') return IS_APPLE_PLATFORM ? '⌘' : 'Ctrl';
    if (key === '[plus]') return '+';
    return key.charAt(0).toUpperCase() + key.slice(1);
};

/** "mod+shift+k" -> "Ctrl+Shift+K" (or "⌘+Shift+K") for display only. */
export const formatHotkeyForDisplay = (hotkey: string): string =>
    hotkey
        .split('+')
        .map((part) => part.trim())
        .filter(Boolean)
        .map(formatHotkeyPart)
        .join('+');
