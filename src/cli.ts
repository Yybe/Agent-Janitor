#!/usr/bin/env node
import './core/quiet.js';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { scanAll, ADAPTER_IDS } from './core/scan.js';
import { renderScan, renderCleanPlan, renderVacuumDryRun } from './report.js';
import { moveToTrash, restoreFromTrash, listTrash, pruneTrash, trashRoot, type TrashEntry } from './core/trash.js';
import { isOldEnough } from './adapters/files.js';
import { defaultOpencodeDbPath, vacuumOpencodeDb } from './adapters/opencode/db.js';
import { isGitRepo, planCodexGc, applyCodexGc } from './adapters/codex/checkpoints.js';
import { formatBytes, parseRetention } from './util.js';
import type { AdapterId, Finding } from './types.js';

const DAY = 86_400_000;

const require = createRequire(import.meta.url);
const VERSION: string = (require('../package.json') as { version?: string }).version ?? '0.0.0';

function fail(msg: string): never {
  console.error(`agent-janitor: ${msg}`);
  console.error(`Run 'agent-janitor help' for usage. No changes were made.`);
  process.exit(1);
}

const HELP = `agent-janitor v${VERSION} — reclaim disk space from AI coding agent harnesses (opencode, codex, claude, gemini, kiro, cursor, antigravity, copilot, cline, amp, roo, openclaw, continue, aider)

usage:
  agent-janitor scan [--target <adapter>] [--retention <30d>] [--json]
  agent-janitor clean [--target <adapter>] [--retention <30d>] [--apply] [--json]
  agent-janitor restore --list [--json] | restore <id>
  agent-janitor trash [--retention <30d>] [--apply] [--json]
  agent-janitor vacuum [--db <path>] [--retention <30d>] [--delete-sessions-older-than <90d>]
                       [--apply] [--no-backup] [--skip-proof] [--json]
  agent-janitor codex-gc [--repo <path>] [--retention <30d>] [--apply] [--json]
  agent-janitor help [command]
  agent-janitor --version

commands:
  scan     read-only audit of every harness's storage. never changes anything.
  clean    move trash-eligible files to ~/.agent-janitor/trash (dry-run by default).
           never touches databases — use vacuum for that.
  restore  put a trashed item back where it was (id from 'restore --list').
  trash    show the trash and how long each item has left; --apply permanently
           deletes items older than the retention window. the only real delete.
  vacuum   opencode DB surgery: delete superseded snapshot events + byte-identical
           duplicates, then VACUUM. gated by a reconstruction proof. dry-run default.
           --delete-sessions-older-than N additionally deletes whole old sessions (opt-in).
  codex-gc garbage-collect Codex turn-diff checkpoint refs (refs/codex/turn-diffs/*)
           in a git repo. forfeits per-turn rewind for affected old sessions.

safety: scan is read-only. clean/vacuum/codex-gc are dry-run by default and need
--apply to act. files go to a trash dir with a manifest and are restorable.
databases are refused when in use (WAL/SHM present); integrity is checked before
and after surgery; a timestamped backup is taken unless you pass --no-backup.

examples:
  agent-janitor scan                  # read-only audit — always safe, start here
  agent-janitor clean                 # preview what would move to trash
  agent-janitor clean --apply         # move it to trash (restorable)
  agent-janitor restore --list        # show what can be put back
  agent-janitor vacuum                # preview opencode DB compaction
  agent-janitor codex-gc --repo ~/myrepo   # preview checkpoint-ref cleanup

run 'agent-janitor <command> --help' for details on one command.
`;

const SCAN_HELP = `agent-janitor scan — read-only audit. never changes anything.

usage: agent-janitor scan [--target <adapter>] [--retention <30d>] [--json]

  --retention <n><d|w|m>  age cutoff used to flag old items (default 30d)
  --target <adapter>      audit only one harness
  --json                  machine-readable output (schema: see README "JSON output")

exit codes: 0 scan completed (even when nothing found), 1 bad flag/target.
`;

const CLEAN_HELP = `agent-janitor clean — move trash-eligible files to ~/.agent-janitor/trash.

usage: agent-janitor clean [--target <adapter>] [--retention <30d>] [--apply] [--json]

destructive? only with --apply, and even then nothing is deleted: files are
moved to trash with a manifest entry and can be put back with 'restore'.
default (no --apply) is a dry run: prints what would move, changes nothing.

  --retention <n><d|w|m>  only items older than this move (ephemeral logs/tmp always eligible)
  --target <adapter>      clean only one harness
  --apply                 actually move files to trash
  --json                  machine-readable plan (dry run) or result (--apply)

never touches: databases (use vacuum), settings/credentials/plugins dirs,
report-only paths (listed by scan). files with unknown age are kept.

examples:
  agent-janitor clean                 # preview
  agent-janitor clean --apply         # move to trash
  agent-janitor restore --list        # show trash contents
`;

