# Changelog

## 0.3.1

- Fix: `vacuum` no longer locks itself out forever after a harness crash. A `-wal`/`-shm`
  sidecar only blocks when it still holds bytes; a 0-byte leftover is judged by the read-only
  open instead of by its name (`docs/safety.md`, fixture test added).
- Fix: `trash --apply` drops restored entries and their emptied batch dirs out of
  `manifest.json`, which used to grow forever.
- Fix: the suite compiles again — `test/paths.trash.test.ts` had been truncated mid-test, so
  `npm test` failed before running anything.
- New: `doctor` — read-only, one line per adapter root: whether it exists, what is in it, when
  it was last written. `doctor --json` is the paste-into-an-issue evidence that a path is
  right (or wrong) on macOS / Windows / Linux.
- Coverage: Cursor's CLI tree (`~/.cursor/chats/<hash>`,
  `~/.cursor/projects/<id>/agent-transcripts`) and Continue (`~/.continue/sessions`,
  `~/.continue/logs`) are now source-cited cleaners instead of guesses.
- Gate: a test fails the build if an id in `ADAPTER_IDS` has no row in
  `docs/agent-sources.md`, so the evidence corpus cannot drift from the shipped adapters.
- Fix: a cross-volume (`EXDEV`) trash move now checks free space on the trash volume before
  copying, instead of failing mid-copy on a 70 GB tree.
- Issue templates ask for `doctor --json`, so path evidence arrives with the report.

## 0.3.0

- Correctness: per-OS app-data roots (`appData()`/`localData()`/`dataDir()` in `src/util.ts`)
  replace the Linux-only guess that made every macOS and Windows adapter a false negative.
  `scan` now prints the root it probed per adapter (and in `--json`), so "not installed" and
  "we looked in the wrong place" are distinguishable.
- Coverage: Zed, Qwen Code, Kimi CLI, Amazon Q, Crush and Windsurf adapters, each path taken
  from the harness's own source constants or vendor docs. OpenClaw and Continue are honestly
  `report-only` (their layouts are unproven); Cursor's updater path moved to `%LOCALAPPDATA%`.
- New: `history` — an append-only journal (`~/.agent-janitor/history.log`) of every action that
  changed something: `clean`/`trash`/`vacuum`/`codex-gc` with `--apply`, and every `restore`.
  Dry runs are never recorded. Answers "what did it do last week" without reading JSON by hand.
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
