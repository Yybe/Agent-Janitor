## What

One or two sentences on the change. Closes #.

## Evidence for paths touched

agent-janitor moves files, so every directory in the diff needs a source. Link the harness's own
path constant (file + line), its docs, or a user-confirmed bug report. If a path is unverified,
say so and keep it `report-only`.

| Path | Source |
|---|---|

## Tests

- [ ] `npm test` green locally
- [ ] fake-home test added/updated for any adapter change (old item flagged, fresh item spared,
      precious item `report-only`)
- [ ] macOS and Windows layouts covered, not just the CI host's
- [ ] fixture test added before touching lock detection, the schema gate, the reconstruction proof,
      trash/restore, or DB backup behavior

## Risk

What could this delete, restore incorrectly, or refuse that it used to accept?
