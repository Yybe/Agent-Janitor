# Changelog

## 0.3.0

- Correctness: per-OS app-data roots (`appData()`/`localData()`/`dataDir()` in `src/util.ts`)
  replace the Linux-only guess that made every macOS and Windows adapter a false negative.
  `scan` now prints the root it probed per adapter (and in `--json`), so "not installed" and
  "we looked in the wrong place" are distinguishable.
- Coverage: Zed, Qwen Code, Kimi CLI, Amazon Q, Crush and Windsurf adapters, each path taken
  from the harness's own source constants or vendor docs. OpenClaw and Continue are honestly
  `report-only` (their layouts are unproven); Cursor's updater path moved to `%LOCALAPPDATA%`.
- New: `trash` / `trash --apply` — the reclaimable trash no longer grows forever; expired items
  are listed first, deleted only with `--apply`, and a batch dir is only removed when empty.
- New: `docs/agent-sources.md` — the path-evidence corpus (path, class, source, pinned commit)
  that every adapter row in the README traces back to.
- Contributor funnel: `new-harness.yml` and `bug-report.yml` issue templates, PR template with an
  evidence table, rewritten `CONTRIBUTING.md` (three-step adapter recipe, "path evidence is the
  merge bar"). One `ADAPTER_IDS` list now drives the registry, the roots map and `--target`.
- CI: 3-OS × Node 22/24 matrix, packed-tarball install smoke (`npm pack` → global install →
  `scan`), tag-triggered `npm publish` with provenance. Local `npm test` ~1.4 s; the real-DB
  integration test is opt-in via `JANITOR_REAL_DB=1`.
- Noise: the `node:sqlite` `ExperimentalWarning` no longer prints.

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
