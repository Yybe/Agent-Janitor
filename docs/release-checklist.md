# Release checklist

Publishing is automated: pushing a `v*` tag runs `.github/workflows/release.yml`, which builds,
tests and runs `npm publish` with provenance on `ubuntu-latest`. It needs one repo secret.

- [ ] `secrets.NPM_TOKEN` exists and can publish. Either an npm automation token (npm dashboard →
      Access Tokens → "Read and publish", 2FA required on the account), or trusted publishing, in
      which case delete the `NODE_AUTH_TOKEN` line so npm falls back to the OIDC token the
      workflow already requests. The first publish of a brand-new package name usually has to use
      an automation token, because a granular token cannot be scoped to a package that does not
      exist yet.
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
