---
"zed-knip": minor
---

Initial release of the Knip extension for Zed:

- Diagnostics for unused files, dependencies, and exports
- Quick fixes to remove unused exports, add JSDoc tags (`@lintignore`, `@internal`, `@public`), remove unused dependencies, and install unlisted packages
- Hover on exports and `package.json` dependencies to inspect import locations
- Hover on circular imports and contended exports (`ambiguous`, `shadowed`, `converged`)
- Inlay hints showing import counts (`↻ N imports`), export contention badges, and circular dependencies (`↻ circular`)
- Zed Context Server integration for `@knip/mcp` (`knip-configure`, `knip-docs`)
