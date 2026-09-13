import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { makeTempHome, runCli, seedFakeHarnessFiles, type TempHome } from './helpers.js';

let home: TempHome;

before(() => {
  home = makeTempHome();
  seedFakeHarnessFiles(home.root);
});

after(() => {
  home.cleanup();
});

const oldTranscript = () => path.join(home.root, '.claude', 'transcripts', 'ses_old.jsonl');
const newTranscript = () => path.join(home.root, '.claude', 'transcripts', 'ses_new.jsonl');
const oldRollout = () => path.join(home.root, '.codex', 'sessions', '2026', '08', '17', 'rollout-old.jsonl');
const freshRollout = () => path.join(home.root, '.codex', 'sessions', '2026', '09', '12', 'rollout-fresh.jsonl');
const tmpJunk = () => path.join(home.root, '.codex', '..codex-global-state.json.tmp-123');
const staleBackup = () => path.join(home.root, '.config', 'opencode', 'opencode.jsonc.backup-2026-06-16T15-55-05-577Z');

test('scan --json reports adapters and findings against a fake home', () => {
  const res = runCli(home.root, ['scan', '--json', '--retention', '30d']);
  assert.equal(res.status, 0, `scan failed: ${res.stderr}`);
  const parsed = JSON.parse(res.stdout) as {
    adapters: Array<{ adapter: string; present: boolean; findings: Array<{ kind: string; path: string }> }>;
  };
  const byAdapter = new Map(parsed.adapters.map((a) => [a.adapter, a]));
  const claude = byAdapter.get('claude')!;
  assert.ok(claude.present);
  assert.ok(claude.findings.some((f) => f.kind === 'session-file' && f.path === oldTranscript()), 'old transcript found');
  assert.ok(!claude.findings.some((f) => f.path === newTranscript()), 'fresh transcript not flagged');
  const codex = byAdapter.get('codex')!;
  assert.ok(codex.findings.some((f) => f.kind === 'session-file' && f.path === oldRollout()));
  assert.ok(codex.findings.some((f) => f.kind === 'tmp-junk' && f.path === tmpJunk()), 'tmp junk flagged regardless of age');
});

test('clean dry-run lists old items but moves nothing', () => {
  const res = runCli(home.root, ['clean', '--retention', '30d']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /DRY RUN/);
  assert.match(res.stdout, /ses_old/);
  assert.match(res.stdout, /rollout-old/);
  assert.match(res.stdout, /tmp-123/); // tmp junk always eligible
  assert.doesNotMatch(res.stdout, /ses_new/);
  assert.doesNotMatch(res.stdout, /rollout-fresh/);
  assert.ok(existsSync(oldTranscript()), 'dry run moved nothing');
  assert.ok(existsSync(staleBackup()), 'dry run moved nothing');
});

test('clean --apply moves trash-eligible files to trash with manifest', () => {
  const res = runCli(home.root, ['clean', '--retention', '30d', '--apply']);
  assert.equal(res.status, 0, res.stderr);
  assert.ok(!existsSync(oldTranscript()), 'old transcript moved to trash');
  assert.ok(!existsSync(oldRollout()), 'old rollout moved to trash');
  assert.ok(!existsSync(tmpJunk()), 'tmp junk moved to trash');
  assert.ok(existsSync(newTranscript()), 'fresh transcript untouched');
  assert.ok(existsSync(freshRollout()), 'fresh rollout untouched');
  // stale backup: 40d old → eligible
  assert.ok(!existsSync(staleBackup()), 'stale config backup moved to trash');

  const manifest = JSON.parse(readFileSync(path.join(home.root, '.agent-janitor', 'trash', 'manifest.json'), 'utf8')) as {
    entries: Array<{ id: string; originalPath: string; restoredAt?: string }>;
  };
  const movedPaths = manifest.entries.filter((e) => !e.restoredAt).map((e) => e.originalPath);
  assert.ok(movedPaths.includes(oldTranscript()));
  assert.ok(movedPaths.includes(oldRollout()));
  assert.ok(movedPaths.includes(tmpJunk()));
  assert.ok(movedPaths.includes(staleBackup()));
});

test('restore puts a trashed item back at its original path', () => {
  const res = runCli(home.root, ['restore', '--list']);
  assert.equal(res.status, 0, res.stderr);
  const match = /(\S+#[^\s]+).*ses_old\.jsonl/.exec(res.stdout);
  assert.ok(match, `list output should contain ses_old entry: ${res.stdout}`);
  const restore = runCli(home.root, ['restore', match![1]!]);
  assert.equal(restore.status, 0, restore.stderr);
  assert.ok(existsSync(oldTranscript()), 'file restored to original location');
  const content = readFileSync(oldTranscript(), 'utf8');
  assert.match(content, /"type":"user"/);
});

test('restore --list no longer shows the restored entry as active', () => {
  const res = runCli(home.root, ['restore', '--list']);
  assert.doesNotMatch(res.stdout, /ses_old\.jsonl/);
  assert.match(res.stdout, /ses_02|rollout-old|tmp-123|opencode\.jsonc\.backup/);
});
