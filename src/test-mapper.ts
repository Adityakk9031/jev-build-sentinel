import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CandidateTest, TestRelationReason } from './types.js';

/** Abstraction over a concrete framework test mapper. */
export interface TestMapper {
  readonly framework: 'jest' | 'vitest';
  /** All known test files in the repository (relative paths, posix separators). */
  discoverTestFiles(repoDir: string): string[];
  /**
   * Map changed source files to candidate tests.
   * @param changedFiles paths of changed source (non-test) files
   * @param repoDir repository root (used to inspect imports)
   * @param testFiles known test files (defaults to discoverTestFiles(repoDir))
   */
  mapTests(changedFiles: string[], repoDir: string, testFiles?: string[]): CandidateTest[];
}

const DEFAULT_TEST_FILE_RES = /(^|[\\/])(__tests__[\\/].*|.*\.(test|spec)\.[cm]?[jt]sx?)$/;

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Strip common source prefixes to create a comparable module identity. */
function moduleIdentity(p: string): string {
  const posix = toPosix(p);
  const stripped = posix.replace(/\.[cm]?[jt]sx?$/, '');
  const withoutTestDir = stripped.replace(/(^|\/)__tests__\//, '$1');
  const withoutSrcDir = withoutTestDir.replace(/\/(?:src|lib|source)\//, '/').replace(/^(?:src|lib|source)\//, '');
  const withoutTestPrefix = withoutSrcDir.replace(/^(?:tests?|spec)\//, '');
  // Strip .test/.spec suffix from the basename: foo/bar.test -> foo/bar
  return withoutTestPrefix.replace(/\.(?:test|spec)$/, '');
}

/** True when a path looks like a test file. */
export function isTestFile(p: string): boolean {
  return DEFAULT_TEST_FILE_RES.test(toPosix(p));
}

/** Find the closest existing ancestor directory (never escapes repoDir). */
function safeResolve(repoDir: string, rel: string): string {
  return path.resolve(repoDir, rel);
}

/**
 * Resolve a relative or package-ish import specifier to a file inside the repo.
 * Tries common extension and index resolutions.
 */
export function resolveImport(repoDir: string, fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = safeResolve(repoDir, path.join(path.dirname(toPosix(fromFile)), specifier));
  const candidates: string[] = [base];
  for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']) {
    candidates.push(`${base}${ext}`);
    candidates.push(path.join(base, `index${ext}`));
  }
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return toPosix(path.relative(repoDir, c));
    } catch {
      /* not a file */
    }
  }
  return null;
}

/** Extract relative import specifiers from a source file (best effort, regex based). */
export function extractImports(repoDir: string, filePath: string): string[] {
  const abs = safeResolve(repoDir, filePath);
  let text: string;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch {
    return [];
  }
  const specifiers: string[] = [];
  const re = /(?:import[\s\S]*?from\s*|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    specifiers.push(m[1]!);
  }
  return specifiers;
}

/**
 * Build a reverse import graph: for every test file, which repo files does it
 * (transitively, up to `depth`) import?
 */
export function buildTestImportGraph(
  repoDir: string,
  testFiles: string[],
  depth = 3,
): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  const cache = new Map<string, Set<string>>();

  const directImports = (file: string): Set<string> => {
    const cached = cache.get(file);
    if (cached) return cached;
    const resolved = new Set<string>();
    for (const spec of extractImports(repoDir, file)) {
      const target = resolveImport(repoDir, file, spec);
      if (target) resolved.add(target);
    }
    cache.set(file, resolved);
    return resolved;
  };

  for (const testFile of testFiles) {
    const seen = new Set<string>();
    let frontier = new Set([toPosix(testFile)]);
    for (let d = 0; d < depth; d++) {
      const next = new Set<string>();
      for (const f of frontier) {
        for (const dep of directImports(f)) {
          if (dep === toPosix(testFile)) continue;
          if (!seen.has(dep)) {
            seen.add(dep);
            next.add(dep);
          }
        }
      }
      if (next.size === 0) break;
      frontier = next;
    }
    graph.set(toPosix(testFile), seen);
  }
  return graph;
}

