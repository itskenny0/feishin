import path from 'path';
import { defineConfig, normalizePath } from 'vite';
import { ViteEjsPlugin } from 'vite-plugin-ejs';
import { VitePWA } from 'vite-plugin-pwa';

import { kuromojiDictionaryPlugin } from './vite.kuromoji-plugin';
import { createReactPlugin } from './vite.react-plugin';

// Split stable, heavy vendor libraries into their own long-lived chunks so
// they stay byte-stable across releases (warm-start cache hits) and download
// in parallel with the app chunk instead of collapsing into one giant entry
// bundle. Mirrors electron.vite.config.ts. Returning undefined keeps Vite's
// default chunking (incl. the React.lazy route splits) for everything else.
const manualChunks = (id: string): string | undefined => {
    if (!id.includes('node_modules')) return undefined;

    if (id.includes('/react-dom/') || id.includes('/scheduler/')) return 'vendor-react-dom';
    if (
        /\/node_modules\/(react|react-router|react-router-dom|react-is)\//.test(id) ||
        id.includes('/use-sync-external-store/')
    ) {
        return 'vendor-react';
    }
    if (id.includes('/@mantine/')) return 'vendor-mantine';
    if (id.includes('/@tanstack/')) return 'vendor-tanstack';
    if (id.includes('/i18next') || id.includes('/react-i18next/')) return 'vendor-i18n';
    if (id.includes('/react-icons/')) return 'vendor-icons';
    if (id.includes('/lodash')) return 'vendor-lodash';
    if (id.includes('/@atlaskit/')) return 'vendor-dnd';
    if (id.includes('/zod/')) return 'vendor-zod';
    if (
        id.includes('/motion/') ||
        id.includes('/motion-dom/') ||
        id.includes('/framer-motion/') ||
        id.includes('/motion-utils/')
    ) {
        return 'vendor-motion';
    }
    if (id.includes('/axios/')) return 'vendor-axios';
    if (id.includes('/dexie/')) return 'vendor-dexie';
    if (id.includes('/dompurify/')) return 'vendor-dompurify';
    if (id.includes('/overlayscrollbars')) return 'vendor-overlayscrollbars';
    if (id.includes('/fuse.js/') || id.includes('/fuse/')) return 'vendor-fuse';
    if (id.includes('/buffer/')) return 'vendor-buffer';
    // MQTT peer-sync transport. Only reachable through async boundaries (the
    // lazy PeerSyncHook, the lazy peer-dispatcher facade, the lazy Settings
    // route), so isolating it keeps the ~360 KB mqtt graph out of the entry
    // chunk and in a single warm-cacheable async chunk instead of being
    // duplicated/inlined into whichever lazy chunk first touches it.
    if (
        id.includes('/mqtt/') ||
        id.includes('/mqtt-packet/') ||
        id.includes('/number-allocator/') ||
        id.includes('/reinterval/') ||
        id.includes('/mqtt-pattern/') ||
        id.includes('/help-me/')
    ) {
        return 'vendor-mqtt';
    }

    return undefined;
};

