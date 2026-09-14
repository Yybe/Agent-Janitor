# Contributing

```bash
npm install
npm test      # build + node:test suite (unit + CLI round-trips)
npm run dev -- scan
```

Architecture: `src/cli.ts` parses args and prints output, `src/report.ts` formats
human text, `src/core/` holds scan/trash/safety primitives, `src/adapters/`
holds one harness module each (`files.ts`, `opencode/db.ts`, `codex/checkpoints.ts`).

Adding a harness adapter: add a `scan<Name>` function in `src/adapters/files.ts`
(or a new file under `src/adapters/`) returning `Finding[]`, wire it into
`src/core/scan.ts`, keep unknown-age files `retentionAware` (fail closed), and
mark precious paths `report-only`, never `trash`.

Safety-related changes get extra review: lock detection, schema gates, the
reconstruction proof, trash/restore round-trips, and DB backup behavior must
stay fail-closed. Add a fixture test before changing any of them.

PRs: small diffs, tests included, `npm test` green on your machine. Bugs: include
the command, `--json` output when possible, OS, and Node version.
