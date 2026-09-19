import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { AdapterId, Finding } from '../types.js';
import { appData, collectFiles, exists, home, localData, walkSize } from '../util.js';

const DAY = 86_400_000;

/** Files/dirs are trash-eligible when older than the cutoff (or always, when retentionAware=false). */
export function isOldEnough(f: Finding, cutoffMs: number): boolean {
  if (!f.retentionAware) return true;
  if (f.mtimeMs === undefined) return false; // unknown age → keep (fail closed)
  return f.mtimeMs < cutoffMs;
}

async function finding(
  adapter: AdapterId,
  kind: string,
  p: string,
  description: string,
  category: 'trash' | 'report-only',
  retentionAware: boolean,
): Promise<Finding | undefined> {
  if (!exists(p)) return undefined;
  const st = await fsp.lstat(p);
  // stat only — walkSize never reads file contents, so this stays sub-second on GB stores
  const ws = st.isDirectory() ? await walkSize(p) : undefined;
  const bytes = ws ? ws.bytes : st.size;
  const mtimeMs = ws ? ws.newestMtimeMs > 0 ? ws.newestMtimeMs : undefined : st.mtimeMs;
  return { adapter, kind, path: p, description, bytes, mtimeMs, category, retentionAware };
}

/** Trash finding for a directory measured with one stat-only walk. */
async function dirFinding(
  adapter: AdapterId,
  kind: string,
  p: string,
  description: string,
  retentionAware: boolean,
  cutoffMs: number,
  minBytes = 1,
): Promise<Finding | undefined> {
  if (!exists(p)) return undefined;
  const ws = await walkSize(p);
  if (ws.bytes < minBytes) return undefined;
  const mtimeMs = ws.newestMtimeMs > 0 ? ws.newestMtimeMs : undefined;
  const f: Finding = { adapter, kind, path: p, description, bytes: ws.bytes, mtimeMs, category: 'trash', retentionAware };
  return isOldEnough(f, cutoffMs) ? f : undefined;
}

/** One trash finding per old immediate subdirectory of `parent` (sized in parallel). */
async function oldSubdirs(
  adapter: AdapterId,
  kind: string,
  parent: string,
  description: string,
  cutoffMs: number,
  minBytes = 1,
): Promise<Finding[]> {
  if (!exists(parent)) return [];
  let entries;
  try {
    entries = await fsp.readdir(parent);
  } catch {
    return [];
  }
  // ponytail: hand-rolled 16-way pool, no dep for one loop
  const out: Finding[] = [];
  const queue = entries.map((name) => path.join(parent, name));
  const workers = new Array(Math.min(16, queue.length)).fill(0).map(async () => {
    while (queue.length > 0) {
      const p = queue.pop()!;
      const f = await dirFinding(adapter, kind, p, description, true, cutoffMs, minBytes);
      if (f) out.push(f);
    }
  });
  await Promise.all(workers);
  out.sort((a, b) => (a.path < b.path ? -1 : 1));
  return out;
}

async function oldFiles(
  adapter: AdapterId,
  kind: string,
  dir: string,
  match: (name: string) => boolean,
  description: string,
  cutoffMs: number,
): Promise<Finding[]> {
  const out: Finding[] = [];
  if (!exists(dir)) return out;
  for (const f of await collectFiles(dir, 1)) {
    if (!match(path.basename(f.path))) continue;
    const item: Finding = {
      adapter,
      kind,
      path: f.path,
      description,
      bytes: f.bytes,
      mtimeMs: f.mtimeMs,
      category: 'trash',
      retentionAware: true,
    };
    if (isOldEnough(item, cutoffMs)) out.push(item);
  }
  return out;
}

// ---------------------------------------------------------------------------
// opencode (files only; DB handled by adapters/opencode/db.ts)
// ---------------------------------------------------------------------------

