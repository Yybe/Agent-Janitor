# Harness storage path evidence

Every path `agent-janitor` reads has to appear here with a primary source, or it does not
ship. This file is the corpus the issue templates and `CONTRIBUTING.md` point at: paste a row
into an issue and the adapter is a 20-line PR.

Classes:

- **(a) regenerable** — the harness rebuilds it. Trash-eligible after retention.
- **(b) user history** — transcripts, sessions, checkpoints. Trash-eligible after retention,
  with the consequence printed in the plan.
- **(c) precious** — settings, credentials, keymaps, MCP config, licenses. `report-only`, always.
- **(d) live DB** — an SQLite file a running harness owns. `report-only` unless this tool has a
  gated compaction path for it (today: OpenCode only).

Pinned at review time 2026-09-19. Re-verify a row before trusting it after a major harness
release; paths move.

## Cleaned adapters

| Harness | Path | Class | Evidence |
|---|---|---|---|
| OpenCode | `~/.local/share/opencode/storage`, `log/`, `~/.config/opencode/*.backup-*`, `opencode.db` | a/b/d | own product layout; DB compaction is gated by the schema anchor + reconstruction proof (see `docs/safety.md`) |
| Codex CLI | `~/.codex/sessions/**`, `~/.codex/*.tmp-*`, `refs/codex/turn-diffs/*` | b/a/b | OpenAI Codex CLI source + `git for-each-ref` layout |
| Claude Code | `~/.claude/projects`, `~/.claude/transcripts`, the 13 stale cache dirs, `history.jsonl`, `.claude.json.backup*` | b/a | anthropics/claude-code docs; `cleanupPeriodDays` is the native knob (nudge, not delete) |
| Gemini CLI | `~/.gemini/{tmp,cache,logs,sessions,history,checkpoints}` + precious `settings.json`/`GEMINI.md`/`oauth_creds.json` | a/b/c | google-gemini/gemini-cli docs |
| Kiro | `~/.kiro/sessions/<ws>/<sess>`, `session-index/*.jsonl`, `logs/`; precious `steering`, `settings`, `skills`, `powers` | b/a/c | Kiro CLI docs |
| Cursor | `<appData>/Cursor/User/workspaceStorage/<hash>`, `logs`, `Crashpad`, `CachedData`, `Code Cache`, `GPUCache`; `<localData>/cursor-updater` | a/b | forum.cursor.com/t/chat-history-folder/7653 (macOS `~/Library/Application Support/Cursor/…` vs Windows `%APPDATA%\Cursor\…`) |
| Antigravity | `<appData>/{Antigravity,Antigravity IDE}/User/workspaceStorage`, `~/.gemini/antigravity/{conversations,browser_recordings,crashes}` | a/b | Google Antigravity troubleshooting docs |
| Copilot (VS Code host) | `<appData>/Code/User/workspaceStorage/<hash>`; `~/.copilot/logs`, `media-cache`; `data.db` | a/b/d | GitHub Copilot docs; VS Code workspaceStorage layout |
| Cline | `~/.cline/data/workspaces/<hash>`; precious `data/db/sessions.db`, `cline_mcp_settings.json` | b/d/c | cline `apps/vscode/src/core/storage/disk.ts` (`getClineHomePath`) |
| Roo-Code | `<appData>/Roo-Code/User/workspaceStorage/<hash>` | a/b | VS Code extension host layout (same shape as Cursor) |
| Amp | `~/.amp/file-changes/<task-id>` | b | Amp (Sourcegraph) CLI state dir |
| Zed | data dir: macOS `~/Library/Application Support/Zed`, Linux `$XDG_DATA_HOME/zed`, Windows `%LOCALAPPDATA%\Zed`; logs macOS `~/Library/Logs/Zed` else `<data>/logs`; cache `~/Library/Caches/Zed` / `~/.cache/zed`; `embeddings/`, `extensions/`, `external_agents/`, `threads/threads.db`, `db/`; config `~/.config/zed` on **every** platform | a/b/c/d | zed-industries/zed `crates/paths/src/paths.rs` (pinned `916fc2b`), `crates/agent/src/db.rs:444`; runaway-log failure mode: zed-industries/zed#57042 (95 GB `logs/server-setup-5.log`) |
| Qwen Code | `~/.qwen/{projects/<hash>/chats,tmp,debug,ide,bin,arena}`; precious `settings.json`, `memory.md`, `commands/`, `oauth_creds.json`, `mcp-oauth-tokens.json` | b/a/c | QwenLM/qwen-code `packages/core/src/config/storage.ts` (`TMP_DIR_NAME`, `DEBUG_DIR_NAME`, `IDE_DIR_NAME`, `getGlobalDebugDir()`) |
| Kimi CLI | `~/.kimi/sessions/<md5(workdir)>/<session-id>/{wire.jsonl,context.jsonl}`; precious `config.toml`, `kimi.json`, `credentials/`, `mcp-oauth/`, `plugins/`, `skills/` | b/c | MoonshotAI/kimi-cli `metadata.py:34` (`sessions_dir`), `session.py:175`, `auth/oauth.py:264` |
| Amazon Q | `~/.aws/amazonq/cli-checkouts`, `.cli_bash_history`; logs `$TMPDIR/qlog` (unix) / `%TEMP%\amazon-q\logs` (Windows); data `~/.local/share/amazon-q` / `~/Library/Application Support/amazon-q` / `%LOCALAPPDATA%\amazon-q`; precious `config.json`, `global_context.json`, `mcp.json`, `prompts/`, `profiles/`, `knowledge_bases/`, `~/.aws/sso/cache` | b/a/d/c | aws/amazon-q-developer-cli `crates/chat-cli/src/util/paths.rs` (`SHADOW_REPO_DIR`, `logs_dir`, `database_path_static`, `mcp_auth_dir`) |
| Crush | cache `$XDG_CACHE_HOME/crush` / `%LOCALAPPDATA%\crush\cache` (`CRUSH_CACHE_DIR` overrides); config `~/.config/crush/{crushrc,crush.json}`; data `~/.local/share/crush/crush.json`; per-project `<cwd>/.crush/{crush.db,crush.lock,logs/crush.log}` | a/c/b/d | charmbracelet/crush `internal/filepath` (`GlobalCacheDir`, `GlobalConfig`, `GlobalConfigData`), `internal/db/connect.go`, `datadirlock.go:23` |
| Windsurf | `~/.codeium/windsurf/cascade` (chat history); precious `~/.codeium/windsurf/mcp_config.json` | b/c | docs.devin.ai/desktop/troubleshooting.md ("clearing your chat history (`~/.codeium/windsurf/cascade`)"), docs.devin.ai/desktop/cascade/mcp.md |

