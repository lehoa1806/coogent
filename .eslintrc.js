// @ts-check
/** @type {import('eslint').Linter.Config} */
module.exports = {
    root: true,
    parser: '@typescript-eslint/parser',
    parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: __dirname,
        sourceType: 'module',
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
    rules: {
        // Allow unused vars with _ prefix (common pattern in this codebase)
        '@typescript-eslint/no-unused-vars': ['warn', {
            argsIgnorePattern: '^_',
            varsIgnorePattern: '^_',
        }],
        // Warn on explicit any — goal is to reduce over time
        '@typescript-eslint/no-explicit-any': 'warn',
        // Consistent return statements
        'consistent-return': 'off', // TypeScript handles this via noImplicitReturns
        // Allow empty catch blocks (used for best-effort cleanup)
        'no-empty': ['error', { allowEmptyCatch: true }],
        // Allow non-null assertions (common in VS Code extension code)
        '@typescript-eslint/no-non-null-assertion': 'off',
    },
    ignorePatterns: [
        'out/',
        'node_modules/',
        'webview-ui/',
        '*.js',         // Don't lint compiled output
        '!.eslintrc.js', // But DO lint this config file
    ],
};
