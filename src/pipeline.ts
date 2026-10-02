import type {
  AnalysisFeatures,
  BuildSentinelRequest,
  ChangeSet,
  SentinelDecision,
} from './types.js';
import { extractFeatures } from './analyzer.js';
import {
  createTestMapper,
  detectTestFramework,
  type TestMapper,
} from './test-mapper.js';
import { applyPolicy, DEFAULT_POLICY, type RiskPolicyConfig } from './risk-engine.js';
import type { JevClient } from './jev-client.js';

export interface PipelineDeps {
  jev: Pick<JevClient, 'decideOrFull'>;
  /** Pre-resolved change set (from GitHub API or git). */
  changeSet: ChangeSet;
  /** Repository working directory (for test discovery). May be a synthetic root in tests. */
  repoDir: string;
  /** Optional test mapper override; defaults to framework detection. */
  mapper?: TestMapper;
  policy?: Partial<RiskPolicyConfig>;
  /** Historical co-change records (stage 9). */
  historicalCoChanges?: Map<string, string[]>;
  historicalRecordCount?: number;
}

export interface PipelineResult {
  decision: SentinelDecision;
  features: AnalysisFeatures;
  candidateTests: string[];
  request: BuildSentinelRequest;
  degraded: boolean;
}

/** Run the full Sentinel pipeline and produce the final (policy-applied) decision. */
export async function runPipeline(deps: PipelineDeps): Promise<PipelineResult> {
  const features = extractFeatures(deps.changeSet);

  const mapper = deps.mapper ?? createTestMapper(deps.repoDir);
  const changedSourceFiles = deps.changeSet.files.map((f) => f.path);
  const candidates = mapper.mapTests(changedSourceFiles, deps.repoDir);

  // Stage 9: merge historical co-change tests into the candidate list.
  const historical = new Map<string, number>();
  for (const file of deps.changeSet.files) {
    for (const t of deps.historicalCoChanges?.get(file.path) ?? []) {
      historical.set(t, (historical.get(t) ?? 0) + 1);
    }
  }
  const alreadyCandidate = new Set(candidates.map((c) => c.test));
  for (const [test, occurrences] of historical) {
    if (!alreadyCandidate.has(test)) {
      candidates.push({
        test,
        source: 'historical',
        reason: 'historical_cochange',
        confidence: Math.min(0.5 + 0.1 * occurrences, 0.9),
      });
    }
  }

  const candidateTests = [...new Set(candidates.map((c) => c.test))];
  const framework = mapper?.framework ?? detectTestFramework(deps.repoDir);

  const coChanges = [...(deps.historicalCoChanges?.entries() ?? [])]
    .map(([source, tests]) => ({ source, tests, occurrences: tests.length }))
    .slice(0, 50);

  const request: BuildSentinelRequest = {
    repository: '',
    baseSha: deps.changeSet.baseSha,
    headSha: deps.changeSet.headSha,
    changedFiles: deps.changeSet.files.map((f) => ({
      path: f.path,
      changeType: f.changeType,
      extension: f.extension,
      directory: f.directory,
      linesChanged: f.linesChanged,
    })),
    features,
    candidateTests: candidates.map((c) => ({
      test: c.test,
      source: c.source,
      reason: c.reason,
      confidence: c.confidence,
    })),
    ...(coChanges.length > 0
      ? { historicalMetadata: { totalRecords: deps.historicalRecordCount ?? coChanges.length, coChanges } }
      : {}),
    testFramework: framework,
  };

  const { decision: jevDecision, degraded } = await deps.jev.decideOrFull(request);
  const decision = applyPolicy(
    jevDecision,
    features,
    candidateTests,
    deps.policy ?? DEFAULT_POLICY,
  );

  return { decision, features, candidateTests, request, degraded };
}
