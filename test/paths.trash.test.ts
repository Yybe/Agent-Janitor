import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { appData, localData } from '../src/util.js';
import { makeTempHome, runCli, seedFakeHarnessFiles } from './helpers.js';

const DAY = 86_400_000;
const KEYS = ['JANITOR_APPDATA', 'JANITOR_LOCALDATA', 'JANITOR_HOME', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME'];

/** Run `fn` with process.platform forced and the path env vars pinned to `env`. */
function withEnv<T>(plat: NodeJS.Platform, env: Record<string, string>, fn: () => T): T {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  const desc = Object.getOwnPropertyDescriptor(process, 'platform')!;
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  Object.defineProperty(process, 'platform', { value: plat, configurable: true });
  try {
    return fn();
  } finally {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
    Object.defineProperty(process, 'platform', desc);
  }
}

test('appData resolves the real per-OS Electron data root', () => {
  // macOS: Electron apps live in ~/Library/Application Support, NOT ~/.config.
  // The win32 branch needs real path.win32 separators, so CI's windows job covers it.
  withEnv('darwin', { JANITOR_HOME: '/h' }, () =>
    assert.equal(appData('Cursor'), path.join('/h', 'Library', 'Application Support', 'Cursor')),
  );
  withEnv('linux', { JANITOR_HOME: '/h' }, () => assert.equal(appData('Cursor'), path.join('/h', '.config', 'Cursor')));
});

test('localData resolves the per-OS updater/cache root', () => {
  withEnv('darwin', { JANITOR_HOME: '/h' }, () =>
    assert.equal(localData('cursor-updater'), path.join('/h', 'Library', 'Caches', 'cursor-updater')),
  );
  withEnv('linux', { JANITOR_HOME: '/h' }, () => assert.equal(localData('cursor-updater'), path.join('/h', '.cache', 'cursor-updater')));
});

test('scan names the root it probed when a harness turns up empty', () => {
  const h = makeTempHome();
  try {
    const out = runCli(h.root, ['scan', '--target', 'cursor']);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /cursor \(no data at ~.*Cursor\)/);
  } finally {
    h.cleanup();
  }
});

test('trash lists expired items and --apply deletes them for good', () => {
  const h = makeTempHome();
  try {
    seedFakeHarnessFiles(h.root);
    assert.equal(runCli(h.root, ['clean', '--target', 'claude', '--apply']).status, 0);

    const manifestPath = path.join(h.root, '.agent-janitor', 'trash', 'manifest.json');
    const read = () => JSON.parse(readFileSync(manifestPath, 'utf8')) as { entries: Array<{ movedAt: string; trashPath: string; bytes: number }> };
    const age = (days: number) => {
      const m = read();
      for (const e of m.entries) e.movedAt = new Date(Date.now() - days * DAY).toISOString();
      writeFileSync(manifestPath, JSON.stringify(m), 'utf8');
    };
    const before = read().entries;
    assert.ok(before.length > 0, 'clean --apply should have trashed something');
    age(40);

    const dry = runCli(h.root, ['trash', '--retention', '30d']);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /EXPIRED/);
    assert.match(dry.stdout, /DRY RUN/);
    for (const e of before) assert.ok(existsSync(e.trashPath), 'dry run must not delete');

    const notYet = runCli(h.root, ['trash', '--retention', '60d', '--json']);
    assert.equal(JSON.parse(notYet.stdout).expiredCount, 0, '40d-old items are not expired at a 60d window');

    const applied = runCli(h.root, ['trash', '--retention', '30d', '--apply', '--json']);
    assert.equal(applied.status, 0, applied.stderr);
    const out = JSON.parse(applied.stdout);
    assert.equal(out.dryRun, false);
    assert.equal(out.deletedBytes, before.reduce((s, e) => s + e.bytes, 0));
    assert.equal(out.activeCount, 0);
    assert.equal(read().entries.length, 0, 'pruned entries leave the manifest');
  } finally {
    h.cleanup();
  }
});
