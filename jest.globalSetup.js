// jest.globalSetup.js — Copy sql-wasm.wasm to locations where ArtifactDB
// expects it at runtime (uses __dirname, which in ts-jest resolves to the
// source directory rather than the esbuild output directory).

const fs = require('node:fs');
const path = require('node:path');

module.exports = async function globalSetup() {
    const wasmSrc = path.resolve(__dirname, 'node_modules/sql.js/dist/sql-wasm.wasm');
    const destinations = [
        path.resolve(__dirname, 'src/mcp/sql-wasm.wasm'),
    ];

    for (const dest of destinations) {
        if (!fs.existsSync(dest)) {
            fs.copyFileSync(wasmSrc, dest);
        }
    }
};