const RESTORE_HELP = `agent-janitor restore — put a trashed item back where it was.

usage: agent-janitor restore --list [--json]
       agent-janitor restore <id>

never destructive to your data: refuses when something already exists at the
original path (nothing is overwritten).

examples:
  agent-janitor restore --list   # show trash: id, size, harness, original path
  agent-janitor restore 2026-09-14T10-00-00-000Z#3
`;

const TRASH_HELP = `agent-janitor trash — inspect the trash, then (and only then) really delete.

usage: agent-janitor trash [--retention <30d>] [--apply] [--json]

  (no --apply)   list every trashed item with its age and what is past the window
  --retention    window after which an item is expired (default 30d)
  --apply        PERMANENTLY delete the expired items. this is the only command in
                 agent-janitor that destroys data; nothing can be restored after it.
  --json         machine-readable

the trash itself is at ~/.agent-janitor/trash — you can delete it by hand at any time.

examples:
  agent-janitor trash                 # what is in there, what is expiring
  agent-janitor trash --apply         # really delete the expired ones
  agent-janitor trash --retention 7d --apply
`;

const VACUUM_HELP = `agent-janitor vacuum — compact the opencode SQLite DB. most sensitive command.

usage: agent-janitor vacuum [--db <path>] [--retention <30d>] [--delete-sessions-older-than <90d>]
                            [--apply] [--no-backup] [--skip-proof] [--json]

what it does: deletes superseded snapshot events (older full snapshots of an
entity the newest snapshot already covers) + byte-identical duplicate payloads,
then VACUUM to shrink the file.

default (no --apply) is a dry run: runs the safety checks, prints the plan,
changes nothing.

safety pipeline (every step must pass, else abort with no changes):
  1. lock probe — refuses when WAL/SHM sidecars exist (DB in use).
     fix: close opencode, wait a few seconds for checkpointing, retry.
  2. schema gate — refuses unknown schemas (fail closed).
  3. reconstruction proof — verifies every live message/part matches its newest
     snapshot before deleting anything. use --skip-proof only to preview faster;
     never with --apply on data you care about.
  4. backup — timestamped copy next to the DB (disable with --no-backup, dangerous).
  5. integrity quick_check before and after deletes and after VACUUM.

  --db <path>                       opencode.db path (default: ~/.local/share/opencode/opencode.db)
  --delete-sessions-older-than <Nd> opt-in: also delete whole sessions older than N.
                                    sessions are removed, not trashed — the DB backup is the undo.
  --no-backup                       skip the safety copy (dangerous)
  --skip-proof                      skip the losslessness proof (dangerous with --apply)

examples:
  agent-janitor vacuum               # preview with proof
  agent-janitor vacuum --apply       # backup, delete eligible rows, VACUUM
`;

const CODEX_GC_HELP = `agent-janitor codex-gc — delete old Codex turn-diff checkpoint refs in a git repo.

usage: agent-janitor codex-gc [--repo <path>] [--retention <30d>] [--apply] [--json]

WARNING: this forfeits per-turn project rewind/diff for affected old sessions.
Codex never prunes refs/codex/turn-diffs/* and they can grow to 100+ GB
(openai/codex#29388). only refs under refs/codex/turn-diffs/ are touched;
your branches, tags, and other refs are never modified.

default (no --apply) is a dry run: lists refs that would go, changes nothing.

examples:
  agent-janitor codex-gc --repo ~/myrepo           # preview
  agent-janitor codex-gc --repo ~/myrepo --apply   # delete old refs + git gc --prune=now
`;

const COMMAND_HELP: Record<string, string> = {
  scan: SCAN_HELP,
  clean: CLEAN_HELP,
  restore: RESTORE_HELP,
  trash: TRASH_HELP,
  vacuum: VACUUM_HELP,
  'codex-gc': CODEX_GC_HELP,
};

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
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
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
  if (!ADAPTER_IDS.includes(target as AdapterId)) fail(`--target must be one of: ${ADAPTER_IDS.join(', ')}`);
  return target as AdapterId;
}

async function cmdScan(args: CliArgs): Promise<void> {
  if (args.values.help === true) {
    console.log(SCAN_HELP);
    return;
  }
  const retentionDays = parseRetention(String(args.values.retention ?? '30d'));
  const result = await scanAll({ retentionDays, target: adapterFromTarget(args.values.target as string | undefined) });
  if (args.values.json) {
    console.log(JSON.stringify({ ...result, version: VERSION }, null, 2));
  } else {
    console.log(renderScan(result, VERSION));
  }
}

