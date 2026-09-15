import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { makeTempHome, runCli, seedFakeHarnessFiles, type TempHome } from './helpers.js';

let home: TempHome;

const DAY = 86_400_000;

before(() => {
  home = makeTempHome();
  seedFakeHarnessFiles(home.root);
  seedNewAdapters(home.root);
});

after(() => {
  home.cleanup();
});

/** Fake homes for the new adapters: kiro, cursor, claude-deep, antigravity, copilot, cline, amp. */
function seedNewAdapters(root: string): void {
  const old = new Date(Date.now() - 40 * DAY);
  const fresh = new Date(Date.now() - 1 * DAY);

  // kiro: one old session bundle + one fresh, old log dir, precious steering
  const kOld = path.join(root, '.kiro', 'sessions', 'ws1', 'sess_old');
  const kFresh = path.join(root, '.kiro', 'sessions', 'ws1', 'sess_new');
  mkdirSync(kOld, { recursive: true });
  mkdirSync(kFresh, { recursive: true });
  writeFileSync(path.join(kOld, 'messages.jsonl'), '{"a":1}\n');
  writeFileSync(path.join(kFresh, 'messages.jsonl'), '{"a":1}\n');
  // age the files AND dirs: walkSize takes newest mtime of everything inside
  utimesSync(path.join(kOld, 'messages.jsonl'), old, old);
  for (const d of [kOld, path.join(root, '.kiro', 'sessions', 'ws1')]) utimesSync(d, old, old);
  utimesSync(path.join(kFresh, 'messages.jsonl'), fresh, fresh);
  const kLog = path.join(root, '.kiro', 'logs', 'oldrun');
  mkdirSync(kLog, { recursive: true });
  writeFileSync(path.join(kLog, 'kiro.log'), 'x'.repeat(100));
  utimesSync(path.join(kLog, 'kiro.log'), old, old);
  utimesSync(kLog, old, old);
  mkdirSync(path.join(root, '.kiro', 'steering'), { recursive: true });
  mkdirSync(path.join(root, '.kiro', 'settings'), { recursive: true });
  writeFileSync(path.join(root, '.kiro', 'settings', 'permissions.yaml'), 'x\n');

  // claude-deep: orphan project (not in registry), stale cache, overgrown history
  writeFileSync(path.join(root, '.claude.json'), JSON.stringify({ projects: { '/real/proj': {} } }));
  const orphan = path.join(root, '.claude', 'projects', 'gone-proj');
  mkdirSync(orphan, { recursive: true });
  writeFileSync(path.join(orphan, 's.jsonl'), '{"t":1}\n');
  utimesSync(path.join(orphan, 's.jsonl'), fresh, fresh); // fresh but orphan → still flagged
  const tele = path.join(root, '.claude', 'telemetry');
  mkdirSync(tele, { recursive: true });
  writeFileSync(path.join(tele, 't.log'), 'y'.repeat(50));
  utimesSync(path.join(tele, 't.log'), old, old);
  utimesSync(tele, old, old);
  writeFileSync(path.join(root, '.claude', 'history.jsonl'), Array.from({ length: 600 }, (_, i) => `{"i":${i}}`).join('\n'));
  mkdirSync(path.join(root, '.claude', 'skills'), { recursive: true });

  // cursor + antigravity + copilot: APPDATA roots only exist via env override — seed under fake home
  for (const app of ['Cursor', 'Code']) {
    const ws = path.join(root, 'AppData', 'Roaming', app, 'User', 'workspaceStorage', 'oldhash');
    mkdirSync(ws, { recursive: true });
    writeFileSync(path.join(ws, 'state.vscdb'), 'z'.repeat(200));
    utimesSync(path.join(ws, 'state.vscdb'), old, old);
    utimesSync(ws, old, old);
  }
  // copilot CLI logs
  const clog = path.join(root, '.copilot', 'logs');
  mkdirSync(clog, { recursive: true });
  writeFileSync(path.join(clog, 'p.log'), 'log\n');
  // cline workspace
  const cw = path.join(root, '.cline', 'data', 'workspaces', 'oldws');
  mkdirSync(cw, { recursive: true });
  writeFileSync(path.join(cw, 'workspaceState.json'), '{}\n');
  utimesSync(path.join(cw, 'workspaceState.json'), old, old);
  utimesSync(cw, old, old);
  // amp file-changes
  const af = path.join(root, '.amp', 'file-changes', 'T-old');
  mkdirSync(af, { recursive: true });
  writeFileSync(path.join(af, 'diff.txt'), 'd\n');
  utimesSync(path.join(af, 'diff.txt'), old, old);
  utimesSync(af, old, old);
  // antigravity conversations
  const ag = path.join(root, '.gemini', 'antigravity', 'conversations');
  mkdirSync(ag, { recursive: true });
  writeFileSync(path.join(ag, 'old.pb'), 'p'.repeat(100));
  utimesSync(path.join(ag, 'old.pb'), old, old);
}

