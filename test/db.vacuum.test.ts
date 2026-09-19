import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { analyzeOpencodeDb, vacuumOpencodeDb, defaultOpencodeDbPath } from '../src/adapters/opencode/db.js';
import { ANCHOR_MIGRATION } from '../src/core/safety.js';

const DAY = 86_400_000;

/**
 * Builds a miniature OpenCode-shaped DB with the real DDL shape (simplified):
 * superseded snapshot events, an exact-duplicate payload pair, and one stale session.
 */
function buildFixtureDb(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE \`__drizzle_migrations\` (\`id\` integer PRIMARY KEY AUTOINCREMENT, \`hash\` text, \`created_at\` integer, \`name\` text, \`applied_at\` text);
    CREATE TABLE \`event_sequence\` (\`aggregate_id\` text PRIMARY KEY, \`seq\` integer NOT NULL);
    CREATE TABLE \`event\` (\`id\` text PRIMARY KEY, \`aggregate_id\` text NOT NULL, \`seq\` integer NOT NULL, \`type\` text NOT NULL, \`data\` text NOT NULL,
      CONSTRAINT fk_event FOREIGN KEY (aggregate_id) REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE);
    CREATE UNIQUE INDEX event_aggregate_seq_idx ON event(aggregate_id, seq);
    CREATE TABLE \`session\` (\`id\` text PRIMARY KEY, \`time_updated\` integer NOT NULL, \`data\` text NOT NULL, \`cost\` real DEFAULT 0 NOT NULL,
      \`tokens_input\` integer DEFAULT 0 NOT NULL, \`tokens_output\` integer DEFAULT 0 NOT NULL, \`tokens_cache_read\` integer DEFAULT 0 NOT NULL);
    CREATE TABLE \`message\` (\`id\` text PRIMARY KEY, \`session_id\` text NOT NULL, \`time_created\` integer NOT NULL, \`time_updated\` integer NOT NULL, \`data\` text NOT NULL,
      FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE);
    CREATE TABLE \`part\` (\`id\` text PRIMARY KEY, \`message_id\` text NOT NULL, \`session_id\` text NOT NULL, \`time_created\` integer NOT NULL, \`time_updated\` integer NOT NULL, \`data\` text NOT NULL,
      FOREIGN KEY (message_id) REFERENCES message(id) ON DELETE CASCADE);
  `);
  db.prepare('INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at) VALUES (?,?,?,?)').run(
    '',
    Date.now(),
    ANCHOR_MIGRATION,
    new Date().toISOString(),
  );

  const now = Date.now();
  db.prepare('INSERT INTO session (id, time_updated, data) VALUES (?,?,?)').run('ses_fresh', now, '{}');
  db.prepare('INSERT INTO session (id, time_updated, data) VALUES (?,?,?)').run('ses_stale', now - 40 * DAY, '{}');
  db.prepare('INSERT INTO event_sequence (aggregate_id, seq) VALUES (?,?)').run('ses_fresh', 100);
  db.prepare('INSERT INTO event_sequence (aggregate_id, seq) VALUES (?,?)').run('ses_stale', 100);

  const insertEvent = db.prepare('INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?,?,?,?,?)');
  const insertMessage = db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)');
  const insertPart = db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)');

  // msg1 (fresh): row data, plus an older snapshot event missing `finish`, newest snapshot == row
  const msg1Data = { role: 'user', time: { created: 111 }, agent: 'build' };
  const msg1Newest = { id: 'msg1', sessionID: 'ses_fresh', ...msg1Data };
  insertMessage.run('msg1', 'ses_fresh', now, now, JSON.stringify(msg1Data));
  insertEvent.run('e1', 'ses_fresh', 1, 'message.updated.1', JSON.stringify({ sessionID: 'ses_fresh', info: { ...msg1Newest, agent: 'plan' } }));
  insertEvent.run('e2', 'ses_fresh', 2, 'message.updated.1', JSON.stringify({ sessionID: 'ses_fresh', info: msg1Newest }));

  // prt1 (fresh): older snapshot + newest == row
  const prt1Data = { type: 'text', text: 'hello world' };
  const prt1Newest = { id: 'prt1', sessionID: 'ses_fresh', messageID: 'msg1', ...prt1Data };
  insertPart.run('prt1', 'msg1', 'ses_fresh', now, now, JSON.stringify(prt1Data));
  insertEvent.run('e3', 'ses_fresh', 3, 'message.part.updated.1', JSON.stringify({ sessionID: 'ses_fresh', part: { ...prt1Newest, text: 'hello' } }));
  insertEvent.run('e4', 'ses_fresh', 4, 'message.part.updated.1', JSON.stringify({ sessionID: 'ses_fresh', part: prt1Newest }));

  // msg2 in the STALE session
  const msg2Data = { role: 'assistant', time: { created: 222 } };
  const msg2Newest = { id: 'msg2', sessionID: 'ses_stale', ...msg2Data };
  insertMessage.run('msg2', 'ses_stale', now, now, JSON.stringify(msg2Data));
  insertEvent.run('e5', 'ses_stale', 5, 'message.updated.1', JSON.stringify({ sessionID: 'ses_stale', info: { ...msg2Newest, agent: 'plan' } }));
  insertEvent.run('e6', 'ses_stale', 6, 'message.updated.1', JSON.stringify({ sessionID: 'ses_stale', info: msg2Newest }));

  // msg3 with a >1MB payload, snapshotted twice with BYTE-IDENTICAL payloads (dupe pair)
  const bigText = 'x'.repeat(1_500_000);
  const msg3Data = { role: 'user', time: { created: 333 }, text: bigText };
  const msg3Newest = { id: 'msg3', sessionID: 'ses_fresh', ...msg3Data };
  insertMessage.run('msg3', 'ses_fresh', now, now, JSON.stringify(msg3Data));
  insertEvent.run('e7', 'ses_fresh', 7, 'message.updated.1', JSON.stringify({ sessionID: 'ses_fresh', info: msg3Newest }));
  insertEvent.run('e8', 'ses_fresh', 8, 'message.updated.1', JSON.stringify({ sessionID: 'ses_fresh', info: msg3Newest }));

  db.close();
}

