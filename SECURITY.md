# Security

This tool moves and deletes user data, so treat safety bugs as security bugs.

Report vulnerabilities privately: open a GitHub Security Advisory for
[Agent-Janitor](https://github.com/Yybe/Agent-Janitor) (Security tab → Advisories →
New draft advisory) rather than filing a public issue. Include the command run,
OS, Node version, and what you expected to be protected.

Known limits (not bugs, but stay aware):

- `vacuum --no-backup` / `--skip-proof` deliberately weaken the safety pipeline.
- Trash lives on the same machine (`~/.agent-janitor/trash`); it protects against
  mistakes, not disk failure or attackers.
- Cross-volume trash moves copy then remove; a crash mid-copy can leave both copies.
- Lock detection uses WAL/SHM sidecars plus a read-only open probe — a heuristic,
  not a kernel lock.
