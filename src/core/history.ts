import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { home } from '../util.js';

/**
 * Append-only journal of every action that changed something on disk. The trash manifest
 * says where an item went; this says what the tool did and when, which is the question
 * asked after an uninstall impulse ("it did *what* last week?").
 */
export interface HistoryEvent {
  at: string;
  command: string;
  summary: string;
  items?: number;
  bytes?: number;
}

export function historyPath(): string {
  return home('.agent-janitor', 'history.log');
}

/** Never fails an apply run over a log write: the action already happened. */
export async function logAction(ev: HistoryEvent): Promise<void> {
  try {
    await fsp.mkdir(path.dirname(historyPath()), { recursive: true });
    await fsp.appendFile(historyPath(), `${JSON.stringify(ev)}\n`, 'utf8');
  } catch {
    /* best effort */
  }
}

export async function readHistory(limit = 50): Promise<HistoryEvent[]> {
  let raw = '';
  try {
    raw = await fsp.readFile(historyPath(), 'utf8');
  } catch {
    return [];
  }
  const out: HistoryEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as HistoryEvent);
    } catch {
      /* a torn line is not worth failing a read over */
    }
  }
  return out.slice(-limit).reverse(); // newest first
}
