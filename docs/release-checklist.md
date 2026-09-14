# Release checklist

- [ ] `npm install` clean, `npm test` green (Linux/macOS/Windows via CI)
- [ ] `npm run build` green, no new warnings
- [ ] CLI smoke: `help`, `scan`, `clean` dry run, `restore --list`, `vacuum` dry run on fixture, `codex-gc` dry run on fixture, `--json` valid on each
- [ ] `npm pack`, install tarball in a temp dir, run `scan` from the packed binary
- [ ] `npm pack --dry-run` file list inspected (only `dist`, `README.md`, `LICENSE`)
- [ ] README commands re-run against the built CLI (no stale flags/output)
- [ ] Version bumped in `package.json`, `CHANGELOG.md` entry written
- [ ] Tag `vX.Y.Z`, GitHub release with notes + tarball hash