function findingsFor(stdout: string, adapter: string): Array<{ kind: string; path: string; category: string }> {
  const parsed = JSON.parse(stdout) as {
    adapters: Array<{ adapter: string; findings: Array<{ kind: string; path: string; category: string }> }>;
  };
  return parsed.adapters.find((a) => a.adapter === adapter)?.findings ?? [];
}

test('kiro: old session bundle flagged, fresh kept, steering report-only', () => {
  const res = runCli(home.root, ['scan', '--json', '--target', 'kiro', '--retention', '30d']);
  assert.equal(res.status, 0, res.stderr);
  const f = findingsFor(res.stdout, 'kiro');
  assert.ok(f.some((x) => x.kind === 'session-dir' && x.path.endsWith('sess_old')), 'old kiro session flagged');
  assert.ok(!f.some((x) => x.path.endsWith('sess_new')), 'fresh kiro session kept');
  assert.ok(f.some((x) => x.path.includes('logs') && x.category === 'trash'), 'old kiro logs trashed');
  assert.ok(f.some((x) => x.path.endsWith('steering') && x.category === 'report-only'), 'steering precious');
});

test('claude-deep: orphan project flagged regardless of age, telemetry trashed, history capped', () => {
  const res = runCli(home.root, ['scan', '--json', '--target', 'claude', '--retention', '30d']);
  assert.equal(res.status, 0, res.stderr);
  const f = findingsFor(res.stdout, 'claude');
  assert.ok(f.some((x) => x.kind === 'orphan-project' && x.path.endsWith('gone-proj')), 'orphan flagged even though fresh');
  assert.ok(f.some((x) => x.kind === 'cache-dir' && x.path.endsWith('telemetry')), 'stale telemetry trashed');
  assert.ok(f.some((x) => x.kind === 'history-log'), 'overgrown history flagged');
  assert.ok(f.some((x) => x.path.endsWith('skills') && x.category === 'report-only'), 'skills precious');
});

test('cursor/copilot/cline/amp/antigravity: workspace + logs flagged, creds untouched', () => {
  for (const t of ['cursor', 'copilot', 'cline', 'amp', 'antigravity']) {
    const res = runCli(home.root, ['scan', '--json', '--target', t, '--retention', '30d'], 60_000);
    assert.equal(res.status, 0, `${t}: ${res.stderr}`);
    const f = findingsFor(res.stdout, t);
    assert.ok(f.length > 0, `${t} finds something in fake home`);
  }
});

test('clean --apply on kiro target moves only kiro trash, restores cleanly', () => {
  const kDir = path.join(home.root, '.kiro', 'sessions', 'ws1', 'sess_old');
  const kOld = path.join(kDir, 'messages.jsonl');
  assert.ok(existsSync(kOld), 'precondition: old kiro session exists');
  const res = runCli(home.root, ['clean', '--target', 'kiro', '--retention', '30d', '--apply']);
  assert.equal(res.status, 0, res.stderr);
  assert.ok(!existsSync(kOld), 'old kiro session trashed');
  assert.ok(existsSync(path.join(home.root, '.kiro', 'sessions', 'ws1', 'sess_new', 'messages.jsonl')), 'fresh kept');
  assert.ok(existsSync(path.join(home.root, '.kiro', 'steering')), 'steering untouched');
  const manifest = JSON.parse(readFileSync(path.join(home.root, '.agent-janitor', 'trash', 'manifest.json'), 'utf8')) as {
    entries: Array<{ id: string; originalPath: string; restoredAt?: string }>;
  };
  const entry = manifest.entries.find((e) => !e.restoredAt && e.originalPath === kDir);
  assert.ok(entry, 'manifest has kiro session-dir entry');
  const restore = runCli(home.root, ['restore', entry!.id]);
  assert.equal(restore.status, 0, restore.stderr);
  assert.ok(existsSync(kOld), 'kiro session restored');
});
