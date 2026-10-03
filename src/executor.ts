import * as fs from 'node:fs';
import * as path from 'node:path';
import * as core from '@actions/core';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { ExecutionResult } from './types.js';

/** Show the last N non-empty lines of command output in the Actions log. */
export function tail(text: string, lines: number): string {
  const cleaned = text
    .split('\n')
    .map((l) => l.replace(/\r/g, ''))
    .filter((l) => l.trim() !== '');
  if (cleaned.length === 0) return '(no output)';
  const shown = cleaned.slice(-lines).join('\n');
  return cleaned.length > lines ? `… (last ${lines} lines of output)\n${shown}` : shown;
}

const execAsync = promisify(exec);

export type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun';
export type Framework = 'jest' | 'vitest' | 'unknown';

/** Detect the package manager from lockfiles (never invents commands). */
export function detectPackageManager(repoDir: string): PackageManager {
  if (fs.existsSync(path.join(repoDir, 'bun.lockb'))) return 'bun';
  if (fs.existsSync(path.join(repoDir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(repoDir, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

const VITEST_CONFIGS = ['vitest.config.ts', 'vitest.config.mts', 'vitest.config.js', 'vitest.config.mjs'];
const JEST_CONFIGS = ['jest.config.ts', 'jest.config.js', 'jest.config.mjs', 'jest.config.cjs'];

/**
 * Detect the test framework from config files and package.json. Never assumes
 * jest: a wrong default produces commands that match no tests (vitest exits
 * "No test files found" and the suite silently doesn't run).
 */
export function detectFramework(repoDir: string): Framework {
  let deps: Record<string, unknown> = {};
  let testScript = '';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoDir, 'package.json'), 'utf8'));
    deps = { ...pkg.dependencies, ...pkg.devDependencies };
    testScript = typeof pkg.scripts?.test === 'string' ? pkg.scripts.test : '';
  } catch {
    // no readable package.json - fall through to config-file checks
  }
  if ('vitest' in deps || VITEST_CONFIGS.some((f) => fs.existsSync(path.join(repoDir, f)))) return 'vitest';
  if ('jest' in deps || JEST_CONFIGS.some((f) => fs.existsSync(path.join(repoDir, f)))) return 'jest';
  if (testScript.includes('vitest')) return 'vitest';
  if (testScript.includes('jest')) return 'jest';
  return 'unknown';
}

function runCommand(pm: PackageManager): string {
  switch (pm) {
    case 'npm':
      return 'npm test --';
    case 'yarn':
      return 'yarn test';
    case 'pnpm':
      return 'pnpm test --';
    case 'bun':
      return 'bun test';
  }
}

/** Resolves the two overlapping execution inputs: `mode` and `execute-tests`. */
export function shouldExecuteTests(mode: string | undefined, executeTests: boolean): boolean {
  return executeTests || mode === 'execute';
}

export type CommandRunner = (
  command: string,
  cwd: string,
  timeoutMs?: number,
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Upper bound on per-test runs used to attribute a failed targeted batch. */
export const MAX_ATTRIBUTION_RUNS = 12;

/**
 * Execute tests according to the decision.
 * - TARGETED: run only selected tests; if that fails because tests cannot run
 *   independently (nonzero exit with runner errors), fall back to FULL.
 * - FULL: run the repository's normal test command.
 */
export async function executeTests(opts: {
  repoDir: string;
  decision: 'SKIP' | 'TARGETED' | 'FULL';
  selectedTests: string[];
  framework?: 'jest' | 'vitest' | 'unknown';
  timeoutMs?: number;
  /** Injectable runner for tests. Defaults to spawning a shell command. */
  runner?: CommandRunner;
  /** Injectable logger; defaults to the GitHub Actions logger. */
  logger?: (msg: string) => void;
}): Promise<ExecutionResult> {
  const repoDir = opts.repoDir;
  const run = opts.runner ?? runShell;
  const log = opts.logger ?? ((msg: string) => core.info(msg));
  const seconds = (t0: number) => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
  const pm = detectPackageManager(repoDir);
  const framework: Framework = opts.framework ?? detectFramework(repoDir);
  const start = Date.now();

  // vitest/jest accept test file paths as positional filters; the generic
  // npm-script fallback forwards them after `--` (npm ≥7 forwards bare args too).
  const baseCmd =
    framework === 'vitest' ? 'npx vitest run' : framework === 'jest' ? 'npx jest' : runCommand(pm);

  const fullCommand = baseCmd.trim();

  if (opts.decision === 'FULL') {
    log(`▶ Executing FULL verification (all tests): ${fullCommand}`);
    const res = await run(fullCommand, repoDir, opts.timeoutMs);
    log(`▶ FULL verification finished: exit ${res.code} in ${seconds(start)}`);
    log(tail(res.code === 0 ? res.stdout : `${res.stdout}\n${res.stderr}`, 30));
    return {
      ran: true,
      exitCode: res.code,
      command: fullCommand,
      durationMs: Date.now() - start,
      testsExecuted: null,
      testsSkipped: 0,
      fellBackToFull: false,
      failedTests: [],
    };
  }

  // TARGETED: pass test paths positionally; both jest and vitest accept file filters.
  if (opts.selectedTests.length === 0) {
    // Nothing to run: treat as safe skip of the expensive suite.
    return {
      ran: false,
      exitCode: 0,
      command: '(no tests selected)',
      durationMs: 0,
      testsExecuted: 0,
      testsSkipped: 0,
      fellBackToFull: false,
      failedTests: [],
    };
  }

  const targetedCommand = `${baseCmd} ${opts.selectedTests.map(quote).join(' ')}`.trim();
  log(
    `▶ Executing TARGETED verification (${opts.selectedTests.length} test files): ${targetedCommand}`,
  );
  const targeted = await run(targetedCommand, repoDir, opts.timeoutMs);
  log(`▶ TARGETED verification finished: exit ${targeted.code} in ${seconds(start)}`);
  if (targeted.code !== 0) {
    log(tail(`${targeted.stdout}\n${targeted.stderr}`, 40));
  } else {
    log(tail(targeted.stdout, 15));
  }

  if (targeted.code === 0) {
    return {
      ran: true,
      exitCode: 0,
      command: targetedCommand,
      durationMs: Date.now() - start,
      testsExecuted: opts.selectedTests.length,
      testsSkipped: 0,
      fellBackToFull: false,
      failedTests: [],
    };
  }

  // Targeted execution failed. Attribute the failure to specific tests (bounded,
  // best-effort) so historical learning knows what actually broke, then fall
  // back to FULL - the safety principle still wins over the diagnostic pass.
  log('▶ Targeted run failed - attributing failures by re-running selected tests individually.');
  const failedTests = await attributeFailures(log, run, baseCmd, opts.selectedTests, repoDir, opts.timeoutMs);
  log(`▶ Falling back to FULL suite: ${fullCommand}`);
  const fullRes = await run(fullCommand, repoDir, opts.timeoutMs);
  log(`▶ FULL fallback finished: exit ${fullRes.code} in ${seconds(start)}`);
  if (fullRes.code !== 0) {
    log(tail(`${fullRes.stdout}\n${fullRes.stderr}`, 40));
  }
  return {
    ran: true,
    exitCode: fullRes.code,
    command: fullCommand,
    durationMs: Date.now() - start,
    testsExecuted: null,
    testsSkipped: 0,
    fellBackToFull: true,
    failedTests,
  };
}

/**
 * Re-run the selected tests one at a time to learn which of them failed.
 * Returns [] when the batch is too large to probe (or nothing can be attributed),
 * which callers treat as "unknown" and fall back to the coarse heuristic.
 */
async function attributeFailures(
  log: (msg: string) => void,
  run: CommandRunner,
  baseCmd: string,
  selectedTests: string[],
  repoDir: string,
  timeoutMs?: number,
): Promise<string[]> {
  if (selectedTests.length > MAX_ATTRIBUTION_RUNS) return [];
  const failed: string[] = [];
  for (const test of selectedTests) {
    try {
      const res = await run(`${baseCmd} ${quote(test)}`.trim(), repoDir, timeoutMs);
      log(`  ↳ ${test}: exit ${res.code}`);
      if (res.code !== 0) failed.push(test);
    } catch {
      return []; // attribution is best-effort; unknown beats wrong
    }
  }
  return failed;
}

function quote(p: string): string {
  return /^[a-zA-Z0-9_\-./]+$/.test(p) ? p : `"${p.replace(/"/g, '')}"`;
}

async function runShell(
  command: string,
  cwd: string,
  timeoutMs?: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: timeoutMs ?? 20 * 60 * 1000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, CI: 'true' },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}
