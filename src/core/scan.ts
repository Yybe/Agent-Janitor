import type { AdapterId, AdapterScan, ScanResult, ScanOptions, Finding } from '../types.js';
import { quickOpencodeDbStats, defaultOpencodeDbPath } from '../adapters/opencode/db.js';
import {
  scanOpencodeFiles,
  scanCodex,
  scanClaude,
  scanGemini,
  scanKiro,
  scanCursor,
  scanAntigravity,
  scanCopilot,
  scanCline,
  scanAmp,
  scanRoo,
  scanOpenclaw,
  scanContinue,
  scanAider,
} from '../adapters/files.js';

const SCANNERS: Record<AdapterId, (retentionDays: number) => Promise<Finding[]>> = {
  opencode: scanOpencodeFiles,
  codex: scanCodex,
  claude: scanClaude,
  gemini: scanGemini,
  kiro: scanKiro,
  cursor: scanCursor,
  antigravity: scanAntigravity,
  copilot: scanCopilot,
  cline: scanCline,
  amp: scanAmp,
  roo: scanRoo,
  openclaw: scanOpenclaw,
  continue: scanContinue,
  aider: scanAider,
};

const ALL: AdapterId[] = [
  'opencode',
  'codex',
  'claude',
  'gemini',
  'kiro',
  'cursor',
  'antigravity',
  'copilot',
  'cline',
  'amp',
  'roo',
  'openclaw',
  'continue',
  'aider',
];

async function scanAdapter(id: AdapterId, opts: ScanOptions): Promise<AdapterScan> {
  const scan: AdapterScan = { adapter: id, present: false, findings: [], dbReport: undefined, notes: [] };
  if (opts.target && opts.target !== id) return scan;
  try {
    scan.findings = await SCANNERS[id](opts.retentionDays);
    if (id === 'opencode') {
      // P0: scan uses PRAGMA/COUNT fast path only — exact byte plan lives in vacuum dry run
      const dbPath = defaultOpencodeDbPath();
      if (dbPath) {
        scan.dbReport = await quickOpencodeDbStats(dbPath);
        if (!scan.dbReport) scan.notes.push('opencode.db unreadable or failed schema gate');
      } else {
        scan.notes.push('no opencode.db found');
      }
    }
    scan.present = scan.findings.length > 0 || scan.dbReport !== undefined;
  } catch (err) {
    scan.notes.push(`scan error: ${err instanceof Error ? err.message : String(err)}`);
  }
  return scan;
}

export async function scanAll(opts: ScanOptions): Promise<ScanResult> {
  // P0: adapters scan concurrently — wall time is the slowest adapter, not the sum
  const adapters = await Promise.all(ALL.map((id) => scanAdapter(id, opts)));
  const trashable = (f: Finding) => f.category === 'trash';
  return {
    scannedAt: new Date().toISOString(),
    retentionDays: opts.retentionDays,
    adapters,
    fileReclaimableBytes: adapters.flatMap((a) => a.findings).filter(trashable).reduce((s, f) => s + f.bytes, 0),
    reportOnlyBytes: adapters.flatMap((a) => a.findings).filter((f) => !trashable(f)).reduce((s, f) => s + f.bytes, 0),
    dbReclaimableEstimateBytes: adapters.reduce(
      (s, a) => s + (a.dbReport ? a.dbReport.supersededBytes + a.dbReport.dupeBytes + a.dbReport.freelistBytes : 0),
      0,
    ),
  };
}
