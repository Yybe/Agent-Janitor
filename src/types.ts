export type AdapterId =
  | 'opencode'
  | 'codex'
  | 'claude'
  | 'gemini'
  | 'kiro'
  | 'cursor'
  | 'antigravity'
  | 'copilot'
  | 'cline'
  | 'amp'
  | 'openclaw'
  | 'continue'
  | 'aider'
  | 'roo';

export type FindingCategory = 'trash' | 'report-only';

/** One reclaimable (or noteworthy) item found on disk. */
export interface Finding {
  adapter: AdapterId;
  /** machine-readable kind, e.g. 'session-file', 'log', 'snapshot-dir', 'tmp-junk', 'stale-backup' */
  kind: string;
  /** absolute path to a file or directory */
  path: string;
  description: string;
  bytes: number;
  mtimeMs: number | undefined;
  category: FindingCategory;
  /** false for ephemeral kinds (logs, tmp junk) that `clean` removes regardless of age */
  retentionAware: boolean;
}

export interface EventTypeStat {
  type: string;
  rows: number;
  bytes: number;
}

export type SchemaGateResult =
  | { ok: true; latestMigration: string }
  | { ok: false; reason: string };

export interface DbReport {
  path: string;
  fileBytes: number;
  pageCount: number;
  pageSize: number;
  freelistPages: number;
  freelistBytes: number;
  eventTypes: EventTypeStat[];
  totalEventRows: number;
  totalEventBytes: number;
  /** older event snapshots superseded by a newer snapshot of the same entity */
  supersededRows: number;
  supersededBytes: number;
  /** byte-identical duplicate payloads (verified exactly, payloads > 1 MB) */
  dupeRows: number;
  dupeBytes: number;
  sessions: { total: number; oldestMs: number; newestMs: number };
  staleSessions: {
    count: number;
    estimatedBytes: number;
    totalCost: number;
    tokensInput: number;
    tokensOutput: number;
    tokensCacheRead: number;
  };
  /** approximate bytes the DB file could shrink by after deletes + VACUUM */
  vacuumEstimateBytes: number;
  schemaGate: SchemaGateResult;
}

export interface AdapterScan {
  adapter: AdapterId;
  present: boolean;
  findings: Finding[];
  dbReport: DbReport | undefined;
  notes: string[];
}

export interface ScanResult {
  scannedAt: string;
  retentionDays: number;
  adapters: AdapterScan[];
  fileReclaimableBytes: number;
  reportOnlyBytes: number;
  dbReclaimableEstimateBytes: number;
}

export interface ScanOptions {
  retentionDays: number;
  /** restrict to one adapter */
  target?: AdapterId | undefined;
}
