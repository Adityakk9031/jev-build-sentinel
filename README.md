# Jev Build Sentinel

A GitHub Action that determines the **minimum safe amount of CI verification** for a pull
request — and automatically chooses full CI whenever it isn't confident.

> The story isn't "AI skips tests."
> It's: **Jev is a low-latency CI decision engine that determines the minimum safe amount
> of verification — and always escalates to full CI when uncertain.**

## Pipeline

```text
PR
 ↓
Git diff (src/diff.ts)          changed files, added/deleted/modified lines, renames
 ↓
Structured change set
 ↓
Test mapper (src/test-mapper.ts)  Jest/Vitest naming conventions + import graph + proximity
 ↓
Candidate tests
 ↓
Feature extractor (src/analyzer.ts)  deterministic risk features
 ↓
Jev inference API (src/jev-client.ts)  SKIP | TARGETED | FULL
 ↓
Safety policy (src/risk-engine.ts)  "when uncertain, run more tests, never fewer"
 ↓
Action outputs + job summary + optional execution (src/executor.ts)
```

## Usage

```yaml
name: CI
on: pull_request

jobs:
  sentinel:
    runs-on: ubuntu-latest
    outputs:
      decision: ${{ steps.sentinel.outputs.decision }}
      selected_tests: ${{ steps.sentinel.outputs.selected_tests }}
    steps:
      - uses: actions/checkout@v4
      - id: sentinel
        uses: jev/build-sentinel@v1
        with:
          jev-endpoint: https://jev.example.com/v1
          jev-api-key: ${{ secrets.JEV_API_KEY }}
          execute-tests: 'true'

  tests:
    needs: sentinel
    if: needs.sentinel.outputs.decision == 'FULL'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test
```

### Inputs

| Input | Default | Description |
| ----- | ------- | ----------- |
| `github-token` | `${{ github.token }}` | Token used to read the PR diff. |
| `jev-endpoint` | — (required) | Base URL of the Jev inference API. |
| `jev-api-key` | — | API key; never logged. |
| `mode` | `decide` | `decide` or `execute`. |
| `execute-tests` | `false` | Also run the selected/normal tests. |
| `confidence-threshold` | `0.7` | Below this Jev confidence, force FULL. |
| `timeout-ms` | `10000` | Jev request timeout. |
| `retries` | `2` | Retries on transient Jev failures. |
| `working-directory` | `.` | Repo root for mapping and execution. |

### Outputs

`decision`, `risk_score`, `confidence`, `selected_tests`, `tests_skipped`, `reason`, `fallback_used`.

## Safety policy

Jev is the primary decision engine, but it is never blindly trusted:

1. Jev confidence below threshold → **FULL**
2. Jev says FULL → **FULL**
3. Jev says TARGETED → run only selected tests
4. Jev says SKIP → skip the expensive suite
5. High-risk changes always force **FULL** regardless of Jev: database migrations,
   dependency/lock changes, CI configuration, Docker infrastructure,
   authentication/security paths, core shared libraries
6. TARGETED is never empty — falls back to locally mapped candidates, else FULL
7. Jev API failure or timeout → **FULL**

## Historical learning

When `execute-tests` is enabled and `SENTINEL_HISTORY_FILE` points to a JSON file,
Sentinel records which tests were selected (and which failed) per changed source:

```json
{ "records": { "src/payments/stripe.ts": [{ "test": "tests/e2e/payment-refund.spec.ts", "failures": 2, "selections": 3, "lastSeen": "..." }] } }
```

Next time `stripe.ts` changes, the historically-linked e2e test becomes a candidate —
turning static selection into a repository-specific test-risk model.

## Local demo (no network)

```bash
npm install
npm test                # 90 unit tests
npx tsx demo/offline-demo.ts readme        # SKIP
npx tsx demo/offline-demo.ts notification # TARGETED (1 test)
npx tsx demo/offline-demo.ts payment      # TARGETED + historical e2e test
npx tsx demo/offline-demo.ts auth         # FULL (safety policy override)
npx tsx demo/offline-demo.ts migration    # FULL (high-risk change)
```

## Development

```bash
npm run build:check   # strict TypeScript
npm run build         # tsc + ncc -> dist/index.js (the Action bundle)
npm test              # node:test unit tests
```

Architecture is strictly layered: `types.ts` (contracts) → `diff.ts` / `test-mapper.ts` /
`analyzer.ts` (pure functions) → `jev-client.ts` / `risk-engine.ts` (decision) →
`pipeline.ts` (orchestration) → `report.ts` / `executor.ts` / `history.ts` (effects) →
`index.ts` (Action wiring).
