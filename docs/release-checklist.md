# Release checklist

Publishing is automated: pushing a `v*` tag runs `.github/workflows/release.yml`, which builds,
tests and runs `npm publish` with provenance on `ubuntu-latest`. Nothing else publishes: the
registry only accepts the tag run once the account has a publish credential.

- [ ] A publish credential exists for the account. Order matters:
      1. **First publish only** — npm's trusted publishing cannot create a package, so version 1
         has to come from a token: `npm login` locally and `npm publish --access public
         --no-provenance`, or put an npm automation token in `secrets.NPM_TOKEN` and let the tag
         run publish it.
      2. **Every publish after that** — switch to trusted publishing (npm dashboard → Publishing
         from CI → add `Yybe/Agent-Janitor` + `release.yml`), then delete the `NPM_TOKEN` guard and
         the `NODE_AUTH_TOKEN` line below it; `id-token: write` is already set. Tokens that bypass
         2FA are being restricted for direct publishing in January 2027, so this is the route that
         keeps working, and it produces provenance attestations for free.
- [ ] `npm profile get` reports `"tfa": true`. A fresh npm account without two-factor auth cannot
      publish at all; the registry answers `403 Forbidden … Two-factor authentication or granular
      access token with bypass 2fa enabled is required to publish packages.`
- [ ] After a failed tag run there is no need to re-tag: fix the secret, then "Re-run failed jobs"
      on the Actions run for that tag.
- [ ] `npm install` clean, `npm test` green (Linux/macOS/Windows via CI)
- [ ] `npm run build` green, no new warnings
- [ ] CLI smoke: `help`, `scan`, `clean` dry run, `restore --list`, `vacuum` dry run on fixture, `codex-gc` dry run on fixture, `--json` valid on each
- [ ] `npm pack`, install tarball in a temp dir, run `scan` from the packed binary
- [ ] `npm pack --dry-run` file list inspected (only `dist`, `README.md`, `LICENSE`)
- [ ] README commands re-run against the built CLI (no stale flags/output)
- [ ] Version bumped in `package.json`, `CHANGELOG.md` entry written
- [ ] Tag `vX.Y.Z`, GitHub release with notes + tarball hash
