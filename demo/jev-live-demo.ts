/**
 * Live smoke test against the TypeSafe Jev API (requires .env with JEV_API_KEY).
 *
 *   npx tsx demo/jev-live-demo.ts
 *
 * Sends one synthetic change set through the real evaluation endpoint and prints
 * the mapped decision. Offline demo stays in offline-demo.ts.
 */
import { loadEnvFile } from '../src/env.js';
import { DEFAULT_ENDPOINT, DEFAULT_MODEL, JevClient } from '../src/jev-client.js';
import type { BuildSentinelRequest } from '../src/types.js';

loadEnvFile();

const apiKey = process.env['JEV_API_KEY'];
if (!apiKey) {
  console.error('JEV_API_KEY is not set. Add it to .env (see .env.example).');
  process.exit(1);
}

const request: BuildSentinelRequest = {
  repository: 'acme/widget',
  baseSha: 'a1b2c3d',
  headSha: 'e4f5a6b',
  changedFiles: [
    { path: 'src/payments/refund.ts', changeType: 'modified', extension: 'ts', directory: 'src/payments', linesChanged: 42 },
    { path: 'README.md', changeType: 'modified', extension: 'md', directory: '', linesChanged: 3 },
  ],
  features: {
    linesChanged: 45,
    filesChanged: 2,
    sourceFileCount: 1,
    testFileCount: 0,
    dependencyCount: 0,
    hasDatabaseMigration: false,
    hasPackageChange: false,
    hasCIChange: false,
    hasDockerChange: false,
    hasAuthRelatedPath: false,
    hasPaymentRelatedPath: true,
    hasConfigChange: false,
    hasCoreLibraryChange: false,
    docsOnly: false,
    testOnly: false,
  },
  candidateTests: [
    { test: 'tests/payments/refund.test.ts', source: 'src/payments/refund.ts', reason: 'direct_test_match', confidence: 0.98 },
    { test: 'tests/payments/checkout.test.ts', source: 'src/payments/refund.ts', reason: 'directory_proximity', confidence: 0.62 },
    { test: 'tests/e2e/payment-refund.spec.ts', source: 'historical', reason: 'historical_cochange', confidence: 0.7 },
  ],
  historicalMetadata: {
    totalRecords: 1,
    coChanges: [{ source: 'src/payments/refund.ts', tests: ['tests/e2e/payment-refund.spec.ts'], occurrences: 1 }],
  },
  testFramework: 'jest',
};

const client = new JevClient({
  endpoint: process.env['JEV_ENDPOINT'] || DEFAULT_ENDPOINT,
  apiKey,
  model: process.env['JEV_MODEL'] || DEFAULT_MODEL,
});

const started = Date.now();
const { decision, degraded } = await client.decideOrFull(request);

console.log(`latency: ${Date.now() - started}ms, degraded: ${degraded}`);
console.log(JSON.stringify(decision, null, 2));
process.exit(degraded ? 1 : 0);
