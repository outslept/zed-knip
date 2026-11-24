import { exec } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

const serverModuleUrl = new URL('./server.js', import.meta.resolve('@knip/language-server'));
const { LanguageServer } = await import(serverModuleUrl);
const requireFromServer = createRequire(serverModuleUrl);

const { SESSION_LOADING } = await import(new URL('./constants.js', serverModuleUrl));
const { KNIP_CONFIG_LOCATIONS } = await import(pathToFileURL(requireFromServer.resolve('knip/session')));

const { DidChangeWatchedFilesNotification } = requireFromServer('vscode-languageserver/node');
const { TextDocument } = requireFromServer('vscode-languageserver-textdocument');

const MAX_TOTAL_DEP_SNIPPETS = 30;
const MAX_DEP_SNIPPETS_PER_FILE = 3;
const END_OF_LINE_COL = 10000;

const REGEXP_ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;
const MD_ESCAPE_RE = /[\\[\]*_`~]/g;
const PACKAGE_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;
const DEP_SECTION_RES = [
  /"dependencies"\s*:\s*\{/g,
  /"devDependencies"\s*:\s*\{/g,
  /"peerDependencies"\s*:\s*\{/g,
  /"optionalDependencies"\s*:\s*\{/g,
];
const collator = new Intl.Collator();

const DEFAULT_CONFIG = {
  enabled: true,
  requireConfig: false,
  deferSession: false,
  editor: {
    severity: 'default',
    exports: {
      codelens: { enabled: true },
      hover: { enabled: true, includeImportLocationSnippet: false, maxSnippets: 10, timeout: 300 },
      quickfix: { enabled: true, jsdocTags: ['@lintignore', '@internal', '@public'] },
      highlight: {
        dimExports: false,
        dimTypes: false,
        dimEnumMembers: false,
        dimDuplicates: false,
      },
    },
    dependencies: {
      hover: { enabled: true },
    },
  },
  imports: { enabled: true },
  exports: { enabled: true, contention: { enabled: true } },
};

/**
 * @param {Record<string, any>} target
 * @param {Record<string, any>} source
 */
function deepMerge(target, source) {
  const output = { ...target };
  if (!source || typeof source !== 'object') return output;
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    if (srcVal && typeof srcVal === 'object' && !Array.isArray(srcVal)) {
      output[key] = key in target ? deepMerge(target[key], srcVal) : srcVal;
    } else if (srcVal !== undefined) {
      output[key] = srcVal;
    }
  }
  return output;
}

// Normalize to forward slashes, uppercase drive letter on Windows
/** @param {string} value */
const toPosix = value => {
  const posix = value.includes('\\') ? value.replaceAll('\\', '/') : value;
  const c0 = posix.charCodeAt(0);
  if (posix.charCodeAt(1) === 58 && posix.charCodeAt(2) === 47 && c0 >= 97 && c0 <= 122) {
    return String.fromCharCode(c0 - 32) + posix.slice(1);
  }
  return posix;
};

/**
 * @param {string} filePath
 * @param {string} rootPrefix
 */
const toRelativePosix = (filePath, rootPrefix) => {
  const posix = toPosix(filePath);
  return posix.startsWith(rootPrefix) ? posix.slice(rootPrefix.length) : posix;
};

/** @param {string} value */
const isFilePath = value => value.charCodeAt(0) === 47 /* '/' */ || value.charCodeAt(1) === 58 /* ':' */;

/** @param {string} str */
const escapeRegExp = str => str.replace(REGEXP_ESCAPE_RE, '\\$&');

/** @param {string} text */
const escapeMd = text => {
  const s = text.includes('<') ? text.replaceAll('<', '‹') : text;
  return s.replace(MD_ESCAPE_RE, '\\$&');
};

/**
 * Format markdown link text with bold match highlights
 * @param {string} text
 * @param {RegExp} matchRegex
 * @param {string} boldText
 */
function formatHighlightedLinkText(text, matchRegex, boldText) {
  const chunks = text.split(matchRegex);
  if (chunks.length <= 1) return escapeMd(text);
  const escapedBold = `**${escapeMd(boldText)}**`;
  let result = '';
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i]) result += escapeMd(chunks[i]);
    if (i < chunks.length - 1) result += escapedBold;
  }
  return result || escapeMd(text);
}

/** @param {Array<Record<string, any>>} rows */
function dedupeContentionRows(rows) {
  const seen = new Set();
  const result = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const key = [row.label, row.filePath, row.line, row.col, row.icon, row.tooltip].join('\0');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(row);
  }
  return result;
}

/**
 * Build contention descriptor tree matching @knip/vscode ExportsTreeViewProvider
 * @param {any} details
 * @param {string} root
 */
export function createContentionDescriptors(details, root) {
  const rootPrefix = `${toPosix(root)}/`;
  const toRel = p => toRelativePosix(p, rootPrefix);

  /**
   * @param {any} binding
   * @param {string} icon
   * @param {string} role
   */
  const createBindingRow = (binding, icon, role) => {
    const tooltip = `${role}: ${binding.identifier}`;
    if (!isFilePath(binding.filePath)) {
      return {
        label: `${binding.filePath}:${binding.identifier}`,
        filePath: undefined,
        line: undefined,
        col: undefined,
        icon: undefined,
        tooltip,
      };
    }
    return {
      label: undefined,
      filePath: binding.filePath,
      line: binding.line,
      col: binding.col,
      icon,
      tooltip,
    };
  };

  if (!details?.sites?.length) {
    const rows = [];
    const branching = [...(details?.branching ?? [])].sort(collator.compare);
    for (let i = 0; i < branching.length; i++) {
      rows.push({
        label: undefined,
        filePath: branching[i],
        line: undefined,
        col: undefined,
        icon: '◇',
        tooltip: 'Contention: branch location',
      });
    }
    const conflict = [...(details?.conflict ?? [])].sort(collator.compare);
    for (let i = 0; i < conflict.length; i++) {
      rows.push({
        label: undefined,
        filePath: conflict[i],
        line: undefined,
        col: undefined,
        icon: '‼︎',
        tooltip: 'Contention: conflict location',
      });
    }
    return dedupeContentionRows(rows);
  }

  const rows = [];
  for (let i = 0; i < details.sites.length; i++) {
    const site = details.sites[i];
    const relSite = toRel(site.filePath);
    const origins = [...(site.origins ?? [])].sort((a, b) =>
      collator.compare(toRel(a.filePath), toRel(b.filePath))
    );
    const count = origins.length;

    let icon = '►';
    let originIcon = '►';
    let role = 'Origin binding';
    let tooltip = `Contention at ${relSite}: ${site.identifier}`;

    if (site.kind === 'ambiguous') {
      icon = '‼︎';
      originIcon = '‼︎';
      role = 'Competing binding';
      tooltip = `Ambiguous at ${relSite}: ${site.identifier} resolves to ${count} binding${count === 1 ? '' : 's'}`;
    } else if (site.kind === 'shadowed') {
      icon = '⊘';
      originIcon = '⊘';
      role = 'Hidden binding';
      tooltip = `Shadowing at ${relSite}: ${site.identifier} hides ${count} binding${count === 1 ? '' : 's'}`;
    } else if (site.kind === 'converged') {
      icon = '◇';
      originIcon = '◇';
      role = 'Origin binding';
      const sources = (site.sources ?? []).map(toRel).join(', ');
      tooltip = `Converged at ${relSite}: ${site.identifier} arrives through ${sources}`;
    }

    const children = [];
    for (let j = 0; j < origins.length; j++) {
      children.push(createBindingRow(origins[j], originIcon, role));
    }
    if (site.kind === 'shadowed' && site.winner) {
      children.push(createBindingRow(site.winner, '✓', 'Winning binding'));
    }

    rows.push({
      label: undefined,
      filePath: site.filePath,
      line: site.line,
      col: site.col,
      icon,
      tooltip,
      children: dedupeContentionRows(children),
    });
  }

  return dedupeContentionRows(rows);
}

/**
 * Format summary description for an export with contention
 * @param {string} filePath
 * @param {any} _export
 * @param {any} details
 * @param {string} root
 */
export function formatContentionSummary(filePath, _export, details, root) {
  const rootPrefix = `${toPosix(root)}/`;
  const importedCount = _export.importLocations?.length ?? 0;
  if (!details?.sites?.length) {
    const count = (details?.branching?.length ?? 0) + (details?.conflict?.length ?? 0);
    return `► imported ${importedCount}x / contention ${count}x`;
  }
  const firstSite = details.sites[0];
  const kindLabel = firstSite.kind === 'shadowed' ? 'shadowing' : firstSite.kind;
  let sameKindCount = 0;
  for (let i = 0; i < details.sites.length; i++) {
    if (details.sites[i].kind === firstSite.kind) sameKindCount++;
  }
  const countSuffix = sameKindCount > 1 ? ` ${sameKindCount}x` : '';
  const atSuffix =
    toPosix(firstSite.filePath) !== toPosix(filePath)
      ? ` at ${toRelativePosix(firstSite.filePath, rootPrefix)}`
      : '';
  return `► imported ${importedCount}x / ${kindLabel}${countSuffix}${atSuffix}`;
}

export class ZedKnipServer extends LanguageServer {
  constructor() {
    super();
    this.cachedConfig = null;
    this.rawDiagnostics = new Map();
  }

  setupHandlers() {
    const origOnInitialize = this.connection.onInitialize.bind(this.connection);
    this.connection.onInitialize = handler => {
      origOnInitialize(params => {
        // Resolve relative initializationOptions.cwd against workspace folder root
        const uri = params.workspaceFolders?.[0]?.uri;
        if (uri && params.initializationOptions?.cwd) {
          const base = fileURLToPath(uri);
          const rawCwd = String(params.initializationOptions.cwd).trim();
          if (rawCwd) {
            params.initializationOptions.cwd = path.isAbsolute(rawCwd)
              ? path.normalize(rawCwd)
              : path.resolve(base, rawCwd);
          } else {
            params.initializationOptions.cwd = undefined;
          }
        }
        const result = handler(params);
        result.capabilities = {
          ...result.capabilities,
          hoverProvider: true,
          inlayHintProvider: true,
          executeCommandProvider: {
            commands: ['knip.installDependency'],
          },
        };
        return result;
      });
    };

    const origOnInitialized = this.connection.onInitialized.bind(this.connection);
    this.connection.onInitialized = handler => {
      origOnInitialized(params => {
        // Dynamically register file watcher without blocking session startup
        Promise.resolve(
          this.connection.client.register(DidChangeWatchedFilesNotification.type, {
            watchers: [{ globPattern: '**/*' }],
          })
        )
          .then(() => this.connection.console.log('Registered file watcher for workspace'))
          .catch(error => this.connection.console.warn(`Failed to register file watcher: ${error}`));
        return handler(params);
      });
    };

    if (typeof this.connection.sendDiagnostics === 'function') {
      const origSendDiagnostics = this.connection.sendDiagnostics.bind(this.connection);
      this.connection.sendDiagnostics = params => {
        this.rawDiagnostics.set(params.uri, params.diagnostics ?? []);
        return origSendDiagnostics({
          ...params,
          diagnostics: this.filterDiagnosticsForDocument(params.uri, params.diagnostics ?? []),
        });
      };
    }

    super.setupHandlers();

    if (typeof this.documents.onDidChangeContent === 'function') {
      this.documents.onDidChangeContent(event => {
        const uri = event.document.uri;
        const raw = this.rawDiagnostics.get(uri);
        if (raw && typeof this.connection.sendDiagnostics === 'function') {
          this.connection.sendDiagnostics({ uri, diagnostics: raw });
        }
      });
    }

    if (typeof this.documents.onDidSave === 'function') {
      this.documents.onDidSave(event => {
        this.handleFileChanges({ changes: [{ uri: event.document.uri, type: 2 }] });
      });
    }

    this.connection.onHover(params => this.handleHover(params));
    this.connection.onRequest('textDocument/inlayHint', params => this.handleInlayHints(params));
    this.connection.onExecuteCommand(params => this.handleExecuteCommand(params));
  }

  /**
   * Filter out export diagnostics that were resolved in the live buffer via Quick Fix
   * (e.g. removed `export` keyword or added `@lintignore` / `@internal` / `@public` JSDoc tag)
   * @param {string} uri
   * @param {Array<any>} diagnostics
   */
  filterDiagnosticsForDocument(uri, diagnostics) {
    if (!diagnostics.length || !uri.startsWith('file:')) return diagnostics;
    let text;
    const openDoc = this.documents.get(uri);
    if (openDoc) {
      text = typeof openDoc === 'string' ? openDoc : openDoc.getText();
    } else {
      try {
        text = readFileSync(this.normalizeUriToFilePath(uri), 'utf8');
      } catch {
        return diagnostics;
      }
    }
    if (!text) return diagnostics;

    const lines = text.split(/\r?\n/);
    const tags = this.cachedConfig?.editor?.exports?.quickfix?.jsdocTags ?? DEFAULT_CONFIG.editor.exports.quickfix.jsdocTags;

    return diagnostics.filter(diag => {
      const code = String(diag.code ?? '');
      if (
        code !== 'exports' &&
        code !== 'types' &&
        code !== 'nsExports' &&
        code !== 'nsTypes' &&
        code !== 'enumMembers' &&
        code !== 'namespaceMembers'
      ) {
        return true;
      }
      const colonIdx = diag.message ? diag.message.lastIndexOf(':') : -1;
      const identifier = colonIdx !== -1 ? diag.message.slice(colonIdx + 1).trim() : '';
      if (!identifier) return true;

      const origLine = diag.range?.start?.line ?? 0;
      const maxLine = Math.min(lines.length - 1, origLine + 4);
      const minLine = Math.max(0, origLine - 2);
      let declLine = -1;

      for (let l = origLine; l <= maxLine; l++) {
        if (lines[l]?.includes(identifier)) {
          declLine = l;
          break;
        }
      }
      if (declLine === -1) {
        for (let l = minLine; l < origLine; l++) {
          if (lines[l]?.includes(identifier)) {
            declLine = l;
            break;
          }
        }
      }
      if (declLine === -1) return false;

      // Check if `export` keyword was removed from the declaration
      let hasExportKeyword = false;
      for (let l = declLine; l >= Math.max(0, declLine - 3); l--) {
        if (/\bexport\b/.test(lines[l])) {
          hasExportKeyword = true;
          break;
        }
      }
      if (!hasExportKeyword) return false;

      // Check if a JSDoc comment immediately preceding the export contains an ignored tag
      let j = declLine - 1;
      while (j >= 0 && lines[j].trim() === '') j--;
      if (j >= 0 && lines[j].trim().endsWith('*/')) {
        const startLimit = Math.max(0, j - 15);
        for (let k = j; k >= startLimit; k--) {
          const commentLine = lines[k];
          for (let t = 0; t < tags.length; t++) {
            if (commentLine.includes(tags[t])) return false;
          }
          if (commentLine.includes('/**') || commentLine.includes('/*')) break;
        }
      }

      return true;
    });
  }

  /** @param {string} cwd */
  hasKnipConfig(cwd) {
    for (let i = 0; i < KNIP_CONFIG_LOCATIONS.length; i++) {
      if (existsSync(path.join(cwd, KNIP_CONFIG_LOCATIONS[i]))) return true;
    }
    try {
      const pkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8'));
      if (pkg && typeof pkg === 'object' && 'knip' in pkg) return true;
    } catch {}
    return false;
  }

  async start() {
    if (this.session) return;
    if (this.cwd && !existsSync(path.join(this.cwd, 'package.json'))) return;
    const config = await this.getConfig();
    if (config.enabled === false) return;
    if (config.requireConfig && this.cwd && !this.hasKnipConfig(this.cwd)) return;
    return super.start();
  }

  publishDiagnostics(newDiags) {
    super.publishDiagnostics(newDiags);
    this.connection.sendRequest('workspace/inlayHint/refresh').catch(() => {});
  }

  /** @param {string} uri */
  normalizeUriToFilePath(uri) {
    const filePath = fileURLToPath(uri);
    // Align Windows drive letter casing with this.cwd
    if (this.cwd && this.cwd.charCodeAt(1) === 58 && filePath.charCodeAt(1) === 58) {
      const cwdDrive = this.cwd.charCodeAt(0);
      const fileDrive = filePath.charCodeAt(0);
      if (cwdDrive !== fileDrive && (cwdDrive | 32) === (fileDrive | 32)) {
        return this.cwd[0] + filePath.slice(1);
      }
    }
    return filePath;
  }

  async getConfig() {
    let userConfig = this.initConfig ?? {};
    try {
      const workspaceConfig = await this.connection.workspace.getConfiguration('knip');
      userConfig = deepMerge(userConfig, workspaceConfig);
    } catch {}
    this.cachedConfig = deepMerge(DEFAULT_CONFIG, userConfig);
    return this.cachedConfig;
  }

  /** @param {import('vscode-languageserver/node').DidChangeWatchedFilesParams} params */
  async handleFileChanges(params) {
    const changes = params.changes;
    const filteredChanges = [];
    const cwdDrive = this.cwd && this.cwd.charCodeAt(1) === 58 ? this.cwd[0] : '';
    const cwdDriveLower = cwdDrive ? cwdDrive.charCodeAt(0) | 32 : 0;

    for (let i = 0; i < changes.length; i++) {
      const change = changes[i];
      const uri = change.uri;
      if (!uri.startsWith('file:')) continue;
      const posixUri = uri.includes('\\') ? uri.replaceAll('\\', '/') : uri;
      if (posixUri.includes('/.git/') || posixUri.includes('/node_modules/')) continue;

      if (cwdDrive) {
        const filePath = fileURLToPath(uri);
        if (filePath.charCodeAt(1) === 58 && (filePath.charCodeAt(0) | 32) === cwdDriveLower) {
          change.uri = pathToFileURL(cwdDrive + filePath.slice(1)).toString();
        }
      }
      filteredChanges.push(change);
    }

    if (filteredChanges.length === 0) return;
    return super.handleFileChanges({ changes: filteredChanges });
  }

  /** @param {string} filePath */
  getOrLoadDocument(filePath) {
    const uri = pathToFileURL(filePath).toString();
    const openDoc = this.documents.get(uri);
    if (openDoc) return openDoc;
    try {
      const content = readFileSync(filePath, 'utf8');
      return TextDocument.create(uri, 'plaintext', 0, content);
    } catch {
      return undefined;
    }
  }

  /** @param {string} filePath */
  getDocumentText(filePath) {
    const uri = pathToFileURL(filePath).toString();
    const openDoc = this.documents.get(uri);
    if (openDoc) return openDoc.getText();
    try {
      return readFileSync(filePath, 'utf8');
    } catch {
      return undefined;
    }
  }

  /** @param {import('vscode-languageserver/node').HoverParams} params */
  async handleHover(params) {
    if (!this.session) return null;
    const uri = params.textDocument.uri;
    if (!uri.startsWith('file:')) return null;

    const config = await this.getConfig();
    const filePath = this.normalizeUriToFilePath(uri);
    const root = toPosix(this.cwd ?? process.cwd());
    const position = params.position;

    if (path.basename(filePath) === 'package.json') {
      if (!config.editor?.dependencies?.hover?.enabled) return null;
      return this.getDependencyHoverContent(filePath, position, root);
    }

    const isShowContention = config.exports?.contention?.enabled !== false;
    const file = this.getFileDescriptor(filePath, { isShowContention });
    if (!file || file === SESSION_LOADING) return null;

    if (config.editor?.exports?.hover?.enabled) {
      const _export = this.findExportAtPosition(file, position);
      if (_export) {
        const maxSnippets = config.editor.exports.hover.maxSnippets ?? 10;
        const timeout = config.editor.exports.hover.timeout ?? 300;
        const includeImportLocationSnippet = config.editor.exports.hover.includeImportLocationSnippet ?? false;
        const parts = [];

        if (_export.importLocations.length > 0) {
          let snippets = [];
          if (maxSnippets !== 0) {
            snippets = this.collectExportHoverSnippets(_export.identifier, _export.importLocations, {
              timeout,
              includeImportLocationSnippet,
            });
          }
          parts.push(this.renderExportHover(_export, root, snippets, maxSnippets));
        } else if (_export.entryPaths?.size > 0) {
          parts.push(this.renderExportHoverEntryPaths(_export, toPosix(filePath), root));
        }

        const contentionDetails = file.contention?.[_export.identifier];
        if (contentionDetails) {
          const contentionMd = this.renderContentionHover(filePath, _export, contentionDetails, root);
          if (contentionMd) parts.push(contentionMd);
        }

        if (parts.length > 0) {
          return {
            contents: {
              kind: 'markdown',
              value: parts.length === 1 ? parts[0] : parts.join('\n\n---\n\n'),
            },
          };
        }
      }
    }

    const cycleHover = this.getImportCycleHoverAtPosition(file, position, root);
    if (cycleHover) {
      return {
        contents: {
          kind: 'markdown',
          value: cycleHover,
        },
      };
    }

    return null;
  }

  /**
   * @param {any} file
   * @param {import('vscode-languageserver/node').Position} position
   */
  findExportAtPosition(file, position) {
    const exportsList = file.exports;
    if (!exportsList?.length) return undefined;
    const posLine = position.line;
    const posChar = position.character;
    let lineFallback;

    for (let i = 0; i < exportsList.length; i++) {
      const _export = exportsList[i];
      if (posLine === _export.line - 1) {
        const col = _export.col - 1;
        const identifier = _export.identifier;
        if (identifier === 'default') return _export;
        if (posChar >= col && posChar <= col + identifier.length) return _export;
        if (
          !lineFallback ||
          (!file.contention?.[lineFallback.identifier] && file.contention?.[identifier]) ||
          (!lineFallback.importLocations?.length && _export.importLocations?.length)
        ) {
          lineFallback = _export;
        }
      }
      const subExports = _export.exports;
      if (subExports?.length) {
        for (let j = 0; j < subExports.length; j++) {
          const subExport = subExports[j];
          if (posLine === subExport.line - 1) {
            const col = subExport.col - 1;
            const identifier = subExport.identifier;
            if (posChar >= col && posChar <= col + identifier.length) return subExport;
            if (!lineFallback) lineFallback = subExport;
          }
        }
      }
    }
    return lineFallback;
  }

  /**
   * @param {any} file
   * @param {import('vscode-languageserver/node').Position} position
   * @param {string} root
   */
  getImportCycleHoverAtPosition(file, position, root) {
    if (!file.cycles?.length || !file.internalImports?.length) return null;
    const rootPrefix = `${root}/`;
    const imports = file.internalImports;
    const cycles = file.cycles;

    for (let i = 0; i < imports.length; i++) {
      const _import = imports[i];
      if (_import.importLine === undefined || position.line !== _import.importLine - 1) continue;
      const targetPosix = toPosix(_import.filePath);
      for (let j = 0; j < cycles.length; j++) {
        const cycle = cycles[j];
        if (toPosix(cycle[1]) === targetPosix) {
          const chain = cycle
            .map(p => {
              const rel = toRelativePosix(p, rootPrefix);
              const uri = pathToFileURL(p).toString();
              return `- [\`${escapeMd(rel)}\`](${uri})`;
            })
            .join('\n');
          return `**↻ Circular dependency**\n\n${chain}`;
        }
      }
    }
    return null;
  }

  /**
   * @param {string} identifier
   * @param {Array<{ filePath: string, line?: number, col?: number }>} locations
   * @param {{ timeout?: number, includeImportLocationSnippet?: boolean }} [options]
   */
  collectExportHoverSnippets(identifier, locations, options = {}) {
    const { timeout = 300, includeImportLocationSnippet = false } = options;
    if (!Array.isArray(locations) || locations.length === 0) return [];

    const startTime = Date.now();
    const snippets = [];
    const seen = new Set();
    const linesCache = new Map();
    const wordRegex = new RegExp(`\\b${escapeRegExp(identifier)}\\b`, 'g');
    const idLen = identifier.length;

    for (let index = 0; index < locations.length; index++) {
      const location = locations[index];
      if (!location?.filePath) continue;
      if (timeout > 0 && Date.now() - startTime > timeout) break;

      let lines = linesCache.get(location.filePath);
      if (!lines) {
        const text = this.getDocumentText(location.filePath);
        if (!text) continue;
        lines = text.split(/\r?\n/);
        linesCache.set(location.filePath, lines);
      }

      const zeroLine = Math.max((location.line ?? 1) - 1, 0);
      const zeroChar = Math.max((location.col ?? 1) - 1, 0);
      const fileSnippets = [];
      snippets[index] = fileSnippets;

      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const text = lines[lineIdx];
        if (!text.includes(identifier)) continue;

        wordRegex.lastIndex = 0;
        let match;
        while ((match = wordRegex.exec(text)) !== null) {
          const char = match.index;
          const endChar = char + idLen;

          // Skip the import statement itself unless explicitly configured
          if (!includeImportLocationSnippet && lineIdx === zeroLine && zeroChar >= char && zeroChar <= endChar) {
            continue;
          }

          const dedupeKey = `${location.filePath}:${lineIdx}`;
          if (seen.has(dedupeKey)) break;
          seen.add(dedupeKey);

          const start = Math.max(0, char - 30);
          const end = Math.min(text.length, endChar + 30);
          let snippet = text.slice(start, end);
          const trimStart = snippet.length - snippet.trimStart().length;
          const trimEnd = snippet.length - snippet.trimEnd().length;
          snippet = snippet.trim();
          if (start > 0 && trimStart === 0) snippet = `…${snippet}`;
          if (end < text.length && trimEnd === 0) snippet = `${snippet}…`;
          if (snippet.length > 60) snippet = `${snippet.slice(0, 60).trimEnd()}…`;

          fileSnippets.push({ line: lineIdx + 1, col: char + 1, snippet });
          break;
        }
      }

      if (fileSnippets.length > 1) {
        fileSnippets.sort((a, b) => a.line - b.line || a.col - b.col);
      }
    }

    return snippets;
  }

  /**
   * @param {any} _export
   * @param {string} root
   * @param {Array<Array<{ line: number, col: number, snippet: string }>>} snippets
   * @param {number} maxSnippets
   */
  renderExportHover(_export, root, snippets, maxSnippets) {
    const { identifier, importLocations } = _export;
    const uniqueFiles = new Set();
    for (let i = 0; i < importLocations.length; i++) {
      uniqueFiles.add(toPosix(importLocations[i].filePath));
    }
    const refs = uniqueFiles.size;
    const identifierMatch = new RegExp(`\\b${escapeRegExp(identifier)}\\b`, 'g');
    const rootPrefix = `${root}/`;
    const lines = [`${refs} file${refs > 1 ? 's' : ''} import${refs > 1 ? '' : 's'} **${escapeMd(identifier)}**`];

    const len = importLocations.length;
    const sortedIndices = Array.from({ length: len }, (_, i) => i);
    sortedIndices.sort((a, b) => collator.compare(importLocations[a].filePath, importLocations[b].filePath));

    let lastFilePath = '';
    for (let i = 0; i < sortedIndices.length; i++) {
      const index = sortedIndices[i];
      const loc = importLocations[index];
      const posixPath = toPosix(loc.filePath);
      const uri = pathToFileURL(loc.filePath).toString();
      const position = loc.line && loc.col ? `#${loc.line},${loc.col}` : loc.line ? `#${loc.line}` : '';
      const relativePath = toRelativePosix(posixPath, rootPrefix);

      if (posixPath !== lastFilePath) {
        lines.push(`[${escapeMd(relativePath)}](${uri}${position})`);
        lastFilePath = posixPath;
      }

      const snippetsForFile = snippets[index];
      if (!snippetsForFile?.length) continue;

      const limitedSnippets = maxSnippets < 0 ? snippetsForFile : snippetsForFile.slice(0, maxSnippets);
      for (let j = 0; j < limitedSnippets.length; j++) {
        const snippet = limitedSnippets[j];
        if (!snippet.snippet.includes(identifier)) continue;
        const linkText = formatHighlightedLinkText(snippet.snippet, identifierMatch, identifier);
        const lineCode = String(snippet.line).padStart(4, '\u00A0');
        lines.push(`\`${lineCode}\`\u00A0\u00A0[${linkText}](${uri}#${snippet.line},${snippet.col})`);
      }

      if (maxSnippets > 0 && snippetsForFile.length > maxSnippets) {
        const remaining = snippetsForFile.length - maxSnippets;
        lines.push(`…and ${remaining} more`);
      }
    }

    return lines.join('\\\n');
  }

  /**
   * @param {any} _export
   * @param {string} filePath
   * @param {string} root
   */
  renderExportHoverEntryPaths(_export, filePath, root) {
    const { identifier, entryPaths } = _export;
    const entryPathsArray = Array.from(entryPaths, p => toPosix(p));
    const isEntryFile = entryPathsArray.length === 1 && entryPathsArray[0] === filePath;
    const rootPrefix = `${root}/`;
    const header = isEntryFile
      ? `No files import **${escapeMd(identifier)}**; exported by entry file`
      : `No files import **${escapeMd(identifier)}**; re-exported by ${entryPathsArray.length} entry file${entryPathsArray.length > 1 ? 's' : ''}:`;
    if (isEntryFile) return header;

    const listItems = entryPathsArray.map(entryPath => {
      const url = pathToFileURL(entryPath).toString();
      const text = toRelativePosix(entryPath, rootPrefix);
      return `- [${escapeMd(text)}](${url})`;
    });
    return `${header}\n\n${listItems.join('\n')}`;
  }

  /**
   * @param {string} filePath
   * @param {any} _export
   * @param {any} contentionDetails
   * @param {string} root
   */
  renderContentionHover(filePath, _export, contentionDetails, root) {
    const descriptors = createContentionDescriptors(contentionDetails, root);
    if (descriptors.length === 0) return null;
    const rootPrefix = `${toPosix(root)}/`;
    const summary = formatContentionSummary(filePath, _export, contentionDetails, root);

    const formatLink = row => {
      if (!row.filePath) return `\`${escapeMd(row.label)}\``;
      const rel = toRelativePosix(row.filePath, rootPrefix);
      const uri = pathToFileURL(row.filePath).toString();
      const pos = row.line && row.col ? `#${row.line},${row.col}` : row.line ? `#${row.line}` : '';
      return `[${escapeMd(rel)}](${uri}${pos})`;
    };

    const lines = [];
    for (let i = 0; i < descriptors.length; i++) {
      const row = descriptors[i];
      lines.push(`- ${row.icon} ${row.tooltip} (${formatLink(row)})`);
      if (row.children?.length) {
        for (let j = 0; j < row.children.length; j++) {
          const child = row.children[j];
          const prefix = child.icon ? `${child.icon} ` : '';
          lines.push(`  - ${prefix}${formatLink(child)} — ${child.tooltip}`);
        }
      }
    }

    return `**► Export Contention** (${summary})\n\n${lines.join('\n')}`;
  }

  /**
   * @param {string} filePath
   * @param {import('vscode-languageserver/node').Position} position
   * @param {string} root
   */
  getDependencyHoverContent(filePath, position, root) {
    const doc = this.getOrLoadDocument(filePath);
    if (!doc) return null;

    const packageName = this.findDependencyAtPosition(doc, position);
    if (!packageName) return null;

    const pkgResult = this.getPackageJsonDescriptor();
    if (!pkgResult || pkgResult === SESSION_LOADING) return null;

    const usage = pkgResult.dependenciesUsage?.[packageName];
    if (!usage || usage.imports.length === 0) return null;

    const workspaceDir = `${toPosix(path.dirname(filePath))}/`;
    const imports = usage.imports.filter(_import => toPosix(_import.filePath).startsWith(workspaceDir));
    if (imports.length === 0) return null;

    const snippets = this.collectDependencySnippets(imports);
    const md = this.renderDependencyHover({ packageName, imports }, root, snippets);
    if (!md) return null;

    return {
      contents: {
        kind: 'markdown',
        value: md,
      },
    };
  }

  /**
   * @param {import('vscode-languageserver-textdocument').TextDocument} document
   * @param {import('vscode-languageserver/node').Position} position
   */
  findDependencyAtPosition(document, position) {
    const text = document.getText();
    const offset = document.offsetAt(position);
    let inDependencySection = false;

    for (let i = 0; i < DEP_SECTION_RES.length; i++) {
      const regex = DEP_SECTION_RES[i];
      regex.lastIndex = 0;
      const sectionMatch = regex.exec(text);
      if (!sectionMatch) continue;

      const sectionStart = sectionMatch.index;
      if (offset < sectionStart) continue;

      let braceCount = 1;
      let sectionEnd = sectionStart + sectionMatch[0].length;
      while (braceCount > 0 && sectionEnd < text.length) {
        const ch = text.charCodeAt(sectionEnd);
        if (ch === 123 /* '{' */) braceCount++;
        else if (ch === 125 /* '}' */) braceCount--;
        sectionEnd++;
      }

      if (offset <= sectionEnd) {
        inDependencySection = true;
        break;
      }
    }

    if (!inDependencySection) return undefined;

    // Extract package key directly from the hovered line without JSON.parse or per-key RegExp
    const lineText = document.getText({
      start: { line: position.line, character: 0 },
      end: { line: position.line + 1, character: 0 },
    });
    const firstQuote = lineText.indexOf('"');
    if (firstQuote === -1) return undefined;
    const secondQuote = lineText.indexOf('"', firstQuote + 1);
    if (secondQuote === -1) return undefined;
    const colonIdx = lineText.indexOf(':', secondQuote + 1);
    if (colonIdx === -1) return undefined;

    if (position.character >= firstQuote && position.character <= secondQuote) {
      return lineText.slice(firstQuote + 1, secondQuote);
    }
    return undefined;
  }

  /** @param {Array<{ filePath: string, line?: number, col?: number }>} imports */
  collectDependencySnippets(imports) {
    const snippets = [];
    const seen = new Set();
    const linesCache = new Map();

    for (let i = 0; i < imports.length; i++) {
      const _import = imports[i];
      if (!_import.filePath) continue;
      const dedupeKey = `${_import.filePath}:${_import.line ?? 'ref'}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      if (_import.line === undefined) {
        snippets.push({ filePath: _import.filePath, line: undefined, col: undefined, snippet: undefined });
        continue;
      }

      let lines = linesCache.get(_import.filePath);
      if (!lines) {
        const text = this.getDocumentText(_import.filePath);
        if (!text) continue;
        lines = text.split(/\r?\n/);
        linesCache.set(_import.filePath, lines);
      }

      const lineIndex = _import.line - 1;
      if (lineIndex < 0 || lineIndex >= lines.length) continue;
      snippets.push({
        filePath: _import.filePath,
        line: _import.line,
        col: _import.col,
        snippet: lines[lineIndex].trim(),
      });
    }
    return snippets;
  }

  /**
   * @param {{ packageName: string, imports: Array<any> }} usage
   * @param {string} root
   * @param {Array<{ filePath: string, line?: number, col?: number, snippet?: string }>} snippets
   */
  renderDependencyHover(usage, root, snippets) {
    const { packageName, imports } = usage;
    if (imports.length === 0) return null;

    const uniqueFiles = new Set();
    const binaryNames = new Set();
    for (let i = 0; i < imports.length; i++) {
      const _import = imports[i];
      uniqueFiles.add(toPosix(_import.filePath));
      if (_import.binaryName && _import.binaryName !== packageName) {
        binaryNames.add(_import.binaryName);
      }
    }

    const fileCount = uniqueFiles.size;
    const rootPrefix = `${root}/`;
    const packageNameMatch = new RegExp(`(?<=['"\`])${escapeRegExp(packageName)}(?=['"\`/])`, 'g');

    let header = `At least ${fileCount} file${fileCount > 1 ? 's' : ''} reference${fileCount > 1 ? '' : 's'} **${escapeMd(packageName)}**`;
    if (binaryNames.size > 0) header += ` (${[...binaryNames].join(', ')})`;
    const lines = [header];

    snippets.sort((a, b) => collator.compare(a.filePath, b.filePath));
    const snippetsByFile = new Map();
    for (let i = 0; i < snippets.length; i++) {
      const snippet = snippets[i];
      let group = snippetsByFile.get(snippet.filePath);
      if (!group) {
        group = [];
        snippetsByFile.set(snippet.filePath, group);
      }
      group.push(snippet);
    }

    let totalSnippetsShown = 0;
    for (const [filePath, fileSnippets] of snippetsByFile) {
      const relativePath = toRelativePosix(filePath, rootPrefix);
      const firstSnippet = fileSnippets[0];
      const uri = pathToFileURL(filePath).toString();
      const position = firstSnippet.line && firstSnippet.col ? `#${firstSnippet.line},${firstSnippet.col}` : '';
      lines.push(`[${escapeMd(relativePath)}](${uri}${position})`);

      if (totalSnippetsShown >= MAX_TOTAL_DEP_SNIPPETS) continue;

      const remainingBudget = MAX_TOTAL_DEP_SNIPPETS - totalSnippetsShown;
      const maxForThisFile = Math.min(MAX_DEP_SNIPPETS_PER_FILE, remainingBudget);
      const limitedSnippets = fileSnippets.slice(0, maxForThisFile);
      const snippetsOmittedInFile = fileSnippets.length - limitedSnippets.length;
      totalSnippetsShown += limitedSnippets.length;

      for (let i = 0; i < limitedSnippets.length; i++) {
        const snippet = limitedSnippets[i];
        if (!snippet.snippet) continue;
        const snippetPosition = snippet.line && snippet.col ? `#${snippet.line},${snippet.col}` : '';
        const linkText = formatHighlightedLinkText(snippet.snippet, packageNameMatch, packageName);
        const lineCode = String(snippet.line).padStart(4, '\u00A0');
        lines.push(`\`${lineCode}\`\u00A0\u00A0[${linkText}](${uri}${snippetPosition})`);
      }

      if (snippetsOmittedInFile > 0) {
        lines.push(`…and ${snippetsOmittedInFile} more`);
      }
    }

    return lines.join('\\\n');
  }

  /** @param {import('vscode-languageserver/node').InlayHintParams} params */
  async handleInlayHints(params) {
    if (!this.session) return null;
    const config = await this.getConfig();

    const uri = params.textDocument.uri;
    if (!uri.startsWith('file:')) return null;
    const filePath = this.normalizeUriToFilePath(uri);
    if (path.basename(filePath) === 'package.json') return null;

    const isShowContention = config.exports?.contention?.enabled !== false;
    const file = this.getFileDescriptor(filePath, { isShowContention });
    if (!file || file === SESSION_LOADING) return null;

    const hints = [];
    const range = params.range;

    if (config.editor?.exports?.codelens?.enabled && file.exports?.length) {
      const exportsList = file.exports;
      const seenExportLines = new Set();

      for (let i = 0; i < exportsList.length; i++) {
        const _export = exportsList[i];
        const size = _export.importLocations.length;
        const contentionDetails = isShowContention ? file.contention?.[_export.identifier] : undefined;
        if (size === 0 && !contentionDetails) continue;

        const line = Math.max(0, _export.line - 1);
        if (range && (line < range.start.line || line > range.end.line)) continue;
        if (seenExportLines.has(line)) continue;
        seenExportLines.add(line);

        const labelParts = [];
        if (size > 0) {
          const firstLoc = _export.importLocations[0];
          const targetLine = Math.max(0, (firstLoc.line ?? 1) - 1);
          const targetCol = Math.max(0, (firstLoc.col ?? 1) - 1);
          labelParts.push({
            value: `↻ ${size} import${size > 1 ? 's' : ''}`,
            location: {
              uri: pathToFileURL(firstLoc.filePath).toString(),
              range: {
                start: { line: targetLine, character: targetCol },
                end: { line: targetLine, character: targetCol },
              },
            },
          });
        }

        if (contentionDetails) {
          const firstSite = contentionDetails.sites?.[0];
          const kind = firstSite?.kind;
          const icon = kind === 'ambiguous' ? '‼︎' : kind === 'shadowed' ? '⊘' : '◇';
          const kindLabel = kind === 'shadowed' ? 'shadowing' : (kind ?? 'contention');
          const targetFile = firstSite?.filePath ?? contentionDetails.conflict?.[0] ?? contentionDetails.branching?.[0];
          const targetLine = Math.max(0, (firstSite?.line ?? 1) - 1);
          const targetCol = Math.max(0, (firstSite?.col ?? 1) - 1);

          labelParts.push({
            value: `${labelParts.length > 0 ? ' · ' : ''}${icon} ${kindLabel}`,
            ...(targetFile && isFilePath(targetFile)
              ? {
                  location: {
                    uri: pathToFileURL(targetFile).toString(),
                    range: {
                      start: { line: targetLine, character: targetCol },
                      end: { line: targetLine, character: targetCol },
                    },
                  },
                }
              : {}),
          });
        }

        // Place hint at the end of the line so it never splits function signatures
        hints.push({
          position: { line, character: END_OF_LINE_COL },
          label: labelParts,
          paddingLeft: true,
        });
      }
    }

    if (config.imports?.enabled !== false && file.cycles?.length && file.internalImports?.length) {
      const imports = file.internalImports;
      const cycles = file.cycles;
      const seenCycleLines = new Set();

      for (let i = 0; i < imports.length; i++) {
        const _import = imports[i];
        if (_import.importLine === undefined) continue;
        const line = Math.max(0, _import.importLine - 1);
        if (range && (line < range.start.line || line > range.end.line)) continue;
        if (seenCycleLines.has(line)) continue;

        const targetPosix = toPosix(_import.filePath);
        for (let j = 0; j < cycles.length; j++) {
          if (toPosix(cycles[j][1]) === targetPosix) {
            seenCycleLines.add(line);
            hints.push({
              position: { line, character: END_OF_LINE_COL },
              label: [
                {
                  value: '↻ circular',
                  location: {
                    uri: pathToFileURL(_import.filePath).toString(),
                    range: {
                      start: { line: 0, character: 0 },
                      end: { line: 0, character: 0 },
                    },
                  },
                },
              ],
              paddingLeft: true,
            });
            break;
          }
        }
      }
    }

    return hints.length > 0 ? hints : null;
  }

  // Walk up from startDir to find the lockfile or packageManager field
  /** @param {string} startDir */
  detectPackageManager(startDir) {
    let dir = startDir;
    const root = path.parse(dir).root;
    while (dir !== root) {
      if (existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
      if (existsSync(path.join(dir, 'yarn.lock'))) return 'yarn';
      if (existsSync(path.join(dir, 'package-lock.json'))) return 'npm';
      if (existsSync(path.join(dir, 'bun.lockb')) || existsSync(path.join(dir, 'bun.lock'))) return 'bun';

      const packageJsonPath = path.join(dir, 'package.json');
      if (existsSync(packageJsonPath)) {
        try {
          const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
          if (packageJson.packageManager) {
            const pmName = packageJson.packageManager.split('@')[0];
            if (pmName === 'pnpm' || pmName === 'yarn' || pmName === 'npm' || pmName === 'bun') {
              return pmName;
            }
          }
        } catch {}
      }
      dir = path.dirname(dir);
    }
    return 'npm';
  }

  /** @param {import('vscode-languageserver/node').ExecuteCommandParams} params */
  async handleExecuteCommand(params) {
    if (params.command !== 'knip.installDependency') return;
    const [packageName, dependencyType, workspacePath] = params.arguments ?? [];
    if (typeof packageName !== 'string' || !PACKAGE_NAME_RE.test(packageName)) return;
    if (!workspacePath || !existsSync(workspacePath)) return;

    const pm = this.detectPackageManager(workspacePath);
    const isDev = dependencyType === 'devDependencies';
    const commands = {
      npm: `npm install ${packageName}${isDev ? ' --save-dev' : ' --save'}`,
      pnpm: `pnpm add ${packageName}${isDev ? ' -D' : ''}`,
      yarn: `yarn add ${packageName}${isDev ? ' -D' : ''}`,
      bun: `bun add ${packageName}${isDev ? ' -d' : ''}`,
    };
    const cmd = commands[pm];
    this.connection.console.log(`Installing dependency: ${cmd} (in ${workspacePath})`);

    try {
      await execAsync(cmd, { cwd: workspacePath });
      this.connection.console.log(`Successfully installed ${packageName}`);
      await this.restart();
    } catch (error) {
      this.connection.console.error(`Failed to install ${packageName}: ${error}`);
    }
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const transports = ['--stdio', '--socket', '--node-ipc', '--pipe'];
  if (!process.argv.some(arg => transports.includes(arg))) process.argv.push('--stdio');
  new ZedKnipServer();
}
