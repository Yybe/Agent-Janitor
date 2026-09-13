import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url)); // <root>/test or <root>/dist-test/test
export const REPO_ROOT = path.resolve(here, '..', '..');
export const CLI = path.join(REPO_ROOT, 'dist', 'cli.js');

export interface TempHome {
  root: string;
  cleanup: () => void;
}

export function makeTempHome(): TempHome {
  const root = mkdtempSync(path.join(tmpdir(), 'janitor-home-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Run the built CLI with USERPROFILE pointed at a fake home. */
export function runCli(homeRoot: string, args: string[], timeoutMs = 120_000): RunResult {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, USERPROFILE: homeRoot },
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

const DAY = 86_400_000;

/** Populate a fake home with harness files of controlled ages. */
export function seedFakeHarnessFiles(root: string): void {
  const old = new Date(Date.now() - 40 * DAY);
  const fresh = new Date(Date.now() - 1 * DAY);

  // claude transcripts: one old, one fresh
  const tr = path.join(root, '.claude', 'transcripts');
  mkdirSync(tr, { recursive: true });
  writeFileSync(path.join(tr, 'ses_old.jsonl'), '{"type":"user"}\n{"type":"assistant"}\n');
  writeFileSync(path.join(tr, 'ses_new.jsonl'), '{"type":"user"}\n');
  utimesSync(path.join(tr, 'ses_old.jsonl'), old, old);
  utimesSync(path.join(tr, 'ses_new.jsonl'), fresh, fresh);

  // codex session tree: old rollout + fresh rollout + tmp junk
  const codexDay = path.join(root, '.codex', 'sessions', '2026', '08', '17');
  const codexDayFresh = path.join(root, '.codex', 'sessions', '2026', '09', '12');
  mkdirSync(codexDay, { recursive: true });
  mkdirSync(codexDayFresh, { recursive: true });
  writeFileSync(path.join(codexDay, 'rollout-old.jsonl'), '{"ordinal":0}\n');
  writeFileSync(path.join(codexDayFresh, 'rollout-fresh.jsonl'), '{"ordinal":0}\n');
  utimesSync(path.join(codexDay, 'rollout-old.jsonl'), old, old);
  utimesSync(path.join(codexDayFresh, 'rollout-fresh.jsonl'), fresh, fresh);
  writeFileSync(path.join(root, '.codex', '..codex-global-state.json.tmp-123'), '');
  utimesSync(path.join(root, '.codex', '..codex-global-state.json.tmp-123'), fresh, fresh);

  // stale opencode config backup
  const cfg = path.join(root, '.config', 'opencode');
  mkdirSync(cfg, { recursive: true });
  writeFileSync(path.join(cfg, 'opencode.jsonc.backup-2026-06-16T15-55-05-577Z'), '{}\n');
  utimesSync(path.join(cfg, 'opencode.jsonc.backup-2026-06-16T15-55-05-577Z'), old, old);
}
