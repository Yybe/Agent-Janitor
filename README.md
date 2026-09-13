# agent-janitor

**Reclaim disk space from AI coding agent harnesses — safely, cross-harness, with receipts.**

OpenCode's SQLite DB grows to 72 GB in two weeks ([#47022]); Codex writes per-turn project-tree
checkpoints into your repos' `.git` and never garbage-collects them (100+ GB cases, [#29388]);
Claude Code transcripts pile up; base64 blobs sit inside session DBs ([openclaw#143973]).
No harness ships retention or vacuum tooling. **agent-janitor** audits all of them and reclaims
the space — with a trash, a manifest, integrity gates, and a reconstruction proof before it
touches a single row.

Real run on a 2.05 GB OpenCode DB (this tool's own development machine):

```
$ agent-janitor vacuum --db opencode.db --apply
  proof passed: 8448 messages + 36794 parts newest snapshots == live rows
  dupe: 1 byte-identical 133954749-byte payload(s) queued for deletion
  ...
applied: 66 duplicate rows + 90909 superseded rows deleted, 0 sessions removed
size: 1.91 GB -> 769 MB (freed 1.16 GB)
integrity: ok -> ok
```

## Install

Requires Node ≥ 22.5 (uses the built-in `node:sqlite`). Zero runtime dependencies.

```bash
npx agent-janitor scan          # read-only audit — always safe
```

## Commands

| Command | What it does | Destructive? |
|---|---|---|
| `scan` | Read-only audit: per-harness, per-cause reclaimable bytes, event-table stats, duplicate payloads, stale sessions (with the $ and tokens they represent) | never |
| `clean` | Move trash-eligible files (old transcripts, session rollouts, snapshots, logs, stale backups) to `~/.agent-janitor/trash` with a manifest | dry-run default; `--apply` required |
| `restore <id>` | Put a trashed item back exactly where it was | never destructive |
| `vacuum` | OpenCode DB surgery: delete **superseded snapshot events** (the event table stores full snapshots per update — older ones are pure overhead) + byte-identical duplicate payloads, then `VACUUM` | dry-run default; backup + proof gated |
| `codex-gc` | Delete Codex turn-diff checkpoint refs older than retention in a git repo, then `git gc --prune=now` | dry-run default; **forfeits per-turn rewind for affected old sessions** |

Common flags: `--retention <n><d|w|m>` (default 30d), `--target <adapter>`, `--json`, `--apply`.

## The safety model (this is the product)

1. **`scan` is always read-only.** Nothing is opened for writing.
2. **Dry-run is the default everywhere.** `--apply` is an explicit act.
3. **Files are never deleted** — they are *moved to trash* (`~/.agent-janitor/trash`) with a
   manifest entry (original path, size, mtime). `restore` undoes it.
4. **DB surgery is gated by a reconstruction proof.** Before deleting anything, the tool verifies,
   for every live message and part in the DB, that the *newest* snapshot event captures the live
   row exactly (row-side drift such as fields added by newer harness versions is tolerated, but
   only when older events don't carry keys the newest snapshot lacks — a delta chain would be
   unsafe, and the proof refuses). Any failure aborts with zero changes.
5. **Lock probe.** If a `-wal`/`-shm` sidecar exists, the DB is in use and the tool refuses.
6. **Backup + integrity.** A timestamped copy is taken before surgery (default on), and
   `quick_check` must pass before *and* after deletes and after `VACUUM`. Disk headroom is
   checked (3× DB size with backup, 2× without).
7. **Schema gate.** The DB's drizzle migrations and table DDL are matched against the schema this
   version was written for; unknown schemas fail closed.
8. **Protected paths are never touched**: settings, credentials, plugins, `CLAUDE.md`, skills,
   prompt history, harness-managed caches and live SQLite sets are reported, not cleaned.

Deleting old snapshot events is lossless *by construction*: replaying an event log applies events
in order and the newest snapshot per entity wins — older snapshots are always overridden. The
proof exists to catch the day OpenCode's format surprises us.

## What it found on a real machine (Sept 2026)

- OpenCode `event` table: 146,702 rows, 1.5 GB — **90,975 rows (1.1 GB) were superseded snapshots**
  of live entities, plus 66 byte-identical duplicate payloads (422 MB, incl. a 134 MB clone).
- 118 sessions older than 30 days ≈ 157 MB — with $0.40 and 77M-in/5.6M-out/720M-cache tokens
  attached (printed before deletion so you can decide).
- `~/.gemini` alone held 1.9 GB of Antigravity IDE data; `~/.codex/plugins/.plugin-appserver` hid
  374 MB in a dotfile dir; 9 stale `*.backup-*` config files; a 20 MB log.

## Supported harnesses

| Harness | Audit | File cleanup | DB vacuum | Notes |
|---|---|---|---|---|
| OpenCode | ✅ | snapshots, logs, stale backups | ✅ event compaction + dedupe + VACUUM | schema-gated against drizzle migrations |
| Codex CLI | ✅ | session rollouts, tmp junk | — | turn-diff checkpoint GC via `codex-gc` (git repos) |
| Claude Code | ✅ | transcripts, project sessions | — | native `cleanupPeriodDays` dirs are reported, not duplicated |
| Gemini CLI | ✅ | tmp | — | more rules as formats stabilize |

## Honest competitive map

- **[ocdbc]** (Python) — OpenCode-only; freelist `VACUUM` with excellent safety ceremony. Cannot
  reclaim the event whale: freelist was ~0 on our 2 GB DB, because live superseded snapshots keep
  the pages. agent-janitor compacts the snapshots *then* vacuums, and covers other harnesses.
- **[ocgc]** (Python) — OpenCode session/file purger; no DB event compaction.
- **[claude-code-cleaner]** (Rust) — Claude-only, Linux/macOS install, no trash/restore, and its
  dir list predates Claude Code's native retention sweep.
- **[ai-session-cleaner]** (Node) — closest in scope (multi-harness), but no backup, no trash,
  no license, no proof, zero adoption at time of writing.
- **Nobody** handles Codex turn-diff checkpoint GC — that slot is empty and it is the single
  largest win on Codex-heavy machines.
- [ccusage] owns post-hoc *usage accounting* across harnesses (18.5k★) — different problem;
  agent-janitor's stale-session receipts ($ / tokens about to be forgotten) deliberately align
  with its data model.

## Development

```bash
npm install        # typescript + tsx only
npm test           # builds + runs node:test suite (unit + CLI round-trips + real-machine scan if present)
npm run dev -- scan
```

The test suite builds a miniature OpenCode-shaped DB with the real DDL (superseded snapshots,
byte-identical dupes, a stale session) and runs the full proof → delete → VACUUM path against it,
plus proof-failure and unknown-schema abort tests, trash/restore round-trips through the real
CLI, and codex-gc against a synthetic repo.

## License

MIT

[#47022]: https://github.com/anomalyco/opencode/issues/47022
[#29388]: https://github.com/openai/codex/issues/29388
[openclaw#143973]: https://github.com/openclaw/openclaw/issues/143973
[ocdbc]: https://github.com/chncaesar/opencode-db-clean
[ocgc]: https://github.com/whtsky/ocgc
[claude-code-cleaner]: https://github.com/garrickz2/claude-code-cleaner
[ai-session-cleaner]: https://github.com/cvscarlos/ai-session-cleaner
[ccusage]: https://github.com/ryoppippi/ccusage
