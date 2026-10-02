/**
 * Typed HTTP client for TypeSafe's Jev evaluation endpoint.
 * https://docs.typesafe.ai/api
 *
 *   POST {endpoint}/systemone
 *   Authorization: Bearer <API_KEY>
 *   { state, model, questions: { <id>: Question } }
 *   -> { model, answers: { <id>: Answer }, usage }
 *
 * Integration notes (from https://docs.typesafe.ai/introduction):
 * - The Sentinel's structured request travels as `state` (structured data is valid state).
 * - Questions are atomic, well-scoped, and evaluated in parallel in one call:
 *     verification     (choice) -> SKIP | TARGETED | FULL, with confidence
 *     risk             (score)  -> calibrated severity, normalized to 0..1
 *     regression_risk  (noul)   -> guardrail: would a reduced run miss a regression?
 *     test_0..test_N   (noul)   -> is this mapped candidate test worth running?
 * - The model never picks tests out of thin air: it only ranks candidates that the
 *   local mapper already produced, and the deterministic safety policy still applies.
 * - The API key is never logged.
 */
import type { BuildSentinelRequest, JevDecision } from './types.js';

export interface JevClientOptions {
  /** Base URL of the TypeSafe API, e.g. https://api.typesafe.ai/v1 */
  endpoint: string;
  apiKey?: string;
  /** Model alias; defaults to jev-latest. */
  model?: string;
  timeoutMs?: number;
  retries?: number;
  /** Minimum candidate-test noul required to keep the test in a TARGETED run (default 0.5). */
  testThreshold?: number;
  /** Cap on per-test questions asked in a single call (default 12). */
  maxTestQuestions?: number;
  /** Injectable fetch for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable sleep for backoff tests. */
  sleepImpl?: (ms: number) => Promise<void>;
}

export const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1';
export const DEFAULT_MODEL = 'jev-latest';

/** Question ids. Answers come back under the same keys. */
const VERIFICATION = 'verification';
const RISK = 'risk';
const REGRESSION = 'regression_risk';
const TEST_PREFIX = 'test_';

const RISK_LEVELS = ['Negligible', 'Low', 'Moderate', 'High', 'Severe'];
/** A high noul on regression_risk escalates any reduced verdict to FULL. */
const REGRESSION_THRESHOLD = 0.8;
const DEFAULT_TEST_THRESHOLD = 0.5;
const DEFAULT_MAX_TEST_QUESTIONS = 12;

/** 529 = TypeSafe overloaded (docs: retry with backoff). 429 = rate limit. */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRIES = 2;

type Question =
  | { type: 'noul'; instructions: unknown; criteria?: Record<string, string> }
  | { type: 'choice'; instructions: unknown; criteria: Record<string, string | null> }
  | { type: 'score'; instructions: unknown; criteria: string[] };

interface EvaluationPayload {
  state: BuildSentinelRequest;
  model: string;
  questions: Record<string, Question>;
}

