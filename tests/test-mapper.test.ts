import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  JestTestMapper,
  VitestTestMapper,
  detectTestFramework,
  createTestMapper,
  isTestFile,
  buildTestImportGraph,
} from '../src/test-mapper.js';

let tmpDir: string;

function write(rel: string, content: string): void {
  const full = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-mapper-'));
});

after(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('naming convention mapping', () => {
  test('src/foo/bar.ts maps to tests/foo/bar.test.ts', () => {
    write('src/foo/bar.ts', 'export const x = 1;\n');
    write('tests/foo/bar.test.ts', 'import { x } from "../../src/foo/bar";\n');
    const mapper = new JestTestMapper();
    const tests = mapper.discoverTestFiles(tmpDir);
    assert.deepEqual(tests, ['tests/foo/bar.test.ts']);
    const result = mapper.mapTests(['src/foo/bar.ts'], tmpDir, tests);
    const direct = result.find((c) => c.reason === 'direct_test_match');
    assert.ok(direct);
    assert.equal(direct!.test, 'tests/foo/bar.test.ts');
    assert.equal(direct!.source, 'src/foo/bar.ts');
    assert.ok(direct!.confidence >= 0.9);
  });

  test('co-located src/foo/bar.test.ts matches', () => {
    write('src/foo/bar.ts', 'export const x = 1;\n');
    write('src/foo/bar.test.ts', 'import { x } from "./bar";\n');
    const mapper = new VitestTestMapper();
    const result = mapper.mapTests(['src/foo/bar.ts'], tmpDir);
    assert.ok(result.some((c) => c.test === 'src/foo/bar.test.ts' && c.reason === 'direct_test_match'));
  });

  test('spec naming is recognized', () => {
    write('src/auth/login.ts', 'export const login = () => 1;\n');
    write('src/auth/login.spec.ts', 'import { login } from "./login";\n');
    const mapper = new JestTestMapper();
    const result = mapper.mapTests(['src/auth/login.ts'], tmpDir);
    assert.ok(result.some((c) => c.test === 'src/auth/login.spec.ts'));
  });

  test('changed test file maps to itself with confidence 1.0', () => {
    write('tests/auth/login.test.ts', 'test("x", () => {});\n');
    const mapper = new JestTestMapper();
    const result = mapper.mapTests(['tests/auth/login.test.ts'], tmpDir);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.confidence, 1.0);
    assert.equal(result[0]!.reason, 'direct_test_match');
  });
});

describe('import graph mapping', () => {
  test('test importing changed file directly is found', () => {
    write('src/payment/stripe.ts', 'export const charge = () => 1;\n');
    write('tests/payment/stripe.test.ts', 'import { charge } from "../../src/payment/stripe";\ntest("c", () => {});\n');
    write('tests/unrelated.test.ts', 'test("u", () => {});\n');
    const mapper = new JestTestMapper();
    const result = mapper.mapTests(['src/payment/stripe.ts'], tmpDir);
    const viaImport = result.find((c) => c.reason === 'direct_test_match');
    assert.ok(viaImport);
    assert.equal(viaImport!.test, 'tests/payment/stripe.test.ts');
  });

  test('transitive import: test -> helper -> changed source', () => {
    write('src/core/calc.ts', 'export const calc = () => 1;\n');
    write('src/helpers/flow.ts', 'import { calc } from "../core/calc";\nexport const flow = () => calc();\n');
    write('tests/flow.test.ts', 'import { flow } from "../src/helpers/flow";\ntest("f", () => {});\n');
    const graph = buildTestImportGraph(tmpDir, ['tests/flow.test.ts']);
    assert.ok(graph.get('tests/flow.test.ts')!.has('src/core/calc.ts'));
    const mapper = new JestTestMapper();
    const result = mapper.mapTests(['src/core/calc.ts'], tmpDir);
    assert.ok(result.some((c) => c.test === 'tests/flow.test.ts' && c.reason === 'import_graph'));
  });
});

describe('directory proximity', () => {
  test('same basename in mirrored test dir maps with lower confidence', () => {
    write('src/users/service.ts', 'export const s = 1;\n');
    // No import link; naming identity differs (service vs service handled by identity match? identity strips ext only)
    write('tests/users/service.test.ts', 'test("s", () => {});\n');
    const mapper = new JestTestMapper();
    const result = mapper.mapTests(['src/users/service.ts'], tmpDir);
    const c = result.find((x) => x.test === 'tests/users/service.test.ts');
    assert.ok(c);
    assert.ok(c!.confidence <= 0.99);
  });
});

describe('no false positives', () => {
  test('unrelated change maps to nothing', () => {
    write('src/notifications/email.ts', 'export const e = 1;\n');
    write('tests/payment/stripe.test.ts', 'test("p", () => {});\n');
    const mapper = new JestTestMapper();
    const result = mapper.mapTests(['src/notifications/email.ts'], tmpDir);
    const strong = result.filter((c) => c.confidence >= 0.8);
    assert.equal(strong.length, 0);
  });
});

describe('framework detection', () => {
  test('detects vitest', () => {
    write('package.json', JSON.stringify({ devDependencies: { vitest: '^2.0.0' } }));
    assert.equal(detectTestFramework(tmpDir), 'vitest');
    assert.equal(createTestMapper(tmpDir).framework, 'vitest');
  });

  test('detects jest', () => {
    write('package.json', JSON.stringify({ devDependencies: { jest: '^29.0.0' } }));
    assert.equal(detectTestFramework(tmpDir), 'jest');
    assert.equal(createTestMapper(tmpDir).framework, 'jest');
  });

  test('unknown when no package.json', () => {
    assert.equal(detectTestFramework(tmpDir), 'unknown');
  });
});

describe('isTestFile', () => {
  test('recognizes test/spec patterns', () => {
    assert.ok(isTestFile('a/b.test.ts'));
    assert.ok(isTestFile('a/b.spec.tsx'));
    assert.ok(isTestFile('__tests__/b.ts'));
    assert.ok(!isTestFile('a/b.ts'));
    assert.ok(!isTestFile('a/latest.ts'));
  });
});

describe('discovery skips junk dirs', () => {
  test('node_modules and dist are excluded', () => {
    write('node_modules/x/y.test.ts', '');
    write('dist/y.test.ts', '');
    write('tests/real.test.ts', '');
    const tests = new JestTestMapper().discoverTestFiles(tmpDir);
    assert.deepEqual(tests, ['tests/real.test.ts']);
  });
});
