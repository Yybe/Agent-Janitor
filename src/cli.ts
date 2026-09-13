#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { scanAll } from './core/scan.js';
import { renderScan, renderCleanPlan, renderVacuumDryRun } from './report.js';
import { moveToTrash, restoreFromTrash, listTrash, type TrashEntry } from './core/trash.js';
import { isOldEnough } from './adapters/files.js';
import { defaultOpencodeDbPath, vacuumOpencodeDb } from './adapters/opencode/db.js';
import { isGitRepo, planCodexGc, applyCodexGc } from './adapters/codex/checkpoints.js';
import { formatBytes, parseRetention } from './util.js';
import type { AdapterId, Finding } from './types.js';

const DAY = 86_400_000;

function fail(msg: string): never {
  console.error(`agent-janitor: ${msg}`);
  process.exit(1);
}

const HELP = `agent-janitor — reclaim disk space from AI coding agent harnesses (opencode, codex, claude, gemini)

usage:
  agent-janitor scan [--target <adapter>] [--retention <30d>] [--json]
  agent-janitor clean [--target <adapter>] [--retention <30d>] [--apply] [--json]
  agent-janitor restore --list | <id>
  agent-janitor vacuum [--db <path>] [--retention <30d>] [--delete-sessions-older-than <90d>]
                       [--apply] [--no-backup] [--skip-proof]
  agent-janitor codex-gc [--repo <path>] [--retention <30d>] [--apply]
  agent-janitor help

commands:
  scan     read-only audit of every harness's storage. always safe.
  clean    move trash-eligible files to ~/.agent-janitor/trash (dry-run by default).
           never touches databases — use vacuum for that.
  restore  put a trashed item back where it was (id from 'restore --list').
  vacuum   opencode DB surgery: delete superseded snapshot events + byte-identical
           duplicates, then VACUUM. gated by a reconstruction proof. dry-run default.
           --delete-sessions-older-than N additionally deletes whole old sessions (opt-in).
  codex-gc garbage-collect Codex turn-diff checkpoint refs (refs/codex/turn-diffs/*)
           in a git repo — Codex never prunes these and they grow to 100+ GB
           (openai/codex#29388). Deleting old refs + git gc --prune=now reclaims
           the objects but forfeits per-turn rewind for affected old sessions.

flags:
  --retention <n><d|w|m>   age cutoff for trash-eligible items (default 30d)
  --apply                  actually perform the operation (default: dry run)
  --no-backup              vacuum: skip the safety copy (dangerous)
  --skip-proof             vacuum: skip the losslessness proof (dangerous)
  --json                   machine-readable output

safety: every removal goes to a trash dir with a manifest and is restorable.
databases are refused when in use (WAL/SHM present); integrity is checked before
and after surgery; a timestamped backup is taken unless you pass --no-backup.
`;

interface CliArgs {
  command: string;
  values: Record<string, string | string[] | boolean | undefined>;
  positionals: string[];
}