export class JevClientError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'JevClientError';
    if (status !== undefined) this.status = status;
  }
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new JevClientError(`Invalid Jev response: ${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asUnit(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new JevClientError(`Invalid Jev response: ${what} must be a number in [0,1]`);
  }
  return value;
}

function asFinite(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new JevClientError(`Invalid Jev response: ${what} must be a finite number`);
  }
  return value;
}

/** Tolerant of casing/separator variants, but only our three verbatim options. */
function toDecision(choice: string): JevDecision['decision'] | null {
  const key = choice.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (key === 'skip' || key === 'skip_tests') return 'SKIP';
  if (key === 'targeted' || key === 'selective') return 'TARGETED';
  if (key === 'full' || key === 'full_suite') return 'FULL';
  return null;
}

function readNoul(answer: unknown, what: string): number {
  const a = asRecord(answer, what);
  const type = a['type'];
  if (type !== undefined && type !== 'noul') {
    throw new JevClientError(`Invalid Jev response: ${what}.type must be "noul"`);
  }
  return asUnit(a['noul'], `${what}.noul`);
}

/** Map the parallel answers back onto the Sentinel's decision contract. */
function parseAnswers(
  answers: Record<string, unknown>,
  selectedFrom: string[],
  testThreshold: number,
): JevDecision {
  // 1. Choice: the verdict itself, plus the confidence the safety policy consumes.
  const verification = asRecord(answers[VERIFICATION], `answers.${VERIFICATION}`);
  const vType = verification['type'];
  if (vType !== undefined && vType !== 'choice') {
    throw new JevClientError(`Invalid Jev response: ${VERIFICATION}.type must be "choice"`);
  }
  const choice = verification['choice'];
  if (typeof choice !== 'string') {
    throw new JevClientError(`Invalid Jev response: ${VERIFICATION}.choice must be a string`);
  }
  const decision = toDecision(choice);
  if (!decision) {
    throw new JevClientError(`Invalid Jev response: unknown choice ${JSON.stringify(choice)}`);
  }
  const confidence = asUnit(verification['confidence'], `${VERIFICATION}.confidence`);
  const probabilities = verification['probabilities'];
  if (probabilities !== undefined) {
    const probs = asRecord(probabilities, `${VERIFICATION}.probabilities`);
    for (const [option, p] of Object.entries(probs)) {
      asUnit(p, `${VERIFICATION}.probabilities.${option}`);
    }
  }

  // 2. Score: probability-weighted severity across ordered levels -> normalized 0..1.
  const riskAnswer = asRecord(answers[RISK], `answers.${RISK}`);
  const rType = riskAnswer['type'];
  if (rType !== undefined && rType !== 'score') {
    throw new JevClientError(`Invalid Jev response: ${RISK}.type must be "score"`);
  }
  const rawScore = asFinite(riskAnswer['score'], `${RISK}.score`);
  let levelCount = RISK_LEVELS.length;
  const legend = riskAnswer['legend'];
  let label: string | undefined;
  if (legend !== undefined) {
    const levels = asRecord(legend, `${RISK}.legend`);
    if (Object.keys(levels).length >= 2) levelCount = Object.keys(levels).length;
    const nearest = levels[String(Math.round(Math.min(Math.max(rawScore, 0), levelCount - 1)))];
    if (typeof nearest === 'string') label = nearest;
  }
  const clamped = Math.min(Math.max(rawScore, 0), levelCount - 1);
  const riskScore = clamped / (levelCount - 1);
  if (label === undefined) label = RISK_LEVELS[Math.round(clamped)] ?? `${Math.round(clamped)}/${levelCount - 1}`;

  // 3. Noul guardrail: a high regression risk always escalates to FULL.
  const regressionRaw = answers[REGRESSION];
  const regression = regressionRaw === undefined ? undefined : readNoul(regressionRaw, `answers.${REGRESSION}`);

  // 4. Per-test noul answers: keep the candidates Jev believes in.
  const selectedTests: string[] = [];
  selectedFrom.forEach((test, i) => {
    const answer = answers[`${TEST_PREFIX}${i}`];
    if (answer === undefined) return;
    if (readNoul(answer, `answers.${TEST_PREFIX}${i}`) >= testThreshold) selectedTests.push(test);
  });

  const escalated = regression !== undefined && regression >= REGRESSION_THRESHOLD && decision !== 'FULL';
  const finalDecision: JevDecision['decision'] = escalated ? 'FULL' : decision;

  const reason = escalated
    ? `Regression risk ${regression!.toFixed(2)} >= ${REGRESSION_THRESHOLD} - full suite required ` +
      `(Jev chose ${decision}, confidence ${confidence.toFixed(2)}, risk ${riskScore.toFixed(2)})`
    : `Jev chose ${decision} (confidence ${confidence.toFixed(2)}); risk ${riskScore.toFixed(2)} (${label})` +
      (regression !== undefined ? `; regression risk ${regression.toFixed(2)}` : '') +
      `; ${selectedTests.length}/${selectedFrom.length} candidate tests selected`;

  return { decision: finalDecision, risk_score: riskScore, confidence, selected_tests: selectedTests, reason };
}

export class JevClient {
  private readonly url: string;
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly testThreshold: number;
  private readonly maxTestQuestions: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(opts: JevClientOptions) {
    if (!opts.endpoint) throw new JevClientError('Jev endpoint is required');
    const base = opts.endpoint.replace(/\/+$/, '');
    this.url = base.endsWith('/systemone') ? base : `${base}/systemone`;
    this.apiKey = opts.apiKey || undefined;
    this.model = opts.model || DEFAULT_MODEL;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retries = opts.retries ?? DEFAULT_RETRIES;
    this.testThreshold = opts.testThreshold ?? DEFAULT_TEST_THRESHOLD;
    this.maxTestQuestions = opts.maxTestQuestions ?? DEFAULT_MAX_TEST_QUESTIONS;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.sleepImpl = opts.sleepImpl ?? ((ms) => new Promise((res) => setTimeout(res, ms)));
  }

  /** Evaluate the change set. Never throws for network errors; use decideOrFull for that. */
  async decide(request: BuildSentinelRequest): Promise<JevDecision> {
    const payload = this.buildPayload(request);
    const selectedFrom = payload.questionsOrder;
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) {
        // Exponential backoff with cap: 250ms, 500ms, 1000ms...
        await this.sleepImpl(Math.min(250 * 2 ** (attempt - 1), 4000));
      }
      try {
        return await this.attemptOnce(payload.body, selectedFrom);
      } catch (err) {
        lastError = err;
        if (err instanceof JevClientError && err.status !== undefined && !RETRYABLE_STATUS.has(err.status)) {
          throw err; // non-retryable (401/400/422)
        }
      }
    }
    throw lastError instanceof Error ? lastError : new JevClientError('Jev request failed');
  }

  /** Decide, but degrade to FULL on any failure. This is the safety-first wrapper. */
  async decideOrFull(request: BuildSentinelRequest): Promise<{ decision: JevDecision; degraded: boolean }> {
    try {
      return { decision: await this.decide(request), degraded: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        decision: {
          decision: 'FULL',
          risk_score: 1,
          confidence: 0,
          selected_tests: [],
          reason: `Jev API unavailable - fallback to FULL (${message.slice(0, 120)})`,
        },
        degraded: true,
      };
    }
  }

  /** Compose the evaluation request: structured state + atomic typed questions. */
  private buildPayload(request: BuildSentinelRequest): {
    body: EvaluationPayload;
    questionsOrder: string[];
  } {
    const questions: Record<string, Question> = {
      [VERIFICATION]: {
        type: 'choice',
        instructions:
          'What is the minimum safe amount of CI verification needed for this pull request? ' +
          'Pick the cheapest option with no realistic chance of missing a regression it introduces.',
        criteria: {
          SKIP:
            'No executable behavior changed (docs, comments, formatting, generated files), ' +
            'so running tests cannot produce a different outcome.',
          TARGETED:
            'The change is small and confined to code with specific mapped tests that would ' +
            'catch a regression here; the rest of the suite adds nothing.',
          FULL:
            'The change is broad, crosses module boundaries, touches shared or runtime behavior, ' +
            'or its relevant tests are unclear - the whole suite is warranted.',
        },
      },
      [RISK]: {
        type: 'score',
        instructions: 'If this change shipped with a bug, how severe would the impact be?',
        criteria: RISK_LEVELS,
      },
      [REGRESSION]: {
        type: 'noul',
        instructions: 'Could a reduced test run miss a regression that the full suite would catch?',
        criteria: {
          true: 'A reduced test run could miss a real regression - the full suite is needed.',
          false: 'Nothing the full suite would catch is plausibly missed by a reduced run.',
        },
      },
    };

    // Bounded, parallel per-candidate questions: Jev ranks the mapper's candidates,
    // it never invents test paths.
    const questionsOrder: string[] = [];
    for (const candidate of request.candidateTests.slice(0, this.maxTestQuestions)) {
      const id = `${TEST_PREFIX}${questionsOrder.length}`;
      questionsOrder.push(candidate.test);
      questions[id] = {
        type: 'noul',
        instructions: {
          test: candidate.test,
          source_file: candidate.source ?? 'unknown',
          mapping: candidate.reason,
          question: `Is \`test\` likely to catch a regression introduced by this pull request?`,
        },
      };
    }

    return { body: { state: request, model: this.model, questions }, questionsOrder };
  }

  private async attemptOnce(body: EvaluationPayload, selectedFrom: string[]): Promise<JevDecision> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'application/json',
      };
      if (this.apiKey) headers['authorization'] = `Bearer ${this.apiKey}`;

      const res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new JevClientError(`Jev API returned HTTP ${res.status}`, res.status);
      }
      const json = asRecord(await res.json(), 'response body');
      const answers = asRecord(json['answers'], 'answers');
      return parseAnswers(answers, selectedFrom, this.testThreshold);
    } catch (err) {
      if (err instanceof JevClientError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new JevClientError(`Jev API timed out after ${this.timeoutMs}ms`);
      }
      throw new JevClientError(`Jev request failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
