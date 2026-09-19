import { promises as fsp, accessSync } from "node:fs";
import path from 'node:path';
import os from 'node:os';

export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return '?';
  const neg = n < 0;
  let v = Math.abs(n);
  if (v < 1024) return `${neg ? '-' : ''}${Math.round(v)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let u = -1;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${neg ? '-' : ''}${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[u]}`;
}

export function home(...segments: string[]): string {
  // test seam: fake homes inject via env (see test/helpers.ts runCli)
  const base = process.env.JANITOR_HOME ?? process.env.USERPROFILE ?? process.env.HOME ?? os.homedir();
  return path.join(base, ...segments);
}

/**
 * Electron / VS-Code-family app data root, per OS:
 * Windows `%APPDATA%` (Roaming), macOS `~/Library/Application Support`, Linux `$XDG_CONFIG_HOME` or `~/.config`.
 * Confirmed against Cursor's real layout: `~/Library/Application Support/Cursor/User/workspaceStorage`
 * vs `%APPDATA%\Cursor\User\workspaceStorage` (forum.cursor.com/t/chat-history-folder/7653).
 */
export function appData(...segments: string[]): string {
  const env = process.env;
  const base =
    env.JANITOR_APPDATA ??
    (process.platform === 'win32'
      ? env.APPDATA ?? home('AppData', 'Roaming')
      : process.platform === 'darwin'
        ? home('Library', 'Application Support')
        : env.XDG_CONFIG_HOME ?? home('.config'));
  return path.join(base, ...segments);
}

/**
 * Long-lived application data root: macOS `~/Library/Application Support`, Linux
 * `$XDG_DATA_HOME` or `~/.local/share`, Windows `%APPDATA%`. Zed splits config from data.
 */
export function dataDir(...segments: string[]): string {
  const env = process.env;
  const base =
    env.JANITOR_DATADIR ??
    (process.platform === 'win32'
      ? env.APPDATA ?? home('AppData', 'Roaming')
      : process.platform === 'darwin'
        ? home('Library', 'Application Support')
        : env.XDG_DATA_HOME ?? home('.local', 'share'));
  return path.join(base, ...segments);
}

/** Updater / crash / cache root: Windows `%LOCALAPPDATA%`, macOS `~/Library/Caches`, Linux `$XDG_CACHE_HOME` or `~/.cache`. */
export function localData(...segments: string[]): string {
  const env = process.env;
  const base =
    env.JANITOR_LOCALDATA ??
    (process.platform === 'win32'
      ? env.LOCALAPPDATA ?? home('AppData', 'Local')
      : process.platform === 'darwin'
        ? home('Library', 'Caches')
        : env.XDG_CACHE_HOME ?? home('.cache'));
  return path.join(base, ...segments);
}

export function exists(p: string): boolean {
  try {
    accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export async function statSafe(p: string): Promise<{ bytes: number; mtimeMs: number } | undefined> {
  try {
    const st = await fsp.stat(p);
    return { bytes: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return undefined;
  }
}

/** Run tasks with at most `n` in flight. Zero deps, enough for sibling-dir fan-out. */
async function parallel<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = new Array(Math.min(n, items.length)).fill(0).map(async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/** One iterative stat-only pass: total bytes + newest mtime + counts. Never reads file contents. */
export interface WalkStats {
  bytes: number;
  newestMtimeMs: number;
  files: number;
  dirs: number;
}

function mergeWalk(a: WalkStats, b: WalkStats): WalkStats {
  return {
    bytes: a.bytes + b.bytes,
    newestMtimeMs: Math.max(a.newestMtimeMs, b.newestMtimeMs),
    files: a.files + b.files,
    dirs: a.dirs + b.dirs,
  };
}

async function walkOne(entry: string, symlinkBudget: { left: number }): Promise<WalkStats> {
  const out: WalkStats = { bytes: 0, newestMtimeMs: 0, files: 0, dirs: 0 };
  const stack: string[] = [entry];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let st;
    try {
      st = await fsp.lstat(cur);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      if (symlinkBudget.left-- <= 0) continue;
      try {
        const real = await fsp.stat(cur);
        if (real.isFile()) {
          out.bytes += real.size;
          out.files++;
          if (real.mtimeMs > out.newestMtimeMs) out.newestMtimeMs = real.mtimeMs;
        }
      } catch {
        /* dangling — skip */
      }
      continue;
    }
    if (st.isFile()) {
      out.bytes += st.size;
      out.files++;
      if (st.mtimeMs > out.newestMtimeMs) out.newestMtimeMs = st.mtimeMs;
      continue;
    }
    if (!st.isDirectory()) continue;
    out.dirs++;
    if (st.mtimeMs > out.newestMtimeMs) out.newestMtimeMs = st.mtimeMs;
    const base = cur.split(/[\\/]/).pop() ?? '';
    // ponytail: skip-list ceiling is node_modules/.git only; extend when real stores hit it
    if (base === 'node_modules' || base === '.git') continue;
    let entries;
    try {
      entries = await fsp.readdir(cur);
    } catch {
      continue;
    }
    for (const e of entries) stack.push(path.join(cur, e));
  }
  return out;
}

export async function walkSize(root: string): Promise<WalkStats> {
  let rootSt;
  try {
    rootSt = await fsp.lstat(root);
  } catch {
    return { bytes: 0, newestMtimeMs: 0, files: 0, dirs: 0 };
  }
  if (!rootSt.isDirectory() || rootSt.isSymbolicLink()) return walkOne(root, { left: 64 });
  let entries;
  try {
    entries = await fsp.readdir(root);
  } catch {
    return { bytes: 0, newestMtimeMs: 0, files: 0, dirs: 0 };
  }
  // fan out over immediate children (16-way): workspaceStorage/<97 hashes> sizes in parallel
  const parts = await parallel(entries, 16, (e) => walkOne(path.join(root, e), { left: 64 }));
  let out: WalkStats = { bytes: 0, newestMtimeMs: rootSt.mtimeMs, files: 0, dirs: 1 };
  for (const p of parts) out = mergeWalk(out, p);
  return out;
}

export interface FileStat {
  path: string;
  bytes: number;
  mtimeMs: number;
}

/** Iterative per-file listing under root (stat only, no content reads). Sorted by path for stable output. */
export async function collectFiles(root: string, maxDepth = 8): Promise<FileStat[]> {
  const out: FileStat[] = [];
  const stack: Array<{ p: string; d: number }> = [{ p: root, d: 0 }];
  while (stack.length > 0) {
    const { p, d } = stack.pop()!;
    let st;
    try {
      st = await fsp.lstat(p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue; // never chase symlinks in scans
    if (st.isFile()) {
      out.push({ path: p, bytes: st.size, mtimeMs: st.mtimeMs });
      continue;
    }
    if (!st.isDirectory() || d >= maxDepth) continue;
    let entries;
    try {
      entries = await fsp.readdir(p);
    } catch {
      continue;
    }
    for (const e of entries) stack.push({ p: path.join(p, e), d: d + 1 });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : 1));
  return out;
}

/** Parse '30d' | '2w' | '1m' | '365' into days. */
export function parseRetention(input: string): number {
  const m = /^(\d+)\s*(d|w|m|y)?$/i.exec(input.trim());
  if (!m) throw new Error(`invalid retention: ${input} (expected e.g. 30d, 2w, 6m)`);
  const n = Number(m[1]);
  const unit = (m[2] ?? 'd').toLowerCase();
  const mult = unit === 'd' ? 1 : unit === 'w' ? 7 : unit === 'm' ? 30 : 365;
  return n * mult;
}
