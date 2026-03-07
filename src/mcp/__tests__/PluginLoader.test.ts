// ─────────────────────────────────────────────────────────────────────────────
// PluginLoader.test.ts — Tests for MCP plugin discovery and lifecycle
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { PluginLoader } from '../PluginLoader.js';
import type { PluginContext } from '../MCPPlugin.js';

// Stub context — plugins in tests won't register real handlers
const stubCtx: PluginContext = {
    server: {} as any,
    db: {} as any,
    workspaceRoot: '/stub',
};

describe('PluginLoader', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-loader-test-'));
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('returns empty array when plugins directory does not exist', async () => {
        const loader = new PluginLoader(tmpDir);
        const plugins = await loader.loadAll(stubCtx);
        expect(plugins).toEqual([]);
    });

    it('returns empty array when plugins directory is empty', async () => {
        await fs.mkdir(path.join(tmpDir, '.coogent', 'plugins'), { recursive: true });
        const loader = new PluginLoader(tmpDir);
        const plugins = await loader.loadAll(stubCtx);
        expect(plugins).toEqual([]);
    });

    it('skips plugin directory without plugin.json', async () => {
        const pluginDir = path.join(tmpDir, '.coogent', 'plugins', 'bad-plugin');
        await fs.mkdir(pluginDir, { recursive: true });
        await fs.writeFile(path.join(pluginDir, 'index.js'), 'console.log("hello")');

        const loader = new PluginLoader(tmpDir);
        const plugins = await loader.loadAll(stubCtx);
        expect(plugins).toEqual([]);
    });

    it('skips plugin with invalid manifest JSON', async () => {
        const pluginDir = path.join(tmpDir, '.coogent', 'plugins', 'bad-json');
        await fs.mkdir(pluginDir, { recursive: true });
        await fs.writeFile(path.join(pluginDir, 'plugin.json'), 'not valid json {{{');

        const loader = new PluginLoader(tmpDir);
        const plugins = await loader.loadAll(stubCtx);
        expect(plugins).toEqual([]);
    });

    it('skips plugin with missing required manifest fields', async () => {
        const pluginDir = path.join(tmpDir, '.coogent', 'plugins', 'incomplete');
        await fs.mkdir(pluginDir, { recursive: true });
        await fs.writeFile(
            path.join(pluginDir, 'plugin.json'),
            JSON.stringify({ id: 'test' }) // missing name and main
        );

        const loader = new PluginLoader(tmpDir);
        const plugins = await loader.loadAll(stubCtx);
        expect(plugins).toEqual([]);
    });

    it('loads and activates a valid plugin', async () => {
        const pluginDir = path.join(tmpDir, '.coogent', 'plugins', 'valid-plugin');
        await fs.mkdir(pluginDir, { recursive: true });

        await fs.writeFile(
            path.join(pluginDir, 'plugin.json'),
            JSON.stringify({
                id: 'test-plugin',
                name: 'Test Plugin',
                main: 'index.js',
            })
        );

        // Create a valid plugin module using CommonJS (jest uses CJS)
        await fs.writeFile(
            path.join(pluginDir, 'index.js'),
            `
            let activated = false;
            module.exports = {
                activate() { activated = true; },
                deactivate() { activated = false; },
                get isActivated() { return activated; },
            };
            `
        );

        const loader = new PluginLoader(tmpDir);
        const plugins = await loader.loadAll(stubCtx);

        expect(plugins).toHaveLength(1);
        expect(plugins[0].manifest.id).toBe('test-plugin');
        expect(plugins[0].manifest.name).toBe('Test Plugin');
    });

    it('skips duplicate plugin IDs', async () => {
        const dir1 = path.join(tmpDir, '.coogent', 'plugins', 'plugin-a');
        const dir2 = path.join(tmpDir, '.coogent', 'plugins', 'plugin-b');
        await fs.mkdir(dir1, { recursive: true });
        await fs.mkdir(dir2, { recursive: true });

        const manifest = JSON.stringify({
            id: 'same-id',
            name: 'Plugin',
            main: 'index.js',
        });

        const moduleCode = `module.exports = { activate() {} };`;

        await fs.writeFile(path.join(dir1, 'plugin.json'), manifest);
        await fs.writeFile(path.join(dir1, 'index.js'), moduleCode);
        await fs.writeFile(path.join(dir2, 'plugin.json'), manifest);
        await fs.writeFile(path.join(dir2, 'index.js'), moduleCode);

        const loader = new PluginLoader(tmpDir);
        const plugins = await loader.loadAll(stubCtx);

        // Only the first one should load
        expect(plugins).toHaveLength(1);
    });

    it('disposeAll calls deactivate on loaded plugins', async () => {
        const pluginDir = path.join(tmpDir, '.coogent', 'plugins', 'disposable');
        await fs.mkdir(pluginDir, { recursive: true });

        await fs.writeFile(
            path.join(pluginDir, 'plugin.json'),
            JSON.stringify({ id: 'disposable', name: 'Disposable', main: 'index.js' })
        );

        await fs.writeFile(
            path.join(pluginDir, 'index.js'),
            `
            let deactivated = false;
            module.exports = {
                activate() {},
                deactivate() { deactivated = true; },
                get isDeactivated() { return deactivated; },
            };
            `
        );

        const loader = new PluginLoader(tmpDir);
        await loader.loadAll(stubCtx);

        expect(loader.getLoadedPlugins()).toHaveLength(1);

        await loader.disposeAll();

        expect(loader.getLoadedPlugins()).toHaveLength(0);
    });

    it('error in one plugin does not prevent loading others', async () => {
        const goodDir = path.join(tmpDir, '.coogent', 'plugins', 'good-plugin');
        const badDir = path.join(tmpDir, '.coogent', 'plugins', 'bad-plugin');
        await fs.mkdir(goodDir, { recursive: true });
        await fs.mkdir(badDir, { recursive: true });

        // Good plugin
        await fs.writeFile(
            path.join(goodDir, 'plugin.json'),
            JSON.stringify({ id: 'good', name: 'Good', main: 'index.js' })
        );
        await fs.writeFile(
            path.join(goodDir, 'index.js'),
            `module.exports = { activate() {} };`
        );

        // Bad plugin — activate throws
        await fs.writeFile(
            path.join(badDir, 'plugin.json'),
            JSON.stringify({ id: 'bad', name: 'Bad', main: 'index.js' })
        );
        await fs.writeFile(
            path.join(badDir, 'index.js'),
            `module.exports = { activate() { throw new Error("boom"); } };`
        );

        const loader = new PluginLoader(tmpDir);
        const plugins = await loader.loadAll(stubCtx);

        // Only the good plugin loaded despite the bad one throwing
        expect(plugins).toHaveLength(1);
        expect(plugins[0].manifest.id).toBe('good');
    });
});
