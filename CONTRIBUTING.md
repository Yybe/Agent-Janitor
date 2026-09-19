# Contributing

```bash
npm install
npm test      # build + node:test suite (unit + CLI round-trips)
npm run dev -- scan
```

Architecture: `src/cli.ts` parses args and prints output, `src/report.ts` formats
human text, `src/core/` holds scan/trash/safety primitives, `src/adapters/`
holds one harness module each (`files.ts`, `opencode/db.ts`, `codex/checkpoints.ts`).

## Adding a harness adapter

1. Write `scan<Name>(retentionDays)` in `src/adapters/files.ts` (or a new file under
   `src/adapters/`) returning `Finding[]`.
2. Add the id to the `AdapterId` union in `src/types.ts`.
3. Add one line to `SCANNERS` in `src/core/scan.ts`. That map is the single registry:
   `Record<AdapterId, …>` makes the compiler reject an id without a scanner, and the
   CLI's `--target` list and scan order both derive from it. Do not add a fourth list.

Use `appData()` for Electron/VS-Code-family roots (it is `~/Library/Application
Support` on macOS, `%APPDATA%` on Windows, `$XDG_CONFIG_HOME` on Linux) and
`localData()` for updater/cache roots. Never hardcode `~/.config` for a GUI app.

**Path evidence is the merge bar.** Every directory an adapter reads must be backed by
the harness's own source (a path constant you can cite by file and line), its official
docs, or a real user-confirmed bug report — and say which in the PR. Guessing a
directory because the naming pattern looks plausible has cost us adapters that report
nothing (or worse, the wrong thing). An adapter that only proves the harness is
installed is fine; label it as such in the README table instead of implying coverage.

Keep unknown-age files `retentionAware` (fail closed) and mark precious paths
`report-only`, never `trash`. Live SQLite DBs are always `report-only`: `vacuum` is the
only command that opens a database, and it refuses a locked one.

Safety-related changes get extra review: lock detection, schema gates, the
reconstruction proof, trash/restore round-trips, and DB backup behavior must
stay fail-closed. Add a fixture test before changing any of them.

Adapters get a fake-home test: seed the real path layout under `test/helpers.ts`
`runCli`'s `JANITOR_HOME` / `JANITOR_APPDATA`, age the files with `utimesSync`, then
assert `scan` flags the old ones, spares the fresh ones, and lists the precious ones as
`report-only`. Cover the OS-specific root too — a green macOS CI job that never plants a
`Library/Application Support` file proves nothing about macOS.

PRs: small diffs, tests included, `npm test` green on your machine. Bugs: include
the command, `--json` output when possible, OS, and Node version.