export default defineConfig({
    base: './',
    build: {
        emptyOutDir: true,
        outDir: path.resolve(__dirname, './out/web'),
        rollupOptions: {
            input: {
                '32x32': normalizePath(path.resolve(__dirname, './assets/icons/32x32.png')),
                '64x64': normalizePath(path.resolve(__dirname, './assets/icons/64x64.png')),
                '128x128': normalizePath(path.resolve(__dirname, './assets/icons/128x128.png')),
                '256x256': normalizePath(path.resolve(__dirname, './assets/icons/256x256.png')),
                '512x512': normalizePath(path.resolve(__dirname, './assets/icons/512x512.png')),
                '1024x1024': normalizePath(path.resolve(__dirname, './assets/icons/1024x1024.png')),
                favicon: normalizePath(path.resolve(__dirname, './assets/icons/favicon.ico')),
                index: normalizePath(path.resolve(__dirname, './src/renderer/index.html')),
                preview_full_screen_player: normalizePath(
                    path.resolve(__dirname, './media/preview_full_screen_player.webp'),
                ),
            },
            output: {
                assetFileNames: (assetInfo) => {
                    const stableNames = [
                        '32x32.png',
                        '64x64.png',
                        '128x128.png',
                        '256x256.png',
                        '512x512.png',
                        '1024x1024.png',
                        'favicon.ico',
                        'preview_full_screen_player.webp',
                    ];

                    if (assetInfo.names.length === 1 && stableNames.includes(assetInfo.names[0])) {
                        return 'assets/[name][extname]';
                    }

                    return 'assets/[name]-[hash][extname]';
                },
                manualChunks,
                sourcemapExcludeSources: false,
            },
        },
        sourcemap: true,
    },
    css: {
        modules: {
            generateScopedName: 'fs-[name]-[local]',
            localsConvention: 'camelCase',
        },
    },
    optimizeDeps: {
        exclude: [
            '@atlaskit/pragmatic-drag-and-drop',
            '@atlaskit/pragmatic-drag-and-drop-auto-scroll',
            '@atlaskit/pragmatic-drag-and-drop-hitbox',
            '@tanstack/react-query-persist-client',
            'idb-keyval',
        ],
        include: [
            '@atlaskit/pragmatic-drag-and-drop > bind-event-listener',
            '@atlaskit/pragmatic-drag-and-drop-auto-scroll > bind-event-listener',
            '@atlaskit/pragmatic-drag-and-drop-hitbox > bind-event-listener',
        ],
    },
    plugins: [
        createReactPlugin(),
        kuromojiDictionaryPlugin(),
        ViteEjsPlugin({
            root: normalizePath(path.resolve(__dirname, './src/renderer')),
            web: true,
        }),
        VitePWA({
            devOptions: {
                // The PWA will not be shown during development
                enabled: false,
            },
            filename: 'assets/sw.js',
            injectRegister: 'inline',
            manifest: {
                background_color: '#FFDCB5',
                display: 'standalone',
                icons: [
                    {
                        sizes: '32x32',
                        src: '32x32.png',
                        type: 'image/png',
                    },
                    {
                        sizes: '64x64',
                        src: '64x64.png',
                        type: 'image/png',
                    },
                    {
                        sizes: '128x128',
                        src: '128x128.png',
                        type: 'image/png',
                    },
                    {
                        sizes: '256x256',
                        src: '256x256.png',
                        type: 'image/png',
                    },
                    {
                        purpose: 'any',
                        sizes: '512x512',
                        src: '512x512.png',
                        type: 'image/png',
                    },
                    {
                        sizes: '1024x1024',
                        src: '1024x1024.png',
                        type: 'image/png',
                    },
                ],
                name: 'Feishin',
                orientation: 'portrait',
                screenshots: [
                    {
                        form_factor: 'wide',
                        label: 'Full screen player showing music player and lyrics',
                        sizes: '720x450',
                        src: 'preview_full_screen_player.webp',
                        type: 'image/webp',
                    },
                ],
                short_name: 'Feishin',
                start_url: '/',
                theme_color: '#1E003D',
            },
            manifestFilename: 'assets/manifest.webmanifest',
            outDir: path.resolve(__dirname, './out/web/'),
            registerType: 'autoUpdate',
            scope: '/assets/',
            workbox: {
                cleanupOutdatedCaches: true,
                clientsClaim: true,
                globIgnores: ['**/kuromoji/**'],
                maximumFileSizeToCacheInBytes: 1000000 * 10, // 10 MB
                skipWaiting: true,
            },
        }),
    ],
    resolve: {
        alias: {
            '/@/i18n': path.resolve(__dirname, './src/i18n'),
            '/@/lyrics-conversion-api': path.resolve(
                __dirname,
                './src/main/features/core/lyrics/furigana.ts',
            ),
            '/@/remote': path.resolve(__dirname, './src/remote'),
            '/@/renderer': path.resolve(__dirname, './src/renderer'),
            '/@/shared': path.resolve(__dirname, './src/shared'),
            path: path.resolve(__dirname, './src/renderer/shims/path.ts'),
        },
    },
    root: path.resolve(__dirname, './src/renderer'),
});
