// Guard for the playerbar waveform's full-audio decode.
//
// WaveSurfer renders peaks by fetching the stream URL and decoding the ENTIRE
// file to PCM. On desktop that's noise; on Android/iOS WebViews the transient
// allocation for a full-quality file (offline playback serves the original
// bytes as a blob: URL) runs to hundreds of MB and the OS low-memory killer
// takes the app down moments after playback starts. On native platforms we
// skip loading the waveform for blob: sources and fall back to the plain seek
// slider — remote URLs stay allowed because online they're the (small)
// transcoded analysis copy.

import { Capacitor } from '@capacitor/core';

const isNativePlatform = (): boolean => {
    try {
        return Capacitor.isNativePlatform();
    } catch {
        return false;
    }
};

export const shouldSkipWaveformLoad = (
    streamUrl: string | undefined,
    nativePlatform: boolean = isNativePlatform(),
): boolean => {
    if (!streamUrl) return false;
    return nativePlatform && streamUrl.startsWith('blob:');
};
