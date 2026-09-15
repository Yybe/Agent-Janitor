# Changelog

## 0.2.0

- P0 speed: stat-only parallel `walkSize` (16-way fan-out), concurrent adapters,
  DB fast path in `scan` (PRAGMA + COUNTs; exact byte plan stays in `vacuum`).
  Full scan on a 10-harness machine: ~1.4s wall time.
- Claude-deep: orphan project caches, 13 stale cache dirs, `history.jsonl` 500-line
  cap, `.claude.json.backup*`, `cleanupPeriodDays` nudge.
- New adapters: Kiro sessions/logs, Cursor, Antigravity (IDE storage +
  `~/.gemini/antigravity` conversations/recordings/crashes), Copilot, Cline, Amp,
  Roo-Code, OpenClaw, Continue, Aider (markers/precious-only where appropriate).
- Test seam: `JANITOR_HOME` / `JANITOR_APPDATA` env overrides for fake-home tests.
- 18 tests passing (fake-home round-trips for every new adapter).

## 0.1.0

Initial public release.

- `scan`: read-only cross-harness audit (OpenCode, Codex CLI, Claude Code, Gemini CLI).
- `clean`: trash-safe file cleanup, dry-run by default, `--apply` to move, `restore` to undo.
- `restore`: list trash contents and put items back; refuses when the original path exists.
- `vacuum`: OpenCode SQLite compaction (superseded snapshots + byte-identical dupes + `VACUUM`),
  gated by lock probe, schema gate, reconstruction proof, backup, and integrity checks.
- `codex-gc`: prune old `refs/codex/turn-diffs/*` checkpoint refs + `git gc` (forfeits old per-turn rewind).
- `--json` machine output on scan/clean/restore/vacuum/codex-gc; per-command `--help`; `--version`.