function eventCount(dbPath: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const n = Number((db.prepare('SELECT COUNT(*) AS n FROM event').get() as { n: number }).n);
  db.close();
  return n;
}

describe('opencode db fixture', () => {
  let dir: string;
  let dbPath: string;

  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'janitor-db-'));
    dbPath = path.join(dir, 'opencode.db');
    buildFixtureDb(dbPath);
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('analyze reports superseded events, dupes, and stale sessions', async () => {
    const report = await analyzeOpencodeDb(dbPath, 30);
    assert.equal(report.schemaGate.ok, true);
    assert.equal(report.sessions.total, 2);
    // superseded: e1 (msg1 old), e3 (prt1 old), e5 (msg2 old), e7 (msg3 old — e8 is newest)
    assert.equal(report.supersededRows, 4);
    assert.equal(report.dupeRows, 1); // e7 == e8 (byte-identical > 1MB)
    assert.equal(report.staleSessions.count, 1);
    assert.ok(report.totalEventRows === 8);
  });

  test('vacuum apply: proof passes, deletes superseded + dupes, VACUUM shrinks file, integrity ok', async () => {
    const sizeBefore = statSync(dbPath).size;
    const logLines: string[] = [];
    const outcome = await vacuumOpencodeDb({
      dbPath,
      apply: true,
      backup: true,
      skipProof: false,
      log: (m) => logLines.push(m),
    });
    assert.equal(outcome.applied, true);
    assert.equal(outcome.proof.pass, true);
    assert.ok(outcome.proof.checkedMessages >= 2);
    assert.ok(outcome.proof.checkedParts >= 1);
    // dupe pair: keep one (e7 by rowid order), delete e8
    assert.equal(outcome.deletedDupeRows, 1);
    // superseded: e1, e3, e5 (e7 was already deleted by the dupe step)
    assert.equal(outcome.deletedSupersededRows, 3);
    assert.equal(eventCount(dbPath), 4); // e2, e4, e6, e7 remain
    assert.equal(outcome.integrityAfter, 'ok');
    const sizeAfter = statSync(dbPath).size;
    assert.ok(sizeAfter < sizeBefore, `VACUUM should shrink file: ${sizeBefore} -> ${sizeAfter}`);
    assert.ok(outcome.backupPath && statSync(outcome.backupPath!).size > 0, 'backup exists');

    // post state sanity: newest snapshots still match rows
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const msg1 = (db.prepare('SELECT data FROM message WHERE id = ?').get('msg1') as { data: string }).data;
    const e2 = (db.prepare('SELECT data FROM event WHERE id = ?').get('e2') as { data: string }).data;
    assert.match(e2, /"agent":"build"/);
    assert.match(msg1, /"agent":"build"/);
    db.close();
  });

  test('vacuum with session retention deletes stale session and cascades', async () => {
    const outcome = await vacuumOpencodeDb({
      dbPath,
      apply: true,
      backup: false,
      deleteSessionsOlderThanDays: 30,
      skipProof: false,
      log: () => {},
    });
    assert.equal(outcome.applied, true);
    assert.equal(outcome.deletedSessions, 1);
    assert.ok(outcome.deletedEventsForSessions >= 1, 'stale session events removed');
    assert.equal(eventCount(dbPath), 3); // e2, e4, e7 remain (e6 removed with ses_stale)
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const sessions = db.prepare('SELECT id FROM session').all() as Array<{ id: string }>;
    assert.deepEqual(sessions.map((s) => s.id), ['ses_fresh']);
    db.close();
  });

  test('reconstruction proof failure aborts with nothing changed', async () => {
    // corrupt the newest snapshot of msg1 (e2): change role so it differs from the live row
    const db = new DatabaseSync(dbPath);
    const row = db.prepare('SELECT data FROM event WHERE id = ?').get('e2') as { data: string };
    const parsed = JSON.parse(row.data) as { info: Record<string, unknown> };
    (parsed.info as { role: string }).role = 'system';
    db.prepare('UPDATE event SET data = ? WHERE id = ?').run(JSON.stringify(parsed), 'e2');
    db.close();

    const before = eventCount(dbPath);
    await assert.rejects(
      () =>
        vacuumOpencodeDb({ dbPath, apply: true, backup: true, skipProof: false, log: () => {} }),
      /reconstruction proof FAILED/,
    );
    assert.equal(eventCount(dbPath), before, 'nothing deleted when proof fails');
  });

  test('unknown schema fails closed', async () => {
    const other = path.join(dir, 'future.db');
    const db = new DatabaseSync(other);
    db.exec('CREATE TABLE event (id text PRIMARY KEY);');
    db.close();
    const report = await analyzeOpencodeDb(other, 30);
    assert.equal(report.schemaGate.ok, false);
  });
});

describe('real-machine integration (opt-in: JANITOR_REAL_DB=1)', () => {
  test('real DB analyzes read-only with passing schema gate', async (t) => {
    // Opt-in because a real DB takes minutes; CI has no opencode.db either way.
    const dbPath = process.env.JANITOR_REAL_DB ? defaultOpencodeDbPath() : undefined;
    if (!dbPath) {
      t.skip('set JANITOR_REAL_DB=1 with an opencode.db present to run');
      return;
    }
    const report = await analyzeOpencodeDb(dbPath, 30);
    assert.equal(report.schemaGate.ok, true, `gate: ${report.schemaGate.ok ? '' : (report.schemaGate as { reason: string }).reason}`);
    assert.ok(report.fileBytes > 0);
    assert.ok(report.totalEventRows > 0);
    assert.ok(report.vacuumEstimateBytes >= report.dupeBytes);
  });
});
