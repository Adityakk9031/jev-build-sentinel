/**
 * Shared strongly-typed interfaces for Jev Build Sentinel.
 *
 * The pipeline is:
 *   PR -> Git diff -> Structured change set -> Features -> Jev -> Decision
 */

/** Change type for a single file in the diff. */
export type ChangeType = 'added' | 'deleted' | 'modified' | 'renamed' | 'changed';

/** A single changed file extracted from the git diff. */
export interface ChangedFile {
  /** Path relative to repository root (post-change path for renames). */
  path: string;
  /** Previous path for renamed files, otherwise undefined. */
  previousPath?: string;
  changeType: ChangeType;
  extension: string;
  /** Directory containing the file, '' for repository root. */
  directory: string;
  addedLines: number;
  deletedLines: number;
  /** Lines that were both deleted and re-added on the same file (approximation of modified lines). */
  modifiedLines: number;
  /** Approximate total lines changed: added + deleted + modified. */
  linesChanged: number;
}

/** The structured change set for the whole pull request. */
export interface ChangeSet {
  baseSha: string;
  headSha: string;
  files: ChangedFile[];
  totalAddedLines: number;
  totalDeletedLines: number;
  totalLinesChanged: number;
}

/** Deterministic features extracted from a change set (no decision is made here). */
export interface AnalysisFeatures {
  linesChanged: number;
  filesChanged: number;
  sourceFileCount: number;
  testFileCount: number;
  dependencyCount: number;
  hasDatabaseMigration: boolean;
  hasPackageChange: boolean;
  hasCIChange: boolean;
  hasDockerChange: boolean;
  hasAuthRelatedPath: boolean;
  hasPaymentRelatedPath: boolean;
  hasConfigChange: boolean;
  hasCoreLibraryChange: boolean;
  docsOnly: boolean;
  testOnly: boolean;
}

/** Why a candidate test was mapped to a changed source file. */
export type TestRelationReason =
  | 'direct_test_match'
  | 'import_graph'
  | 'directory_proximity'
  | 'naming_convention'
  | 'historical_cochange';

/** One candidate test mapped from one changed source file. */
export interface CandidateTest {
  test: string;
  source: string;
  reason: TestRelationReason;
  /** 0..1 */
  confidence: number;
}

/** The structured request sent to the Jev inference API. */
export interface BuildSentinelRequest {
  repository: string;
  baseSha: string;
  headSha: string;
  changedFiles: Array<Pick<ChangedFile, 'path' | 'changeType' | 'extension' | 'directory' | 'linesChanged'>>;
  features: AnalysisFeatures;
  candidateTests: Array<Pick<CandidateTest, 'test' | 'reason' | 'confidence'>>;
  historicalMetadata?: {
    totalRecords: number;
    coChanges: Array<{ source: string; tests: string[]; occurrences: number }>;
  };
  testFramework: 'jest' | 'vitest' | 'unknown';
}

/** The decision returned by the Jev inference API. */
export interface JevDecision {
  decision: 'SKIP' | 'TARGETED' | 'FULL';
  risk_score: number;
  confidence: number;
  selected_tests: string[];
  reason: string;
}

/** Final decision after the deterministic safety policy is applied. */
export interface SentinelDecision extends JevDecision {
  /** True when the safety policy overrode the Jev decision or a fallback fired. */
  fallbackUsed: boolean;
  /** Human-readable list of safety rules that fired. */
  policyTriggers: string[];
}

/** Result of executing tests. */
export interface ExecutionResult {
  ran: boolean;
  exitCode: number | null;
  command: string;
  durationMs: number;
  testsExecuted: number | null;
  testsSkipped: number;
  fellBackToFull: boolean;
}