export async function scanOpencodeFiles(retentionDays: number): Promise<Finding[]> {
  const out: Finding[] = [];
  const cutoff = Date.now() - retentionDays * DAY;

  // content-addressed session snapshots back /undo; old ones are reclaimable
  out.push(...(await oldSubdirs('opencode', 'snapshot-dir', home('.local', 'share', 'opencode', 'snapshot'), `old session snapshot (backs /undo for sessions unused ${retentionDays}d+)`, cutoff)));

  // logs are ephemeral — any size, any age
  if (exists(home('.local', 'share', 'opencode', 'log'))) {
    for (const f of await collectFiles(home('.local', 'share', 'opencode', 'log'), 1)) {
      if (f.bytes < 1_048_576) continue; // only bother with logs >= 1 MB
      out.push({
        adapter: 'opencode',
        kind: 'log',
        path: f.path,
        description: 'harness log file (ephemeral)',
        bytes: f.bytes,
        mtimeMs: f.mtimeMs,
        category: 'trash',
        retentionAware: false,
      });
    }
  }

  // stale config backups (*.backup-*)
  if (exists(home('.config', 'opencode'))) {
    for (const f of await collectFiles(home('.config', 'opencode'), 1)) {
      if (!/\.(json|jsonc)\.backup-/.test(path.basename(f.path))) continue;
      const item = await finding('opencode', 'stale-backup', f.path, 'old config backup file', 'trash', true);
      if (item && isOldEnough(item, cutoff)) out.push(item);
    }
  }

  // report-only: installed plugin deps (never touch)
  const nm = await finding('opencode', 'report-dir', home('.config', 'opencode', 'node_modules'), 'installed plugin dependencies (managed by opencode)', 'report-only', false);
  if (nm) out.push(nm);

  return out;
}

// ---------------------------------------------------------------------------
// claude code (deep)
// ---------------------------------------------------------------------------

/** Claude slugifies project paths by replacing every non-alphanumeric char with '-'. */
export function claudeSlug(p: string): string {
  return p.replace(/[^A-Za-z0-9]/g, '-');
}

/** Real project paths from ~/.claude.json, best effort (missing file → no orphan detection). */
async function claudeKnownProjects(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const raw = await fsp.readFile(home('.claude.json'), 'utf8');
    const projects = (JSON.parse(raw) as { projects?: Record<string, unknown> }).projects ?? {};
    for (const k of Object.keys(projects)) map.set(claudeSlug(k), k);
  } catch {
    /* no registry — orphan detection skipped */
  }
  return map;
}

