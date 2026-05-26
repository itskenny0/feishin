import path from 'path';
import { defineConfig } from 'vitest/config';

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
