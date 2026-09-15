import type { ScanResult, Finding, DbReport } from './types.js';
import { formatBytes } from './util.js';

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function padLeft(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
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

/** machine kind -> human label for grouped scan output */
function kindLabel(kind: string): string {
  const map: Record<string, string> = {
    'snapshot-dir': 'Superseded snapshots',
    'session-dir': 'Stale sessions',
    'session-file': 'Stale sessions',
    'workspace-dir': 'Stale workspaces',
    'orphan-project': 'Orphan project caches',
    'cache-dir': 'Stale caches',
    'history-log': 'Overgrown history',
    conversation: 'Stale conversations',
    recording: 'Stale recordings',
    'crash-log': 'Crash logs',
    log: 'Logs',
    'tmp-junk': 'Temp files',
    'stale-backup': 'Stale backups',
  };
  return map[kind] ?? kind;
}

export function renderScan(result: ScanResult, version?: string): string {
  const lines: string[] = [];
  lines.push(version ? `agent-janitor v${version}` : 'agent-janitor scan');
  lines.push('');
  lines.push(`Scanning AI coding-agent storage... (retention ${result.retentionDays}d)`);
  lines.push('');
  for (const a of result.adapters) {
    lines.push(a.present ? `✓ ${a.adapter}` : `- ${a.adapter} (not found)`);
  }
  for (const a of result.adapters) {
    for (const note of a.notes) lines.push(`  note (${a.adapter}): ${note}`);
  }
  lines.push('');
  lines.push('Reclaimable storage');
  lines.push('');
  let anyReclaimable = false;
  for (const a of result.adapters) {
    const trash = a.findings.filter((f) => f.category === 'trash');
    const dbBytes = a.dbReport && a.dbReport.schemaGate.ok
      ? a.dbReport.supersededBytes + a.dbReport.dupeBytes + a.dbReport.freelistBytes
      : 0;
    if (trash.length === 0 && dbBytes === 0 && !a.dbReport) continue;
    anyReclaimable = true;
    lines.push(a.adapter);
    // group file findings by kind so output reads as categories, not raw paths
    const byKind = new Map<string, { count: number; bytes: number }>();
    for (const f of trash) {
      const g = byKind.get(f.kind) ?? { count: 0, bytes: 0 };
      g.count++;
      g.bytes += f.bytes;
      byKind.set(f.kind, g);
    }
    for (const [kind, g] of [...byKind.entries()].sort((x, y) => y[1].bytes - x[1].bytes)) {
      lines.push(`${kindLabel(kind).padEnd(28)} ${formatBytes(g.bytes).padStart(9)}  (${g.count} item${g.count === 1 ? '' : 's'})`);
    }
    if (a.dbReport) lines.push(...renderDbSummary(a.dbReport));
    // full path detail, newest last so the biggest offenders are visible
    const detail = [...trash].sort((x, y) => y.bytes - x.bytes).slice(0, 10);
    for (const f of detail) {
      lines.push(`  ${padLeft(formatBytes(f.bytes), 9)}  ${pad(age(f.mtimeMs), 5)} ${truncatePath(f.path, 90)}`);
    }
    if (trash.length > detail.length) lines.push(`  ... and ${trash.length - detail.length} more (run with --json for the full list)`);
    lines.push('');
  }
  if (!anyReclaimable) lines.push('(nothing reclaimable found)\n');
  const potential = result.fileReclaimableBytes + result.dbReclaimableEstimateBytes;
  lines.push('------------------------------------');
  lines.push(`Potential reclaimable space  ${formatBytes(potential).padStart(9)}`);
  lines.push('------------------------------------');
  lines.push(`  files: ${formatBytes(result.fileReclaimableBytes)} trash-eligible · db estimate (upper bound): ${formatBytes(result.dbReclaimableEstimateBytes)}`);
  lines.push('');
  const reportOnly = result.adapters.flatMap((a) => a.findings.filter((f) => f.category === 'report-only'));
  if (reportOnly.length > 0) {
    lines.push('Never touched (report-only):');
    const seen = new Set<string>();
    for (const f of reportOnly.slice(0, 8)) {
      const key = `${f.adapter}:${f.description}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`  - ${f.adapter}: ${truncatePath(f.path, 60)} — ${f.description}`);
    }
    lines.push(`  ${reportOnly.length} path(s), ${formatBytes(result.reportOnlyBytes)} total. settings, credentials, plugins, and live DBs are never cleaned.`);
    lines.push('');
  }
  lines.push('Nothing was changed. scan is always read-only.');
  lines.push('');
  lines.push('Next:');
  lines.push('  agent-janitor clean    # preview what would move to trash (dry run)');
  return lines.join('\n');
}

function renderDbSummary(db: DbReport): string[] {
  if (!db.schemaGate.ok) return [`db: SCHEMA GATE FAILED — ${db.schemaGate.reason}; no DB operations possible`];
  const out: string[] = [];
  out.push(
    `${'DB compaction'.padEnd(28)} ${formatBytes(db.supersededBytes + db.dupeBytes + db.freelistBytes).padStart(9)}  (${db.supersededRows} superseded + ${db.dupeRows} dupe rows, ${db.sessions.total} sessions)`,
  );
  if (db.staleSessions.count > 0) {
    const s = db.staleSessions;
    out.push(
      `  stale sessions: ${s.count} (≈${formatBytes(s.estimatedBytes)}; $${s.totalCost.toFixed(2)} / ${fmtTokens(s.tokensInput)}in/${fmtTokens(s.tokensOutput)}out/${fmtTokens(s.tokensCacheRead)}cache would be forgotten)`,
    );
  }
  return out;
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
  lines.push(apply ? 'agent-janitor clean — APPLY (moving to trash)' : 'DRY RUN — nothing will be changed');
  lines.push('');
  const byAdapter = new Map<string, Finding[]>();
  for (const f of findings) {
    const g = byAdapter.get(f.adapter) ?? [];
    g.push(f);
    byAdapter.set(f.adapter, g);
  }
  for (const [adapter, items] of byAdapter) {
    const bytes = items.reduce((s, f) => s + f.bytes, 0);
    lines.push(`${adapter}`);
    lines.push(`  ${items.length} file(s), ${formatBytes(bytes)}`);
    for (const f of items.slice(0, 15)) {
      lines.push(`    ${padLeft(formatBytes(f.bytes), 9)}  ${pad(f.kind, 13)} ${truncatePath(f.path, 80)}`);
    }
    if (items.length > 15) lines.push(`    ... and ${items.length - 15} more`);
    lines.push('');
  }
  lines.push('Total:');
  lines.push(`  ${findings.length} file(s), ${formatBytes(total)} -> trash (~/.agent-janitor/trash)`);
  lines.push('  Nothing is permanently deleted. Restore with: agent-janitor restore --list');
  if (!apply) {
    lines.push('');
    lines.push('To apply:');
    lines.push('  agent-janitor clean --apply');
  }
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
  lines.push('OpenCode database vacuum');
  lines.push('');
  lines.push(`Database:`);
  lines.push(`  ${view.path} (${formatBytes(view.fileBytes)}, ${view.sessionsTotal} sessions)`);
  lines.push('');
  lines.push('Safety checks');
  lines.push('  (lock probe, schema gate, and integrity check ran before this plan)');
  lines.push(`  reconstruction proof: ${proofSummary}`);
  lines.push('');
  lines.push('Plan');
  lines.push(`  Superseded snapshots: ${view.supersededRows} rows = ${formatBytes(view.supersededBytes)}`);
  lines.push(`  Duplicate payloads:   ${view.dupeRows} rows = ${formatBytes(view.dupeBytes)}`);
  lines.push(`  Freelist pages:       ${view.freelistPages} pages = ${formatBytes(view.freelistBytes)}`);
  if (deleteSessionsOlderThanDays !== undefined) {
    lines.push(
      `  Sessions older than ${deleteSessionsOlderThanDays}d: ${view.staleSessions} sessions ≈ ${formatBytes(view.staleSessionBytes)} (removed, not trashed — the DB backup is the undo)`,
    );
  }
  const estimate = view.freelistBytes + view.supersededBytes + view.dupeBytes;
  lines.push(`  Estimated reclaim (upper bound): ${formatBytes(estimate)}`);
  lines.push('');
  lines.push('DRY RUN — no changes made.');
  lines.push('');
  lines.push('Apply with:');
  lines.push('  agent-janitor vacuum --apply');
  lines.push('A timestamped backup is taken first (unless --no-backup).');
  return lines.join('\n');
}
