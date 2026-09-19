import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { probeDbLocks } from '../src/core/safety.js';
import { requireCopyFits } from '../src/core/trash.js';
import { ADAPTER_IDS } from '../src/types.js';
import { REPO_ROOT, makeTempHome, runCli } from './helpers.js';

const DAY = 86_400_000;

function makeDb(p: string): void {
  mkdirSync(path.dirname(p), { recursive: true });
  const db = new DatabaseSync(p);
  db.exec('CREATE TABLE t (x); INSERT INTO t VALUES (1)');
  db.close();
}

test('probeDbLocks refuses a sidecar holding bytes, tolerates a 0-byte crash leftover', async () => {
  const h = makeTempHome();
  try {
    const db = path.join(h.root, 'opencode.db');
    makeDb(db);
    assert.equal((await probeDbLocks(db)).ok, true, 'clean DB with no sidecars opens');

    writeFileSync(`${db}-wal`, '');
    writeFileSync(`${db}-shm`, '');
    const stale = await probeDbLocks(db);
    assert.equal(stale.ok, true, 'a 0-byte -wal/-shm pair left by a crash must not lock vacuum out forever');
    assert.equal(stale.walPresent, true, 'the sidecars are still reported as present');

    writeFileSync(`${db}-wal`, 'uncheckpointed frames');
    const live = await probeDbLocks(db);
    assert.equal(live.ok, false, 'a -wal with bytes means a writer may own the DB');
    assert.match(live.reason!, /-wal exists with \d+ bytes/);
    assert.ok(!existsSync(path.join(h.root, 'opencode.db.bak')), 'probing writes nothing');
  } finally {
    h.cleanup();
  }
});

test('trash --apply drops restored entries from the manifest', () => {
  const h = makeTempHome();
  try {
    mkdirSync(path.join(h.root, '.claude', 'transcripts'), { recursive: true });
    const victim = path.join(h.root, '.claude', 'transcripts', 'ses_old.jsonl');
    writeFileSync(victim, '{"type":"user"}\n');
    const old = new Date(Date.now() - 40 * DAY);
    utimesSync(victim, old, old);

    assert.equal(runCli(h.root, ['clean', '--target', 'claude', '--apply']).status, 0);
    const manifest = path.join(h.root, '.agent-janitor', 'trash', 'manifest.json');
    const id = (JSON.parse(readFileSync(manifest, 'utf8')) as { entries: Array<{ id: string }> }).entries[0]!.id;
    assert.equal(runCli(h.root, ['restore', id]).status, 0);
    assert.ok(existsSync(victim), 'restore put the file back');

    const out = runCli(h.root, ['trash', '--retention', '30d', '--apply', '--json']);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(JSON.parse(readFileSync(manifest, 'utf8')).entries.length, 0, 'restored entries leave the manifest');
  } finally {
    h.cleanup();
  }
});

test('cursor adapter covers the CLI tree, not just the IDE', () => {
  const h = makeTempHome();
  try {
    const old = new Date(Date.now() - 40 * DAY);
    const age = (p: string) => {
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, '{}');
      utimesSync(p, old, old);
      let d = path.dirname(p);
      while (d !== h.root && d !== path.dirname(d)) {
        utimesSync(d, old, old);
        d = path.dirname(d);
      }
    };
    age(path.join(h.root, '.cursor', 'chats', 'ws-hash-old', '1.db'));
    mkdirSync(path.join(h.root, '.cursor', 'projects', 'projA', 'agent-transcripts'), { recursive: true });
    age(path.join(h.root, '.cursor', 'projects', 'projA', 'agent-transcripts', 'sess.jsonl'));
    age(path.join(h.root, '.cursor', 'cli-auth.json'));
    mkdirSync(path.join(h.root, '.cursor', 'chats', 'ws-hash-fresh'), { recursive: true });
    writeFileSync(path.join(h.root, '.cursor', 'chats', 'ws-hash-fresh', '2.db'), '{}');

    const res = runCli(h.root, ['scan', '--json', '--target', 'cursor', '--retention', '30d']);
    assert.equal(res.status, 0, res.stderr);
    const f = (JSON.parse(res.stdout) as { adapters: Array<{ adapter: string; findings: Array<{ path: string; category: string }> }> })
      .adapters.find((a) => a.adapter === 'cursor')!;
    const trash = f.findings.filter((x) => x.category === 'trash').map((x) => x.path);
    assert.ok(trash.some((p) => p.endsWith('ws-hash-old')), 'old cursor CLI chat dir flagged');
    assert.ok(trash.some((p) => p.includes('agent-transcripts')), 'old agent transcripts flagged');
    assert.ok(!trash.some((p) => p.endsWith('ws-hash-fresh')), 'fresh chat dir kept');
    assert.ok(f.findings.some((x) => x.path.endsWith('cli-auth.json') && x.category === 'report-only'), 'CLI auth token precious');
  } finally {
    h.cleanup();
  }
});

