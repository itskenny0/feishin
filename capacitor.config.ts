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
        // Surfaces the WebView to chrome://inspect on a connected dev
        // machine — useful for diagnosing the boot of a fresh APK install.
        // Flip back to false (Capacitor default) before any signed Play
        // Store build.
        webContentsDebuggingEnabled: true,
    },
    appId: 'cat.kenny.feishin',
    appName: 'Feishin',
    ios: {
        // Paint the WebView's backdrop black during the cold-start frame so
        // the launch storyboard hands off to a dark surface instead of a
        // white flash (the renderer's dark theme takes over once React
        // mounts).
        backgroundColor: '#000000',
        // Don't let WKWebView add its own scroll content insets — the mobile
        // shell manages its own safe-area padding via env(safe-area-inset-*),
        // which iOS reports correctly (unlike the Android WebView, which is
        // why android needs the --android-safe-* fallbacks). 'never' keeps
        // the WebView edge-to-edge so those insets stay accurate.
        contentInset: 'never',
        // NB: the iOS analogue of android.allowMixedContent / server.cleartext
        // (letting the capacitor://localhost secure origin load a user's
        // http:// LAN media server) is NOT a Capacitor config flag — it lives
        // in ios/App/App/Info.plist as NSAppTransportSecurity →
        // NSAllowsArbitraryLoads. See IOS.md.
    },
    plugins: {
        SplashScreen: {
            androidScaleType: 'CENTER_CROP',
            backgroundColor: '#15103a',
            launchAutoHide: true,
            launchShowDuration: 1500,
            showSpinner: false,
            splashFullScreen: true,
            splashImmersive: false,
        },
    },
    server: {
        // Allow plain HTTP traffic to Jellyfin / Subsonic servers on the local
        // network. Production deployments behind HTTPS still work; this just
        // doesn't reject http:// URLs the user might enter in the server form.
        //
        // androidScheme is 'http' (not 'https') because the v20h/v20i builds
        // showed a persistent black-page boot under https://localhost — a
        // known interaction between the `crossorigin` attribute Vite emits on
        // the production module script and Capacitor's https custom scheme
        // handler. Outbound requests to user-network media servers can still
        // be https:// (or http:// with cleartext); only the in-app WebView's
        // origin changes.
        androidScheme: 'http',
        cleartext: true,
    },
    webDir: 'out/web',
};

export default config;
