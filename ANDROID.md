# Android (Capacitor tech demo)

This is a Capacitor-based wrapper that runs the existing `pnpm build:web`
bundle inside an Android WebView. The renderer is unmodified — the desktop UI
runs as-is. This is the tablet-only first phase: the existing 768 px
`useIsMobile` breakpoint keeps the desktop layout active in either orientation
on any 10" tablet.

## Install the prebuilt APK

1. Grab the latest `feishin-*-android.apk` from the
   [Releases page](https://github.com/itskenny0/feishin/releases).
2. On your tablet, enable installs from your browser / file manager:
   **Settings → Apps → Special app access → Install unknown apps** and toggle
   on the source you'll open the APK from.
3. Open the downloaded `.apk` and accept the install prompt. The APK is an
   unsigned debug build; Play Protect may warn — accept and continue.

## Build locally

Prerequisites:

- JDK 21 (Temurin recommended). Capacitor 8's Android module requires
  source release 21; JDK 17 will fail mid-compile with `invalid source
  release: 21`.
- Android SDK with platform-tools and a recent `compileSdk` (Capacitor 8
  targets API 35 by default — Android Studio's SDK Manager will fetch it).
- `pnpm` and Node 22.

Then from the repo root:

```bash
pnpm install
pnpm build:web
npx cap sync android
cd android && ./gradlew assembleDebug
```

The APK lands at `android/app/build/outputs/apk/debug/app-debug.apk`.

For an iterative Android Studio loop:

```bash
pnpm android:sync   # build:web + cap sync
pnpm android:open   # open the android/ project in Android Studio
```

## Known limitations

- **Background audio**: audio may stop when the WebView is backgrounded. This
  build does not yet ship a foreground service / MediaSession integration.
- **Phone-portrait layouts are not optimized**: the desktop UI assumes a
  viewport wider than 768 px. 10" tablets clear that bar in both orientations;
  a small phone in portrait will not.
- **HTTP and HTTPS servers both work**: `usesCleartextTraffic` and
  `allowMixedContent` are enabled so plain-HTTP Jellyfin / Navidrome / Subsonic
  servers on the LAN load correctly. Public HTTPS deployments continue to work
  unchanged.
- **Electron-only features fall back to the web path**: things like the MPV
  audio engine, native menus, OS cache directories, and the desktop
  remote-control surface are gated on `isElectron()` in the renderer. Inside
  the Capacitor WebView that returns `false`, so the existing web fallbacks
  (web audio player, in-app menus, idb-keyval, etc.) are used.
