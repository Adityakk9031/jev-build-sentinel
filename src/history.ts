import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ExecutionResult } from './types.js';

export interface HistoryRecord {
  /** source path -> tests that were selected and/or failed alongside it */
  [source: string]: Array<{ test: string; failures: number; selections: number; lastSeen: string }>;
}

export interface History {
  records: HistoryRecord;
}

const MAX_TESTS_PER_SOURCE = 20;

/** Load the history file; returns an empty history when missing or corrupt. */
export function loadHistory(filePath: string): History {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as History;
    if (parsed && typeof parsed.records === 'object') return { records: parsed.records };
  } catch {
    /* missing or corrupt -> start fresh */
  }
  return { records: {} };
}

/** Persist history to disk (atomic-ish write). */
export function saveHistory(filePath: string, history: History): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(history, null, 2));
}

/**
 * Record an outcome: which tests were selected for which changed sources.
 * Failures are weighted heavier so flaky-but-related tests rank up.
 */
export function rememberOutcome(
  history: History,
  changedSources: string[],
  selectedTests: string[],
  execution: Pick<ExecutionResult, 'exitCode' | 'fellBackToFull'>,
  failedTests: string[] = [],
  now = new Date().toISOString(),
): void {
  for (const source of changedSources) {
    const bucket = (history.records[source] ??= []);
    // Specific attribution beats the coarse "the fallback suite failed" heuristic.
    const attributed = failedTests.length > 0;
    for (const test of selectedTests) {
      const failed = attributed
        ? failedTests.includes(test)
        : execution.exitCode !== 0 && execution.fellBackToFull;
      let entry = bucket.find((b) => b.test === test);
      if (!entry) {
        entry = { test, failures: 0, selections: 0, lastSeen: now };
        bucket.push(entry);
      }
      entry.selections += 1;
      if (failed) entry.failures += 1;
      entry.lastSeen = now;
    }
    // Keep the strongest signals only.
    bucket.sort((a, b) => b.failures - a.failures || b.selections - a.selections);
    history.records[source] = bucket.slice(0, MAX_TESTS_PER_SOURCE);
  }
}

/** Get historical co-changed tests for a source, ranked by failure weight. */
export function getCoTests(history: History, source: string): string[] {
  return (history.records[source] ?? [])
    .filter((r) => r.failures > 0 || r.selections > 1)
    .sort((a, b) => b.failures - a.failures || b.selections - a.selections)
    .map((r) => r.test);
}

/**
 * Ranked co-change candidates for every learned source, ready to merge into the
 * pipeline's candidate set. Sources with only one clean observation are skipped.
 */
export function coChangeMap(history: History): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const source of Object.keys(history.records)) {
    const tests = getCoTests(history, source);
    if (tests.length > 0) map.set(source, tests);
  }
  return map;
}
