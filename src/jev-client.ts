/**
 * Typed HTTP client for the Jev inference API.
 * - timeout + retries with backoff
 * - strict response schema validation
 * - never logs the API key
 */
import type { BuildSentinelRequest, JevDecision } from './types.js';

export interface JevClientOptions {
  endpoint: string;
  apiKey?: string;
  timeoutMs?: number;
  retries?: number;
  /** Injectable fetch for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable sleep for backoff tests. */
  sleepImpl?: (ms: number) => Promise<void>;
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRIES = 2;

function validateDecision(raw: unknown): JevDecision {
  if (typeof raw !== 'object' || raw === null) {
    throw new JevClientError('Invalid Jev response: expected object');
  }
  const r = raw as Record<string, unknown>;
  const decision = r['decision'];
  if (decision !== 'SKIP' && decision !== 'TARGETED' && decision !== 'FULL') {
    throw new JevClientError(`Invalid Jev response: unknown decision ${JSON.stringify(decision)}`);
  }
  const risk = r['risk_score'];
  const conf = r['confidence'];
  if (typeof risk !== 'number' || !Number.isFinite(risk) || risk < 0 || risk > 1) {
    throw new JevClientError('Invalid Jev response: risk_score must be a number in [0,1]');
  }
  if (typeof conf !== 'number' || !Number.isFinite(conf) || conf < 0 || conf > 1) {
    throw new JevClientError('Invalid Jev response: confidence must be a number in [0,1]');
  }
  const selected = r['selected_tests'];
  if (!Array.isArray(selected) || selected.some((t) => typeof t !== 'string')) {
    throw new JevClientError('Invalid Jev response: selected_tests must be string[]');
  }
  const reason = r['reason'];
  if (typeof reason !== 'string') {
    throw new JevClientError('Invalid Jev response: reason must be a string');
  }
  return {
    decision,
    risk_score: risk,
    confidence: conf,
    selected_tests: selected as string[],
    reason,
  };
}

export class JevClientError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'JevClientError';
    if (status !== undefined) this.status = status;
  }
}

export class JevClient {
  private readonly endpoint: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(opts: JevClientOptions) {
    if (!opts.endpoint) throw new JevClientError('Jev endpoint is required');
    this.endpoint = opts.endpoint.replace(/\/$/, '');
    this.apiKey = opts.apiKey || undefined;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retries = opts.retries ?? DEFAULT_RETRIES;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.sleepImpl = opts.sleepImpl ?? ((ms) => new Promise((res) => setTimeout(res, ms)));
  }

  /** Decide the CI strategy for a build. Never throws for network errors; use callOrFull for that. */
  async decide(request: BuildSentinelRequest): Promise<JevDecision> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) {
        // Exponential backoff with cap: 250ms, 500ms, 1000ms...
        await this.sleepImpl(Math.min(250 * 2 ** (attempt - 1), 4000));
      }
      try {
        return await this.attemptOnce(request);
      } catch (err) {
        lastError = err;
        if (err instanceof JevClientError && err.status !== undefined && !RETRYABLE_STATUS.has(err.status)) {
          throw err; // non-retryable (4xx like 401/403/400)
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

  private async attemptOnce(request: BuildSentinelRequest): Promise<JevDecision> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'application/json',
      };
      if (this.apiKey) headers['authorization'] = `Bearer ${this.apiKey}`;

      const res = await this.fetchImpl(`${this.endpoint}/decide`, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new JevClientError(`Jev API returned HTTP ${res.status}`, res.status);
      }
      const json: unknown = await res.json();
      return validateDecision(json);
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
