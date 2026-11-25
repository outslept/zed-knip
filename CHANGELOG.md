# zed-knip

## 0.2.0

### Minor Changes

- [`49b77b9`](https://github.com/outslept/zed-knip/commit/49b77b987be1ae707a4761b387686b4c346f1994) Thanks [@outslept](https://github.com/outslept)! - Rename the extension ID to `knip-lsp` and remove the MCP context server from the extension manifest.
  
  Dependency installation no longer runs a package manager from the language server. The unlisted-dependency quick fix now shows the install command to run in the project workspace.
  
  Disable oxc raw transfer by default to avoid `RangeError: Array buffer allocation failed` on Windows and low-memory machines.

## 0.1.1

### Patch Changes

- [`1703ab7`](https://github.com/outslept/zed-knip/commit/1703ab76e5bd776e663803221503a15ab1c85750) Thanks [@outslept](https://github.com/outslept)! - Fix the language server lifecycle hooks: `enabled` and `requireConfig` are now respected at startup, and editor settings are re-read instead of cached for the whole session.
  
  Inlay hints refresh after every module graph rebuild, and quick-fix diagnostics for unused enum and namespace members clear immediately.

## 0.1.0

### Minor Changes

- [`4fd9aa4`](https://github.com/outslept/zed-knip/commit/4fd9aa41a8e3a5c4c612a8f13465788d152fbc51) Thanks [@outslept](https://github.com/outslept)! - Initial release of the Knip extension for Zed:
  
  - Diagnostics for unused files, dependencies, and exports
  - Quick fixes to remove unused exports, add JSDoc tags (`@lintignore`, `@internal`, `@public`), remove unused dependencies, and install unlisted packages
  - Hover on exports and `package.json` dependencies to inspect import locations
  - Hover on circular imports and contended exports (`ambiguous`, `shadowed`, `converged`)
  - Inlay hints showing import counts (`↻ N imports`), export contention badges, and circular dependencies (`↻ circular`)
  - Zed Context Server integration for `@knip/mcp` (`knip-configure`, `knip-docs`)
