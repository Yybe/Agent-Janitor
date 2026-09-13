import { promises as fsp } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { DbReport } from '../../types.js';
import { probeDbLocks, quickCheck, schemaGate, requireHeadroom, ANCHOR_MIGRATION } from '../../core/safety.js';
import { exists, home } from '../../util.js';

/**
 * OpenCode session DB adapter.
 *
 * The DB is an event-sourced log (`event`) beside materialized state
 * (`session`/`message`/`part`). Events of type `message.updated.1` and
 * `message.part.updated.1` carry FULL snapshots of an entity; older snapshots of
 * the same entity are pure overhead. We only delete an older snapshot after the
 * reconstruction proof shows that the newest snapshot of every live entity is
 * semantically identical to its live row — then older snapshots provably hold
 * zero information that is not kept elsewhere.
 */

const SNAPSHOT_TYPES = ['message.updated.1', 'message.part.updated.1'] as const;
const SNAPSHOT_TYPE_SQL = "('message.updated.1','message.part.updated.1')";

/** byte length via CAST; SQLite length() on TEXT counts characters, not bytes */
const BLEN = "length(CAST(data AS BLOB))";

/** the eid expression for each snapshot type */
const EID_SQL = "CASE type WHEN 'message.updated.1' THEN json_extract(data,'$.info.id') WHEN 'message.part.updated.1' THEN json_extract(data,'$.part.id') END";

export function defaultOpencodeDbPath(): string | undefined {
  const p = home('.local', 'share', 'opencode', 'opencode.db');
  return exists(p) ? p : undefined;
}

function openReadOnly(dbPath: string): DatabaseSync {
  return new DatabaseSync(dbPath, { readOnly: true });
}

