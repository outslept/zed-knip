---
"zed-knip": patch
---

Fix the language server lifecycle hooks: `enabled` and `requireConfig` are now respected at startup, and editor settings are re-read instead of cached for the whole session.

Inlay hints refresh after every module graph rebuild, and quick-fix diagnostics for unused enum and namespace members clear immediately.
