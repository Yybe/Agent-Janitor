import type { AdapterId, AdapterScan, ScanResult, ScanOptions, Finding } from '../types.js';
import { analyzeOpencodeDb, defaultOpencodeDbPath } from '../adapters/opencode/db.js';
import { scanOpencodeFiles, scanCodex, scanClaude, scanGemini } from '../adapters/files.js';

async function scanAdapter(id: AdapterId, opts: ScanOptions): Promise<AdapterScan> {
  const scan: AdapterScan = { adapter: id, present: false, findings: [], dbReport: undefined, notes: [] };
  if (opts.target && opts.target !== id) return scan;
  try {
    if (id === 'opencode') {
      scan.findings = await scanOpencodeFiles(opts.retentionDays);
      const dbPath = defaultOpencodeDbPath();
      if (dbPath) {
        scan.dbReport = await analyzeOpencodeDb(dbPath, opts.retentionDays);
      } else {
        scan.notes.push('no opencode.db found');
      }
      scan.present = scan.findings.length > 0 || scan.dbReport !== undefined;
    } else if (id === 'codex') {
      scan.findings = await scanCodex(opts.retentionDays);
      scan.present = scan.findings.length > 0;
    } else if (id === 'claude') {
      scan.findings = await scanClaude(opts.retentionDays);
      scan.present = scan.findings.length > 0;
    } else if (id === 'gemini') {
      scan.findings = await scanGemini(opts.retentionDays);
      scan.present = scan.findings.length > 0;
    }
  } catch (err) {
    scan.notes.push(`scan error: ${err instanceof Error ? err.message : String(err)}`);
  }
  return scan;
}

export async function scanAll(opts: ScanOptions): Promise<ScanResult> {
  const adapters: AdapterScan[] = [];
  for (const id of ['opencode', 'codex', 'claude', 'gemini'] as AdapterId[]) {
    adapters.push(await scanAdapter(id, opts));
  }
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
