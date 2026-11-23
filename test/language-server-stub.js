import { registerHooks } from 'node:module';

const stubUrl = import.meta.url;
const STUBBED_SPECIFIERS = new Set([
  'knip/session',
  './node_modules/@knip/language-server/src/server.js',
  'vscode-languageserver/node',
  'vscode-languageserver-textdocument',
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (STUBBED_SPECIFIERS.has(specifier)) {
      return { url: stubUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

export const SIDE_EFFECTS = '__side_effects__';
export const DidChangeWatchedFilesNotification = {
  type: 'workspace/didChangeWatchedFiles',
};

export const TextDocument = {
  create(uri, languageId, version, content) {
    const lines = content.split(/\r?\n/);
    return {
      uri,
      languageId,
      version,
      lineCount: lines.length,
      getText(range) {
         if (!range) return content;
         return lines.slice(range.start.line, range.end.line + 1).join('\n');
       },
      offsetAt(position) {
        let offset = 0;
        for (let i = 0; i < position.line && i < lines.length; i++) {
          offset += lines[i].length + 1;
        }
        return offset + position.character;
      },
    };
  },
};

export class LanguageServer {
  constructor() {
    this.cwd = '/workspace';
    this.session = {};
    this.initializing = null;
    this.initConfig = {};
    this.documents = new Map();
    this.documents.onDidChangeContent = () => {};
    this.documents.onDidSave = () => {};
    this.fileDescriptors = new Map();
    this.packageJsonDescriptor = { dependenciesUsage: {} };
    this.inlayRefreshCount = 0;
    this.workspaceConfig = {};
    this.connection = {
      onInitialize: () => {},
      onInitialized: () => {},
      onHover: handler => {
        this.hoverHandler = handler;
      },
      onRequest: (method, handler) => {
        if (method === 'textDocument/inlayHint') this.inlayHintHandler = handler;
      },
      onExecuteCommand: handler => {
        this.executeCommandHandler = handler;
      },
      sendDiagnostics: () => {},
      sendRequest: async method => {
        if (method === 'workspace/inlayHint/refresh') this.inlayRefreshCount++;
      },
      workspace: {
        getConfiguration: async () => this.workspaceConfig,
      },
      client: {
        register: async () => {},
      },
      console: {
        log: () => {},
        warn: () => {},
        error: () => {},
      },
    };
    this.setupHandlers();
  }
  setupHandlers() {}
  async startSession() {}
  async restart() {}
  publishAllDiagnostics() {}
  getFileDescriptor(filePath) {
    const posix = filePath.replaceAll('\\', '/');
    return this.fileDescriptors.get(posix) ?? this.fileDescriptors.get(posix.replace(/^[A-Za-z]:/, ''));
  }
  getPackageJsonDescriptor() {
    return this.packageJsonDescriptor;
  }
}
