import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectPackageManager } from '../src/executor.js';

function mkRepo(files: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-exec-'));
  for (const f of files) fs.writeFileSync(path.join(dir, f), '');
  return dir;
}

describe('package manager detection', () => {
  test('pnpm from pnpm-lock.yaml', () => {
    assert.equal(detectPackageManager(mkRepo(['pnpm-lock.yaml'])), 'pnpm');
  });
  test('yarn from yarn.lock', () => {
    assert.equal(detectPackageManager(mkRepo(['yarn.lock'])), 'yarn');
  });
  test('bun from bun.lockb', () => {
    assert.equal(detectPackageManager(mkRepo(['bun.lockb'])), 'bun');
  });
  test('npm by default and from package-lock.json', () => {
    assert.equal(detectPackageManager(mkRepo([])), 'npm');
    assert.equal(detectPackageManager(mkRepo(['package-lock.json'])), 'npm');
  });
});
