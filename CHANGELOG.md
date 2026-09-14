# Changelog

## 0.1.0

Initial public release.

- `scan`: read-only cross-harness audit (OpenCode, Codex CLI, Claude Code, Gemini CLI).
- `clean`: trash-safe file cleanup, dry-run by default, `--apply` to move, `restore` to undo.
- `restore`: list trash contents and put items back; refuses when the original path exists.
- `vacuum`: OpenCode SQLite compaction (superseded snapshots + byte-identical dupes + `VACUUM`),
  gated by lock probe, schema gate, reconstruction proof, backup, and integrity checks.
- `codex-gc`: prune old `refs/codex/turn-diffs/*` checkpoint refs + `git gc` (forfeits old per-turn rewind).
- `--json` machine output on scan/clean/restore/vacuum/codex-gc; per-command `--help`; `--version`.
