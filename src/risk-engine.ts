/**
 * Risk engine: Jev is the primary decision engine, wrapped in a deterministic
 * safety policy. The invariant: "When uncertain, run more tests, never fewer."
 */
import type { AnalysisFeatures, JevDecision, SentinelDecision } from './types.js';

export interface RiskPolicyConfig {
  /** Minimum Jev confidence before forcing FULL. */
  confidenceThreshold: number;
  /** Force FULL on high-risk repo changes even when Jev is confident. */
  alwaysFullOnHighRisk: boolean;
}

export const DEFAULT_POLICY: RiskPolicyConfig = {
  confidenceThreshold: 0.7,
  alwaysFullOnHighRisk: true,
};

/** Repository changes that must always trigger FULL regardless of Jev. */
export function isHighRiskChange(features: AnalysisFeatures): string[] {
  const triggers: string[] = [];
  if (features.hasDatabaseMigration) triggers.push('database migration');
  if (features.hasPackageChange && features.dependencyCount > 0) triggers.push('dependency/package lock change');
  if (features.hasCIChange) triggers.push('CI configuration');
  if (features.hasDockerChange) triggers.push('Docker infrastructure');
  if (features.hasAuthRelatedPath) triggers.push('authentication/security infrastructure');
  if (features.hasCoreLibraryChange) triggers.push('core shared library');
  return triggers;
}

/**
 * Apply the safety policy to a Jev decision.
 * Order matters: hard safety rules first, then confidence, then Jev's verdict.
 */
export function applyPolicy(
  jev: JevDecision,
  features: AnalysisFeatures,
  candidateTests: string[],
  config: Partial<RiskPolicyConfig> = {},
): SentinelDecision {
  const cfg = { ...DEFAULT_POLICY, ...config };
  const triggers = cfg.alwaysFullOnHighRisk ? isHighRiskChange(features) : [];
  const policyTriggers: string[] = [];
  let decision = jev.decision;
  let selectedTests = [...jev.selected_tests];
  let fallbackUsed = false;
  let reason = jev.reason;

  // Rule 5: high-risk repository changes always trigger FULL.
  if (triggers.length > 0) {
    decision = 'FULL';
    fallbackUsed = true;
    policyTriggers.push(`high-risk change: ${triggers.join(', ')}`);
    reason = `Safety policy: FULL required due to ${triggers.join(', ')}`;
  }

  // Rule 1: low confidence forces FULL.
  if (jev.confidence < cfg.confidenceThreshold && decision !== 'FULL') {
    decision = 'FULL';
    fallbackUsed = true;
    policyTriggers.push(`confidence ${jev.confidence} below threshold ${cfg.confidenceThreshold}`);
    reason = `Safety policy: Jev confidence ${jev.confidence} below threshold ${cfg.confidenceThreshold}`;
  }

  // Rule 6: never allow an empty selection for TARGETED.
  if (decision === 'TARGETED' && selectedTests.length === 0) {
    if (candidateTests.length > 0) {
      selectedTests = candidateTests;
      policyTriggers.push('empty Jev selection replaced with local candidates');
    } else {
      decision = 'FULL';
      policyTriggers.push('empty Jev selection with no local candidates -> FULL');
    }
    fallbackUsed = true;
    reason = policyTriggers[policyTriggers.length - 1]!;
  }

  // Rule 3/4: TARGETED uses only selected tests; SKIP skips the expensive suite.
  // Both are valid outcomes here; enforcement happens at execution time.

  return {
    decision,
    risk_score: jev.risk_score,
    confidence: jev.confidence,
    selected_tests: decision === 'TARGETED' ? selectedTests : [],
    reason,
    fallbackUsed,
    policyTriggers,
  };
}
