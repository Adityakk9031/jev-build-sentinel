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
}): Promise<ExecutionResult> {
  const repoDir = opts.repoDir;
  const pm = detectPackageManager(repoDir);
  const framework = opts.framework === 'vitest' ? 'vitest' : 'jest';
  const start = Date.now();

  const baseCmd =
    framework === 'vitest'
      ? `npx vitest run`
      : `${runCommand(pm)} ${runScriptName(framework)}`;

  const fullCommand = baseCmd.trim();

  if (opts.decision === 'FULL') {
    const res = await runShell(fullCommand, repoDir, opts.timeoutMs);
    return {
      ran: true,
      exitCode: res.code,
      command: fullCommand,
      durationMs: Date.now() - start,
      testsExecuted: null,
      testsSkipped: 0,
      fellBackToFull: false,
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
    };
  }

  const targetedCommand = `${baseCmd} ${opts.selectedTests.map(quote).join(' ')}`.trim();
  const targeted = await runShell(targetedCommand, repoDir, opts.timeoutMs);

  if (targeted.code === 0) {
    return {
      ran: true,
      exitCode: 0,
      command: targetedCommand,
      durationMs: Date.now() - start,
      testsExecuted: opts.selectedTests.length,
      testsSkipped: 0,
      fellBackToFull: false,
    };
  }

  // Targeted execution failed: fall back to FULL (safety principle).
  const fullRes = await runShell(fullCommand, repoDir, opts.timeoutMs);
  return {
    ran: true,
    exitCode: fullRes.code,
    command: fullCommand,
    durationMs: Date.now() - start,
    testsExecuted: null,
    testsSkipped: 0,
    fellBackToFull: true,
  };
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
