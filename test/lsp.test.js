import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { startServer } from './lsp.test-utils.js';

const packageJson = `${JSON.stringify({ name: 'fixture', private: true, type: 'module', packageManager: 'pnpm@12.21.0' }, null, 2)}\n`;
const knipJson = `${JSON.stringify({ entry: ['src/index.ts'], project: ['src/**/*.ts'] }, null, 2)}\n`;
const lib = 'export const apple = 1;\nexport const pear = 2;\n';
const index = "import { apple } from './lib.ts';\nconsole.log(apple);\n";

const files = {
  'package.json': packageJson,
  'knip.json': knipJson,
  'src/lib.ts': lib,
  'src/index.ts': index,
};

const withoutPackage = {
  'knip.json': knipJson,
  'src/lib.ts': lib,
  'src/index.ts': index,
};

const withoutConfig = {
  'package.json': packageJson,
  'src/lib.ts': lib,
  'src/index.ts': index,
};

const uriOf = (server, name) => pathToFileURL(path.join(server.projectDir, name)).href;

describe('knip language server', () => {
  const mainSettings = {};
  const noConfigSettings = {};
  const noPackageSettings = {};
  let main;
  let noConfig;
  let noPackageData;

  before(async () => {
    [main, noConfig, noPackageData] = await Promise.all([
      startServer({
        files,
        settings: mainSettings,
        initializationOptions: { cwd: '.', config: { deferSession: true } },
        waitForGraph: false,
      }),
      startServer({
        files: withoutConfig,
        settings: noConfigSettings,
        initializationOptions: { cwd: '.', config: { deferSession: true } },
        waitForGraph: false,
      }),
      startServer({
        files: withoutPackage,
        settings: noPackageSettings,
        initializationOptions: { cwd: '.', config: { deferSession: true } },
        waitForGraph: false,
      }),
    ]);
    const initialRefresh = main.client.waitForInlayRefresh();
    const initialBuilt = main.client.waitForNotification('knip.moduleGraphBuilt');
    await main.client.request('knip.start');
    await Promise.all([initialRefresh, initialBuilt]);
  });

  after(async () => {
    await Promise.all([main.close(), noConfig.close(), noPackageData.close()]);
  });

  test('starts a normal package', async () => {
    const results = await main.client.request('knip.getResults');
    assert.ok(results);
  });

  test('publishes diagnostics from the real module graph', () => {
    const diagnostics = main.client.diagnostics.get(uriOf(main, 'src/lib.ts'));
    assert.ok(diagnostics?.some(diagnostic => diagnostic.code === 'exports'));
  });

  test('hover on an export lists the importer', async () => {
    const uri = uriOf(main, 'src/lib.ts');
    const hover = await main.client.request('textDocument/hover', {
      textDocument: { uri },
      position: { line: 0, character: 14 },
    });
    assert.match(hover.contents.value, /index\.ts/);
  });

  test('inlay hints show the import count', async () => {
    const uri = uriOf(main, 'src/lib.ts');
    const hints = await main.client.request('textDocument/inlayHint', {
      textDocument: { uri },
      range: { start: { line: 0, character: 0 }, end: { line: 20, character: 0 } },
    });
    const labels = hints.flatMap(hint => hint.label);
    assert.ok(labels.some(label => label.value === '↻ 1 import'));
  });

  test('shows the install command instead of running it', async () => {
    const message = main.client.waitForNotification('window/showMessage');
    await main.client.request('workspace/executeCommand', {
      command: 'knip.installDependency',
      arguments: ['chalk', 'dependencies', main.projectDir],
    });
    const notification = await message;
    assert.match(notification.message, /pnpm add chalk/);
  });

  test('pushes an inlay hint refresh after a module graph rebuild', async () => {
    const beforeCount = main.client.state.inlayRefreshes;
    const refreshed = main.client.waitForInlayRefresh();
    const built = main.client.waitForNotification('knip.moduleGraphBuilt');
    await main.client.request('knip.restart');
    await Promise.all([built, refreshed]);
    assert.ok(main.client.state.inlayRefreshes > beforeCount);
  });

  test('skips when disabled', async () => {
    await main.client.request('knip.stop');
    mainSettings.enabled = false;
    await main.client.request('knip.start');
    const results = await main.client.request('knip.getResults');
    delete mainSettings.enabled;
    assert.equal(results, null);
  });

  test('skips when requireConfig is set and no config exists', async () => {
    noConfigSettings.requireConfig = true;
    await noConfig.client.request('knip.start');
    const results = await noConfig.client.request('knip.getResults');
    assert.equal(results, null);
  });

  test('starts when requireConfig finds a config file', async () => {
    mainSettings.requireConfig = true;
    await main.client.request('knip.start');
    const results = await main.client.request('knip.getResults');
    delete mainSettings.requireConfig;
    assert.ok(results);
    await main.client.request('knip.stop');
  });

  test('skips a workspace without package.json', async () => {
    await noPackageData.client.request('knip.start');
    const results = await noPackageData.client.request('knip.getResults');
    assert.equal(results, null);
  });
});
