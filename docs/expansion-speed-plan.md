# agent-janitor — Expansion + Speed Plan

**Date:** 2026-09-15
**Goal:** (1) cover more IDEs/harnesses (Kiro, Antigravity deep, Claude deep, Cursor, Windsurf, Copilot, Gemini deep, + long tail), learning from OSS cleaners + Reddit/X lore; (2) make scan/clean sub-second, not O(GB).
**Current code:** `agent-janitor/src/adapters/files.ts` (opencode-files, claude, codex, gemini-stub), `src/adapters/opencode/db.ts` (vacuum + proof), `src/adapters/codex/checkpoints.ts` (turn-diff GC), `src/core/scan.ts`, `src/util.ts` (`deepSize`, `newestMtime`), `src/types.ts` (`AdapterId = opencode|codex|claude|gemini`).

---

## A. Where we stand (coverage audit)

| Harness | Today | Verdict |
|---|---|---|
| OpenCode files+DB | `snapshot/`, `log/`, `*.backup-*` + `opencode.db` vacuum (superseded snapshots, >1MB dupes, stale sessions, freelist) | Keep; needs speed fix (see E) |
| Codex | `sessions/YYYY/MM/DD/*.jsonl`, `..*.tmp-*`, `refs/codex/turn-diffs/` GC | Keep; sessions walk is 4-deep nested loop — flatten |
| Claude Code | `transcripts/`, `projects/` (+ report-only `shell-snapshots,todos,statsig,debug,plugins,settings.json`) | Thin — expand (see D1) |
| Gemini CLI | report-only `~/.gemini` + `tmp/` | Stub — expand (see D2) |
| Kiro, Antigravity, Cursor, Windsurf, Copilot, OpenClaw, Aider, Continue, Cline/Roo | nothing | New adapters (see D) |

