// ─────────────────────────────────────────────────────────────────────────────
// S2-7: ESLint configuration for Coogent
// ─────────────────────────────────────────────────────────────────────────────
// Uses @typescript-eslint/parser for TypeScript-aware linting.
// Start with conservative rules — ratchet up over time.

/** @type {import('eslint').Linter.Config} */
module.exports = {
    root: true,
    parser: '@typescript-eslint/parser',
    parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        project: './tsconfig.json',
    },
    plugins: ['@typescript-eslint'],
    extends: [
        'eslint:recommended',
        'plugin:@typescript-eslint/recommended',
    ],
    env: {
        node: true,
        es2022: true,
    },
    ignorePatterns: [
        'out/',
        'node_modules/',
        'webview-ui/',
        '*.js',
        '*.cjs',
    ],
    rules: {
        // ── Warnings (ratchet up to errors over time) ────────────────────
        '@typescript-eslint/no-unused-vars': ['warn', {
            argsIgnorePattern: '^_',
            varsIgnorePattern: '^_',
        }],
        '@typescript-eslint/no-explicit-any': 'warn',

        // ── Errors ───────────────────────────────────────────────────────
        'consistent-return': 'error',
        'no-duplicate-imports': 'error',

        // ── Disabled (too noisy for existing codebase) ───────────────────
        '@typescript-eslint/no-inferrable-types': 'off',
        '@typescript-eslint/ban-ts-comment': 'off',
    },
};
