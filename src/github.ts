import * as fs from 'node:fs';

/** Minimal shape of the GitHub webhook payload we rely on. */
export interface EventContext {
  repository: { full_name: string; name: string; owner: { login: string } } | null;
  pull_request?: {
    base: { sha: string };
    head: { sha: string };
    number?: number;
  };
}

/** Read the GitHub event payload path from env. */
export function getEventPayloadPath(env: NodeJS.ProcessEnv = process.env): string | null {
  return env['GITHUB_EVENT_PATH'] ?? null;
}

/** Load and parse the GitHub event payload, or null when not running in Actions. */
export function loadEventContext(env: NodeJS.ProcessEnv = process.env): EventContext | null {
  const p = env['GITHUB_EVENT_PATH'] ?? null;
  if (!p || !fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as EventContext;
  } catch {
    return null;
  }
}

/** Resolve base and head SHAs from the event context. */
export function resolveShas(ctx: EventContext | null): { baseSha: string; headSha: string } | null {
  if (!ctx?.pull_request) return null;
  const base = ctx.pull_request.base?.sha;
  const head = ctx.pull_request.head?.sha;
  if (!base || !head) return null;
  return { baseSha: base, headSha: head };
}

/** Repository in owner/name form. */
export function repositoryFullName(ctx: EventContext | null): string | null {
  return ctx?.repository?.full_name ?? null;
}