## Detected only — queued for nothing until proven

| Harness | Why it is not cleaned |
|---|---|
| OpenClaw | `~/.openclaw/{sessions,logs}` are the *expected* names, not a source constant. Home is measured, nothing queued. |
| Continue | same: `~/.continue/{sessions,logs}` unverified; `config.yaml` precious. |
| Aider | storage is per git root (`<root>/.aider.tags.cache.v3/` from `aider/repomap.py` `TAGS_CACHE_DIR`, `.aider.chat.history.md` from `args.py:272`). A global scan would have to walk the user's repos — not what this tool does. |
| VS Code `state.vscdb` | not verified against VS Code source in this pass; stays inside the workspaceStorage finding, which is trashed as a whole dir only after retention. |

## Researched and deliberately not shipped

| Harness | Blocker |
|---|---|
| Goose (Block) | Linux is proven (`~/.local/share/goose/sessions/sessions.db`, `<state>/logs/`), but the macOS root is contradictory: a code comment says `~/Library/Application Support/Block/goose/` while etcetera's Apple strategy computes a bundle-id dir. Also `~/.agents/plugins` is a **shared namespace** with other harnesses. Needs a real Mac. |
| Trae (ByteDance) | only `…/Trae/ModularData/ai-agent/snapshot` is documented; Linux root name, chat DB and its SQLCipher usage are unverified. |
| Warp | `~/Library/Logs/warp.log*`, Linux `~/.local/state/warp-terminal/`, Windows `%LOCALAPPDATA%\warp\Warp\{data\logs,cache}` are documented, but the exact macOS/Windows location of `warp.sqlite` is not — and AI transcripts are cloud-side. |
| OpenHands | persistence defaults to CWD-relative `workspace/conversations/`; global footprint is `~/.openhands`, which holds credentials. Guard only, no bytes. |
| iFlow CLI | settings paths documented (incl. `/etc/iflow-cli`, `C:\ProgramData\iflow-cli`); session dirs unverified. |
| Factory Droid | `~/.factory/{settings.json,specs,worktrees}` are documented, but `~/.factory/sessions/` is corroborated only by a third-party parser and the binary is closed-source. |

## Rules that fall out of this table

1. `appData()` (Roaming / Application Support / `$XDG_CONFIG_HOME`) for GUI app state,
   `localData()` (Local / Caches / `$XDG_CACHE_HOME`) for updaters and caches,
   `dataDir()` (Application Support / `$XDG_DATA_HOME`) for long-lived data. Never hardcode
   `~/.config` for a GUI app — that is the macOS false-negative that started this file.
2. A live SQLite file is `report-only` unless this tool has a gated compaction path for it.
3. Honor the harness's own env overrides (`CRUSH_CACHE_DIR`, `XDG_*`) when they exist, or the
   adapter scans the wrong tree on purpose.
4. Shared namespaces (`~/.agents/`) are never in scope, whatever the subdirectory is called.