test('continue: old session JSONs and logs flagged, index and config kept', () => {
  const h = makeTempHome();
  try {
    const old = new Date(Date.now() - 40 * DAY);
    for (const [rel, aged] of [
      [path.join('.continue', 'sessions', 'sess-old.json'), true],
      [path.join('.continue', 'sessions', 'sessions.json'), true],
      [path.join('.continue', 'logs', 'a.log'), true],
      [path.join('.continue', 'config.yaml'), true],
      [path.join('.continue', 'sessions', 'sess-new.json'), false],
    ] as Array<[string, boolean]>) {
      const p = path.join(h.root, rel);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, 'x');
      if (aged) utimesSync(p, old, old);
    }
    const res = runCli(h.root, ['scan', '--json', '--target', 'continue', '--retention', '30d']);
    assert.equal(res.status, 0, res.stderr);
    const f = (JSON.parse(res.stdout) as { adapters: Array<{ adapter: string; findings: Array<{ path: string; category: string }> }> })
      .adapters.find((a) => a.adapter === 'continue')!;
    const trash = f.findings.filter((x) => x.category === 'trash').map((x) => x.path);
    assert.ok(trash.some((p) => p.endsWith('sess-old.json')), 'old session flagged');
    assert.ok(!trash.some((p) => p.endsWith('sess-new.json')), 'fresh session kept');
    assert.ok(!trash.some((p) => p.endsWith('sessions.json')), 'session index never queued');
    assert.ok(f.findings.some((x) => x.path.endsWith('config.yaml') && x.category === 'report-only'), 'config precious');
  } finally {
    h.cleanup();
  }
});

test('a cross-volume trash copy refuses when the trash volume cannot hold the bytes', async () => {
  const h = makeTempHome();
  try {
    // statfs needs a real directory, so the check runs against the temp home's own volume
    await assert.rejects(
      () => requireCopyFits(path.join(h.root, 'y'), Number.MAX_SAFE_INTEGER ** 2),
      /must be copied there/,
    );
    await requireCopyFits(path.join(h.root, 'y'), 1);
  } finally {
    h.cleanup();
  }
});

test('doctor reports every adapter root and says which ones exist', () => {
  const h = makeTempHome();
  try {
    mkdirSync(path.join(h.root, '.codex'), { recursive: true });
    const res = runCli(h.root, ['doctor', '--json']);
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout) as {
      platform: string;
      rows: Array<{ adapter: string; root: string; kind: string; entries: number | undefined }>;
    };
    assert.equal(out.platform, process.platform);
    assert.equal(out.rows.length, ADAPTER_IDS.length, 'one row per adapter, no fourth list');
    const codex = out.rows.find((r) => r.adapter === 'codex')!;
    assert.equal(codex.kind, 'dir');
    assert.equal(codex.entries, 0);
    assert.ok(out.rows.every((r) => r.root.startsWith(h.root)), 'doctor honours the fake home');
    assert.equal(out.rows.filter((r) => r.kind === 'absent').length, ADAPTER_IDS.length - 1);
  } finally {
    h.cleanup();
  }
});

test('every shipped adapter is named in the path-evidence corpus', () => {
  const doc = readFileSync(path.join(REPO_ROOT, 'docs', 'agent-sources.md'), 'utf8');
  const hay = doc.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
  const missing = ADAPTER_IDS.filter((id) => !hay.includes(id.toLowerCase()));
  assert.deepEqual(missing, [], 'CONTRIBUTING.md: a path must be cited in docs/agent-sources.md before it ships');
});