export async function scanClaude(retentionDays: number): Promise<Finding[]> {
  const out: Finding[] = [];
  const cutoff = Date.now() - retentionDays * DAY;
  const base = home('.claude');
  if (!exists(base)) return out;
  const known = await claudeKnownProjects();

  // session transcripts — the payload on most machines
  for (const dir of [path.join(base, 'transcripts'), path.join(base, 'projects'), path.join(base, 'sessions')]) {
    if (!exists(dir)) continue;
    let entries;
    try {
      entries = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const p = path.join(dir, name);
      let st;
      try {
        st = await fsp.lstat(p);
      } catch {
        continue;
      }
      if (st.isFile()) {
        if (!name.endsWith('.jsonl')) continue;
        const item: Finding = {
          adapter: 'claude',
          kind: 'session-file',
          path: p,
          description: 'session transcript older than retention',
          bytes: st.size,
          mtimeMs: st.mtimeMs,
          category: 'trash',
          retentionAware: true,
        };
        if (isOldEnough(item, cutoff)) out.push(item);
      } else if (st.isDirectory() && (dir.endsWith('projects') || dir.endsWith('sessions'))) {
        const real = known.get(name);
        const orphan = dir.endsWith('projects') && known.size > 0 && (real === undefined || !exists(real));
        const ws = await walkSize(p);
        if (ws.bytes === 0) continue;
        const mtimeMs = ws.newestMtimeMs > 0 ? ws.newestMtimeMs : undefined;
        const item: Finding = {
          adapter: 'claude',
          kind: orphan ? 'orphan-project' : 'session-file',
          path: p,
          description: orphan
            ? `orphan project cache (source ${real ?? 'unknown'} gone — safe regardless of age)`
            : 'project session dir older than retention',
          bytes: ws.bytes,
          mtimeMs,
          category: 'trash',
          retentionAware: !orphan,
        };
        if (isOldEnough(item, cutoff)) out.push(item);
      }
    }
  }

  // history.jsonl: cap at 500 lines (GarrickZ2 rule); moving to trash is the restorable equivalent of truncating
  const hist = path.join(base, 'history.jsonl');
  try {
    const st = await fsp.stat(hist);
    const tail = await fsp.readFile(hist, 'utf8');
    if (tail.split('\n').length > 500) {
      out.push({
        adapter: 'claude',
        kind: 'history-log',
        path: hist,
        description: 'shell history over 500-line cap (trash it, or truncate to last 500 lines manually)',
        bytes: st.size,
        mtimeMs: st.mtimeMs,
        category: 'trash',
        retentionAware: false,
      });
    }
  } catch {
    /* absent — fine */
  }

  // ephemeral caches: trash when older than retention
  for (const d of ['usage-data', 'backups', 'feedback-bundles', 'debug', 'file-history', 'shell-snapshots', 'todos', 'tasks', 'plans', 'paste-cache', 'telemetry', 'cache', 'downloads']) {
    const p = path.join(base, d);
    if (d === 'usage-data') {
      out.push(...(await oldFiles('claude', 'cache-dir', p, (n) => n.endsWith('.html'), 'dated usage report', cutoff)));
      continue;
    }
    const f = await dirFinding('claude', 'cache-dir', p, `stale ${d} cache`, true, cutoff);
    if (f) out.push(f);
  }
  out.push(...(await oldFiles('claude', 'stale-backup', home(), (n) => n.startsWith('.claude.json.backup'), 'old claude config backup', cutoff)));

  // precious / natively managed — report-only
  for (const [name, why] of [
    ['statsig', 'telemetry cache; native retention applies'],
    ['plugins', 'PRECIOUS — never delete'],
    ['skills', 'PRECIOUS — never delete'],
    ['commands', 'PRECIOUS — never delete'],
    ['agents', 'PRECIOUS — never delete'],
    ['ide', 'PRECIOUS — never delete'],
    ['settings.json', 'PRECIOUS — never delete'],
    ['.credentials.json', 'PRECIOUS — never delete'],
  ] as Array<[string, string]>) {
    const f = await finding('claude', 'report-dir', path.join(base, name), why, 'report-only', false);
    if (f) out.push(f);
  }
  try {
    const settings = JSON.parse(await fsp.readFile(path.join(base, 'settings.json'), 'utf8')) as { cleanupPeriodDays?: number };
    if (settings.cleanupPeriodDays === undefined) {
      out.push({
        adapter: 'claude',
        kind: 'report-dir',
        path: path.join(base, 'settings.json'),
        description: 'no cleanupPeriodDays set — add {"cleanupPeriodDays": 14} for native retention',
        bytes: 0,
        mtimeMs: undefined,
        category: 'report-only',
        retentionAware: false,
      });
    }
  } catch {
    /* unreadable settings — skip the nudge */
  }
  return out;
}

// ---------------------------------------------------------------------------
// codex
// ---------------------------------------------------------------------------

export async function scanCodex(retentionDays: number): Promise<Finding[]> {
  const out: Finding[] = [];
  const cutoff = Date.now() - retentionDays * DAY;
  const base = home('.codex');
  if (!exists(base)) return out;

  // session JSONLs: sessions/YYYY/MM/DD/rollout-*.jsonl — one flat iterative walk
  const sessionsDir = path.join(base, 'sessions');
  if (exists(sessionsDir)) {
    for (const f of await collectFiles(sessionsDir)) {
      if (!f.path.endsWith('.jsonl')) continue;
      const item: Finding = {
        adapter: 'codex',
        kind: 'session-file',
        path: f.path,
        description: 'codex session rollout (resume history lost for this session)',
        bytes: f.bytes,
        mtimeMs: f.mtimeMs,
        category: 'trash',
        retentionAware: true,
      };
      if (isOldEnough(item, cutoff)) out.push(item);
    }
  }

  // tmp junk (0-byte ..*.tmp-* etc.)
  for (const f of await collectFiles(base, 1)) {
    const n = path.basename(f.path);
    if (!/^\.\..*\.tmp-/.test(n) && !/\.tmp-[^/]*$/.test(n)) continue;
    out.push({
      adapter: 'codex',
      kind: 'tmp-junk',
      path: f.path,
      description: 'abandoned temp file',
      bytes: f.bytes,
      mtimeMs: f.mtimeMs,
      category: 'trash',
      retentionAware: false,
    });
  }

  // report-only: live SQLite sets, caches, plugin runtime
  const reports: Array<[string, string]> = [
    ['plugins', 'plugin runtime incl. hidden .plugin-appserver (can be 100s of MB; managed by codex)'],
    ['cache', 'rebuildable cache; cleared on demand by codex'],
    ['logs_2.sqlite', 'live log DB — locked while codex runs'],
    ['queue_1.sqlite', 'live queue DB — locked while codex runs'],
    ['state_5.sqlite', 'live state DB — locked while codex runs'],
  ];
  for (const [name, why] of reports) {
    const f = await finding('codex', 'report-dir', path.join(base, name), why, 'report-only', false);
    if (f) out.push(f);
  }
  return out;
}

