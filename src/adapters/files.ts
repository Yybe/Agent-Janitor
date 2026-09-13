import { promises as fsp } from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import type { AdapterId, Finding } from '../types.js';
import { deepSize, exists, home, newestMtime } from '../util.js';

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
  const bytes = st.isDirectory() ? await deepSize(p) : st.size;
  if (bytes === 0 && category === 'report-only') return undefined;
  return {
    adapter,
    kind,
    path: p,
    description,
    bytes,
    mtimeMs: st.mtimeMs,
    category,
    retentionAware,
  };
}

// ---------------------------------------------------------------------------
// opencode (files only; DB handled by adapters/opencode/db.ts)
// ---------------------------------------------------------------------------

export async function scanOpencodeFiles(retentionDays: number): Promise<Finding[]> {
  const out: Finding[] = [];
  const cutoff = Date.now() - retentionDays * DAY;

  // content-addressed session snapshots back /undo; old ones are reclaimable
  const snapshotDir = home('.local', 'share', 'opencode', 'snapshot');
  if (exists(snapshotDir)) {
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(snapshotDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = path.join(snapshotDir, e.name);
      const mtime = await newestMtime(p, 2);
      if (mtime === 0 || mtime >= cutoff) continue;
      const bytes = await deepSize(p);
      if (bytes === 0) continue;
      out.push({
        adapter: 'opencode',
        kind: 'snapshot-dir',
        path: p,
        description: `old session snapshot (backs /undo for sessions unused ${retentionDays}d+)`,
        bytes,
        mtimeMs: mtime,
        category: 'trash',
        retentionAware: true,
      });
    }
  }

  // logs are ephemeral — any size, any age
  const logDir = home('.local', 'share', 'opencode', 'log');
  if (exists(logDir)) {
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(logDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const e of entries) {
      if (!e.isFile()) continue;
      const p = path.join(logDir, e.name);
      const st = await fsp.stat(p);
      if (st.size < 1_048_576) continue; // only bother with logs >= 1 MB
      out.push({
        adapter: 'opencode',
        kind: 'log',
        path: p,
        description: 'harness log file (ephemeral)',
        bytes: st.size,
        mtimeMs: st.mtimeMs,
        category: 'trash',
        retentionAware: false,
      });
    }
  }

  // stale config backups (*.backup-*)
  for (const dir of [home('.config', 'opencode')]) {
    if (!exists(dir)) continue;
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const e of entries) {
      if (!e.isFile() || !/\.(json|jsonc)\.backup-/.test(e.name)) continue;
      const p = path.join(dir, e.name);
      const f = await finding('opencode', 'stale-backup', p, 'old config backup file', 'trash', true);
      if (f && isOldEnough(f, cutoff)) out.push(f);
    }
  }

  // report-only: installed plugin deps (never touch)
  const nm = home('.config', 'opencode', 'node_modules');
  const nmFinding = await finding('opencode', 'report-dir', nm, 'installed plugin dependencies (managed by opencode)', 'report-only', false);
  if (nmFinding) out.push(nmFinding);

  return out;
}

// ---------------------------------------------------------------------------
// claude code
// ---------------------------------------------------------------------------

