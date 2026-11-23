import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { formatContentionSummary, ZedKnipServer } from '../src/wrapper.mjs';
import fixtures from './fixtures/contention-descriptors.js';
import { TextDocument } from './language-server-stub.js';

const ROOT = '/workspace';
const ambiguousExport = fixtures['barrel.ts'].contention.apple;

test('formatContentionSummary formats barrel contention summary', () => {
  const summary = formatContentionSummary(
    `${ROOT}/fruits.ts`,
    { importLocations: [{ filePath: `${ROOT}/index.ts`, line: 1, col: 10 }] },
    ambiguousExport,
    ROOT
  );
  assert.equal(summary, '► imported 1x / ambiguous at barrel.ts');
});

test('handleHover renders export usage and contention tree', async () => {
  const server = new ZedKnipServer();
  const uri = pathToFileURL(`${ROOT}/fruits.ts`).href;
  const filePath = fileURLToPath(uri);

  server.documents.set(uri, TextDocument.create(uri, 'typescript', 1, 'export const apple = 1;\n'));
  server.fileDescriptors.set(filePath.replaceAll('\\', '/'), {
    internalImports: [],
    exports: [
      {
        identifier: 'apple',
        line: 1,
        col: 14,
        importLocations: [{ filePath: `${ROOT}/index.ts`, line: 1, col: 34 }],
        entryPaths: new Set(),
      },
    ],
    cycles: [],
    contention: {
      apple: ambiguousExport,
    },
  });

  const hover = await server.handleHover({
    textDocument: { uri },
    position: { line: 0, character: 15 },
  });

  assert.ok(hover);
  assert.match(hover.contents.value, /1 file imports \*\*apple\*\*/);
  assert.match(hover.contents.value, /\*\*► Export Contention\*\*/);
  assert.match(hover.contents.value, /Ambiguous at barrel\.ts/);
});

test('handleHover renders circular dependency chain on import line', async () => {
  const server = new ZedKnipServer();
  const uri = pathToFileURL(`${ROOT}/circular-a.ts`).href;
  const filePath = fileURLToPath(uri);
  const bPath = fileURLToPath(pathToFileURL(`${ROOT}/circular-b.ts`).href);
  const cPath = fileURLToPath(pathToFileURL(`${ROOT}/circular-c.ts`).href);

  server.documents.set(uri, TextDocument.create(uri, 'typescript', 1, "import { b } from './circular-b.ts';\n"));
  server.fileDescriptors.set(filePath.replaceAll('\\', '/'), {
    internalImports: [
      {
        identifier: 'b',
        filePath: bPath,
        importLine: 1,
        col: 10,
      },
    ],
    exports: [],
    cycles: [[filePath, bPath, cPath, filePath]],
    contention: {},
  });

  const hover = await server.handleHover({
    textDocument: { uri },
    position: { line: 0, character: 20 },
  });

  assert.ok(hover);
  assert.match(hover.contents.value, /Circular dependency/);
  assert.match(hover.contents.value, /circular-b\.ts/);
  assert.match(hover.contents.value, /circular-c\.ts/);
});

test('module graph refresh updates dependency hover data (before.js -> after.js) and refreshes inlay hints', async () => {
  const server = new ZedKnipServer();
  const pkgUri = pathToFileURL(`${ROOT}/package.json`).href;
  const beforeUri = pathToFileURL(`${ROOT}/before.js`).href;
  const afterUri = pathToFileURL(`${ROOT}/after.js`).href;
  const beforePath = fileURLToPath(beforeUri);
  const afterPath = fileURLToPath(afterUri);

  server.documents.set(
    pkgUri,
    TextDocument.create(pkgUri, 'json', 1, '{\n  "dependencies": {\n    "chalk": "*"\n  }\n}\n')
  );
  server.documents.set(beforeUri, TextDocument.create(beforeUri, 'javascript', 1, "import chalk from 'chalk';\n"));
  server.documents.set(afterUri, TextDocument.create(afterUri, 'javascript', 1, "import chalk from 'chalk';\n"));

  server.packageJsonDescriptor = {
    dependenciesUsage: {
      chalk: {
        imports: [{ filePath: beforePath, line: 1, col: 1 }],
      },
    },
  };

  const beforeHover = await server.handleHover({
    textDocument: { uri: pkgUri },
    position: { line: 2, character: 6 },
  });
  assert.ok(beforeHover);
  assert.match(beforeHover.contents.value, /before\.js/);

  server.packageJsonDescriptor = {
    dependenciesUsage: {
      chalk: {
        imports: [{ filePath: afterPath, line: 1, col: 1 }],
      },
    },
  };
  server.publishAllDiagnostics();

  assert.equal(server.inlayRefreshCount, 1);

  const afterHover = await server.handleHover({
    textDocument: { uri: pkgUri },
    position: { line: 2, character: 6 },
  });
  assert.ok(afterHover);
  assert.match(afterHover.contents.value, /after\.js/);
  assert.doesNotMatch(afterHover.contents.value, /before\.js/);
});

test('handleInlayHints returns import count, contention badge, and circular hint', async () => {
  const server = new ZedKnipServer();
  const uri = pathToFileURL(`${ROOT}/fruits.ts`).href;
  const filePath = fileURLToPath(uri);
  const depPath = fileURLToPath(pathToFileURL(`${ROOT}/vegetables.ts`).href);

  server.documents.set(
    uri,
    TextDocument.create(uri, 'typescript', 1, "import { b } from './vegetables.ts';\nexport const apple = 1;\n")
  );
  server.fileDescriptors.set(filePath.replaceAll('\\', '/'), {
    internalImports: [
      {
        identifier: 'b',
        filePath: depPath,
        importLine: 1,
        col: 10,
      },
    ],
    exports: [
      {
        identifier: 'apple',
        line: 2,
        col: 14,
        importLocations: [{ filePath: `${ROOT}/index.ts`, line: 1, col: 34 }],
        entryPaths: new Set(),
      },
    ],
    cycles: [[filePath, depPath, filePath]],
    contention: {
      apple: ambiguousExport,
    },
  });

  const hints = await server.handleInlayHints({
    textDocument: { uri },
  });

  assert.equal(hints.length, 2);
  assert.equal(hints[0].label[0].value, '↻ 1 import');
  assert.match(hints[0].label[1].value, /‼︎ ambiguous/);
  assert.equal(hints[1].label[0].value, '↻ circular');
});

test('filterDiagnosticsForDocument removes export diagnostic when JSDoc tag is added', () => {
  const server = new ZedKnipServer();
  const uri = 'file:///workspace/fruits.ts';

  server.documents.set(
    uri,
    TextDocument.create(uri, 'typescript', 1, '/** @internal */\nexport const DESCRIPTION = "test";\n')
  );

  const filtered = server.filterDiagnosticsForDocument(uri, [
    {
      code: 'exports',
      range: {
        start: { line: 1, character: 13 },
        end: { line: 1, character: 24 },
      },
      message: 'Unused exported variable: DESCRIPTION',
    },
  ]);

  assert.equal(filtered.length, 0);
});
