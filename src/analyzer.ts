import * as path from 'node:path';
import type { AnalysisFeatures, ChangeSet, ChangedFile } from './types.js';

const SOURCE_EXTS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts']);
const TEST_FILE_RES = /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)__tests__\//;
const MIGRATION_RES = /(^|\/)(migrations?|db\/migrate|schema|prisma\/migrations?)\//i;
const MIGRATION_EXT = new Set(['sql', 'prisma', 'mongo']);
const CI_PATHS = ['.github/workflows/', '.gitlab-ci', 'jenkinsfile', '.circleci/', '.travis.yml', 'azure-pipelines'];
const DOCKER_RES = /(^|\/)(dockerfile(\..+)?|docker-compose(\..+)?\.ya?ml)$/i;
const CONFIG_EXTS = new Set(['json', 'yml', 'yaml', 'toml', 'ini', 'env', 'properties']);
const CONFIG_NAMES = new Set(['.env', '.env.local', '.env.production', 'config']);
const AUTH_RES = /(^|\/)(auth|authentication|authorization|login|session|jwt|oauth|passport|permission|rbac|token|password)/i;
const PAYMENT_RES = /(^|\/)(payment|payments|billing|checkout|cart|stripe|paypal|invoice|subscription|pricing)/i;
const CORE_RES = /(^|\/)(core|shared|common|utils?|lib|internal)(\/|$)/i;
const DEP_FILES = new Set(['package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'npm-shrinkwrap.json', 'requirements.txt', 'poetry.lock', 'go.mod', 'go.sum', 'gemfile.lock', 'composer.lock', 'cargo.lock']);

function isTestFile(f: ChangedFile): boolean {
  return TEST_FILE_RES.test(f.path);
}

function isDependencyFile(f: ChangedFile): boolean {
  return DEP_FILES.has(f.path.toLowerCase()) || f.path.toLowerCase().endsWith('cargo.toml');
}

/**
 * Extract deterministic, typed risk features from a change set.
 * No CI decision is made here - callers (risk engine) interpret the features.
 */
export function extractFeatures(changeSet: ChangeSet): AnalysisFeatures {
  const files = changeSet.files;

  let sourceFileCount = 0;
  let testFileCount = 0;
  let dependencyCount = 0;
  let hasDatabaseMigration = false;
  let hasPackageChange = false;
  let hasCIChange = false;
  let hasDockerChange = false;
  let hasAuthRelatedPath = false;
  let hasPaymentRelatedPath = false;
  let hasConfigChange = false;
  let hasCoreLibraryChange = false;

  for (const f of files) {
    if (isTestFile(f)) testFileCount += 1;
    else if (SOURCE_EXTS.has(f.extension)) sourceFileCount += 1;

    if (isDependencyFile(f)) {
      hasPackageChange = true;
      if (f.path.toLowerCase().includes('lock')) dependencyCount += 1;
      else if (f.path.toLowerCase() === 'package.json') {
        // Count +/- dependency lines in package.json heuristically via linesChanged
        dependencyCount += Math.min(f.linesChanged, 10);
      }
    }

    const lower = f.path.toLowerCase();
    if (MIGRATION_RES.test(lower) || MIGRATION_EXT.has(f.extension)) hasDatabaseMigration = true;
    if (CI_PATHS.some((p) => lower.includes(p))) hasCIChange = true;
    if (DOCKER_RES.test(lower)) hasDockerChange = true;
    if (AUTH_RES.test(lower)) hasAuthRelatedPath = true;
    if (PAYMENT_RES.test(lower)) hasPaymentRelatedPath = true;
    if (CORE_RES.test(lower) && SOURCE_EXTS.has(f.extension)) hasCoreLibraryChange = true;
    if (
      CONFIG_EXTS.has(f.extension) ||
      CONFIG_NAMES.has(path.posix.basename(lower)) ||
      lower.endsWith('.config.js') ||
      lower.endsWith('.config.ts')
    ) {
      hasConfigChange = true;
    }
  }

  const docsOnly =
    files.length > 0 &&
    files.every((f) => ['md', 'mdx', 'txt', 'rst', 'adoc'].includes(f.extension));
  const testOnly =
    files.length > 0 &&
    files.every((f) => isTestFile(f));

  return {
    linesChanged: changeSet.totalLinesChanged,
    filesChanged: files.length,
    sourceFileCount,
    testFileCount,
    dependencyCount,
    hasDatabaseMigration,
    hasPackageChange,
    hasCIChange,
    hasDockerChange,
    hasAuthRelatedPath,
    hasPaymentRelatedPath,
    hasConfigChange,
    hasCoreLibraryChange,
    docsOnly,
    testOnly,
  };
}
