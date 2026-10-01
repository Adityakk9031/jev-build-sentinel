import * as fs from 'node:fs';
import * as path from 'node:path';

/** A unified-diff hunk line prefixed as in `git diff` output. */
export interface DiffLine {
  kind: 'context' | 'added' | 'removed';
  text: string;
}

export interface FileDiff {
  /** Post-change path. */
  path: string;
  /** Pre-change path when the file was renamed. */
  previousPath?: string;
  changeType: 'added' | 'deleted' | 'modified' | 'renamed' | 'changed';
  /** Parsed unified diff hunks. */
  hunks: Array<{
    header: string;
    oldStart: number;
    newStart: number;
    lines: DiffLine[];
  }>;
  addedLines: number;
  deletedLines: number;
}

/** Raw result of parsing a unified diff into per-file hunks. */
export interface ParsedDiff {
  files: FileDiff[];
}

const DIFF_FILE_HEADER = /^diff --git a\/(.+?) b\/(.+)$/;
const RENAME_FROM = /^rename from (.+)$/;
const RENAME_TO = /^rename to (.+)$/;
const OLD_MODE = /^old mode /;
const NEW_MODE = /^new mode /;
const SIMILARITY = /^similarity index /;
const INDEX_LINE = /^index /;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function extensionOf(p: string): string {
  const base = path.basename(p);
  const idx = base.lastIndexOf('.');
  if (idx <= 0) return '';
  return base.slice(idx + 1).toLowerCase();
}

function directoryOf(p: string): string {
  const dir = path.posix.dirname(p.replace(/\\/g, '/'));
  return dir === '.' ? '' : dir;
}

/**
 * Parse the output of `git diff` (unified format) into structured per-file diffs.
 * Handles added, deleted, modified, and renamed files, including binary files
 * (which yield zero counted lines) and mode-only changes.
 */
export function parseUnifiedDiff(diffText: string): ParsedDiff {
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  let currentHunk: FileDiff['hunks'][number] | null = null;

  const lines = diffText.split('\n');
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    const fileMatch = DIFF_FILE_HEADER.exec(line);
    if (fileMatch) {
      current = {
        path: fileMatch[2]!,
        changeType: 'modified',
        hunks: [],
        addedLines: 0,
        deletedLines: 0,
      };
      files.push(current);
      currentHunk = null;
      continue;
    }
    if (!current) continue;

    const renameFrom = RENAME_FROM.exec(line);
    if (renameFrom) {
      current.previousPath = renameFrom[1]!;
      continue;
    }
    const renameTo = RENAME_TO.exec(line);
    if (renameTo) {
      current.path = renameTo[1]!;
      current.changeType = 'renamed';
      continue;
    }
    if (NEW_MODE.test(line) && !line.startsWith('new file mode')) {
      // pure mode change; keep as modified with no hunks
      continue;
    }
    if (OLD_MODE.test(line) || SIMILARITY.test(line) || INDEX_LINE.test(line)) {
      continue;
    }
    if (line.startsWith('new file mode')) {
      current.changeType = 'added';
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      current.changeType = 'deleted';
      continue;
    }
    if (
      line.startsWith('Binary files') ||
      line.startsWith('GIT binary patch') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ')
    ) {
      continue;
    }

    const hunkMatch = HUNK_HEADER.exec(line);
    if (hunkMatch) {
      currentHunk = {
        header: line,
        oldStart: Number(hunkMatch[1]),
        newStart: Number(hunkMatch[3]),
        lines: [],
      };
      current.hunks.push(currentHunk);
      continue;
    }

    if (!currentHunk) continue;
    if (line.startsWith('+')) {
      currentHunk.lines.push({ kind: 'added', text: line.slice(1) });
      current.addedLines += 1;
    } else if (line.startsWith('-')) {
      currentHunk.lines.push({ kind: 'removed', text: line.slice(1) });
      current.deletedLines += 1;
    } else if (line.startsWith(' ') || line === '') {
      currentHunk.lines.push({ kind: 'context', text: line.startsWith(' ') ? line.slice(1) : '' });
    }
    // '\ No newline at end of file' and any other prefixes are ignored.
  }

  return { files };
}

/** Convert a parsed file diff into the shared ChangedFile record. */
export function toChangedFile(file: FileDiff): import('./types.js').ChangedFile {
  let modifiedLines = 0;
  const removedTexts = new Map<string, number>();
  for (const hunk of file.hunks) {
    for (const dl of hunk.lines) {
      if (dl.kind === 'removed') {
        removedTexts.set(dl.text, (removedTexts.get(dl.text) ?? 0) + 1);
      }
    }
  }
  for (const hunk of file.hunks) {
    for (const dl of hunk.lines) {
      if (dl.kind === 'added') {
        const remaining = removedTexts.get(dl.text) ?? 0;
        if (remaining > 0) {
          modifiedLines += 1;
          removedTexts.set(dl.text, remaining - 1);
        }
      }
    }
  }
  const addedLines = file.addedLines - modifiedLines;
  const deletedLines = file.deletedLines - modifiedLines;
  return {
    path: file.path,
    ...(file.previousPath !== undefined ? { previousPath: file.previousPath } : {}),
    changeType: file.changeType,
    extension: extensionOf(file.path),
    directory: directoryOf(file.path),
    addedLines: Math.max(0, addedLines),
    deletedLines: Math.max(0, deletedLines),
    modifiedLines,
    linesChanged: Math.max(0, addedLines) + Math.max(0, deletedLines) + modifiedLines,
  };
}

/** Parse a unified diff into the shared ChangeSet. */
export function buildChangeSet(
  diffText: string,
  baseSha: string,
  headSha: string,
): import('./types.js').ChangeSet {
  const parsed = parseUnifiedDiff(diffText);
  const files = parsed.files.map(toChangedFile);
  return {
    baseSha,
    headSha,
    files,
    totalAddedLines: files.reduce((acc, f) => acc + f.addedLines, 0),
    totalDeletedLines: files.reduce((acc, f) => acc + f.deletedLines, 0),
    totalLinesChanged: files.reduce((acc, f) => acc + f.linesChanged, 0),
  };
}

/**
 * Obtain `git diff` output between two SHAs.
 * Uses --find-renames so renames are reported, and full context is not needed.
 */
export async function getDiffBetweenShas(
  repoDir: string,
  baseSha: string,
  headSha: string,
  execFn: (
    cmd: string,
    args: string[],
    opts: { cwd: string },
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
): Promise<string> {
  const res = await execFn('git', ['diff', '--find-renames', `${baseSha}...${headSha}`], {
    cwd: repoDir,
  });
  if (res.exitCode !== 0) {
    throw new Error(`git diff failed (exit ${res.exitCode}): ${res.stderr.slice(0, 500)}`);
  }
  return res.stdout;
}

/** Read a diff from a fixture file (used by tests and offline mode). */
export function readDiffFixture(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}
