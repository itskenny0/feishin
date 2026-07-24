import { defineConfig, externalizeDepsPlugin, UserConfig } from 'electron-vite';
import { createRequire } from 'module';
import { dirname, resolve } from 'path';
import conditionalImportPlugin from 'vite-plugin-conditional-import';
import dynamicImportPlugin from 'vite-plugin-dynamic-import';
import { ViteEjsPlugin } from 'vite-plugin-ejs';

import { kuromojiDictionaryPlugin } from './vite.kuromoji-plugin';
import { createReactPlugin } from './vite.react-plugin';

const currentOSEnv = process.platform;
const electronRendererTarget = 'chrome87';

// peer-sync's native-tcp transport builds its Duplex on mqtt.js's own bundled
// `readable-stream`. pnpm installs it under mqtt's scope but does not hoist it,
// so alias the bare specifier to mqtt's copy. The Electron renderer never runs
// the native path (Android-only), but the module is imported transitively, so
// the alias must resolve here too. Version-agnostic; no new npm dependency.
// Use createRequire(import.meta.url) for the inner resolve: electron-vite
// bundles this config to ESM, where the ambient `require` becomes a shim whose
// `.resolve` is not a function (`__require.resolve is not a function`). vite's
// own loader tolerates the bare `require.resolve` (so web.vite.config.ts works),
// but electron-vite does not — resolve through a real Node require instead.
const nodeRequire = createRequire(import.meta.url);
const readableStreamDir = dirname(
    createRequire(nodeRequire.resolve('mqtt/package.json')).resolve('readable-stream/package.json'),
);

// Split stable, heavy vendor libraries into their own long-lived chunks.
// Without this, everything the entry imports collapses into one ~5 MB
// `index` chunk that is re-downloaded + re-parsed on every app update.
// Grouping by library keeps the vendor chunks byte-stable across releases
// (better warm-start caching) and lets the browser fetch/parse them in
// parallel with the app chunk. Returning undefined falls back to Vite's
// default chunking for everything else (incl. the React.lazy route splits).
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
    // chunk and in a single warm-cacheable async chunk. Mirrors
    // web.vite.config.ts.
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

const createConfig = (isDevelopment: boolean): UserConfig => ({
    main: {
        build: {
            rollupOptions: {
                external: ['source-map-support'],
            },
            sourcemap: true,
        },
        define: {
            'import.meta.env.IS_LINUX': JSON.stringify(currentOSEnv === 'linux'),
            'import.meta.env.IS_MACOS': JSON.stringify(currentOSEnv === 'darwin'),
            'import.meta.env.IS_WIN': JSON.stringify(currentOSEnv === 'win32'),
        },
        plugins: [
            externalizeDepsPlugin(),
            dynamicImportPlugin(),
            conditionalImportPlugin({
                currentEnv: currentOSEnv,
                envs: ['win32', 'linux', 'darwin'],
            }),
        ],
        resolve: {
            alias: {
                '/@/main': resolve('src/main'),
                '/@/shared': resolve('src/shared'),
            },
        },
    },
    preload: {
        build: {
            sourcemap: true,
        },
        plugins: [externalizeDepsPlugin()],
        resolve: {
            alias: {
                '/@/preload': resolve('src/preload'),
                '/@/shared': resolve('src/shared'),
            },
        },
    },
    renderer: {
        build: {
            cssMinify: 'esbuild',
            minify: 'esbuild',
            modulePreload: {
                polyfill: false,
            },
            rollupOptions: {
                output: {
                    manualChunks,
                },
            },
            sourcemap: true,
            target: electronRendererTarget,
        },
        css: {
            modules: {
                generateScopedName: 'fs-[name]-[local]',
                localsConvention: 'camelCase',
            },
        },
        plugins: [
            createReactPlugin(),
            ...(isDevelopment ? [kuromojiDictionaryPlugin({ emitDictionary: false })] : []),
            ViteEjsPlugin({ web: false }),
        ],
        resolve: {
            alias: {
                '/@/i18n': resolve('src/i18n'),
                '/@/lyrics-conversion-api': resolve(
                    isDevelopment
                        ? 'src/renderer/features/lyrics/api/development-lyrics-conversion-api.ts'
                        : 'src/renderer/features/lyrics/api/electron-lyrics-conversion-api.ts',
                ),
                '/@/remote': resolve('src/remote'),
                '/@/renderer': resolve('src/renderer'),
                '/@/shared': resolve('src/shared'),
                'readable-stream': readableStreamDir,
                ...(isDevelopment ? { path: resolve('src/renderer/shims/path.ts') } : {}),
            },
        },
    },
});

export default defineConfig(({ command }) => createConfig(command === 'serve'));
