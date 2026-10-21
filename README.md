# Local portable-compaction fork

Based on installed `@signalridge/pi-codex-compact@1.3.3` (MIT; upstream source files
and license retained). Every enabled compaction pairs Codex V2 with KB-compatible
Luna plaintext extraction, on all models. Model switches reuse plaintext rather
than reverting to opaque replay. It uses Pi's standard auth path,
including the existing `pi-codex-multi` hook, without a new provider or credential store.

Enabled via `~/.pi/agent/settings.json`; use `/reload` to load it.
`/codex-compact` retains the upstream settings UI.

See `../codex-portable-compact/README.md` for behavior, safety limits, tests and rollback.
This private local package depends on its sibling `codex-portable-compact` directory.
It is not a standalone npm release.