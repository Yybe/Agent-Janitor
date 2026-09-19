import type { AdapterId, AdapterScan, ScanResult, ScanOptions, Finding } from '../types.js';
import { ADAPTER_IDS } from '../types.js';
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
  scanZed,
  scanQwen,
  scanKimi,
  scanAmazonQ,
  scanCrush,
  scanWindsurf,
  zedData,
} from '../adapters/files.js';
import { appData, home, localData } from '../util.js';

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
  zed: scanZed,
  qwen: scanQwen,
  kimi: scanKimi,
  amazonq: scanAmazonQ,
  crush: scanCrush,
  windsurf: scanWindsurf,
};

/** Where each adapter looks. Compiled-exhaustive alongside SCANNERS, so a new adapter must state its root. */
const ROOTS: Record<AdapterId, string> = {
  opencode: home('.local', 'share', 'opencode'),
  codex: home('.codex'),
  claude: home('.claude'),
  gemini: home('.gemini'),
  kiro: home('.kiro'),
  cursor: appData('Cursor'),
  antigravity: appData('Antigravity'),
  copilot: appData('Code'),
  cline: home('.cline'),
  amp: home('.amp'),
  roo: appData('Roo-Code'),
  openclaw: home('.openclaw'),
  continue: home('.continue'),
  aider: home('.aider.conf.yml'),
  zed: zedData(),
  qwen: home('.qwen'),
  kimi: home('.kimi'),
  amazonq: home('.aws', 'amazonq'),
  crush: localData('crush'),
  windsurf: home('.codeium', 'windsurf'),
};

async function scanAdapter(id: AdapterId, opts: ScanOptions): Promise<AdapterScan> {
  const scan: AdapterScan = { adapter: id, root: ROOTS[id], present: false, findings: [], dbReport: undefined, notes: [] };
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
  const adapters = await Promise.all(ADAPTER_IDS.map((id) => scanAdapter(id, opts)));
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
