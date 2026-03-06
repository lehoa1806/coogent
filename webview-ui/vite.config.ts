import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  build: {
    outDir: 'dist',
    target: 'es2020',
    // vendor-mermaid chunk is ~2.4 MB (mermaid + d3 are inherently large).
    // The meaningful split is done — main bundle is <200 KB.
    chunkSizeWarningLimit: 2800,
    rollupOptions: {
      output: {
        // Deterministic file names (no hash) for Extension Host script-tag URIs
        entryFileNames: 'assets/index.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]',

        // Split the heavy mermaid dependency tree into its own chunk
        manualChunks(id) {
          if (
            id.includes('node_modules/mermaid') ||
            id.includes('node_modules/d3') ||
            id.includes('node_modules/dagre') ||
            id.includes('node_modules/elkjs') ||
            id.includes('node_modules/cytoscape') ||
            id.includes('node_modules/dompurify') ||
            id.includes('node_modules/katex') ||
            id.includes('node_modules/khroma') ||
            id.includes('node_modules/lodash') ||
            id.includes('node_modules/stylis')
          ) {
            return 'vendor-mermaid';
          }
          // Everything else stays in the entry chunk
        },
      },
    },
    // Inline all CSS into a single file
    cssCodeSplit: false,
  },
});
