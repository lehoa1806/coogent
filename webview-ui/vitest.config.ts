import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
    plugins: [svelte({ hot: false })],
    resolve: {
        // Svelte 5 uses package.json `exports` conditions.
        // Without `browser`, Vitest resolves to the server bundle which
        // lacks `mount()`. The `browser` condition forces the client bundle.
        conditions: ['browser'],
    },
    test: {
        environment: 'jsdom',
        globals: true,
        setupFiles: ['./src/__tests__/setup.ts'],
        include: ['src/**/*.test.ts'],
    },
});
