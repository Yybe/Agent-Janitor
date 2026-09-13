import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Codex turn-diff checkpoint GC.
 *
 * Codex CLI/Desktop writes per-turn project-tree snapshots as git refs
 * `refs/codex/turn-diffs/checkpoints/...` inside the USER'S REPO .git, pointing
 * at tree objects (full file contents per turn, .gitignore ignored). Codex never
 * garbage-collects them — upstream issue openai/codex#29388 documents 100+ GB
 * orphans. Deleting the refs then `git gc --prune=now` reclaims the objects;
 * the cost is losing per-turn rewind for affected old sessions.
 *
 * We only ever touch refs under refs/codex/turn-diffs — never user refs.
 */

export interface CheckpointRef {
  refname: string;
  creatorDateSec: number;
  oid: string;
}

export interface CodexGcPlan {
  repo: string;
  totalRefs: number;
  oldRefs: CheckpointRef[];
  newestDateSec: number;
  oldestDateSec: number;
  gcRequired: boolean;
}

const REF_PREFIX = 'refs/codex/turn-diffs/';

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', repo, ...args], { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

export async function isGitRepo(repo: string): Promise<boolean> {
  try {
    const out = await git(repo, ['rev-parse', '--is-inside-work-tree']);
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

export async function planCodexGc(repo: string, retentionDays: number): Promise<CodexGcPlan> {
  const out = await git(
    repo,
    ['for-each-ref', '--format=%(refname)%00%(creatordate:unix)%00%(objectname)', REF_PREFIX],
  );
  const refs: CheckpointRef[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [refname, dateSec, oid] = line.split('\0');
    if (!refname?.startsWith(REF_PREFIX)) continue; // defensive: never treat anything else
    refs.push({ refname, creatorDateSec: Number(dateSec ?? 0) * 1000, oid: oid ?? '' });
  }
  const cutoff = Date.now() - retentionDays * 86_400_000;
  const dates = refs.map((r) => r.creatorDateSec).filter((d) => d > 0);
  return {
    repo,
    totalRefs: refs.length,
    oldRefs: refs.filter((r) => r.creatorDateSec > 0 && r.creatorDateSec < cutoff),
    newestDateSec: dates.length ? Math.max(...dates) : 0,
    oldestDateSec: dates.length ? Math.min(...dates) : 0,
    gcRequired: true,
  };
}

export interface CodexGcOutcome {
  applied: boolean;
  deletedRefs: number;
  gcOutput?: string;
}

export async function applyCodexGc(plan: CodexGcPlan, log: (msg: string) => void): Promise<CodexGcOutcome> {
  for (const ref of plan.oldRefs) {
    log(`deleting ref ${ref.refname}`);
    await git(plan.repo, ['update-ref', '-d', ref.refname]);
  }
  log('git gc --prune=now: reclaiming orphaned checkpoint objects ...');
  const gcOutput = await git(plan.repo, ['gc', '--prune=now', '--quiet']);
  return { applied: true, deletedRefs: plan.oldRefs.length, gcOutput };
}
