import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadHistory,
  saveHistory,
  rememberOutcome,
  getCoTests,
  coChangeMap,
  type History,
} from '../src/history.js';

describe('history learning', () => {
  test('empty history when file missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-hist-'));
    const h = loadHistory(path.join(dir, 'nope.json'));
    assert.deepEqual(h.records, {});
  });

  test('rememberOutcome records selections and failures', () => {
    const h: History = { records: {} };
    rememberOutcome(
      h,
      ['src/payment/stripe.ts'],
      ['stripe.test.ts', 'checkout.test.ts'],
      { exitCode: 0, fellBackToFull: false },
      ['checkout.test.ts'],
    );
    const recs = h.records['src/payment/stripe.ts']!;
    assert.equal(recs.length, 2);
    const checkout = recs.find((r) => r.test === 'checkout.test.ts')!;
    assert.equal(checkout.failures, 1);
    assert.equal(checkout.selections, 1);
  });

  test('failed tests rank first and are returned by getCoTests', () => {
    const h: History = { records: {} };
    rememberOutcome(h, ['src/a.ts'], ['t1.test.ts', 't2.test.ts'], { exitCode: 0, fellBackToFull: false }, ['t2.test.ts']);
    rememberOutcome(h, ['src/a.ts'], ['t1.test.ts', 't2.test.ts'], { exitCode: 0, fellBackToFull: false }, ['t2.test.ts']);
    const co = getCoTests(h, 'src/a.ts');
    assert.equal(co[0], 't2.test.ts');
    assert.ok(co.includes('t1.test.ts'));
  });

  test('one-time selections without failures are not returned', () => {
    const h: History = { records: {} };
    rememberOutcome(h, ['src/b.ts'], ['t9.test.ts'], { exitCode: 0, fellBackToFull: false });
    assert.deepEqual(getCoTests(h, 'src/b.ts'), []);
  });

  test('save/load round-trips', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-hist-'));
    const file = path.join(dir, 'history.json');
    const h: History = { records: {} };
    rememberOutcome(h, ['src/c.ts'], ['t.test.ts'], { exitCode: 1, fellBackToFull: true }, [], '2026-01-01');
    saveHistory(file, h);
    const loaded = loadHistory(file);
    assert.equal(loaded.records['src/c.ts']![0]!.failures, 1);
  });

  test('bucket is capped at 20 tests per source', () => {
    const h: History = { records: {} };
    const tests = Array.from({ length: 30 }, (_, i) => `t${i}.test.ts`);
    rememberOutcome(h, ['src/d.ts'], tests, { exitCode: 0, fellBackToFull: false });
    assert.equal(h.records['src/d.ts']!.length, 20);
  });

  test('attributed failures override the coarse fallback heuristic', () => {
    const h: History = { records: {} };
    rememberOutcome(
      h,
      ['src/e.ts'],
      ['keep.test.ts', 'break.test.ts'],
      { exitCode: 1, fellBackToFull: true },
      ['break.test.ts'],
    );
    const bucket = h.records['src/e.ts']!;
    assert.equal(bucket.find((r) => r.test === 'break.test.ts')!.failures, 1);
    assert.equal(bucket.find((r) => r.test === 'keep.test.ts')!.failures, 0);
  });

  test('without attribution the fallback heuristic still marks everything failed', () => {
    const h: History = { records: {} };
    rememberOutcome(h, ['src/f.ts'], ['one.test.ts', 'two.test.ts'], { exitCode: 1, fellBackToFull: true });
    for (const rec of h.records['src/f.ts']!) assert.equal(rec.failures, 1);
  });

  test('coChangeMap ranks qualifying sources and skips one-off observations', () => {
    const h: History = { records: {} };
    // Qualifies: selected twice and one failure.
    rememberOutcome(h, ['src/g.ts'], ['flaky.test.ts', 'solid.test.ts'], { exitCode: 0, fellBackToFull: false });
    rememberOutcome(h, ['src/g.ts'], ['flaky.test.ts', 'solid.test.ts'], { exitCode: 1, fellBackToFull: true }, ['flaky.test.ts']);
    // One clean observation: not yet a standing candidate.
    rememberOutcome(h, ['src/lonely.ts'], ['once.test.ts'], { exitCode: 0, fellBackToFull: false });

    const map = coChangeMap(h);
    assert.deepEqual(map.get('src/g.ts'), ['flaky.test.ts', 'solid.test.ts']);
    assert.equal(map.has('src/lonely.ts'), false);
  });
});
