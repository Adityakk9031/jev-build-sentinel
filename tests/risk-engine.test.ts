import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyPolicy, isHighRiskChange, DEFAULT_POLICY } from '../src/risk-engine.js';
import type { AnalysisFeatures, JevDecision } from '../src/types.js';

const safeFeatures: AnalysisFeatures = {
  linesChanged: 10,
  filesChanged: 1,
  sourceFileCount: 1,
  testFileCount: 0,
  dependencyCount: 0,
  hasDatabaseMigration: false,
  hasPackageChange: false,
  hasCIChange: false,
  hasDockerChange: false,
  hasAuthRelatedPath: false,
  hasPaymentRelatedPath: false,
  hasConfigChange: false,
  hasCoreLibraryChange: false,
  docsOnly: false,
  testOnly: false,
};

const feat = (over: Partial<AnalysisFeatures>): AnalysisFeatures => ({ ...safeFeatures, ...over });

const jev = (over: Partial<JevDecision>): JevDecision => ({
  decision: 'TARGETED',
  risk_score: 0.3,
  confidence: 0.95,
  selected_tests: ['tests/a.test.ts'],
  reason: 'ok',
  ...over,
});

describe('policy rule: Jev verdict respected when safe', () => {
  test('TARGETED passes through with selected tests', () => {
    const d = applyPolicy(jev({}), safeFeatures, ['tests/a.test.ts']);
    assert.equal(d.decision, 'TARGETED');
    assert.deepEqual(d.selected_tests, ['tests/a.test.ts']);
    assert.equal(d.fallbackUsed, false);
  });

  test('FULL passes through', () => {
    const d = applyPolicy(jev({ decision: 'FULL' }), safeFeatures, []);
    assert.equal(d.decision, 'FULL');
  });

  test('SKIP passes through on docs-only change', () => {
    const d = applyPolicy(jev({ decision: 'SKIP', selected_tests: [] }), feat({ docsOnly: true }), []);
    assert.equal(d.decision, 'SKIP');
  });
});

describe('policy rule 1: low confidence forces FULL', () => {
  test('confidence below threshold escalates', () => {
    const d = applyPolicy(jev({ confidence: 0.5, decision: 'TARGETED' }), safeFeatures, ['tests/a.test.ts']);
    assert.equal(d.decision, 'FULL');
    assert.equal(d.fallbackUsed, true);
    assert.match(d.reason, /below threshold/);
    assert.equal(d.selected_tests.length, 0);
  });

  test('confidence exactly at threshold is accepted', () => {
    const d = applyPolicy(jev({ confidence: DEFAULT_POLICY.confidenceThreshold }), safeFeatures, ['tests/a.test.ts']);
    assert.equal(d.decision, 'TARGETED');
  });

  test('custom threshold is honored', () => {
    const d = applyPolicy(
      jev({ confidence: 0.8 }),
      safeFeatures,
      ['tests/a.test.ts'],
      { confidenceThreshold: 0.9 },
    );
    assert.equal(d.decision, 'FULL');
  });

  test('low confidence SKIP still escalates to FULL (never fewer tests when uncertain)', () => {
    const d = applyPolicy(jev({ confidence: 0.2, decision: 'SKIP', selected_tests: [] }), safeFeatures, []);
    assert.equal(d.decision, 'FULL');
  });
});

describe('policy rule 5: high-risk changes force FULL', () => {
  const cases: Array<[string, Partial<AnalysisFeatures>]> = [
    ['database migration', { hasDatabaseMigration: true }],
    ['package lock change', { hasPackageChange: true, dependencyCount: 2 }],
    ['CI configuration', { hasCIChange: true }],
    ['Docker infrastructure', { hasDockerChange: true }],
    ['authentication', { hasAuthRelatedPath: true }],
    ['core shared library', { hasCoreLibraryChange: true }],
  ];
  for (const [label, over] of cases) {
    test(label, () => {
      const d = applyPolicy(jev({ decision: 'SKIP', confidence: 1, selected_tests: [] }), feat(over), []);
      assert.equal(d.decision, 'FULL', `expected FULL for ${label}`);
      assert.equal(d.fallbackUsed, true);
    });
  }

  test('payment-related path alone does NOT force FULL (handled by Jev risk)', () => {
    const d = applyPolicy(jev({}), feat({ hasPaymentRelatedPath: true }), ['tests/payment.test.ts']);
    assert.equal(d.decision, 'TARGETED');
  });

  test('isHighRiskChange enumerates all triggers', () => {
    const t = isHighRiskChange(
      feat({ hasDatabaseMigration: true, hasCIChange: true, hasDockerChange: true }),
    );
    assert.equal(t.length, 3);
  });
});

describe('policy rule 6: never empty TARGETED', () => {
  test('empty Jev selection falls back to local candidates', () => {
    const d = applyPolicy(jev({ selected_tests: [] }), safeFeatures, ['tests/local.test.ts']);
    assert.equal(d.decision, 'TARGETED');
    assert.deepEqual(d.selected_tests, ['tests/local.test.ts']);
    assert.equal(d.fallbackUsed, true);
    assert.match(d.policyTriggers.join('; '), /local candidates/);
  });

  test('empty selection with no candidates becomes FULL', () => {
    const d = applyPolicy(jev({ selected_tests: [] }), safeFeatures, []);
    assert.equal(d.decision, 'FULL');
    assert.equal(d.fallbackUsed, true);
  });
});

describe('policy interaction cases', () => {
  test('high-risk + high confidence still FULL', () => {
    const d = applyPolicy(
      jev({ decision: 'SKIP', confidence: 1, selected_tests: [] }),
      feat({ hasDatabaseMigration: true }),
      [],
    );
    assert.equal(d.decision, 'FULL');
    assert.match(d.reason, /database migration/);
  });

  test('high-risk overrides can be disabled via config', () => {
    const d = applyPolicy(
      jev({ decision: 'TARGETED', confidence: 0.99 }),
      feat({ hasDatabaseMigration: true }),
      ['tests/a.test.ts'],
      { alwaysFullOnHighRisk: false },
    );
    assert.equal(d.decision, 'TARGETED');
  });

  test('SKIP with zero-risk docs change and no triggers stays SKIP', () => {
    const d = applyPolicy(jev({ decision: 'SKIP', selected_tests: [], confidence: 0.99 }), feat({ docsOnly: true }), []);
    assert.equal(d.decision, 'SKIP');
    assert.deepEqual(d.selected_tests, []);
  });
});