async function cmdClean(args: CliArgs): Promise<void> {
  if (args.values.help === true) {
    console.log(CLEAN_HELP);
    return;
  }
  const retentionDays = parseRetention(String(args.values.retention ?? '30d'));
  const target = adapterFromTarget(args.values.target as string | undefined);
  const apply = args.values.apply === true;
  const json = args.values.json === true;
  const result = await scanAll({ retentionDays, target });
  const cutoff = Date.now() - retentionDays * DAY;
  const findings: Finding[] = result.adapters
    .flatMap((a) => a.findings)
    .filter((f) => f.category === 'trash' && isOldEnough(f, cutoff));
  if (findings.length === 0) {
    if (json) {
      console.log(JSON.stringify({ command: 'clean', version: VERSION, dryRun: !apply, retentionDays, count: 0, totalBytes: 0, findings: [] }, null, 2));
    } else {
      console.log(`nothing to clean for the current filters (retention ${retentionDays}d). Nothing was changed.`);
    }
    return;
  }
  if (!apply) {
    if (json) {
      console.log(
        JSON.stringify(
          {
            command: 'clean',
            version: VERSION,
            dryRun: true,
            retentionDays,
            count: findings.length,
            totalBytes: findings.reduce((s, f) => s + f.bytes, 0),
            findings,
          },
          null,
          2,
        ),
      );
      return;
    }
    console.log(renderCleanPlan(findings, false));
    console.log('\nDRY RUN — nothing was changed. To apply:\n  agent-janitor clean --apply');
    return;
  }
  const moved: Array<{ id: string; originalPath: string; bytes: number; adapter: string; kind: string }> = [];
  const failed: Array<{ path: string; error: string }> = [];
  let movedCount = 0;
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
      movedCount++;
      bytes += f.bytes;
      moved.push({ id: entry.id, originalPath: entry.originalPath, bytes: f.bytes, adapter: f.adapter, kind: f.kind });
      if (!json) console.log(`  trashed ${formatBytes(f.bytes).padStart(9)}  ${f.path}  [${entry.id}]`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failed.push({ path: f.path, error: message });
      if (!json) console.error(`  FAILED ${f.path}: ${message}`);
    }
  }
  if (json) {
    console.log(JSON.stringify({ command: 'clean', version: VERSION, dryRun: false, retentionDays, moved: movedCount, totalBytes: bytes, entries: moved, failed }, null, 2));
    return;
  }
  console.log(`\nmoved ${movedCount} item(s), ${formatBytes(bytes)} to trash. Nothing was permanently deleted.`);
  if (failed.length > 0) console.log(`${failed.length} item(s) could not be moved (see errors above).`);
  console.log(`Restore: agent-janitor restore --list`);
}

async function cmdRestore(args: CliArgs): Promise<void> {
  if (args.values.help === true) {
    console.log(RESTORE_HELP);
    return;
  }
  const list = args.values.list === true;
  const json = args.values.json === true;
  if (list || args.positionals.length === 0) {
    const active = (await listTrash()).filter((e) => !e.restoredAt);
    if (active.length === 0) {
      if (json) {
        console.log(JSON.stringify({ command: 'restore', version: VERSION, count: 0, totalBytes: 0, entries: [] }, null, 2));
      } else {
        console.log('Trash is empty. Nothing to restore.');
      }
      return;
    }
    let total = 0;
    for (const e of active) total += e.bytes;
    if (json) {
      console.log(JSON.stringify({ command: 'restore', version: VERSION, count: active.length, totalBytes: total, entries: active }, null, 2));
      return;
    }
    console.log('Trash (~/.agent-janitor/trash) — nothing here is gone, everything can go back:\n');
    console.log(`  ${'ID'.padEnd(30)}${'SIZE'.padStart(9)}  ${'HARNESS'.padEnd(9)}${'KIND'.padEnd(14)}ORIGINAL PATH`);
    for (const e of active) {
      console.log(`  ${e.id.padEnd(30)}${formatBytes(e.bytes).padStart(9)}  ${e.adapter.padEnd(9)}${e.kind.padEnd(14)}${e.originalPath}`);
    }
    console.log(`\n${active.length} item(s), ${formatBytes(total)} in trash.`);
    console.log(`\nRestore with:\n  agent-janitor restore <id>`);
    return;
  }
  const entry: TrashEntry = await restoreFromTrash(args.positionals[0]!);
  if (json) {
    console.log(JSON.stringify({ command: 'restore', version: VERSION, restored: entry }, null, 2));
    return;
  }
  console.log(`restored ${entry.originalPath}`);
}

