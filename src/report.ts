import type { ScanResult, Finding, DbReport } from './types.js';
import { formatBytes } from './util.js';

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function padLeft(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

/** keep the TAIL of long paths — basenames (the identifying part) live at the end */
function truncatePath(p: string, n = 120): string {
  return p.length <= n ? p : '…' + p.slice(p.length - n + 1);
}

function age(mtimeMs: number | undefined): string {
  if (!mtimeMs) return '?';
  const days = Math.floor((Date.now() - mtimeMs) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return '1d';
  if (days < 60) return `${days}d`;
  return `${Math.round(days / 30)}mo`;
}

export function renderScan(result: ScanResult): string {
  const lines: string[] = [];
  lines.push(`agent-janitor scan — ${result.scannedAt} (retention ${result.retentionDays}d)`);
  lines.push('');
  for (const a of result.adapters) {
    if (!a.present && a.notes.length === 0) continue;
    lines.push(`── ${a.adapter} ${'─'.repeat(Math.max(3, 60 - a.adapter.length))}`);
    for (const note of a.notes) lines.push(`   note: ${note}`);
    const trash = a.findings.filter((f) => f.category === 'trash');
    const reports = a.findings.filter((f) => f.category === 'report-only');
    if (trash.length > 0) {
      lines.push(`   ${pad('KIND', 16)}${padLeft('SIZE', 10)}  ${pad('AGE', 6)}PATH`);
      for (const f of trash) {
        lines.push(`   ${pad(f.kind, 16)}${padLeft(formatBytes(f.bytes), 10)}  ${pad(age(f.mtimeMs), 6)}${truncatePath(f.path)}`);
      }
      lines.push(`   ${pad('', 16)}${padLeft(formatBytes(trash.reduce((s, f) => s + f.bytes, 0)), 10)}  trash-eligible`);
    }
    if (reports.length > 0) {
      lines.push(`   report-only (never touched):`);
      for (const f of reports) {
        lines.push(`   ${pad(f.kind, 16)}${padLeft(formatBytes(f.bytes), 10)}  ${pad('', 6)}${truncatePath(f.path, 100)} — ${f.description}`);
      }
    }
    if (a.dbReport) lines.push(...renderDbReport(a.dbReport));
    lines.push('');
  }
  lines.push('── totals ' + '─'.repeat(52));
  lines.push(`   trash-eligible files:        ${padLeft(formatBytes(result.fileReclaimableBytes), 10)}`);
  lines.push(`   db reclaim estimate (upper): ${padLeft(formatBytes(result.dbReclaimableEstimateBytes), 10)}`);
  lines.push(`   report-only (untouched):     ${padLeft(formatBytes(result.reportOnlyBytes), 10)}`);
  lines.push('');
  lines.push(`run 'agent-janitor clean --apply' to trash file findings (dry-run is default).`);
  lines.push(`run 'agent-janitor vacuum' for the opencode DB (dry-run is default).`);
  return lines.join('\n');
}

function renderDbReport(db: DbReport): string[] {
  const lines: string[] = [];
  if (!db.schemaGate.ok) {
    lines.push(`   db: ${db.path}`);
    lines.push(`   db: SCHEMA GATE FAILED — ${db.schemaGate.reason}; no DB operations possible`);
    return lines;
  }
  lines.push(`   db: ${db.path} (${formatBytes(db.fileBytes)}, ${db.sessions.total} sessions)`);
  lines.push(
    `   db: pages ${db.pageCount} × ${db.pageSize}B, freelist ${db.freelistPages} pages (${formatBytes(db.freelistBytes)}) — deletes reclaim nothing until VACUUM`,
  );
  for (const t of db.eventTypes.slice(0, 6)) {
    lines.push(`   db: event ${pad(t.type, 26)}${padLeft(String(t.rows), 8)} rows  ${padLeft(formatBytes(t.bytes), 10)}`);
  }
  lines.push(`   db: superseded snapshot events (keep newest per entity): ${db.supersededRows} rows = ${formatBytes(db.supersededBytes)}`);
  lines.push(`   db: byte-identical duplicate payloads (>1MB, verified): ${db.dupeRows} rows = ${formatBytes(db.dupeBytes)}`);
  if (db.staleSessions.count > 0) {
    const s = db.staleSessions;
    lines.push(
      `   db: sessions older than retention: ${s.count} (≈${formatBytes(s.estimatedBytes)}; $${s.totalCost.toFixed(2)} / ${fmtTokens(s.tokensInput)}in/${fmtTokens(s.tokensOutput)}out/${fmtTokens(s.tokensCacheRead)}cache would be forgotten)`,
    );
  }
  lines.push(`   db: VACUUM reclaim estimate (upper bound): ${formatBytes(db.vacuumEstimateBytes)}`);
  return lines;
}

function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

export function renderCleanPlan(findings: Finding[], apply: boolean): string {
  const lines: string[] = [];
  const total = findings.reduce((s, f) => s + f.bytes, 0);
  lines.push(apply ? 'agent-janitor clean — APPLY (moving to trash)' : 'agent-janitor clean — DRY RUN (nothing moved; pass --apply)');
  lines.push('');
  for (const f of findings) {
    lines.push(`  ${padLeft(formatBytes(f.bytes), 10)}  ${pad(f.adapter, 9)} ${pad(f.kind, 14)} ${truncatePath(f.path)}`);
  }
  lines.push('');
  lines.push(`  ${findings.length} item(s), ${formatBytes(total)} -> trash (~/.agent-janitor/trash)`);
  return lines.join('\n');
}

export interface VacuumDryRunView {
  path: string;
  fileBytes: number;
  freelistPages: number;
  freelistBytes: number;
  supersededRows: number;
  supersededBytes: number;
  dupeRows: number;
  dupeBytes: number;
  staleSessions: number;
  staleSessionBytes: number;
  sessionsTotal: number;
}

export function renderVacuumDryRun(view: VacuumDryRunView, proofSummary: string, deleteSessionsOlderThanDays?: number): string {
  const lines: string[] = [];
  lines.push('agent-janitor vacuum — DRY RUN (nothing changed; pass --apply)');
  lines.push('');
  lines.push(`  db: ${view.path} (${formatBytes(view.fileBytes)}, ${view.sessionsTotal} sessions)`);
  lines.push(`  reconstruction proof: ${proofSummary}`);
  lines.push(`  would delete superseded snapshot events: ${view.supersededRows} rows = ${formatBytes(view.supersededBytes)}`);
  lines.push(`  would delete byte-identical duplicates:  ${view.dupeRows} rows = ${formatBytes(view.dupeBytes)}`);
  lines.push(`  would reclaim freelist:                  ${view.freelistPages} pages = ${formatBytes(view.freelistBytes)}`);
  if (deleteSessionsOlderThanDays !== undefined) {
    lines.push(
      `  would delete sessions older than ${deleteSessionsOlderThanDays}d: ${view.staleSessions} sessions ≈ ${formatBytes(view.staleSessionBytes)}`,
    );
  }
  const estimate = view.freelistBytes + view.supersededBytes + view.dupeBytes;
  lines.push(`  then VACUUM; estimated shrink (upper bound): ${formatBytes(estimate)}`);
  return lines.join('\n');
}
