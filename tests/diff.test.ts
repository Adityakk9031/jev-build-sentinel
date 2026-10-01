import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseUnifiedDiff, buildChangeSet, toChangedFile } from '../src/diff.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const load = (name: string): string => fs.readFileSync(path.join(fixturesDir, name), 'utf8');

describe('parseUnifiedDiff: README-only change', () => {
  const parsed = parseUnifiedDiff(load('readme-only.diff'));

  test('finds one modified markdown file', () => {
    assert.equal(parsed.files.length, 1);
    assert.equal(parsed.files[0]!.path, 'README.md');
    assert.equal(parsed.files[0]!.changeType, 'modified');
  });

  test('counts added lines from both hunks', () => {
    assert.equal(parsed.files[0]!.addedLines, 2);
    assert.equal(parsed.files[0]!.deletedLines, 0);
  });

  test('change set marks it as docs-only shape (no source files)', () => {
    const cs = buildChangeSet(load('readme-only.diff'), 'base', 'head');
    assert.equal(cs.files.length, 1);
    assert.equal(cs.files[0]!.extension, 'md');
    assert.equal(cs.totalLinesChanged, 2);
  });
});

describe('parseUnifiedDiff: TypeScript source change', () => {
  const cs = buildChangeSet(load('ts-source.diff'), 'base', 'head');

  test('extracts file metadata', () => {
    const f = cs.files[0]!;
    assert.equal(f.path, 'src/payment/stripe.ts');
    assert.equal(f.extension, 'ts');
    assert.equal(f.directory, 'src/payment');
    assert.equal(f.changeType, 'modified');
  });

  test('approximates modified lines: both removed lines re-added with same text', () => {
    // "- return subtotal;" -> "+ const tax..." is NOT a match (1 deleted, 0 modified)
    // "- return api.delete(...)" -> "+ return api.post(...)" is also different text,
    // so modifiedLines counts only lines whose removed text is re-added identically.
    const f = cs.files[0]!;
    assert.ok(f.addedLines > 0);
    assert.ok(f.deletedLines > 0);
    assert.equal(f.modifiedLines, 0);
  });

  test('linesChanged equals added + deleted + modified', () => {
    const f = cs.files[0]!;
    assert.equal(f.linesChanged, f.addedLines + f.deletedLines + f.modifiedLines);
  });
});

describe('parseUnifiedDiff: database migration', () => {
  const cs = buildChangeSet(load('db-migration.diff'), 'base', 'head');

  test('marks new file as added', () => {
    const f = cs.files[0]!;
    assert.equal(f.changeType, 'added');
    assert.equal(f.path, 'db/migrations/004_add_refunds.sql');
    assert.equal(f.extension, 'sql');
    assert.equal(f.directory, 'db/migrations');
    assert.equal(f.addedLines, 5);
    assert.equal(f.deletedLines, 0);
  });
});

describe('parseUnifiedDiff: package.json change', () => {
  const cs = buildChangeSet(load('package-change.diff'), 'base', 'head');

  test('finds both package files', () => {
    assert.deepEqual(
      cs.files.map((f) => f.path).sort(),
      ['package-lock.json', 'package.json'],
    );
  });

  test('counts added dependency line', () => {
    const pkg = cs.files.find((f) => f.path === 'package.json')!;
    assert.equal(pkg.addedLines, 1);
    const lock = cs.files.find((f) => f.path === 'package-lock.json')!;
    assert.ok(lock.addedLines >= 3);
  });
});

describe('parseUnifiedDiff: multiple directories', () => {
  const cs = buildChangeSet(load('multi-directory.diff'), 'base', 'head');

  test('finds files in three directories', () => {
    const dirs = new Set(cs.files.map((f) => f.directory));
    assert.ok(dirs.has('src/notifications'));
    assert.ok(dirs.has('src/utils'));
    assert.ok(dirs.has('tests/auth'));
  });

  test('recognizes a test file by path', () => {
    const f = cs.files.find((x) => x.path.includes('.test.'))!;
    assert.equal(f.path, 'tests/auth/login.test.ts');
  });
});

describe('parseUnifiedDiff: renamed file', () => {
  const cs = buildChangeSet(load('renamed-file.diff'), 'base', 'head');

  test('records previousPath and new path', () => {
    const f = cs.files[0]!;
    assert.equal(f.changeType, 'renamed');
    assert.equal(f.previousPath, 'src/notifications/notify.ts');
    assert.equal(f.path, 'src/notifications/notifier.ts');
  });

  test('counts the content change after rename', () => {
    const f = cs.files[0]!;
    assert.equal(f.addedLines, 3);
  });
});

describe('parseUnifiedDiff: binary file', () => {
  test('yields a file entry with zero line counts', () => {
    const cs = buildChangeSet(load('binary.diff'), 'base', 'head');
    assert.equal(cs.files.length, 1);
    assert.equal(cs.files[0]!.path, 'logo.png');
    assert.equal(cs.files[0]!.linesChanged, 0);
    assert.equal(cs.files[0]!.extension, 'png');
  });
});

describe('toChangedFile: modified-line approximation', () => {
  test('counts removed-then-readded identical lines as modified', () => {
    const diffText = [
      'diff --git a/a.ts b/a.ts',
      'index 111..222 100644',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,3 +1,3 @@',
      ' const x = 1;',
      '-const y = 2;',
      '+const y = 2;',
      '+const z = 3;',
    ].join('\n');
    const parsed = parseUnifiedDiff(diffText);
    const f = toChangedFile(parsed.files[0]!);
    assert.equal(f.modifiedLines, 1);
    assert.equal(f.addedLines, 1);
    assert.equal(f.deletedLines, 0);
    assert.equal(f.linesChanged, 2);
  });
});

describe('buildChangeSet: totals', () => {
  test('sums across files', () => {
    const cs = buildChangeSet(load('multi-directory.diff'), 'abc', 'def');
    assert.equal(cs.baseSha, 'abc');
    assert.equal(cs.headSha, 'def');
    assert.equal(cs.totalLinesChanged, cs.files.reduce((a, f) => a + f.linesChanged, 0));
    assert.equal(cs.totalAddedLines, cs.files.reduce((a, f) => a + f.addedLines, 0));
  });
});
