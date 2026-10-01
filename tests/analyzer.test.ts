import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildChangeSet } from '../src/diff.js';
import { extractFeatures } from '../src/analyzer.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const load = (name: string): string => fs.readFileSync(path.join(fixturesDir, name), 'utf8');
const featuresOf = (name: string) => extractFeatures(buildChangeSet(load(name), 'b', 'h'));

describe('extractFeatures: README-only change', () => {
  const f = featuresOf('readme-only.diff');
  test('is docsOnly with zero source files', () => {
    assert.equal(f.docsOnly, true);
    assert.equal(f.sourceFileCount, 0);
    assert.equal(f.testFileCount, 0);
    assert.equal(f.filesChanged, 1);
  });
});

describe('extractFeatures: TypeScript source change', () => {
  const f = featuresOf('ts-source.diff');
  test('counts one source file, payment path detected', () => {
    assert.equal(f.sourceFileCount, 1);
    assert.equal(f.hasPaymentRelatedPath, true);
    assert.equal(f.docsOnly, false);
    assert.ok(f.linesChanged > 0);
  });
});

describe('extractFeatures: database migration', () => {
  const f = featuresOf('db-migration.diff');
  test('flags hasDatabaseMigration', () => {
    assert.equal(f.hasDatabaseMigration, true);
    assert.equal(f.hasPackageChange, false);
  });
});

describe('extractFeatures: package change', () => {
  const f = featuresOf('package-change.diff');
  test('flags hasPackageChange and counts dependencies', () => {
    assert.equal(f.hasPackageChange, true);
    assert.ok(f.dependencyCount >= 1);
    assert.equal(f.hasDatabaseMigration, false);
  });
});

describe('extractFeatures: multiple directories', () => {
  const f = featuresOf('multi-directory.diff');
  test('counts source and test files separately', () => {
    assert.equal(f.sourceFileCount, 2);
    assert.equal(f.testFileCount, 1);
    assert.equal(f.filesChanged, 3);
    assert.equal(f.testOnly, false);
    assert.equal(f.docsOnly, false);
  });
});

describe('extractFeatures: synthetic edge cases', () => {
  const mk = (paths: string[]) =>
    buildChangeSet(
      paths
        .map((p) =>
          [
            `diff --git a/${p} b/${p}`,
            'index 111..222 100644',
            `--- a/${p}`,
            `+++ b/${p}`,
            '@@ -1,1 +1,2 @@',
            ' old',
            '+new',
          ].join('\n'),
        )
        .join('\n'),
      'b',
      'h',
    );

  test('CI change detected', () => {
    const f = extractFeatures(mk(['.github/workflows/ci.yml']));
    assert.equal(f.hasCIChange, true);
    assert.equal(f.hasConfigChange, true);
  });

  test('Docker change detected', () => {
    const f = extractFeatures(mk(['Dockerfile', 'docker-compose.yml']));
    assert.equal(f.hasDockerChange, true);
  });

  test('auth path detected', () => {
    const f = extractFeatures(mk(['src/auth/session.ts']));
    assert.equal(f.hasAuthRelatedPath, true);
  });

  test('core library path detected', () => {
    const f = extractFeatures(mk(['src/shared/http.ts']));
    assert.equal(f.hasCoreLibraryChange, true);
  });

  test('testOnly for pure test change', () => {
    const f = extractFeatures(mk(['tests/a.test.ts', 'src/__tests__/b.ts']));
    assert.equal(f.testOnly, true);
    assert.equal(f.testFileCount, 2);
  });

  test('config change via extension', () => {
    const f = extractFeatures(mk(['config/settings.yaml']));
    assert.equal(f.hasConfigChange, true);
  });

  test('empty change set is not docsOnly', () => {
    const f = extractFeatures(buildChangeSet('', 'b', 'h'));
    assert.equal(f.docsOnly, false);
    assert.equal(f.testOnly, false);
    assert.equal(f.filesChanged, 0);
  });
});
