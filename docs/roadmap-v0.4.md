# Roadmap v0.4 — critique and continuation plan

Written 2026-09-19 against `main` + the working tree. The claim being tested is the
README's: "cross-harness janitor". Verdict: the safety engineering is already better than
every comparable tool; the packaging, the verification story, and a few honesty details are
what keep it from being the one people actually install.

## Critique (what a reviewer would say out loud)

1. **Distribution is the bottleneck, not adapter count.** `node:sqlite` pins the tool to
   Node ≥ 22.5 and npm. `duf`, `dua`, `ncdu` and `bleachbit` won adoption with a single
   binary plus a brew formula; `ccusage` wins this exact niche's installs because
   `npx ccusage` does something on first paste. Today `npx agent-janitor` prints a help
   screen — nobody forks a cleanup tool over help text, they fork it over "I ran one
   command and got my 30 GB back".
2. **`npm test` was red on the working tree.** `test/paths.trash.test.ts` was truncated
   mid-test (untracked `history` feature left half-finished), so the suite did not compile.
   A contributor's first command failing is the fastest possible way to lose them. Fixed in
   this pass, but it points at a process gap: "done" items were checked off
   `docs/roadmap-v0.3.md` without a green run.
3. **Adapter count overstates coverage.** 20 ids, but `aider` reports one config file,
   `openclaw` measures a home and queues nothing, `roo` and `kiro` IDE ride on the generic
   VS Code-family scanner. A list of 20 with three thin rows reads like padding to the
   audience that matters (people evaluating whether to trust it with `--apply`).
4. **No per-user verification story.** CI already runs the suite on ubuntu/macos/windows ×
   Node 22/24 and installs the packed tarball — so the matrix is not the gap. What was
   missing is evidence from *real* machines: roots come from `appData()`/`localData()`/
   `dataDir()` and fake-home fixtures, and nothing let a user hand a maintainer "on my box
   these 20 roots resolved to this". `docs/agent-sources.md` says "needs a real Mac" three
   times, and the Goose/Trae/Warp rows are blocked on exactly that. Fixed in this pass by
   `doctor` (see below); the follow-up is wiring it into the issue templates.
5. **`vacuum` covers one database.** OpenCode's DB is the only compaction path; Codex
   `logs_2.sqlite`, Cline `sessions.db`, Zed `threads.db`, Continue's doc index and VS Code's
   `state.vscdb` are all `report-only`. For the heaviest users those files are the biggest
   single sink, so the reclaim ceiling is "session files", not "storage".
6. **Safety gaps worth naming.** The cross-volume (`EXDEV`) trash fallback copies without a
   free-space check (`requireHeadroom` is DB-only), so trashing a 70 GB tree onto a small
   second volume fails mid-copy. Restored entries also accumulated in `manifest.json`
   forever, and a lingering 0-byte `-wal` used to lock `vacuum` out permanently — both fixed
   in this pass.
7. **The plan prints bytes, not decisions.** `clean` says "1.2 GB of transcripts"; it does
   not say "Claude Code already deletes these after 30 days if you set
   `cleanupPeriodDays`" — that native-knob nudge exists for exactly one harness (Claude) and
   nowhere else. Users of a janitor want the least invasive knob first.

## Plan

- **P0 keep the suite green and prove it** — the truncated test is repaired, and the new
  evidence-gate test fails CI if an adapter ships without a cited row in
  `docs/agent-sources.md`. ✅ done (33 tests, 0 failures, 3-OS × 2-Node matrix already in place)
- **P0 distribution** — prebuilt single binary (Node SEA or `bun --compile`, keeping
  `node:sqlite` semantics), brew formula tap, `install.sh`, and a README that opens with a
  captured run (`vhs` tape) instead of prose. ⏳ not started — highest-leverage remaining work.
- **P1 `doctor`** — print every probed root with resolved path, exists/absent, entry count and
  mtime as JSON, so real-machine evidence arrives from issues instead of from a maintainer's
  laptop. ✅ shipped in this pass; unblocks the `Goose` macOS root, `Trae`, `Warp`, `OpenClaw`.
- **P1 native-knob nudges** — generalize the `cleanupPeriodDays` hint: every adapter reports
  the harness's own retention setting when one exists, above the trash line.
- **P2 per-harness DB paths** — extend the gated vacuum pipeline (lock probe → schema anchor
  → proof → backup → VACUUM) to the next SQLite sets that are provably regenerable
  (`state.vscdb`, Codex `logs_2.sqlite`); everything else stays `report-only`.
- **P2 coverage** — VS Code/Cursor `globalStorage` chat stores, Kilo Code, OpenClaw once its
  source names its dirs; headroom check in the `EXDEV` copy path.

## Executed in this pass

- `vacuum` no longer refuses forever: a `-wal`/`-shm` sidecar only blocks when it still holds
  bytes; a 0-byte crash leftover is judged by the read-only open (fixture test included).
- `trash --apply` drops restored entries and their batch dirs out of `manifest.json`.
- Cursor coverage extended to the CLI tree (`~/.cursor/chats`, `~/.cursor/projects/*
  /agent-transcripts`), with `cli-auth.json`/`ide-session-token.txt`/`mcp.json`/`rules`
  pinned as `report-only` (user-confirmed paths, cited in `docs/agent-sources.md`).
- `continue` promoted from detect-only to a real adapter on `core/util/paths.ts` evidence:
  old session JSONs and `logs/` queue for trash, the `sessions.json` index and configs never.
- New gate test: every id in `ADAPTER_IDS` must appear in `docs/agent-sources.md`.
- New `doctor` command (roots, kind, entry count, mtime, `--json`), wired into both issue
  templates so a wrong path is reportable in one paste. Verified on a real Windows box:
  12 of 20 roots exist, and `scan --target cursor` found 813 MB reclaimable.
- The `EXDEV` trash copy path checks the destination volume's free space before copying.
- Suite: 40 tests, 39 passing, 1 skipped (the `JANITOR_REAL_DB=1` integration test).
