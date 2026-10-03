import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  detectPackageManager,
  detectFramework,
  executeTests,
  shouldExecuteTests,
  MAX_ATTRIBUTION_RUNS,
} from '../src/executor.js';

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

describe('framework detection', () => {
  test('vitest from devDependencies or config file', () => {
    const withDep = mkRepo(['package.json']);
    fs.writeFileSync(
      path.join(withDep, 'package.json'),
      JSON.stringify({ devDependencies: { vitest: '^2.1.0' } }),
    );
    assert.equal(detectFramework(withDep), 'vitest');
    assert.equal(detectFramework(mkRepo(['vitest.config.ts'])), 'vitest');
  });
  test('jest from jest.config.js', () => {
    assert.equal(detectFramework(mkRepo(['jest.config.js'])), 'jest');
  });
  test('unknown when package.json is empty and no config exists', () => {
    assert.equal(detectFramework(mkRepo(['package.json'])), 'unknown');
    assert.equal(detectFramework(mkRepo([])), 'unknown');
  });
  test('vitest repos run vitest, not a jest-named script', async () => {
    const dir = mkRepo(['vitest.config.ts', 'package.json']);
    const commands: string[] = [];
    await executeTests({
      repoDir: dir,
      decision: 'FULL',
      selectedTests: [],
      runner: async (command) => {
        commands.push(command);
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(commands[0], 'npx vitest run');
  });
});

describe('shouldExecuteTests', () => {
  test('mode execute enables execution', () => {
    assert.equal(shouldExecuteTests('execute', false), true);
  });
  test('execute-tests true enables execution regardless of mode', () => {
    assert.equal(shouldExecuteTests('decide', true), true);
    assert.equal(shouldExecuteTests(undefined, true), true);
  });
  test('decide mode with execute-tests false does not execute', () => {
    assert.equal(shouldExecuteTests('decide', false), false);
    assert.equal(shouldExecuteTests(undefined, false), false);
    assert.equal(shouldExecuteTests('typo', false), false);
  });
});

describe('executeTests with an injected runner', () => {
  function repo(): string {
    return mkRepo(['package.json']);
  }

  test('targeted success runs one command and reports no failures', async () => {
    const commands: string[] = [];
    const result = await executeTests({
      repoDir: repo(),
      decision: 'TARGETED',
      selectedTests: ['tests/a.test.ts'],
      runner: async (command) => {
        commands.push(command);
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.fellBackToFull, false);
    assert.deepEqual(result.failedTests, []);
    assert.equal(commands.length, 1);
    assert.match(commands[0]!, /tests\/a\.test\.ts/);
  });

  test('attributes which targeted tests failed before falling back to FULL', async () => {
    const commands: string[] = [];
    const result = await executeTests({
      repoDir: repo(),
      decision: 'TARGETED',
      selectedTests: ['tests/a.test.ts', 'tests/b.test.ts'],
      runner: async (command) => {
        commands.push(command);
        const probes = ['tests/a.test.ts', 'tests/b.test.ts'].filter((t) => command.includes(t));
        if (probes.length === 2) return { code: 1, stdout: '', stderr: '' }; // batch fails
        if (probes.length === 1) return { code: probes[0] === 'tests/b.test.ts' ? 1 : 0, stdout: '', stderr: '' };
        return { code: 0, stdout: '', stderr: '' }; // the FULL fallback run
      },
    });
    assert.equal(result.fellBackToFull, true);
    assert.deepEqual(result.failedTests, ['tests/b.test.ts']);
    // batch + 2 attribution probes + full fallback
    assert.equal(commands.length, 4);
  });

  test('skips attribution for oversized batches (unknown beats wrong)', async () => {
    const selected = Array.from({ length: MAX_ATTRIBUTION_RUNS + 1 }, (_, i) => `tests/t${i}.test.ts`);
    let runs = 0;
    const result = await executeTests({
      repoDir: repo(),
      decision: 'TARGETED',
      selectedTests: selected,
      runner: async () => {
        runs += 1;
        return { code: 1, stdout: '', stderr: '' };
      },
    });
    assert.equal(result.fellBackToFull, true);
    assert.deepEqual(result.failedTests, []);
    assert.equal(runs, 2); // batch + FULL fallback, no per-test probing
  });

  test('FULL runs the normal suite once', async () => {
    const commands: string[] = [];
    const result = await executeTests({
      repoDir: repo(),
      decision: 'FULL',
      selectedTests: [],
      runner: async (command) => {
        commands.push(command);
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.failedTests, []);
    assert.equal(commands.length, 1);
  });

  test('SKIP with no selection does not run anything', async () => {
    let runs = 0;
    const result = await executeTests({
      repoDir: repo(),
      decision: 'TARGETED',
      selectedTests: [],
      runner: async () => {
        runs += 1;
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(result.ran, false);
    assert.equal(runs, 0);
  });
});