export async function scanClaude(retentionDays: number): Promise<Finding[]> {
  const out: Finding[] = [];
  const cutoff = Date.now() - retentionDays * DAY;
  const base = home('.claude');

  // session transcripts — the payload on most machines
  for (const dir of [path.join(base, 'transcripts'), path.join(base, 'projects')]) {
    if (!exists(dir)) continue;
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isFile()) {
        if (!e.name.endsWith('.jsonl')) continue;
        const st = await fsp.stat(p);
        if (st.mtimeMs >= cutoff) continue;
        out.push({
          adapter: 'claude',
          kind: 'session-file',
          path: p,
          description: 'session transcript older than retention',
          bytes: st.size,
          mtimeMs: st.mtimeMs,
          category: 'trash',
          retentionAware: true,
        });
      } else if (e.isDirectory() && dir.endsWith('projects')) {
        // project dirs contain per-project transcripts; mtime = newest activity inside
        const mtime = await newestMtime(p, 2);
        if (mtime === 0 || mtime >= cutoff) continue;
        const bytes = await deepSize(p);
        if (bytes === 0) continue;
        out.push({
          adapter: 'claude',
          kind: 'session-file',
          path: p,
          description: 'project session dir older than retention',
          bytes,
          mtimeMs: mtime,
          category: 'trash',
          retentionAware: true,
        });
      }
    }
  }

  // report-only: dirs Claude Code manages with its own retention (cleanupPeriodDays) or that are precious
  const notes: Array<[string, string]> = [
    ['shell-snapshots', 'recreated each session; native retention applies'],
    ['todos', 'native retention applies'],
    ['statsig', 'telemetry cache; native retention applies'],
    ['debug', 'native retention applies'],
    ['plugins', 'PRECIOUS — never delete'],
    ['settings.json', 'PRECIOUS — never delete'],
  ];
  for (const [name, why] of notes) {
    const p = path.join(base, name);
    const f = await finding('claude', 'report-dir', p, why, 'report-only', false);
    if (f) out.push(f);
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

  // session JSONLs: sessions/YYYY/MM/DD/rollout-*.jsonl
  const sessionsDir = path.join(base, 'sessions');
  if (exists(sessionsDir)) {
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(sessionsDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const y of entries) {
      if (!y.isDirectory()) continue;
      const yPath = path.join(sessionsDir, y.name);
      let months;
      try {
        months = await fsp.readdir(yPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const m of months) {
        if (!m.isDirectory()) continue;
        const mPath = path.join(yPath, m.name);
        let days;
        try {
          days = await fsp.readdir(mPath, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const d of days) {
          if (!d.isDirectory()) continue;
          const dPath = path.join(mPath, d.name);
          let files;
          try {
            files = await fsp.readdir(dPath, { withFileTypes: true });
          } catch {
            continue;
          }
          for (const f of files) {
            if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
            const p = path.join(dPath, f.name);
            const st = await fsp.stat(p);
            if (st.mtimeMs >= cutoff) continue;
            out.push({
              adapter: 'codex',
              kind: 'session-file',
              path: p,
              description: 'codex session rollout (resume history lost for this session)',
              bytes: st.size,
              mtimeMs: st.mtimeMs,
              category: 'trash',
              retentionAware: true,
            });
          }
          // remove empty day dirs from consideration (nothing to do — only files are trashed)
        }
      }
    }
  }

  // tmp junk (0-byte ..*.tmp-* etc.)
  if (exists(base)) {
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(base, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (!/^\.\..*\.tmp-/.test(e.name) && !/\.tmp-[^/]*$/.test(e.name)) continue;
      const p = path.join(base, e.name);
      const st = await fsp.stat(p);
      out.push({
        adapter: 'codex',
        kind: 'tmp-junk',
        path: p,
        description: 'abandoned temp file',
        bytes: st.size,
        mtimeMs: st.mtimeMs,
        category: 'trash',
        retentionAware: false,
      });
    }
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
    const p = path.join(base, name);
    const f = await finding('codex', 'report-dir', p, why, 'report-only', false);
    if (f) out.push(f);
  }
  return out;
}

// ---------------------------------------------------------------------------
// gemini cli
// ---------------------------------------------------------------------------

export async function scanGemini(retentionDays: number): Promise<Finding[]> {
  const out: Finding[] = [];
  const base = home('.gemini');
  const f = await finding('gemini', 'report-dir', base, 'gemini cli state (audited; cleanup rules TBD)', 'report-only', false);
  if (f) out.push(f);

  const tmpDir = path.join(base, 'tmp');
  if (exists(tmpDir)) {
    const mtime = await newestMtime(tmpDir, 2);
    const cutoff = Date.now() - retentionDays * DAY;
    if (mtime > 0 && mtime < cutoff) {
      const bytes = await deepSize(tmpDir);
      if (bytes > 0) {
        out.push({
          adapter: 'gemini',
          kind: 'tmp-junk',
          path: tmpDir,
          description: 'gemini tmp dir older than retention',
          bytes,
          mtimeMs: mtime,
          category: 'trash',
          retentionAware: true,
        });
      }
    }
  }
  return out;
}
