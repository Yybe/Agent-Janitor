import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { home } from '../util.js';

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