// ---------------------------------------------------------------------------
// gemini cli
// ---------------------------------------------------------------------------

export async function scanGemini(retentionDays: number): Promise<Finding[]> {
  const out: Finding[] = [];
  const cutoff = Date.now() - retentionDays * DAY;
  const base = home('.gemini');
  if (!exists(base)) return out;

  // ~/.gemini/antigravity/* belongs to the antigravity adapter — skip it here
  for (const d of ['tmp', 'cache', 'logs', 'sessions', 'checkpoints', 'history']) {
    const f = await dirFinding('gemini', d === 'tmp' || d === 'logs' ? 'tmp-junk' : 'session-file', path.join(base, d), `gemini ${d} dir older than retention`, true, cutoff);
    if (f) out.push(f);
  }
  const f = await finding('gemini', 'report-dir', base, 'gemini cli state (audited; see per-dir findings)', 'report-only', false);
  if (f) out.push(f);
  for (const [name, why] of [
    ['settings.json', 'PRECIOUS — never delete'],
    ['GEMINI.md', 'PRECIOUS — never delete'],
    ['oauth_creds.json', 'PRECIOUS — never delete'],
  ] as Array<[string, string]>) {
    const r = await finding('gemini', 'report-dir', path.join(base, name), why, 'report-only', false);
    if (r) out.push(r);
  }
  return out;
}

// ---------------------------------------------------------------------------
// kiro: ~/.kiro sessions + logs (+ Kiro IDE storage, VS-Code family)
// ---------------------------------------------------------------------------

export async function scanKiro(retentionDays: number): Promise<Finding[]> {
  const out: Finding[] = [];
  const cutoff = Date.now() - retentionDays * DAY;
  const base = home('.kiro');
  if (exists(base)) {
    // sessions/<workspace-id>/<session-id>/ — session bundles (messages.jsonl, session.json)
    if (exists(path.join(base, 'sessions'))) {
      let wss: string[];
      try {
        wss = await fsp.readdir(path.join(base, 'sessions'));
      } catch {
        wss = [];
      }
      for (const ws of wss) {
        out.push(...(await oldSubdirs('kiro', 'session-dir', path.join(base, 'sessions', ws), 'kiro session bundle older than retention (resume history lost)', cutoff)));
      }
    }
    out.push(...(await oldFiles('kiro', 'session-file', path.join(base, 'session-index'), (n) => n.endsWith('.jsonl'), 'kiro session index older than retention', cutoff)));
    out.push(...(await oldSubdirs('kiro', 'log', path.join(base, 'logs'), 'kiro harness log dir (ephemeral)', cutoff)));
    for (const [name, why] of [
      ['steering', 'PRECIOUS — product rules, never delete'],
      ['settings', 'PRECIOUS — never delete'],
      ['skills', 'PRECIOUS — never delete'],
      ['powers', 'PRECIOUS — never delete'],
    ] as Array<[string, string]>) {
      const r = await finding('kiro', 'report-dir', path.join(base, name), why, 'report-only', false);
      if (r) out.push(r);
    }
  }
  out.push(...(await scanVscodeFamily('kiro', [appData('Kiro')], cutoff)));
  if (out.length === 0 && !exists(base)) return out;
  return out;
}

// ---------------------------------------------------------------------------
// shared VS-Code-family scanner (Cursor / Kiro IDE / Antigravity / Code / Roo)
// ---------------------------------------------------------------------------

