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
  candidateTests: [
    { test: 'tests/x.test.ts', source: 'src/x.ts', reason: 'direct_test_match', confidence: 0.98 },
  ],
  testFramework: 'jest',
};

const LEGEND = { '0': 'Negligible', '1': 'Low', '2': 'Moderate', '3': 'High', '4': 'Severe' };

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** A well-formed TypeSafe evaluation response. */
function evalResponse(overrides: {
  choice?: string;
  confidence?: number;
  score?: number;
  regression?: number;
  testNouls?: Array<number | undefined>;
} = {}): unknown {
  const answers: Record<string, unknown> = {
    verification: {
      type: 'choice',
      choice: overrides.choice ?? 'TARGETED',
      probabilities: { SKIP: 0.03, TARGETED: 0.94, FULL: 0.03 },
      confidence: overrides.confidence ?? 0.95,
    },
    risk: { type: 'score', score: overrides.score ?? 1.6, legend: LEGEND, confidence: 0.9 },
    regression_risk: { type: 'noul', noul: overrides.regression ?? 0.12 },
  };
  (overrides.testNouls ?? [0.9]).forEach((noul, i) => {
    if (noul !== undefined) answers[`test_${i}`] = { type: 'noul', noul };
  });
  return {
    model: 'jev-1.13.0',
    answers,
    usage: { input_tokens: 300, output_tokens: 20 },
  };
}

describe('JevClient: happy path', () => {
  test('POSTs state + questions to /systemone and maps the answers', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: Record<string, any> = {};
    const client = new JevClient({
      endpoint: 'https://api.typesafe.ai/v1',
      apiKey: 'secret-key',
      fetchImpl: async (url, init) => {
        capturedUrl = String(url);
        capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
        capturedBody = JSON.parse(String(init?.body));
        return okResponse(evalResponse());
      },
    });
    const d = await client.decide(baseRequest);

    assert.equal(capturedUrl, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(capturedHeaders['authorization'], 'Bearer secret-key');
    assert.equal(capturedHeaders['content-type'], 'application/json');

    // Request body follows the documented {state, model, questions} shape.
    assert.equal(capturedBody.model, 'jev-latest');
    assert.equal(capturedBody.state.repository, 'acme/widget');
    assert.equal(capturedBody.state.candidateTests[0].source, 'src/x.ts');
    assert.deepEqual(
      Object.keys(capturedBody.questions).sort(),
      ['regression_risk', 'risk', 'test_0', 'verification'],
    );
    assert.equal(capturedBody.questions.verification.type, 'choice');
    assert.deepEqual(
      Object.keys(capturedBody.questions.verification.criteria),
      ['SKIP', 'TARGETED', 'FULL'],
    );
    assert.equal(capturedBody.questions.risk.type, 'score');
    assert.deepEqual(capturedBody.questions.risk.criteria, ['Negligible', 'Low', 'Moderate', 'High', 'Severe']);
    assert.equal(capturedBody.questions.regression_risk.type, 'noul');
    assert.equal(capturedBody.questions.test_0.type, 'noul');
    assert.equal(capturedBody.questions.test_0.instructions.test, 'tests/x.test.ts');

    assert.equal(d.decision, 'TARGETED');
    assert.equal(d.confidence, 0.95);
    assert.equal(d.risk_score, 0.4); // score 1.6 across 5 levels -> 1.6 / 4
    assert.deepEqual(d.selected_tests, ['tests/x.test.ts']);
    assert.match(d.reason, /Jev chose TARGETED/);
  });

  test('SKIP with no candidates asks no per-test questions', async () => {
    let capturedBody: Record<string, any> = {};
    const client = new JevClient({
      endpoint: 'https://api.typesafe.ai/v1',
      fetchImpl: async (_url, init) => {
        capturedBody = JSON.parse(String(init?.body));
        return okResponse(evalResponse({ choice: 'SKIP', testNouls: [] }));
      },
    });
    const d = await client.decide({ ...baseRequest, candidateTests: [] });
    assert.equal(d.decision, 'SKIP');
    assert.deepEqual(d.selected_tests, []);
    assert.deepEqual(
      Object.keys(capturedBody.questions).sort(),
      ['regression_risk', 'risk', 'verification'],
    );
  });

  test('drops candidates Jev scores below the relevance threshold', async () => {
    const client = new JevClient({
      endpoint: 'https://api.typesafe.ai/v1',
      fetchImpl: async () => okResponse(evalResponse({ testNouls: [0.2] })),
    });
    const d = await client.decide(baseRequest);
    assert.deepEqual(d.selected_tests, []);
    assert.match(d.reason, /0\/1 candidate tests selected/);
  });

  test('high regression noul escalates a reduced verdict to FULL', async () => {
    const client = new JevClient({
      endpoint: 'https://api.typesafe.ai/v1',
      fetchImpl: async () => okResponse(evalResponse({ choice: 'SKIP', regression: 0.93 })),
    });
    const d = await client.decide(baseRequest);
    assert.equal(d.decision, 'FULL');
    assert.match(d.reason, /full suite required/);
    assert.match(d.reason, /0\.93/);
  });

  test('honours a custom model alias', async () => {
    let capturedBody: Record<string, any> = {};
    const client = new JevClient({
      endpoint: 'https://api.typesafe.ai/v1',
      model: 'jev-1.13.0',
      fetchImpl: async (_url, init) => {
        capturedBody = JSON.parse(String(init?.body));
        return okResponse(evalResponse());
      },
    });
    await client.decide(baseRequest);
    assert.equal(capturedBody.model, 'jev-1.13.0');
  });
});

