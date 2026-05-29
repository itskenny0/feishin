import { createRequire } from 'module';
import path from 'path';
import { defineConfig } from 'vitest/config';

// The native-tcp transport (peer-sync) builds its Duplex on top of mqtt.js's
// own bundled `readable-stream`. pnpm installs it under mqtt's scope but does
// not hoist it to the top-level node_modules, so resolve it via mqtt and alias
// the bare specifier. Version-agnostic: no .pnpm path is hardcoded, and no new
// npm dependency is added.
const readableStreamDir = path.dirname(
    createRequire(require.resolve('mqtt/package.json')).resolve('readable-stream/package.json'),
);

export default defineConfig({
    esbuild: {
        // Automatic JSX runtime so component tests don't need a React import
        // and we avoid pulling in the app's full Vite React plugin chain.
        jsx: 'automatic',
    },
    resolve: {
        alias: {
            '/@/i18n': path.resolve(__dirname, './src/i18n'),
            '/@/remote': path.resolve(__dirname, './src/remote'),
            '/@/renderer': path.resolve(__dirname, './src/renderer'),
            '/@/shared': path.resolve(__dirname, './src/shared'),
            'readable-stream': readableStreamDir,
        },
    },
    test: {
        // CSS-module imports resolve to an empty proxy; tests never assert on
        // generated class names.
        css: false,
        environment: 'jsdom',
        globals: true,
        include: ['src/**/*.test.{ts,tsx}'],
        setupFiles: ['./src/test/setup.ts'],
    },
});