export async function analyzeOpencodeDb(dbPath: string, retentionDays: number): Promise<DbReport> {
  let gate: ReturnType<typeof schemaGate>;
  try {
    const db = openReadOnly(dbPath);
    try {
      gate = schemaGate(db);
    } finally {
      db.close();
    }
  } catch (err) {
    gate = { ok: false, reason: `cannot open: ${err instanceof Error ? err.message : String(err)}` };
  }

  const fileStat = await fsp.stat(dbPath);
  const base: DbReport = {
    path: dbPath,
    fileBytes: fileStat.size,
    pageCount: 0,
    pageSize: 4096,
    freelistPages: 0,
    freelistBytes: 0,
    eventTypes: [],
    totalEventRows: 0,
    totalEventBytes: 0,
    supersededRows: 0,
    supersededBytes: 0,
    dupeRows: 0,
    dupeBytes: 0,
    sessions: { total: 0, oldestMs: 0, newestMs: 0 },
    staleSessions: { count: 0, estimatedBytes: 0, totalCost: 0, tokensInput: 0, tokensOutput: 0, tokensCacheRead: 0 },
    vacuumEstimateBytes: 0,
    schemaGate: gate,
  };
  if (!gate.ok) return base;

  const db = openReadOnly(dbPath);
  try {
    const page = db.prepare('PRAGMA page_count').get() as { page_count?: number };
    const size = db.prepare('PRAGMA page_size').get() as { page_size?: number };
    const free = db.prepare('PRAGMA freelist_count').get() as { freelist_count?: number };
    base.pageCount = Number(page?.page_count ?? 0);
    base.pageSize = Number(size?.page_size ?? 4096);
    base.freelistPages = Number(free?.freelist_count ?? 0);
    base.freelistBytes = base.freelistPages * base.pageSize;

    const types = db
      .prepare(`SELECT type, COUNT(*) AS rows, SUM(${BLEN}) AS bytes FROM event GROUP BY type ORDER BY bytes DESC`)
      .all() as Array<{ type: string; rows: number; bytes: number | null }>;
    base.eventTypes = types.map((t) => ({ type: t.type, rows: Number(t.rows), bytes: Number(t.bytes ?? 0) }));
    base.totalEventRows = base.eventTypes.reduce((a, t) => a + t.rows, 0);
    base.totalEventBytes = base.eventTypes.reduce((a, t) => a + t.bytes, 0);

    // compaction estimate: keep the newest snapshot per entity; older ones are reclaimable
    const compaction = compactionEstimate(db);
    base.supersededRows = compaction.rows;
    base.supersededBytes = compaction.bytes;

    // exact duplicates among big payloads (> 1 MB), byte-verified
    const dupes = findExactDupes(db);
    base.dupeRows = dupes.rows;
    base.dupeBytes = dupes.bytes;

    const sess = db
      .prepare('SELECT COUNT(*) AS n, MIN(time_updated) AS oldest, MAX(time_updated) AS newest FROM session')
      .get() as { n: number; oldest: number | null; newest: number | null };
    base.sessions = { total: Number(sess.n), oldestMs: Number(sess.oldest ?? 0), newestMs: Number(sess.newest ?? 0) };

    const cutoff = Date.now() - retentionDays * 86_400_000;
    const stale = db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(cost),0) AS cost, COALESCE(SUM(tokens_input),0) AS tin,
                COALESCE(SUM(tokens_output),0) AS tout, COALESCE(SUM(tokens_cache_read),0) AS tcache
         FROM session WHERE time_updated < ?`,
      )
      .get(cutoff) as { n: number; cost: number; tin: number; tout: number; tcache: number };
    const staleBytes = staleSessionBytesFor(db, cutoff);
    base.staleSessions = {
      count: Number(stale.n),
      estimatedBytes: staleBytes,
      totalCost: Number(stale.cost),
      tokensInput: Number(stale.tin),
      tokensOutput: Number(stale.tout),
      tokensCacheRead: Number(stale.tcache),
    };

    // NB: dupe rows may partially overlap superseded rows, so this is an upper bound;
    // the applied result is reported exactly after surgery.
    base.vacuumEstimateBytes = base.freelistBytes + base.supersededBytes + base.dupeBytes + staleBytes;
    return base;
  } finally {
    db.close();
  }
}

function compactionEstimate(db: DatabaseSync): { rows: number; bytes: number } {
  // temp tables live in the temp schema, so this works on a read-only main DB
  db.exec(
    `CREATE TEMP TABLE ev_rank (rid INTEGER PRIMARY KEY, eid TEXT, seq INTEGER, len INTEGER);
     INSERT INTO ev_rank (rid, eid, seq, len)
       SELECT rowid, ${EID_SQL}, seq, ${BLEN} FROM event WHERE type IN ${SNAPSHOT_TYPE_SQL};
     CREATE TEMP TABLE keep_rid (rid INTEGER PRIMARY KEY);
     INSERT INTO keep_rid (rid)
       SELECT rid FROM (SELECT rid, ROW_NUMBER() OVER (PARTITION BY eid ORDER BY seq DESC) AS rn FROM ev_rank)
       WHERE rn = 1;`,
  );
  const row = db
    .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(len),0) AS b FROM ev_rank WHERE rid NOT IN (SELECT rid FROM keep_rid)')
    .get() as { n: number; b: number };
  db.exec('DROP TABLE IF EXISTS temp.ev_rank; DROP TABLE IF EXISTS temp.keep_rid');
  return { rows: Number(row.n), bytes: Number(row.b) };
}

interface DupeCandidate {
  len: number;
  n: number;
  head: string;
}

interface DupeGroup {
  seen: string[];
  dupeRows: number;
  dupeBytes: number;
}

function dupeGroupKey(len: number, head: string): string {
  return `${len}|${head}`;
}

function dupeCandidates(db: DatabaseSync): Set<string> {
  const candidates = db
    .prepare(
      `SELECT ${BLEN} AS len, COUNT(*) AS n, substr(data,1,2048) AS head
       FROM event WHERE ${BLEN} > 1048576
       GROUP BY len, head HAVING n > 1`,
    )
    .all() as unknown as DupeCandidate[];
  return new Set(candidates.map((c) => dupeGroupKey(c.len, c.head)));
}

function findExactDupes(db: DatabaseSync): { rows: number; bytes: number } {
  const candKeys = dupeCandidates(db);
  if (candKeys.size === 0) return { rows: 0, bytes: 0 };
  const groups = new Map<string, DupeGroup>();
  const iter = db
    .prepare(
      `SELECT ${BLEN} AS len, substr(data,1,2048) AS head, data
       FROM event WHERE ${BLEN} > 1048576 ORDER BY rowid`,
    )
    .iterate() as IterableIterator<{ len: number; head: string; data: string }>;
  for (const row of iter) {
    const key = dupeGroupKey(row.len, row.head);
    if (!candKeys.has(key)) continue;
    let g = groups.get(key);
    if (!g) {
      g = { seen: [], dupeRows: 0, dupeBytes: 0 };
      groups.set(key, g);
    }
    if (g.seen.some((s) => s === row.data)) {
      g.dupeRows++;
      g.dupeBytes += row.len;
    } else {
      g.seen.push(row.data);
    }
  }
  let rows = 0;
  let bytes = 0;
  for (const g of groups.values()) {
    rows += g.dupeRows;
    bytes += g.dupeBytes;
  }
  return { rows, bytes };
}

function staleSessionBytesFor(db: DatabaseSync, cutoffMs: number): number {
  const cutoff = cutoffMs;
  const cond = `WHERE session_id IN (SELECT id FROM session WHERE time_updated < ?)`;
  const aggCond = `WHERE aggregate_id IN (SELECT id FROM session WHERE time_updated < ?)`;
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(n),0) AS total FROM (
         SELECT SUM(${BLEN}) AS n FROM message ${cond}
         UNION ALL
         SELECT SUM(${BLEN}) AS n FROM part ${cond}
         UNION ALL
         SELECT SUM(${BLEN}) AS n FROM event ${aggCond}
       )`,
    )
    .get(cutoff) as { total: number };
  return Number(row.total);
}

