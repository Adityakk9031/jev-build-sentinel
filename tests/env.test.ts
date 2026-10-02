import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadEnvFile } from '../src/env.js';

function tmpEnvFile(lines: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-env-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, lines.join('\n'));
  return file;
}

const TEST_KEYS = ['SENTINEL_TEST_PLAIN', 'SENTINEL_TEST_QUOTED', 'SENTINEL_TEST_EXISTING'];

describe('loadEnvFile', () => {
  afterEach(() => {
    for (const key of TEST_KEYS) delete process.env[key];
  });

  test('parses assignments, quotes, and skips comments/blanks', () => {
    process.env['SENTINEL_TEST_EXISTING'] = 'from-process';
    loadEnvFile(
      tmpEnvFile([
        '# a comment',
        '',
        'SENTINEL_TEST_PLAIN=abc=def',
        'SENTINEL_TEST_QUOTED="https://api.typesafe.ai/v1"',
        'SENTINEL_TEST_EXISTING=from-file',
        'NOT A KEY LINE',
        '=orphan',
      ]),
    );
    // Only the first '=' separates key from value.
    assert.equal(process.env['SENTINEL_TEST_PLAIN'], 'abc=def');
    assert.equal(process.env['SENTINEL_TEST_QUOTED'], 'https://api.typesafe.ai/v1');
    // Real environment variables are never shadowed by the file.
    assert.equal(process.env['SENTINEL_TEST_EXISTING'], 'from-process');
  });

  test('single quotes are stripped too', () => {
    loadEnvFile(tmpEnvFile(["SENTINEL_TEST_PLAIN='jev-latest'"]));
    assert.equal(process.env['SENTINEL_TEST_PLAIN'], 'jev-latest');
  });

  test('missing file is not an error', () => {
    assert.doesNotThrow(() => loadEnvFile(path.join(os.tmpdir(), 'does-not-exist.env')));
  });
});
