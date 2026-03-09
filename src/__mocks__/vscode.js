// Jest mock for the 'vscode' module.
// ArtifactDB.ts uses vscode.window.showWarningMessage in flushAsync error path.
module.exports = {
    window: {
        showWarningMessage: jest.fn(),
        showErrorMessage: jest.fn(),
        showInformationMessage: jest.fn(),
    },
    workspace: {
        workspaceFolders: [],
    },
    Uri: {
        file: (f) => ({ fsPath: f, scheme: 'file' }),
        joinPath: (...parts) => ({ fsPath: parts.join('/') }),
    },
    commands: {
        executeCommand: jest.fn(),
    },
};