/**
 * One Electron app root: old workspaceStorage hashes (the big sink), ephemeral
 * logs, and regenerable caches. Quit the app first — same rule as the folk remedy.
 */
export async function scanVscodeFamily(adapter: AdapterId, roots: string[], cutoffMs: number): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const root of roots) {
    if (!exists(root)) continue;
    out.push(...(await oldSubdirs(adapter, 'workspace-dir', path.join(root, 'User', 'workspaceStorage'), 'workspace storage for a folder unused past retention (that folder\'s chat/composer history goes with it)', cutoffMs)));
    // logs: trash when big regardless of age (ephemeral), else when old
    const logs = path.join(root, 'logs');
    if (exists(logs)) {
      const ws = await walkSize(logs);
      if (ws.bytes >= 1_048_576 || (ws.newestMtimeMs > 0 && ws.newestMtimeMs < cutoffMs)) {
        out.push({
          adapter,
          kind: 'log',
          path: logs,
          description: 'IDE log dir (ephemeral)',
          bytes: ws.bytes,
          mtimeMs: ws.newestMtimeMs > 0 ? ws.newestMtimeMs : undefined,
          category: 'trash',
          retentionAware: false,
        });
      }
    }
    for (const [d, why] of [
      ['Crashpad', 'crash dumps (ephemeral)'],
      ['CachedData', 'regenerable extension/host cache — quit app first'],
      ['Code Cache', 'regenerable render cache — quit app first'],
      ['GPUCache', 'regenerable GPU cache — quit app first'],
    ] as Array<[string, string]>) {
      const f = await dirFinding(adapter, 'cache-dir', path.join(root, d), why, false, cutoffMs);
      if (f) out.push(f);
    }
  }
  return out;
}

export async function scanCursor(retentionDays: number): Promise<Finding[]> {
  const out: Finding[] = [];
  const cutoff = Date.now() - retentionDays * DAY;
  out.push(...(await scanVscodeFamily('cursor', [appData('Cursor')], cutoff)));
  const f = await dirFinding('cursor', 'cache-dir', localData('cursor-updater'), 'cursor updater cache', true, cutoff);
  if (f) out.push(f);
  if (out.length === 0 && !exists(appData('Cursor'))) return out;
  return out;
}

export async function scanAntigravity(retentionDays: number): Promise<Finding[]> {
  const out: Finding[] = [];
  const cutoff = Date.now() - retentionDays * DAY;
  out.push(...(await scanVscodeFamily('antigravity', [appData('Antigravity'), appData('Antigravity IDE')], cutoff)));
  // agent state under ~/.gemini/antigravity (verified on real machine)
  const ag = path.join(home('.gemini'), 'antigravity');
  if (exists(ag)) {
    out.push(...(await oldFiles('antigravity', 'conversation', path.join(ag, 'conversations'), (n) => n.endsWith('.pb') || n.endsWith('.db'), 'antigravity conversation snapshot older than retention', cutoff)));
    const rec = await dirFinding('antigravity', 'recording', path.join(ag, 'browser_recordings'), 'antigravity browser recording older than retention', true, cutoff);
    if (rec) out.push(rec);
    if (exists(path.join(ag, 'crashes'))) {
      for (const f of await collectFiles(path.join(ag, 'crashes'), 1)) {
        out.push({
          adapter: 'antigravity',
          kind: 'crash-log',
          path: f.path,
          description: 'antigravity crash log (ephemeral)',
          bytes: f.bytes,
          mtimeMs: f.mtimeMs,
          category: 'trash',
          retentionAware: false,
        });
      }
    }
  }
  if (out.length === 0 && !exists(ag) && !exists(appData('Antigravity')) && !exists(appData('Antigravity IDE'))) return out;
  return out;
}

