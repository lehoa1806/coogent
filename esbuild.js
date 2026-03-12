// @ts-check
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * esbuild plugin that copies sql-wasm.wasm into the out/ directory.
 * sql.js requires the WASM binary at runtime next to the extension bundle.
 * @type {import('esbuild').Plugin}
 */
const copyWasmPlugin = {
    name: 'copy-sql-wasm',
    setup(build) {
        build.onStart(() => {
            const src = path.join(__dirname, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
            const outDir = path.join(__dirname, 'out');
            const dest = path.join(outDir, 'sql-wasm.wasm');

            if (!fs.existsSync(outDir)) {
                fs.mkdirSync(outDir, { recursive: true });
            }

            fs.copyFileSync(src, dest);
            console.log('[copy-sql-wasm] Copied sql-wasm.wasm → out/');
        });
    },
};

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'out/extension.js',
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    sourcemap: !production,
    minify: production,
    logLevel: 'info',
    loader: { '.md': 'text' },
    plugins: [copyWasmPlugin],
};

/** @type {import('esbuild').BuildOptions} */
const stdioBuildOptions = {
    entryPoints: ['src/mcp/stdio-server.ts'],
    bundle: true,
    outfile: 'out/stdio-server.js',
    // Alias 'vscode' to a minimal shim (the real module is not available outside
    // the VS Code extension host). The shim provides no-op stubs for the APIs
    // used by ArtifactDB and PluginLoader.
    alias: { 'vscode': './src/mcp/vscode-shim.ts' },
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    sourcemap: !production,
    minify: production,
    logLevel: 'info',
    plugins: [copyWasmPlugin],
};

async function main() {
    if (watch) {
        const ctx = await esbuild.context(buildOptions);
        await ctx.watch();
        const stdioctx = await esbuild.context(stdioBuildOptions);
        await stdioctx.watch();
        console.log('[esbuild] Watching for changes...');
    } else {
        await esbuild.build(buildOptions);
        await esbuild.build(stdioBuildOptions);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
