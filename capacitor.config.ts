import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
    android: {
        // The WebView needs to be willing to play any http:// audio stream
        // from the user's media server (most home installs are http://).
        // Without this, the Audio element refuses to load mixed-content
        // streams.
        allowMixedContent: true,
        // Background-mode is best-effort on Android. We don't ship a real
        // foreground service in this tech demo; audio may pause when the
        // WebView is backgrounded. That's documented in ANDROID.md.
        backgroundColor: '#000000',
    },
    appId: 'cat.kenny.feishin',
    appName: 'Feishin',
    server: {
        // Allow plain HTTP traffic to Jellyfin / Subsonic servers on the local
        // network. Production deployments behind HTTPS still work; this just
        // doesn't reject http:// URLs the user might enter in the server form.
        androidScheme: 'https',
        cleartext: true,
    },
    webDir: 'out/web',
};

export default config;
