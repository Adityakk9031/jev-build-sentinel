/**
 * Minimal dependency-free .env loader.
 *
 * Reads KEY=VALUE lines from a file into process.env. Values already present
 * in process.env always win, so real environment variables (GitHub Actions
 * secrets, CI overrides) are never shadowed by the local file.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** Load `file` (defaults to `./.env`) into process.env. Missing file is not an error. */
export function loadEnvFile(file: string = path.resolve(process.cwd(), '.env')): void {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return; // no local .env — rely on real environment variables
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key === '' || key in process.env) continue; // existing env wins
    process.env[key] = unquote(trimmed.slice(eq + 1).trim());
  }
}
