// ─────────────────────────────────────────────────────────────────────────────
// esbuild-webview.js — Bundle the Webview UI for production
// ─────────────────────────────────────────────────────────────────────────────

const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

async function main() {
    const ctx = await esbuild.context({
        entryPoints: ['webview-ui/main.js'],
        bundle: true,
        format: 'iife',
        minify: production,
        sourcemap: !production,
        outfile: 'webview-ui/dist/main.js',
        target: 'es2020',
        platform: 'browser',
    });

    if (watch) {
        await ctx.watch();
        console.log('[esbuild-webview] Watching for changes...');
    } else {
        await ctx.rebuild();
        console.log('[esbuild-webview] Build complete.');
        await ctx.dispose();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
