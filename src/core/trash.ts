import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { formatBytes, home } from '../util.js';
import { diskFree } from './safety.js';

const DAY = 86_400_000;

export interface TrashEntry {
  id: string;
  batch: string;
  originalPath: string;
  trashPath: string;
  bytes: number;
  mtimeMs: number | undefined;
  adapter: string;
  kind: string;
  description: string;
  movedAt: string;
  restoredAt?: string;
}

export interface Manifest {
  version: 1;
  entries: TrashEntry[];
}

export function trashRoot(): string {
  return home('.agent-janitor', 'trash');
}

function manifestPath(): string {
  return path.join(trashRoot(), 'manifest.json');
}

async function readManifest(): Promise<Manifest> {
  try {
    const raw = await fsp.readFile(manifestPath(), 'utf8');
    const parsed = JSON.parse(raw) as Manifest;
    if (parsed?.version === 1 && Array.isArray(parsed.entries)) return parsed;
  } catch {
    /* no manifest yet */
  }
  return { version: 1, entries: [] };
}

async function writeManifest(m: Manifest): Promise<void> {
  await fsp.mkdir(trashRoot(), { recursive: true });
  const tmp = `${manifestPath()}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, JSON.stringify(m, null, 2), 'utf8');
  await fsp.rename(tmp, manifestPath());
}

export interface MoveToTrashInput {
  targetPath: string;
  bytes: number;
  mtimeMs: number | undefined;
  adapter: string;
  kind: string;
  description: string;
}

/**
 * A cross-volume trash move copies before it removes, so a full trash volume would fail
 * mid-copy with the original still in place. Check first and say how much is missing.
 */
export async function requireCopyFits(trashPath: string, bytes: number): Promise<void> {
  const free = await diskFree(trashPath);
  if (free !== undefined && free < bytes) {
    throw new Error(
      `${path.dirname(trashPath)} is on a different volume with ${formatBytes(free)} free, ` +
        `but ${formatBytes(bytes)} must be copied there. Free space, or move the trash root ` +
        `to the source volume before running again.`,
    );
  }
}

/** Move one file or directory into the janitor trash; never deletes anything. */
export async function moveToTrash(input: MoveToTrashInput): Promise<TrashEntry> {
  const batch = new Date().toISOString().replace(/[:.]/g, '-');
  const batchDir = path.join(trashRoot(), batch);
  await fsp.mkdir(batchDir, { recursive: true });
  const manifest = await readManifest();
  const index = manifest.entries.filter((e) => e.batch === batch).length + 1;
  const base = path.basename(input.targetPath) || 'unnamed';
  const trashPath = path.join(batchDir, `${String(index).padStart(4, '0')}__${base}`);
  try {
    await fsp.rename(input.targetPath, trashPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      // cross-volume: copy then remove original (still recoverable via the copy)
      await requireCopyFits(trashPath, input.bytes);
      await fsp.cp(input.targetPath, trashPath, { recursive: true });
      await fsp.rm(input.targetPath, { recursive: true });
    } else {
      throw err;
    }
  }
  const entry: TrashEntry = {
    id: `${batch}#${index}`,
    batch,
    originalPath: input.targetPath,
    trashPath,
    bytes: input.bytes,
    mtimeMs: input.mtimeMs,
    adapter: input.adapter,
    kind: input.kind,
    description: input.description,
    movedAt: new Date().toISOString(),
  };
  manifest.entries.push(entry);
  await writeManifest(manifest);
  return entry;
}

export async function listTrash(): Promise<TrashEntry[]> {
  return (await readManifest()).entries;
}

export interface PruneResult {
  expired: TrashEntry[];
  bytes: number;
  failed: Array<{ id: string; error: string }>;
}

/**
 * Find (and with `apply`, permanently delete) trashed items older than `olderThanDays`.
 * Restored entries point at the original path, not at trash, so `apply` drops them from the
 * manifest with their batch dir; they never count as freed space.
 */
export async function pruneTrash(olderThanDays: number, apply: boolean): Promise<PruneResult> {
  const cutoff = Date.now() - olderThanDays * DAY;
  const manifest = await readManifest();
  const expired = manifest.entries.filter((e) => !e.restoredAt && Date.parse(e.movedAt) < cutoff);
  const restored = manifest.entries.filter((e) => e.restoredAt);
  const failed: PruneResult['failed'] = [];
  let bytes = 0;
  if (apply && (expired.length > 0 || restored.length > 0)) {
    const victims = new Set(expired.map((e) => e.id));
    for (const e of expired) {
      try {
        await fsp.rm(e.trashPath, { recursive: true, force: true });
        bytes += e.bytes;
      } catch (err) {
        failed.push({ id: e.id, error: err instanceof Error ? err.message : String(err) });
        victims.delete(e.id);
      }
    }
    const dropped = new Set(victims);
    for (const e of restored) dropped.add(e.id);
    const remaining = manifest.entries.filter((e) => !dropped.has(e.id));
    await writeManifest({ version: 1, entries: remaining });
    for (const dir of new Set([...expired, ...restored].map((e) => e.batch))) {
      // rmdir, not rm: a fresh item in the same batch keeps the dir alive
      await fsp.rmdir(path.join(trashRoot(), dir)).catch(() => {});
    }
  }
  return { expired, bytes, failed };
}

export async function restoreFromTrash(idOrPrefix: string): Promise<TrashEntry> {
  const manifest = await readManifest();
  const candidates = manifest.entries.filter((e) => !e.restoredAt && e.id.startsWith(idOrPrefix));
  if (candidates.length !== 1) {
    throw new Error(
      candidates.length === 0
        ? `no active trash entry matches "${idOrPrefix}" (use janitor restore --list)`
        : `"${idOrPrefix}" is ambiguous, matches ${candidates.length} entries`,
    );
  }
  const entry = candidates[0]!;
  let stat;
  try {
    stat = await fsp.stat(entry.trashPath);
  } catch {
    throw new Error(`trashed item is gone from ${entry.trashPath}`);
  }
  if (stat) {
    try {
      await fsp.access(entry.originalPath);
      throw new Error(`refusing to restore: ${entry.originalPath} already exists`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('refusing')) throw err;
      /* original gone — good */
    }
  }
  await fsp.mkdir(path.dirname(entry.originalPath), { recursive: true });
  try {
    await fsp.rename(entry.trashPath, entry.originalPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      await fsp.cp(entry.trashPath, entry.originalPath, { recursive: true });
      await fsp.rm(entry.trashPath, { recursive: true });
    } else {
      throw err;
    }
  }
  entry.restoredAt = new Date().toISOString();
  await writeManifest(manifest);
  return entry;
}
