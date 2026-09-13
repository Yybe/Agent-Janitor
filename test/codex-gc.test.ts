import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isGitRepo, planCodexGc, applyCodexGc } from '../src/adapters/codex/checkpoints.js';

const DAY = 86_400_000;

function git(repo: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t.local',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t.local',
      ...env,
    },
  });
}

describe('codex turn-diff checkpoint GC', () => {
  let repo: string;

  before(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'janitor-codexgc-'));
    git(repo, ['init', '-b', 'main']);
    const old = new Date(Date.now() - 40 * DAY).toISOString();
    writeFileSync(path.join(repo, 'a.txt'), 'a');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'old'], { GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old });
    const oldSha = git(repo, ['rev-parse', 'HEAD']).trim();
    writeFileSync(path.join(repo, 'b.txt'), 'b');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'new']);
    const newSha = git(repo, ['rev-parse', 'HEAD']).trim();
    // mimic codex: refs under refs/codex/turn-diffs/checkpoints/
    git(repo, ['update-ref', 'refs/codex/turn-diffs/checkpoints/old-session', oldSha]);
    git(repo, ['update-ref', 'refs/codex/turn-diffs/checkpoints/new-session', newSha]);
  });

  after(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test('isGitRepo detects repos', async () => {
    assert.equal(await isGitRepo(repo), true);
    assert.equal(await isGitRepo(mkdtempSync(path.join(tmpdir(), 'janitor-nogit-'))), false);
  });

  test('plan finds old checkpoint refs only', async () => {
    const plan = await planCodexGc(repo, 30);
    assert.equal(plan.totalRefs, 2);
    assert.equal(plan.oldRefs.length, 1);
    assert.match(plan.oldRefs[0]!.refname, /old-session$/);
  });

  test('apply deletes old refs and runs gc, keeps fresh refs', async () => {
    const outcome = await applyCodexGc(await planCodexGc(repo, 30), () => {});
    assert.equal(outcome.applied, true);
    assert.equal(outcome.deletedRefs, 1);
    const remaining = git(repo, ['for-each-ref', '--format=%(refname)', 'refs/codex/turn-diffs/']).trim();
    assert.ok(remaining.includes('new-session'));
    assert.ok(!remaining.includes('old-session'));
    // user refs untouched
    assert.match(git(repo, ['rev-parse', 'HEAD']).trim(), /^[0-9a-f]{40}$/);
  });
});
