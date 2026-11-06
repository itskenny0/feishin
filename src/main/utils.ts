import os from 'os';

export const getHostname = (): string => {
    try {
        return os.hostname();
    } catch {
        return '';
    }
};

const ACCELERATOR_KEYS: Record<string, string> = {
    arrowdown: 'Down',
    arrowleft: 'Left',
    arrowright: 'Right',
    arrowup: 'Up',
    mod: 'CmdOrCtrl',
    numpadadd: 'numadd',
    numpaddecimal: 'numdec',
    numpaddivide: 'numdiv',
    numpadenter: 'numenter',
    numpadmultiply: 'nummult',
    numpadsubtract: 'numsub',
};

// Maps whole `+`-separated keys, so `numpadsubtract` is not caught by a
// `numpad` prefix replacement first (which yielded the invalid `numsubtract`).
export const hotkeyToElectronAccelerator = (hotkey: string) =>
    hotkey
        .split('+')
        .map((key) => ACCELERATOR_KEYS[key] ?? key.replace(/^numpad(?=\d$)/, 'num'))
        .join('+');
