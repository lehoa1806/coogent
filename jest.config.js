module.exports = {
    globalSetup: './jest.globalSetup.js',
    preset: 'ts-jest',
    testEnvironment: 'node',
    testMatch: ['**/__tests__/**/*.test.ts'],
    testPathIgnorePatterns: ['/node_modules/', '/webview-ui/'],
    moduleNameMapper: {
        '^(\\.{1,2}/.*)\\.js$': '$1',
        '^vscode$': '<rootDir>/src/__mocks__/vscode.js',
    },
    transform: {
        '^.+\\.ts$': ['ts-jest', { diagnostics: { ignoreCodes: ['TS151002'] } }],
        '^.+\\.md$': '<rootDir>/jest.mdTransform.js',
    },
    moduleFileExtensions: ['ts', 'js', 'json', 'md'],
    // S2-2: Coverage thresholds
    collectCoverageFrom: [
        'src/**/*.ts',
        '!src/**/__tests__/**',
        '!src/**/*.d.ts',
    ],
    coverageThreshold: {
        global: {
            lines: 70,
            branches: 60,
            functions: 65,
            statements: 70,
        },
    },
};