Windows is the primary dev machine (`C:\Users\<user>\`), so every new adapter **must** resolve `%USERPROFILE% / %APPDATA% / %LOCALAPPDATA%` first, then `~/.config / ~/.local/share` fallbacks.

---

## B. OSS cleaner landscape (verified 2026-09-15)

Claude Code is the only harness with real cleaner tooling. Everything else is open ground.

- **GarrickZ2/claude-code-cleaner** (Rust TUI, ~35★): cleans `~/.claude/projects/`, `debug/`, `file-history/`, `telemetry/`, `shell-snapshots/`, `todos/`, `plans/`, `usage-data/`, `tasks/`, `paste-cache/`, `~/.claude.json.backup*`, truncates `history.jsonl` to 500 lines. Orphan detection (project source gone → whole cache deletable). 30d retention, dry-run, atomic JSON writes. No trash/restore, no vacuum. Borrow: orphan-project rule + `history.jsonl` truncation.
- **ihoooohi/claude-code-session-cleaner** (Shell, ~100★, most-starred in niche): trash-safe (`~/.claude/session-cleaner-trash` + `metadata.json`), clash-safe restore, 10-min active-window guard, `--older-than 30d` preview-only without `--yes`, `ccsc` CLI + `/delete-session` + `--json`. Borrow: trash layout, active-window guard, short-ID refusal.
- **geminiwen/cccleaner** (~12★, Shell+jq): widest `~/.claude/` cache list + `~/.claude.json` counter surgery + ID-regen helpers. Timestamped `~/` backups, not a trash dir. Borrow: its cache-dir enumeration as our Claude-deep checklist.
- **tawroot/antigravity-cleaner** (Go, ~117★, GPL-3.0): Antigravity 2.x fix/unblock toolkit (cookies, token cache, DIPS caches, Electron net state, process kill, `doctor/patch/launch/clean/kill`). README lists **no filesystem paths**; preserves chats ("0 chat loss"). It is a connectivity fixer, **not** a retention janitor — do not copy its scope; do probe its binary/docs for actual Antigravity paths on Windows.
- **tawanamohammadi/tawana-antigravity-cleaner** (~9★, Python): one-command Windows Antigravity cleanup, thin docs — probe only.
- **Watcher3056/llm-cleaner** (~1★, Node): only multi-harness claim (Codex, Claude, Cursor, Gemini, Antigravity). Estimate-first UI, keeps summaries/recent turns, de-dupes journals, "compacts DBs", 3/6/12-month rules, backup-first + rollback. Paths unverified — treat as feature checklist, not ground truth.
- **Monitors, NOT cleaners** (do not imitate for deletion): `ccusage/ccusage` (~18.6k★, read-only analyzer, `npx ccusage@latest`, covers Claude/Codex/OpenCode/Amp/Droid/Codebuff/Hermes/pi/Goose/OpenClaw/Kilo/Kimi/Qwen/Copilot/Gemini/Antigravity/Grok/ZCode); `steipete/CodexBar` (~21.4k★, macOS menu-bar limits display).
- **Checked-and-not-found:** `ocdbc` (0 GitHub hits, npm 404 — planned/private name, not a competitor); `agent-janitor` on npm (free — only unrelated `@rbxts/janitor`, `html-janitor`); Kiro / Cursor / Windsurf / Copilot / Aider / Continue / Cline dedicated cleaners (none found); `SessionWatcher` (no repo by that name); `jamubc/codexbar` (404, canonical is `steipete/CodexBar`); npm `claude-code-cleaner` v0.1.2 is `gabrielrodrigues42/` TUI, a different author from the Rust one — don't confuse.

**Takeaway:** no cross-harness janitor with trash+restore+vacuum exists. Claude-deep (orphan rule, `history.jsonl` cap, full cache list) + VS-Code-family (`workspaceStorage`) + Kiro/Antigravity-first are all unclaimed.

---

## C. Community lore (Reddit / X / issues — patterns, weak per-URL verification in this env)

- **VS-Code-family `User/workspaceStorage/<hash>/` eating 10s–100+ GB** is the perennial complaint (r/CursorAI, r/vscode). Folk remedy: quit IDE → sort `workspaceStorage/*` by size → delete biggest/oldest hashes + `logs/`, `CachedData/`, `Crashpad/`, updater caches. Cost most-reported as "what broke": per-folder chat/composer history gone; `globalStorage/` delete logs extensions out.
- **Claude `~/.claude/projects/*.jsonl` growth** is the newer wave (r/ClaudeCode). Remedies: `cleanupPeriodDays` → 7–14, manual old-transcript delete, `/compact`. Verified gotcha: `anthropics/claude-code#6016` — disk-full crash blanked the main config; keep headroom + back up `~/.claude.json` + `settings.json` before bulk deletes.
- **OpenCode event-table growth / Codex `refs/codex/turn-diffs` 100+ GB orphans** (`openai/codex#29388`) — already our covered cases.
- **No single upstream `clean` command** except Claude's `cleanupPeriodDays` and OpenCode `/unshare`. Everyone hand-rolls `du`-sort-delete. That is the gap we productize.
- Auth-loss second-place gotcha: deleting `auth.json` / `config.toml` / OAuth creds forces re-login. Never trash creds.

---

## D. Expansion plan — new + deepened adapters

General rules for every adapter: quit-the-app-first warning for locked DBs; unknown-age files kept (fail closed, as today); creds/settings/rules never trashed (report-only or skipped); Windows paths primary.

### D1. Claude Code — deepen (highest ROI, proven bloat)

Add trash-eligible: `projects/<slug>/*.jsonl` older than retention (keep current per-file rule) + **orphan-project rule** (project source path gone → whole slug dir eligible regardless of age, flagged distinctly); `usage-data/report*.html` dated dupes; `backups/`; `feedback-bundles/`; `debug/*.txt`; `file-history/`; `shell-snapshots/` (only files older than retention, since native retention may already cover); `todos/`, `tasks/`, `plans/`, `paste-cache/`, `telemetry/`; truncate `history.jsonl` to last 500 lines (in-place rewrite with backup, following GarrickZ2); `~/.claude.json.backup*`.
Report-only/precious: `settings.json`, `~/.claude.json` (live), `skills/`, `commands/`, `agents/`, `ide/`, `credentials.json`, `CLAUDE.md`, project `MEMORY`.
Native knob to surface in output: `cleanupPeriodDays` (default 30) — suggest lowering before our clean.

### D2. Gemini CLI — promote from stub

Dirs: `%USERPROFILE%\.gemini` / `~/.gemini`. Trash: `tmp/` (already), `logs/`, old `sessions|checkpoints|history` per retention, debug logs. Precious: `settings.json`, `GEMINI.md` (+ global `~/.gemini/GEMINI.md`), `oauth_creds.json`. Keep `.geminiignore` semantics in mind (nothing to delete there).

### D3. Kiro (new — AWS Kiro / `.kiro` / `~/.kiro`)

Project-local (precious, never delete): `<repo>/.kiro/{steering,specs,hooks}/` — this IS the product.
Global: `%USERPROFILE%\.kiro` / `~/.kiro`; if Kiro IDE is a VS-Code fork also scan `%APPDATA%\Kiro` / `~/Library/Application Support/Kiro/` / `~/.config/Kiro` with the VS-Code-family rules (D5). Trash: `logs/`, `CachedData/`, `Crashpad/`, old `workspaceStorage/<hash>/`, updater caches. Confirm on-disk with `du` before finalizing — docs excerpt verified only `.kiro/` project semantics.

### D4. Antigravity (new — Google, least documented, confirm locally)

Provisional roots: `%USERPROFILE%\.antigravity` / `~/.antigravity`; host `%APPDATA%\Antigravity` / `~/Library/Application Support/Antigravity/` / `~/.config/Antigravity`; Chromium-profile + agent/browser-recording caches as likely bloat. Start **report-only + `tmp/logs/cache` trash only**; keep project agent/playbook files precious. Cross-check `tawroot/antigravity-cleaner` binary behavior + `llm-cleaner` claims to pin real paths, then graduate to retention rules. Never auto-delete chat history here until paths are certain ("0 chat loss" is their bar too).

### D5. Cursor + Windsurf + Copilot-host (new — one shared VS-Code-family scanner)

Same layout, three roots: `%APPDATA%\Cursor` (+ `%LOCALAPPDATA%\Cursor`, `~/.cursor`), `%APPDATA%\Windsurf` (+ `~/.windsurf`, `~/.codeium`), VS-Code host `%APPDATA%\Code` (Copilot lives in `globalStorage/github.copilot*`). Trash: `User/workspaceStorage/<old-hash>/` (per-folder blobs + SQLite, the big sink), `logs/`, `CachedData/`, `Crashpad/`, updater caches. Precious: `User/settings.json`, `keybindings.json`, `snippets/`, project `.cursor/rules`, `.cursorignore`, `.windsurf/`, extension auth. Cost to disclose: purging a hash kills that folder's chat/composer history + extension UI state.

### D6. Long tail (cheap file-only adapters, same `files.ts` pattern)

- **OpenClaw:** `%USERPROFILE%\.openclaw` / `~/.openclaw` — trash `sessions/`, `logs/`; precious `openclaw.json`, `workspace/`, `memory/`, creds.
- **Aider:** per-repo `.aider.chat.history.md`, `.aider.input.history`, `.aider/` — rotate; precious `.aider.conf.yml` + repo conventions.
- **Continue:** `%USERPROFILE%\.continue` / `~/.continue` — trash `sessions/`, index/embeddings cache (warn: re-index cost), `logs/`; precious `config.yaml`, custom prompts/models.
- **Cline/Roo:** host `globalStorage/{rooveterinaryinc.roo-cline,saoudrizwan.claude-dev}`, `workspaceStorage/<hash>/`, per-task `task_history|checkpoints|diffs` — prune old tasks + logs; precious `cline_mcp_settings.json`, `.clinerules`, approvals.
- **JetBrains Copilot host:** `%APPDATA%\JetBrains\<IDE>`, `~/.cache/JetBrains` logs/indexes.

`AdapterId` grows to `opencode|codex|claude|gemini|kiro|antigravity|cursor|windsurf|copilot|openclaw|aider|continue|cline`. Ship behind `--target` one at a time; each new adapter = ~40-line scanner + test with fixture dirs.

---

## E. Speed plan — kill O(GB) scans

### E1. Why `scan` is slow today

- `deepSize()` (`src/util.ts`): serial recursion, one `lstat`+`readdir` per entry, full walk even for report-only dirs. O(files), no parallelism, no early exit.
- `newestMtime()`: same serial recursion per candidate dir (snapshot dirs, Claude project dirs, `gemini/tmp`).
- `analyzeOpencodeDb()`: `SUM(length(CAST(data AS BLOB)))` over all 146k event rows; `compactionEstimate` builds temp tables over every snapshot; `findExactDupes` streams **all >1MB payloads as JS strings** and `Array.some(===)` compares — O(GB) reads + GC churn on a 2 GB DB. `staleSessionBytesFor` triple-`SUM` over message/part/event.
- `scanCodex()`: 4-deep sequential `readdir` nesting; per-file `stat`.
- No caching: every `scan` re-pays full cost. No top-K: we size everything even though users act on the top few.

### E2. New architecture (target: `scan` < 2 s on a 2 GB store, 2nd run < 200 ms)

1. **Stat-only scan, never read content.** Size/age come from `readdir({withFileTypes:true})` + single `lstat` for files only. No `readFile`, no `JSON.parse`, no blob reads in scan. Content reads happen only for flagged candidates at `clean --apply` / `vacuum` time.
2. **SQLite fast path — PRAGMAs, not payload sums.** `page_count × page_size` = file truth; `freelist_count × page_size` = instant reclaimable; per-table via `dbstat` (no blob reads). Keep one bounded `GROUP BY type COUNT(*)` (no `SUM(length)`) for the event mix. Move exact byte accounting (superseded/dupe/stale sums) to `vacuum --dry-run` (planning) where the user already expects slowness.
3. **Top-K drill-down.** Aggregate per harness/session dir first; recurse fully only into the top-10 largest. Sort 100 dirs, not 100k files. Add `--detail` for the full walk.
4. **Bounded parallelism.** `p-limit(32)` SSD / `p-limit(8)` HDD for sibling dirs; sequential within a dir. Kills the serial-walk penalty without `EMFILE` thrash. Replace `deepSize`/`newestMtime` recursion with one iterative walker (explicit stack, depth cap for mtime, symlink budget kept).
5. **Tail-read JSONL.** Session age/count from dir `mtimeMs` or last-64KB tail parse, not full streaming parse.
6. **Skip-list with single-value reporting.** `node_modules`, `.git/objects`, `Code Cache`, `*.chunk`, `checkpoints/*.pt` → one `du`-equivalent size + `skipped:{reason}`, never recursed.
7. **Manifest cache.** `~/.cache/agent-janitor/manifest.json`: `{path:{mtimeMs,size,newestMtime}}`; if dir `mtimeMs` unchanged, reuse. Rescan becomes O(dirs-changed). Invalidates on mtime only.
8. **Codex flattening.** Replace YYYY/MM/DD nesting with one iterative walk + tail-age; keep `codex-gc` (git refs) as-is — it is already ref-list-only, no object reads.
9. **Vacuum planning stays correct but lazy.** Proof + dupe-grouping run only under `vacuum` (not `scan`); stream dupes with incremental hashing in fixed-size chunks instead of whole-string `===` (kills the 134 MB-single-payload GC spike).
10. **Budgets:** 50k files stat-only ≈ 300–600 ms; manifest hit < 100 ms; DB PRAGMAs ≈ 5 ms. Leaves ~1 s headroom for UI.

### E3. Concrete code changes

- `src/util.ts`: replace `deepSize` + `newestMtime` with `walkSize(root,{depth,concurrency,skip,manifest}) → {bytes,newestMtime,skipped[]}` (iterative, `p-limit`, single `lstat` per file, dir-mtime shortcut).
- `src/adapters/files.ts`: all scanners call `walkSize`; Claude `projects/` + Codex `sessions/` aggregate-then-topK; Gemini/Kiro/etc reuse the helper (this is what makes 8 new adapters cheap).
- `src/adapters/opencode/db.ts`: split `analyzeOpencodeDb` into `quickDbStats` (PRAGMAs + `COUNT(*) GROUP BY type`, used by `scan`) and `planVacuumStats` (superseded/dupe/stale byte sums, used by `vacuum` dry-run). Chunked-hash dupe grouping.
- `src/core/scan.ts`: run adapters concurrently (`Promise.all`), add `--detail` and `--no-cache` flags, emit `cacheHit`, `skipped[]` in `ScanResult`.
- `src/types.ts`: extend `AdapterId`; add `SkippedDir{path,bytes,reason}`, `cacheHit:boolean` on `AdapterScan`.
- Tests: fixture-tree timing test (`scan` < 2 s on synthetic 50k-file tree), manifest-hit test (< 200 ms), `quickDbStats` ≈ `planVacuumStats` within 1% on the 2 GB fixture, unknown-age-kept + creds-never-touched regression tests per new adapter.

### E4. Rollout (phased, each shippable)

- **P0 (speed):** walker + DB split + concurrent adapters + `--detail/--no-cache`. Success: `scan` on this PC's 2 GB OpenCode store < 2 s.
- **P1 (depth):** Claude-deep (orphan rule, `history.jsonl` cap, cache list) + Gemini promotion + Kiro + Antigravity-report-only.
- **P2 (breadth):** VS-Code-family scanner (Cursor/Windsurf/Copilot-host) + OpenClaw/Aider/Continue/Cline file adapters. Each behind `--target`, fixture-tested.
- **P3 (polish):** manifest cache on by default, `clean` reuses scan manifest (no re-walk), docs table of safe-vs-precious per harness with Windows paths.

---

## F. Safety invariants (unchanged, apply to every new adapter)

`scan` read-only · `clean/vacuum/codex-gc` dry-run by default, `--apply` required · files → `~/.agent-janitor/trash` + manifest, `restore` never overwrites · vacuum keeps timestamped backup + integrity-before/after + reconstruction proof · locked DBs refused · unknown schemas/ages fail closed · `codex-gc` only `refs/codex/turn-diffs/*` with rewind-forfeit warning.
