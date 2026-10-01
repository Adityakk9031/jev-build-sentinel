/**
 * Offline end-to-end demo: runs the full Sentinel pipeline against demo-repo
 * with a simulated Jev decision engine (no network required).
 *
 * Usage: npx tsx demo/offline-demo.ts <scenario>
 *   readme | notification | payment | auth | migration
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildChangeSet } from '../src/diff.js';
import { extractFeatures } from '../src/analyzer.js';
import { runPipeline } from '../src/pipeline.js';
import { buildSummary } from '../src/report.js';
import type { BuildSentinelRequest, JevDecision } from '../src/types.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const demoDir = path.join(root, 'demo-repo');
const fixturesDir = path.join(root, 'fixtures', 'demo');

/** Simulated Jev: deterministic risk model standing in for the real inference API. */
function simulatedJev(req: BuildSentinelRequest): JevDecision {
  const f = req.features;
  if (f.docsOnly) {
    return { decision: 'SKIP', risk_score: 0.02, confidence: 0.99, selected_tests: [], reason: 'docs-only change; no verification needed' };
  }
  if (f.linesChanged <= 15 && f.sourceFileCount <= 2 && req.candidateTests.length > 0) {
    return {
      decision: 'TARGETED',
      risk_score: 0.28,
      confidence: 0.97,
      selected_tests: req.candidateTests.slice(0, 5),
      reason: 'small, low-risk change with high-confidence test mapping',
    };
  }
  return {
    decision: 'FULL',
    risk_score: 0.87,
    confidence: 0.94,
    selected_tests: [],
    reason: 'broad or high-risk change; full verification required',
  };
}

const scenarios = ['readme', 'notification', 'payment', 'auth', 'migration'] as const;
const scenario = process.argv[2] ?? 'payment';
if (!scenarios.includes(scenario as (typeof scenarios)[number])) {
  console.error(`Unknown scenario '${scenario}'. Options: ${scenarios.join(', ')}`);
  process.exit(1);
}

const diffText = fs.readFileSync(path.join(fixturesDir, `${scenario}.diff`), 'utf8');
const changeSet = buildChangeSet(diffText, 'base-sha', 'head-sha');

// Historical learning demo: refund e2e is known to co-change with stripe.ts.
const history = new Map<string, string[]>([
  ['src/payments/stripe.ts', ['tests/e2e/payment-refund.spec.ts']],
]);

const result = await runPipeline({
  jev: { decideOrFull: async (req) => ({ decision: simulatedJev(req), degraded: false }) },
  changeSet,
  repoDir: demoDir,
  historicalCoChanges: history,
  historicalRecordCount: 1,
});

console.log(buildSummary(result.decision, changeSet, result.features, result.candidateTests));
console.log('\n--- pipeline trace ---');
console.log(`candidate tests: ${result.candidateTests.join(', ') || '(none)'}`);
console.log(`degraded: ${result.degraded}, fallbackUsed: ${result.decision.fallbackUsed}`);
