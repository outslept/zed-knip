---
"zed-knip": patch
---

Fix language server lifecycle hooks:

- Respect `enabled` and `requireConfig` at startup.
- Refresh inlay hints after every module graph rebuild.
- Re-read editor settings instead of caching them for the whole session.
- Clear quick-fix diagnostics for unused enum and namespace members immediately.