describe('JevClient: endpoint normalization', () => {
  test('trailing slash is normalized', async () => {
    let url = '';
    const client = new JevClient({
      endpoint: 'https://api.typesafe.ai/v1/',
      fetchImpl: async (u) => {
        url = String(u);
        return okResponse(evalResponse());
      },
    });
    await client.decide(baseRequest);
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
  });

  test('does not double-append /systemone', async () => {
    let url = '';
    const client = new JevClient({
      endpoint: 'https://api.typesafe.ai/v1/systemone',
      fetchImpl: async (u) => {
        url = String(u);
        return okResponse(evalResponse());
      },
    });
    await client.decide(baseRequest);
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
  });

  test('throws without endpoint', () => {
    assert.throws(() => new JevClient({ endpoint: '' }), JevClientError);
  });
});

describe('JevClient: schema validation', () => {
  test('rejects unknown choice', async () => {
    const client = new JevClient({
      endpoint: 'https://api.typesafe.ai/v1',
      retries: 0,
      fetchImpl: async () => okResponse(evalResponse({ choice: 'MAYBE' })),
    });
    await assert.rejects(() => client.decide(baseRequest), /unknown choice/);
  });

  test('rejects out-of-range confidence', async () => {
    const client = new JevClient({
      endpoint: 'https://api.typesafe.ai/v1',
      retries: 0,
      fetchImpl: async () => okResponse(evalResponse({ confidence: 1.5 })),
    });
    await assert.rejects(() => client.decide(baseRequest), /confidence/);
  });

  test('rejects non-numeric risk score', async () => {
    const client = new JevClient({
      endpoint: 'https://api.typesafe.ai/v1',
      retries: 0,
      fetchImpl: async () => okResponse(evalResponse({ score: Number.NaN })),
    });
    await assert.rejects(() => client.decide(baseRequest), /risk\.score/);
  });

  test('rejects a missing answers map', async () => {
    const client = new JevClient({
      endpoint: 'https://api.typesafe.ai/v1',
      retries: 0,
      fetchImpl: async () => okResponse({ model: 'jev-1.13.0' }),
    });
    await assert.rejects(() => client.decide(baseRequest), /answers/);
  });

  test('rejects an answer of the wrong question type', async () => {
    const body = evalResponse() as { answers: Record<string, unknown> };
    body.answers['verification'] = { type: 'noul', noul: 0.5 };
    const client = new JevClient({
      endpoint: 'https://api.typesafe.ai/v1',
      retries: 0,
      fetchImpl: async () => okResponse(body),
    });
    await assert.rejects(() => client.decide(baseRequest), /must be "choice"/);
  });
});

describe('JevClient: HTTP errors and retries', () => {
  test('does not retry 401 and surfaces status', async () => {
    let calls = 0;
    const client = new JevClient({
      endpoint: 'https://api.typesafe.ai/v1',
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

  test('does not retry 422 validation errors', async () => {
    let calls = 0;
    const client = new JevClient({
      endpoint: 'https://api.typesafe.ai/v1',
      retries: 3,
      sleepImpl: async () => {},
      fetchImpl: async () => {
        calls += 1;
        return new Response('bad question', { status: 422 });
      },
    });
    await assert.rejects(
      () => client.decide(baseRequest),
      (e: unknown) => e instanceof JevClientError && e.status === 422,
    );
    assert.equal(calls, 1);
  });

  test('retries 503 then succeeds', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const client = new JevClient({
      endpoint: 'https://api.typesafe.ai/v1',
      retries: 2,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
      fetchImpl: async () => {
        calls += 1;
        if (calls < 3) return new Response('busy', { status: 503 });
        return okResponse(evalResponse());
      },
    });
    const d = await client.decide(baseRequest);
    assert.equal(d.decision, 'TARGETED');
    assert.equal(calls, 3);
    assert.deepEqual(sleeps, [250, 500]);
  });

  test('retries 429 rate limits', async () => {
    let calls = 0;
    const client = new JevClient({
      endpoint: 'https://api.typesafe.ai/v1',
      retries: 1,
      sleepImpl: async () => {},
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return new Response('slow down', { status: 429 });
        return okResponse(evalResponse());
      },
    });
    const d = await client.decide(baseRequest);
    assert.equal(d.decision, 'TARGETED');
    assert.equal(calls, 2);
  });

  test('retries 529 overload', async () => {
    let calls = 0;
    const client = new JevClient({
      endpoint: 'https://api.typesafe.ai/v1',
      retries: 1,
      sleepImpl: async () => {},
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return new Response('overloaded', { status: 529 });
        return okResponse(evalResponse());
      },
    });
    const d = await client.decide(baseRequest);
    assert.equal(d.decision, 'TARGETED');
    assert.equal(calls, 2);
  });

  test('exhausts retries on repeated 500 and throws', async () => {
    let calls = 0;
    const client = new JevClient({
      endpoint: 'https://api.typesafe.ai/v1',
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
      endpoint: 'https://api.typesafe.ai/v1',
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
      endpoint: 'https://api.typesafe.ai/v1',
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
      endpoint: 'https://api.typesafe.ai/v1',
      fetchImpl: async () => okResponse(evalResponse()),
    });
    const { decision, degraded } = await client.decideOrFull(baseRequest);
    assert.equal(degraded, false);
    assert.equal(decision.decision, 'TARGETED');
  });
});
