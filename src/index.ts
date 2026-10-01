import * as core from '@actions/core';
import * as github from '@actions/github';
import { loadEventContext, resolveShas, repositoryFullName } from './github.js';
import { buildChangeSet } from './diff.js';
import type { ChangeSet } from './types.js';

async function run(): Promise<void> {
  try {
    const ctx = loadEventContext();
    const shas = resolveShas(ctx);
    const repo = repositoryFullName(ctx);

    if (!shas || !repo) {
      core.info('Jev Build Sentinel: no pull request context detected. Nothing to do.');
      return;
    }

    core.info(`Repository: ${repo}`);
    core.info(`Base SHA: ${shas.baseSha}`);
    core.info(`Head SHA: ${shas.headSha}`);

    const token = core.getInput('github-token');
    const octokit = github.getOctokit(token);

    // Prefer the GitHub compare API for the diff (works without a full checkout).
    const response = await octokit.rest.repos.compareCommits({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      base: shas.baseSha,
      head: shas.headSha,
      mediaType: { format: 'diff' },
    });
    const diffText =
      typeof response.data === 'string'
        ? response.data
        : String((response.data as unknown as { toString(): string }));

    const changeSet: ChangeSet = buildChangeSet(diffText, shas.baseSha, shas.headSha);

    core.info(`Changed files (${changeSet.files.length}):`);
    for (const file of changeSet.files) {
      core.info(
        `  ${file.changeType.padEnd(8)} ${file.path} (+${file.addedLines}/-${file.deletedLines}${
          file.modifiedLines > 0 ? `, ~${file.modifiedLines} modified` : ''
        })`,
      );
    }
    core.info(`Total lines changed: ${changeSet.totalLinesChanged}`);
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(`Jev Build Sentinel failed: ${error.message}`);
    } else {
      core.setFailed('Jev Build Sentinel failed with an unknown error.');
    }
  }
}

void run();
