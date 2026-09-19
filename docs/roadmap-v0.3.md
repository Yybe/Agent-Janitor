# agent-janitor v0.3 continuation plan

Audited 2026-09-19 against the working tree (18/18 tests green) and against how
maintained OSS cleanup tools ship (Bun, gh, dust/du-disk, ncu, Pearcleaner).

## Critique — what holds the project back

| # | Finding | Why it costs credibility |
|---|---|---|
| C1 | `appData()` returns `~/.config` on macOS. Real Electron/VS-Code-family data lives in `~/Library/Application Support`. | Cursor, Kiro-IDE, Antigravity, Roo and VS Code/Copilot adapters find **nothing** on macOS while README claims "OS: Linux, macOS, Windows". First macOS user files a bug; first reviewer reads `util.ts` and stops trusting the rest. |
| C2 | The VS-Code-family path is never seeded by a test — `helpers.ts` only plants claude/codex/opencode files. | CI is green on macos-latest while C1 is broken. A green matrix that does not exercise the OS-specific branch is decoration. |
| C3 | Adapter ids duplicated in 4 places: `types.ts` union, `scan.ts` SCANNERS map, `scan.ts` ALL list, `cli.ts` valid list. | Adding a harness means four coordinated edits. Contributes get it wrong; reviewers see churn and refuse. |
| C4 | `aider` is a report-only no-op; `openclaw` and `continue` use a generic `scanMarker()` with guessed directory names. | README's Compatibility list reads as 14 supported harnesses; the honest number is ~9. Overstating coverage is the fastest way to be labelled an LLM-written vaporware repo. |
| C5 | Trash has no TTL and no prune command. | A cleanup tool that leaks disk forever is the joke reviewers make. |
| C6 | README quick start is `npx agent-janitor`; the name is not published to npm (registry 404). | Copy-paste fails on the first line of the funnel. |
| C7 | Missing the highest-volume harnesses: Windsurf, Zed, Goose, Amazon Q, Trae, VS Code extension `state.vscdb`. | "Supports most products" is the whole pitch. Coverage is the product. |
| C8 | No npm-publish / release workflow, no git tag. `dist` is untracked, so `npm pack` relies on a prepack build that does not exist. | Nothing to install means nothing to adopt. |
| C9 | Node prints `ExperimentalWarning: SQLite` on every run. | Noise on line one of every README screenshot. |

New adapters ship only with a verified path + citation. No more `scanMarker` guessing.

## Plan

- **P0 correctness** — fix C1 macOS `Application Support`; add a family test that seeds the macOS layout so C2 cannot regress. ✅ done
- **P1 structure** — fix C3: derive `AdapterId` and the CLI's `--target` list from one `ADAPTER_IDS` const. ✅ done
- **P2 trust** — fix C5: `agent-janitor trash --list / --prune <90d>` over the existing manifest. ✅ done as `trash` / `trash --apply`
- **P3 coverage** — fix C7/C4: add verified adapters, delete or clearly label the unverified ones. ✅
  Zed, Qwen Code, Kimi CLI, Amazon Q, Crush, Windsurf added from source constants; OpenClaw and
  Continue demoted to `report-only` in code (the README already claimed that; the code did not).
  Evidence corpus: `docs/agent-sources.md`. 20 adapters, 25 tests.
- **P4 distribution** — fix C6/C8/C9: `prepare` build script, npm publish workflow, tarball install smoke in CI, README truth pass. ✅ done; tag + publish pending

## Found while executing, not yet fixed

- `probeDbLocks` refuses whenever a `-wal`/`-shm` sidecar exists. After a harness crash those
  files linger with nothing holding the DB, so `vacuum` becomes permanently unusable and the only
  user remedy is deleting sidecars by hand. Proposed: allow a 0-byte `-wal` when the read-only
  open succeeds, and add `--force-unlock` that says what it assumes. Safety-critical — needs its
  own fixture test, not a drive-by change.
- `restore` leaves restored entries in `manifest.json` forever. Harmless (bytes are back on disk,
  not in trash), but the manifest grows. Prune them with `trash --apply`.
- README example output is illustrative, not a captured run. A real terminal GIF or `vhs`-generated
  tape would replace it — adoption is decided in the first eight lines.

## v0.4 — what best-in-class still has that we do not

Ranked by what changes adoption, from the comparison against ccusage, Mole, dust, ripgrep,
nvim-lspconfig and npm-check-updates:

1. Publish to npm + tag + GitHub Release (`gh release create --generate-notes`). `npx github:…`
   works, `npx agent-janitor` does not, and the name-squat risk grows daily.
2. `history` command + append-only operations log + a user-editable protect list — the two
   questions that stop an uninstall-on-sight are "what did it do last week" and "how do I tell it
   never to touch this". `manifest.json` answers neither today.
3. `SECURITY_AUDIT.md` dated and versioned, with a protected-prefix table where each row cites the
   fixture test that enforces it. `docs/safety.md` is most of the content; the test mapping is the
   trust leap.
4. Generate the README "What it cleans" table from the registry (a `tier` field per adapter) so the
   docs cannot overstate coverage, plus named exemplar adapters in CONTRIBUTING
   ("copy `scanQwen`") and seeded `good-first-issue`s from `new-harness.yml`.
5. Table stakes: dependabot, `.gitattributes` (a tool that writes trash manifests on Windows),
   `FUNDING.yml` + `package.json` funding, a linter (`--max-warnings 0`), CI jobs split
   lint/typecheck/test, packed-tarball E2E that runs all commands against a fake home and asserts
   `--json` parses.
6. Next adapters, blocked on hardware rather than research: Goose (macOS root contradicts its own
   comment; needs a Mac), Warp (per-OS log/cache documented, `warp.sqlite` location not),
   Trae, OpenHands, iFlow, Droid — see the "deliberately not shipped" table in
   `docs/agent-sources.md`.
