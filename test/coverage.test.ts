import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { makeTempHome, runCli, type TempHome } from './helpers.js';

const DAY = 86_400_000;
let home: TempHome;

/** mirrors zedData() in src/adapters/files.ts for the host platform */
function zedRoot(root: string): string {
  if (process.platform === 'win32') return path.join(root, 'AppData', 'Local', 'Zed');
  return path.join(root, 'data', process.platform === 'darwin' ? 'Zed' : 'zed');
}

function oldFile(p: string, bytes = 200): void {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, 'x'.repeat(bytes));
  const old = new Date(Date.now() - 40 * DAY);
  utimesSync(p, old, old);
  let d = path.dirname(p);
  while (d !== home.root && d !== path.dirname(d)) {
    utimesSync(d, old, old);
    d = path.dirname(d);
  }
}

function freshFile(p: string, bytes = 200): void {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, 'x'.repeat(bytes));
}

before(() => {
  home = makeTempHome();
  const root = home.root;
  // zed: old log, runaway fresh log, fresh small log, old embeddings, live DB, precious config
  oldFile(path.join(zedRoot(root), 'logs', 'server-setup-5.log'));
  freshFile(path.join(zedRoot(root), 'logs', 'runaway.log'), 52_428_801);
  freshFile(path.join(zedRoot(root), 'logs', 'small.log'));
  oldFile(path.join(zedRoot(root), 'embeddings', 'index.bin'), 400);
  freshFile(path.join(zedRoot(root), 'threads', 'threads.db'));
  freshFile(path.join(root, '.config', 'zed', 'settings.json'), 30);
  // qwen: one old project chat dir + old debug log, fresh project kept, creds present
  oldFile(path.join(root, '.qwen', 'projects', 'projhash', 'chats', 'c1.jsonl'));
  freshFile(path.join(root, '.qwen', 'projects', 'projhash2', 'chats', 'c2.jsonl'));
  oldFile(path.join(root, '.qwen', 'debug', 's1.txt'));
  freshFile(path.join(root, '.qwen', 'oauth_creds.json'), 20);
  // kimi: old session bundle, credentials present
  oldFile(path.join(root, '.kimi', 'sessions', 'abc123', 'sess-1', 'wire.jsonl'));
  freshFile(path.join(root, '.kimi', 'credentials', 'oauth.json'), 20);
  // amazon-q: old shadow checkouts + precious config
  oldFile(path.join(root, '.aws', 'amazonq', 'cli-checkouts', 'myrepo', 'HEAD'), 100);
  freshFile(path.join(root, '.aws', 'amazonq', 'mcp.json'), 20);
  // crush: old cache entry
  oldFile(path.join(home.root, 'AppData', 'Local', 'crush', process.platform === 'win32' ? 'cache' : '', 'old-entry'), 150);
  // windsurf: one old cascade bundle
  oldFile(path.join(root, '.codeium', 'windsurf', 'cascade', 'conv-old', 'history.json'));
  freshFile(path.join(root, '.codeium', 'windsurf', 'mcp_config.json'), 20);
});

after(() => {
  home.cleanup();
});

interface Out {
  adapters: Array<{ adapter: string; root: string; present: boolean; findings: Array<{ kind: string; path: string; category: string; description: string; bytes: number }> }>;
}

function scan(adapter: string): Out['adapters'][number] {
  const res = runCli(home.root, ['scan', '--json', '--target', adapter, '--retention', '30d'], 60_000);
  assert.equal(res.status, 0, `${adapter}: ${res.stderr}`);
  const a = (JSON.parse(res.stdout) as Out).adapters.find((x) => x.adapter === adapter);
  assert.ok(a, `${adapter} missing from output`);
  return a!;
}

test('zed: old logs and runaway logs trashed, live DB and settings report-only', () => {
  const f = scan('zed').findings;
  const trash = f.filter((x) => x.category === 'trash').map((x) => x.path);
  assert.ok(trash.some((p) => p.endsWith('server-setup-5.log')), 'old zed log trashed');
  assert.ok(trash.some((p) => p.endsWith('runaway.log')), 'fresh-but-50MB log trashed regardless of age');
  assert.ok(!trash.some((p) => p.endsWith('small.log')), 'fresh small log kept');
  assert.ok(trash.some((p) => p.includes('embeddings')), 'stale embeddings trashed');
  assert.ok(f.some((x) => x.path.endsWith('threads.db') && x.category === 'report-only'), 'live DB never queued');
  assert.ok(f.some((x) => x.path.endsWith('zed') && x.category === 'report-only'), 'zed config dir precious');
});

test('qwen: old project chats and debug logs trashed, creds kept', () => {
  const f = scan('qwen').findings;
  assert.ok(f.some((x) => x.path.endsWith('projhash') && x.category === 'trash'), 'old project chat dir flagged');
  assert.ok(!f.some((x) => x.path.endsWith('projhash2')), 'fresh project chat dir kept');
  assert.ok(f.some((x) => x.path.endsWith('debug') && x.category === 'trash'), 'debug logs flagged');
  assert.ok(f.some((x) => x.path.endsWith('oauth_creds.json') && x.category === 'report-only'), 'creds precious');
});

test('kimi / amazon-q / crush / windsurf: session state flagged, secrets report-only', () => {
  const kimi = scan('kimi').findings;
  assert.ok(kimi.some((x) => x.path.endsWith('abc123') && x.category === 'trash'), 'old kimi session flagged');
  assert.ok(kimi.some((x) => x.path.endsWith('credentials') && x.category === 'report-only'), 'kimi creds precious');
  const q = scan('amazonq').findings;
  assert.ok(q.some((x) => x.path.endsWith('cli-checkouts') && x.category === 'trash'), 'shadow checkouts flagged');
  assert.ok(q.some((x) => x.path.endsWith('mcp.json') && x.category === 'report-only'), 'amazon-q mcp config precious');
  const c = scan('crush').findings;
  assert.ok(c.some((x) => x.category === 'trash'), 'crush cache flagged');
  const w = scan('windsurf').findings;
  assert.ok(w.some((x) => x.path.endsWith('conv-old') && x.category === 'trash'), 'old cascade conversation flagged');
  assert.ok(w.some((x) => x.path.endsWith('mcp_config.json') && x.category === 'report-only'), 'windsurf mcp config precious');
});

test('clean --apply on zed target moves only the old logs', () => {
  const logDir = path.join(zedRoot(home.root), 'logs');
  const contents = readFileSync(path.join(logDir, 'server-setup-5.log'), 'utf8');
  assert.ok(contents.length > 0, 'precondition: old zed log seeded');
  const res = runCli(home.root, ['clean', '--target', 'zed', '--retention', '30d', '--apply']);
  assert.equal(res.status, 0, res.stderr);
  assert.throws(() => readFileSync(path.join(logDir, 'server-setup-5.log')), 'old log moved to trash');
  assert.ok(readFileSync(path.join(logDir, 'small.log'), 'utf8').length > 0, 'fresh log kept');
  assert.ok(existsSync(path.join(zedRoot(home.root), 'threads', 'threads.db')), 'live DB untouched');
});
