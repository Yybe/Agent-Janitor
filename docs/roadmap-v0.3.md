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

- **P0 correctness** — fix C1 macOS `Application Support`; add a family test that seeds the macOS layout so C2 cannot regress.
- **P1 structure** — fix C3: derive `AdapterId` and the CLI's `--target` list from one `ADAPTER_IDS` const.
- **P2 trust** — fix C5: `agent-janitor trash --list / --prune <90d>` over the existing manifest.
- **P3 coverage** — fix C7/C4: add verified adapters, delete or clearly label the unverified ones.
- **P4 distribution** — fix C6/C8/C9: `prepack` build script, npm publish workflow, tag v0.3.0, silence the SQLite warning, README truth pass.

Sequential P0-P2, then coverage. Each step lands with a test.
