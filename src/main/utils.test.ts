// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { hotkeyToElectronAccelerator } from './utils';

describe('hotkeyToElectronAccelerator', () => {
    it('maps the renderer numpad operator keys to Electron accelerator names', () => {
        expect(hotkeyToElectronAccelerator('numpadadd')).toBe('numadd');
        expect(hotkeyToElectronAccelerator('numpaddecimal')).toBe('numdec');
        expect(hotkeyToElectronAccelerator('numpaddivide')).toBe('numdiv');
        expect(hotkeyToElectronAccelerator('numpadmultiply')).toBe('nummult');
        expect(hotkeyToElectronAccelerator('mod+numpadsubtract')).toBe('CmdOrCtrl+numsub');
    });

    it('maps numpad digits, arrows and mod', () => {
        expect(hotkeyToElectronAccelerator('numpad5')).toBe('num5');
        expect(hotkeyToElectronAccelerator('mod+shift+arrowup')).toBe('CmdOrCtrl+shift+Up');
        expect(hotkeyToElectronAccelerator('alt+arrowleft')).toBe('alt+Left');
    });

    it('leaves other keys untouched', () => {
        expect(hotkeyToElectronAccelerator('ctrl+shift+k')).toBe('ctrl+shift+k');
        expect(hotkeyToElectronAccelerator('f13')).toBe('f13');
    });
});
