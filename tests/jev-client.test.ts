import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { JevClient, JevClientError } from '../src/jev-client.js';
import type { BuildSentinelRequest } from '../src/types.js';

const baseRequest: BuildSentinelRequest = {
  repository: 'acme/widget',
  baseSha: 'a',
  headSha: 'b',
  changedFiles: [{ path: 'src/x.ts', changeType: 'modified', extension: 'ts', directory: 'src', linesChanged: 4 }],
  features: {
    linesChanged: 4,
    filesChanged: 1,
    sourceFileCount: 1,
    testFileCount: 0,
    dependencyCount: 0,
    hasDatabaseMigration: false,
    hasPackageChange: false,
    hasCIChange: false,
    hasDockerChange: false,
    hasAuthRelatedPath: false,
    hasPaymentRelatedPath: false,
    hasConfigChange: false,
    hasCoreLibraryChange: false,
    docsOnly: false,
    testOnly: false,
  },
  candidateTests: [{ test: 'tests/x.test.ts', reason: 'direct_test_match', confidence: 0.98 }],
  testFramework: 'jest',
};

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

const validDecision = {
  decision: 'TARGETED',
  risk_score: 0.4,
  confidence: 0.95,
  selected_tests: ['tests/x.test.ts'],
  reason: 'low risk',
};

describe('JevClient: happy path', () => {
  test('returns a validated decision', async () => {
    let capturedHeaders: Record<string, string> = {};
    let capturedUrl = '';
    const client = new JevClient({
      endpoint: 'https://jev.example.com/v1',
      apiKey: 'secret-key',
      fetchImpl: async (url, init) => {
        capturedUrl = String(url);
        capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
        return okResponse(validDecision);
      },
    });
    const d = await client.decide(baseRequest);
    assert.equal(d.decision, 'TARGETED');
    assert.equal(d.risk_score, 0.4);
    assert.equal(capturedUrl, 'https://jev.example.com/v1/decide');
    assert.equal(capturedHeaders['authorization'], 'Bearer secret-key');
    assert.equal(capturedHeaders['content-type'], 'application/json');
  });

  test('accepts SKIP decision with empty tests', async () => {
    const client = new JevClient({
      endpoint: 'https://jev.example.com/v1',
      fetchImpl: async () =>
        okResponse({ ...validDecision, decision: 'SKIP', selected_tests: [] }),
    });
    const d = await client.decide(baseRequest);
    assert.equal(d.decision, 'SKIP');
  });
});

describe('JevClient: schema validation', () => {
  test('rejects unknown decision', async () => {
    const client = new JevClient({
      endpoint: 'https://jev.example.com/v1',
      fetchImpl: async () => okResponse({ ...validDecision, decision: 'MAYBE' }),
    });
    await assert.rejects(() => client.decide(baseRequest), JevClientError);
  });

  test('rejects out-of-range risk_score', async () => {
    const client = new JevClient({
      endpoint: 'https://jev.example.com/v1',
      fetchImpl: async () => okResponse({ ...validDecision, risk_score: 1.5 }),
    });
    await assert.rejects(() => client.decide(baseRequest), /risk_score/);
  });

  test('rejects non-string selected_tests', async () => {
    const client = new JevClient({
      endpoint: 'https://jev.example.com/v1',
      fetchImpl: async () => okResponse({ ...validDecision, selected_tests: [42] }),
    });
    await assert.rejects(() => client.decide(baseRequest), /selected_tests/);
  });
});

describe('JevClient: HTTP errors and retries', () => {
  test('does not retry 401 and surfaces status', async () => {
    let calls = 0;
    const client = new JevClient({
      endpoint: 'https://jev.example.com/v1',
      retries: 3,
      sleepImpl: async () => {},
      fetchImpl: async () => {
        calls += 1;
        return new Response('nope', { status: 401 });
      },
    });
    await assert.rejects(
      () => client.decide(baseRequest),
      (e: unknown) => e instanceof JevClientError && e.status === 401,
    );
    assert.equal(calls, 1);
  });

  test('retries 503 then succeeds', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const client = new JevClient({
      endpoint: 'https://jev.example.com/v1',
      retries: 2,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
      fetchImpl: async () => {
        calls += 1;
        if (calls < 3) return new Response('busy', { status: 503 });
        return okResponse(validDecision);
      },
    });
    const d = await client.decide(baseRequest);
    assert.equal(d.decision, 'TARGETED');
    assert.equal(calls, 3);
    assert.deepEqual(sleeps, [250, 500]);
  });

  test('exhausts retries on repeated 500 and throws', async () => {
    let calls = 0;
    const client = new JevClient({
      endpoint: 'https://jev.example.com/v1',
      retries: 1,
      sleepImpl: async () => {},
      fetchImpl: async () => {
        calls += 1;
        return new Response('err', { status: 500 });
      },
    });
    await assert.rejects(() => client.decide(baseRequest), /HTTP 500/);
    assert.equal(calls, 2);
  });

  test('maps abort to timeout error', async () => {
    const client = new JevClient({
      endpoint: 'https://jev.example.com/v1',
      timeoutMs: 20,
      retries: 0,
      fetchImpl: async (_url, init) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
          });
        });
      },
    });
    await assert.rejects(() => client.decide(baseRequest), /timed out/);
  });
});

describe('JevClient: decideOrFull fallback', () => {
  test('degrades to FULL when API fails', async () => {
    const client = new JevClient({
      endpoint: 'https://jev.example.com/v1',
      retries: 0,
      sleepImpl: async () => {},
      fetchImpl: async () => new Response('err', { status: 503 }),
    });
    const { decision, degraded } = await client.decideOrFull(baseRequest);
    assert.equal(degraded, true);
    assert.equal(decision.decision, 'FULL');
    assert.equal(decision.confidence, 0);
    assert.match(decision.reason, /fallback to FULL/);
  });

  test('does not degrade on success', async () => {
    const client = new JevClient({
      endpoint: 'https://jev.example.com/v1',
      fetchImpl: async () => okResponse(validDecision),
    });
    const { degraded } = await client.decideOrFull(baseRequest);
    assert.equal(degraded, false);
  });
});

describe('JevClient: configuration', () => {
  test('trailing slash is normalized', async () => {
    let url = '';
    const client = new JevClient({
      endpoint: 'https://jev.example.com/v1/',
      fetchImpl: async (u) => {
        url = String(u);
        return okResponse(validDecision);
      },
    });
    await client.decide(baseRequest);
    assert.equal(url, 'https://jev.example.com/v1/decide');
  });

  test('throws without endpoint', () => {
    assert.throws(() => new JevClient({ endpoint: '' }), JevClientError);
  });
});