// ---------------------------------------------------------------------------
// reconstruction proof
// ---------------------------------------------------------------------------

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

export interface ProofResult {
  pass: boolean;
  checkedMessages: number;
  checkedParts: number;
  /** entities whose live row carries keys the newest snapshot lacks (row-side drift, e.g. fields added by newer harness versions) */
  driftMessages: number;
  driftParts: number;
  mismatches: string[];
}

export const proofSkipped: ProofResult = {
  pass: true,
  checkedMessages: 0,
  checkedParts: 0,
  driftMessages: 0,
  driftParts: 0,
  mismatches: [],
};

/**
 * Every leaf of `a` must exist in `b` with an equal value; `b` may add keys or
 * nested keys (row-side enrichment written after the event). Arrays are strict.
 */
function deepSubset(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) return deepEqual(a, b);
  for (const k of Object.keys(a as object)) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepSubset((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

/**
 * For a drifted entity (row has keys the newest snapshot lacks), older events of
 * the same entity must not carry keys the newest snapshot lacks — that would
 * mean partial/delta events whose context we would be destroying.
 */
function olderEventsIntroduceNewKeys(
  db: DatabaseSync,
  type: string,
  eidPath: string,
  eid: string,
  sid: string,
  newestSeq: number,
  newestKeys: Set<string>,
): boolean {
  const iter = db
    .prepare(
      `SELECT data FROM event WHERE type = ? AND aggregate_id = ? AND seq < ? AND json_extract(data, ?) = ?`,
    )
    .iterate(type, sid, newestSeq, eidPath, eid) as IterableIterator<{ data: string }>;
  for (const { data } of iter) {
    try {
      const payload = JSON.parse(data) as Record<string, unknown>;
      const inner = (eidPath.endsWith('$.info.id') ? payload.info : payload.part) as Record<string, unknown> | undefined;
      if (!inner) continue;
      const { id: _i, sessionID: _s, messageID: _m, ...restOlder } = inner;
      for (const k of Object.keys(restOlder)) {
        if (!newestKeys.has(k)) return true;
      }
    } catch {
      return true; // unparseable older event → assume the worst
    }
  }
  return false;
}

/**
 * Proves compaction is lossless. For every live entity the NEWEST snapshot
 * event must capture the live row: identical (normal case) or a subset of it
 * (row-side drift, e.g. fields added by newer harness versions after the event
 * was written — replay is unaffected because deleted events are always
 * overridden by the newest one during replay). For drifted entities we
 * additionally verify older events don't carry keys the newest lacks, which
 * would indicate delta chains that compaction would break.
 */
export function runReconstructionProof(db: DatabaseSync, log: (msg: string) => void): ProofResult {
  const result: ProofResult = {
    pass: true,
    checkedMessages: 0,
    checkedParts: 0,
    driftMessages: 0,
    driftParts: 0,
    mismatches: [],
  };

  db.exec(
    `CREATE TEMP TABLE newest_msg (eid TEXT PRIMARY KEY, mseq INTEGER);
     INSERT INTO newest_msg (eid, mseq)
       SELECT json_extract(data,'$.info.id') AS eid, MAX(seq) FROM event WHERE type='message.updated.1' GROUP BY eid;
     CREATE TEMP TABLE newest_part (eid TEXT PRIMARY KEY, mseq INTEGER);
     INSERT INTO newest_part (eid, mseq)
       SELECT json_extract(data,'$.part.id') AS eid, MAX(seq) FROM event WHERE type='message.part.updated.1' GROUP BY eid;`,
  );

  const msgStmt = db.prepare(
    `SELECT m.id AS mid, m.session_id AS sid, m.data AS rowdata, e.data AS evdata, e.seq AS eseq
     FROM message m JOIN temp.newest_msg n ON n.eid = m.id
     JOIN event e ON e.type='message.updated.1' AND e.aggregate_id = m.session_id AND e.seq = n.mseq`,
  );
  let progress = 0;
  for (const row of msgStmt.iterate() as IterableIterator<{
    mid: string;
    sid: string;
    rowdata: string;
    evdata: string;
    eseq: number;
  }>) {
    try {
      const info = (JSON.parse(row.evdata) as { info?: Record<string, unknown> }).info;
      if (!info || info.id !== row.mid) {
        result.pass = false;
        result.mismatches.push(`message ${row.mid}: newest event does not carry this message`);
      } else {
        const { id: _i, sessionID: _s, ...rest } = info;
        const rowData = JSON.parse(row.rowdata) as Record<string, unknown>;
        if (deepEqual(rest, rowData)) {
          result.checkedMessages++;
        } else if (deepSubset(rest, rowData)) {
          // row-side drift: row knows keys the event log never captured.
          // Safe only if older events don't reference keys absent from the newest snapshot.
          const newestKeys = new Set(Object.keys(rest));
          if (olderEventsIntroduceNewKeys(db, 'message.updated.1', '$.info.id', row.mid, row.sid, row.eseq, newestKeys)) {
            result.pass = false;
            result.mismatches.push(`message ${row.mid}: older events carry keys missing from newest snapshot (delta chain)`);
          } else {
            result.driftMessages++;
          }
        } else {
          result.pass = false;
          result.mismatches.push(`message ${row.mid}: newest snapshot contradicts live row`);
        }
      }
    } catch (err) {
      result.pass = false;
      result.mismatches.push(`message ${row.mid}: proof error ${err instanceof Error ? err.message : String(err)}`);
    }
    if (++progress % 5000 === 0) log(`proof: ${progress} entities verified`);
  }

  const partStmt = db.prepare(
    `SELECT p.id AS pid, p.session_id AS sid, p.data AS rowdata, e.data AS evdata, e.seq AS eseq
     FROM part p JOIN temp.newest_part n ON n.eid = p.id
     JOIN event e ON e.type='message.part.updated.1' AND e.aggregate_id = p.session_id AND e.seq = n.mseq`,
  );
  for (const row of partStmt.iterate() as IterableIterator<{
    pid: string;
    sid: string;
    rowdata: string;
    evdata: string;
    eseq: number;
  }>) {
    try {
      const part = (JSON.parse(row.evdata) as { part?: Record<string, unknown> }).part;
      if (!part || part.id !== row.pid) {
        result.pass = false;
        result.mismatches.push(`part ${row.pid}: newest event does not carry this part`);
      } else {
        const { id: _i, sessionID: _s, messageID: _m, ...rest } = part;
        const rowData = JSON.parse(row.rowdata) as Record<string, unknown>;
        if (deepEqual(rest, rowData)) {
          result.checkedParts++;
        } else if (deepSubset(rest, rowData)) {
          const newestKeys = new Set(Object.keys(rest));
          if (olderEventsIntroduceNewKeys(db, 'message.part.updated.1', '$.part.id', row.pid, row.sid, row.eseq, newestKeys)) {
            result.pass = false;
            result.mismatches.push(`part ${row.pid}: older events carry keys missing from newest snapshot (delta chain)`);
          } else {
            result.driftParts++;
          }
        } else {
          result.pass = false;
          result.mismatches.push(`part ${row.pid}: newest snapshot contradicts live row`);
        }
      }
    } catch (err) {
      result.pass = false;
      result.mismatches.push(`part ${row.pid}: proof error ${err instanceof Error ? err.message : String(err)}`);
    }
    if (++progress % 5000 === 0) log(`proof: ${progress} entities verified`);
  }

  db.exec('DROP TABLE IF EXISTS temp.newest_msg; DROP TABLE IF EXISTS temp.newest_part');
  return result;
}

// ---------------------------------------------------------------------------
// vacuum (surgery)
// ---------------------------------------------------------------------------

export interface VacuumOptions {
  dbPath: string;
  apply: boolean;
  backup: boolean;
  /** when set, sessions older than this many days are deleted entirely (opt-in) */
  deleteSessionsOlderThanDays?: number | undefined;
  skipProof: boolean;
  log: (msg: string) => void;
}

export interface VacuumOutcome {
  applied: boolean;
  proof: ProofResult;
  /** numbers gathered during the planning pass (exact for dupes/proof, estimates for VACUUM) */
  plan: {
    fileBytes: number;
    freelistPages: number;
    freelistBytes: number;
    supersededRows: number;
    supersededBytes: number;
    dupeRows: number;
    dupeBytes: number;
    sessionsTotal: number;
    staleSessions: number;
    staleSessionBytes: number;
  };
  deletedDupeRows: number;
  deletedSupersededRows: number;
  deletedSessions: number;
  deletedEventsForSessions: number;
  backupPath?: string;
  bytesBefore: number;
  bytesAfter?: number;
  integrityBefore?: string;
  integrityAfter?: string;
}

interface VacuumPlan {
  proof: ProofResult;
  eventCount: number;
  dupeDeleteRowids: number[];
  freelistPages: number;
  freelistBytes: number;
  supersededRows: number;
  supersededBytes: number;
  dupeRows: number;
  dupeBytes: number;
  sessionsTotal: number;
  staleSessions: number;
  staleSessionBytes: number;
}

export async function vacuumOpencodeDb(opts: VacuumOptions): Promise<VacuumOutcome> {
  const { dbPath, apply, log } = opts;
  const bytesBefore = (await fsp.stat(dbPath)).size;
  const outcome: VacuumOutcome = {
    applied: false,
    proof: proofSkipped,
    plan: {
      fileBytes: bytesBefore,
      freelistPages: 0,
      freelistBytes: 0,
      supersededRows: 0,
      supersededBytes: 0,
      dupeRows: 0,
      dupeBytes: 0,
      sessionsTotal: 0,
      staleSessions: 0,
      staleSessionBytes: 0,
    },
    deletedDupeRows: 0,
    deletedSupersededRows: 0,
    deletedSessions: 0,
    deletedEventsForSessions: 0,
    bytesBefore,
  };

  const locks = await probeDbLocks(dbPath);
  if (!locks.ok) throw new Error(locks.reason ?? 'database is locked');
  log('lock probe: no WAL/SHM sidecars, read-only open ok');

  {
    const db = openReadOnly(dbPath);
    try {
      const gate = schemaGate(db);
      if (!gate.ok) throw new Error(`schema gate: ${gate.reason}`);
      log(`schema gate: ok (anchor ${ANCHOR_MIGRATION}, latest ${gate.latestMigration})`);
    } finally {
      db.close();
    }
  }

  if (opts.apply) {
    await requireHeadroom(dbPath, bytesBefore * (opts.backup ? 3 : 2));
  }

  log('planning: reconstruction proof + duplicate scan ...');
  const plan = planVacuum(dbPath, opts, log);
  outcome.proof = plan.proof;
  outcome.plan = {
    fileBytes: bytesBefore,
    freelistPages: plan.freelistPages,
    freelistBytes: plan.freelistBytes,
    supersededRows: plan.supersededRows,
    supersededBytes: plan.supersededBytes,
    dupeRows: plan.dupeRows,
    dupeBytes: plan.dupeBytes,
    sessionsTotal: plan.sessionsTotal,
    staleSessions: plan.staleSessions,
    staleSessionBytes: plan.staleSessionBytes,
  };

  if (!apply) {
    log('dry run: no changes made (pass --apply to execute)');
    return outcome;
  }

  if (opts.backup) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    outcome.backupPath = `${dbPath}.janitor-backup-${stamp}`;
    log(`backup: copying DB -> ${outcome.backupPath} ...`);
    await fsp.copyFile(dbPath, outcome.backupPath);
  } else {
    log('WARNING: --no-backup given. If anything goes wrong there is NO way back.');
  }

  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    outcome.integrityBefore = quickCheck(db);
    if (outcome.integrityBefore !== 'ok') {
      throw new Error(`quick_check failed before surgery: ${outcome.integrityBefore}`);
    }

    // the DB may have changed between planning and writing — re-verify cheaply
    const nowCount = Number((db.prepare('SELECT COUNT(*) AS n FROM event').get() as { n: number }).n);
    if (nowCount !== plan.eventCount) {
      log(`event count changed since planning (${plan.eventCount} -> ${nowCount}); re-running proof`);
      const fresh = runReconstructionProof(db, log);
      outcome.proof = fresh;
      if (!fresh.pass) {
        throw new Error(`reconstruction proof FAILED after re-plan (${fresh.mismatches[0]}) — nothing changed`);
      }
    } else if (!opts.skipProof && !plan.proof.pass) {
      throw new Error(`reconstruction proof FAILED (${plan.proof.mismatches[0]}) — nothing changed`);
    }

    log('surgery: deleting superseded snapshot events ...');
    db.exec('BEGIN');
    try {
      // 1. exact duplicates (keep one per group)
      for (const rid of plan.dupeDeleteRowids) {
        db.prepare('DELETE FROM event WHERE rowid = ?').run(rid);
      }
      outcome.deletedDupeRows = plan.dupeDeleteRowids.length;

      // 2. superseded snapshots (keep newest per entity)
      db.exec(
        `CREATE TEMP TABLE keep_rid (rid INTEGER PRIMARY KEY);
         INSERT INTO keep_rid (rid)
           SELECT rid FROM (SELECT rowid AS rid,
                   ROW_NUMBER() OVER (PARTITION BY ${EID_SQL} ORDER BY seq DESC) AS rn
                 FROM event WHERE type IN ${SNAPSHOT_TYPE_SQL})
           WHERE rn = 1;`,
      );
      const sup = db
        .prepare(
          `DELETE FROM event WHERE type IN ${SNAPSHOT_TYPE_SQL} AND rowid NOT IN (SELECT rid FROM keep_rid)`,
        )
        .run();
      outcome.deletedSupersededRows = Number(sup.changes);
      db.exec('DROP TABLE IF EXISTS temp.keep_rid');

      // 3. opt-in session retention
      if (opts.deleteSessionsOlderThanDays !== undefined) {
        const cutoff = Date.now() - opts.deleteSessionsOlderThanDays * 86_400_000;
        db.exec('CREATE TEMP TABLE stale_ids (id TEXT PRIMARY KEY)');
        db.prepare('INSERT INTO stale_ids (id) SELECT id FROM session WHERE time_updated < ?').run(cutoff);
        const nStale = Number((db.prepare('SELECT COUNT(*) AS n FROM stale_ids').get() as { n: number }).n);
        const nEvents = Number(
          (
            db
              .prepare('SELECT COUNT(*) AS n FROM event WHERE aggregate_id IN (SELECT id FROM stale_ids)')
              .get() as { n: number }
          ).n,
        );
        log(
          `retention: deleting ${nStale} sessions older than ${opts.deleteSessionsOlderThanDays}d (cascades messages/parts/events)`,
        );
        const r1 = db.prepare('DELETE FROM session WHERE id IN (SELECT id FROM stale_ids)').run();
        outcome.deletedSessions = Number(r1.changes);
        // events cascade via event_sequence (FK); explicit sweep catches pre-FK rows
        db.prepare('DELETE FROM event_sequence WHERE aggregate_id IN (SELECT id FROM stale_ids)').run();
        db.prepare('DELETE FROM event WHERE aggregate_id IN (SELECT id FROM stale_ids)').run();
        outcome.deletedEventsForSessions = nEvents;
        db.exec('DROP TABLE IF EXISTS temp.stale_ids');
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    outcome.integrityAfter = quickCheck(db);
    if (outcome.integrityAfter !== 'ok') {
      throw new Error(`quick_check failed after deletes: ${outcome.integrityAfter} (backup: ${outcome.backupPath ?? 'NONE'})`);
    }

    log('VACUUM: rebuilding database file (this can take a while) ...');
    db.exec('VACUUM');
    outcome.integrityAfter = quickCheck(db);
    if (outcome.integrityAfter !== 'ok') {
      throw new Error(`quick_check failed after VACUUM: ${outcome.integrityAfter} (backup: ${outcome.backupPath ?? 'NONE'})`);
    }
  } finally {
    db.close();
  }

  outcome.bytesAfter = (await fsp.stat(dbPath)).size;
  outcome.applied = true;
  return outcome;
}

function planVacuum(dbPath: string, opts: VacuumOptions, log: (msg: string) => void): VacuumPlan {
  const db = openReadOnly(dbPath);
  try {
    const proof = opts.skipProof
      ? proofSkipped
      : runReconstructionProof(db, log);
    if (!proof.pass) {
      throw new Error(
        `reconstruction proof FAILED (${proof.mismatches.length} mismatches, first: ${proof.mismatches[0]}) — the event log is not a safe superset of live state; nothing changed`,
      );
    }
    log(
      opts.skipProof
        ? 'proof skipped by flag (--skip-proof)'
        : `proof passed: ${proof.checkedMessages} messages + ${proof.checkedParts} parts newest snapshots == live rows`,
    );
    const eventCount = Number((db.prepare('SELECT COUNT(*) AS n FROM event').get() as { n: number }).n);
    const dupeDeleteRowids = collectDupeDeleteRowids(db, log);

    const page = db.prepare('PRAGMA page_count').get() as { page_count?: number };
    const size = db.prepare('PRAGMA page_size').get() as { page_size?: number };
    const free = db.prepare('PRAGMA freelist_count').get() as { freelist_count?: number };
    const freelistPages = Number(free?.freelist_count ?? 0);
    const pageSize = Number(size?.page_size ?? 4096);
    const compaction = compactionEstimate(db);
    const dupes = findExactDupes(db);
    const sessionsTotal = Number((db.prepare('SELECT COUNT(*) AS n FROM session').get() as { n: number }).n);
    const retentionDays = opts.deleteSessionsOlderThanDays ?? 30;
    const cutoff = Date.now() - retentionDays * 86_400_000;
    const staleSessions = Number(
      (db.prepare('SELECT COUNT(*) AS n FROM session WHERE time_updated < ?').get(cutoff) as { n: number }).n,
    );
    const staleSessionBytes = staleSessionBytesFor(db, cutoff);

    return {
      proof,
      eventCount,
      dupeDeleteRowids,
      freelistPages,
      freelistBytes: freelistPages * pageSize,
      supersededRows: compaction.rows,
      supersededBytes: compaction.bytes,
      dupeRows: dupes.rows,
      dupeBytes: dupes.bytes,
      sessionsTotal,
      staleSessions,
      staleSessionBytes,
    };
  } finally {
    db.close();
  }
}

/** rowids of exact duplicates to remove (first occurrence in rowid order is kept) */
function collectDupeDeleteRowids(db: DatabaseSync, log: (msg: string) => void): number[] {
  const candKeys = dupeCandidates(db);
  if (candKeys.size === 0) return [];
  type Row = { rid: number; len: number; head: string; data: string };
  const groups = new Map<string, { seen: string[]; rowids: number[] }>();
  const iter = db
    .prepare(
      `SELECT rowid AS rid, ${BLEN} AS len, substr(data,1,2048) AS head, data
       FROM event WHERE ${BLEN} > 1048576 ORDER BY rowid`,
    )
    .iterate() as IterableIterator<Row>;
  for (const row of iter) {
    const key = dupeGroupKey(row.len, row.head);
    if (!candKeys.has(key)) continue;
    let g = groups.get(key);
    if (!g) {
      g = { seen: [], rowids: [] };
      groups.set(key, g);
    }
    if (g.seen.some((s) => s === row.data)) {
      g.rowids.push(row.rid);
    } else {
      g.seen.push(row.data);
    }
  }
  const deleteRowids: number[] = [];
  for (const [key, g] of groups) {
    if (g.rowids.length === 0) continue;
    const [lenStr] = key.split('|');
    log(`dupe: ${g.rowids.length} byte-identical ${Number(lenStr)}-byte payload(s) queued for deletion`);
    deleteRowids.push(...g.rowids);
  }
  return deleteRowids;
}
