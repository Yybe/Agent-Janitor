# agent-janitor

![agent-janitor — scan, preview, apply, verify, restore](assets/banner.svg)

Reclaim disk space from AI coding agent harnesses — with a preview first, a trash to undo, and proof before any database surgery.

AI coding agents hoard storage: OpenCode's SQLite DB grows to 72 GB in two weeks ([#47022]); Codex writes per-turn project-tree checkpoints into your repos' `.git` and never garbage-collects them (100+ GB cases, [#29388]); Claude Code transcripts pile up; base64 blobs sit inside session DBs ([openclaw#143973]). No harness ships retention or vacuum tooling. agent-janitor audits all of them and reclaims the space — and refuses unsafe operations instead of guessing.

```
$ npx agent-janitor scan
agent-janitor v0.1.0

Scanning AI coding-agent storage...

✓ opencode
✓ codex
✓ claude
✓ gemini

Reclaimable storage

opencode
DB compaction               1.52 GB  (90975 superseded + 66 dupe rows)
claude
Stale sessions                157 MB  (118 items)

------------------------------------
Potential reclaimable space    1.7 GB
------------------------------------

Nothing was changed. scan is always read-only.

Next:
  agent-janitor clean    # preview what would move to trash (dry run)
```

Numbers above are illustrative — your run prints real measured bytes.

## Why this exists

Session transcripts, rollout logs, snapshot dirs, and event-sourced DB rows accumulate silently across every AI harness. Each one is small; together they eat gigabytes. agent-janitor tells you exactly what is wasting space, lets you preview the cleanup, refuses unsafe operations, keeps recoverable files in trash, proves database changes before making them, and shows exactly what happened.

## Safety model

- `scan` is always read-only.
- `clean`, `vacuum`, `codex-gc` are dry-run by default; `--apply` is required.
- Files are moved to `~/.agent-janitor/trash` with a manifest — never deleted. `restore` puts them back.
- `vacuum` takes a timestamped DB backup (default on) and checks integrity before and after.
- `vacuum` runs a reconstruction proof: every live row must match its newest snapshot, else abort with zero changes.
- Locked DBs (WAL/SHM present) are refused. Unknown schemas fail closed. Unknown-age files are kept.
- `codex-gc` only touches `refs/codex/turn-diffs/*` and always warns it forfeits old per-turn rewind.

Full contract: [docs/safety.md](docs/safety.md).

## Quick start

### 1. Check what can be reclaimed (always safe)

```
npx agent-janitor scan
```

### 2. Preview cleanup (changes nothing)

```
npx agent-janitor clean
```

### 3. Apply cleanup (moves to trash, restorable)

```
npx agent-janitor clean --apply
```

### 4. Restore something

```
npx agent-janitor restore --list
npx agent-janitor restore <id>
```

## Installation

Requires Node ≥ 22.5 (uses the built-in `node:sqlite`). Zero runtime dependencies.

```bash
npx agent-janitor scan          # try without installing
npm install -g agent-janitor    # or install globally
```

Local development:

```bash
git clone https://github.com/Yybe/Agent-Janitor.git
cd Agent-Janitor/agent-janitor   # or wherever the package root is
npm install
npm test
npm run dev -- scan
```

## Commands

| Command | What it does | Destructive? |
|---|---|---|
| `scan` | Read-only audit: per-harness, per-cause reclaimable bytes, event-table stats, duplicate payloads, stale sessions (with the $ and tokens they represent) | never |
| `clean` | Move trash-eligible files (old transcripts, session rollouts, snapshots, logs, stale backups) to `~/.agent-janitor/trash` with a manifest | dry-run default; `--apply` required |
| `restore --list` / `restore <id>` | Show trash / put a trashed item back exactly where it was | never destructive (refuses overwrites) |
| `vacuum` | OpenCode DB surgery: delete **superseded snapshot events** + byte-identical duplicate payloads, then `VACUUM` | dry-run default; backup + proof gated |
| `codex-gc` | Delete old Codex turn-diff checkpoint refs in a git repo, then `git gc --prune=now` | dry-run default; **forfeits per-turn rewind for affected old sessions** |

Common flags: `--retention <n><d|w|m>` (default 30d), `--target <adapter>`, `--json`, `--apply`.
Per-command help: `agent-janitor <command> --help`. Version: `agent-janitor --version`.

A real vacuum run on a 2.05 GB OpenCode DB:

```
$ agent-janitor vacuum --db opencode.db --apply
  proof passed: 8448 messages + 36794 parts newest snapshots == live rows
  dupe: 1 byte-identical 133954749-byte payload(s) queued for deletion
  ...
applied: 66 duplicate rows + 90909 superseded rows deleted, 0 sessions removed
size: 1.91 GB -> 769 MB (freed 1.16 GB)
integrity: ok -> ok
```

## What it cleans

| Harness | Storage | Action | Risk / consequence |
|---|---|---|---|
| OpenCode | snapshot dirs, logs ≥1 MB, stale `*.backup-*` configs | move to trash | session `/undo` history for old sessions lost (restorable) |
| OpenCode | superseded snapshot events + byte-identical dupe payloads in `opencode.db` | delete + `VACUUM` (backup first) | none when proof passes; old event rows gone |
| OpenCode | whole sessions (`--delete-sessions-older-than`, opt-in) | delete (backup is the undo) | $ / token receipts printed first; sessions permanently removed |
| Codex CLI | session rollouts older than retention, `*.tmp-*` junk | move to trash | resume history for those sessions lost (restorable) |
| Codex CLI | `refs/codex/turn-diffs/*` checkpoint refs older than retention | delete refs + `git gc` | per-turn rewind for affected old sessions forfeited |
| Claude Code | transcripts / project session dirs older than retention | move to trash | old session history lost (restorable) |
| Gemini CLI | `tmp` dir older than retention | move to trash | temp files lost (restorable) |

## What is NEVER touched

Settings, credentials, plugins, installed plugin dependencies, `CLAUDE.md`, skills, prompt history, harness-managed caches, live SQLite sets (`logs_2.sqlite`, `queue_1.sqlite`, `state_5.sqlite`), Claude Code native-retention dirs (`shell-snapshots`, `todos`, `statsig`, `debug`), user git refs outside `refs/codex/turn-diffs/`. These appear as `report-only` in `scan` — measured, never queued.

## JSON output

Every command accepts `--json`: stable structured objects (`{command, version, dryRun, ...}` plus command payload), no ANSI decoration, safe to pipe. `scan --json` emits the full `ScanResult` (adapters, findings with absolute paths/bytes/mtime, db report, totals) plus `version`. Error paths exit 1 with a plain `agent-janitor: <reason>` line on stderr — no partial JSON.

## Compatibility

OS: Linux, macOS, Windows (CI runs all three; Node 22 and 24). Harnesses: OpenCode, Codex CLI, Claude Code, Gemini CLI — each detected independently; missing harnesses show `(not found)` and are skipped.

## Limitations

Be honest with yourself before `--apply`:

- Vacuum reclaims only superseded/duplicate event rows plus freelist; a DB full of live sessions shrinks little.
- Size estimates are upper bounds until `VACUUM` completes.
- `--delete-sessions-older-than` has no per-item undo beyond the whole-DB backup.
- Lock detection is a WAL/SHM heuristic, not a kernel lock — close the harness first.
- Trash protects against mistakes, not disk failure; cross-volume moves copy-then-remove.

## Development

```bash
npm install        # typescript + tsx only
npm test           # builds + runs node:test suite (unit + CLI round-trips + real-machine scan if present)
npm run dev -- scan
```

The test suite builds a miniature OpenCode-shaped DB with the real DDL (superseded snapshots, byte-identical dupes, a stale session) and runs the full proof → delete → VACUUM path against it, plus proof-failure and unknown-schema abort tests, trash/restore round-trips through the real CLI, and codex-gc against a synthetic repo. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

See [SECURITY.md](SECURITY.md) for private vulnerability reporting and known limits.

## License

MIT

[#47022]: https://github.com/anomalyco/opencode/issues/47022
[#29388]: https://github.com/openai/codex/issues/29388
[openclaw#143973]: https://github.com/openclaw/openclaw/issues/143973
