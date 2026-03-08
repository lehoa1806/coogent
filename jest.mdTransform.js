// jest.mdTransform.js — Transform .md files into ES module default exports.
// Mirrors esbuild's `loader: { '.md': 'text' }` behavior for Jest tests.

'use strict';

module.exports = {
    process(sourceText) {
        return {
            code: `module.exports = ${JSON.stringify(sourceText)};`,
        };
    },
};
