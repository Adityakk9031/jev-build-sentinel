import * as path from 'node:path';
import type {
  AnalysisFeatures,
  ChangeSet,
  ExecutionResult,
  SentinelDecision,
} from './types.js';

/** Set all documented Action outputs (pure over inputs; core injected for tests). */
export function setOutputs(
  core: Pick<typeof import('@actions/core'), 'setOutput' | 'setFailed'>,
  decision: SentinelDecision,
  candidateCount: number,
): void {
  core.setOutput('decision', decision.decision);
  core.setOutput('risk_score', String(decision.risk_score));
  core.setOutput('confidence', String(decision.confidence));
  core.setOutput('selected_tests', decision.selected_tests.join(' '));
  core.setOutput('tests_skipped', String(Math.max(0, candidateCount - decision.selected_tests.length)));
  core.setOutput('reason', decision.reason);
  core.setOutput('fallback_used', String(decision.fallbackUsed));
}

/** Build the markdown job summary (pure string builder for testability). */
export function buildSummary(
  decision: SentinelDecision,
  changeSet: ChangeSet,
  features: AnalysisFeatures,
  candidateTests: string[],
  execution?: ExecutionResult,
): string {
  const lines: string[] = [];
  lines.push('## Jev Build Sentinel');
  lines.push('');
  lines.push('```text');
  lines.push('------------------');
  lines.push(`Decision: ${decision.decision}`);
  lines.push(`Risk: ${decision.risk_score.toFixed(2)}`);
  lines.push(`Confidence: ${decision.confidence.toFixed(2)}`);
  lines.push('```');
  lines.push('');

  if (decision.selected_tests.length > 0) {
    lines.push('**Selected tests:**');
    lines.push('');
    for (const t of decision.selected_tests.slice(0, 50)) {
      lines.push(`- ${t}`);
    }
    if (decision.selected_tests.length > 50) {
      lines.push(`- … and ${decision.selected_tests.length - 50} more`);
    }
    lines.push('');
  }

  const skipped = Math.max(0, candidateTests.length - decision.selected_tests.length);
  lines.push(`**Skipped tests:** ${skipped}`);
  lines.push('');
  lines.push(`**Fallback policy:** ${decision.fallbackUsed ? 'triggered' : 'enabled (not needed)'}`);
  if (decision.policyTriggers.length > 0) {
    lines.push('');
    lines.push('**Policy triggers:**');
    lines.push('');
    for (const t of decision.policyTriggers) {
      lines.push(`- ${t}`);
    }
  }
  lines.push('');

  lines.push('<details><summary>Change analysis</summary>');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('| ------ | ----- |');
  lines.push(`| Files changed | ${changeSet.files.length} |`);
  lines.push(`| Lines changed | ${changeSet.totalLinesChanged} |`);
  lines.push(`| Source files | ${features.sourceFileCount} |`);
  lines.push(`| Test files | ${features.testFileCount} |`);
  lines.push(`| Docs only | ${features.docsOnly} |`);
  lines.push('');
  if (changeSet.files.length > 0) {
    lines.push('| File | Change | +/- |');
    lines.push('| ---- | ------ | --- |');
    for (const f of changeSet.files.slice(0, 30)) {
      lines.push(`| ${path.basename(f.path)} | ${f.changeType} | +${f.addedLines}/-${f.deletedLines} |`);
    }
  }
  lines.push('');
  lines.push('</details>');

  if (execution) {
    lines.push('');
    lines.push('### Test execution');
    lines.push('');
    lines.push('```text');
    lines.push(`Command: ${execution.command}`);
    lines.push(`Exit code: ${execution.exitCode ?? 'n/a'}`);
    lines.push(`Duration: ${(execution.durationMs / 1000).toFixed(1)}s`);
    lines.push(`Tests executed: ${execution.testsExecuted ?? 'n/a'}`);
    lines.push(`Tests skipped: ${execution.testsSkipped}`);
    if (execution.fellBackToFull) lines.push('Targeted execution failed - fell back to FULL suite');
    lines.push('```');
  }

  lines.push('');
  lines.push(`> ${decision.reason}`);
  return lines.join('\n');
}