async function cmdTrash(args: CliArgs): Promise<void> {
  if (args.values.help === true) {
    console.log(TRASH_HELP);
    return;
  }
  const retentionDays = parseRetention(String(args.values.retention ?? '30d'));
  const apply = args.values.apply === true;
  const json = args.values.json === true;
  const before = (await listTrash()).filter((e) => !e.restoredAt);
  const result = await pruneTrash(retentionDays, apply);
  const active = apply ? before.filter((e) => !result.expired.some((x) => x.id === e.id)) : before;
  if (json) {
    console.log(
      JSON.stringify(
        {
          command: 'trash',
          version: VERSION,
          dryRun: !apply,
          retentionDays,
          trashPath: trashRoot(),
          activeCount: active.length,
          activeBytes: active.reduce((s, e) => s + e.bytes, 0),
          expiredCount: result.expired.length,
          ...(apply ? { deletedBytes: result.bytes, failed: result.failed } : {}),
          entries: active,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (active.length === 0 && result.expired.length === 0) {
    console.log(`Trash is empty (${trashRoot()}). Nothing to prune.`);
    return;
  }
  const age = (iso: string): string => `${Math.floor((Date.now() - Date.parse(iso)) / DAY)}d`;
  console.log(`Trash — ${trashRoot()}\n`);
  for (const e of active) {
    const expired = result.expired.some((x) => x.id === e.id);
    console.log(
      `  ${expired ? 'EXPIRED' : 'kept   '}  ${formatBytes(e.bytes).padStart(9)}  ${age(e.movedAt).padStart(3)} old  ${e.adapter.padEnd(10)}${e.originalPath}`,
    );
  }
  const kept = active.length - result.expired.length;
  console.log(`\n  ${active.length} item(s), ${formatBytes(active.reduce((s, e) => s + e.bytes, 0))} total — ${result.expired.length} past the ${retentionDays}d window, ${kept} still restorable.`);
  if (!apply) {
    if (result.expired.length === 0) return;
    console.log('\nDRY RUN — nothing was deleted. To really delete the expired items:');
    console.log('  agent-janitor trash --apply');
    console.log('\nWARNING: after --apply those items are gone for good. Restore them first with:');
    console.log('  agent-janitor restore <id>');
    return;
  }
  console.log(`\ndeleted ${result.expired.length} expired item(s), ${formatBytes(result.bytes)} reclaimed permanently.`);
  if (result.failed.length > 0) console.log(`${result.failed.length} could not be deleted (see below).`);
  for (const f of result.failed) console.error(`  FAILED ${f.id}: ${f.error}`);
}

async function cmdVacuum(args: CliArgs): Promise<void> {
  if (args.values.help === true) {
    console.log(VACUUM_HELP);
    return;
  }
  const dbPath = (args.values.db as string | undefined) ?? defaultOpencodeDbPath();
  if (!dbPath) fail('no opencode.db found (pass --db <path>). Nothing was changed.');
  const apply = args.values.apply === true;
  const json = args.values.json === true;
  const backup = args.values['no-backup'] !== true;
  const skipProof = args.values['skip-proof'] === true;
  const retentionDays = parseRetention(String(args.values.retention ?? '30d'));
  const delSessionsRaw = args.values['delete-sessions-older-than'] as string | undefined;
  const deleteSessionsOlderThanDays = delSessionsRaw !== undefined ? parseRetention(delSessionsRaw) : undefined;
  const log = json ? (_msg: string): void => {} : (msg: string): void => console.log(`  ${msg}`);
  try {
    const outcome = await vacuumOpencodeDb({ dbPath, apply, backup, deleteSessionsOlderThanDays, skipProof, log });
    if (json) {
      console.log(
        JSON.stringify(
          {
            command: 'vacuum',
            version: VERSION,
            dryRun: !apply,
            dbPath,
            proof: outcome.proof,
            plan: outcome.plan,
            ...(apply
              ? {
                  deletedDupeRows: outcome.deletedDupeRows,
                  deletedSupersededRows: outcome.deletedSupersededRows,
                  deletedSessions: outcome.deletedSessions,
                  deletedEventsForSessions: outcome.deletedEventsForSessions,
                  backupPath: outcome.backupPath ?? null,
                  bytesBefore: outcome.bytesBefore,
                  bytesAfter: outcome.bytesAfter ?? null,
                  integrityBefore: outcome.integrityBefore ?? null,
                  integrityAfter: outcome.integrityAfter ?? null,
                }
              : {}),
          },
          null,
          2,
        ),
      );
      return;
    }
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
    console.log('Result');
    console.log(
      `  deleted: ${outcome.deletedDupeRows} duplicate rows + ${outcome.deletedSupersededRows} superseded rows, ${outcome.deletedSessions} sessions removed`,
    );
    console.log(`  size: ${formatBytes(outcome.bytesBefore)} -> ${formatBytes(after)} (freed ${formatBytes(freed)})`);
    console.log(`  integrity: ${outcome.integrityBefore} -> ${outcome.integrityAfter}`);
    console.log(`  backup: ${outcome.backupPath ?? 'NONE (--no-backup was given)'}`);
    if (outcome.backupPath) {
      console.log(`\nTo undo: close opencode, then copy the backup back over the DB.`);
    } else {
      console.log(`\nNo backup exists for this run — deleted rows cannot be recovered.`);
    }
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
  if (args.values.help === true) {
    console.log(CODEX_GC_HELP);
    return;
  }
  const repo = (args.values.repo as string | undefined) ?? process.cwd();
  if (!(await isGitRepo(repo))) fail(`not a git repository: ${repo}. Nothing was changed.`);
  const apply = args.values.apply === true;
  const json = args.values.json === true;
  const retentionDays = parseRetention(String(args.values.retention ?? '30d'));
  const plan = await planCodexGc(repo, retentionDays);
  if (json) {
    if (!apply) {
      console.log(JSON.stringify({ command: 'codex-gc', version: VERSION, dryRun: true, ...plan }, null, 2));
      return;
    }
    const logged: string[] = [];
    const outcome = await applyCodexGc(plan, (m) => logged.push(m));
    console.log(JSON.stringify({ command: 'codex-gc', version: VERSION, dryRun: false, ...plan, ...outcome, log: logged }, null, 2));
    return;
  }
  const fmt = (sec: number): string => (sec ? new Date(sec).toISOString().slice(0, 10) : '?');
  console.log(`agent-janitor codex-gc — repo: ${repo}`);
  console.log(`  checkpoint refs under refs/codex/turn-diffs/: ${plan.totalRefs}`);
  if (plan.totalRefs === 0) {
    console.log('  nothing to collect. Nothing was changed.');
    return;
  }
  console.log(`  refs span ${fmt(plan.oldestDateSec)} .. ${fmt(plan.newestDateSec)}`);
  console.log(
    `  older than ${retentionDays}d: ${plan.oldRefs.length} ref(s) — deleting them + 'git gc --prune=now' reclaims their tree objects`,
  );
  console.log('');
  console.log('  WARNING: this forfeits per-turn rewind/diff history for the affected old sessions.');
  console.log('  Only refs under refs/codex/turn-diffs/ are targeted. Your branches and tags are never touched.');
  const listed = plan.oldRefs.slice(0, 20);
  for (const r of listed) console.log(`    would delete: ${r.refname}`);
  if (plan.oldRefs.length > listed.length) console.log(`    ... and ${plan.oldRefs.length - listed.length} more`);
  if (!apply) {
    console.log('\nDRY RUN — nothing was changed. To apply:\n  agent-janitor codex-gc --apply');
    return;
  }
  await applyCodexGc(plan, (m) => console.log(`  ${m}`));
  console.log(`\ndeleted ${plan.oldRefs.length} ref(s); git gc complete.`);
}

async function main(): Promise<void> {
  const args = parse();
  if (args.values.version === true) {
    console.log(VERSION);
    return;
  }
  switch (args.command) {
    case 'scan':
      return cmdScan(args);
    case 'clean':
      return cmdClean(args);
    case 'restore':
      return cmdRestore(args);
    case 'trash':
      return cmdTrash(args);
    case 'vacuum':
      return cmdVacuum(args);
    case 'codex-gc':
      return cmdCodexGc(args);
    case 'version':
    case '--version':
    case '-v':
      console.log(VERSION);
      return;
    case 'help':
    case '--help':
    case '-h': {
      const topic = args.positionals[0];
      if (topic && COMMAND_HELP[topic]) {
        console.log(COMMAND_HELP[topic]);
        return;
      }
      if (topic) fail(`unknown help topic "${topic}" (try: ${Object.keys(COMMAND_HELP).join(', ')})`);
      console.log(HELP);
      return;
    }
    default:
      console.log(HELP);
      fail(`unknown command "${args.command}"`);
  }
}

main().catch((err) => fail(err instanceof Error ? (err.stack ?? err.message) : String(err)));