/** Shared mapping engine: naming conventions + import graph + directory proximity. */
function mapWithEngine(
  changedFiles: string[],
  repoDir: string,
  testFiles: string[],
): CandidateTest[] {
  const allTests = testFiles.map(toPosix);
  const graph = buildTestImportGraph(repoDir, allTests);
  const results: CandidateTest[] = [];
  const seenPairs = new Set<string>();

  const push = (test: string, source: string, reason: TestRelationReason, confidence: number) => {
    const key = `${test}\u0000${source}`;
    if (seenPairs.has(key)) return;
    // Keep the highest confidence/reason priority per test-source pair.
    const existingIdx = results.findIndex((c) => c.test === test && c.source === source);
    if (existingIdx >= 0) {
      const existing = results[existingIdx]!;
      if (confidence > existing.confidence) {
        results[existingIdx] = { test, source, reason, confidence };
      }
      return;
    }
    seenPairs.add(key);
    results.push({ test, source, reason, confidence });
  };

  for (const changedRaw of changedFiles) {
    const changed = toPosix(changedRaw);
    if (isTestFile(changed)) {
      // A changed test file maps to itself: it obviously needs to run.
      push(changed, changed, 'direct_test_match', 1.0);
      continue;
    }

    const changedIdentity = moduleIdentity(changed);
    const changedDir = path.posix.dirname(changed);

    for (const testFile of allTests) {
      // 1. Direct naming convention: src/foo/bar.ts -> tests/foo/bar.test.ts
      const testIdentity = moduleIdentity(testFile);
      if (testIdentity === changedIdentity) {
        push(testFile, changed, 'direct_test_match', 0.98);
        continue;
      }

      // 2. Import graph: test imports (transitively) the changed file.
      if (graph.get(testFile)?.has(changed)) {
        push(testFile, changed, 'import_graph', 0.85);
        continue;
      }

      // 3. Directory proximity: same directory with weaker naming link.
      const testDir = path.posix.dirname(testFile);
      const normalizedTestDir = testDir.replace(/^(tests?|__tests__)(\/|$)/, '');
      const normalizedChangedDir = changedDir.replace(/^(tests?|__tests__)(\/|$)/, '');
      if (
        normalizedTestDir === normalizedChangedDir &&
        path.posix.basename(testIdentity) === path.posix.basename(changedIdentity)
      ) {
        push(testFile, changed, 'directory_proximity', 0.6);
      }
    }
  }
  return results;
}

/** Jest mapper (uses the same conventions; kept as a distinct framework adapter). */
export class JestTestMapper implements TestMapper {
  readonly framework = 'jest' as const;

  discoverTestFiles(repoDir: string): string[] {
    return discoverTestFilesRecursive(repoDir, DEFAULT_TEST_FILE_RES);
  }

  mapTests(changedFiles: string[], repoDir: string, testFiles?: string[]): CandidateTest[] {
    return mapWithEngine(changedFiles, repoDir, testFiles ?? this.discoverTestFiles(repoDir));
  }
}

/** Vitest mapper (same conventions as Jest for the MVP). */
export class VitestTestMapper implements TestMapper {
  readonly framework = 'vitest' as const;

  discoverTestFiles(repoDir: string): string[] {
    return discoverTestFilesRecursive(repoDir, DEFAULT_TEST_FILE_RES);
  }

  mapTests(changedFiles: string[], repoDir: string, testFiles?: string[]): CandidateTest[] {
    return mapWithEngine(changedFiles, repoDir, testFiles ?? this.discoverTestFiles(repoDir));
  }
}

/** Recursively find test files under repoDir, skipping node_modules and build dirs. */
export function discoverTestFilesRecursive(repoDir: string, res: RegExp): string[] {
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next']);
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) walk(full);
      } else if (e.isFile() && res.test(e.name)) {
        out.push(toPosix(path.relative(repoDir, full)));
      }
    }
  };
  walk(repoDir);
  return out.sort();
}

/** Detect the test framework from package.json devDependencies/scripts. */
export function detectTestFramework(repoDir: string): 'jest' | 'vitest' | 'unknown' {
  let pkg: { devDependencies?: Record<string, string>; dependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(repoDir, 'package.json'), 'utf8'));
  } catch {
    return 'unknown';
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if ('vitest' in deps) return 'vitest';
  if ('jest' in deps) return 'jest';
  return 'unknown';
}

/** Create the mapper matching the repository's detected framework. */
export function createTestMapper(repoDir: string): TestMapper {
  const framework = detectTestFramework(repoDir);
  if (framework === 'vitest') return new VitestTestMapper();
  return new JestTestMapper();
}
