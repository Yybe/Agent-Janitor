# Safety contract

Technical and honest. No absolute safety is promised — the tool refuses unsafe
operations instead.

## `scan`

Always read-only. Opens the OpenCode DB with `readOnly: true`, stats files,
never writes. Exit 0 even when nothing is found.

## Dry run (default for `clean`, `vacuum`, `codex-gc`, `trash`)

Prints the plan and changes nothing. `--apply` is required to act. For `vacuum`,
dry run still runs the lock probe, schema gate, proof, and integrity read —
reads only.

## `clean --apply`

Moves trash-eligible files to `~/.agent-janitor/trash/<timestamp>/` with a
`manifest.json` entry (original path, size, mtime, harness, kind). Never deletes.
Files with unknown mtime are kept (fail closed). Protected paths (settings,
credentials, plugins, live SQLite sets, native-retention dirs) are `report-only`
and never queued. Cross-volume moves copy then remove the original.

## `vacuum --apply`

Touches only the OpenCode DB given by `--db` (default
`~/.local/share/opencode/opencode.db`). Pipeline, in order:

1. Lock probe: refuses when `-wal`/`-shm` sidecars exist or read-only open fails.
2. Schema gate: refuses unless the anchor drizzle migration and expected table
   DDL fragments match.
3. Reconstruction proof: every live message/part must equal its newest snapshot
   event (row-side drift tolerated only when older events carry no keys the
   newest snapshot lacks — delta chains fail the proof). Failure aborts, nothing
   changed. `--skip-proof` skips this; dangerous with `--apply`.
4. Backup: timestamped copy `<db>.janitor-backup-<stamp>` beside the DB.
   `--no-backup` skips it; dangerous.
5. Deletes inside one transaction: exact-duplicate events (keep first by rowid),
   then superseded snapshots (keep newest per entity), then — only with
   `--delete-sessions-older-than N` — whole old sessions (cascades to
   messages/parts/events). Rollback on any error.
6. `quick_check` before and after deletes and after `VACUUM`; any non-`ok`
   aborts loudly (with `--apply` and a backup already taken, restore = copy the
   backup back over the DB while opencode is closed).

`--delete-sessions-older-than` removes sessions permanently (not via trash);
the pre-run backup is the undo.

## `codex-gc --apply`

Deletes only refs under `refs/codex/turn-diffs/` older than retention, then runs
`git gc --prune=now` in the target repo. Forfeits per-turn rewind/diff for
affected old sessions. User branches/tags are never touched.

## `restore`

Puts a trashed item back at its original path. Refuses when something already
exists there (never overwrites). Restores across volumes by copy + remove.

## `trash --apply`

The only real delete in the tool. Without `--apply` it lists every trash entry with
its age and marks which ones are past `--retention` (default 30d), and removes
nothing. With `--apply` it permanently deletes exactly those expired items, rewrites
`manifest.json`, and drops the batch directories that are now empty (`rmdir`, never
`rm -r`, so a still-restorable item in the same batch can never be taken with it).
Items that fail to delete stay in the manifest and are reported. Anything still
inside the window is untouched and remains restorable.

## Refusal summary

Refuses (exit 1, no changes) on: locked DB, unknown schema, failed proof, failed
integrity check, insufficient disk headroom for vacuum (2× DB, 3× with backup),
restore target collision, unknown `--target`, non-git `--repo`, ambiguous trash id.
