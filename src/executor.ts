import * as fs from 'node:fs';
import * as path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { ExecutionResult } from './types.js';

const execAsync = promisify(exec);

export type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun';

/** Detect the package manager from lockfiles (never invents commands). */
export function detectPackageManager(repoDir: string): PackageManager {
  if (fs.existsSync(path.join(repoDir, 'bun.lockb'))) return 'bun';
  if (fs.existsSync(path.join(repoDir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(repoDir, 'yarn.lock'))) return 'yarn';
  return 'npm';
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

function runScriptName(framework: 'jest' | 'vitest'): string {
  return framework === 'vitest' ? 'vitest run' : 'jest';
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
}): Promise<ExecutionResult> {
  const repoDir = opts.repoDir;
  const run = opts.runner ?? runShell;
  const pm = detectPackageManager(repoDir);
  const framework = opts.framework === 'vitest' ? 'vitest' : 'jest';
  const start = Date.now();

  const baseCmd =
    framework === 'vitest'
      ? `npx vitest run`
      : `${runCommand(pm)} ${runScriptName(framework)}`;

  const fullCommand = baseCmd.trim();

  if (opts.decision === 'FULL') {
    const res = await run(fullCommand, repoDir, opts.timeoutMs);
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
  const targeted = await run(targetedCommand, repoDir, opts.timeoutMs);

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
  const failedTests = await attributeFailures(run, baseCmd, opts.selectedTests, repoDir, opts.timeoutMs);
  const fullRes = await run(fullCommand, repoDir, opts.timeoutMs);
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
      env: { ...process.env, CI: 'true' },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}
