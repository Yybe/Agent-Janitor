import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { home } from '../util.js';
import type { SchemaGateResult } from '../types.js';

/**
 * The newest drizzle migration this tool's DB logic was written and tested against.
 * If a DB does not contain this migration, or contains DDL we don't recognize, we
 * refuse to operate — OpenCode's schema is allowed to drift, we fail closed.
 */
export const ANCHOR_MIGRATION = '20260504145000_add_sync_owner';

/** DDL signatures that must be present for our event-compaction logic to be valid. */
const REQUIRED_DDL_SIGNATURES: Array<{ table: string; mustContain: string[] }> = [
  { table: 'event', mustContain: ['aggregate_id', 'seq', 'type', 'data', 'event_sequence'] },
  { table: 'message', mustContain: ['session_id', 'data', 'REFERENCES'] },
  { table: 'part', mustContain: ['message_id', 'session_id', 'data', 'REFERENCES'] },
  { table: 'session', mustContain: ['time_updated', 'data'] },
];

export interface LockProbe {
  ok: boolean;
  reason?: string;
  walPresent: boolean;
  shmPresent: boolean;
}

/** Refuse to touch a DB that a harness may be holding open (WAL/SHM sidecars are the tell). */
export async function probeDbLocks(dbPath: string): Promise<LockProbe> {
  const wal = `${dbPath}-wal`;
  const shm = `${dbPath}-shm`;
  const walPresent = await existsQuiet(wal);
  const shmPresent = await existsQuiet(shm);
  // Only a sidecar holding bytes proves anything: uncheckpointed frames may belong to a live
  // writer. A 0-byte leftover from a crashed harness holds no data, so the read-only open
  // below decides — it still fails closed if a writer really is on the file.
  for (const p of walPresent ? [wal, shm] : [shm]) {
    const st = await statQuiet(p);
    if (st && st.size > 0) {
      return {
        ok: false,
        walPresent,
        shmPresent,
        reason:
          `${p} exists with ${st.size} bytes — a harness process may have this database open. ` +
          `Close the harness (and wait a few seconds for checkpointing), then retry.`,
      };
    }
  }
  // read-only open proves the file is at least not exclusively locked
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec('SELECT 1');
    db.close();
  } catch (err) {
    return {
      ok: false,
      walPresent,
      shmPresent,
      reason: `database cannot be opened read-only (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  return { ok: true, walPresent, shmPresent };
}

async function existsQuiet(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function statQuiet(p: string): Promise<{ size: number } | undefined> {
  try {
    return await fsp.stat(p);
  } catch {
    return undefined;
  }
}

export function quickCheck(db: DatabaseSync): string {
  const row = db.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined;
  const value = row?.quick_check ?? 'unknown';
  return value === 'ok' ? 'ok' : value;
}

export function schemaGate(db: DatabaseSync): SchemaGateResult {
  try {
    const migrations = db
      .prepare('SELECT name FROM __drizzle_migrations ORDER BY id DESC')
      .all() as Array<{ name?: string | null }>;
    const names = migrations.map((m) => m.name ?? '');
    if (!names.includes(ANCHOR_MIGRATION)) {
      return {
        ok: false,
        reason: `anchor migration "${ANCHOR_MIGRATION}" not found — DB schema is older or newer than what agent-janitor supports`,
      };
    }
    for (const req of REQUIRED_DDL_SIGNATURES) {
      const row = db.prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?').get('table', req.table) as
        | { sql?: string | null }
        | undefined;
      const ddl = row?.sql ?? '';
      if (!ddl) return { ok: false, reason: `required table "${req.table}" is missing` };
      for (const frag of req.mustContain) {
        if (!ddl.includes(frag)) {
          return { ok: false, reason: `table "${req.table}" DDL no longer contains "${frag}" — schema drift, refusing` };
        }
      }
    }
    const latest = names.find((n) => n.length > 0) ?? ANCHOR_MIGRATION;
    return { ok: true, latestMigration: latest };
  } catch (err) {
    return { ok: false, reason: `schema gate failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * User-managed "never touch" list: `~/.agent-janitor/protect`, one path prefix per line,
 * `#` comments allowed. The answer to "how do I tell it never to touch this".
 */
export async function readProtectList(): Promise<string[]> {
  try {
    const raw = await fsp.readFile(home('.agent-janitor', 'protect'), 'utf8');
    return raw
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith('#'))
      .map(normalizePath);
  } catch {
    return [];
  }
}

/** Accept either slash style on any OS, no trailing separator. */
function normalizePath(p: string): string {
  return p.replace(/[\\/]+$/, '').replaceAll('/', path.sep);
}

export function isProtected(p: string, prefixes: string[]): boolean {
  const target = normalizePath(p);
  return prefixes.some((prefix) => target === prefix || target.startsWith(prefix + path.sep));
}

/** Free bytes on the volume holding p. Returns undefined when unsupported. */
export async function diskFree(p: string): Promise<number | undefined> {
  try {
    const s = await fsp.statfs(path.dirname(p));
    return s.bavail * s.bsize;
  } catch {
    return undefined;
  }
}

/** Throws unless the volume holding dbPath has at least `neededBytes` free. */
export async function requireHeadroom(dbPath: string, neededBytes: number): Promise<void> {
  const free = await diskFree(dbPath);
  if (free === undefined) return; // statfs unsupported → VACUUM's own failure modes apply
  if (free < neededBytes) {
    const gb = (neededBytes / 1024 ** 3).toFixed(2);
    const freeGb = (free / 1024 ** 3).toFixed(2);
    throw new Error(
      `insufficient disk headroom: VACUUM needs ~${gb} free (2× the DB) but only ${freeGb} is available on ${path.dirname(dbPath)}`,
    );
  }
}
