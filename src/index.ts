import * as core from '@actions/core';
import * as github from '@actions/github';
import { loadEventContext, resolveShas, repositoryFullName } from './github.js';
import { buildChangeSet } from './diff.js';
import { loadEnvFile } from './env.js';
import { DEFAULT_ENDPOINT, DEFAULT_MODEL, JevClient } from './jev-client.js';
import { runPipeline } from './pipeline.js';
import { setOutputs, buildSummary } from './report.js';
import { executeTests, shouldExecuteTests } from './executor.js';
import { coChangeMap, loadHistory, rememberOutcome, saveHistory } from './history.js';

async function run(): Promise<void> {
  try {
    // Local .env supplies JEV_API_KEY/JEV_ENDPOINT/JEV_MODEL; real env vars win.
    loadEnvFile();
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

    // 1. Obtain the diff via the GitHub compare API (works without full checkout).
    const token = core.getInput('github-token');
    const octokit = github.getOctokit(token);
    const response = await octokit.rest.repos.compareCommits({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      base: shas.baseSha,
      head: shas.headSha,
      mediaType: { format: 'diff' },
    });
    const diffText =
      typeof response.data === 'string' ? response.data : String(response.data);

    const changeSet = buildChangeSet(diffText, shas.baseSha, shas.headSha);
    core.info(`Changed files: ${changeSet.files.length}`);

    // 2-4. Features, candidate tests, Jev request.
    const repoDir = core.getInput('working-directory') || '.';
    const jev = new JevClient({
      endpoint: core.getInput('jev-endpoint') || process.env['JEV_ENDPOINT'] || DEFAULT_ENDPOINT,
      apiKey: core.getInput('jev-api-key') || process.env['JEV_API_KEY'] || undefined,
      model: core.getInput('jev-model') || process.env['JEV_MODEL'] || DEFAULT_MODEL,
      timeoutMs: Number(core.getInput('timeout-ms') || '10000'),
      retries: Number(core.getInput('retries') || '2'),
    });

    const historyFile = process.env['SENTINEL_HISTORY_FILE'];
    const history = historyFile ? loadHistory(historyFile) : { records: {} };
    // Ranked, filtered co-change candidates (sources need more than one clean observation).
    const historicalCoChanges = coChangeMap(history);

    const result = await runPipeline({
      jev,
      changeSet,
      repoDir,
      policy: { confidenceThreshold: Number(core.getInput('confidence-threshold') || '0.7') },
      historicalCoChanges,
      historicalRecordCount: Object.keys(history.records).length,
    });

    const { decision, features, candidateTests } = result;
    core.info(`Decision: ${decision.decision} (risk ${decision.risk_score}, confidence ${decision.confidence})`);
    if (decision.policyTriggers.length > 0) {
      core.warning(`Safety policy triggers: ${decision.policyTriggers.join('; ')}`);
    }

    // 5. Outputs + job summary.
    setOutputs(core, decision, candidateTests.length);
    const mode = core.getInput('mode') || 'decide';
    if (mode !== 'decide' && mode !== 'execute') {
      core.warning(`Unknown mode '${mode}' - expected 'decide' or 'execute'. Treating as 'decide'.`);
    }
    const executionInput = shouldExecuteTests(mode, core.getInput('execute-tests') === 'true');
    let execution;
    if (executionInput && decision.decision !== 'SKIP') {
      execution = await executeTests({
        repoDir,
        decision: decision.decision,
        selectedTests: decision.selected_tests,
      });
      if (execution.fellBackToFull) {
        core.warning('Targeted execution was not possible - fell back to FULL suite.');
      }
      if (execution.failedTests.length > 0) {
        core.warning(`Failing tests: ${execution.failedTests.join(', ')}`);
      }
    }
    core.summary.addRaw(buildSummary(decision, changeSet, features, candidateTests, execution));
    await core.summary.write();

    // Stage 9: record actual outcomes for historical learning when executing.
    if (executionInput && execution && historyFile) {
      rememberOutcome(
        history,
        changeSet.files.map((f) => f.path),
        decision.selected_tests,
        execution,
        execution.failedTests,
      );
      saveHistory(historyFile, history);
      core.info(`Updated test history at ${historyFile}`);
    }
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(`Jev Build Sentinel failed: ${error.message}`);
    } else {
      core.setFailed('Jev Build Sentinel failed with an unknown error.');
    }
  }
}

void run();
