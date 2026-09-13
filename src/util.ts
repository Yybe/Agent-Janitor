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
  return path.join(os.homedir(), ...segments);
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

/** Recursively measure the size of a file or directory. Missing paths → 0. */
export async function deepSize(p: string, symlinkBudget = { left: 64 }): Promise<number> {
  let st;
  try {
    st = await fsp.lstat(p);
  } catch {
    return 0;
  }
  if (st.isSymbolicLink()) {
    if (symlinkBudget.left-- <= 0) return 0;
    try {
      const real = await fsp.stat(p);
      if (real.isFile()) return real.size;
    } catch {
      return 0;
    }
    return 0;
  }
  if (st.isFile()) return st.size;
  let total = 0;
  let entries;
  try {
    entries = await fsp.readdir(p, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    // dotfiles included on purpose: hidden caches are exactly what we hunt
    total += await deepSize(path.join(p, e.name), symlinkBudget);
    if (total > Number.MAX_SAFE_INTEGER / 2) break;
  }
  return total;
}

/** Newest mtime within a directory tree (0 when unknown). */
export async function newestMtime(p: string, depth = 3): Promise<number> {
  let st;
  try {
    st = await fsp.stat(p);
  } catch {
    return 0;
  }
  let newest = st.mtimeMs;
  if (depth <= 0) return newest;
  let entries;
  try {
    entries = await fsp.readdir(p, { withFileTypes: true });
  } catch {
    return newest;
  }
  for (const e of entries) {
    const childNewest = await newestMtime(path.join(p, e.name), depth - 1);
    if (childNewest > newest) newest = childNewest;
  }
  return newest;
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