export async function scanCopilot(retentionDays: number): Promise<Finding[]> {
  const out: Finding[] = [];
  const cutoff = Date.now() - retentionDays * DAY;
  out.push(...(await scanVscodeFamily('copilot', [appData('Code')], cutoff)));
  const base = home('.copilot');
  if (exists(base)) {
    if (exists(path.join(base, 'logs'))) {
      for (const f of await collectFiles(path.join(base, 'logs'), 1)) {
        out.push({
          adapter: 'copilot',
          kind: 'log',
          path: f.path,
          description: 'copilot CLI log (ephemeral)',
          bytes: f.bytes,
          mtimeMs: f.mtimeMs,
          category: 'trash',
          retentionAware: false,
        });
      }
    }
    const mc = await dirFinding('copilot', 'cache-dir', path.join(base, 'media-cache'), 'copilot media cache', true, cutoff);
    if (mc) out.push(mc);
    for (const db of ['data.db', 'repo-metadata-cache.db']) {
      const r = await finding('copilot', 'report-dir', path.join(base, db), 'live copilot DB — locked while copilot runs', 'report-only', false);
      if (r) out.push(r);
    }
  }
  if (out.length === 0 && !exists(base) && !exists(appData('Code'))) return out;
  return out;
}

export async function scanCline(retentionDays: number): Promise<Finding[]> {
  const out: Finding[] = [];
  const cutoff = Date.now() - retentionDays * DAY;
  const base = home('.cline');
  if (!exists(base)) return out;
  out.push(...(await oldSubdirs('cline', 'workspace-dir', path.join(base, 'data', 'workspaces'), 'cline workspace state older than retention', cutoff)));
  for (const [name, why] of [
    [path.join('data', 'db', 'sessions.db'), 'live cline sessions DB — locked while cline runs'],
    [path.join('data', 'settings', 'cline_mcp_settings.json'), 'PRECIOUS — never delete'],
  ] as Array<[string, string]>) {
    const r = await finding('cline', 'report-dir', path.join(base, name), why, 'report-only', false);
    if (r) out.push(r);
  }
  return out;
}

export async function scanAmp(retentionDays: number): Promise<Finding[]> {
  const out: Finding[] = [];
  const cutoff = Date.now() - retentionDays * DAY;
  const base = home('.amp');
  if (!exists(base)) return out;
  out.push(...(await oldSubdirs('amp', 'session-dir', path.join(base, 'file-changes'), 'amp file-change snapshot older than retention', cutoff)));
  return out;
}

export async function scanRoo(retentionDays: number): Promise<Finding[]> {
  const out: Finding[] = [];
  const cutoff = Date.now() - retentionDays * DAY;
  out.push(...(await scanVscodeFamily('roo', [appData('Roo-Code')], cutoff)));
  if (out.length === 0 && !exists(appData('Roo-Code'))) return out;
  return out;
}

/** Dir-absent harnesses: present with a note when a marker exists, else absent. */
export async function scanMarker(
  adapter: AdapterId,
  marker: string,
  trashDirs: string[],
  precious: Array<[string, string]>,
  retentionDays: number,
): Promise<Finding[]> {
  const out: Finding[] = [];
  if (!exists(marker)) return out;
  const cutoff = Date.now() - retentionDays * DAY;
  for (const d of trashDirs) {
    const f = await dirFinding(adapter, 'session-file', path.join(marker, d), `${adapter} ${d} older than retention`, true, cutoff);
    if (f) out.push(f);
  }
  for (const [name, why] of precious) {
    const r = await finding(adapter, 'report-dir', path.join(marker, name), why, 'report-only', false);
    if (r) out.push(r);
  }
  return out;
}

export async function scanOpenclaw(retentionDays: number): Promise<Finding[]> {
  return scanMarker('openclaw', home('.openclaw'), ['sessions', 'logs'], [['openclaw.json', 'PRECIOUS — never delete']], retentionDays);
}

export async function scanContinue(retentionDays: number): Promise<Finding[]> {
  return scanMarker('continue', home('.continue'), ['sessions', 'logs'], [['config.yaml', 'PRECIOUS — never delete']], retentionDays);
}

export async function scanAider(retentionDays: number): Promise<Finding[]> {
  const out: Finding[] = [];
  // aider histories live per-repo (.aider.chat.history.md); global marker only proves presence
  for (const m of [home('.aider.conf.yml'), home('.aider.model.settings.yml')]) {
    const r = await finding('aider', 'report-dir', m, 'aider config present — per-repo .aider.chat.history.md files are rotated manually (not scanned)', 'report-only', false);
    if (r) out.push(r);
  }
  void retentionDays;
  return out;
}
