import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runPipeline } from '../src/pipeline.js';
import type { BuildSentinelRequest, ChangeSet, JevDecision } from '../src/types.js';

function mkRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-pipe-'));
  const write = (rel: string, content: string) => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  write('package.json', JSON.stringify({ devDependencies: { jest: '^29' } }));
  write('src/payment/stripe.ts', 'export const charge = () => 1;\n');
  write('tests/payment/stripe.test.ts', 'import { charge } from "../../src/payment/stripe";\n');
  return dir;
}

const changeSet: ChangeSet = {
  baseSha: 'a',
  headSha: 'b',
  files: [
    {
      path: 'src/payment/stripe.ts',
      changeType: 'modified',
      extension: 'ts',
      directory: 'src/payment',
      addedLines: 2,
      deletedLines: 1,
      modifiedLines: 0,
      linesChanged: 3,
    },
  ],
  totalAddedLines: 2,
  totalDeletedLines: 1,
  totalLinesChanged: 3,
};

function stubJev(response: JevDecision, captured: BuildSentinelRequest[] = []) {
  return {
    decideOrFull: async (req: BuildSentinelRequest) => {
      captured.push(req);
      return { decision: response, degraded: false };
    },
  };
}

describe('pipeline', () => {
  test('maps candidates and passes them to Jev', async () => {
    const captured: BuildSentinelRequest[] = [];
    const repoDir = mkRepo();
    const result = await runPipeline({
      jev: stubJev(
        { decision: 'TARGETED', risk_score: 0.3, confidence: 0.9, selected_tests: ['tests/payment/stripe.test.ts'], reason: 'ok' },
        captured,
      ),
      changeSet,
      repoDir,
    });
    assert.equal(result.decision.decision, 'TARGETED');
    assert.ok(result.candidateTests.includes('tests/payment/stripe.test.ts'));
    const req = captured[0]!;
    assert.equal(req.testFramework, 'jest');
    assert.ok(req.candidateTests.some((c) => c.test === 'tests/payment/stripe.test.ts' && c.confidence >= 0.9));
    assert.equal(req.features.sourceFileCount, 1);
  });

  test('Jev failure degrades to FULL', async () => {
    const repoDir = mkRepo();
    const result = await runPipeline({
      jev: {
        decideOrFull: async () => ({
          decision: {
            decision: 'FULL' as const,
            risk_score: 1,
            confidence: 0,
            selected_tests: [],
            reason: 'Jev API unavailable - fallback to FULL (boom)',
          },
          degraded: true,
        }),
      },
      changeSet,
      repoDir,
    });
    assert.equal(result.decision.decision, 'FULL');
    assert.equal(result.degraded, true);
  });

  test('migration change forces FULL regardless of Jev', async () => {
    const repoDir = mkRepo();
    const migrationChangeSet: ChangeSet = {
      ...changeSet,
      files: [
        {
          path: 'db/migrations/004_add_refunds.sql',
          changeType: 'added',
          extension: 'sql',
          directory: 'db/migrations',
          addedLines: 5,
          deletedLines: 0,
          modifiedLines: 0,
          linesChanged: 5,
        },
      ],
    };
    const result = await runPipeline({
      jev: stubJev({ decision: 'SKIP', risk_score: 0.01, confidence: 1, selected_tests: [], reason: 'trivial' }),
      changeSet: migrationChangeSet,
      repoDir,
    });
    assert.equal(result.decision.decision, 'FULL');
    assert.equal(result.decision.fallbackUsed, true);
    assert.match(result.decision.reason, /migration/);
  });

  test('historical co-changes are merged into candidates and request', async () => {
    const captured: BuildSentinelRequest[] = [];
    const repoDir = mkRepo();
    const result = await runPipeline({
      jev: stubJev(
        { decision: 'TARGETED', risk_score: 0.2, confidence: 0.9, selected_tests: ['tests/e2e/refund.spec.ts'], reason: 'history' },
        captured,
      ),
      changeSet,
      repoDir,
      historicalCoChanges: new Map([['src/payment/stripe.ts', ['tests/e2e/refund.spec.ts']]]),
      historicalRecordCount: 1,
    });
    assert.ok(result.candidateTests.includes('tests/e2e/refund.spec.ts'));
    const req = captured[0]!;
    assert.ok(req.historicalMetadata?.coChanges.some((c) => c.source === 'src/payment/stripe.ts'));
    assert.ok(req.candidateTests.some((c) => c.reason === 'historical_cochange'));
  });
});
