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

async function main() {
    if (watch) {
        const ctx = await esbuild.context(buildOptions);
        await ctx.watch();
        console.log('[esbuild] Watching for changes...');
    } else {
        await esbuild.build(buildOptions);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