function parse(): CliArgs {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? 'help';
  let parsed;
  try {
    parsed = parseArgs({
      args: argv.slice(1),
      options: {
        target: { type: 'string' },
        retention: { type: 'string', default: '30d' },
        apply: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        db: { type: 'string' },
        'no-backup': { type: 'boolean', default: false },
        'skip-proof': { type: 'boolean', default: false },
        'delete-sessions-older-than': { type: 'string' },
        repo: { type: 'string' },
        list: { type: 'boolean', short: 'l', default: false },
      },
      allowPositionals: true,
    });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  return {
    command,
    values: parsed!.values as CliArgs['values'],
    positionals: parsed!.positionals,
  };
}

function adapterFromTarget(target: string | undefined): AdapterId | undefined {
  if (target === undefined) return undefined;
  const valid: AdapterId[] = ['opencode', 'codex', 'claude', 'gemini'];
  if (!valid.includes(target as AdapterId)) fail(`--target must be one of: ${valid.join(', ')}`);
  return target as AdapterId;
}

async function cmdScan(args: CliArgs): Promise<void> {
  const retentionDays = parseRetention(String(args.values.retention ?? '30d'));
  const result = await scanAll({ retentionDays, target: adapterFromTarget(args.values.target as string | undefined) });
  if (args.values.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(renderScan(result));
  }
}

async function cmdClean(args: CliArgs): Promise<void> {
  const retentionDays = parseRetention(String(args.values.retention ?? '30d'));
  const target = adapterFromTarget(args.values.target as string | undefined);
  const apply = args.values.apply === true;
  const result = await scanAll({ retentionDays, target });
  const cutoff = Date.now() - retentionDays * DAY;
  const findings: Finding[] = result.adapters
    .flatMap((a) => a.findings)
    .filter((f) => f.category === 'trash' && isOldEnough(f, cutoff));
  if (findings.length === 0) {
    console.log(`nothing to clean for the current filters (retention ${retentionDays}d).`);
    return;
  }
  if (!apply) {
    console.log(renderCleanPlan(findings, false));
    console.log('\ndry run — pass --apply to move these to trash.');
    return;
  }
  let moved = 0;
  let bytes = 0;
  for (const f of findings) {
    try {
      const entry = await moveToTrash({
        targetPath: f.path,
        bytes: f.bytes,
        mtimeMs: f.mtimeMs,
        adapter: f.adapter,
        kind: f.kind,
        description: f.description,
      });
      console.log(`  trashed ${formatBytes(f.bytes).padStart(9)}  ${f.path}  [${entry.id}]`);
      moved++;
      bytes += f.bytes;
    } catch (err) {
      console.error(`  FAILED ${f.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`\nmoved ${moved} item(s), ${formatBytes(bytes)} to trash. list trash: agent-janitor restore --list`);
}

async function cmdRestore(args: CliArgs): Promise<void> {
  const list = args.values.list === true;
  if (list || args.positionals.length === 0) {
    const active = (await listTrash()).filter((e) => !e.restoredAt);
    if (active.length === 0) {
      console.log('trash is empty.');
      return;
    }
    let total = 0;
    for (const e of active) total += e.bytes;
    for (const e of active) {
      console.log(`  ${e.id}  ${formatBytes(e.bytes).padStart(9)}  ${e.adapter.padEnd(9)} ${e.originalPath}`);
    }
    console.log(`\n${active.length} item(s), ${formatBytes(total)} in trash. restore: agent-janitor restore <id>`);
    return;
  }
  const entry: TrashEntry = await restoreFromTrash(args.positionals[0]!);
  console.log(`restored ${entry.originalPath}`);
}

async function cmdVacuum(args: CliArgs): Promise<void> {
  const dbPath = (args.values.db as string | undefined) ?? defaultOpencodeDbPath();
  if (!dbPath) fail('no opencode.db found (pass --db <path>)');
  const apply = args.values.apply === true;
  const backup = args.values['no-backup'] !== true;
  const skipProof = args.values['skip-proof'] === true;
  const retentionDays = parseRetention(String(args.values.retention ?? '30d'));
  const delSessionsRaw = args.values['delete-sessions-older-than'] as string | undefined;
  const deleteSessionsOlderThanDays = delSessionsRaw !== undefined ? parseRetention(delSessionsRaw) : undefined;
  const log = (msg: string): void => console.log(`  ${msg}`);
  try {
    const outcome = await vacuumOpencodeDb({ dbPath, apply, backup, deleteSessionsOlderThanDays, skipProof, log });
    if (!apply) {
      console.log(
        renderVacuumDryRun(
          {
            path: dbPath,
            fileBytes: outcome.plan.fileBytes,
            freelistPages: outcome.plan.freelistPages,
            freelistBytes: outcome.plan.freelistBytes,
            supersededRows: outcome.plan.supersededRows,
            supersededBytes: outcome.plan.supersededBytes,
            dupeRows: outcome.plan.dupeRows,
            dupeBytes: outcome.plan.dupeBytes,
            staleSessions: outcome.plan.staleSessions,
            staleSessionBytes: outcome.plan.staleSessionBytes,
            sessionsTotal: outcome.plan.sessionsTotal,
          },
          proofSummary(outcome.proof),
          deleteSessionsOlderThanDays,
        ),
      );
      return;
    }
    const after = outcome.bytesAfter ?? outcome.bytesBefore;
    const freed = outcome.bytesBefore - after;
    console.log('');
    console.log(
      `applied: ${outcome.deletedDupeRows} duplicate rows + ${outcome.deletedSupersededRows} superseded rows deleted, ${outcome.deletedSessions} sessions removed`,
    );
    console.log(`size: ${formatBytes(outcome.bytesBefore)} -> ${formatBytes(after)} (freed ${formatBytes(freed)})`);
    console.log(`integrity: ${outcome.integrityBefore} -> ${outcome.integrityAfter}`);
    console.log(`backup: ${outcome.backupPath ?? 'NONE (--no-backup)'}`);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

function proofSummary(proof: {
  pass: boolean;
  checkedMessages: number;
  checkedParts: number;
  driftMessages: number;
  driftParts: number;
  mismatches: string[];
}): string {
  if (proof.mismatches.length > 0) return `FAILED (${proof.mismatches[0]})`;
  if (proof.checkedMessages === 0 && proof.checkedParts === 0 && proof.driftMessages === 0 && proof.driftParts === 0) {
    return 'skipped (--skip-proof)';
  }
  const drift = proof.driftMessages + proof.driftParts;
  return (
    `PASS — ${proof.checkedMessages} messages + ${proof.checkedParts} parts verified identical to newest snapshots` +
    (drift > 0 ? ` (${drift} row-side drift tolerated, no delta chains)` : '')
  );
}

async function cmdCodexGc(args: CliArgs): Promise<void> {
  const repo = (args.values.repo as string | undefined) ?? process.cwd();
  if (!(await isGitRepo(repo))) fail(`not a git repository: ${repo}`);
  const apply = args.values.apply === true;
  const retentionDays = parseRetention(String(args.values.retention ?? '30d'));
  const plan = await planCodexGc(repo, retentionDays);
  const fmt = (sec: number): string => (sec ? new Date(sec).toISOString().slice(0, 10) : '?');
  console.log(`codex-gc — repo: ${repo}`);
  console.log(`  checkpoint refs under refs/codex/turn-diffs/: ${plan.totalRefs}`);
  if (plan.totalRefs === 0) {
    console.log('  nothing to collect.');
    return;
  }
  console.log(`  refs span ${fmt(plan.oldestDateSec)} .. ${fmt(plan.newestDateSec)}`);
  console.log(
    `  older than ${retentionDays}d: ${plan.oldRefs.length} refs — deleting them + 'git gc --prune=now' reclaims their tree objects`,
  );
  console.log(`  WARNING: rewind/diff for affected old codex sessions is forfeited.`);
  if (!apply) {
    console.log('\ndry run — pass --apply to delete the old refs and run git gc.');
    return;
  }
  await applyCodexGc(plan, (m) => console.log(`  ${m}`));
  console.log(`\ndeleted ${plan.oldRefs.length} refs; git gc complete.`);
}

async function main(): Promise<void> {
  const args = parse();
  switch (args.command) {
    case 'scan':
      return cmdScan(args);
    case 'clean':
      return cmdClean(args);
    case 'restore':
      return cmdRestore(args);
    case 'vacuum':
      return cmdVacuum(args);
    case 'codex-gc':
      return cmdCodexGc(args);
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return;
    default:
      console.log(HELP);
      fail(`unknown command "${args.command}"`);
  }
}

main().catch((err) => fail(err instanceof Error ? (err.stack ?? err.message) : String(err)));
