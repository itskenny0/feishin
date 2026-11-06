import { describe, expect, it } from 'vitest';

import { sanitizeForDiagnostics } from '/@/shared/utils/sanitize-for-diagnostics';

describe('sanitizeForDiagnostics', () => {
    // The renderer settings dump in the diagnostics export runs through this.
    // API keys and the peer-sync room override (which doubles as the MQTT
    // broker password) used to ship in plain text.
    it('redacts credential-bearing settings keys', () => {
        const result = sanitizeForDiagnostics({
            general: { lastfmApiKey: 'lfm-key', theme: 'nord' },
            lyrics: { translationApiKey: 'tr-key' },
            peerSync: {
                brokerPassword: 'pw',
                enabled: true,
                roomKey: 'rk',
                roomKeyOverride: 'override',
            },
        });

        expect(result).toEqual({
            general: { lastfmApiKey: '[Redacted]', theme: 'nord' },
            lyrics: { translationApiKey: '[Redacted]' },
            peerSync: {
                brokerPassword: '[Redacted]',
                enabled: true,
                roomKey: '[Redacted]',
                roomKeyOverride: '[Redacted]',
            },
        });
    });

    it('keeps non-secret keys that merely contain "key"', () => {
        const value = { hotkeys: { bindings: { play: { hotkey: 'space' } } }, tlsKeyPath: '/x' };
        expect(sanitizeForDiagnostics(value)).toEqual(value);
    });
});
